#!/usr/bin/env node
// ============================================================
// tokenmem MCP Server
// Exposes recall_memory / store_memory / memory_stats tools
// On-demand recall for any MCP-compatible AI agent — saves 80-90% memory token costs
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

import {
  initMemory,
  recallMemories,
  storeMemory,
  storeMemoryAsync,
  buildMemoryContext,
  getMemoryStats,
  indexSessionTranscripts,
  closeMemory,
} from './index.mjs'

// 初始化记忆系统
initMemory()

// 工厂：每次调用返回带 3 工具的全新 McpServer 实例
// 为什么是工厂：HTTP stateful 多 client 模式下，每 session 需要独立 server（SDK 设计 transport ↔ server 1:1）
function createServer() {
  const s = new McpServer({
    name: 'tokenmem',
    version: '1.1.0',
  })

  // ── 工具：recall_memory ───────────────────────────────────────
  s.tool(
    'recall_memory',
    '从 Agent 的长期记忆中检索与查询相关的内容。涉及个人偏好、过去工作、项目状态、关系、决策时必须调用。',
    {
      query: z.string().describe('查询内容，用自然语言描述想找的信息'),
      limit: z.number().optional().default(8).describe('返回条数，默认 8'),
      category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().describe('限定分类（可选）'),
    },
    async ({ query, limit = 8, category }) => {
      // _source: 'mcp' → recall_log 打点能区分 MCP tool 调用 vs CLI vs hook
      // _sessionId: HTTP MCP transport 没暴露 CC session id，先 NULL（per-prompt 聚合走时间窗口近似）
      const ctx = await buildMemoryContext({
        query,
        memoryLimit: limit,
        _source: 'mcp',
        _sessionId: null,
      })
      if (!ctx) {
        return { content: [{ type: 'text', text: '（未找到相关记忆）' }] }
      }
      return { content: [{ type: 'text', text: ctx }] }
    }
  )

  // ── 工具：store_memory ────────────────────────────────────────
  s.tool(
    'store_memory',
    '将重要信息存入 Agent 的长期记忆。对话中发现的新偏好、决策、关键事实、用户反馈等应及时存入。优先使用 meta_knowledge 层级（提炼模式而非记录具体步骤，跨场景复用价值高）。',
  {
    content: z.string().describe('要记忆的内容'),
    summary: z.string().optional().describe('一句话摘要（可选）'),
    importance: z.number().min(1).max(10).optional().default(6).describe('重要性 1-10，默认 6'),
    memory_type: z.enum(['working', 'short_term', 'long_term', 'permanent']).optional().default('long_term').describe('保留层级，默认 long_term'),
    memory_level: z.enum(['concrete_trace', 'semi_abstract', 'meta_knowledge']).optional().default('semi_abstract').describe('抽象层级（Memory Transfer Learning）：concrete_trace=具体操作记录（低召回权重，易负迁移）/ semi_abstract=半抽象描述（默认）/ meta_knowledge=模式/方法/启发式（高召回权重，跨场景最有效）'),
    category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().default('general').describe('分类'),
    tags: z.array(z.string()).optional().describe('标签列表'),
    supersedes: z.array(z.string()).optional().describe('被本条记忆替代的旧记忆 id 列表（rowid 字符串数组，如 ["325","348"]）。写入后旧记忆会在下一次 expireMemories 自动软删除，不再被 recall 召回。优先于 summary 里的字符串约定。'),
  },
  async ({ content, summary, importance = 6, memory_type = 'long_term', memory_level = 'semi_abstract', category = 'general', tags = [], supersedes }) => {
    // 走 async 版本：会同步调 embedding API 写入向量（百炼 ~120ms）
    const id = await storeMemoryAsync({
      content,
      summary,
      importance,
      memoryType: memory_type,
      memoryLevel: memory_level,
      category,
      source: 'conversation',
      tags,
      supersedes,
    })

    if (!id) {
      return { content: [{ type: 'text', text: '存储失败' }] }
    }

    return { content: [{ type: 'text', text: `已存入记忆 (id: ${id}, 重要性: ${importance}, 类型: ${memory_type}, 层级: ${memory_level})` }] }
  }
)

  // ── 工具：memory_stats ────────────────────────────────────────
  s.tool(
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
        `压缩压力: ${stats.compressionPressure} ${stats.compressionPressure > 1 ? '⚠️ 临时记忆堆积，建议压缩' : '✓ 正常'}`,
        `死知识 (30d 未访问): ${stats.deadKnowledge} 条${stats.deadKnowledge > 10 ? ' ⚠️ 建议清理' : ''}`,
        `近 7 天搜索未命中: ${stats.recentSearchMisses} 次${stats.recentSearchMisses > 5 ? ' ⚠️ 存在知识盲区' : ''}`,
        `向量搜索: ${stats.embeddingConfigured ? '已配置' : '未配置（使用 FTS5）'}`,
      ].join('\n')
      return { content: [{ type: 'text', text }] }
    }
  )

  return s
}

// ── transport 选择 ───────────────────────────────────────────────
// 默认 stdio（向后兼容老 session）。传 --transport=http --port=18792 启 HTTP 模式：
//   一个常驻 server 进程多 client 共享，根治"每个 CC session spawn 一份 → 僵尸堆积 → db 锁竞争"问题
const args = process.argv.slice(2)
const useHttp = args.includes('--transport=http')
const portArg = args.find(a => a.startsWith('--port='))
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 18792
const HOST = '127.0.0.1' // 硬性 bind localhost only（防 DNS rebinding，按 MCP 规范）

let httpServer = null

const gracefulExit = (reason) => {
  try { if (httpServer) httpServer.close() } catch {}
  try { closeMemory() } catch {}
  process.exit(0)
}

if (useHttp) {
  // ── HTTP transport (stateful, per-session transport map) ───────────
  // 多 CC client 同时连：每 client 一个 transport 实例 + sessionId
  // - 第一次 init 请求：sessionIdGenerator 给个新 uuid，开 transport 加入 map
  // - 后续请求带 Mcp-Session-Id 头：从 map 找对应 transport
  // - SDK 注释明确：stateless 模式要每请求新 transport（开销大），所以走 stateful
  const sessions = new Map() // sessionId → { transport, server }

  httpServer = http.createServer(async (req, res) => {
    // Origin 校验：只允许 localhost 来源（MCP 规范硬性要求）
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden origin')
      return
    }
    // 健康检查端点（独立于 MCP 协议）
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, server: 'tokenmem', version: '1.1.0', transport: 'http',
        active_sessions: sessions.size,
      }))
      return
    }
    // MCP 端点
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      try {
        const sessionId = req.headers['mcp-session-id']
        let entry = sessionId ? sessions.get(sessionId) : null

        if (!entry) {
          // 新 session：开 transport + connect 一个 server 实例
          // 注意：单一 McpServer 实例在多 transport 间共享 tool registry 不安全（SDK 设计）
          // 所以每 session 新 server + 注册同样的工具
          const newServer = createServer()
          const newTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { transport: newTransport, server: newServer })
              console.error(`[tokenmem] session opened: ${newSessionId.slice(0, 8)} (total=${sessions.size})`)
            },
            onsessionclosed: (closedSessionId) => {
              sessions.delete(closedSessionId)
              console.error(`[tokenmem] session closed: ${closedSessionId.slice(0, 8)} (total=${sessions.size})`)
            },
          })
          await newServer.connect(newTransport)
          entry = { transport: newTransport, server: newServer }
        }
        await entry.transport.handleRequest(req, res)
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end(`MCP transport error: ${e.message}`)
        }
        console.error(`[tokenmem] handler error: ${e.message}`)
      }
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  httpServer.listen(PORT, HOST, () => {
    console.error(`[tokenmem] HTTP MCP server listening on http://${HOST}:${PORT}/mcp (PID ${process.pid})`)
    console.error(`[tokenmem] Health: http://${HOST}:${PORT}/health`)
  })

  process.on('SIGINT', () => gracefulExit('SIGINT'))
  process.on('SIGTERM', () => gracefulExit('SIGTERM'))
  process.on('SIGHUP', () => gracefulExit('SIGHUP'))
} else {
  // ── stdio transport（老路径，向后兼容）────────────────────────────
  const stdioServer = createServer()
  const transport = new StdioServerTransport()
  await stdioServer.connect(transport)

  // 守卫：CC session 退出时通常只断 stdio 不发信号，必须监听 stdin end/close 主动退出
  // 否则 mcp-server 进程堆积成僵尸（2026-04-27 实证 13 个并发 → engram.db 锁竞争 → MCP disconnected）
  process.on('SIGINT', () => gracefulExit('SIGINT'))
  process.on('SIGTERM', () => gracefulExit('SIGTERM'))
  process.on('SIGHUP', () => gracefulExit('SIGHUP'))
  process.stdin.on('end', () => gracefulExit('stdin-end'))
  process.stdin.on('close', () => gracefulExit('stdin-close'))
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') gracefulExit('stdout-EPIPE')
  })
}
