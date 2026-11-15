// 验收用例：维护入口（把 planDecay 接出来）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { CUMULATIVE_DAYS } from '../../lib/decay.js'
import { DAY } from '../../lib/retrieve.js'

const NOW = Date.parse('2026-11-15T22:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-maintain-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

/** 直接塞一条「很久没提」的条目，用旧时钟写进去。 */
function seedOld(store, days, over = {}) {
  const r = createTools({ store, clock: () => NOW - days * DAY })
  return r.remember({ text: '主人说周三发版，别在周五动线上', ...over }).id
}

test('maintain：久未提及的条目被压一级', () => {
  const { store, tools } = fresh()
  const id = seedOld(store, CUMULATIVE_DAYS[1] + 3)

  const r = tools.maintain({})
  assert.equal(r.ok, true)
  assert.equal(r.changed, 1)
  assert.equal(r.items[0].id, id)
  assert.equal(r.items[0].to, 1)

  const e = store.readAll().entries.find((x) => x.id === id)
  assert.equal(e.compressionLevel, 1)
})

test('maintain：dryRun 只算计划，不动库', () => {
  const { store, tools } = fresh()
  const id = seedOld(store, CUMULATIVE_DAYS[1] + 3)

  const r = tools.maintain({ dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, 1)
  assert.equal(r.dryRun, true)

  const e = store.readAll().entries.find((x) => x.id === id)
  assert.equal(e.compressionLevel, 0, 'dryRun 不该写盘')
})

test('maintain：没固化的条目只标待固化，不压', () => {
  const { store, tools } = fresh()
  const id = seedOld(store, 400, { text: '这个再说吧' })

  const r = tools.maintain({})
  assert.equal(r.ok, true)
  assert.equal(r.changed, 0)
  assert.equal(r.pending, 1)

  const e = store.readAll().entries.find((x) => x.id === id)
  assert.equal(e.compressionLevel, 0)
  assert.equal(e.pendingConsolidation, true)
})

test('maintain：重复跑不会把级别一直往上顶', () => {
  const { store, tools } = fresh()
  seedOld(store, CUMULATIVE_DAYS[1] + 3)

  tools.maintain({})
  const second = tools.maintain({})
  assert.equal(second.changed, 0, '第二次不该再有变化')
})

test('maintain：空库也不报错', () => {
  const { tools } = fresh()
  const r = tools.maintain({})
  assert.equal(r.ok, true)
  assert.equal(r.changed, 0)
})

test('maintain：报告只回前 20 条，不吐整库', () => {
  const { store, tools } = fresh()
  for (let i = 0; i < 30; i++) {
    seedOld(store, CUMULATIVE_DAYS[1] + 3, { text: `第${i}条很老的记忆，内容各不相同` })
  }
  const r = tools.maintain({})
  assert.equal(r.changed, 30)
  assert.equal(r.items.length, 20, '明细最多回 20 条')
})

test('maintain 调得动，且能重复调用', async () => {
  const { tools } = fresh()
  const a = await tools.maintain({ dryRun: true })
  const b = await tools.maintain({ dryRun: true })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})
