-- ============================================================
-- Migration 003: memory 衰减 + paper trail（v59 借入 AI 情绪系统 3 项机制）
-- 来源：state.md v59（2026-05-12 桌面 session handoff）
--   - 借自 v2 教程 §1.5 衰减公式 + Wave14 §2 幂律衰减
--   - 借自 v2 教程 §2.5 paper trail（merge 不删，推进 prior_versions[]）
-- 执行时间：2026-05-13
--
-- 设计要点：
--   1. SQLite 无 JSONB → prior_versions 用 TEXT 存 JSON.stringify 数组
--   2. activation_count / last_activated 复用现有 access_count / last_accessed
--      （含义一致，不重复加列）
--   3. surfaced_random 浮现条件：importance ≥ 8 AND 30d 未 hit AND decay ≥ 0.3
--   4. τ = 24h（v2 教程默认 4h 对实测 access pattern 太快，调到 24h）
-- ============================================================

-- 1. decay_score — 幂律衰减分（runDecayCycle 周期更新；recall 排序乘权重）
ALTER TABLE memories ADD COLUMN decay_score REAL NOT NULL DEFAULT 1.0;

-- 2. prior_versions — paper trail；supersede 时旧 content/summary/ts 推进数组
ALTER TABLE memories ADD COLUMN prior_versions TEXT NOT NULL DEFAULT '[]';

-- 3. 索引：surfaced_random 浮现池查询专用
--    条件：importance ≥ 8 AND last_accessed 30d 之前 AND decay_score ≥ 0.3
--    实际池子很小（importance ≥ 8 通常仅几十条），index 加速 random 抽样
CREATE INDEX IF NOT EXISTS idx_mem_surface_pool
  ON memories(importance, last_accessed, decay_score)
  WHERE deleted_at IS NULL AND superseded_by IS NULL AND importance >= 8;

-- 验证：
--   PRAGMA table_info(memories);  -- 末尾应见 decay_score / prior_versions 两列
--   SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mem_surface_pool';
--   SELECT COUNT(*) FROM memories
--     WHERE importance >= 8 AND last_accessed < (unixepoch()*1000 - 30*86400*1000)
--       AND decay_score >= 0.3 AND deleted_at IS NULL;
