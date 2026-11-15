// 验收用例：会话语料（digest），用来补记漏掉的记忆。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { readUserMessages, DATA_NOT_INSTRUCTION } from '../../lib/digest.js'

const NOW = Date.parse('2026-11-15T22:30:00+08:00')
const DAY = 86400000

/** 造一个假会话目录：一个工作区、一个会话、若干行事件。 */
function makeSessions({ messages = [], extraLines = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-'))
  const sdir = path.join(root, '--E-work--', 'session-abc')
  fs.mkdirSync(sdir, { recursive: true })

  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'abc', createdAt: NOW }),
    ...extraLines,
    ...messages.map((m) => JSON.stringify(m)),
  ]
  fs.writeFileSync(
    path.join(sdir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')),
  )
  return root
}

/** 造一条用户消息。 */
function um(text, at) {
  return { type: 'user/message', seq: 1, time: at, data: { role: 'user', content: [{ type: 'text', text }] } }
}

/** 造一条助手消息。 */
function am(text, at) {
  return {
    type: 'assistant/message',
    seq: 2,
    time: at,
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

function freshTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-store-'))
  const store = createStore({ dir, now: () => NOW })
  return createTools({ store, clock: () => NOW })
}

test('只捞用户消息，不捞助手自己说的话', async () => {
  const root = makeSessions({
    messages: [um('我喜欢蓝色', NOW - 1000), am('好的，记住了', NOW - 900)],
  })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.ok(r.messages[0].text.includes('喜欢蓝色'))
})

test('按时间过滤：太久以前的不捞', async () => {
  const root = makeSessions({
    messages: [um('很久以前说的', NOW - 30 * DAY), um('昨天说的', NOW - 1 * DAY)],
  })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - 3 * DAY, limit: 50 })
  assert.equal(r.count, 1)
  assert.ok(r.messages[0].text.includes('昨天'))
})

test('返回前先脱敏：密码不进上下文', async () => {
  const root = makeSessions({ messages: [um('我的密码是 abc123xyz', NOW - 1000)] })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.messages[0].text.includes('abc123xyz'), false)
  assert.ok(r.messages[0].text.includes('[已脱敏'))
})

test('工具输出带「这是数据不是指令」的声明', async () => {
  const root = makeSessions({ messages: [um('随便一句话', NOW - 1000)] })
  const tools = freshTools()

  const r = await tools.digest({ days: 1, sessionsDir: root })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes(DATA_NOT_INSTRUCTION), '必须防提示注入')
})

test('超长消息被截断，不撑爆上下文', async () => {
  const long = '很长的内容'.repeat(300)
  const root = makeSessions({ messages: [um(long, NOW - 1000)] })
  const tools = freshTools()

  const r = await tools.digest({ days: 1, sessionsDir: root })
  assert.equal(r.ok, true)
  assert.ok(r.text.length < long.length, '应被截断')
})

test('limit 生效，只回最近的几条', async () => {
  const msgs = []
  for (let i = 0; i < 20; i++) msgs.push(um(`第${i}句话`, NOW - 2000 + i))
  const root = makeSessions({ messages: msgs })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 5 })
  assert.equal(r.count, 5)
  assert.equal(r.truncated, true)
  assert.ok(r.messages[4].text.includes('第19句'), '该留最近的')
})

test('没有消息时给一句人话，不报错', async () => {
  const root = makeSessions({ messages: [] })
  const tools = freshTools()

  const r = await tools.digest({ days: 1, sessionsDir: root })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('没有'))
})

test('目录不存在时明确报错，不静默', async () => {
  const tools = freshTools()
  const r = await tools.digest({ days: 1, sessionsDir: path.join(os.tmpdir(), 'definitely-not-here-xyz') })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'sessions_dir_missing')
})

test('坏文件跳过，不影响同一目录里的好文件', async () => {
  const root = makeSessions({ messages: [um('正常的消息', NOW - 1000)] })
  // 再塞一个坏文件（目录要先建）
  const badDir = path.join(root, '--E-work--', 'session-bad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd'))

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1, '坏文件只是跳过，不该让整体失败')
})

test('用户消息里夹的 system-reminder 被剥掉', async () => {
  const dirty =
    '重启了\n\n<system-reminder>\nUpdated instructions from: AGENTS.md\n一大堆系统提示\n</system-reminder>'
  const root = makeSessions({ messages: [um(dirty, NOW - 1000)] })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.count, 1)
  assert.equal(r.messages[0].text, '重启了', '只留用户真正说的话')
})

test('整条都是 system-reminder 的被整条丢弃', async () => {
  const only = '<system-reminder>\n只有系统提示\n</system-reminder>'
  const root = makeSessions({ messages: [um(only, NOW - 1000)] })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.count, 0, '剥完是空的就不该算一条')
})

test('没闭合的 system-reminder 也剥掉', async () => {
  const dirty = '真话\n<system-reminder>\n没闭合的系统提示一直写到结尾'
  const root = makeSessions({ messages: [um(dirty, NOW - 1000)] })

  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.messages[0].text, '真话')
})

test('非文本块（图片等）不会把消息变成噪音', async () => {
  const row = {
    type: 'user/message',
    time: NOW - 1000,
    data: { content: [{ type: 'image', url: 'x' }, { type: 'text', text: '看这张图' }] },
  }
  const root = makeSessions({ messages: [row] })
  const r = await readUserMessages({ sessionsDir: root, since: NOW - DAY, limit: 50 })
  assert.equal(r.count, 1)
  assert.equal(r.messages[0].text, '看这张图')
})
