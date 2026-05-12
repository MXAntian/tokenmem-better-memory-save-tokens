#!/usr/bin/env node
// ============================================================
// Memory migration script: Claude Auto Memory → SQLite
//
// 将 ~/.claude/projects/ 下所有项目的 memory/*.md 文件
// 导入到 SQLite，实现跨项目记忆统一。
//
// 特性：
//   - 幂等（按 summary+source='manual' 去重，可重复运行）
//   - 不删除原文件（Claude Code auto memory 继续工作）
//   - 自动映射 type → category/importance
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ── 扫描目录 ──────────────────────────────────────────────────
const CLAUDE_PROJECTS = 'C:/Users/MSI/.claude/projects'
const MEMORY_DIRS = [
  `${CLAUDE_PROJECTS}/E--Project/memory`,
  `${CLAUDE_PROJECTS}/E--Airi/memory`,
]

// ── type → category 映射 ──────────────────────────────────────
const TYPE_TO_CATEGORY = {
  user: 'people',
  feedback: 'feedback',
  project: 'project',
  reference: 'general',
}

// ── name 前缀 → importance 映射 ──────────────────────────────
function guessImportance(filename, type, name) {
  const f = filename.toLowerCase()
  if (f.includes('persona') || f.includes('chinatsu')) return 9
  if (type === 'feedback') return 8
  if (f.includes('profile') || f.includes('user')) return 8
  if (type === 'project') return 7
  if (type === 'reference') return 6
  return 6
}

// ── 解析 frontmatter ──────────────────────────────────────────
function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/m)
  if (!m) return { meta: {}, body: content }

  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) meta[kv[1].trim()] = kv[2].trim()
  }
  return { meta, body: m[2].trim() }
}

// ── 主逻辑 ────────────────────────────────────────────────────
async function main() {
  // 初始化 DB（复用 memory/index.mjs 的 initMemory）
  const { initMemory, storeMemory, closeMemory } = await import('./index.mjs')
  initMemory()

  // 直接用 better-sqlite3 做去重查询
  const Database = require('better-sqlite3')
  // 默认指向 tokenmem.db；setup 时若 DB 文件名不同，改这里或传环境变量
  const db = new Database(resolve(__dirname, process.env.TOKENMEM_DB || 'tokenmem.db'))

  const checkDup = db.prepare(
    `SELECT id FROM memories WHERE summary = ? AND source = 'manual' AND deleted_at IS NULL LIMIT 1`
  )

  let imported = 0
  let skipped = 0
  let errors = 0

  for (const dir of MEMORY_DIRS) {
    if (!existsSync(dir)) {
      console.log(`⚠️  跳过不存在的目录: ${dir}`)
      continue
    }

    const project = dir.includes('E--Project') ? 'E--Project' : 'E--Airi'
    const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    console.log(`\n📁 ${project}: ${files.length} 个文件`)

    for (const filename of files) {
      const filepath = resolve(dir, filename)
      try {
        const raw = readFileSync(filepath, 'utf-8')
        const { meta, body } = parseFrontmatter(raw)

        const name = meta.name || basename(filename, '.md')
        const type = meta.type || 'reference'
        const description = meta.description || ''
        const category = TYPE_TO_CATEGORY[type] || 'general'
        const importance = guessImportance(filename, type, name)

        // 摘要用于去重
        const summary = description || name

        // 检查去重
        const existing = checkDup.get(summary)
        if (existing) {
          console.log(`  ⏭  跳过（已存在）: ${name}`)
          skipped++
          continue
        }

        // 内容 = 文件正文（含 frontmatter 中的描述）
        const content = body || `${name}${description ? '：' + description : ''}`

        storeMemory({
          content: content.slice(0, 8000),
          summary,
          memoryType: 'permanent',
          category,
          importance,
          source: 'manual',
          tags: ['migrated', 'claude_auto_memory', project, type],
          metadata: {
            source_file: filepath,
            original_type: type,
            migrated_at: new Date().toISOString(),
          },
        })

        console.log(`  ✅ 导入: [${type}→${category} i${importance}] ${name}`)
        imported++

      } catch (e) {
        console.log(`  ❌ 错误: ${filename} — ${e.message}`)
        errors++
      }
    }
  }

  db.close()
  closeMemory()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`迁移完成: ${imported} 导入, ${skipped} 跳过, ${errors} 错误`)
  console.log(`${'='.repeat(50)}`)
}

main().catch(e => {
  console.error('迁移失败:', e)
  process.exit(1)
})
