#!/usr/bin/env node
// ============================================================
// tokenmem MCP Server
// Exposes recall_memory / store_memory / memory_stats tools
// On-demand recall for any MCP-compatible AI agent — saves 80-90% memory token costs
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

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

// Initialize memory system
initMemory()

const server = new McpServer({
  name: 'tokenmem',
  version: '2.0.0',
})

// -- Tool: recall_memory --------------------------------------------------
server.tool(
  'recall_memory',
  'Retrieve relevant content from the agent\'s long-term memory. Must call when dealing with personal preferences, past work, project status, relationships, or decisions.',
  {
    query: z.string().describe('Query content — describe what you\'re looking for in natural language'),
    limit: z.number().optional().default(8).describe('Number of results to return, default 8'),
    category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().describe('Filter by category (optional)'),
  },
  async ({ query, limit = 8, category }) => {
    const ctx = await buildMemoryContext({
      query,
      memoryLimit: limit,
    })

    if (!ctx) {
      return { content: [{ type: 'text', text: '(no matching memories found)' }] }
    }

    return { content: [{ type: 'text', text: ctx }] }
  }
)

// -- Tool: store_memory ---------------------------------------------------
server.tool(
  'store_memory',
  'Store important information in the agent\'s long-term memory. New preferences, decisions, key facts, and user feedback should be stored promptly. Prefer meta_knowledge level (extract patterns rather than recording specific steps — higher cross-context reuse value).',
  {
    content: z.string().describe('Content to remember'),
    summary: z.string().optional().describe('One-line summary (optional)'),
    importance: z.number().min(1).max(10).optional().default(6).describe('Importance 1-10, default 6'),
    memory_type: z.enum(['working', 'short_term', 'long_term', 'permanent']).optional().default('long_term').describe('Retention layer, default long_term'),
    memory_level: z.enum(['concrete_trace', 'semi_abstract', 'meta_knowledge']).optional().default('semi_abstract').describe('Abstraction level (Memory Transfer Learning): concrete_trace = specific operation log (low recall weight, prone to negative transfer) / semi_abstract = semi-abstract description (default) / meta_knowledge = patterns/methods/heuristics (high recall weight, most effective across contexts)'),
    category: z.enum(['general', 'people', 'project', 'decision', 'feedback', 'bug', 'relationship', 'skill', 'preference']).optional().default('general').describe('Category'),
    tags: z.array(z.string()).optional().describe('Tag list'),
  },
  async ({ content, summary, importance = 6, memory_type = 'long_term', memory_level = 'semi_abstract', category = 'general', tags = [] }) => {
    // Use async version: calls embedding API and writes vector (~120ms)
    const id = await storeMemoryAsync({
      content,
      summary,
      importance,
      memoryType: memory_type,
      memoryLevel: memory_level,
      category,
      source: 'conversation',
      tags,
    })

    if (!id) {
      return { content: [{ type: 'text', text: 'Storage failed' }] }
    }

    return { content: [{ type: 'text', text: `Stored memory (id: ${id}, importance: ${importance}, type: ${memory_type}, level: ${memory_level})` }] }
  }
)

// -- Tool: memory_stats ---------------------------------------------------
server.tool(
  'memory_stats',
  'View agent memory system statistics: total memories, layer distribution, conversation count, active goals, etc.',
  {},
  async () => {
    const stats = getMemoryStats()
    const text = [
      `Total memories: ${stats.memories.total_active}`,
      `  working: ${stats.memories.working} | short_term: ${stats.memories.short_term} | long_term: ${stats.memories.long_term} | permanent: ${stats.memories.permanent}`,
      `Conversations: ${stats.conversations}`,
      `Active goals: ${stats.activeGoals}`,
      `Compression pressure: ${stats.compressionPressure} ${stats.compressionPressure > 1 ? '(warning: temporary memories piling up, consider compression)' : '(normal)'}`,
      `Dead knowledge (30d unaccessed): ${stats.deadKnowledge}${stats.deadKnowledge > 10 ? ' (warning: consider cleanup)' : ''}`,
      `Search misses (7d): ${stats.recentSearchMisses}${stats.recentSearchMisses > 5 ? ' (warning: knowledge blind spots detected)' : ''}`,
      `Vector search: ${stats.embeddingConfigured ? 'configured' : 'not configured (using FTS5 only)'}`,
    ].join('\n')
    return { content: [{ type: 'text', text }] }
  }
)

// Start server
const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', () => { closeMemory(); process.exit(0) })
process.on('SIGTERM', () => { closeMemory(); process.exit(0) })
