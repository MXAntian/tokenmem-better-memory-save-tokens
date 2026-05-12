-- ============================================================
-- Migration 002: session_summaries — Phase A
-- 来源：Phase A design feedback (2026-04-29)，方向 1+2 合并实施
-- 设计：把 session 当成可结构化追溯对象
--   Phase A：零 LLM 抽取（files / meta_rowids / related / topic_tags + 基础时间元数据）
--   Phase B（后续）：加 narrative（Haiku）
--   Phase C（后续）：加 decisions / blockers（LLM 深度抽取）
-- ============================================================

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id TEXT PRIMARY KEY,

  -- 时间 / cwd / 规模
  started_at INTEGER,                          -- ms epoch
  ended_at INTEGER,
  duration_min INTEGER,
  workspace_root TEXT,                         -- 取 transcript 第一条的 cwd
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,

  -- Phase A: 零 LLM 自动抽取
  files_modified TEXT NOT NULL DEFAULT '[]',   -- JSON array of file paths
  meta_knowledge_rowids TEXT NOT NULL DEFAULT '[]', -- JSON array of memories.rowid
  topic_tags TEXT NOT NULL DEFAULT '[]',       -- JSON array (keyword-driven)
  related_session_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of session_id (overlap by files/topics)

  -- Phase B: LLM narrative（可后续填）
  narrative TEXT,                              -- ~200 字"这次做了啥"

  -- Phase C: 深度结构化（可后续填）
  decisions TEXT NOT NULL DEFAULT '[]',        -- JSON [{when, decision, why, rejected}]
  blockers TEXT NOT NULL DEFAULT '[]',         -- JSON [{when, stuck_on, attempts, breakthrough}]

  -- 抽取元数据
  extracted_phase TEXT NOT NULL DEFAULT 'A',   -- 'A' / 'B' / 'C' 标记当前抽取深度
  extracted_at INTEGER,                        -- 上次跑抽取的时间戳

  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ss_started ON session_summaries(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ss_extracted ON session_summaries(extracted_at);
CREATE INDEX IF NOT EXISTS idx_ss_phase ON session_summaries(extracted_phase);

-- FTS5 让 narrative + topic_tags 可被全文召回（与 memories_fts 同 simple tokenizer）
CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  narrative,
  topic_tags,
  content='session_summaries',
  content_rowid='rowid',
  tokenize='simple 0'
);

CREATE TRIGGER IF NOT EXISTS trg_ss_fts_insert AFTER INSERT ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(rowid, narrative, topic_tags)
  VALUES (new.rowid, new.narrative, new.topic_tags);
END;

CREATE TRIGGER IF NOT EXISTS trg_ss_fts_delete AFTER DELETE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, narrative, topic_tags)
  VALUES ('delete', old.rowid, old.narrative, old.topic_tags);
END;

CREATE TRIGGER IF NOT EXISTS trg_ss_fts_update AFTER UPDATE OF narrative, topic_tags ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, narrative, topic_tags)
  VALUES ('delete', old.rowid, old.narrative, old.topic_tags);
  INSERT INTO session_summaries_fts(rowid, narrative, topic_tags)
  VALUES (new.rowid, new.narrative, new.topic_tags);
END;
