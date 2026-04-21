-- ============================================================
-- tokenmem Schema v2.0 (SQLite + FTS5 + sqlite-vec)
-- Inspired by: AIRI (moeru-ai/airi) memory architecture
--
-- Design principles:
--   1. Structured layered memory (working -> short_term -> long_term -> permanent)
--   2. FTS5 full-text search (built-in, no extensions needed)
--   3. Composite scoring in application layer (AIRI-style: 1.2x semantic + 0.2x time decay)
--   4. Pure local SQLite, zero infrastructure dependency
--   5. Optional: sqlite-vec for KNN vector search
--   6. Memory Transfer Learning: 3-tier abstraction levels
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -- 1. Core memory table -------------------------------------------------
-- Inspired by AIRI's memory_fragments
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,

  -- Layered & categorized (AIRI core design)
  memory_type TEXT NOT NULL DEFAULT 'working'
    CHECK (memory_type IN ('working', 'short_term', 'long_term', 'permanent')),
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'people', 'project', 'decision', 'feedback',
                         'bug', 'relationship', 'skill', 'preference')),

  -- Scoring (AIRI design)
  importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  emotional_impact INTEGER NOT NULL DEFAULT 0 CHECK (emotional_impact BETWEEN -10 AND 10),

  -- Source tracking
  source TEXT NOT NULL DEFAULT 'conversation'
    CHECK (source IN ('conversation', 'observation', 'manual', 'extraction', 'compression')),
  source_id TEXT,
  source_platform TEXT DEFAULT 'unknown',

  -- Tags (JSON array)
  tags TEXT DEFAULT '[]',

  -- Compression pipeline (Myco-inspired)
  compressed_from TEXT DEFAULT '[]', -- JSON array: source memory rowids that were compressed into this
  is_compressed INTEGER NOT NULL DEFAULT 0, -- 1 = this is a compression product, cannot be re-compressed (prevent cascade)

  -- Abstraction level (Memory Transfer Learning, arxiv 2604.14004)
  -- concrete_trace: specific operation record (low weight, prone to negative transfer)
  -- semi_abstract:  semi-abstract description (default, medium weight)
  -- meta_knowledge: pattern/method/heuristic (high weight, most effective cross-domain)
  memory_level TEXT NOT NULL DEFAULT 'semi_abstract'
    CHECK (memory_level IN ('concrete_trace', 'semi_abstract', 'meta_knowledge')),

  -- Extended metadata
  metadata TEXT DEFAULT '{}',

  -- Vector (JSON array, optional, for application-layer cosine similarity or sqlite-vec)
  content_vector TEXT,

  -- Timestamps & access stats
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,

  -- Soft delete
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source_platform, source) WHERE deleted_at IS NULL;

-- FTS5 virtual table (full-text search)
-- tokenize='simple 0': wangfenjin/simple extension for Chinese word-level tokenization (optional)
-- Requires: loadExtension('libsimple') + jieba_dict(dictPath)
-- Without simple extension: default FTS5 tokenizer works for English and other languages
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  summary,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='simple 0'
);

-- Sync triggers: memories INSERT/DELETE/UPDATE -> FTS index auto-updated
CREATE TRIGGER IF NOT EXISTS trg_mem_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS trg_mem_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS trg_mem_fts_update AFTER UPDATE OF content, summary, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
  VALUES ('delete', old.rowid, old.content, old.summary, old.tags);
  INSERT INTO memories_fts(rowid, content, summary, tags)
  VALUES (new.rowid, new.content, new.summary, new.tags);
END;

-- -- 2. Conversation log table --------------------------------------------
-- Inspired by AIRI's chat_messages
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  platform TEXT NOT NULL DEFAULT 'unknown',
  chat_id TEXT NOT NULL,
  message_id TEXT,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL CHECK (length(content) > 0),
  is_reply INTEGER DEFAULT 0,
  reply_to_id TEXT,
  metadata TEXT DEFAULT '{}',
  content_vector TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_conv_chat_time ON conversations(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversations(platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_from ON conversations(from_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_dedup
  ON conversations(platform, chat_id, message_id)
  WHERE message_id IS NOT NULL;

-- FTS5 conversation search
CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
  content,
  from_name,
  content='conversations',
  content_rowid='rowid',
  tokenize='simple 0'
);

CREATE TRIGGER IF NOT EXISTS trg_conv_fts_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO conversations_fts(rowid, content, from_name)
  VALUES (new.rowid, new.content, new.from_name);
END;

CREATE TRIGGER IF NOT EXISTS trg_conv_fts_delete AFTER DELETE ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
  VALUES ('delete', old.rowid, old.content, old.from_name);
END;

CREATE TRIGGER IF NOT EXISTS trg_conv_fts_update AFTER UPDATE OF content ON conversations BEGIN
  INSERT INTO conversations_fts(conversations_fts, rowid, content, from_name)
  VALUES ('delete', old.rowid, old.content, old.from_name);
  INSERT INTO conversations_fts(rowid, content, from_name)
  VALUES (new.rowid, new.content, new.from_name);
END;

-- -- 3. Goal tracking table -----------------------------------------------
-- Inspired by AIRI's memory_long_term_goals
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'abandoned')),
  parent_goal_id TEXT REFERENCES goals(id),
  category TEXT NOT NULL DEFAULT 'project',
  deadline INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_goal_status ON goals(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_goal_priority ON goals(priority DESC) WHERE deleted_at IS NULL;

-- -- 4. Search miss tracking ----------------------------------------------
-- Track queries with no results — high-frequency misses signal knowledge blind spots
CREATE TABLE IF NOT EXISTS search_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'recall',  -- recall / search_conversations / hybrid
  hit_count INTEGER NOT NULL DEFAULT 0,   -- 0 = complete miss
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_miss_query ON search_misses(query);
CREATE INDEX IF NOT EXISTS idx_miss_created ON search_misses(created_at DESC);

-- -- 5. Episodic memory table ---------------------------------------------
-- Inspired by AIRI's memory_episodic
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  participants TEXT DEFAULT '[]',
  location TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ep_type ON episodes(event_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ep_memory ON episodes(memory_id);
