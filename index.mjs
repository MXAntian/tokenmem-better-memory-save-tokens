// ============================================================
// claude-agent-memory v1.0 (SQLite + FTS5)
// 灵感来源：AIRI (moeru-ai/airi) 记忆架构
//
// 核心能力：
//   - 结构化记忆存储（分层 + 分类 + 重要性打分）
//   - FTS5 全文搜索（内置，零依赖）
//   - 复合打分排序（AIRI 风格：重要性 + 文本相关度 + 时间衰减）
//   - 上下文窗口扩展（召回相关消息前后 N 条）
//   - 自动过期 & 记忆升迁（working → long_term）
//   - 可选：向量相似度（JSON 存储，应用层计算余弦距离）
//
// 依赖：better-sqlite3（同步 API，高性能）
// 数据文件：同目录下 engram.db
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = resolve(__dirname, 'engram.db')
const SCHEMA_PATH = resolve(__dirname, 'schema.sql')
// wangfenjin/simple 中文分词扩展（Windows x64 预编译）
const SIMPLE_EXT_DIR = resolve(__dirname, 'lib/libsimple-windows-x64')
const SIMPLE_EXT_PATH = resolve(SIMPLE_EXT_DIR, 'simple')  // .dll 后缀由 loadExtension 自动处理
const SIMPLE_DICT_PATH = resolve(SIMPLE_EXT_DIR, 'dict')

const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] [Memory] ${msg}\n`)

// ── DB 实例 ──────────────────────────────────────────────────
let _db = null
let _embeddingConfig = null
let _simpleLoaded = false  // 是否已成功加载 simple 扩展

/**
 * 获取或创建 DB 实例（加载 simple 分词扩展）
 */
function getDb() {
  if (_db) return _db
  const Database = require('better-sqlite3')
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('busy_timeout = 5000')  // 并发写入时等待 5s 而不是立即报错

  // 加载中文分词扩展（better-sqlite3 的 loadExtension 需要扩展名不含 .dll）
  try {
    if (existsSync(SIMPLE_EXT_PATH + '.dll') || existsSync(SIMPLE_EXT_PATH)) {
      _db.loadExtension(SIMPLE_EXT_PATH)
      _db.prepare('SELECT jieba_dict(?)').run(SIMPLE_DICT_PATH)
      _simpleLoaded = true
      log('中文分词扩展 libsimple + jieba 加载成功')
    }
  } catch (e) {
    log(`中文分词扩展加载失败（降级到字符匹配）: ${e.message}`)
  }

  return _db
}

// ── 初始化 ────────────────────────────────────────────────────

/**
 * 初始化记忆系统：创建表、FTS 索引
 */
export function initMemory() {
  const db = getDb()
  const schema = readFileSync(SCHEMA_PATH, 'utf-8')

  // PRAGMA 必须在事务外单独执行
  const pragmaLines = schema.match(/^PRAGMA\s+[^;]+;/gm) || []
  for (const p of pragmaLines) {
    try { db.exec(p) } catch {}
  }

  // 剩余 DDL 用 exec() 批量执行（better-sqlite3 原生支持多语句）
  const ddl = schema.replace(/^PRAGMA\s+[^;]+;\s*$/gm, '')
  try {
    db.exec(ddl)
  } catch (e) {
    // 首次运行正常创建；后续运行某些语句可能报 already exists
    if (!e.message.includes('already exists')) {
      log(`Schema exec: ${e.message.slice(0, 200)}`)
    }
  }

  log(`Initialized — DB at ${DB_PATH}`)

  // ── FTS 迁移：如果 simple 扩展已加载但 FTS 表还用旧 tokenizer，重建索引 ──────
  if (_simpleLoaded) {
    try {
      // 通过 sqlite_master 检查 FTS 建表语句里的 tokenize 参数
      const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories_fts'`).get()
      const currentSql = ftsRow?.sql || ''
      const currentTokenizer = currentSql.match(/tokenize\s*=\s*'([^']+)'/)?.[1] || 'none'
      if (!currentTokenizer.includes('simple')) {
        log(`FTS 正在迁移: ${currentTokenizer} → simple（重建索引，稍等…）`)
        // 删除旧 FTS 表及触发器，重新用 simple tokenizer 创建
        db.exec(`
          DROP TRIGGER IF EXISTS trg_mem_fts_insert;
          DROP TRIGGER IF EXISTS trg_mem_fts_delete;
          DROP TRIGGER IF EXISTS trg_mem_fts_update;
          DROP TRIGGER IF EXISTS trg_conv_fts_insert;
          DROP TRIGGER IF EXISTS trg_conv_fts_delete;
          DROP TRIGGER IF EXISTS trg_conv_fts_update;
          DROP TABLE IF EXISTS memories_fts;
          DROP TABLE IF EXISTS conversations_fts;

          CREATE VIRTUAL TABLE memories_fts USING fts5(
            content, summary, tags,
            content='memories', content_rowid='rowid',
            tokenize='simple 0'
          );

          CREATE VIRTUAL TABLE conversations_fts USING fts5(
            content, from_name,
            content='conversations', content_rowid='rowid',
            tokenize='simple 0'
          );

          CREATE TRIGGER trg_mem_fts_insert AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;
          CREATE TRIGGER trg_mem_fts_delete AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
            VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
          END;
          CREATE TRIGGER trg_mem_fts_update AFTER UPDATE OF content, summary, tags ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
            VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
            INSERT INTO memories_fts(rowid, content, summary, tags)
            VALUES (new.rowid, new.content, new.summary, new.tags);
          END;

          CREATE TRIGGER trg_conv_fts_insert AFTER INSERT ON conversations BEGIN
            INSERT INTO conversations_fts(rowid, content, from_name)
            VALUES (new.rowid, new.content, new.from_name);
          END;
          CREATE TRIGGER trg_conv_fts_delete AFTER DELETE ON conversations BEGIN
            INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
            VALUES ('delete', old.rowid, old.content, old.from_name);
          END;
          CREATE TRIGGER trg_conv_fts_update AFTER UPDATE OF content ON conversations BEGIN
            INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
            VALUES ('delete', old.rowid, old.content, old.from_name);
            INSERT INTO conversations_fts(rowid, content, from_name)
            VALUES (new.rowid, new.content, new.from_name);
          END;
        `)
        // 用现有数据重建 FTS 索引
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
        db.exec(`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`)
        const memCount = db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c
        log(`FTS 迁移完成，已重建 ${memCount} 条记忆索引（tokenize=simple）`)
      } else {
        log(`FTS 已使用 simple tokenizer，无需迁移`)
      }
    } catch (e) {
      log(`FTS 迁移失败（不影响功能，降级到字符匹配）: ${e.message}`)
    }
  }

  // 检测 embedding 配置
  if (process.env.EMBEDDING_API_BASE_URL && process.env.EMBEDDING_API_KEY) {
    _embeddingConfig = {
      baseUrl: process.env.EMBEDDING_API_BASE_URL,
      apiKey: process.env.EMBEDDING_API_KEY,
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1536', 10),
    }
    log(`Embedding API: ${_embeddingConfig.model} (${_embeddingConfig.dimension}d)`)
  } else {
    log('No embedding API — using FTS5 full-text search only')
  }

  // 清理过期记忆
  expireMemories()

  // 显示统计
  const stats = getMemoryStats()
  log(`Stats: ${stats.memories.total_active} memories, ${stats.conversations} conversations, ${stats.activeGoals} active goals`)
}

// ── Embedding（可选）─────────────────────────────────────────

/**
 * 生成 embedding 向量（OpenAI 兼容接口）
 */
async function generateEmbedding(text) {
  if (!_embeddingConfig) return null
  try {
    const res = await fetch(`${_embeddingConfig.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_embeddingConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: _embeddingConfig.model,
        input: text.slice(0, 8000),
        dimensions: _embeddingConfig.dimension,
      }),
    })
    const data = await res.json()
    return data?.data?.[0]?.embedding || null
  } catch (e) {
    log(`Embedding failed: ${e.message}`)
    return null
  }
}

/**
 * 余弦相似度（应用层计算，替代 pgvector 的 <=> 运算符）
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dotProduct / denom
}

// ── 对话记录 ──────────────────────────────────────────────────

/**
 * 记录一条对话消息
 * @param {Object} msg
 * @param {string} msg.platform
 * @param {string} msg.chatId
 * @param {string} [msg.messageId]
 * @param {string} msg.fromId
 * @param {string} msg.fromName
 * @param {string} msg.role - user | assistant | system
 * @param {string} msg.content
 * @param {boolean} [msg.isReply]
 * @param {string} [msg.replyToId]
 * @param {Object} [msg.metadata]
 * @returns {string|null} conversation id
 */
export function recordConversation(msg) {
  const db = getDb()
  try {
    const stmt = db.prepare(`
      INSERT INTO conversations
        (platform, chat_id, message_id, from_id, from_name, role, content, is_reply, reply_to_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const info = stmt.run(
      msg.platform || 'feishu',
      msg.chatId,
      msg.messageId || null,
      msg.fromId,
      msg.fromName || '',
      msg.role || 'user',
      msg.content,
      msg.isReply ? 1 : 0,
      msg.replyToId || null,
      JSON.stringify(msg.metadata || {}),
    )
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  } catch (e) {
    // UNIQUE constraint = 去重，静默
    if (e.message.includes('UNIQUE')) return null
    log(`recordConversation failed: ${e.message}`)
    return null
  }
}

/**
 * 异步版本：记录对话 + 生成向量（后台不阻塞）
 */
export async function recordConversationAsync(msg) {
  const id = recordConversation(msg)
  if (!id) return null

  // 后台生成 embedding
  const embedding = await generateEmbedding(msg.content)
  if (embedding) {
    try {
      getDb().prepare(`UPDATE conversations SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}
  }
  return id
}

// ── 记忆存储 ──────────────────────────────────────────────────

/**
 * 存储一条记忆
 * @param {Object} mem
 * @returns {string|null} memory id
 */
export function storeMemory(mem) {
  const db = getDb()
  const now = Date.now()

  // 默认 TTL
  let expiresAt = mem.expiresAt || null
  if (!expiresAt && !mem.ttlMs) {
    if (mem.memoryType === 'working') expiresAt = now + 6 * 3600_000      // 6h
    else if (mem.memoryType === 'short_term') expiresAt = now + 7 * 86400_000  // 7d
  } else if (mem.ttlMs) {
    expiresAt = now + mem.ttlMs
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO memories
        (content, summary, memory_type, category, importance, emotional_impact,
         source, source_id, source_platform, tags, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const info = stmt.run(
      mem.content,
      mem.summary || null,
      mem.memoryType || 'working',
      mem.category || 'general',
      mem.importance || 5,
      mem.emotionalImpact || 0,
      mem.source || 'conversation',
      mem.sourceId || null,
      mem.sourcePlatform || 'feishu',
      JSON.stringify(mem.tags || []),
      JSON.stringify(mem.metadata || {}),
      expiresAt,
    )
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  } catch (e) {
    log(`storeMemory failed: ${e.message}`)
    return null
  }
}

/**
 * 异步版本：存储记忆 + 生成向量
 */
export async function storeMemoryAsync(mem) {
  const id = storeMemory(mem)
  if (!id) return null

  const embedding = await generateEmbedding(mem.content)
  if (embedding) {
    try {
      getDb().prepare(`UPDATE memories SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}
  }
  return id
}

// ── 记忆检索（核心！AIRI 风格复合打分）─────────────────────

/**
 * 检索相关记忆
 *
 * 打分策略（模拟 AIRI）：
 *   score = FTS相关度 × 0.4
 *         + importance/10 × 0.3
 *         + 时间衰减 × 0.2
 *         + 访问频率 × 0.1
 *
 * 当向量可用时：向量相似度 × 1.2 替代 FTS × 0.4
 *
 * @param {Object} opts
 * @param {string} [opts.query] - 查询文本
 * @param {string[]} [opts.types] - 限定记忆类型
 * @param {string[]} [opts.categories] - 限定分类
 * @param {string[]} [opts.tags] - 标签过滤（任意匹配）
 * @param {number} [opts.minImportance] - 最低重要性
 * @param {number} [opts.limit] - 返回数量
 * @returns {Array}
 */
export function recallMemories(opts = {}) {
  const db = getDb()
  const { query: queryText, types, categories, tags, minImportance, limit = 10 } = opts
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000

  let rows

  if (queryText) {
    // FTS5 搜索 + 结构化过滤
    // simple 扩展已加载时：使用 jieba_query() 实现中文词级匹配
    // 未加载时：退化为字符级查询（OR 连接每个词）
    const ftsQueryParam = queryText.trim()

    const structuredConditions = ['m.deleted_at IS NULL']
    const structuredParams = []
    if (types?.length) {
      structuredConditions.push(`m.memory_type IN (${types.map(() => '?').join(',')})`)
      structuredParams.push(...types)
    }
    if (categories?.length) {
      structuredConditions.push(`m.category IN (${categories.map(() => '?').join(',')})`)
      structuredParams.push(...categories)
    }
    if (minImportance) {
      structuredConditions.push('m.importance >= ?')
      structuredParams.push(minImportance)
    }

    // 尝试 FTS 搜索
    if (ftsQueryParam) {
      try {
        // simple 扩展加载时：jieba OR 查询（过滤停用词，任意词命中即可）
        // 否则：退化为字符级 OR 查询
        const orQuery = _simpleLoaded
          ? buildJiebaOrQuery(ftsQueryParam)
          : queryText.replace(/[""''【】（）《》，。！？、；：\s]+/g, ' ').trim()
              .split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"`).join(' OR ')

        if (orQuery) {
          const sql = `
            SELECT m.*, mf.rank AS fts_rank
            FROM memories m
            JOIN memories_fts mf ON mf.rowid = m.rowid
            WHERE memories_fts MATCH ?
              AND ${structuredConditions.join(' AND ')}
            ORDER BY mf.rank
            LIMIT ?
          `
          rows = db.prepare(sql).all(orQuery, ...structuredParams, limit * 3)
        }
      } catch (e) {
        log(`FTS query failed: ${e.message}`)
        rows = []
      }
    }

    // FTS 没结果 → fallback 到 LIKE + 结构化过滤
    // 中文关键词拆分：空格分词 + CJK 双字滑窗（"小天是谁" → ["小天", "是谁"]）
    if (!rows || rows.length === 0) {
      const keywords = tokenizeForLike(queryText)
      const likeConditions = keywords.map(() => 'm.content LIKE ?')
      const likeParams = keywords.map(w => `%${w}%`)

      const sql = `
        SELECT m.*, 0 AS fts_rank
        FROM memories m
        WHERE ${structuredConditions.join(' AND ')}
          ${likeConditions.length ? `AND (${likeConditions.join(' OR ')})` : ''}
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ?
      `
      rows = db.prepare(sql).all(...structuredParams, ...likeParams, limit * 3)
    }
  } else {
    // 无查询文本：按重要性 + 时间排序
    const conditions = ['deleted_at IS NULL']
    const params = []
    if (types?.length) {
      conditions.push(`memory_type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    if (categories?.length) {
      conditions.push(`category IN (${categories.map(() => '?').join(',')})`)
      params.push(...categories)
    }
    if (minImportance) {
      conditions.push('importance >= ?')
      params.push(minImportance)
    }

    const sql = `
      SELECT *, 0 AS fts_rank FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `
    params.push(limit)
    rows = db.prepare(sql).all(...params)
  }

  // 复合打分（AIRI 风格）
  const scored = rows.map(row => {
    const ftsScore = row.fts_rank ? Math.min(1, Math.abs(row.fts_rank) / 10) : 0
    const importanceScore = row.importance / 10
    const age = now - row.created_at
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    const accessScore = Math.min(1, row.access_count / 20)

    const score = (ftsScore * 0.4) + (importanceScore * 0.3) + (timeScore * 0.2) + (accessScore * 0.1)

    return { ...row, score, tags: safeJsonParse(row.tags, []), metadata: safeJsonParse(row.metadata, {}) }
  })

  // 标签过滤（应用层，因为 SQLite 没有数组 overlap 操作符）
  let filtered = scored
  if (tags?.length) {
    filtered = scored.filter(r => tags.some(t => r.tags.includes(t)))
  }

  // 按 score 降序排序，取 top N
  filtered.sort((a, b) => b.score - a.score)
  const result = filtered.slice(0, limit)

  // 更新 last_accessed
  if (result.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?
    `)
    const updateMany = db.transaction((items) => {
      for (const item of items) updateStmt.run(now, item.rowid)
    })
    try { updateMany(result) } catch {}
  }

  return result
}

// ── 对话历史检索 ──────────────────────────────────────────────

/**
 * 获取最近 N 条对话（AIRI 的 findLastNMessages）
 */
export function getRecentConversations(chatId, limit = 20) {
  const db = getDb()
  try {
    return db.prepare(`
      SELECT id, platform, from_id, from_name, role, content, created_at, metadata
      FROM conversations
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, limit).reverse()
  } catch (e) {
    log(`getRecentConversations failed: ${e.message}`)
    return []
  }
}

/**
 * 搜索相关对话 + 上下文窗口扩展（AIRI 的 findRelevantMessages）
 */
export function searchConversations(queryText, opts = {}) {
  const db = getDb()
  const { chatId, limit = 3, contextWindow = 3 } = opts

  if (!queryText?.trim()) return []

  try {
    // Step 1: 找 anchor 消息
    // simple 扩展加载时：jieba_query() 词级搜索；否则退化为字符级 OR
    let anchorSQL, anchorParams
    if (_simpleLoaded) {
      const convOrQuery = buildJiebaOrQuery(queryText) || queryText.trim()
      anchorSQL = `
        SELECT c.rowid, c.chat_id, c.created_at, cf.rank AS fts_rank
        FROM conversations c
        JOIN conversations_fts cf ON cf.rowid = c.rowid
        WHERE conversations_fts MATCH ?
          ${chatId ? 'AND c.chat_id = ?' : ''}
        ORDER BY cf.rank
        LIMIT ?
      `
      anchorParams = [convOrQuery]
    } else {
      const ftsQuery = queryText
        .replace(/[""''【】（）《》，。！？、；：]/g, ' ')
        .split(/\s+/).filter(w => w.length > 0).map(w => `"${w}"`).join(' OR ')
      if (!ftsQuery) return []
      anchorSQL = `
        SELECT c.rowid, c.chat_id, c.created_at, cf.rank AS fts_rank
        FROM conversations c
        JOIN conversations_fts cf ON cf.rowid = c.rowid
        WHERE conversations_fts MATCH ?
          ${chatId ? 'AND c.chat_id = ?' : ''}
        ORDER BY cf.rank
        LIMIT ?
      `
      anchorParams = [ftsQuery]
    }
    if (chatId) anchorParams.push(chatId)
    anchorParams.push(limit)

    const anchors = db.prepare(anchorSQL).all(...anchorParams)
    if (anchors.length === 0) return []

    // Step 2: AIRI 风格上下文窗口扩展
    const contextStmt = db.prepare(`
      SELECT id, platform, from_id, from_name, role, content, created_at
      FROM (
        SELECT * FROM conversations WHERE chat_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?
      )
      UNION ALL
      SELECT id, platform, from_id, from_name, role, content, created_at
      FROM (
        SELECT * FROM conversations WHERE chat_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?
      )
      ORDER BY created_at ASC
    `)

    return anchors.map(anchor => ({
      score: Math.abs(anchor.fts_rank),
      messages: contextStmt.all(
        anchor.chat_id, anchor.created_at, contextWindow + 1,
        anchor.chat_id, anchor.created_at, contextWindow,
      ),
    }))
  } catch (e) {
    log(`searchConversations failed: ${e.message}`)
    return []
  }
}

// ── 构建记忆上下文（注入 system prompt 的核心函数）──────────

/**
 * 为当前消息构建记忆上下文
 * 组合：相关记忆 + 相关历史对话 + 活跃目标
 *
 * @param {Object} opts
 * @param {string} opts.query - 当前用户消息
 * @param {string} [opts.chatId] - 当前聊天 ID
 * @param {number} [opts.memoryLimit] - 召回记忆数
 * @returns {string} 格式化的记忆上下文（为空则返回空字符串）
 */
export function buildMemoryContext(opts = {}) {
  const { query: queryText, chatId, memoryLimit = 8 } = opts
  const sections = []

  // 1. 相关记忆（有查询词时按语义召回；无查询词时注入高重要性基础记忆）
  const memories = queryText
    ? recallMemories({ query: queryText, limit: memoryLimit, minImportance: 3 })
    : recallMemories({ limit: memoryLimit, minImportance: 7 })
  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const prefix = { permanent: '📌', long_term: '🔷', short_term: '🔹', working: '·' }[m.memory_type] || '·'
      const tagStr = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      const age = Math.floor((Date.now() - m.created_at) / 86400_000)
      const ageStr = age === 0 ? '今天' : age === 1 ? '昨天' : `${age}天前`
      const text = m.summary || m.content.slice(0, 200)
      return `${prefix} (${m.category}, 重要性${m.importance}, ${ageStr})${tagStr}\n   ${text}`
    })
    sections.push(`<recalled-memories>\n${memLines.join('\n')}\n</recalled-memories>`)
  }

  // 2. 相关历史对话片段
  if (queryText) {
    const segments = searchConversations(queryText, { chatId, limit: 2, contextWindow: 3 })
    if (segments.length > 0) {
      const convLines = segments.map(seg => {
        return seg.messages.map(m => {
          const time = new Date(Number(m.created_at)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          return `  [${time}] ${m.from_name || m.role}: ${m.content.slice(0, 150)}`
        }).join('\n')
      })
      sections.push(`<relevant-conversations>\n${convLines.join('\n---\n')}\n</relevant-conversations>`)
    }
  }

  // 3. 活跃目标
  try {
    const goals = getDb().prepare(`
      SELECT title, description, priority, progress, status
      FROM goals
      WHERE deleted_at IS NULL AND status IN ('planned', 'in_progress')
      ORDER BY priority DESC LIMIT 5
    `).all()

    if (goals.length > 0) {
      const goalLines = goals.map(g =>
        `- [${g.status === 'in_progress' ? '进行中' : '计划'}] ${g.title} (P${g.priority}, ${g.progress}%)${g.description ? ': ' + g.description.slice(0, 80) : ''}`
      )
      sections.push(`<active-goals>\n${goalLines.join('\n')}\n</active-goals>`)
    }
  } catch {}

  if (sections.length === 0) return ''

  return [
    '',
    '## Agent 记忆系统（自动召回）',
    '以下是与当前对话相关的记忆和历史。可参考但不必逐条回应：',
    '',
    ...sections,
  ].join('\n')
}

// ── 记忆管理 ──────────────────────────────────────────────────

/** 清理过期记忆 */
export function expireMemories() {
  const db = getDb()
  try {
    const info = db.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < unixepoch() * 1000
    `).run()
    if (info.changes > 0) log(`Expired ${info.changes} memories`)
    return info.changes
  } catch { return 0 }
}

/** 记忆升迁：working → short_term → long_term */
export function promoteMemories() {
  const db = getDb()
  try {
    // working → short_term：访问≥3 或 importance≥7
    const r1 = db.prepare(`
      UPDATE memories
      SET memory_type = 'short_term',
          expires_at = unixepoch() * 1000 + 604800000,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'working' AND deleted_at IS NULL
        AND (access_count >= 3 OR importance >= 7)
    `).run()

    // short_term → long_term：访问≥8 或 importance≥8
    const r2 = db.prepare(`
      UPDATE memories
      SET memory_type = 'long_term',
          expires_at = NULL,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'short_term' AND deleted_at IS NULL
        AND (access_count >= 8 OR importance >= 8)
    `).run()

    if (r1.changes || r2.changes) {
      log(`Promoted: ${r1.changes} → short_term, ${r2.changes} → long_term`)
    }
  } catch (e) {
    log(`promoteMemories failed: ${e.message}`)
  }
}

// ── 目标管理 ──────────────────────────────────────────────────

export function upsertGoal(goal) {
  const db = getDb()
  if (goal.id) {
    db.prepare(`
      UPDATE goals SET title = coalesce(?, title), description = coalesce(?, description),
        priority = coalesce(?, priority), progress = coalesce(?, progress),
        status = coalesce(?, status), updated_at = unixepoch() * 1000
      WHERE id = ?
    `).run(goal.title, goal.description, goal.priority, goal.progress, goal.status, goal.id)
    return goal.id
  } else {
    const info = db.prepare(`
      INSERT INTO goals (title, description, priority, progress, status, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(goal.title, goal.description || '', goal.priority || 5, goal.progress || 0,
           goal.status || 'planned', goal.category || 'project')
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  }
}

// ── 统计 ──────────────────────────────────────────────────────

export function getMemoryStats() {
  const db = getDb()
  try {
    const mem = db.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS total_active,
        SUM(CASE WHEN memory_type = 'working' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS working,
        SUM(CASE WHEN memory_type = 'short_term' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS short_term,
        SUM(CASE WHEN memory_type = 'long_term' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS long_term,
        SUM(CASE WHEN memory_type = 'permanent' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS permanent
      FROM memories
    `).get()
    const conv = db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get()
    const goals = db.prepare(`
      SELECT COUNT(*) AS count FROM goals WHERE deleted_at IS NULL AND status IN ('planned', 'in_progress')
    `).get()

    return {
      memories: {
        total_active: mem?.total_active || 0,
        working: mem?.working || 0,
        short_term: mem?.short_term || 0,
        long_term: mem?.long_term || 0,
        permanent: mem?.permanent || 0,
      },
      conversations: conv?.count || 0,
      activeGoals: goals?.count || 0,
      embeddingConfigured: !!_embeddingConfig,
    }
  } catch (e) {
    return { error: e.message }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// 高频停用词，FTS 搜索时过滤掉（太泛，命中噪声大）
const FTS_STOP_WORDS = new Set([
  '的','了','是','在','有','和','与','或','但','而','也','都','很','就','才','被',
  '你','我','他','她','它','们','您','咱','俺',
  '呢','吗','啊','哦','哈','嗯','嘿','喂','啥','呀','嘛','吧','么',
  '什么','怎么','哪里','哪个','谁','哪','一下','方便','以后','一起','一','不',
  '想','这','那','这个','那个','有没有','可以','可能','需要','应该','如果',
])

/**
 * 使用 jieba 分词构建 FTS OR 查询（simple 扩展加载时）
 * "你平时不爱吃什么" → "不爱" OR "口味" OR "偏好"（过滤停用词 + 单字）
 */
function buildJiebaOrQuery(text) {
  if (!_simpleLoaded) return null
  try {
    const db = getDb()
    const jiebaRaw = db.prepare('SELECT jieba_query(?) AS q').get(text.slice(0, 200))?.q || ''
    const terms = [...jiebaRaw.matchAll(/"([^"]+)"/g)].map(m => m[1])
    const keywords = terms.filter(t => t.length > 1 && !FTS_STOP_WORDS.has(t))
    if (keywords.length === 0) return null
    return keywords.map(t => `"${t}"`).join(' OR ')
  } catch { return null }
}

/**
 * 中文友好的关键词拆分（用于 LIKE 查询）
 * 先按空格分词，然后对连续 CJK 字符串做双字滑窗
 * "小天是谁" → ["小天", "是谁"]
 * "SEO 技术资产" → ["SEO", "技术", "资产"]
 */
function tokenizeForLike(text) {
  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
  const words = text
    .replace(/[""''【】（）《》，。！？、；：\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)

  const tokens = []
  for (const w of words) {
    if (CJK.test(w) && w.length > 2) {
      // CJK 双字滑窗
      for (let i = 0; i < w.length - 1; i++) {
        if (CJK.test(w[i])) tokens.push(w.slice(i, i + 2))
      }
    } else {
      tokens.push(w)
    }
  }
  return [...new Set(tokens)]  // 去重
}

/** 关闭数据库连接 */
export function closeMemory() {
  if (_db) {
    _db.close()
    _db = null
    log('DB closed')
  }
}

// ── CLI 模式 ──────────────────────────────────────────────────────────────────
// 直接执行时（node memory/index.mjs --stats 等），提供命令行接口
// 用于 SessionStart hook 和主会话按需召回

import { fileURLToPath as _ftu } from 'node:url'
const _isMain = process.argv[1] && resolve(process.argv[1]) === resolve(_ftu(import.meta.url))

if (_isMain) {
  const args = process.argv.slice(2)
  const getFlag = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 ? (args[i + 1] || '') : null
  }
  const hasFlag = (flag) => args.includes(flag)

  try {
    initMemory()

    if (hasFlag('--stats')) {
      // ── 输出统计 JSON ──
      const stats = getMemoryStats()
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n')

    } else if (getFlag('--context') !== null) {
      // ── 构建上下文块（给 hook/session 注入用）──
      const query = getFlag('--context') || ''
      const ctx = buildMemoryContext({ query, memoryLimit: 10 })
      if (ctx) process.stdout.write(ctx + '\n')

    } else if (getFlag('--recall') !== null) {
      // ── 召回记忆列表（人类可读）──
      const query = getFlag('--recall') || ''
      const limit = parseInt(getFlag('--limit') || '10', 10)
      const memories = recallMemories({ query, limit })
      if (memories.length === 0) {
        process.stdout.write('（无相关记忆）\n')
      } else {
        for (const m of memories) {
          const date = new Date(m.created_at).toLocaleDateString('zh-CN')
          process.stdout.write(`[${m.importance}★ ${m.memory_type} ${date}] ${m.content.slice(0, 120)}\n`)
        }
      }

    } else if (getFlag('--store') !== null) {
      // ── 手动存入一条记忆 ──
      const content = getFlag('--store')
      if (!content || content.trim().length === 0) {
        process.stderr.write('Error: --store 需要内容参数\n')
        process.exit(1)
      }
      const importance = parseInt(getFlag('--importance') || '6', 10)
      const category = getFlag('--category') || 'general'
      const memoryType = getFlag('--type') || 'long_term'
      const id = storeMemory({
        content: content.trim(),
        memoryType,
        category,
        importance,
        source: 'manual',
        tags: ['cli', 'manual'],
      })
      process.stdout.write(`stored: ${id}\n`)

    } else {
      process.stderr.write([
        'claude-agent-memory CLI',
        '',
        '用法:',
        '  node memory/index.mjs --stats                  输出统计 JSON',
        '  node memory/index.mjs --context "查询词"        构建注入上下文',
        '  node memory/index.mjs --recall "查询词"         召回记忆列表',
        '  node memory/index.mjs --recall "" --limit 20   列出最近 20 条',
        '  node memory/index.mjs --store "内容"           手动存入记忆',
        '    [--importance 1-10] [--category general|people|project|...]',
        '    [--type working|short_term|long_term|permanent]',
        '',
      ].join('\n'))
      process.exit(1)
    }

  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`)
    process.exit(1)
  } finally {
    closeMemory()
  }
}
