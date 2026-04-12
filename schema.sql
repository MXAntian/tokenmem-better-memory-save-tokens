-- ============================================================
-- claude-agent-memory Schema v1.0 (SQLite + FTS5)
-- 灵感来源：AIRI (moeru-ai/airi) 记忆架构
--
-- 设计原则：
--   1. 结构化分层记忆（working → short_term → long_term → permanent）
--   2. FTS5 全文搜索（内置，无需扩展）
--   3. 复合打分在应用层计算（模拟 AIRI 的 1.2×语义 + 0.2×时间衰减）
--   4. 纯本地 SQLite，零基础设施依赖
--   5. 向量相似度可选（通过 JSON 存储向量，应用层计算余弦距离）
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 1. 核心记忆表 ──────────────────────────────────────────────
-- 对应 AIRI 的 memory_fragments
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,

  -- 分层 & 分类（AIRI 核心设计）
  memory_type TEXT NOT NULL DEFAULT 'working'
    CHECK (memory_type IN ('working', 'short_term', 'long_term', 'permanent')),
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'people', 'project', 'decision', 'feedback',
                         'bug', 'relationship', 'skill', 'preference')),

  -- 评分（AIRI 设计）
  importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  emotional_impact INTEGER NOT NULL DEFAULT 0 CHECK (emotional_impact BETWEEN -10 AND 10),

  -- 来源追踪
  source TEXT NOT NULL DEFAULT 'conversation'
    CHECK (source IN ('conversation', 'observation', 'manual', 'extraction')),
  source_id TEXT,
  source_platform TEXT DEFAULT 'feishu',

  -- 标签（JSON 数组）
  tags TEXT DEFAULT '[]',

  -- 扩展元数据
  metadata TEXT DEFAULT '{}',

  -- 向量（JSON 数组，可选，应用层计算相似度）
  content_vector TEXT,

  -- 时间戳 & 访问统计
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,

  -- 软删除
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_accessed ON memories(last_accessed DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source_platform, source) WHERE deleted_at IS NULL;

-- FTS5 虚拟表（全文搜索）
-- tokenize='simple 0': wangfenjin/simple 扩展，支持中文词级分词（0=禁用拼音，减小开销）
-- 需要先 loadExtension('libsimple-windows-x64/simple') + jieba_dict(dictPath)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  summary,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='simple 0'
);

-- 同步触发器：memories 增删改 → FTS 索引自动更新
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

-- ── 2. 对话日志表 ──────────────────────────────────────────────
-- 对应 AIRI 的 chat_messages
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  platform TEXT NOT NULL DEFAULT 'feishu',
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

-- FTS5 对话搜索
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

-- ── 3. 目标追踪表 ──────────────────────────────────────────────
-- 对应 AIRI 的 memory_long_term_goals
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

-- ── 4. 事件记忆表 ──────────────────────────────────────────────
-- 对应 AIRI 的 memory_episodic
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
