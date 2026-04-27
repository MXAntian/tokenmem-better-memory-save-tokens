# tokenmem

> **Save 80-90% memory-related token costs.** Persistent long-term memory for AI agents via MCP — on-demand recall instead of always-inject.  
> **Works with any MCP-compatible agent**: Claude Code, Cursor, Windsurf, Cline, Continue, and more.
> **Both stdio and HTTP transports supported** — HTTP recommended for multi-session use to avoid zombie process buildup.
>
> **节省 80-90% 记忆相关 token 开销。** 通过 MCP 为 AI Agent 提供持久化长期记忆——按需召回，不再每次都注入。  
> **适用于所有支持 MCP 的 AI Agent**：Claude Code、Cursor、Windsurf、Cline、Continue 等。  
> **同时支持 stdio 和 HTTP transport**——多 session 场景推荐 HTTP，避免僵尸进程堆积。

---

## The Problem: Memory Costs Tokens / 问题：记忆 = Token 开销

AI agents are stateless. The common fix is injecting a context file on every prompt — but that means you pay token costs on **every single message**, even when the agent already knows the answer.

AI Agent 是无状态的。常见方案是每条 prompt 都注入上下文文件——但这意味着**每一条消息都要消耗 token**，即使 Agent 已经知道答案。

**How much does this waste?**

| Approach | Token cost per message | 100 messages/day |
|----------|----------------------|------------------|
| Pre-injection (always inject) | ~2,000-5,000 tokens | 200K-500K tokens/day |
| **tokenmem (on-demand)** | **0 tokens (most messages)** | **~20K-50K tokens/day** |

Most prompts don't need historical memory. tokenmem lets the agent decide when to look things up — saving **80-90% of memory-related token costs**.

大多数 prompt 不需要历史记忆。tokenmem 让 Agent 自己决定何时查询——节省 **80-90% 的记忆相关 token 开销**。

---

## How It Works / 工作原理

```
┌────────────────────────────────────────────────┐
│           Any MCP-Compatible Agent             │
│      (Claude Code / Cursor / Windsurf / ...)   │
│                                                │
│  User prompt → "Do I already know this?"       │
│                     │                          │
│              ┌──────┴──────┐                   │
│              ↓ Yes         ↓ No                │
│         Answer directly    recall_memory()     │
│         (0 extra tokens)       ↓               │
│                          MCP Server            │
│                              ↓                 │
│                       SQLite + FTS5            │
│                       (tokenmem.db)              │
│                              ↓                 │
│                    ← ranked results            │
│                                                │
│  store_memory("important fact") → MCP Server   │
│                                      ↓         │
│                              INSERT INTO DB    │
└────────────────────────────────────────────────┘
```

**Three MCP tools exposed:**

| Tool | Purpose |
|------|---------|
| `recall_memory(query)` | Search memories by relevance (FTS5 + composite scoring) |
| `store_memory(content)` | Store a fact, decision, preference, or insight |
| `memory_stats()` | Get memory system statistics |

---

## Why MCP Makes This Universal / 为什么 MCP 让它通用

tokenmem is a standard **MCP server** using stdio transport. Any AI agent or IDE that supports the [Model Context Protocol](https://modelcontextprotocol.io/) can connect to it — no code changes needed.

tokenmem 是标准的 **MCP Server**（stdio 传输）。任何支持 [Model Context Protocol](https://modelcontextprotocol.io/) 的 AI Agent 或 IDE 都可以直接连接，无需改代码。

**Tested with / 已验证：**

| Agent | Setup |
|-------|-------|
| Claude Code | `claude mcp add --scope user tokenmem -- node /path/to/mcp-server.mjs` |
| Cursor | Add to `.cursor/mcp.json` |
| Windsurf | Add to MCP server config |
| Cline / Continue | Add to MCP settings |

The agent calls `recall_memory()` / `store_memory()` like any other MCP tool. Memory persists in a local SQLite file across all sessions.

Agent 像调用其他 MCP 工具一样调用 `recall_memory()` / `store_memory()`。记忆持久化在本地 SQLite 文件中，跨所有 session 可用。

---

## Features / 功能特性

### Memory Layers with Auto-Promotion / 记忆分层 + 自动晋升

| Layer | TTL | Auto-promotes when |
|-------|-----|--------------------|
| `working` | 6 hours | Accessed 3+ times or importance >= 7 |
| `short_term` | 7 days | Accessed 8+ times or importance >= 8 |
| `long_term` | No expiry | — |
| `permanent` | No expiry, no deletion | — |

Working memory expires automatically. Important memories get promoted to long-term storage based on access patterns — no manual curation needed.

### Composite Scoring / 复合打分

Recall results are ranked by:

```
score = FTS_relevance (40%) + importance (30%) + recency (20%) + access_frequency (10%)
```

Inspired by the [AIRI](https://github.com/moeru-ai/airi) memory architecture[^1]. Recent, important, frequently-accessed memories rank higher.

### 9 Memory Categories / 9 种分类

`general` · `people` · `project` · `decision` · `feedback` · `bug` · `relationship` · `skill` · `preference`

Filter recall by category for precision: `recall_memory({ query: "...", category: "preference" })`.

### Chinese Tokenization *(Optional)* / 中文分词（可选）

Built-in support for Chinese via [wangfenjin/simple](https://github.com/wangfenjin/simple)[^2] — a native SQLite extension using cppjieba for word-level segmentation. Falls back gracefully to character-level FTS5 if the extension isn't installed.

Includes stop-word filtering and AND→OR query rewriting for high recall without false positives.

**Non-Chinese users: skip this entirely.** The default FTS5 tokenizer works well for English and other languages.

### Optional Embedding Support / 可选向量支持

Set `EMBEDDING_API_BASE_URL` + `EMBEDDING_API_KEY` to enable OpenAI-compatible embeddings. The schema includes `content_vector` columns ready for cosine similarity search. Works without embeddings — FTS5 handles most recall needs.

### HTTP Transport (Recommended for Multi-Session) / HTTP 传输（多 session 推荐）

> **Added 2026-04**: tokenmem now supports both **stdio** (default, simple) and **HTTP Streamable** transport. HTTP is **strongly recommended** if you run multiple agent sessions concurrently.

**Why this matters / 为什么重要：**

With **stdio transport**, each agent session spawns its own `mcp-server.mjs` child process — they each open their own SQLite connection. Sessions don't always notify the server cleanly when they exit (the client just closes stdio and walks away), so child processes pile up. We've observed **13 zombie processes** in the wild after a few days of normal use, all fighting for the same SQLite WAL write lock. The result is the dreaded "MCP available → no longer available" flapping.

stdio 模式下每个 agent session 各 spawn 一个 `mcp-server.mjs` 子进程，各自持 SQLite 连接。session 退出时通常只断 stdio 不发信号，子进程不知道 client 死了 → 僵尸进程堆积（实测正常用几天积 13 个），它们争同一把 SQLite WAL 写锁 → MCP "available → unavailable" 反复跳。

**HTTP transport solves this structurally / HTTP 模式从结构上解决：**

| | stdio | HTTP |
|--|---|---|
| OS processes | N (one per session) | **1 (long-lived)** |
| SQLite connections | N (lock contention) | **1 (no contention)** |
| Restart on crash | manual | **client auto-reconnect (5× exp backoff)** |
| Cross-machine reuse | impossible | **change `url` and go** |
| Setup | trivial | one extra step (long-lived process) |

**Start the HTTP server:**

```bash
node mcp-server.mjs --transport=http --port=18792
# Listening on http://127.0.0.1:18792/mcp
# Health: http://127.0.0.1:18792/health
```

The server **only binds to 127.0.0.1** (per [MCP spec](https://modelcontextprotocol.io/specification/draft/basic/transports#security-warning) to prevent DNS rebinding) and validates the `Origin` header.

**Connect from your agent:**

```json
{
  "mcpServers": {
    "tokenmem": {
      "type": "http",
      "url": "http://127.0.0.1:18792/mcp"
    }
  }
}
```

Or via Claude Code CLI:
```bash
claude mcp add --scope user --transport http tokenmem http://127.0.0.1:18792/mcp
```

**Keep the server alive across reboots:** add a startup task (Windows: `schtasks`; macOS: `launchd`; Linux: `systemd --user`) pointing at:

```bash
node /absolute/path/to/tokenmem/mcp-server.mjs --transport=http --port=18792
```

**Health check from a hook / shell:**

```bash
curl -s http://127.0.0.1:18792/health
# {"ok":true,"server":"chinatsu-memory","version":"1.1.0","transport":"http","active_sessions":3}
```

The HTTP transport uses **stateful per-session mode** internally (each agent gets a `Mcp-Session-Id`-keyed transport in an in-process Map) — this is required by the MCP SDK's design (one `Server` instance per transport). All sessions share the same OS process, the same SQLite connection, and the same loaded extensions. The per-session JS objects are a few KB each, no extra processes, no extra locks.

---

## Quick Start / 快速开始

### Prerequisites

- Node.js 18+
- Any MCP-compatible AI agent

### Install / 安装

```bash
git clone https://github.com/MXAntian/tokenmem.git
cd tokenmem
npm install
```

### Initialize / 初始化

```bash
node index.mjs --stats
# Creates tokenmem.db on first run
```

### Connect to Your Agent / 连接到你的 Agent

**Claude Code:**
```bash
claude mcp add --scope user tokenmem -- node /absolute/path/to/tokenmem/mcp-server.mjs
```

**Cursor / Windsurf / Other MCP clients:**
```json
{
  "mcpServers": {
    "tokenmem": {
      "command": "node",
      "args": ["/absolute/path/to/tokenmem/mcp-server.mjs"]
    }
  }
}
```

### Add Agent Instructions / 添加 Agent 指令

Add to your agent's system instructions (e.g., `CLAUDE.md`, `.cursorrules`, etc.):

```markdown
## Memory System (tokenmem MCP)

You have access to a persistent memory database via the `tokenmem` MCP server:
- `recall_memory(query, limit?, category?)` — retrieve relevant memories
- `store_memory(content, summary?, importance?, memory_type?, category?, tags?)` — store important info
- `memory_stats()` — view statistics

### When to call recall_memory
**Check context first. Only query when context doesn't contain a confident answer.**

Must call:
- User asks about personal preferences, habits, past work
- User references people, relationships, project history
- Context doesn't have a confident answer

Skip:
- Current context already has the answer
- Pure technical question unrelated to stored knowledge
- Already queried the same topic in this session
```

---

## CLI Usage / 命令行

tokenmem also works as a standalone CLI tool — useful for hooks, scripts, and debugging:

```bash
# Check stats
node index.mjs --stats

# Recall memories
node index.mjs --recall "food preferences" --limit 5

# Store a memory
node index.mjs --store "User prefers dark mode" --importance 7 --type long_term --category preference

# Build context for injection (useful in hooks)
node index.mjs --context "current project status" --limit 10
```

---

## File Structure / 文件结构

```
tokenmem/
├── mcp-server.mjs     # MCP server entry point (stdio transport)
├── index.mjs          # Core engine: store, recall, scoring, layers
├── schema.sql         # SQLite schema (memories, conversations, FTS5)
├── package.json       # 3 dependencies only
├── tokenmem.db        # SQLite database (auto-created, gitignored)
└── lib/               # Optional: Chinese tokenizer binary + dict
```

**~1,000 lines of code. 3 dependencies. No build step.**

---

## Design Decisions / 设计决策

**Why SQLite, not a vector database?**  
For personal agent memory, FTS5 provides sufficient semantic recall without operational overhead. Embedding support is ready when needed (`content_vector` column exists).

**Why on-demand, not pre-injection?**  
Pre-injection wastes tokens on every message. On-demand lets the agent skip the lookup when it already has the answer — which is most of the time.

**Why MCP, not a custom API?**  
MCP is the emerging standard for agent-tool communication. One implementation works across Claude Code, Cursor, Windsurf, and any future MCP-compatible agent.

---

**为什么用 SQLite？** 对个人 Agent 记忆，FTS5 的语义召回足够用，不需要向量库的运维成本。

**为什么按需召回？** 预注入每条消息都浪费 token。按需让 Agent 跳过不需要的查询——大多数时候都不需要。

**为什么用 MCP？** MCP 是 Agent 工具通信的新兴标准。一次实现，跨所有 MCP 兼容 Agent 使用。

---

## References / 参考资料

[^1]: [moeru-ai/airi](https://github.com/moeru-ai/airi) — Memory architecture inspiration (composite scoring model).

[^2]: [wangfenjin/simple](https://github.com/wangfenjin/simple) — Chinese tokenizer for SQLite FTS5 (cppjieba-based, prebuilt binaries available).

[^3]: [SQLite FTS5](https://www.sqlite.org/fts5.html) — Full-text search extension with BM25 ranking.

[^4]: [Model Context Protocol](https://modelcontextprotocol.io/) — The standard for agent-tool communication.

---

## License / 许可证

MIT
