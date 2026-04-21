// ============================================================
// tokenmem v2.0 (SQLite + FTS5 + sqlite-vec)
// Token-efficient persistent memory for AI agents
// Inspired by: AIRI (moeru-ai/airi) memory architecture
//
// Core capabilities:
//   - Structured memory storage (layered + categorized + importance scoring)
//   - FTS5 full-text search (built-in, zero-dependency)
//   - Hybrid retrieval: FTS5 + sqlite-vec KNN + RRF fusion
//   - Composite scoring (AIRI-style: importance + text relevance + time decay)
//   - Memory Transfer Learning (meta_knowledge > semi_abstract > concrete_trace)
//   - Context window expansion (recall surrounding messages)
//   - Auto-expiry & memory promotion (working -> long_term)
//   - Compression pipeline (LLM summarization)
//   - Compact summary ingestion (SessionStart hook)
//
// Dependencies: better-sqlite3 (sync API, high performance)
// Optional: sqlite-vec (KNN vector search), libsimple (Chinese tokenization)
// Data file: tokenmem.db (same directory)
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.TOKENMEM_DB_PATH || resolve(__dirname, 'tokenmem.db')
const SCHEMA_PATH = resolve(__dirname, 'schema.sql')
// wangfenjin/simple Chinese tokenizer extension (optional, platform-specific binary)
const SIMPLE_EXT_DIR = resolve(__dirname, 'lib/libsimple-windows-x64')
const SIMPLE_EXT_PATH = resolve(SIMPLE_EXT_DIR, 'simple')  // .dll suffix auto-resolved by loadExtension
const SIMPLE_DICT_PATH = resolve(SIMPLE_EXT_DIR, 'dict')

// asg017/sqlite-vec vector search extension (optional, platform-specific binary)
const VEC_EXT_DIR = resolve(__dirname, 'lib/sqlite-vec-windows-x64')
const VEC_EXT_PATH = resolve(VEC_EXT_DIR, 'vec0')

const log = (msg) => process.stderr.write(`[${new Date().toISOString()}] [Memory] ${msg}\n`)

// -- DB instance ---------------------------------------------------------
let _db = null
let _embeddingConfig = null
let _simpleLoaded = false  // whether libsimple extension loaded successfully
let _vecLoaded = false     // whether sqlite-vec extension loaded successfully

/**
 * Get or create DB instance (loads native extensions if available)
 */
function getDb() {
  if (_db) return _db
  const Database = require('better-sqlite3')
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('busy_timeout = 5000')  // wait 5s on concurrent writes instead of failing immediately

  // Load Chinese tokenizer extension (optional)
  try {
    if (existsSync(SIMPLE_EXT_PATH + '.dll') || existsSync(SIMPLE_EXT_PATH)) {
      _db.loadExtension(SIMPLE_EXT_PATH)
      _db.prepare('SELECT jieba_dict(?)').run(SIMPLE_DICT_PATH)
      _simpleLoaded = true
      log('Chinese tokenizer libsimple + jieba loaded')
    }
  } catch (e) {
    log(`Chinese tokenizer load failed (falling back to character matching): ${e.message}`)
  }

  // Load sqlite-vec vector search extension (optional)
  try {
    if (existsSync(VEC_EXT_PATH + '.dll') || existsSync(VEC_EXT_PATH)) {
      _db.loadExtension(VEC_EXT_PATH)
      const ver = _db.prepare('SELECT vec_version() AS v').get()?.v || 'unknown'
      _vecLoaded = true
      log(`sqlite-vec vector search loaded (${ver})`)
    }
  } catch (e) {
    log(`sqlite-vec load failed (falling back to FTS5 only): ${e.message}`)
  }

  return _db
}

// -- Initialization -------------------------------------------------------

/**
 * Initialize memory system: create tables, FTS indexes
 */
export function initMemory() {
  const db = getDb()
  const schema = readFileSync(SCHEMA_PATH, 'utf-8')

  // PRAGMAs must execute outside transactions
  const pragmaLines = schema.match(/^PRAGMA\s+[^;]+;/gm) || []
  for (const p of pragmaLines) {
    try { db.exec(p) } catch {}
  }

  // Remaining DDL executed as batch (better-sqlite3 supports multi-statement)
  const ddl = schema.replace(/^PRAGMA\s+[^;]+;\s*$/gm, '')
  try {
    db.exec(ddl)
  } catch (e) {
    // First run creates normally; subsequent runs may report "already exists"
    if (!e.message.includes('already exists')) {
      log(`Schema exec: ${e.message.slice(0, 200)}`)
    }
  }

  log(`Initialized — DB at ${DB_PATH}`)

  // -- FTS migration: if simple extension loaded but FTS table uses old tokenizer, rebuild --
  if (_simpleLoaded) {
    try {
      const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories_fts'`).get()
      const currentSql = ftsRow?.sql || ''
      const currentTokenizer = currentSql.match(/tokenize\s*=\s*'([^']+)'/)?.[1] || 'none'
      if (!currentTokenizer.includes('simple')) {
        log(`FTS migrating: ${currentTokenizer} -> simple (rebuilding index...)`)
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
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
        db.exec(`INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild')`)
        const memCount = db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c
        log(`FTS migration complete, rebuilt ${memCount} memory indexes (tokenize=simple)`)
      } else {
        log(`FTS already using simple tokenizer, no migration needed`)
      }
    } catch (e) {
      log(`FTS migration failed (not critical, falling back to character matching): ${e.message}`)
    }
  }

  // Detect embedding configuration
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

  // -- Incremental schema migrations ----------------------------------------
  // New columns: compressed_from, is_compressed (compression pipeline)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN compressed_from TEXT DEFAULT '[]'`)
    log('Migration: added compressed_from column')
  } catch {}  // "duplicate column name" = already exists, ignore
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN is_compressed INTEGER NOT NULL DEFAULT 0`)
    log('Migration: added is_compressed column')
  } catch {}
  // Abstraction level (Memory Transfer Learning)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN memory_level TEXT NOT NULL DEFAULT 'semi_abstract'`)
    log('Migration: added memory_level column')
  } catch {}  // already exists
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_level ON memories(memory_level) WHERE deleted_at IS NULL`)
  } catch {}

  // Vector search virtual table (sqlite-vec)
  // Dimension determined by _embeddingConfig; skip if not available
  if (_vecLoaded && _embeddingConfig) {
    try {
      const dim = _embeddingConfig.dimension
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          memory_rowid INTEGER PRIMARY KEY,
          embedding FLOAT[${dim}]
        )
      `)
      log(`Vector table memories_vec ready (dim=${dim})`)
    } catch (e) {
      log(`memories_vec creation failed: ${e.message}`)
    }
  }
  // New table: search_misses (search miss tracking)
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

  // Migration: memories.source CHECK constraint — add 'compression'
  // SQLite doesn't support ALTER CHECK -> check if current source CHECK includes 'compression', rebuild table if not
  try {
    const memSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'`).get()?.sql || ''
    if (memSchema && !memSchema.includes("'compression'")) {
      log('Migration: rebuilding memories table to add compression source')
      db.exec(`
        BEGIN TRANSACTION;

        -- Disable FTS triggers during rebuild
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
          source_platform TEXT DEFAULT 'unknown',
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

        -- Rebuild indexes
        CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source_platform, source) WHERE deleted_at IS NULL;

        -- Rebuild FTS triggers
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
      // Rebuild FTS index (triggers were disabled during migration)
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      log('Migration: memories table rebuilt, FTS reindexed')
    }
  } catch (e) {
    log(`Migration memories CHECK failed: ${e.message}`)
    try { db.exec('ROLLBACK') } catch {}
  }

  // Clean up expired memories
  expireMemories()

  // Display stats
  const stats = getMemoryStats()
  log(`Stats: ${stats.memories.total_active} memories, ${stats.conversations} conversations, ${stats.activeGoals} active goals`)
}

// -- Embedding (optional) -------------------------------------------------

/**
 * Generate embedding vector (OpenAI-compatible API)
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
 * Cosine similarity (application-layer computation)
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

// -- Conversation logging -------------------------------------------------

/**
 * Record a conversation message
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
      msg.platform || 'unknown',
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
    // UNIQUE constraint = dedup, silent
    if (e.message.includes('UNIQUE')) return null
    log(`recordConversation failed: ${e.message}`)
    return null
  }
}

/**
 * Async version: record conversation + generate embedding (non-blocking)
 */
export async function recordConversationAsync(msg) {
  const id = recordConversation(msg)
  if (!id) return null

  // Background embedding generation
  const embedding = await generateEmbedding(msg.content)
  if (embedding) {
    try {
      getDb().prepare(`UPDATE conversations SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}
  }
  return id
}

// -- Memory storage -------------------------------------------------------

/**
 * Store a memory
 * @param {Object} mem
 * @returns {string|null} memory id
 */
export function storeMemory(mem) {
  const db = getDb()
  const now = Date.now()

  // Default TTL
  let expiresAt = mem.expiresAt || null
  if (!expiresAt && !mem.ttlMs) {
    if (mem.memoryType === 'working') expiresAt = now + 6 * 3600_000      // 6h
    else if (mem.memoryType === 'short_term') expiresAt = now + 7 * 86400_000  // 7d
  } else if (mem.ttlMs) {
    expiresAt = now + mem.ttlMs
  }

  // Compression pipeline: compressed_from tracks source memories, is_compressed marks output
  const compressedFrom = mem.compressedFrom || []
  const isCompressed = compressedFrom.length > 0 ? 1 : 0

  // Prevent cascade: reject if compressedFrom contains already-compressed memories (prevent hallucination amplification)
  if (compressedFrom.length > 0) {
    const cascadeCheck = db.prepare(
      `SELECT rowid FROM memories WHERE rowid IN (${compressedFrom.map(() => '?').join(',')}) AND is_compressed = 1`
    ).all(...compressedFrom)
    if (cascadeCheck.length > 0) {
      log(`storeMemory: rejecting cascade compression (${cascadeCheck.length} sources are already compressed)`)
      return null
    }
  }

  // Abstraction level (Memory Transfer Learning):
  // - concrete_trace: specific operation records -> low recall weight
  // - semi_abstract:  "did X because Y" -> default
  // - meta_knowledge: "when encountering X, do Y" -> high recall weight
  const validLevels = ['concrete_trace', 'semi_abstract', 'meta_knowledge']
  const memoryLevel = validLevels.includes(mem.memoryLevel) ? mem.memoryLevel : 'semi_abstract'

  try {
    const stmt = db.prepare(`
      INSERT INTO memories
        (content, summary, memory_type, category, importance, emotional_impact,
         source, source_id, source_platform, tags, metadata, expires_at,
         compressed_from, is_compressed, memory_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      mem.sourcePlatform || 'unknown',
      JSON.stringify(mem.tags || []),
      JSON.stringify(mem.metadata || {}),
      expiresAt,
      JSON.stringify(compressedFrom),
      isCompressed,
      memoryLevel,
    )
    return info.lastInsertRowid ? String(info.lastInsertRowid) : null
  } catch (e) {
    log(`storeMemory failed: ${e.message}`)
    return null
  }
}

/**
 * Async version: store memory + generate embedding + write to vec table
 */
export async function storeMemoryAsync(mem) {
  const id = storeMemory(mem)
  if (!id) return null

  const embedding = await generateEmbedding(mem.content)
  if (embedding) {
    const db = getDb()
    try {
      // Store JSON string in memories.content_vector (cross-tool visible + backup)
      db.prepare(`UPDATE memories SET content_vector = ? WHERE rowid = ?`)
        .run(JSON.stringify(embedding), id)
    } catch {}

    // Sync to sqlite-vec virtual table (for KNN queries)
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

// -- Memory retrieval (core! AIRI-style composite scoring) ----------------

/**
 * Retrieve relevant memories
 *
 * Scoring strategy (AIRI-inspired):
 *   score = FTS_relevance * 0.4
 *         + importance/10 * 0.3
 *         + time_decay * 0.2
 *         + access_frequency * 0.1
 *
 * With Memory Transfer Learning level weighting:
 *   meta_knowledge * 1.3 (patterns/heuristics, most effective across contexts)
 *   semi_abstract * 1.0 (default)
 *   concrete_trace * 0.7 (specific operations, prone to negative transfer)
 *
 * @param {Object} opts
 * @param {string} [opts.query] - query text
 * @param {string[]} [opts.types] - filter by memory types
 * @param {string[]} [opts.categories] - filter by categories
 * @param {string[]} [opts.tags] - tag filter (any match)
 * @param {number} [opts.minImportance] - minimum importance
 * @param {number} [opts.limit] - result count
 * @returns {Array}
 */
export function recallMemories(opts = {}) {
  const db = getDb()
  const { query: queryText, types, categories, tags, minImportance, limit = 10 } = opts
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000

  let rows

  if (queryText) {
    // FTS5 search + structured filtering
    // When simple extension is loaded: use jieba_query() for Chinese word-level matching
    // Otherwise: fall back to character-level query (OR-joined tokens)
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

    // Try FTS search
    if (ftsQueryParam) {
      try {
        // simple extension loaded: jieba OR query (filter stop words, any word match)
        // otherwise: character-level OR query
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

    // FTS returned nothing -> fallback to LIKE + structured filtering
    // Chinese keyword splitting: space-separated + CJK bigram sliding window
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
    // No query text: sort by importance + time
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

  // Composite scoring (AIRI-style + Memory Transfer Learning level weighting)
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }
  const scored = rows.map(row => {
    const ftsScore = row.fts_rank ? Math.min(1, Math.abs(row.fts_rank) / 10) : 0
    const importanceScore = row.importance / 10
    const age = now - row.created_at
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    const accessScore = Math.min(1, row.access_count / 20)
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0

    const baseScore = (ftsScore * 0.4) + (importanceScore * 0.3) + (timeScore * 0.2) + (accessScore * 0.1)
    const score = baseScore * levelWeight

    return { ...row, score, tags: safeJsonParse(row.tags, []), metadata: safeJsonParse(row.metadata, {}) }
  })

  // Tag filtering (application layer, since SQLite has no array overlap operator)
  let filtered = scored
  if (tags?.length) {
    filtered = scored.filter(r => tags.some(t => r.tags.includes(t)))
  }

  // Sort by score descending, take top N
  filtered.sort((a, b) => b.score - a.score)
  const result = filtered.slice(0, limit)

  // Update last_accessed
  if (result.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?
    `)
    const updateMany = db.transaction((items) => {
      for (const item of items) updateStmt.run(now, item.rowid)
    })
    try { updateMany(result) } catch {}
  }

  // Search miss tracking: queried but found nothing = knowledge blind spot signal
  if (queryText && result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'recall')
    } catch {}
  }

  return result
}

// -- Hybrid retrieval: FTS5 + vector + RRF fusion -------------------------
//
// How it works:
//   1. FTS5 path: keyword/lexical matching (strong for exact queries)
//   2. Vector path: semantic matching (synonyms, paraphrases)
//   3. RRF (Reciprocal Rank Fusion): score = sum(1/(k + rank)), k=60
//      Uses only ranks, not raw scores — merges two differently-scaled rankings fairly
//
// Performance:
//   - One embedding API call (query vector, ~120ms)
//   - Local FTS + vec KNN in parallel, sub-millisecond
//   - Total latency ~150ms (FTS alone <10ms, extra time is embedding API network)

const RRF_K = 60

/**
 * Hybrid retrieval: FTS5 + vector + RRF fusion
 * @param {Object} opts  same as recallMemories
 * @returns {Promise<Array>}
 */
export async function recallMemoriesHybrid(opts = {}) {
  const { query: queryText, limit = 10 } = opts

  // No query or extensions not ready -> fall back to sync version
  if (!queryText || !_vecLoaded || !_embeddingConfig) {
    return recallMemories(opts)
  }

  const db = getDb()
  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 86400_000
  const LEVEL_WEIGHT = { meta_knowledge: 1.3, semi_abstract: 1.0, concrete_trace: 0.7 }

  // Parallel: vector query (get embedding) + FTS query
  const [queryEmbedding, ftsRows] = await Promise.all([
    generateEmbedding(queryText),
    // FTS recall: reuse sync recallMemories, expand limit for candidate pool
    Promise.resolve(recallMemories({ ...opts, limit: limit * 3 })),
  ])

  // Vector path: KNN top N
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
      // Parse tags/metadata to align with FTS results
      vecRows = vecRows.map(r => ({
        ...r,
        tags: safeJsonParse(r.tags, []),
        metadata: safeJsonParse(r.metadata, {}),
      }))
    } catch (e) {
      log(`Vec KNN failed: ${e.message}`)
    }
  }

  // RRF fusion
  const rrfScores = new Map()  // rowid -> { row, rrf }
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

  // Apply Memory Transfer Learning level weighting + importance + time decay
  const merged = Array.from(rrfScores.values()).map(({ row, rrf, sources }) => {
    const levelWeight = LEVEL_WEIGHT[row.memory_level] || 1.0
    const importanceScore = row.importance / 10
    const age = now - row.created_at
    const timeScore = Math.max(0, 1 - age / THIRTY_DAYS_MS)
    // Composite: RRF primary (0.7) + importance/time adjustment (0.3), multiplied by level weight
    const score = (rrf * 0.7 + (importanceScore * 0.2 + timeScore * 0.1)) * levelWeight
    return { ...row, score, rrf, recall_sources: sources }
  })

  merged.sort((a, b) => b.score - a.score)
  const result = merged.slice(0, limit)

  // Update last_accessed
  if (result.length > 0) {
    const stmt = db.prepare(`UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE rowid = ?`)
    const tx = db.transaction((items) => { for (const item of items) stmt.run(now, item.rowid) })
    try { tx(result) } catch {}
  }

  // Search miss tracking (both paths empty = miss)
  if (result.length === 0) {
    try {
      db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
        .run(queryText.slice(0, 500), 'hybrid')
    } catch {}
  }

  return result
}

// -- Conversation history retrieval ---------------------------------------

/**
 * Get last N conversations (AIRI's findLastNMessages)
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
 * Search relevant conversations + context window expansion (AIRI's findRelevantMessages)
 */
export function searchConversations(queryText, opts = {}) {
  const db = getDb()
  const { chatId, limit = 3, contextWindow = 3 } = opts

  if (!queryText?.trim()) return []

  try {
    // Step 1: find anchor messages
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
      // Search miss tracking
      try {
        db.prepare('INSERT INTO search_misses (query, source, hit_count) VALUES (?, ?, 0)')
          .run(queryText.slice(0, 500), 'search_conversations')
      } catch {}
      return []
    }

    // Step 2: AIRI-style context window expansion
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

// -- Build memory context (core function for system prompt injection) ------

/**
 * Build memory context for current message
 * Combines: relevant memories + relevant conversation history + active goals
 *
 * @param {Object} opts
 * @param {string} opts.query - current user message
 * @param {string} [opts.chatId] - current chat ID
 * @param {number} [opts.memoryLimit] - recall memory count
 * @returns {Promise<string>} formatted memory context (empty string if none)
 */
export async function buildMemoryContext(opts = {}) {
  const { query: queryText, chatId, memoryLimit = 8 } = opts
  const sections = []

  // 1. Relevant memories (hybrid retrieval when query exists; inject high-importance base memories otherwise)
  const memories = queryText
    ? await recallMemoriesHybrid({ query: queryText, limit: memoryLimit, minImportance: 3 })
    : recallMemories({ limit: memoryLimit, minImportance: 7 })
  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const prefix = { permanent: '[P]', long_term: '[L]', short_term: '[S]', working: '[W]' }[m.memory_type] || '[W]'
      // Level marker: meta_knowledge = most valuable patterns; concrete_trace = low reference value
      const levelMark = { meta_knowledge: ' [meta]', semi_abstract: '', concrete_trace: ' [trace]' }[m.memory_level] || ''
      const tagStr = m.tags?.length ? ` [${m.tags.join(', ')}]` : ''
      const age = Math.floor((Date.now() - m.created_at) / 86400_000)
      const ageStr = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age}d ago`
      const text = m.summary || m.content.slice(0, 200)
      return `${prefix}${levelMark} (${m.category}, importance:${m.importance}, ${ageStr})${tagStr}\n   ${text}`
    })
    sections.push(`<recalled-memories>\n${memLines.join('\n')}\n</recalled-memories>`)
  }

  // 2. Relevant conversation history segments
  if (queryText) {
    const segments = searchConversations(queryText, { chatId, limit: 2, contextWindow: 3 })
    if (segments.length > 0) {
      const convLines = segments.map(seg => {
        return seg.messages.map(m => {
          const time = new Date(Number(m.created_at)).toISOString().slice(0, 16)
          return `  [${time}] ${m.from_name || m.role}: ${m.content.slice(0, 150)}`
        }).join('\n')
      })
      sections.push(`<relevant-conversations>\n${convLines.join('\n---\n')}\n</relevant-conversations>`)
    }
  }

  // 3. Active goals
  try {
    const goals = getDb().prepare(`
      SELECT title, description, priority, progress, status
      FROM goals
      WHERE deleted_at IS NULL AND status IN ('planned', 'in_progress')
      ORDER BY priority DESC LIMIT 5
    `).all()

    if (goals.length > 0) {
      const goalLines = goals.map(g =>
        `- [${g.status === 'in_progress' ? 'in_progress' : 'planned'}] ${g.title} (P${g.priority}, ${g.progress}%)${g.description ? ': ' + g.description.slice(0, 80) : ''}`
      )
      sections.push(`<active-goals>\n${goalLines.join('\n')}\n</active-goals>`)
    }
  } catch {}

  if (sections.length === 0) return ''

  return [
    '',
    '## Agent Memory System (auto-recall)',
    'Below are memories and history relevant to the current conversation. Reference as needed:',
    '',
    ...sections,
  ].join('\n')
}

// -- Memory management ----------------------------------------------------

/** Clean up expired memories */
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

/** Memory promotion: working -> short_term -> long_term */
export function promoteMemories() {
  const db = getDb()
  try {
    // working -> short_term: accessed >= 3 or importance >= 7
    const r1 = db.prepare(`
      UPDATE memories
      SET memory_type = 'short_term',
          expires_at = unixepoch() * 1000 + 604800000,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'working' AND deleted_at IS NULL
        AND (access_count >= 3 OR importance >= 7)
    `).run()

    // short_term -> long_term: accessed >= 8 or importance >= 8
    const r2 = db.prepare(`
      UPDATE memories
      SET memory_type = 'long_term',
          expires_at = NULL,
          updated_at = unixepoch() * 1000
      WHERE memory_type = 'short_term' AND deleted_at IS NULL
        AND (access_count >= 8 OR importance >= 8)
    `).run()

    if (r1.changes || r2.changes) {
      log(`Promoted: ${r1.changes} -> short_term, ${r2.changes} -> long_term`)
    }
  } catch (e) {
    log(`promoteMemories failed: ${e.message}`)
  }
}

// -- Goal management ------------------------------------------------------

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

// -- Statistics -----------------------------------------------------------

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

    // Compression pressure metric: (working + short_term) / max(1, long_term + permanent)
    // Value > 1.0 means temporary memories are piling up, need compression
    const raw = (mem?.working || 0) + (mem?.short_term || 0)
    const terminal = Math.max(1, (mem?.long_term || 0) + (mem?.permanent || 0))
    const compressionPressure = +(raw / terminal).toFixed(2)

    // Dead knowledge detection: long-term/permanent memories not accessed in 30 days
    const thirtyDaysAgo = Date.now() - 30 * 86400_000
    const deadKnowledge = db.prepare(`
      SELECT COUNT(*) AS count FROM memories
      WHERE deleted_at IS NULL
        AND memory_type IN ('long_term', 'permanent')
        AND last_accessed < ?
    `).get(thirtyDaysAgo)

    // Search miss stats (last 7 days)
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

// -- Session transcript indexing (Myco-inspired) --------------------------

/**
 * Index Claude Code session .jsonl files into conversations table
 * Scans ~/.claude/projects/ for all .jsonl files, extracts user + assistant text
 */
export function indexSessionTranscripts() {
  const db = getDb()
  const projectsDir = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/projects')

  if (!existsSync(projectsDir)) {
    log('Session indexing: projects dir not found')
    return { indexed: 0, skipped: 0 }
  }

  let indexed = 0, skipped = 0

  // Recursively find all .jsonl files
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

    // Skip already-indexed sessions
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
            // assistant content is a JSON array, extract text blocks
            const blocks = Array.isArray(obj.message.content) ? obj.message.content : []
            const textParts = blocks
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text.trim())
              .filter(t => t.length > 0)
            const fullText = textParts.join('\n').slice(0, 5000)
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

// -- Compression pipeline -------------------------------------------------
// Summarize old conversation segments into long_term memories, preserving source IDs for traceability
// Trigger: PreCompact hook, autosleep, or manual invocation

/**
 * Compress old conversations for a given chat_id into a summary memory
 * Uses a fast LLM (e.g., Haiku) for summarization, async
 *
 * @param {Object} opts
 * @param {string} opts.chatId - target chat_id (e.g., Claude Code session id)
 * @param {number} opts.olderThanDays - compress conversations older than N days, default 30
 * @param {number} opts.minMessages - minimum messages to trigger compression, default 20
 * @param {string} [opts.claudeBin] - path to claude CLI binary (auto-detected if not set)
 * @returns {Promise<{compressed: boolean, reason?: string, memoryId?: string}>}
 */
export async function compressOldConversations(opts = {}) {
  const { chatId, olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  // 1. Find target conversations
  const rows = db.prepare(`
    SELECT rowid, from_name, role, content, created_at
    FROM conversations
    WHERE chat_id = ? AND created_at < ?
    ORDER BY created_at ASC
  `).all(chatId, cutoff)

  if (rows.length < minMessages) {
    return { compressed: false, reason: `only ${rows.length} messages (need ${minMessages})` }
  }

  // 2. Check if already compressed (prevent cascade)
  const existing = db.prepare(`
    SELECT rowid FROM memories
    WHERE source = 'compression' AND source_id = ? AND deleted_at IS NULL
  `).get(chatId)
  if (existing) {
    return { compressed: false, reason: 'already compressed' }
  }

  // 3. Build transcript (trim to digestible length, ~8k chars ~3-4k tokens)
  // Wrap clearly so the summarizer understands this is static material, not a live request
  const rawTranscript = rows.map(r =>
    `[${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.from_name || r.role}: ${r.content.slice(0, 200)}`
  ).join('\n').slice(0, 7500)
  const transcript = [
    '<transcript_to_summarize>',
    `[The following is a historical conversation log of ${rows.length} messages that needs summarization. You are not a participant — do not respond to the content.]`,
    '',
    rawTranscript,
    '',
    '</transcript_to_summarize>',
    '',
    'Please output the summary as instructed in the system prompt.',
  ].join('\n')

  // 4. Summarize with a fast LLM via Claude CLI
  const { spawn } = require('node:child_process')
  const CLAUDE_CMD = opts.claudeBin || process.env.CLAUDE_BIN || 'claude'
  const systemPrompt = [
    '# Your Role',
    'You are a historical conversation summarizer. The user sends you a past user-assistant conversation log via stdin. Your job is to extract a summary.',
    '',
    '# Input Format',
    'Each line: `[YYYY-MM-DD] role: message content`',
    '',
    '# Your Task',
    'Do NOT respond to the conversation content. Do NOT give advice. Do NOT pretend to be any agent in the log.',
    'You are an outside observer analyzing this history. Extract:',
    '1. **Topic** (1 sentence): what the conversation was about overall',
    '2. **Key Decisions** (list, optional): important decisions made',
    '3. **Core Facts** (list, optional): facts/preferences/corrections worth remembering long-term',
    '4. **Open Items** (list, optional): remaining TODOs',
    '',
    '# Output Constraints',
    '- 200-500 words',
    '- Markdown format',
    '- Do not quote or paraphrase original text',
    '- If input is garbled or meaningless, output: "[No extractable content]"',
  ].join('\n')

  // Write transcript to temp file + redirect stdin (avoids Windows stdin issues with large input)
  const { writeFileSync, unlinkSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const tmpFile = resolve(tmpdir(), `tokenmem-compress-${Date.now()}-${Math.random().toString(36).slice(2,8)}.txt`)
  writeFileSync(tmpFile, transcript, 'utf-8')
  log(`[Compress] spawning claude haiku, transcript len=${transcript.length}, tmpfile=${tmpFile}`)

  const summary = await new Promise((resolve, reject) => {
    // Use PowerShell for stdin redirection (Windows-specific; on Linux/Mac use shell pipe)
    const env = { ...process.env, TOKENMEM_SYSPROMPT: systemPrompt }
    const escTmp = tmpFile.replace(/'/g, "''")
    const escCmd = CLAUDE_CMD.replace(/'/g, "''")
    const cleanTmpDir = tmpdir().replace(/'/g, "''")
    const psCmd = `Set-Location '${cleanTmpDir}'; Get-Content -Raw -LiteralPath '${escTmp}' | & '${escCmd}' -p --model haiku --system-prompt $env:TOKENMEM_SYSPROMPT --no-session-persistence --output-format text --max-turns 1`
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
      try { unlinkSync(tmpFile) } catch {}  // clean up temp file
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`haiku exit ${code} (stderr: ${stderr.slice(0,300)})`))
    })
  })

  // 5. Store in memories table, record compressed_from (source rowid list)
  const sourceRowIds = rows.map(r => r.rowid)
  const memoryId = storeMemory({
    content: summary,
    summary: `[Compressed] ${chatId} (${rows.length} conversations, ${olderThanDays}d+ old)`,
    memoryType: 'long_term',
    memoryLevel: 'semi_abstract',  // summarized history is session-level distillation, conservatively semi_abstract
    category: 'general',
    importance: 5,
    source: 'compression',
    sourceId: chatId,
    sourcePlatform: 'tokenmem',
    tags: ['compressed', 'transcript'],
    compressedFrom: sourceRowIds,
  })

  if (memoryId) {
    log(`[Compress] ${chatId}: ${rows.length} msgs -> memory id ${memoryId}`)
    return { compressed: true, memoryId, messageCount: rows.length }
  }
  return { compressed: false, reason: 'storeMemory returned null' }
}

/**
 * Scan all active chat_ids, batch-compress eligible ones
 * Returns compression result for each chat_id
 */
export async function compressAllOldConversations(opts = {}) {
  const { olderThanDays = 30, minMessages = 20 } = opts
  const db = getDb()
  const cutoff = Date.now() - olderThanDays * 86400_000

  // Find chat_ids with >= minMessages old conversations that haven't been compressed
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

// -- Utility functions ----------------------------------------------------

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// High-frequency stop words for FTS filtering (Chinese)
const FTS_STOP_WORDS = new Set([
  '的','了','是','在','有','和','与','或','但','而','也','都','很','就','才','被',
  '你','我','他','她','它','们','您','咱','俺',
  '呢','吗','啊','哦','哈','嗯','嘿','喂','啥','呀','嘛','吧','么',
  '什么','怎么','哪里','哪个','谁','哪','一下','方便','以后','一起','一','不',
  '想','这','那','这个','那个','有没有','可以','可能','需要','应该','如果',
])

/**
 * Build FTS OR query using jieba tokenization (when simple extension is loaded)
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
 * Chinese-friendly keyword tokenization for LIKE queries
 * Space-separated + CJK bigram sliding window
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
      // CJK bigram sliding window
      for (let i = 0; i < w.length - 1; i++) {
        if (CJK.test(w[i])) tokens.push(w.slice(i, i + 2))
      }
    } else {
      tokens.push(w)
    }
  }
  return [...new Set(tokens)]  // deduplicate
}

/** Close database connection */
export function closeMemory() {
  if (_db) {
    _db.close()
    _db = null
    log('DB closed')
  }
}

// -- CLI mode -------------------------------------------------------------
// When executed directly (node index.mjs --stats etc.), provides CLI interface
// Used by SessionStart hooks and on-demand recall from main session

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
      // Output stats JSON
      const stats = getMemoryStats()
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n')

    } else if (getFlag('--context') !== null) {
      // Build context block (for hook/session injection)
      const query = getFlag('--context') || ''
      const ctx = await buildMemoryContext({ query, memoryLimit: 10 })
      if (ctx) process.stdout.write(ctx + '\n')

    } else if (getFlag('--recall') !== null) {
      // Recall memories list (human-readable)
      const query = getFlag('--recall') || ''
      const limit = parseInt(getFlag('--limit') || '10', 10)
      const memories = recallMemories({ query, limit })
      if (memories.length === 0) {
        process.stdout.write('(no matching memories)\n')
      } else {
        for (const m of memories) {
          const date = new Date(m.created_at).toLocaleDateString()
          process.stdout.write(`[${m.importance}* ${m.memory_type} ${date}] ${m.content.slice(0, 120)}\n`)
        }
      }

    } else if (getFlag('--store') !== null) {
      // Store a memory manually
      const content = getFlag('--store')
      if (!content || content.trim().length === 0) {
        process.stderr.write('Error: --store requires content\n')
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
      // Ingest compact summary from environment variable
      // Triggered by SessionStart(source=compact) hook
      const summary = process.env.TOKENMEM_COMPACT_SUMMARY
      const sessionId = process.env.TOKENMEM_COMPACT_SESSION || 'unknown'
      if (!summary || summary.length < 50) {
        process.stderr.write('no TOKENMEM_COMPACT_SUMMARY or too short\n')
        process.exit(1)
      }
      // Idempotency check: skip if already stored for this sessionId
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
        summary: `[Compact Summary] session ${sessionId.slice(0, 8)} (${summary.length} chars)`,
        memoryType: 'long_term',
        memoryLevel: 'semi_abstract',  // compact summary is session-level distillation with specific details
        category: 'general',
        importance: 5,
        source: 'compression',
        sourceId: sessionId,
        sourcePlatform: 'claude-code',
        tags: ['compact', 'auto-summary', 'session-transcript'],
      })
      process.stdout.write(`stored compact summary: memory id ${id}\n`)

    } else if (getFlag('--compress') !== null) {
      // Compress old conversations for a specific chat_id
      const chatId = getFlag('--compress')
      const days = parseInt(getFlag('--days') || '30', 10)
      const result = await compressOldConversations({ chatId, olderThanDays: days })
      process.stdout.write(JSON.stringify(result) + '\n')

    } else if (getFlag('--compress-all') !== null) {
      // Batch compress all old chat_ids
      const days = parseInt(getFlag('--days') || '30', 10)
      const results = await compressAllOldConversations({ olderThanDays: days })
      process.stdout.write(JSON.stringify(results, null, 2) + '\n')

    } else {
      process.stderr.write([
        'tokenmem CLI — Token-efficient persistent memory for AI agents',
        '',
        'Usage:',
        '  node index.mjs --stats                  Output stats JSON',
        '  node index.mjs --context "query"         Build injection context',
        '  node index.mjs --recall "query"           Recall memories list',
        '  node index.mjs --recall "" --limit 20    List recent 20',
        '  node index.mjs --store "content"          Store a memory manually',
        '    [--importance 1-10] [--category general|people|project|...]',
        '    [--type working|short_term|long_term|permanent]',
        '    [--level concrete_trace|semi_abstract|meta_knowledge]  abstraction level (default semi_abstract)',
        '  node index.mjs --compress <chat_id>      Compress old conversations (haiku)',
        '    [--days 30]',
        '  node index.mjs --compress-all             Batch compress all old conversations',
        '  node index.mjs --store-compact-summary    Ingest compact summary from TOKENMEM_COMPACT_SUMMARY env var',
        '    (called by SessionStart source=compact hook)',
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
