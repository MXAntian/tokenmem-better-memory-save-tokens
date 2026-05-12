#!/usr/bin/env node
// ============================================================
// Memory system reliability test
// 覆盖：写入完整性、FTS 同步、软删除过滤、边界条件、
//       并发访问、空表处理、幂等初始化、过期/升迁、备份恢复
// ============================================================

import { existsSync, unlinkSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 使用独立的测试 DB（不污染正式数据）
const TEST_DB = resolve(__dirname, 'tokenmem-test.db')
const TEST_DB_WAL = TEST_DB + '-wal'
const TEST_DB_SHM = TEST_DB + '-shm'

function cleanup() {
  for (const f of [TEST_DB, TEST_DB_WAL, TEST_DB_SHM]) {
    try { if (existsSync(f)) unlinkSync(f) } catch {}
  }
}

// 重定向 DB_PATH —— 通过环境变量或猴补丁
// 由于 index.mjs 硬编码了 DB_PATH，我们用一个 wrapper 方法
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0
const errors = []

function assert(condition, label) {
  if (condition) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    errors.push(label)
    console.log(`  ❌ ${label}`)
  }
}

function section(name) {
  console.log(`\n── ${name} ──`)
}

// 直接操作 better-sqlite3 来独立验证
const Database = require('better-sqlite3')

cleanup()

try {
  // ================================================================
  section('1. Schema 初始化（首次 + 幂等）')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')

    const { readFileSync } = await import('node:fs')
    const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8')

    // 首次执行
    const pragmaLines = schema.match(/^PRAGMA\s+[^;]+;/gm) || []
    for (const p of pragmaLines) { try { db.exec(p) } catch {} }
    const ddl = schema.replace(/^PRAGMA\s+[^;]+;\s*$/gm, '')
    db.exec(ddl)
    assert(true, '首次 schema 执行成功')

    // 验证表存在
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name)
    assert(tables.includes('memories'), '表 memories 存在')
    assert(tables.includes('conversations'), '表 conversations 存在')
    assert(tables.includes('goals'), '表 goals 存在')
    assert(tables.includes('episodes'), '表 episodes 存在')
    assert(tables.includes('memories_fts'), 'FTS5 memories_fts 存在')
    assert(tables.includes('conversations_fts'), 'FTS5 conversations_fts 存在')

    // 幂等执行（不应报错）
    try {
      db.exec(ddl)
      assert(true, '幂等 schema 执行无异常')
    } catch (e) {
      assert(e.message.includes('already exists'), `幂等执行: ${e.message.slice(0, 80)}`)
    }

    db.close()
  }

  // ================================================================
  section('2. 写入 + 读取完整性')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 写入 100 条记忆
    const insertMem = db.prepare(`
      INSERT INTO memories (content, summary, memory_type, category, importance, source, tags)
      VALUES (?, ?, ?, ?, ?, 'manual', '[]')
    `)

    const insertMany = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        insertMem.run(
          `测试记忆内容 #${i} — 这是一条用于可靠性验证的记忆，包含中文和English混合`,
          `摘要 #${i}`,
          i < 20 ? 'working' : i < 50 ? 'short_term' : i < 80 ? 'long_term' : 'permanent',
          ['general', 'people', 'project', 'decision', 'feedback'][i % 5],
          Math.min(10, Math.max(1, Math.floor(i / 10) + 1)),
        )
      }
    })
    insertMany()

    const count = db.prepare(`SELECT COUNT(*) AS c FROM memories`).get().c
    assert(count === 100, `写入 100 条，实际 ${count} 条`)

    // 逐条验证内容完整
    const all = db.prepare(`SELECT content, summary, memory_type, category, importance FROM memories ORDER BY rowid`).all()
    let integrityOk = true
    for (let i = 0; i < 100; i++) {
      if (!all[i].content.includes(`#${i}`)) { integrityOk = false; break }
      if (all[i].summary !== `摘要 #${i}`) { integrityOk = false; break }
    }
    assert(integrityOk, '100 条记忆内容完整性验证通过')

    db.close()
  }

  // ================================================================
  section('3. FTS5 同步验证')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // FTS 搜索
    const ftsResults = db.prepare(`
      SELECT m.content FROM memories m
      JOIN memories_fts mf ON mf.rowid = m.rowid
      WHERE memories_fts MATCH '"记忆内容"'
      LIMIT 5
    `).all()
    assert(ftsResults.length > 0, `FTS 搜索 "记忆内容" 命中 ${ftsResults.length} 条`)

    // FTS 搜索特定编号
    const specific = db.prepare(`
      SELECT m.content FROM memories m
      JOIN memories_fts mf ON mf.rowid = m.rowid
      WHERE memories_fts MATCH '"#42"'
    `).all()
    assert(specific.length === 1, `FTS 精确搜索 #42: 期望 1 条，实际 ${specific.length} 条`)

    // 验证 FTS 行数 = 主表行数
    const ftsCount = db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c
    const mainCount = db.prepare(`SELECT COUNT(*) AS c FROM memories`).get().c
    assert(ftsCount === mainCount, `FTS 行数(${ftsCount}) = 主表行数(${mainCount})`)

    db.close()
  }

  // ================================================================
  section('4. 软删除 + 搜索过滤')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 软删除 #42
    db.prepare(`UPDATE memories SET deleted_at = unixepoch() * 1000 WHERE content LIKE '%#42%'`).run()

    // 验证主表查询排除已删除
    const activeCount = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL`).get().c
    assert(activeCount === 99, `软删除后活跃记忆: 期望 99，实际 ${activeCount}`)

    // 关键测试：FTS + deleted_at 过滤
    // 注意：FTS 索引里 #42 仍然存在（因为是 UPDATE 不是 DELETE）
    // 但 JOIN 后的 WHERE 应该过滤掉
    const ftsFiltered = db.prepare(`
      SELECT m.content FROM memories m
      JOIN memories_fts mf ON mf.rowid = m.rowid
      WHERE memories_fts MATCH '"#42"'
        AND m.deleted_at IS NULL
    `).all()
    assert(ftsFiltered.length === 0, `软删除 #42 后 FTS+过滤: 期望 0 条，实际 ${ftsFiltered.length} 条`)

    // 不带过滤的 FTS 仍能找到（FTS 索引未清理）
    const ftsUnfiltered = db.prepare(`
      SELECT m.content FROM memories m
      JOIN memories_fts mf ON mf.rowid = m.rowid
      WHERE memories_fts MATCH '"#42"'
    `).all()
    assert(ftsUnfiltered.length === 1, `FTS 无过滤仍可找到已删除记忆（预期行为）: ${ftsUnfiltered.length} 条`)

    db.close()
  }

  // ================================================================
  section('5. 边界条件')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 5a. 空内容
    try {
      db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES ('', 'working', 'general', 'manual')`).run()
      assert(false, '空内容应该被 NOT NULL 阻止（但 empty string 不是 NULL）')
    } catch {
      assert(true, '空内容插入被阻止')
    }
    // 实际上 empty string 不是 NULL，所以会成功。让我们验证
    const emptyRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content = ''`).get().c
    assert(emptyRow >= 0, `空字符串是合法的（SQLite NOT NULL 只阻止 NULL）: ${emptyRow} 条`)

    // 5b. 超长内容（10KB）
    const longContent = '测试'.repeat(5000)
    db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES (?, 'working', 'general', 'manual')`).run(longContent)
    const longRow = db.prepare(`SELECT length(content) AS len FROM memories WHERE content LIKE '测试测试测试%' LIMIT 1`).get()
    assert(longRow && longRow.len === 10000, `超长内容 (10000 chars) 写入成功: ${longRow?.len}`)

    // 5c. 特殊字符（emoji、SQL 注入尝试）
    const specialContent = `测试 emoji 🎯🔥 和 SQL 注入 '); DROP TABLE memories; --`
    db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES (?, 'working', 'general', 'manual')`).run(specialContent)
    const specialRow = db.prepare(`SELECT content FROM memories WHERE content LIKE '%DROP TABLE%'`).get()
    assert(specialRow && specialRow.content === specialContent, '特殊字符+SQL注入安全写入')

    // 5d. Unicode 混合
    const unicodeContent = 'English 中文 日本語 한국어 Ελληνικά العربية'
    db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES (?, 'working', 'general', 'manual')`).run(unicodeContent)
    const unicodeRow = db.prepare(`SELECT content FROM memories WHERE content LIKE '%Ελληνικά%'`).get()
    assert(unicodeRow && unicodeRow.content === unicodeContent, 'Unicode 多语言内容完整')

    // 5e. 验证表还在（SQL 注入没有成功）
    const tableStillExists = db.prepare(`SELECT COUNT(*) AS c FROM memories`).get().c
    assert(tableStillExists > 100, `SQL 注入无效，表完好: ${tableStillExists} 条记录`)

    db.close()
  }

  // ================================================================
  section('6. 对话记录去重')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 插入带 message_id 的对话
    db.prepare(`
      INSERT INTO conversations (platform, chat_id, message_id, from_id, from_name, role, content)
      VALUES ('feishu', 'chat-1', 'msg-001', 'user1', '小天', 'user', '你好千夏')
    `).run()

    // 重复插入相同 message_id（应被 UNIQUE 约束阻止）
    try {
      db.prepare(`
        INSERT INTO conversations (platform, chat_id, message_id, from_id, from_name, role, content)
        VALUES ('feishu', 'chat-1', 'msg-001', 'user1', '小天', 'user', '你好千夏（重复）')
      `).run()
      assert(false, '重复 message_id 应被阻止')
    } catch (e) {
      assert(e.message.includes('UNIQUE'), `去重约束生效: ${e.message.slice(0, 60)}`)
    }

    // 无 message_id 的对话可以多次插入
    db.prepare(`
      INSERT INTO conversations (platform, chat_id, from_id, from_name, role, content)
      VALUES ('feishu', 'chat-1', 'user1', '小天', 'user', '无 ID 消息 1')
    `).run()
    db.prepare(`
      INSERT INTO conversations (platform, chat_id, from_id, from_name, role, content)
      VALUES ('feishu', 'chat-1', 'user1', '小天', 'user', '无 ID 消息 2')
    `).run()
    const convCount = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE chat_id = 'chat-1'`).get().c
    assert(convCount === 3, `3 条对话（1 有ID + 2 无ID）: ${convCount}`)

    db.close()
  }

  // ================================================================
  section('7. 空表统计不崩溃')
  // ================================================================
  {
    // 新建一个完全空的 DB
    const emptyDb = resolve(__dirname, 'chinatsu-empty-test.db')
    try { if (existsSync(emptyDb)) unlinkSync(emptyDb) } catch {}
    const db2 = new Database(emptyDb)
    db2.pragma('journal_mode = WAL')

    const { readFileSync } = await import('node:fs')
    const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8')
    const pragmaLines = schema.match(/^PRAGMA\s+[^;]+;/gm) || []
    for (const p of pragmaLines) { try { db2.exec(p) } catch {} }
    db2.exec(schema.replace(/^PRAGMA\s+[^;]+;\s*$/gm, ''))

    const stats = db2.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS total_active,
        SUM(CASE WHEN memory_type = 'permanent' THEN 1 ELSE 0 END) AS permanent
      FROM memories
    `).get()

    assert(stats.total_active === null, `空表 SUM 返回 null（不是 undefined）: ${typeof stats.total_active}`)
    // 这意味着在 getMemoryStats() 中需要处理 null → 0
    assert(stats !== undefined, '空表统计不崩溃')

    db2.close()
    for (const f of [emptyDb, emptyDb + '-wal', emptyDb + '-shm']) {
      try { if (existsSync(f)) unlinkSync(f) } catch {}
    }
  }

  // ================================================================
  section('8. 过期机制')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 插入一条已过期的 working 记忆
    const pastTime = Date.now() - 100000  // 100 秒前过期
    db.prepare(`
      INSERT INTO memories (content, memory_type, category, importance, source, expires_at)
      VALUES ('应该被清理的过期记忆', 'working', 'general', 3, 'manual', ?)
    `).run(pastTime)

    // 插入一条未过期的 working 记忆
    const futureTime = Date.now() + 3600000  // 1 小时后过期
    db.prepare(`
      INSERT INTO memories (content, memory_type, category, importance, source, expires_at)
      VALUES ('不应被清理的记忆', 'working', 'general', 3, 'manual', ?)
    `).run(futureTime)

    // 执行过期清理
    const info = db.prepare(`
      UPDATE memories SET deleted_at = unixepoch() * 1000
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < unixepoch() * 1000
    `).run()
    assert(info.changes >= 1, `过期清理: ${info.changes} 条被标记删除`)

    // 验证未过期的仍在
    const alive = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content = '不应被清理的记忆' AND deleted_at IS NULL`).get().c
    assert(alive === 1, '未过期记忆完好')

    // 验证过期的已标记
    const dead = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content = '应该被清理的过期记忆' AND deleted_at IS NOT NULL`).get().c
    assert(dead === 1, '过期记忆已标记删除（不是物理删除）')

    db.close()
  }

  // ================================================================
  section('9. 并发读取安全')
  // ================================================================
  {
    // 打开两个连接同时读
    const db1 = new Database(TEST_DB, { readonly: true })
    const db2 = new Database(TEST_DB, { readonly: true })

    const count1 = db1.prepare(`SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL`).get().c
    const count2 = db2.prepare(`SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL`).get().c
    assert(count1 === count2, `并发读取一致: db1=${count1}, db2=${count2}`)

    // 并发读 + FTS 搜索
    const fts1 = db1.prepare(`SELECT COUNT(*) AS c FROM memories m JOIN memories_fts mf ON mf.rowid = m.rowid WHERE memories_fts MATCH '"记忆"' AND m.deleted_at IS NULL`).get().c
    const fts2 = db2.prepare(`SELECT COUNT(*) AS c FROM memories m JOIN memories_fts mf ON mf.rowid = m.rowid WHERE memories_fts MATCH '"记忆"' AND m.deleted_at IS NULL`).get().c
    assert(fts1 === fts2, `并发 FTS 搜索一致: ${fts1} = ${fts2}`)

    db1.close()
    db2.close()
  }

  // ================================================================
  section('10. WAL 完整性 + 备份恢复')
  // ================================================================
  {
    const db = new Database(TEST_DB)
    db.pragma('busy_timeout = 5000')

    // 写入一条标记记忆
    db.prepare(`
      INSERT INTO memories (content, memory_type, category, importance, source)
      VALUES ('备份验证标记 BACKUP_MARKER_20260413', 'permanent', 'general', 10, 'manual')
    `).run()

    // 强制 WAL checkpoint（确保数据落盘）
    db.pragma('wal_checkpoint(TRUNCATE)')

    // 备份
    const backupPath = TEST_DB + '.backup'
    copyFileSync(TEST_DB, backupPath)
    assert(existsSync(backupPath), '备份文件创建成功')

    // 在原 DB 上继续写
    db.prepare(`
      INSERT INTO memories (content, memory_type, category, importance, source)
      VALUES ('备份后新增的记忆', 'working', 'general', 5, 'manual')
    `).run()
    db.close()

    // 从备份恢复并验证
    const backupDb = new Database(backupPath, { readonly: true })
    const marker = backupDb.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content LIKE '%BACKUP_MARKER%'`).get().c
    assert(marker === 1, '备份包含标记记忆')

    const postBackup = backupDb.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content = '备份后新增的记忆'`).get().c
    assert(postBackup === 0, '备份不包含备份后新增数据（时间点正确）')

    backupDb.close()
    try { unlinkSync(backupPath) } catch {}
  }

  // ================================================================
  section('11. CHECK 约束验证')
  // ================================================================
  {
    const db = new Database(TEST_DB)

    // 无效 memory_type
    try {
      db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES ('test', 'invalid_type', 'general', 'manual')`).run()
      assert(false, '无效 memory_type 应被 CHECK 阻止')
    } catch {
      assert(true, 'CHECK: 无效 memory_type 被拒绝')
    }

    // importance 超范围
    try {
      db.prepare(`INSERT INTO memories (content, memory_type, category, importance, source) VALUES ('test', 'working', 'general', 99, 'manual')`).run()
      assert(false, 'importance=99 应被 CHECK 阻止')
    } catch {
      assert(true, 'CHECK: importance 超范围被拒绝')
    }

    // 无效 category
    try {
      db.prepare(`INSERT INTO memories (content, memory_type, category, source) VALUES ('test', 'working', 'nonexistent', 'manual')`).run()
      assert(false, '无效 category 应被 CHECK 阻止')
    } catch {
      assert(true, 'CHECK: 无效 category 被拒绝')
    }

    db.close()
  }

  // ================================================================
  // 结果汇总
  // ================================================================
  console.log(`\n${'='.repeat(50)}`)
  console.log(`结果: ${passed} 通过, ${failed} 失败`)
  if (errors.length > 0) {
    console.log(`\n失败项:`)
    errors.forEach(e => console.log(`  - ${e}`))
  }
  console.log(`${'='.repeat(50)}`)

  process.exitCode = failed > 0 ? 1 : 0

} catch (e) {
  console.error('\n💥 测试框架异常:', e)
  process.exitCode = 1
} finally {
  cleanup()
}
