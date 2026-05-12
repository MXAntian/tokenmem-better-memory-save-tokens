#!/usr/bin/env node
// ============================================================
// 回填脚本：给已有 memories 补 embedding 向量
//
// 用途：
//   - 首次启用向量搜索时，把历史记忆（无 content_vector）批量过 embedding
//   - 中断后可重跑（幂等：只处理 content_vector IS NULL 的行）
//
// 用法：
//   node memory/backfill-embeddings.mjs
//   node memory/backfill-embeddings.mjs --batch-size 5 --concurrency 3
//   node memory/backfill-embeddings.mjs --dry-run    # 只统计不写入
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ── 加载 .env.local ────────────────────────────────────────
const envPath = resolve(__dirname, '..', '.env.local')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf-8').split('\n').filter(l => l && !l.startsWith('#')).forEach(l => {
    const i = l.indexOf('=')
    if (i > 0) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  })
}

const args = process.argv.slice(2)
const hasFlag = (f) => args.includes(f)
const getFlag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }

const CONCURRENCY = parseInt(getFlag('--concurrency') || '3', 10)
const DRY_RUN = hasFlag('--dry-run')

// ── 配置 ─────────────────────────────────────────────────────
const DB_PATH = resolve(__dirname, 'engram.db')
const VEC_EXT = resolve(__dirname, 'lib/sqlite-vec-windows-x64/vec0')
const EMBED_URL = (process.env.EMBEDDING_API_BASE_URL || '') + '/embeddings'
const EMBED_KEY = process.env.EMBEDDING_API_KEY
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-v3'
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10)

if (!EMBED_KEY) {
  console.error('❌ EMBEDDING_API_KEY 未设置，检查 .env.local')
  process.exit(1)
}

// ── DB 打开 + 加载 vec 扩展 ─────────────────────────────────
const Database = require('better-sqlite3')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.loadExtension(VEC_EXT)
console.log(`✓ DB opened: ${DB_PATH}`)
console.log(`✓ sqlite-vec loaded: ${db.prepare('SELECT vec_version() as v').get().v}`)

// 确保 memories_vec 存在（initMemory 应该已建，但防御性创建）
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
    memory_rowid INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBED_DIM}]
  )
`)

// ── 统计待处理 ──────────────────────────────────────────────
const pending = db.prepare(`
  SELECT rowid, id, content, length(content) as len
  FROM memories
  WHERE deleted_at IS NULL
    AND (content_vector IS NULL OR content_vector = '')
  ORDER BY importance DESC, created_at DESC
`).all()

const total = pending.length
console.log(`\n📊 待处理记忆: ${total} 条`)
if (total === 0) { console.log('✓ 全部已 embed'); db.close(); process.exit(0) }

const totalChars = pending.reduce((s, r) => s + r.len, 0)
const estimatedTokens = Math.ceil(totalChars / 1.5)  // 中文约 1.5 字/token
const estimatedCost = (estimatedTokens / 1000 * 0.0007).toFixed(4)
console.log(`📊 总字符数: ${totalChars}  ≈ ${estimatedTokens} tokens`)
console.log(`📊 预计成本: ¥${estimatedCost}`)

if (DRY_RUN) {
  console.log('\n[dry-run] 仅统计，不实际调用 API')
  db.close()
  process.exit(0)
}

// ── 调 embedding API ────────────────────────────────────────
async function embed(text) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${EMBED_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text.slice(0, 8000),
      dimensions: EMBED_DIM,
      encoding_format: 'float',
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`)
  const data = await res.json()
  return data?.data?.[0]?.embedding
}

// ── 批量处理 ────────────────────────────────────────────────
const updateVecStmt = db.prepare('UPDATE memories SET content_vector = ? WHERE rowid = ?')
const insertVecStmt = db.prepare('INSERT OR REPLACE INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)')

const writeTxn = db.transaction((rowid, vecJson, floatArr) => {
  updateVecStmt.run(vecJson, rowid)
  insertVecStmt.run(BigInt(rowid), floatArr)
})

let processed = 0, failed = 0
const startTs = Date.now()

async function processOne(row) {
  try {
    const vec = await embed(row.content)
    if (!vec || vec.length !== EMBED_DIM) throw new Error(`invalid vector (len=${vec?.length})`)
    writeTxn(row.rowid, JSON.stringify(vec), new Float32Array(vec))
    processed++
  } catch (e) {
    failed++
    console.log(`  ❌ rowid ${row.rowid}: ${e.message}`)
  }
}

// 并发池（ concurrency 个并发请求）
async function runPool() {
  const queue = [...pending]
  const workers = []

  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const row = queue.shift()
        if (!row) break
        await processOne(row)
        if ((processed + failed) % 10 === 0) {
          const elapsed = (Date.now() - startTs) / 1000
          const rate = (processed + failed) / elapsed
          const eta = ((total - processed - failed) / rate).toFixed(0)
          console.log(`  进度: ${processed + failed}/${total}  (成功 ${processed} / 失败 ${failed}, ${rate.toFixed(1)} req/s, ETA ${eta}s)`)
        }
      }
    })())
  }
  await Promise.all(workers)
}

console.log(`\n🚀 开始回填 (concurrency=${CONCURRENCY})...\n`)
await runPool()

const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)
console.log(`\n✓ 完成`)
console.log(`  处理: ${processed} 成功 / ${failed} 失败 / ${total} 总计`)
console.log(`  耗时: ${elapsed}s`)
console.log(`  memories_vec 当前总数: ${db.prepare('SELECT COUNT(*) as c FROM memories_vec').get().c}`)

db.close()
