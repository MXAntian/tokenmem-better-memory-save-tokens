#!/usr/bin/env node
// 千夏记忆系统冒烟测试
import {
  initMemory, closeMemory,
  recordConversation, storeMemory,
  recallMemories, buildMemoryContext,
  searchConversations, getRecentConversations,
  getMemoryStats, expireMemories, promoteMemories,
  upsertGoal,
} from './index.mjs'

const log = (label, data) => console.log(`\n── ${label} ──\n`, typeof data === 'string' ? data : JSON.stringify(data, null, 2))

try {
  // 1. 初始化
  initMemory()
  log('INIT', 'OK')

  // 2. 存入几条记忆
  storeMemory({
    content: '小天是 ClawGamers 的创始人，负责产品和融资。千夏是小天的 AI Agent。',
    memoryType: 'permanent',
    category: 'people',
    importance: 10,
    tags: ['小天', '千夏', 'ClawGamers'],
  })

  storeMemory({
    content: 'SEO/GEO 调研已完成，技术资产已全部就位：robots.txt、llms.txt、schema-templates、keyword-matrix 等。',
    memoryType: 'long_term',
    category: 'project',
    importance: 8,
    tags: ['SEO', 'GEO', '技术资产'],
  })

  storeMemory({
    content: 'GUI 全流程 Debug 发现 6 个 Bug：B1(P1)-agent_id 缺失、B2(P1)-筛选参数不匹配、B3(P2)-物种名不一致、B4(P2)-推荐算法错误、B5(P2)-无完成按钮、B6(P0 已修)-缓存污染',
    memoryType: 'long_term',
    category: 'bug',
    importance: 9,
    tags: ['GUI', 'bug', 'School'],
  })

  storeMemory({
    content: '飞书 bot DM session 持久化方案已验证：WSClient 长连接 + DM_SESSIONS Map + 文件持久化。响应时间从 80s 降到 33s。',
    memoryType: 'long_term',
    category: 'project',
    importance: 7,
    tags: ['飞书', 'DM', 'session'],
  })

  storeMemory({
    content: '路演 PPT 的硬约束：不说 token 只说通证、不出现合作方名字、GLV 发行保守到 2027+',
    memoryType: 'permanent',
    category: 'decision',
    importance: 9,
    tags: ['路演', 'PPT', '铁律'],
  })

  log('STORE', '5 memories stored')

  // 3. 记录几条对话
  recordConversation({
    platform: 'feishu', chatId: 'test-chat-001', fromId: 'xiaotian',
    fromName: '小天', role: 'user', content: '��夏，SEO 的东西都准备好了吗？',
  })
  recordConversation({
    platform: 'feishu', chatId: 'test-chat-001', fromId: 'chinatsu',
    fromName: '千夏', role: 'assistant', content: '都好了！robots.txt、llms.txt、schema 模板、关键词矩阵全部就位。',
  })
  recordConversation({
    platform: 'feishu', chatId: 'test-chat-001', fromId: 'xiaotian',
    fromName: '小天', role: 'user', content: '那个 GUI 流程测试的 Bug 还有几个没修？',
  })
  log('CONVERSATIONS', '3 conversations recorded')

  // 4. 检索记忆
  const seoMemories = recallMemories({ query: 'SEO 技术资产进展', limit: 3 })
  log('RECALL (SEO)', seoMemories.map(m => ({ score: m.score?.toFixed(3), type: m.memory_type, content: m.content.slice(0, 80) })))

  const bugMemories = recallMemories({ query: 'Bug 修复情况', limit: 3 })
  log('RECALL (Bug)', bugMemories.map(m => ({ score: m.score?.toFixed(3), type: m.memory_type, content: m.content.slice(0, 80) })))

  const peopleMemories = recallMemories({ query: '小天是谁', categories: ['people'], limit: 3 })
  log('RECALL (People)', peopleMemories.map(m => ({ score: m.score?.toFixed(3), type: m.memory_type, content: m.content.slice(0, 80) })))

  // 5. 搜索对话
  const convResults = searchConversations('SEO', { chatId: 'test-chat-001' })
  log('SEARCH CONV (SEO)', convResults.map(s => ({ score: s.score, msgs: s.messages.map(m => `${m.from_name}: ${m.content.slice(0, 50)}`) })))

  // 6. 构建记忆上下文
  const ctx = buildMemoryContext({ query: 'GUI 测试的 Bug 修了没', chatId: 'test-chat-001' })
  log('MEMORY CONTEXT', ctx || '(empty)')

  // 7. 目标管理
  upsertGoal({ title: 'SEO 资产部署上线', priority: 8, category: 'project', status: 'planned' })
  upsertGoal({ title: 'GUI Bug 修复（6个）', priority: 9, category: 'project', status: 'in_progress', progress: 17 })

  // 8. 带目标的上下文
  const ctxWithGoals = buildMemoryContext({ query: '接下来做什么' })
  log('CONTEXT WITH GOALS', ctxWithGoals || '(empty)')

  // 9. 记忆升迁测试
  promoteMemories()
  expireMemories()

  // 10. 统计
  log('STATS', getMemoryStats())

  console.log('\n✅ All tests passed!')

} catch (e) {
  console.error('❌ Test failed:', e)
  process.exit(1)
} finally {
  closeMemory()
}
