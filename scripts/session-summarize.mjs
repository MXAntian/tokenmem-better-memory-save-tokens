// Phase A 抽取脚本：扫 transcript jsonl + 关联 memories 写入 session_summaries
//
// 用法：
//   node scripts/session-summarize.mjs <sessionId>           # 抽一个 session
//   node scripts/session-summarize.mjs --backfill --hours=72 # 扫最近 72 小时所有 session
//   node scripts/session-summarize.mjs --all                  # 扫所有 transcript（首次回填）
//
// Phase A 只做零 LLM 抽取：
//   - files_modified: 扫 type=tool_use, name in (Edit|Write|MultiEdit|NotebookEdit), 取 input.file_path
//   - meta_knowledge_rowids: 查 memories 表 created_at 在 [started, ended] 范围内的
//   - topic_tags: 关键词频率（按 TOPIC_KEYWORDS 字典；项目相关 topic 默认是 example，用户应按自己 workflow 改）
//   - related_session_ids: 同 files_modified 重叠或 topic_tags 重叠的其他 sessionId
//   - 时间元数据 + cwd + 计数

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = resolve(__dirname, '../engram.db')

// CC transcript 根目录（按 cwd 派生子目录名）
const PROJECTS_ROOT = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/projects')

// 主题关键词字典（出现 ≥3 次入选 topic_tags）
const TOPIC_KEYWORDS = {
  'tokenmem': ['tokenmem', 'engram', 'recall_memory', 'store_memory'],
  'mcp': ['MCP', 'mcp-server', 'StdioServerTransport', 'StreamableHTTP'],
  'ariel': ['爱芮', 'ariel-workspace', 'memory-engram'],
  'town': ['ClawGamers Town', 'town_send', 'town_status', 'CGA2A'],
  'patent': ['专利', 'patent-disclosure', 'patent-review', '交底书'],
  'hook': ['SessionStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit', 'hook-trace'],
  'evolve': ['harness-evolve', 'harness-research', 'evolve-today'],
  'plugin': ['plugin', 'definePluginEntry', 'OpenClaw plugin'],
  'http-transport': ['port 18792', 'StreamableHTTP', '--transport=http', 'health endpoint'],
  'supersede': ['supersede', 'superseded_by', 'supersedes'],
  'school': ['school/', 'School V2', 'course'],
  'review': ['PR review', 'code-review', 'pr-self-check'],
  'codex': ['codex-offload', 'codex-run', 'codex CLI'],
}

// 工具：统计关键词出现次数
function countTopicTags(text) {
  const tags = []
  for (const [tag, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let total = 0
    for (const kw of keywords) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const matches = text.match(re)
      if (matches) total += matches.length
    }
    if (total >= 3) tags.push({ tag, count: total })
  }
  // 按 count 降序，最多 6 个 tag（避免噪音）
  return tags.sort((a, b) => b.count - a.count).slice(0, 6).map(t => t.tag)
}

// 解析单个 transcript jsonl
function parseTranscript(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean)
  let started = null
  let ended = null
  let cwd = null
  const filesModifiedSet = new Set()
  let toolCallCount = 0
  let messageCount = 0
  const textChunks = []  // 给 topic_tags 用的文本池

  for (const line of lines) {
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    const ts = evt.timestamp ? new Date(evt.timestamp).getTime() : null
    if (ts) {
      if (!started || ts < started) started = ts
      if (!ended || ts > ended) ended = ts
    }
    if (!cwd && evt.cwd) cwd = evt.cwd

    // user/assistant 消息计数
    if (evt.type === 'user' || evt.type === 'assistant') messageCount++

    // 扫 message.content 找 tool_use
    const content = evt.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'tool_use') {
        toolCallCount++
        const name = part.name
        const input = part.input || {}
        // 抽 file_path：Edit / Write / MultiEdit / NotebookEdit
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) && input.file_path) {
          filesModifiedSet.add(input.file_path)
        }
        // tool_use 的 input 也喂给 topic_tags（如 Bash 命令、Edit 内容）
        const inputStr = JSON.stringify(input).slice(0, 500)  // 限长避免巨型 chunk
        textChunks.push(inputStr)
      } else if (part?.type === 'text' && part.text) {
        textChunks.push(part.text.slice(0, 500))
      } else if (part?.type === 'tool_result' && part.content) {
        const c = Array.isArray(part.content) ? part.content : [part.content]
        for (const cc of c) {
          if (cc?.type === 'text' && cc.text) textChunks.push(cc.text.slice(0, 200))
        }
      }
    }
  }

  return {
    started_at: started,
    ended_at: ended,
    duration_min: started && ended ? Math.round((ended - started) / 60000) : null,
    workspace_root: cwd,
    message_count: messageCount,
    tool_call_count: toolCallCount,
    files_modified: Array.from(filesModifiedSet),
    topic_tags: countTopicTags(textChunks.join(' ')),
  }
}

// 找一个 sessionId 对应的 transcript 文件（扫所有 projects 子目录）
function findTranscript(sessionId) {
  if (!existsSync(PROJECTS_ROOT)) return null
  const subdirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
  for (const sub of subdirs) {
    const path = join(PROJECTS_ROOT, sub, `${sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return null
}

// 关联 memories 表：找 created_at 在 session 时间窗内的 memory rowid
// 注意 Phase A 限制：纯时间窗匹配，长 session 会吞别的 session 的 meta。
// Phase B/C 改进：storeMemory 时把 session_id 写入 metadata，精确归属
function findMetaRowids(db, started_at, ended_at) {
  if (!started_at || !ended_at) return []
  const rows = db.prepare(`
    SELECT rowid FROM memories
    WHERE created_at >= ? AND created_at <= ?
      AND deleted_at IS NULL
      AND memory_level = 'meta_knowledge'
    ORDER BY rowid DESC
    LIMIT 50
  `).all(started_at, ended_at)
  return rows.map(r => r.rowid)
}

// 关联其他 session：同 files_modified 重叠 ≥1 或同 topic 重叠 ≥2
function findRelatedSessions(db, sessionId, filesModified, topicTags) {
  const all = db.prepare(`
    SELECT session_id, files_modified, topic_tags FROM session_summaries
    WHERE session_id != ?
  `).all(sessionId)
  const fileSet = new Set(filesModified)
  const tagSet = new Set(topicTags)
  const related = []
  for (const s of all) {
    let otherFiles = []
    let otherTags = []
    try { otherFiles = JSON.parse(s.files_modified) } catch {}
    try { otherTags = JSON.parse(s.topic_tags) } catch {}
    const fileOverlap = otherFiles.filter(f => fileSet.has(f)).length
    const tagOverlap = otherTags.filter(t => tagSet.has(t)).length
    if (fileOverlap >= 1 || tagOverlap >= 2) {
      related.push({ session_id: s.session_id, fileOverlap, tagOverlap })
    }
  }
  return related
    .sort((a, b) => (b.fileOverlap + b.tagOverlap) - (a.fileOverlap + a.tagOverlap))
    .slice(0, 8)
    .map(r => r.session_id)
}

// 写入 / 更新 session_summaries（upsert）
function upsertSummary(db, sessionId, data) {
  const now = Date.now()
  const existing = db.prepare(`SELECT session_id FROM session_summaries WHERE session_id = ?`).get(sessionId)
  if (existing) {
    db.prepare(`
      UPDATE session_summaries SET
        started_at = ?, ended_at = ?, duration_min = ?, workspace_root = ?,
        message_count = ?, tool_call_count = ?,
        files_modified = ?, meta_knowledge_rowids = ?,
        topic_tags = ?, related_session_ids = ?,
        extracted_phase = 'A', extracted_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      data.started_at, data.ended_at, data.duration_min, data.workspace_root,
      data.message_count, data.tool_call_count,
      JSON.stringify(data.files_modified), JSON.stringify(data.meta_knowledge_rowids),
      JSON.stringify(data.topic_tags), JSON.stringify(data.related_session_ids),
      now, now,
      sessionId,
    )
    return 'updated'
  } else {
    db.prepare(`
      INSERT INTO session_summaries
        (session_id, started_at, ended_at, duration_min, workspace_root,
         message_count, tool_call_count,
         files_modified, meta_knowledge_rowids,
         topic_tags, related_session_ids,
         extracted_phase, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A', ?)
    `).run(
      sessionId, data.started_at, data.ended_at, data.duration_min, data.workspace_root,
      data.message_count, data.tool_call_count,
      JSON.stringify(data.files_modified), JSON.stringify(data.meta_knowledge_rowids),
      JSON.stringify(data.topic_tags), JSON.stringify(data.related_session_ids),
      now,
    )
    return 'inserted'
  }
}

// 主流程：处理一个 sessionId
function summarizeSession(db, sessionId) {
  const transcriptPath = findTranscript(sessionId)
  if (!transcriptPath) {
    console.error(`❌ no transcript for ${sessionId}`)
    return null
  }
  const parsed = parseTranscript(transcriptPath)
  parsed.meta_knowledge_rowids = findMetaRowids(db, parsed.started_at, parsed.ended_at)
  parsed.related_session_ids = findRelatedSessions(db, sessionId, parsed.files_modified, parsed.topic_tags)
  const action = upsertSummary(db, sessionId, parsed)
  return { action, ...parsed }
}

// CLI 入口
const args = process.argv.slice(2)
const isBackfill = args.includes('--backfill')
const isAll = args.includes('--all')
const hoursArg = args.find(a => a.startsWith('--hours='))
const hours = hoursArg ? parseInt(hoursArg.split('=')[1], 10) : 72

const db = new Database(DB_PATH)
db.loadExtension(resolve(__dirname, '../lib/libsimple-windows-x64/simple'))
db.prepare('SELECT jieba_dict(?)').run(resolve(__dirname, '../lib/libsimple-windows-x64/dict'))

if (isBackfill || isAll) {
  // 扫所有 transcript
  const cutoff = isAll ? 0 : Date.now() - hours * 3600 * 1000
  const targets = []
  if (existsSync(PROJECTS_ROOT)) {
    const subdirs = readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory())
    for (const sub of subdirs) {
      const dirPath = join(PROJECTS_ROOT, sub.name)
      const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
      for (const f of files) {
        const fpath = join(dirPath, f)
        const stat = statSync(fpath)
        if (stat.mtimeMs < cutoff) continue
        const sessionId = f.replace(/\.jsonl$/, '')
        // session ID 必须像 uuid，否则跳（避开 .jsonl.deleted 等怪文件）
        if (!/^[0-9a-f-]{36}$/.test(sessionId)) continue
        targets.push(sessionId)
      }
    }
  }
  console.log(`Found ${targets.length} sessions in window`)
  let inserted = 0, updated = 0, failed = 0
  for (const sid of targets) {
    try {
      const r = summarizeSession(db, sid)
      if (!r) { failed++; continue }
      if (r.action === 'inserted') inserted++
      else updated++
    } catch (e) {
      failed++
      console.error(`fail ${sid.slice(0, 8)}: ${e.message}`)
    }
  }
  console.log(`done: +${inserted} inserted, ~${updated} updated, ${failed} failed`)
} else if (args.length > 0 && /^[0-9a-f-]{36}$/.test(args[0])) {
  // 单个 sessionId
  const r = summarizeSession(db, args[0])
  if (!r) process.exit(1)
  console.log(JSON.stringify({
    session_id: args[0],
    action: r.action,
    started_at: new Date(r.started_at).toISOString(),
    ended_at: new Date(r.ended_at).toISOString(),
    duration_min: r.duration_min,
    workspace_root: r.workspace_root,
    message_count: r.message_count,
    tool_call_count: r.tool_call_count,
    files_modified_count: r.files_modified.length,
    files_modified_sample: r.files_modified.slice(0, 5),
    topic_tags: r.topic_tags,
    meta_knowledge_rowids_count: r.meta_knowledge_rowids.length,
    related_session_ids: r.related_session_ids,
  }, null, 2))
} else {
  console.error('Usage: session-summarize.mjs <sessionId> | --backfill [--hours=72] | --all')
  process.exit(1)
}

db.close()
