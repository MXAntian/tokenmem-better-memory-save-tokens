// Backfill supersede 字段（一次性）
// harness-evolve 提案 #001 配套脚本
//
// 用法：
//   node scripts/backfill-supersede.mjs            # dry-run，输出建议给人审
//   node scripts/backfill-supersede.mjs --apply    # 实际写入 superseded_by 字段
//
// 策略：
//   - 扫描所有未删除且 superseded_by 为空的记忆
//   - 用正则提取 "supersedes id:N" / "supersedes ... #N" / "supersedes id N" 等模式
//   - 显示候选对 (newRowid → oldRowid) 给人审
//   - 排除 PR/commit/issue 上下文（避免 PR 编号被误当 rowid）
//   - --apply 才实际 UPDATE

import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const __dirname = dirname(fileURLToPath(import.meta.url))

const APPLY = process.argv.includes('--apply')
const DB_PATH = process.env.TOKENMEM_DB_PATH || resolve(__dirname, '../engram.db')

const db = new Database(DB_PATH)

console.log('=== Backfill supersede 字段（' + (APPLY ? '🔥 APPLY 模式' : '🟢 dry-run') + '）===')
console.log()

// 候选记忆：含 "supersede" 字串、未删除、未填 superseded_by
const candidates = db.prepare(`
  SELECT rowid, summary, content
  FROM memories
  WHERE (summary LIKE '%supersede%' OR content LIKE '%supersede%')
    AND deleted_at IS NULL
    AND superseded_by IS NULL
  ORDER BY rowid
`).all()

console.log(`扫到 ${candidates.length} 条候选记忆\n`)

// 解析 supersedes XX 模式
// 接受：supersedes id:N / supersedes id N / supersedes ... memory #N / supersedes ... 旧id:N
// 拒绝：PR #N / commit / issue
const SUPERSEDE_PATTERNS = [
  /supersedes?\s+(?:旧)?id[:\s]+(\d+)/gi,
  /supersedes?\s+(?:部分\s*)?memory\s*#?(\d+)/gi,
  /supersedes?\s+rowid[:\s]+(\d+)/gi,
]

const REJECT_CONTEXTS = [/\bPR\s*#?\d+/i, /\bcommit\s+\w+/i, /\bissue\s*#?\d+/i, /\bv\d+\s*[\u4e00-\u9fa5]/]

const proposals = []  // { newRowid, oldRowid, source, snippet }

for (const c of candidates) {
  const blob = `${c.summary || ''}\n${c.content || ''}`

  // 检测 reject 上下文里"supersedes" 是不是指 PR
  // 简单做法：若同句包含 "PR" 而无 "memory/id" 关键字，跳过
  const supersedeLineMatch = blob.match(/^.*supersede.*$/im)
  const sentenceContext = supersedeLineMatch ? supersedeLineMatch[0] : ''
  const isRejected = REJECT_CONTEXTS.some(re => re.test(sentenceContext)) &&
                     !/\b(memory|id|rowid)\b/i.test(sentenceContext)

  if (isRejected) {
    console.log(`⚠️ rowid=${c.rowid} 含 supersede 但上下文为 PR/commit，跳过：`)
    console.log(`   ${sentenceContext.slice(0, 100)}`)
    console.log()
    continue
  }

  let foundOld = null
  for (const pat of SUPERSEDE_PATTERNS) {
    pat.lastIndex = 0
    const m = pat.exec(blob)
    if (m) {
      foundOld = parseInt(m[1], 10)
      break
    }
  }

  if (foundOld == null) {
    console.log(`ℹ️ rowid=${c.rowid} 含 supersede 字串但无明确 id 关联（可能是"v2/rework/状态更新"语义），跳过：`)
    console.log(`   summary: ${(c.summary || '').slice(0, 100)}`)
    console.log()
    continue
  }

  // 验证 oldRowid 存在且未删除
  const old = db.prepare(`SELECT rowid, summary FROM memories WHERE rowid = ? AND deleted_at IS NULL`).get(foundOld)
  if (!old) {
    console.log(`❌ rowid=${c.rowid} 想 supersede rowid=${foundOld}，但目标不存在或已删除，跳过`)
    console.log()
    continue
  }

  // 防自环
  if (foundOld === c.rowid) {
    console.log(`❌ rowid=${c.rowid} 想 supersede 自己，跳过`)
    continue
  }

  proposals.push({
    newRowid: c.rowid,
    oldRowid: foundOld,
    newSummary: c.summary,
    oldSummary: old.summary,
  })
}

console.log('=== 建议的 supersede 关联 ===\n')
if (proposals.length === 0) {
  console.log('（无）— 11 条样本里没有结构化可解析的 supersede 关联')
  process.exit(0)
}

for (const p of proposals) {
  console.log(`✅ rowid=${p.newRowid} supersedes rowid=${p.oldRowid}`)
  console.log(`   NEW (${p.newRowid}): ${(p.newSummary || '').slice(0, 100)}`)
  console.log(`   OLD (${p.oldRowid}): ${(p.oldSummary || '').slice(0, 100)}`)
  console.log()
}

if (!APPLY) {
  console.log('🟢 dry-run 完成。如确认无误，加 --apply 标志重跑写入数据库。')
  process.exit(0)
}

// APPLY 模式
console.log('🔥 APPLY 模式：开始写入 superseded_by 字段...\n')
const upd = db.prepare(`UPDATE memories SET superseded_by = ? WHERE rowid = ? AND deleted_at IS NULL AND superseded_by IS NULL`)
const tx = db.transaction(() => {
  for (const p of proposals) {
    const r = upd.run(String(p.newRowid), p.oldRowid)
    console.log(`   rowid=${p.oldRowid}.superseded_by = ${p.newRowid}（changes=${r.changes}）`)
  }
})
tx()

console.log(`\n✅ 写入完成 ${proposals.length} 条 supersede 关联`)
console.log('   下一步：运行 expireMemories() 让旧记忆软删除（或等下一次 daemon 周期触发）')

db.close()
