# claude-agent-memory

> Persistent long-term memory for Claude Code agents — SQLite + FTS5 + MCP on-demand recall, with Chinese tokenization support.
>
> 为 Claude Code Agent 设计的持久化长期记忆系统 —— SQLite + FTS5 全文搜索 + MCP 按需召回，支持中文分词。

---

## Why / 为什么做这个

Claude Code agents are stateless by default. Every session starts fresh — no memory of past decisions, preferences, or conversations.

The common workaround is injecting a context file on every prompt (`UserPromptSubmit` hook). This works, but it's wasteful: most prompts don't need historical memory, yet you pay the token cost every time.

**This project takes a different approach**: give the agent a structured SQLite memory store, expose it as an MCP tool, and let Claude decide when to query it — only when the current context doesn't already contain the answer.

---

Claude Code Agent 默认是无状态的。每次 session 重新从零开始，没有过去的决策、偏好或对话记录。

常见的解决方案是在每条 prompt 触发时注入上下文文件（`UserPromptSubmit` hook）。这能工作，但代价不低：绝大多数 prompt 根本不需要历史记忆，但每次都要消耗 token。

**本项目采用不同思路**：给 Agent 一个结构化的 SQLite 记忆库，通过 MCP 工具暴露出来，让 Claude 自己决定何时查询——只在当前上下文不够用的时候才查。

---

## Architecture / 架构

```
┌─────────────────────────────────────────────────┐
│                  Claude Code                    │
│                                                 │
│  "Do I already know this?"                      │
│       ↓ No                                      │
│  recall_memory("query") ──→ MCP Server          │
│                                  ↓              │
│                          SQLite + FTS5          │
│                          (chinatsu.db)          │
│                                  ↓              │
│  ← ranked results (importance × recency)        │
│                                                 │
│  store_memory("insight") ──→ MCP Server         │
│                                  ↓              │
│                          INSERT INTO memories   │
└─────────────────────────────────────────────────┘
```

### Two tables / 双表设计

| Table | Purpose |
|-------|---------|
| `memories` | Structured knowledge: preferences, decisions, facts, feedback |
| `conversations` | Raw conversation log (optional, for context window expansion) |

`recall_memory` searches `memories` as the primary source. `conversations` serves as supplementary context.

---

`memories` 存结构化知识（偏好、决策、事实、反馈），`conversations` 存原始对话流水（可选）。`recall_memory` 以 `memories` 为主要检索源。

---

### Memory layers / 记忆分层

| Type | TTL | Use case |
|------|-----|----------|
| `working` | 6 hours | In-session scratch notes |
| `short_term` | 7 days | Task results, recent context |
| `long_term` | No expiry | Decisions, preferences, project facts |
| `permanent` | No expiry | Core identity, iron rules |

---

### Ranking / 打分排序

Recall results are ranked by a composite score inspired by the [AIRI](https://github.com/moeru-ai/airi) memory architecture[^1]:

```
score = importance × recency_decay × fts_rank
```

- **importance** (1–10): set when storing
- **recency_decay**: exponential decay over time (recent memories score higher)
- **fts_rank**: FTS5 BM25 relevance score

---

## The Key Insight: MCP On-Demand vs Pre-Injection / 核心设计：MCP 按需 vs 预注入

### Pre-injection (common but wasteful) / 预注入（常见但浪费）

```
Every user prompt
    → hook fires
    → query SQLite
    → inject into context
    → Claude answers
```

Problem: unnecessary token cost on every single message, even when Claude already has the answer in context.

---

每条 prompt → hook 触发 → 查 SQLite → 注入上下文 → Claude 回答

问题：即使 Claude 已知答案，每条消息都要查一次，持续消耗 token。

### MCP on-demand (this project) / MCP 按需召回（本项目）

```
User prompt
    → Claude reads context
    → "Do I know this already?" → Yes → answer directly
                                → No  → recall_memory(query)
                                            → ranked results
                                        → answer with memory
```

Claude decides whether memory lookup is needed. Most prompts don't need it. Token cost is paid only when it matters.

---

Claude 自己判断是否需要查记忆。大多数 prompt 不需要。只在真正需要时才付出 token 代价。

The `CLAUDE.md` instruction that makes this work:

```markdown
## Memory System (chinatsu-memory MCP)

You have access to a long-term memory SQLite database via the `chinatsu-memory` MCP server:
- `recall_memory(query, limit?, category?)` — retrieve relevant memories
- `store_memory(content, ...)` — store important information

### When to call recall_memory
**Check context first. Only query SQLite when context doesn't contain a confident answer.**

Must call when:
- User asks about personal preferences, habits, past work
- User references people, relationships, or project history
- Context doesn't contain a confident answer

Do NOT call when:
- Current context already contains the answer
- Pure technical question unrelated to personal/project knowledge
- Already queried in this session
```

---

## Chinese Tokenization / 中文分词

SQLite's built-in FTS5 tokenizer treats each CJK character as a separate token. For Chinese, this produces AND queries like:

```sql
-- Searching "你喜欢吃什么" generates:
"你" AND "喜欢" AND "吃" AND "什么"
-- All tokens must be present → very low recall
```

This project integrates **[wangfenjin/simple](https://github.com/wangfenjin/simple)**[^2][^3], a native SQLite extension that uses [cppjieba](https://github.com/yanyiwu/cppjieba) for word-level segmentation:

```sql
-- FTS5 table created with:
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, summary, tags,
  content='memories', content_rowid='rowid',
  tokenize='simple 0'   -- '0' disables pinyin, reduces overhead
);
```

### The AND→OR fix / AND→OR 修复

`jieba_query()` generates AND logic by default — still too strict for recall:

```sql
SELECT jieba_query('你平时不喜欢吃什么');
-- Returns: "平时" AND "不喜欢" AND "吃"
-- A memory containing "不喜欢吃香菜" won't match because "平时" is absent
```

This project parses the jieba output and rebuilds it as OR:

```javascript
function buildJiebaOrQuery(text) {
  const jiebaRaw = db.prepare('SELECT jieba_query(?) AS q').get(text)?.q || ''
  const terms = [...jiebaRaw.matchAll(/"([^"]+)"/g)].map(m => m[1])
  const keywords = terms.filter(t => t.length > 1 && !FTS_STOP_WORDS.has(t))
  if (keywords.length === 0) return null
  return keywords.map(t => `"${t}"`).join(' OR ')
  // → "平时" OR "不喜欢" OR "吃"
  // → Any keyword match returns results ✓
}
```

See wangfenjin's blog post[^3] for a detailed explanation of the tokenizer internals.

---

## Setup / 安装配置

### Prerequisites / 前置条件

- Node.js 18+
- Claude Code CLI

### 1. Install dependencies / 安装依赖

```bash
npm install better-sqlite3 @modelcontextprotocol/sdk zod
```

### 2. Download the simple tokenizer extension / 下载 simple 分词扩展

Grab a prebuilt binary from [wangfenjin/simple releases](https://github.com/wangfenjin/simple/releases)[^2]:

- Windows x64: `simple.dll` + `dict/` folder
- macOS: `libsimple.dylib` + `dict/` folder
- Linux: `libsimple.so` + `dict/` folder

Place them at:

```
memory/
├── lib/
│   └── libsimple-<platform>/
│       ├── simple.dll   (or .dylib / .so)
│       └── dict/
│           ├── jieba.dict.utf8
│           ├── hmm_model.utf8
│           └── ...
```

The tokenizer is optional — the system falls back to character-level FTS5 if the extension isn't found.

### 3. Initialize the database / 初始化数据库

```bash
node index.mjs --stats
# First run creates chinatsu.db and runs schema migrations automatically
```

### 4. Register the MCP server / 注册 MCP Server

```bash
# User scope (available across all projects)
claude mcp add --scope user my-agent-memory -- node /path/to/memory/mcp-server.mjs
```

Verify:

```bash
claude mcp list
# my-agent-memory: node /path/to/... - ✓ Connected
```

### 5. Add the CLAUDE.md instruction / 添加 CLAUDE.md 指令

Add the on-demand recall instruction (see [The Key Insight](#the-key-insight-mcp-on-demand-vs-pre-injection--核心设计mcp-按需-vs-预注入) section above) to your global `~/.claude/CLAUDE.md`.

---

## Usage / 使用

### Store a memory / 存入记忆

```javascript
// Via MCP tool (Claude does this automatically)
store_memory({
  content: "User dislikes coriander",
  summary: "Food preference: no coriander",
  importance: 8,
  memory_type: "long_term",
  category: "preference",
  tags: ["food", "preference"]
})
```

```bash
# Via CLI
node index.mjs --store "User dislikes coriander" --importance 8 --type long_term --category preference
```

### Recall memories / 召回记忆

```javascript
// Via MCP tool (Claude calls this when needed)
recall_memory({ query: "food preferences", limit: 5 })
```

```bash
# Via CLI
node index.mjs --recall "food preferences" --limit 5
```

### Check stats / 查看统计

```bash
node index.mjs --stats
# → 42 memories | 7 conversations | 3 active goals
```

---

## File Structure / 文件结构

```
memory/
├── index.mjs          # Core memory engine (store, recall, context building)
├── mcp-server.mjs     # MCP server (exposes tools to Claude)
├── schema.sql         # SQLite schema (memories, conversations, FTS5 tables)
├── chinatsu.db        # SQLite database (created on first run, gitignored)
└── lib/
    └── libsimple-*/   # Platform-specific tokenizer binary + dict
```

---

## Design Decisions / 设计决策

**Why SQLite over a vector database?**
For a single-agent personal memory system, SQLite FTS5 provides sufficient semantic recall without the operational overhead of a vector store. Embedding support can be layered on top (the schema includes a `content_vector` column) when needed.

**Why not store everything in markdown files?**
Markdown files can't be queried by importance, category, recency, or semantic similarity. They're fine as an index/pointer layer but not as the primary store.

**Why OR logic instead of AND for FTS queries?**
AND requires all extracted keywords to be present — too strict for natural language recall. OR with jieba segmentation provides much higher recall while jieba's word boundaries prevent false positives from single-character matching.

---

**为什么用 SQLite 而不是向量数据库？**
对单 Agent 个人记忆系统，SQLite FTS5 的语义召回已经足够，不需要向量库的运维开销。需要时可叠加 embedding（schema 中已预留 `content_vector` 列）。

**为什么不用 markdown 文件？**
Markdown 文件无法按重要性、分类、时间或语义相似度查询。适合做索引层，不适合做主存储。

**为什么 FTS 查询用 OR 而不是 AND？**
AND 要求所有关键词都存在——对自然语言查询太严格，召回率极低。jieba 分词 + OR 逻辑在保持较高精度的同时大幅提升召回率。

---

## References / 参考资料

[^1]: [moeru-ai/airi](https://github.com/moeru-ai/airi) — Memory architecture inspiration. The composite scoring model (importance × recency × relevance) is adapted from AIRI's memory design.

[^2]: [wangfenjin/simple](https://github.com/wangfenjin/simple) — A simple Chinese tokenizer for SQLite FTS5, based on cppjieba. Provides prebuilt binaries for Windows/macOS/Linux.

[^3]: Wang Fenjin, [《给 sqlite 数据库加上中文分词全文搜索的能力》](https://www.cnblogs.com/wangfenjin/p/14425659.html), 2021 — Detailed explanation of integrating jieba tokenization into SQLite FTS5.

[^4]: [SQLite FTS5 Extension](https://www.sqlite.org/fts5.html) — Official SQLite FTS5 documentation covering tokenizers, content tables, and BM25 ranking.

[^5]: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — Synchronous SQLite bindings for Node.js. Used for `loadExtension()` to load the native tokenizer.

[^6]: [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — The MCP server implementation uses `@modelcontextprotocol/sdk` with stdio transport.

---

## License / 许可证

MIT
