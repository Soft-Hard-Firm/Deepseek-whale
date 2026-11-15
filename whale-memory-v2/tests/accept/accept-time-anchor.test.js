// 验收用例：时间锚点（这件事什么时候发生的，不是什么时候写的）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { parseTime } from '../../lib/model.js'
import { parseBlocks } from '../../lib/ingest.js'
import { renderEntry } from '../../lib/inject.js'

const NOW = Date.parse('2026-11-16T00:10:00+08:00')
const DAY = 86400000
const OLD = Date.parse('2026-10-17T00:19:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-anchor-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('remember 的 at 决定 createdAt，而不是写入时刻', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '主人那天说要去杭州', at: '2026-10-17' })
  assert.equal(r.ok, true)

  const e = store.readAll().entries[0]
  assert.notEqual(e.createdAt, NOW, '不该是写入时刻')
  assert.equal(new Date(e.createdAt).getMonth(), 9, '应该是 10 月')
})

test('不给 at 时仍然是写入时刻（旧行为不变）', () => {
  const { store, tools } = fresh()
  tools.remember({ text: '主人喜欢蓝色' })
  assert.equal(store.readAll().entries[0].createdAt, NOW)
})

test('明显在未来的 at 被拒，防止把秒当毫秒', () => {
  const { tools } = fresh()
  const r = tools.remember({ text: '未来的事', at: NOW + 3 * DAY })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_time')
})

test('parseTime 认三种写法', () => {
  assert.equal(parseTime('2026-10-17'), new Date(2026, 9, 17).getTime())
  assert.equal(parseTime('2026-10-17T00:19:00+08:00'), OLD)
  assert.equal(parseTime(OLD), OLD)
  assert.equal(parseTime('不是时间'), undefined)
  assert.equal(parseTime(''), undefined)
})

test('时间锚点让注入的相对时间正确', () => {
  const { store, tools } = fresh()
  tools.remember({ text: '那天定下的方案', at: OLD })

  const e = store.readAll().entries[0]
  const line = renderEntry(e, { now: NOW })
  // NOW 与 OLD 差 30 天，渲染应说「1 个月前」而不是「今天」
  assert.ok(/月|天/.test(line), `应该是过去时间：${line}`)
  assert.ok(!line.includes('今天'), '不该显示成今天')
})

// ── 流水线 ────────────────────────────────────────────

function makeSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-anchor-sess-'))
  const sdir = path.join(root, '--E-work--', 'session-a')
  fs.mkdirSync(sdir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'a', createdAt: OLD }),
    JSON.stringify({
      type: 'user/message',
      time: OLD,
      data: { content: [{ type: 'text', text: '我明天要去杭州' }] },
    }),
  ]
  fs.writeFileSync(
    path.join(sdir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')),
  )
  return root
}

test('块头 at= 生效：导入的历史条目不是「今天」', async () => {
  const sessionsDir = makeSessions()
  const { store, tools } = fresh()
  await tools.ingest({ sessionsDir })

  const commit = tools.ingestCommit({
    block: `<<<记忆 layer=user at=2026-10-17>>>\n- 我明天要去杭州\n<<<账本>>>\n{"已整理到":"2026-10-17"}`,
  })
  assert.equal(commit.ok, true)
  assert.equal(commit.added, 1)

  const e = store.readAll().entries[0]
  assert.notEqual(e.createdAt, NOW, '导入的历史条目不该记成写入当天')
  assert.equal(new Date(e.createdAt).getDate(), 17)
})

test('块头没给 at 时，用这批会话的时间兜底', async () => {
  const sessionsDir = makeSessions()
  const { store, tools } = fresh()
  await tools.ingest({ sessionsDir })

  tools.ingestCommit({
    block: `<<<记忆 layer=user>>>\n- 我明天要去杭州\n<<<账本>>>\n{"已整理到":"2026-10-17"}`,
  })

  const e = store.readAll().entries[0]
  assert.notEqual(e.createdAt, NOW, '不该是写入当天，应该是会话那天')
  assert.equal(new Date(e.createdAt).getDate(), 17)
})

test('parseBlocks 把块头的 at 变成 createdAt', () => {
  const r = parseBlocks('<<<记忆 layer=user at=2026-10-17>>>\n- 内容')
  assert.equal(r.items.length, 1)
  assert.equal(new Date(r.items[0].createdAt).getDate(), 17)
})

test('压缩计时用锚点时间：导入的老条目不会被当成新的', async () => {
  const sessionsDir = makeSessions()
  const { store, tools } = fresh()
  await tools.ingest({ sessionsDir })
  tools.ingestCommit({
    block: `<<<记忆 layer=user at=2026-09-01>>>\n- 很久以前定下的规矩\n<<<账本>>>\n{"已整理到":"2026-10-17"}`,
  })

  // 9 月 1 日距 NOW 已远超 21 天，维护一次就应该被压
  const r = tools.maintain({})
  assert.equal(r.ok, true)
  assert.ok(r.changed >= 1, '老条目该被压缩，说明计时用的是锚点不是写入时刻')
  // 具体压到几级取决于锚点距现在多久，不该写死数字
  assert.ok(
    store.readAll().entries[0].compressionLevel >= 1,
    '压过就说明计时用的是锚点，不是写入时刻',
  )
})
