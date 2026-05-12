// ============================================================
// tokenmem v1.1 (SQLite + FTS5)
// Token-efficient persistent memory for AI agents
// Inspired by: AIRI (moeru-ai/airi) memory architecture
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
// 数据文件：同目录下 tokenmem.db
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// 在 module load 时同步加载 chinatsu-workspace/.env.local，让 EMBEDDING_API_* 等
// 在 initEmbeddingConfig 之前就位。daemon 自己也有同样逻辑（独立路径），但 mcp-server.mjs
// 直接 import 本文件——ESM hoist 让外部 dotenv.config 永远晚于 module-level 代码，
// 所以必须在这里就同步注入。
// （HTTP transport 改造后由 schtasks/hook 兜底起 mcp-server，env 不靠 cmd shell 继承）
try {
  for (const candidate of ['.env.local', '.env']) {
    const envPath = resolve(__dirname, '..', candidate)
    if (!existsSync(envPath)) continue
    const envText = readFileSync(envPath, 'utf-8')
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = value  // 不覆盖已存在的 env
    }
    break  // 取第一个找到的（.env.local 优先）
  }
} catch (e) {
  // env 文件缺失/格式错也无所谓——FTS5 仍工作，只是 embedding 不可用
}

const DB_PATH = resolve(__dirname, 'engram.db')
const SCHEMA_PATH = resolve(__dirname, 'schema.sql')
// wangfenjin/simple 中文分词扩展（Windows x64 预编译）
const SIMPLE_EXT_DIR = resolve(__dirname, 'lib/libsimple-windows-x64')
const SIMPLE_EXT_PATH = resolve(SIMPLE_EXT_DIR, 'simple')  // .dll 后缀由 loadExtension 自动处理
const SIMPLE_DICT_PATH = resolve(SIMPLE_EXT_DIR, 'dict')

// asg017/sqlite-vec 向量搜索扩展（Windows x64 预编译）
const VEC_EXT_DIR = resolve(__dirname, 'lib/sqlite-vec-windows-x64')
const VEC_EXT_PATH = resolve(VEC_EXT_DIR, 'vec0')

const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] [Memory] ${msg}\n`)

// ── Unicode-safe 字符串工具 ─────────────────────────────────
// JS 字符串是 UTF-16 code unit 数组，4 字节 emoji（如 💡 🔷 🎉）占两个 code unit
// 形成 surrogate pair（高代理 0xD800-0xDBFF + 低代理 0xDC00-0xDFFF）。
// 直接 .slice(0, n) 若切在 pair 中间会留下孤立高代理，导致下游 JSON.stringify
// 产出非法 JSON（Anthropic API 报 "no low surrogate in string"），把整个请求毒掉。

/** UTF-16 surrogate-pair 安全的 slice：避免切断 4 字节 emoji */
export function safeSlice(str, n) {
  if (str == null) return str
  if (typeof str !== 'string') str = String(str)
  if (str.length <= n) return str
  let end = n
  const code = str.charCodeAt(end - 1)
  // 末位是高代理（pair 的前半），单独留下就是孤儿，砍掉
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return str.slice(0, end)
}

/** 兜底：剥离任何孤立的 surrogate（缺配对的高代理或低代理），防止已被毒过的字符串扩散 */
export function sanitizeUnpaired(str) {
  if (str == null || typeof str !== 'string') return str
  // 高代理后面没跟低代理，或低代理前面没高代理 → 替换为 U+FFFD（替换字符）
  return str
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '�')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1�')
}

// ── DB 实例 ──────────────────────────────────────────────────
let _db = null
let _embeddingConfig = null
let _simpleLoaded = false  // 是否已成功加载 simple 扩展
let _vecLoaded = false     // 是否已成功加载 sqlite-vec 扩展

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

  // 加载 sqlite-vec 向量搜索扩展
  try {
    if (existsSync(VEC_EXT_PATH + '.dll') || existsSync(VEC_EXT_PATH)) {
      _db.loadExtension(VEC_EXT_PATH)
      const ver = _db.prepare('SELECT vec_version() AS v').get()?.v || 'unknown'
      _vecLoaded = true
      log(`sqlite-vec 向量搜索扩展加载成功 (${ver})`)
    }
  } catch (e) {
    log(`sqlite-vec 加载失败（降级到仅 FTS5）: ${e.message}`)
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

  // ── Schema 增量迁移 ───────────────────────────────────────────
  // 新增列：compressed_from, is_compressed（压缩管线）
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN compressed_from TEXT DEFAULT '[]'`)
    log('Migration: added compressed_from column')
  } catch {}  // "duplicate column name" = 已存在，忽略
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN is_compressed INTEGER NOT NULL DEFAULT 0`)
    log('Migration: added is_compressed column')
  } catch {}
  // 抽象层级（Memory Transfer Learning）
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN memory_level TEXT NOT NULL DEFAULT 'semi_abstract'`)
    log('Migration: added memory_level column')
  } catch {}  // 已存在
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_level ON memories(memory_level) WHERE deleted_at IS NULL`)
  } catch {}

  // 向量搜索虚拟表（sqlite-vec）
  // 维度由 _embeddingConfig 决定（百炼 v3 = 1024），不存在时跳过
  if (_vecLoaded && _embeddingConfig) {
    try {
      const dim = _embeddingConfig.dimension
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          memory_rowid INTEGER PRIMARY KEY,
          embedding FLOAT[${dim}]
        )
      `)
      log(`向量虚拟表 memories_vec 就绪 (dim=${dim})`)
    } catch (e) {
      log(`memories_vec 创建失败: ${e.message}`)
    }
  }
  // 新增表：search_misses（搜索未命中追踪）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_misses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'recall',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_miss_query ON search_misses(query)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_miss_created ON search_misses(created_at DESC)`)
  } catch {}

  // 新增表：recall_log（每次 recall 调用流水，用于 per-prompt 利用率监控）
  // recall_log: access_count 累计指标无法回答"日均 recall 次数 / 调用方分布 / per-prompt 命中"
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,                       -- 调用时间（ms）
        source TEXT NOT NULL DEFAULT 'unknown',    -- mcp / cli / prompt-recall-hook / tool-recall-hook / context-builder / unknown
        session_id TEXT,                           -- CC session id（hook 路径有；mcp/cli 一般为 NULL）
        query TEXT,                                -- 查询词（截 200）
        hit_ids TEXT,                              -- JSON array of rowid
        hit_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,                       -- 召回耗时（ms）
        filter_level TEXT,                         -- meta_knowledge 等（CSV 多个）
        filter_min_importance INTEGER,
        query_path TEXT NOT NULL DEFAULT 'sync'    -- sync | hybrid
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_log_ts ON recall_log(ts DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_log_source ON recall_log(source, ts DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_log_session ON recall_log(session_id, ts DESC) WHERE session_id IS NOT NULL`)
  } catch {}

  // 2026-05-06 加：final_hit_count 字段，区分 raw 候选池（hit_count）vs hook 后置过滤后真注入的数
  // 由 hook 后置过滤完调用 --update-recall-log <id> --final-count <n> fire-and-forget 写入
  try {
    db.exec(`ALTER TABLE recall_log ADD COLUMN final_hit_count INTEGER`)
  } catch {}  // 已存在

  // Migration: memories.source CHECK 约束添加 'compression'
  // SQLite 不支持 ALTER CHECK → 检查当前 source CHECK 是否包含 'compression'，没有就重建表
  try {
    const memSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'`).get()?.sql || ''
    if (memSchema && !memSchema.includes("'compression'")) {
      log('Migration: rebuilding memories table to add compression source')
      db.exec(`
        BEGIN TRANSACTION;

        -- 禁用 FTS 触发器（避免重建时触发）
        DROP TRIGGER IF EXISTS trg_mem_fts_insert;
        DROP TRIGGER IF EXISTS trg_mem_fts_delete;
        DROP TRIGGER IF EXISTS trg_mem_fts_update;

        ALTER TABLE memories RENAME TO memories_old;

        CREATE TABLE memories (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          content TEXT NOT NULL CHECK (length(content) > 0),
          summary TEXT,
          memory_type TEXT NOT NULL DEFAULT 'working'
            CHECK (memory_type IN ('working', 'short_term', 'long_term', 'permanent')),
          category TEXT NOT NULL DEFAULT 'general'
            CHECK (category IN ('general', 'people', 'project', 'decision', 'feedback',
                                 'bug', 'relationship', 'skill', 'preference')),
          importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
          emotional_impact INTEGER NOT NULL DEFAULT 0 CHECK (emotional_impact BETWEEN -10 AND 10),
          source TEXT NOT NULL DEFAULT 'conversation'
            CHECK (source IN ('conversation', 'observation', 'manual', 'extraction', 'compression')),
          source_id TEXT,
          source_platform TEXT DEFAULT 'feishu',
          tags TEXT DEFAULT '[]',
          compressed_from TEXT DEFAULT '[]',
          is_compressed INTEGER NOT NULL DEFAULT 0,
          memory_level TEXT NOT NULL DEFAULT 'semi_abstract'
            CHECK (memory_level IN ('concrete_trace', 'semi_abstract', 'meta_knowledge')),
          metadata TEXT DEFAULT '{}',
          content_vector TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          access_count INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER,
          deleted_at INTEGER
        );

        -- 按列名显式复制，NULL 值用默认值填充
        INSERT INTO memories (
          id, content, summary, memory_type, category, importance, emotional_impact,
          source, source_id, source_platform, tags, compressed_from, is_compressed,
          memory_level, metadata, content_vector, created_at, updated_at, last_accessed,
          access_count, expires_at, deleted_at
        )
        SELECT
          id, content, summary, memory_type, category, importance, emotional_impact,
          source, source_id, source_platform, tags,
          COALESCE(compressed_from, '[]') AS compressed_from,
          COALESCE(is_compressed, 0) AS is_compressed,
          'semi_abstract' AS memory_level,
          metadata, content_vector, created_at, updated_at, last_accessed, access_count,
          expires_at, deleted_at
        FROM memories_old;
        DROP TABLE memories_old;

        -- 重建索引
        CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source_platform, source) WHERE deleted_at IS NULL;

        -- 重建 FTS 触发器
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

        COMMIT;
      `)
      // 重建 FTS 索引（因为迁移期间触发器被禁用）
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      log('Migration: memories table rebuilt, FTS reindexed')
    }
  } catch (e) {
    log(`Migration memories CHECK failed: ${e.message}`)
    try { db.exec('ROLLBACK') } catch {}
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
        encoding_format: 'float',
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

  // 压缩管线支持：compressed_from 标记源记忆，is_compressed 标记产物
  const compressedFrom = mem.compressedFrom || []
  const isCompressed = compressedFrom.length > 0 ? 1 : 0

  // 防级联：如果 compressedFrom 包含已是压缩产物的记忆，拒绝（防止幻觉放大）
  if (compressedFrom.length > 0) {
    const cascadeCheck = db.prepare(
      `SELECT rowid FROM memories WHERE rowid IN (${compressedFrom.map(() => '?').join(',')}) AND is_compressed = 1`
    ).all(...compressedFrom)
    if (cascadeCheck.length > 0) {
      log(`storeMemory: 拒绝级联压缩（源中有 ${cascadeCheck.length} 条已是压缩产物）`)
      return null
    }
  }

  // 抽象层级（Memory Transfer Learning）：
  // - concrete_trace: "04-16 修了 X bug" 类具体操作 → 低召回权重
  // - semi_abstract:  "做了 X 因为 Y" → 默认
  // - meta_knowledge: "遇到 X 类问题时应该 Y" → 高召回权重
  const validLevels = ['concrete_trace', 'semi_abstract', 'meta_knowledge']
  const memoryLevel = validLevels.includes(mem.memoryLevel) ? mem.memoryLevel : 'semi_abstract'

  // 结构化 supersede（harness-evolve #001）：填充后旧记忆会在下一次 expireMemories 被软删
  // mem.supersedes 是 rowid 字符串数组（与 storeMemory 返回值同制）
  const supersedes = Array.isArray(mem.supersedes)
    ? mem.supersedes.filter(s => typeof s === 'string' && /^\d+$/.test(s.trim())).map(s => s.trim())
    : []

  try {
    const insertStmt = db.prepare(`
      INSERT INTO memories
        (content, summary, memory_type, category, importance, emotional_impact,
         source, source_id, source_platform, tags, metadata, expires_at,
         compressed_from, is_compressed, memory_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const supersedeStmt = db.prepare(
      `UPDATE memories SET superseded_by = ? WHERE rowid = ? AND deleted_at IS NULL AND superseded_by IS NULL`
    )
    // migration 003 (2026-05-13)：paper trail —— supersede 时把旧记忆 content/summary
    // 推进新记忆的 prior_versions[]（不破坏现 superseded_by 指针机制；recall 只返 latest
    // content，但 audit / 追根因可以看链路）
    const priorsLoadStmt = db.prepare(
      `SELECT rowid, content, summary, created_at, prior_versions FROM memories WHERE rowid = ?`
    )
    const priorsUpdateStmt = db.prepare(
      `UPDATE memories SET prior_versions = ? WHERE rowid = ?`
    )

    let newId = null
    const tx = db.transaction(() => {
      const info = insertStmt.run(
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
        JSON.stringify(compressedFrom),
        isCompressed,
        memoryLevel,
      )
      newId = info.lastInsertRowid ? String(info.lastInsertRowid) : null
      if (newId && supersedes.length > 0) {
        // migration 003: 先读旧记忆 → 构造 prior_versions[] → UPDATE 新记忆
        // 链式吸收：旧记忆自己的 prior_versions 也并进来（防止 v3 supersede v2，v2 supersede v1
        // 时 v1 历史丢失）
        const priors = []
        for (const oldRowid of supersedes) {
          const old = priorsLoadStmt.get(oldRowid)
          if (!old) continue
          try {
            const oldPriors = JSON.parse(old.prior_versions || '[]')
            if (Array.isArray(oldPriors)) priors.push(...oldPriors)
          } catch {}
          priors.push({
            content: old.content,
            summary: old.summary || null,
            merged_at: now,
            source_rowid: old.rowid,
            created_at: old.created_at,
          })
        }
        if (priors.length > 0) {
          try { priorsUpdateStmt.run(JSON.stringify(priors), newId) } catch (e) {
            log(`storeMemory: prior_versions update failed for ${newId}: ${e.message}`)
          }
        }
        // 现有 superseded_by 指针机制保持不变（expireMemories 软删旧记录）
        let supCount = 0
        for (const oldRowid of supersedes) {
          const r = supersedeStmt.run(newId, oldRowid)
          if (r.changes > 0) supCount++
        }
        if (supCount > 0) log(`storeMemory: ${newId} supersedes ${supCount}/${supersedes.length} old memories (priors=${priors.length})`)
      }
    })
    tx()
    return newId
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
    const db = getDb()
    try {
      // 备份 JSON 字符串到 memories.content_vector（跨工具可见 + 备份）
      db.prepare(`UPDATE memories SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}

    // 同步到 sqlite-vec 虚拟表（供 KNN 查询）
    // 注意：storeMemory 返回的 id 就是 rowid（见其实现 lastInsertRowid → String）
    if (_vecLoaded) {
      try {
        db.prepare(`INSERT OR REPLACE INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(id), new Float32Array(embedding))
      } catch (e) {
        log(`memories_vec insert failed (id=${id}): ${e.message}`)
      }
    }
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
            SELECT m.rowid AS rowid, m.*, mf.rank AS fts_rank
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
        SELECT m.rowid AS rowid, m.*, 0 AS fts_rank
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
      SELECT rowid, *, 0 AS fts_rank FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `
    params.push(limit)
    rows = db.prepare(sql).all(...params)
  }

  // 复合打分（AIRI 风格 + Memory Transfer Learning 层级加权）
  // meta_knowledge × 1.3（高层模式/启发式，跨场景最有效）
  // semi_abstract × 1.0（默认）
  // concrete_trace × 0.7（具体操作，易负迁移）
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
  const scored = rows.map(row => {
    const ftsScore = row.fts_rank ? Math.min(1, Math.abs(row.fts_rank) / 10) : 0
    const importanceScore = row.importance / 10
    const age = now - row.created_at
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    const accessScore = Math.min(1, row.access_count / 20)
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0

    const baseScore = (ftsScore * 0.4) + (importanceScore * 0.3) + (timeScore * 0.2) + (accessScore * 0.1)
    // migration 003 (2026-05-13)：decay_score 当权重（runDecayCycle 周期更新）
    // 没跑过 decay 周期的记忆默认 1.0，等价于不衰减——向后兼容
    const decay = (row.decay_score != null) ? row.decay_score : 1.0
    const score = baseScore * levelWeight * decay

    return { ...row, score, tags: safeJsonParse(row.tags, []), metadata: safeJsonParse(row.metadata, {}) }
  })

  // 标签过滤（应用层，因为 SQLite 没有数组 overlap 操作符）
  let filtered = scored
  if (tags?.length) {
    filtered = scored.filter(r => tags.some(t => r.tags.includes(t)))
  }

  // 按 score 降序排序，取 top N
  filtered.sort((a, b) => b.score - a.score)
  let result = filtered.slice(0, limit)

  // migration 003：surfaced_random —— 命中不足 limit 时 25% 概率从冷池里浮现 1-3 条
  // 冷池：importance ≥ 8 AND 30d 未 hit AND decay_score ≥ 0.3，模拟"忽然想起"
  // 仅外部调用走（_internal=true 跳过，hybrid 内部拿候选池时不打扰）
  if (!opts._internal && queryText && result.length < limit) {
    const surfaced = surfaceRandomMemories(db, result.map(r => r.rowid), limit - result.length, now)
    if (surfaced.length > 0) result = result.concat(surfaced)
  }

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

  // 搜索未命中追踪：查了但没找到 = 知识盲区信号
  if (queryText && result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'recall')
    } catch {}
  }

  // recall_log 打点（_internal=true 跳过——hybrid 内部调本函数拿 FTS 候选池时不重复计）
  if (!opts._internal) {
    const recallLogId = logRecall({
      source: opts._source || 'unknown',
      sessionId: opts._sessionId || null,
      query: queryText,
      hitIds: result.map(r => r.rowid),
      durationMs: Date.now() - now,
      filterLevel: opts._filterLevel || null,
      minImportance: opts._minImportance || null,
      queryPath: 'sync',
    })
    // 通过 opts._out 引用回传 id（CLI 端用于 --format json 输出，hook 用于 --update-recall-log）
    if (opts._out && typeof opts._out === 'object') opts._out.recallLogId = recallLogId
  }

  return result
}

// ── 单次 recall 流水打点 helper ────────────────────────────────────
// 2026-05-05 加 — 比 access_count 累加更细粒度，用于 per-prompt 利用率分析
// 2026-05-06 改 — 返回 lastInsertRowid（recall_log_id），让 CLI 透出给 hook 用于后置 update final_hit_count
function logRecall({ source, sessionId, query, hitIds, durationMs, filterLevel, minImportance, queryPath }) {
  try {
    const db = getDb()
    const result = db.prepare(`
      INSERT INTO recall_log (ts, source, session_id, query, hit_ids, hit_count, duration_ms, filter_level, filter_min_importance, query_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      source || 'unknown',
      sessionId || null,
      (query || '').slice(0, 200),
      JSON.stringify(Array.isArray(hitIds) ? hitIds.slice(0, 20) : []),
      Array.isArray(hitIds) ? hitIds.length : 0,
      durationMs || 0,
      filterLevel || null,
      minImportance == null ? null : minImportance,
      queryPath || 'sync',
    )
    return Number(result.lastInsertRowid)
  } catch (e) {
    // 打点失败不影响主流程；写到 stderr 留痕
    try { process.stderr.write(`[recall_log INSERT failed] ${e.message}\n`) } catch {}
    return null
  }
}

// ── 混合检索：FTS5 + 向量 + RRF 融合 ───────────────────────────────
//
// 原理：
//   1. FTS5 路径：关键词/词法匹配（简历、不爱吃香菜 这种字面查询强）
//   2. 向量路径：语义匹配（同义词、换个说法也能找到）
//   3. RRF (Reciprocal Rank Fusion): score = Σ 1/(k + rank)，k=60
//      只用排名、不用原始分，两个尺度不同的榜单可以平等融合
//
// 性能：
//   - 一次 embedding API 调用（查询向量，~120ms）
//   - 本地 FTS + vec KNN 并行，都是亚毫秒级
//   - 总延迟约 150ms（FTS 独走 <10ms，多出的全是 embedding API 网络）

const RRF_K = 60

/**
 * 混合检索：FTS5 + 向量 + RRF 融合
 * @param {Object} opts  同 recallMemories
 * @returns {Promise<Array>}
 */
export async function recallMemoriesHybrid(opts = {}) {
  const { query: queryText, limit = 10 } = opts

  // 没有查询词或扩展未就绪 → 回退到同步版本
  if (!queryText || !_vecLoaded || !_embeddingConfig) {
    return recallMemories(opts)
  }

  const db = getDb()
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }

  // 并行：向量查询（拿 embedding）+ FTS 查询
  const [queryEmbedding, ftsRows] = await Promise.all([
    generateEmbedding(queryText),
    // FTS 召回：复用同步 recallMemories，limit 放大拿候选池
    // _internal=true 跳过 recall_log 打点（hybrid 出口统一打点，避免双计）
    Promise.resolve(recallMemories({ ...opts, limit: limit * 3, _internal: true })),
  ])

  // 向量路径：KNN 查 top N
  let vecRows = []
  if (queryEmbedding) {
    try {
      vecRows = db.prepare(`
        SELECT m.rowid AS rowid, m.*, v.distance AS vec_distance
        FROM (
          SELECT memory_rowid, distance
          FROM memories_vec
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        ) AS v
        JOIN memories m ON m.rowid = v.memory_rowid
        WHERE m.deleted_at IS NULL
      `).all(new Float32Array(queryEmbedding), limit * 3)
      // 解析 tags/metadata 以与 FTS 结果对齐
      vecRows = vecRows.map(r => ({
        ...r,
        tags: safeJsonParse(r.tags, []),
        metadata: safeJsonParse(r.metadata, {}),
      }))
    } catch (e) {
      log(`Vec KNN failed: ${e.message}`)
    }
  }

  // RRF 融合
  const rrfScores = new Map()  // rowid → { row, rrf }
  const addRanks = (rows, source) => {
    rows.forEach((row, idx) => {
      const rowid = row.rowid
      if (!rowid) return
      const contribution = 1 / (RRF_K + idx + 1)
      const existing = rrfScores.get(rowid)
      if (existing) {
        existing.rrf += contribution
        existing.sources.push(source)
      } else {
        rrfScores.set(rowid, { row, rrf: contribution, sources: [source] })
      }
    })
  }
  addRanks(ftsRows, 'fts')
  addRanks(vecRows, 'vec')

  // 叠加 Memory Transfer Learning 层级加权 + 重要性 + 时间衰减 + decay_score（migration 003）
  const merged = Array.from(rrfScores.values()).map(({ row, rrf, sources }) => {
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0
    const importanceScore = row.importance / 10
    const age = now - row.created_at
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    // migration 003：decay_score 当权重（runDecayCycle 周期更新，默认 1.0 向后兼容）
    const decay = (row.decay_score != null) ? row.decay_score : 1.0
    // 复合：RRF 为主（0.7）+ importance/time 调整（0.3），再乘层级权重 × decay
    const score = (rrf * 0.7 + (importanceScore * 0.2 + timeScore * 0.1)) * levelWeight * decay
    return { ...row, score, rrf, recall_sources: sources }
  })

  merged.sort((a, b) => b.score - a.score)
  let result = merged.slice(0, limit)

  // migration 003：surfaced_random —— 命中不足 limit 时 25% 概率从冷池浮现 1-3 条
  if (result.length < limit) {
    const surfaced = surfaceRandomMemories(db, result.map(r => r.rowid), limit - result.length, now)
    if (surfaced.length > 0) result = result.concat(surfaced)
  }

  // 更新 last_accessed
  if (result.length > 0) {
    const stmt = db.prepare(`UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?`)
    const tx = db.transaction((items) => { for (const item of items) stmt.run(now, item.rowid) })
    try { tx(result) } catch {}
  }

  // 搜索未命中追踪（两个路径都空才算 miss）
  if (result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'hybrid')
    } catch {}
  }

  // recall_log 打点（hybrid 完整路径出口；fallback 路径已被 recallMemories 自己打点）
  const recallLogId = logRecall({
    source: opts._source || 'unknown',
    sessionId: opts._sessionId || null,
    query: queryText,
    hitIds: result.map(r => r.rowid),
    durationMs: Date.now() - now,
    filterLevel: opts._filterLevel || null,
    minImportance: opts._minImportance || null,
    queryPath: 'hybrid',
  })
  if (opts._out && typeof opts._out === 'object') opts._out.recallLogId = recallLogId

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
    if (anchors.length === 0) {
      // 搜索未命中追踪
      try {
        db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
          .run(queryText.slice(0, 500), 'search_conversations')
      } catch {}
      return []
    }

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
export async function buildMemoryContext(opts = {}) {
  const { query: queryText, chatId, memoryLimit = 8, _source, _sessionId } = opts
  const sections = []

  // 1. 相关记忆（有查询词时用 hybrid 混合检索；无查询词时注入高重要性基础记忆）
  // Hybrid 路径：FTS5 + 向量 + RRF 融合；降级到 FTS5-only 当 vec/embedding 未就绪
  // _source/_sessionId 透传给 recall_log 打点（默认 'context-builder'）
  const ctxSource = _source || 'context-builder'
  const memories = queryText
    ? await recallMemoriesHybrid({ query: queryText, limit: memoryLimit, minImportance: 3, _source: ctxSource, _sessionId })
    : recallMemories({ limit: memoryLimit, minImportance: 7, _source: ctxSource, _sessionId })
  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const prefix = { permanent: '📌', long_term: '🔷', short_term: '🔹', working: '·' }[m.memory_type] || '·'
      // 层级标记（💡 = 模式/启发式，最有价值；○ = 具体操作，参考价值低）
      const levelMark = { meta_knowledge: '💡', semi_abstract: '', concrete_trace: '○' }[m.memory_level] || ''
      // migration 003：surfaced_random 浮现条单独标识（"忽然想起"，跟 query 命中区分）
      const surfaceMark = m.recall_source === 'surfaced_random' ? '🌟[忽然想起] ' : ''
      const tagStr = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      const age = Math.floor((Date.now() - m.created_at) / 86400_000)
      const ageStr = age === 0 ? '今天' : age === 1 ? '昨天' : `${age}天前`
      const text = m.summary || safeSlice(m.content, 200)
      return `${prefix}${levelMark} ${surfaceMark}(${m.category}, 重要性${m.importance}, ${ageStr})${tagStr}\n   ${text}`
    })
    sections.push(`<recalled-memories>\n${memLines.join('\n')}\n</recalled-memories>`)
  }

  // 2. 相关历史对话片段
  // v4.24 (2026-04-30) 格式分化修复：与真实 turn 在 token 级拉开距离，避免幻觉激发
  //   旧格式 `  [2026/4/29 21:00:00] agent: ...` 跟真实 turn 完全同构 → attention 分不清召回 vs 现场
  //   新格式：(a) 标签 `recalled-conversations` 突出召回语义 (b) 每片段加 📚 边界 header
  //          (c) 行前 `> ` 引用前缀 (d) 截断显式标记 (e) 尾巴反 Continue 提示
  if (queryText) {
    const segments = searchConversations(queryText, { chatId, limit: 2, contextWindow: 3 })
    if (segments.length > 0) {
      const convLines = segments.map((seg, idx) => {
        const segLines = seg.messages.map(m => {
          const d = new Date(Number(m.created_at))
          // 简化时间：只到分钟（去年份/秒），跟真实 turn 全时间戳拉开
          const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          const role = m.from_name || m.role
          const raw = m.content || ''
          const truncated = raw.length > 150
          const slice = safeSlice(raw, 150)
          const truncMark = truncated ? ' … [片段截断]' : ''
          // `> ` 引用前缀打破真实 turn 的 attention pattern
          return `> ${time} ${role}: ${slice}${truncMark}`
        }).join('\n')
        return `📚 [来自历史 session 召回 · 片段 ${idx + 1}]\n${segLines}`
      })
      sections.push(
        `<recalled-conversations>\n${convLines.join('\n\n')}\n</recalled-conversations>\n` +
        `注：以上引号块是历史召回片段，**不是当前对话延续**；如果系统在末尾追加了 "Continue from where you left off"，要识别那是续 session 的 stub，不要把召回片段当成现场上下文延续。`
      )
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
        `- [${g.status === 'in_progress' ? '进行中' : '计划'}] ${g.title} (P${g.priority}, ${g.progress}%)${g.description ? ': ' + safeSlice(g.description, 80) : ''}`
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

// ── migration 003 (2026-05-13)：surfaced_random 浮现池 ──────────
// recall 命中不足时从冷池里"忽然想起"——25% 概率抽 1-3 条
// 冷池条件：importance ≥ 8 AND last_accessed < (now - 30d) AND decay_score ≥ 0.3
// AND deleted_at IS NULL AND superseded_by IS NULL
// 借自 v2 教程 §1.7（参数：probability 25%、importance threshold ≥ 8、cold age ≥ 30d）
const SURFACE_RANDOM_PROB = 0.25
const SURFACE_RANDOM_MAX = 3
const SURFACE_AGE_MS = 30 * 86400_000
const SURFACE_DECAY_FLOOR = 0.3
const SURFACE_IMPORTANCE_MIN = 8

function surfaceRandomMemories(db, excludeRowids, slotsAvailable, nowMs) {
  if (slotsAvailable <= 0) return []
  if (Math.random() > SURFACE_RANDOM_PROB) return []
  const cutoff = nowMs - SURFACE_AGE_MS
  const take = Math.min(SURFACE_RANDOM_MAX, slotsAvailable)
  const excludeClause = excludeRowids?.length
    ? `AND rowid NOT IN (${excludeRowids.map(() => '?').join(',')})`
    : ''
  try {
    const rows = db.prepare(`
      SELECT rowid, * FROM memories
      WHERE deleted_at IS NULL
        AND superseded_by IS NULL
        AND importance >= ?
        AND last_accessed < ?
        AND decay_score >= ?
        ${excludeClause}
      ORDER BY RANDOM()
      LIMIT ?
    `).all(SURFACE_IMPORTANCE_MIN, cutoff, SURFACE_DECAY_FLOOR, ...(excludeRowids || []), take)
    return rows.map(r => ({
      ...r,
      score: 0,
      tags: safeJsonParse(r.tags, []),
      metadata: safeJsonParse(r.metadata, {}),
      recall_source: 'surfaced_random',  // 调用方能区分这是浮现条 vs query 命中条
    }))
  } catch (e) {
    log(`surfaceRandomMemories failed: ${e.message}`)
    return []
  }
}

// ── 记忆管理 ──────────────────────────────────────────────────

/** 清理过期记忆 */
export function expireMemories() {
  const db = getDb()
  try {
    // 路径 1：基于 expires_at TTL 过期
    const r1 = db.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < unixepoch() * 1000
    `).run()
    // 路径 2：基于 superseded_by 软删（harness-evolve #001）
    const r2 = db.prepare(`
      UPDATE memories
      SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND superseded_by IS NOT NULL
    `).run()
    if (r1.changes > 0 || r2.changes > 0) {
      log(`Expired: ${r1.changes} ttl + ${r2.changes} superseded`)
    }
    return r1.changes + r2.changes
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

// migration 003 (2026-05-13)：幂律衰减周期
// w(t) = (1 + t/τ)^(-b_eff)，τ = 24h，b_eff = 0.7 / (1 + importance/10)
// importance=1 → b_eff≈0.64 衰减快；importance=10 → b_eff≈0.35 衰减慢
// final = min(1.0, w × (1 + min(10, access_count) × 0.3))
//   access_count cap 在 10（防 reuse 极多的记忆 decay > 1）
//
// 借自 v2 教程 §1.5 + Wave14 §2 幂律衰减；importance 调节是本项目自加（v59 文档化）
// 触发：daemon.mjs setInterval 每 30min 跟 expireMemories / promoteMemories 一起跑
//
// 性能：~1800 条规模下 JS 批处理 + 单 transaction <100ms（实测）
//
// @param {Object} [opts]
// @param {number} [opts.tauHours=24]
// @param {number} [opts.bBase=0.7]
// @param {boolean} [opts.dryRun=false] - 不写 DB，返回 {distribution, sample}
// @returns {Object} { processed, distribution: {high, mid, low, cold} } | dryRun 加 sample
export function runDecayCycle(opts = {}) {
  const { tauHours = 24, bBase = 0.7, dryRun = false } = opts
  const db = getDb()
  const now = Date.now()
  const tauMs = tauHours * 3600_000
  let processed = 0
  const distribution = { high: 0, mid: 0, low: 0, cold: 0 }  // ≥0.7 / 0.3-0.7 / 0.1-0.3 / <0.1
  const sample = []

  try {
    const rows = db.prepare(`
      SELECT rowid, importance, access_count, created_at
      FROM memories
      WHERE deleted_at IS NULL AND superseded_by IS NULL
    `).all()

    const items = rows.map(r => {
      const t = Math.max(0, now - r.created_at)
      const importance = r.importance || 5
      const bEff = bBase / (1 + importance / 10)
      const w = Math.pow(1 + t / tauMs, -bEff)
      const reuseBoost = 1 + Math.min(10, r.access_count || 0) * 0.3
      const score = Math.min(1.0, w * reuseBoost)
      if (score >= 0.7) distribution.high++
      else if (score >= 0.3) distribution.mid++
      else if (score >= 0.1) distribution.low++
      else distribution.cold++
      return { rowid: r.rowid, score }
    })

    if (dryRun) {
      // 抽 10 条样本看分布
      const stride = Math.max(1, Math.floor(items.length / 10))
      for (let i = 0; i < items.length; i += stride) sample.push(items[i])
      return { processed: items.length, distribution, sample, dryRun: true }
    }

    const updateStmt = db.prepare(`UPDATE memories SET decay_score = ? WHERE rowid = ?`)
    const tx = db.transaction((batch) => {
      for (const it of batch) updateStmt.run(it.score, it.rowid)
    })
    tx(items)
    processed = items.length
    log(`runDecayCycle: ${processed} memories updated (high=${distribution.high} mid=${distribution.mid} low=${distribution.low} cold=${distribution.cold})`)
    return { processed, distribution }
  } catch (e) {
    log(`runDecayCycle failed: ${e.message}`)
    return { processed, distribution, error: e.message }
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

    // 压缩压力指标：(working + short_term) / max(1, long_term + permanent)
    // 值 > 1.0 表示临时记忆堆积，需要压缩
    const raw = (mem?.working || 0) + (mem?.short_term || 0)
    const terminal = Math.max(1, (mem?.long_term || 0) + (mem?.permanent || 0))
    const compressionPressure = +(raw / terminal).toFixed(2)

    // 死知识检测：长期/永久记忆中超过 30 天未被访问的
    const thirtyDaysAgo = Date.now() - 30 * 86400_000
    const deadKnowledge = db.prepare(`
      SELECT COUNT(*) AS count FROM memories
      WHERE deleted_at IS NULL
        AND memory_type IN ('long_term', 'permanent')
        AND last_accessed < ?
    `).get(thirtyDaysAgo)

    // 搜索未命中统计（近 7 天）
    const sevenDaysAgo = Date.now() - 7 * 86400_000
    let recentMisses = 0
    try {
      recentMisses = db.prepare(
        'SELECT COUNT(*) AS count FROM search_misses WHERE created_at > ?'
      ).get(sevenDaysAgo)?.count || 0
    } catch {}

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
      compressionPressure,
      deadKnowledge: deadKnowledge?.count || 0,
      recentSearchMisses: recentMisses,
      embeddingConfigured: !!_embeddingConfig,
    }
  } catch (e) {
    return { error: e.message }
  }
}

// ── Session 转录索引（Myco-inspired） ──────────────────────────

/**
 * 索引 Claude Code session .jsonl 文件到 conversations 表
 * 扫描 ~/.claude/projects/ 下所有 .jsonl，提取 user + assistant 文本
 */
export function indexSessionTranscripts() {
  const db = getDb()
  const projectsDir = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/projects')

  if (!existsSync(projectsDir)) {
    log('Session indexing: projects dir not found')
    return { indexed: 0, skipped: 0 }
  }

  let indexed = 0, skipped = 0

  // 递归查找所有 .jsonl 文件
  const { readdirSync, statSync } = require('node:fs')
  const jsonlFiles = []

  function scanDir(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry)
        try {
          const st = statSync(full)
          if (st.isDirectory()) scanDir(full)
          else if (entry.endsWith('.jsonl')) jsonlFiles.push(full)
        } catch {}
      }
    } catch {}
  }
  scanDir(projectsDir)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO conversations
      (id, platform, chat_id, from_id, from_name, role, content, created_at, metadata)
    VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?, '{}')
  `)

  const insertMany = db.transaction((msgs) => {
    for (const m of msgs) {
      insertStmt.run(m.id, m.chatId, m.fromId, m.fromName, m.role, m.content, m.createdAt)
    }
  })

  for (const file of jsonlFiles) {
    const sessionId = file.match(/([a-f0-9-]{36})\.jsonl$/)?.[1]
    if (!sessionId) continue

    // 跳过已索引的 session（检查是否有此 chat_id 的记录）
    const existing = db.prepare('SELECT 1 FROM conversations WHERE chat_id = ? AND platform = ? LIMIT 1')
      .get(sessionId, 'claude-code')
    if (existing) { skipped++; continue }

    try {
      const content = readFileSync(file, 'utf-8')
      const batch = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (!obj.timestamp || !obj.message?.content) continue

          const ts = new Date(obj.timestamp).getTime()
          if (isNaN(ts)) continue

          if (obj.type === 'user' && typeof obj.message.content === 'string') {
            const text = obj.message.content.trim()
            if (text.length > 0 && text.length < 5000) {
              batch.push({
                id: obj.uuid || `cc-${sessionId}-${ts}`,
                chatId: sessionId,
                fromId: 'user',
                fromName: 'user',
                role: 'user',
                content: text,
                createdAt: ts,
              })
            }
          } else if (obj.type === 'assistant') {
            // assistant content 是 JSON 数组，提取 text 块
            const blocks = Array.isArray(obj.message.content) ? obj.message.content : []
            const textParts = blocks
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text.trim())
              .filter(t => t.length > 0)
            const fullText = safeSlice(textParts.join('\n'), 5000)
            if (fullText.length > 0) {
              batch.push({
                id: obj.uuid || `cc-${sessionId}-${ts}`,
                chatId: sessionId,
                fromId: 'assistant',
                fromName: 'claude',
                role: 'assistant',
                content: fullText,
                createdAt: ts,
              })
            }
          }
        } catch {}
      }

      if (batch.length > 0) {
        insertMany(batch)
        indexed++
        log(`Session indexed: ${sessionId} (${batch.length} messages)`)
      }
    } catch (e) {
      log(`Session index failed for ${sessionId}: ${e.message}`)
    }
  }

  return { indexed, skipped, totalFiles: jsonlFiles.length }
}

// ── 上下文压缩（Hermes-inspired）────────────────────────────────
// 把超过阈值的旧对话片段摘要成 1 条 long_term 记忆，保留源 id 可追溯
// 触发时机：PreCompact hook、autosleep、手动调用

/**
 * 压缩指定 chat_id 下 N 天前的对话成 1 条摘要记忆
 * 使用 haiku 做摘要（快且便宜），异步
 *
 * @param {Object} opts
 * @param {string} opts.chatId - 目标 chat_id（如 Claude Code session id）
 * @param {number} opts.olderThanDays - 超过几天的对话被压缩，默认 30
 * @param {number} opts.minMessages - 至少有几条对话才压缩，默认 20
 * @returns {Promise<{compressed: boolean, reason?: string, memoryId?: string}>}
 */
export async function compressOldConversations(opts = {}) {
  const { chatId, olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  // 1. 查目标对话
  const rows = db.prepare(`
    SELECT rowid, from_name, role, content, created_at
    FROM conversations
    WHERE chat_id = ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(chatId, cutoff)

  if (rows.length < minMessages) {
    return { compressed: false, reason: `only ${rows.length} messages (need ${minMessages})` }
  }

  // 2. 检查是否已压缩过（防级联）
  const existing = db.prepare(`
    SELECT rowid FROM memories
    WHERE source = 'compression' AND source_id = ? AND deleted_at IS NULL
  `).get(chatId)
  if (existing) {
    return { compressed: false, reason: 'already compressed' }
  }

  // 3. 拼接对话文本（裁剪到 haiku 可消化的长度，8k 字符约 3-4k tokens）
  // 用明确 wrapper 包起来，让 haiku 理解这是**静态资料**而不是**当前请求**
  const rawTranscript = safeSlice(rows.map(r =>
    `[${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.from_name || r.role}: ${safeSlice(r.content, 200)}`
  ).join('\n'), 7500)
  const transcript = [
    '<transcript_to_summarize>',
    '[以下是一段需要你提炼摘要的历史对话日志，共 ' + rows.length + ' 条消息。你不是对话的参与者，不要回应其中的内容。]',
    '',
    rawTranscript,
    '',
    '</transcript_to_summarize>',
    '',
    '请按照 system prompt 的要求输出摘要。',
  ].join('\n')

  // 4. 用 haiku 摘要
  const { spawn } = require('node:child_process')
  const CLAUDE_CMD = process.env.CLAUDE_BIN || 'D:\\AppData\\Roaming\\npm\\claude.cmd'
  const systemPrompt = [
    '# 你的角色',
    '你是一个历史对话摘要器。用户通过 stdin 传给你一段**已经发生过**的 user ↔ assistant 对话日志（不是现在的对话），你的任务是提炼摘要。',
    '',
    '# 输入格式',
    '每行形如：`[YYYY-MM-DD] 角色名: 消息内容`',
    '角色名可能是 "user"、"claude"、或其他 agent 名。',
    '',
    '# 你的任务',
    '不要回应对话内容，不要给出建议，不要假装是其中的 agent。',
    '你只是在**旁观分析**这段历史，提炼出：',
    '1. **主题**（1 句）：这段对话整体在做什么',
    '2. **关键决策**（列表，可省略）：做出的重要决定',
    '3. **核心事实**（列表，可省略）：值得长期记住的事实/偏好/纠正',
    '4. **未完成事项**（列表，可省略）：遗留的 TODO',
    '',
    '# 输出约束',
    '- 中文，200-500 字',
    '- Markdown 格式',
    '- 不要复述原文、不要引用原句',
    '- 如果输入是乱码或无意义片段，直接输出："[无可提炼内容]"',
  ].join('\n')

  // 方案：写临时文件 + cmd shell 重定向 < tmpfile
  // stdin 在 Windows cmd.exe 上对大输入会挂起，用重定向绕开
  const { writeFileSync, unlinkSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const tmpFile = resolve(tmpdir(), `engram-compress-${Date.now()}-${Math.random().toString(36).slice(2,8)}.txt`)
  writeFileSync(tmpFile, transcript, 'utf-8')
  log(`[Compress] spawning claude haiku, transcript len=${transcript.length}, tmpfile=${tmpFile}`)

  const summary = await new Promise((resolve, reject) => {
    // 用 PowerShell 做 stdin 重定向（Get-Content -Raw | & claude）
    // PowerShell 的引号规则比 cmd.exe 规范；systemPrompt 通过环境变量传
    const env = { ...process.env, ENGRAM_SYSPROMPT: systemPrompt }
    const escTmp = tmpFile.replace(/'/g, "''")
    const escCmd = CLAUDE_CMD.replace(/'/g, "''")
    // cwd 设到无 CLAUDE.md 的临时目录，避开 CLAUDE.md 自发现污染 haiku 的人格
    const { tmpdir: _td } = require('node:os')
    const psCmd = `Set-Location '${_td().replace(/'/g, "''")}'; Get-Content -Raw -LiteralPath '${escTmp}' | & '${escCmd}' -p --model haiku --system-prompt $env:ENGRAM_SYSPROMPT --no-session-persistence --output-format text --max-turns 1`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { env, windowsHide: true })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`haiku timeout 120s (stderr: ${stderr.slice(0,200)})`))
    }, 120000)

    child.stdout.on('data', d => { stdout += d.toString('utf-8') })
    child.stderr.on('data', d => { stderr += d.toString('utf-8') })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`spawn error: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      try { unlinkSync(tmpFile) } catch {}  // 清理临时文件
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`haiku exit ${code} (stderr: ${stderr.slice(0,300)})`))
    })
  })

  // 5. 存入 memories 表，记录 compressed_from（源 rowid 列表）
  const sourceRowIds = rows.map(r => r.rowid)
  const memoryId = storeMemory({
    content: summary,
    summary: `[压缩] ${chatId} (${rows.length} 条对话, ${olderThanDays}d 前)`,
    memoryType: 'long_term',
    memoryLevel: 'semi_abstract',  // haiku 摘要的历史对话，保守归为 semi_abstract
    category: 'general',
    importance: 5,
    source: 'compression',
    sourceId: chatId,
    sourcePlatform: 'engram',
    tags: ['compressed', 'transcript'],
    compressedFrom: sourceRowIds,
  })

  if (memoryId) {
    log(`[Compress] ${chatId}: ${rows.length} msgs → memory id ${memoryId}`)
    return { compressed: true, memoryId, messageCount: rows.length }
  }
  return { compressed: false, reason: 'storeMemory returned null' }
}

/**
 * 扫描所有活跃 chat_id，批量压缩符合条件的
 * 返回每个 chat_id 的压缩结果
 */
export async function compressAllOldConversations(opts = {}) {
  const { olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  // 找出有 >= minMessages 条旧对话、且还没压缩过的 chat_id
  const candidates = db.prepare(`
    SELECT chat_id, COUNT(*) as cnt
    FROM conversations
    WHERE created_at < ?
    GROUP BY chat_id
    HAVING cnt >= ?
    ORDER BY cnt DESC
    LIMIT 10
  `).all(cutoff, minMessages)

  const results = []
  for (const { chat_id } of candidates) {
    try {
      const r = await compressOldConversations({ chatId: chat_id, olderThanDays, minMessages })
      results.push({ chatId: chat_id, ...r })
    } catch (e) {
      results.push({ chatId: chat_id, compressed: false, reason: e.message })
    }
  }
  return results
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
  ;(async () => {
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
      const ctx = await buildMemoryContext({ query, memoryLimit: 10 })
      if (ctx) process.stdout.write(ctx + '\n')

    } else if (getFlag('--recall') !== null) {
      // ── 召回记忆列表 ──
      // 默认 text 输出（人类可读，向后兼容）
      // --format json：结构化输出（hook 用，含 rowid/level/summary/tags 等全字段）
      // --min-importance N：过滤 importance >= N 的条目
      // --level lvl1,lvl2,...：过滤 memory_level 在指定集合内（逗号分隔）
      // --source <name>：recall_log 打点的调用方（mcp/cli/prompt-recall-hook/tool-recall-hook 等），默认 'cli'
      // --session-id <id>：CC session id，hook 透传时用于 per-prompt 聚合
      const query = getFlag('--recall') || ''
      const limit = parseInt(getFlag('--limit') || '10', 10)
      const minImportance = parseInt(getFlag('--min-importance') || '0', 10)
      const levelArg = getFlag('--level') || ''
      const levelFilter = levelArg ? levelArg.split(',').map(s => s.trim()).filter(Boolean) : []
      const format = getFlag('--format') || 'text'
      const source = getFlag('--source') || 'cli'
      const sessionId = getFlag('--session-id') || null

      // 过滤需要更大候选池（先 limit*3 拿候选，再过滤再切 top）
      const candidatePoolSize = (minImportance > 0 || levelFilter.length > 0) ? Math.max(limit * 3, 30) : limit
      // _out: 通过引用拿回 logRecall 写入的 recall_log id（给 hook 后置 update final_hit_count 用）
      const recallOut = {}
      // 走 hybrid：FTS5 + embedding 语义 + RRF 融合（无 _vecLoaded/_embeddingConfig 时自动 fallback 到 sync）
      let memories = await recallMemoriesHybrid({
        query,
        limit: candidatePoolSize,
        _source: source,
        _sessionId: sessionId,
        _filterLevel: levelFilter.length ? levelFilter.join(',') : null,
        _minImportance: minImportance > 0 ? minImportance : null,
        _out: recallOut,
      })

      if (minImportance > 0) memories = memories.filter(m => (m.importance || 0) >= minImportance)
      if (levelFilter.length > 0) memories = memories.filter(m => levelFilter.includes(m.memory_level))
      memories = memories.slice(0, limit)

      if (format === 'json') {
        const hits = memories.map(m => ({
          id: m.rowid,
          content: m.content,
          summary: m.summary || null,
          importance: m.importance,
          memory_level: m.memory_level,
          memory_type: m.memory_type,
          tags: Array.isArray(m.tags) ? m.tags : [],
          score: typeof m.score === 'number' ? m.score : null,
          created_at: m.created_at,
        }))
        // recall_log_id 让 hook 后置 update final_hit_count
        process.stdout.write(JSON.stringify({ hits, count: hits.length, recall_log_id: recallOut.recallLogId || null }) + '\n')
      } else {
        if (memories.length === 0) {
          process.stdout.write('（无相关记忆）\n')
        } else {
          for (const m of memories) {
            const date = new Date(m.created_at).toLocaleDateString('zh-CN')
            process.stdout.write(`[${m.importance}★ ${m.memory_type} ${date}] ${m.content.slice(0, 120)}\n`)
          }
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
      const memoryLevel = getFlag('--level') || 'semi_abstract'
      const id = storeMemory({
        content: content.trim(),
        memoryType,
        memoryLevel,
        category,
        importance,
        source: 'manual',
        tags: ['cli', 'manual'],
      })
      process.stdout.write(`stored: ${id}\n`)

    } else if (getFlag('--store-compact-summary') !== null) {
      // ── 从环境变量接收 compact 摘要并存入 memories 表 ──
      // 由 SessionStart(source=compact) hook 触发
      const summary = process.env.ENGRAM_COMPACT_SUMMARY
      const sessionId = process.env.ENGRAM_COMPACT_SESSION || 'unknown'
      if (!summary || summary.length < 50) {
        process.stderr.write('no ENGRAM_COMPACT_SUMMARY or too short\n')
        process.exit(1)
      }
      // 幂等检查：同一 sessionId 的 compact 摘要已存过就跳过
      const db = getDb()
      const existing = db.prepare(
        `SELECT rowid FROM memories WHERE source = 'compression' AND source_id = ? AND deleted_at IS NULL LIMIT 1`
      ).get(sessionId)
      if (existing) {
        process.stdout.write(`already stored (rowid ${existing.rowid})\n`)
        return
      }
      const id = storeMemory({
        content: summary,
        summary: `[Compact 摘要] session ${sessionId.slice(0, 8)} (${summary.length} 字符)`,
        memoryType: 'long_term',
        memoryLevel: 'semi_abstract',  // compact 摘要是会话级精炼，但含具体细节，保守归为 semi_abstract
        category: 'general',
        importance: 5,
        source: 'compression',
        sourceId: sessionId,
        sourcePlatform: 'claude-code',
        tags: ['compact', 'auto-summary', 'session-transcript'],
      })
      process.stdout.write(`stored compact summary: memory id ${id}\n`)

    } else if (getFlag('--update-recall-log') !== null) {
      // ── 后置更新 recall_log.final_hit_count（hook 后置过滤完写真注入数）──
      // 用法：node engram --update-recall-log <id> --final-count <n>
      // 设计：hook 第一次 spawn 拿 recall_log_id + candidates → 后置过滤算 final → 第二次 spawn 异步回写
      const idStr = getFlag('--update-recall-log') || ''
      const id = parseInt(idStr, 10)
      const finalCount = parseInt(getFlag('--final-count') || '-1', 10)
      if (!Number.isFinite(id) || id <= 0 || finalCount < 0) {
        process.stderr.write(`Error: --update-recall-log <id> --final-count <n> (got id=${idStr} count=${finalCount})\n`)
        process.exit(1)
      }
      const db = getDb()
      const r = db.prepare(`UPDATE recall_log SET final_hit_count = ? WHERE id = ?`).run(finalCount, id)
      process.stdout.write(`updated ${r.changes} row(s)\n`)

    } else if (hasFlag('--recall-stats')) {
      // ── recall_log 统计：近 N 天利用率分析（per-prompt / 调用方分布 / 命中率）──
      // 用法：node index.mjs --recall-stats [--days 7] [--format json]
      // 设计动机：access_count 累计指标无法回答时间窗口/调用方/per-prompt 问题
      const days = parseInt(getFlag('--days') || '7', 10)
      const format = getFlag('--format') || 'text'
      const since = Date.now() - days * 86400_000
      const db = getDb()

      const total = db.prepare(`SELECT COUNT(*) c FROM recall_log WHERE ts > ?`).get(since).c
      const bySource = db.prepare(`
        SELECT source,
               COUNT(*) calls,
               SUM(hit_count) total_hits,
               AVG(hit_count) avg_hits,
               SUM(CASE WHEN hit_count = 0 THEN 1 ELSE 0 END) zero_hits,
               AVG(duration_ms) avg_dur_ms,
               MAX(duration_ms) max_dur_ms
        FROM recall_log WHERE ts > ?
        GROUP BY source
        ORDER BY calls DESC
      `).all(since)
      const byPath = db.prepare(`
        SELECT query_path, COUNT(*) calls, AVG(duration_ms) avg_dur_ms
        FROM recall_log WHERE ts > ?
        GROUP BY query_path
      `).all(since)
      // per-session（≈ per-prompt 近似：同 session 30s 窗口聚合为 1 prompt）
      const sessions = db.prepare(`
        SELECT session_id, COUNT(*) recalls
        FROM recall_log
        WHERE ts > ? AND session_id IS NOT NULL
        GROUP BY session_id
      `).all(since)
      const sessionCount = sessions.length
      const totalSessionRecalls = sessions.reduce((s, r) => s + r.recalls, 0)
      const avgRecallsPerSession = sessionCount > 0 ? totalSessionRecalls / sessionCount : 0
      const noSession = total - totalSessionRecalls  // 没有 session_id 的（mcp / cli 等）

      // 命中分布：0 / 1-2 / 3-9 / 10+
      const hitBuckets = db.prepare(`
        SELECT
          SUM(CASE WHEN hit_count = 0 THEN 1 ELSE 0 END) zero,
          SUM(CASE WHEN hit_count BETWEEN 1 AND 2 THEN 1 ELSE 0 END) one_to_two,
          SUM(CASE WHEN hit_count BETWEEN 3 AND 9 THEN 1 ELSE 0 END) three_to_nine,
          SUM(CASE WHEN hit_count >= 10 THEN 1 ELSE 0 END) ten_plus
        FROM recall_log WHERE ts > ?
      `).get(since)

      // 重复 query top 10（同 query 反复查 → 该写进 SessionStart 注入）
      const dupQueries = db.prepare(`
        SELECT query, COUNT(*) freq, SUM(hit_count) total_hits
        FROM recall_log WHERE ts > ? AND query IS NOT NULL AND length(query) > 0
        GROUP BY query
        HAVING freq >= 3
        ORDER BY freq DESC
        LIMIT 10
      `).all(since)

      if (format === 'json') {
        process.stdout.write(JSON.stringify({
          window_days: days, total_calls: total,
          by_source: bySource, by_path: byPath,
          session_count: sessionCount, avg_recalls_per_session: avgRecallsPerSession,
          recalls_without_session: noSession,
          hit_buckets: hitBuckets,
          duplicate_queries: dupQueries,
        }, null, 2) + '\n')
      } else {
        process.stdout.write(`\n## recall_log 统计 · 近 ${days} 天\n\n`)
        process.stdout.write(`总调用次数: ${total}\n`)
        process.stdout.write(`独立 session 数: ${sessionCount}（仅含 hook 路径有 session_id）\n`)
        process.stdout.write(`无 session_id 的调用（mcp/cli/context-builder）: ${noSession}\n`)
        process.stdout.write(`平均 recalls / session: ${avgRecallsPerSession.toFixed(2)}\n\n`)
        process.stdout.write('### 按调用方\n')
        for (const s of bySource) {
          process.stdout.write(`  ${s.source.padEnd(22)} | calls=${s.calls.toString().padStart(5)} | avg_hits=${s.avg_hits.toFixed(2)} | zero=${s.zero_hits} | avg_dur=${s.avg_dur_ms ? s.avg_dur_ms.toFixed(0) + 'ms' : 'n/a'}\n`)
        }
        process.stdout.write('\n### 按路径\n')
        for (const p of byPath) process.stdout.write(`  ${p.query_path.padEnd(8)} | calls=${p.calls} | avg_dur=${p.avg_dur_ms ? p.avg_dur_ms.toFixed(0) + 'ms' : 'n/a'}\n`)
        process.stdout.write('\n### 命中分布\n')
        process.stdout.write(`  zero=${hitBuckets.zero} | 1-2=${hitBuckets.one_to_two} | 3-9=${hitBuckets.three_to_nine} | 10+=${hitBuckets.ten_plus}\n`)
        if (dupQueries.length > 0) {
          process.stdout.write('\n### 重复 query top（freq >= 3，建议 store 或注入）\n')
          for (const q of dupQueries) process.stdout.write(`  freq=${q.freq.toString().padStart(3)} | total_hits=${q.total_hits} | "${q.query.slice(0, 80)}"\n`)
        }
        process.stdout.write('\n')
      }

    } else if (getFlag('--recall-strict') !== null) {
      // ── 严格关键词匹配：要求 content/summary/tags 真含 keyword 子串 ──
      // 给 tool-recall-pre hook 用：避免 FTS 复合打分把含"参数/用法"的无关 meta 拉上来
      // 2026-05-05 加：--source/--session-id flag 透传 + recall_log 打点（query_path='strict'）
      const keyword = getFlag('--recall-strict') || ''
      const limit = parseInt(getFlag('--limit') || '5', 10)
      const source = getFlag('--source') || 'cli-strict'
      const sessionId = getFlag('--session-id') || null
      const startTs = Date.now()
      if (!keyword || keyword.length < 2) {
        process.stdout.write('（无相关记忆）\n')
        // 空 query 也打点（标 hit_count=0），便于复盘 hook 哪些工具触发但 query 缺失
        logRecall({ source, sessionId, query: keyword, hitIds: [], durationMs: Date.now() - startTs, queryPath: 'strict' })
        return
      }
      const db = getDb()
      const like = '%' + keyword.replace(/[%_]/g, '\\$&') + '%'
      const rows = db.prepare(`
        SELECT rowid, content, summary, importance, memory_type, created_at
        FROM memories
        WHERE deleted_at IS NULL
          AND memory_level IN ('meta_knowledge', 'semi_abstract')
          AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(like, like, like, limit)
      if (rows.length === 0) {
        process.stdout.write('（无相关记忆）\n')
      } else {
        for (const m of rows) {
          const date = new Date(m.created_at).toLocaleDateString('zh-CN')
          process.stdout.write(`[${m.importance}★ ${m.memory_type} ${date}] ${m.content.slice(0, 200)}\n`)
        }
      }
      // 打点（statefully 区分 strict 路径，避免和 hybrid/sync 混在一起统计）
      logRecall({
        source, sessionId, query: keyword,
        hitIds: rows.map(r => r.rowid),
        durationMs: Date.now() - startTs,
        queryPath: 'strict',
      })

    } else if (hasFlag('--summarize-session')) {
      // ── 触发 session_summarize.mjs（Phase A 零 LLM 抽取） ──
      const sessionId = getFlag('--summarize-session')
      if (!sessionId) {
        process.stderr.write('Error: --summarize-session 需要 sessionId 参数\n')
        process.exit(1)
      }
      const { spawn } = await import('node:child_process')
      const scriptPath = resolve(__dirname, 'scripts/session-summarize.mjs')
      const child = spawn(process.execPath, [scriptPath, sessionId], { stdio: 'inherit' })
      child.on('close', code => process.exit(code || 0))
      return  // 让子进程接管

    } else if (hasFlag('--record-conversation')) {
      // ── 由 CC hook 调用：从 stdin 读 content，记录一条对话到 conversations 表 ──
      const platform = getFlag('--platform') || 'claude-code'
      const chatId = getFlag('--chat-id') || ''
      const fromId = getFlag('--from-id') || 'unknown'
      const fromName = getFlag('--from-name') || ''
      const role = getFlag('--role') || 'user'
      if (!chatId) {
        process.stderr.write('Error: --record-conversation 需要 --chat-id\n')
        process.exit(1)
      }
      // 读 stdin 内容（hook 通过 stdin 传 content，避免命令行长度+编码限制）
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      const content = Buffer.concat(chunks).toString('utf-8').trim()
      if (!content || content.length < 2) {
        process.stdout.write('skipped: empty content\n')
        return
      }
      const id = recordConversation({
        platform,
        chatId,
        fromId,
        fromName,
        role,
        content,
      })
      process.stdout.write(`recorded conversation: rowid ${id}\n`)

    } else if (getFlag('--compress') !== null) {
      // ── 压缩指定 chat_id 的旧对话 ──
      const chatId = getFlag('--compress')
      const days = parseInt(getFlag('--days') || '30', 10)
      const result = await compressOldConversations({ chatId, olderThanDays: days })
      process.stdout.write(JSON.stringify(result) + '\n')

    } else if (getFlag('--compress-all') !== null) {
      // ── 批量压缩所有老旧 chat_id ──
      const days = parseInt(getFlag('--days') || '30', 10)
      const results = await compressAllOldConversations({ olderThanDays: days })
      process.stdout.write(JSON.stringify(results, null, 2) + '\n')

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
        '    [--level concrete_trace|semi_abstract|meta_knowledge]  抽象层级（默认 semi_abstract）',
        '  node memory/index.mjs --compress <chat_id>    压缩指定会话的旧对话（haiku）',
        '    [--days 30]',
        '  node memory/index.mjs --compress-all          批量压缩所有老旧会话（haiku）',
        '  node memory/index.mjs --store-compact-summary  从 ENGRAM_COMPACT_SUMMARY 环境变量存入 compact 摘要',
        '    （SessionStart source=compact hook 调用）',
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
  })()
}
