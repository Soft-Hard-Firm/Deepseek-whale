// 验收用例：拾取流水线（ingest / ingest_commit）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import {
  parseBlocks,
  parseAttrs,
  groupByDay,
  pickNextBatch,
  dayKey,
  MAX_BATCH_MESSAGES,
} from '../../lib/ingest.js'

const NOW = Date.parse('2026-11-15T23:30:00+08:00')
const DAY = 86400000

// ── 纯函数 ────────────────────────────────────────────

test('解析属性：layer / project / alpha / beta', () => {
  const a = parseAttrs(' layer=rule project=记忆系统 alpha=0.9 beta=1 ')
  assert.equal(a.layer, 'rule')
  assert.equal(a.project, '记忆系统')
  assert.equal(a.alpha, '0.9')
  assert.equal(a.beta, '1')
})

test('属性值带引号也能解析', () => {
  const a = parseAttrs(' layer=user project="我的 项目"')
  assert.equal(a.project, '我的 项目')
})

test('解析单个块', () => {
  const block = [
    '<<<记忆 layer=rule project=记忆系统 alpha=0.9 beta=1>>>',
    '- 改主意要说清三步',
    '- 不确定就不记',
    '<<<账本>>>',
    '{"已整理到":"2026-11-14"}',
  ].join('\n')

  const r = parseBlocks(block)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].text, '改主意要说清三步')
  // 旧层名 rule 会被映射到 knowledge —— 模型照着文档老例子写也能收
  assert.equal(r.items[0].layer, 'knowledge')
  assert.equal(r.items[0].project, '记忆系统')
  assert.equal(r.errors.length, 0)
  assert.equal(r.ledger['已整理到'], '2026-11-14')
})

test('多个块共享各自的头部属性', () => {
  const block = [
    '<<<记忆 layer=user>>>',
    '- 喜欢吃辣',
    '<<<记忆 layer=project project=X>>>',
    '- 这个项目用 pnpm',
  ].join('\n')

  const r = parseBlocks(block)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].layer, 'user')
  assert.equal(r.items[1].layer, 'project')
  assert.equal(r.items[1].project, 'X')
})

test('块头缺 layer 时报错但不崩，后续块照常', () => {
  const block = [
    '<<<记忆 project=X>>>',
    '- 这条该被跳过',
    '<<<记忆 layer=user>>>',
    '- 这条该留下',
  ].join('\n')

  const r = parseBlocks(block)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].text, '这条该留下')
  assert.ok(r.errors.some((e) => e.includes('缺 layer')))
})

test('层名非法时报错', () => {
  const r = parseBlocks('<<<记忆 layer=bogus>>>\n- 内容')
  assert.equal(r.items.length, 0)
  assert.ok(r.errors.some((e) => e.includes('层名非法')))
})

test('账本不是 JSON 时报错但不崩', () => {
  const r = parseBlocks('<<<记忆 layer=user>>>\n- 内容\n<<<账本>>>\n{坏掉的')
  assert.equal(r.items.length, 1)
  assert.ok(r.errors.some((e) => e.includes('账本')))
})

test('块里的隐私会被脱敏', () => {
  const r = parseBlocks('<<<记忆 layer=user>>>\n- 密码是 abc123xyz')
  assert.equal(r.items[0].text.includes('abc123xyz'), false)
})

test('块里的注入内容会被剥掉', () => {
  const r = parseBlocks('<<<记忆 layer=user>>>\n- ## 长期记忆（自动带上）')
  assert.equal(r.items.length, 0, '剥完是空的就不该收')
})

test('按天分组', () => {
  const msgs = [
    { at: Date.parse('2026-11-14T10:00:00+08:00'), text: 'a' },
    { at: Date.parse('2026-11-14T18:00:00+08:00'), text: 'b' },
    { at: Date.parse('2026-11-15T09:00:00+08:00'), text: 'c' },
  ]
  const days = groupByDay(msgs)
  assert.equal(days.length, 2)
  assert.equal(days[0].day, '2026-11-14')
  assert.equal(days[0].messages.length, 2)
  assert.equal(days[1].day, '2026-11-15')
})

test('pickNextBatch 从时间戳之后接着取', () => {
  const msgs = [{ at: 1, text: 'x' }, { at: 2, text: 'y' }]
  const b = pickNextBatch(msgs, 1)
  assert.deepEqual(b.messages.map((m) => m.text), ['y'])
})

test('pickNextBatch 全部整理完时返回 null', () => {
  assert.equal(pickNextBatch([{ at: 1, text: 'x' }], 1), null)
})

test('pickNextBatch 受条数上限约束', () => {
  const big = Array.from({ length: MAX_BATCH_MESSAGES + 50 }, (_, i) => ({ at: i, text: `m${i}` }))
  const b = pickNextBatch(big, 0)
  assert.equal(b.messages.length, MAX_BATCH_MESSAGES)
  assert.equal(b.truncated, true)
})

test('单天超过上限时不死循环：下一批从上一批末尾接着取', () => {
  // 同一天塞 200 条 —— 这是会让人永远整理不完的经典陷阱
  const day = Date.parse('2026-11-14T12:00:00+08:00')
  const many = Array.from({ length: 200 }, (_, i) => ({ at: day + i, text: `m${i}` }))

  const first = pickNextBatch(many, 0)
  assert.equal(first.messages.length, MAX_BATCH_MESSAGES)

  const second = pickNextBatch(many, first.lastAt)
  assert.ok(second, '必须还有下一批')
  assert.notEqual(second.messages[0].at, first.messages[0].at, '不能还是同一批')
  assert.equal(second.messages.length, 200 - MAX_BATCH_MESSAGES)
})

// ── 端到端 ────────────────────────────────────────────

function makeSessions(daysBack = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ingest-'))
  const sdir = path.join(root, '--E-work--', 'session-a')
  fs.mkdirSync(sdir, { recursive: true })

  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'a', createdAt: NOW }),
    JSON.stringify({
      type: 'user/message',
      time: NOW - daysBack * DAY,
      data: { content: [{ type: 'text', text: '主人说他喜欢蓝色' }] },
    }),
  ]
  fs.writeFileSync(
    path.join(sdir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')),
  )
  return root
}

function freshTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ingest-store-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('端到端：取批 → 交块 → 落库 → 记进度', async () => {
  const sessionsDir = makeSessions(1)
  const { store, tools } = freshTools()

  const batch = await tools.ingest({ sessionsDir })
  assert.equal(batch.ok, true)
  assert.equal(batch.count, 1)
  assert.ok(batch.text.includes('主人说他喜欢蓝色'))
  assert.ok(batch.text.includes('<<<记忆'), '必须给出块格式')

  const day = batch.days[0]
  const commit = tools.ingestCommit({
    block: [
      `<<<记忆 layer=user alpha=0.8 beta=0.9>>>`,
      `- 主人说他喜欢蓝色`,
      `<<<账本>>>`,
      `{"已整理到":"${day}"}`,
    ].join('\n'),
  })

  assert.equal(commit.ok, true)
  assert.equal(commit.added, 1)
  assert.equal(store.readAll().entries.length, 1)
  assert.equal(store.readAll().entries[0].text, '主人说他喜欢蓝色')

  // 进度已记
  const st = store.readState()
  assert.ok(st.ingest.doneDays.includes(day))
})

test('断点续跑：交过一次的批次不再给', async () => {
  const sessionsDir = makeSessions(1)
  const { tools } = freshTools()

  const b1 = await tools.ingest({ sessionsDir })
  assert.equal(b1.done, undefined)
  tools.ingestCommit({
    block: `<<<记忆 layer=user>>>\n- 主人说他喜欢蓝色\n<<<账本>>>\n{"已整理到":"${b1.days[0]}"}`,
  })

  const b2 = await tools.ingest({ sessionsDir })
  assert.equal(b2.ok, true)
  assert.equal(b2.done, true, '第二次应该没有待整理了')
})

test('空块不让进度前进', async () => {
  const sessionsDir = makeSessions(1)
  const { store, tools } = freshTools()

  await tools.ingest({ sessionsDir })
  const before = store.readState().ingest?.lastIngestedAt ?? 0

  const commit = tools.ingestCommit({ block: '这里什么块都没有' })
  assert.equal(commit.ok, true)
  assert.equal(commit.added, 0)

  const after = store.readState().ingest?.lastIngestedAt ?? 0
  assert.equal(after, before, '空块不该让进度前进')
})

test('重复内容走去重，不算新增', async () => {
  const sessionsDir = makeSessions(1)
  const { tools } = freshTools()

  const b = await tools.ingest({ sessionsDir })
  const block = `<<<记忆 layer=user>>>\n- 主人说他喜欢蓝色\n<<<账本>>>\n{"已整理到":"${b.days[0]}"}`

  const first = tools.ingestCommit({ block })
  assert.equal(first.added, 1)

  const second = tools.ingestCommit({ block })
  assert.equal(second.deduped, 1)
  assert.equal(second.added, 0)
})

test('块里带密码会被脱敏后入库', async () => {
  const sessionsDir = makeSessions(1)
  const { store, tools } = freshTools()

  const b = await tools.ingest({ sessionsDir })
  tools.ingestCommit({
    block: `<<<记忆 layer=user>>>\n- 密码是 abc123xyz\n<<<账本>>>\n{"已整理到":"${b.days[0]}"}`,
  })

  const e = store.readAll().entries[0]
  assert.equal(e.text.includes('abc123xyz'), false)
  assert.ok(e.text.includes('[已脱敏'))
})

test('dayKey 用本地日期', () => {
  assert.equal(dayKey(Date.parse('2026-11-15T23:30:00+08:00')), '2026-11-15')
  assert.equal(dayKey(Date.parse('2026-11-15T00:10:00+08:00')), '2026-11-15')
})
