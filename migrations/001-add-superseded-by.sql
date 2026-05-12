-- ============================================================
-- Migration 001: 引入结构化 supersede 字段
-- 来源：harness-evolve 提案 #001 (P0)
-- 论文依据：Mnemonic Sovereignty (arxiv 2604.16548) — 填补 Forget 阶段安全盲区
-- 执行时间：2026-04-25
-- ============================================================

-- 1. 加列：superseded_by 软关联到 memories.id（hex 主键）
--    nullable，无 FK 约束（SQLite 软关联，避免删除级联问题）
ALTER TABLE memories ADD COLUMN superseded_by TEXT;

-- 2. 索引：仅扫"待失效"集合（已 supersede 但未软删的）
CREATE INDEX IF NOT EXISTS idx_mem_superseded_by
  ON memories(superseded_by)
  WHERE superseded_by IS NOT NULL AND deleted_at IS NULL;

-- 验证：
--   PRAGMA table_info(memories);  -- 末尾应见 superseded_by 列
--   SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mem_superseded_by';
