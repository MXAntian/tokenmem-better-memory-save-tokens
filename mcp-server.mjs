#!/usr/bin/env node
// ============================================================
// claude-agent-memory MCP Server
// 暴露 recall_memory / store_memory / memory_stats 三个工具
// 让 Claude Code 主会话按需查询，替代 UserPromptSubmit 预注入
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  initMemory,
  recallMemories,
  storeMemory,
  buildMemoryContext,
  getMemoryStats,
  closeMemory,
} from './index.mjs'

// 初始化记忆系统
initMemory()

const server = new McpServer({
  name: 'engram',
  version: '1.0.0',
})

// ── 工具：recall_memory ───────────────────────────────────────
server.tool(
  'recall_memory',
  '从 Agent 的长期记忆中检索与查询相关的内容。涉及个人偏好、过去工作、项目状态、关系、决策时必须调用。',
  {
    query: z.string().describe('查询内容，用自然语言描述想找的信息'),
    limit: z.number().optional().default(8).describe('返回条数，默认 8'),
    category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().describe('限定分类（可选）'),
  },
  async ({ query, limit = 8, category }) => {
    const ctx = buildMemoryContext({
      query,
      memoryLimit: limit,
    })

    if (!ctx) {
      return { content: [{ type: 'text', text: '（未找到相关记忆）' }] }
    }

    return { content: [{ type: 'text', text: ctx }] }
  }
)

// ── 工具：store_memory ────────────────────────────────────────
server.tool(
  'store_memory',
  '将重要信息存入 Agent 的长期记忆。对话中发现的新偏好、决策、关键事实、用户反馈等应及时存入。',
  {
    content: z.string().describe('要记忆的内容'),
    summary: z.string().optional().describe('一句话摘要（可选）'),
    importance: z.number().min(1).max(10).optional().default(6).describe('重要性 1-10，默认 6'),
    memory_type: z.enum(['working', 'short_term', 'long_term', 'permanent']).optional().default('long_term').describe('记忆层级，默认 long_term'),
    category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().default('general').describe('分类'),
    tags: z.array(z.string()).optional().describe('标签列表'),
  },
  async ({ content, summary, importance = 6, memory_type = 'long_term', category = 'general', tags = [] }) => {
    const id = storeMemory({
      content,
      summary,
      importance,
      memoryType: memory_type,
      category,
      source: 'conversation',
      tags,
    })

    if (!id) {
      return { content: [{ type: 'text', text: '存储失败' }] }
    }

    return { content: [{ type: 'text', text: `已存入记忆 (id: ${id}, 重要性: ${importance}, 类型: ${memory_type})` }] }
  }
)

// ── 工具：memory_stats ────────────────────────────────────────
server.tool(
  'memory_stats',
  '查看 Agent 记忆系统的统计信息：记忆总数、分层分布、对话数、活跃目标等。',
  {},
  async () => {
    const stats = getMemoryStats()
    const text = [
      `记忆总数: ${stats.memories.total_active} 条`,
      `  working: ${stats.memories.working} | short_term: ${stats.memories.short_term} | long_term: ${stats.memories.long_term} | permanent: ${stats.memories.permanent}`,
      `对话记录: ${stats.conversations} 条`,
      `活跃目标: ${stats.activeGoals} 个`,
      `向量搜索: ${stats.embeddingConfigured ? '已配置' : '未配置（使用 FTS5）'}`,
    ].join('\n')
    return { content: [{ type: 'text', text }] }
  }
)

// 启动
const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', () => { closeMemory(); process.exit(0) })
process.on('SIGTERM', () => { closeMemory(); process.exit(0) })
