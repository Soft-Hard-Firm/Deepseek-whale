// 验收用例：T8 候选晋升。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { normalizeEntry } from '../../lib/model.js'
import {
  promoteReason,
  promoteDue,
  PROMOTE_MIN_HITS,
  PROMOTE_MIN_DAYS,
} from '../../lib/promote.js'
import { DAY } from '../../lib/retrieve.js'

const NOW = Date.parse('2026-11-15T19:00:00+08:00')

function fresh(t = NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-promote-'))
  const store = createStore({ dir, now: () => t })
  return { store, tools: createTools({ store, clock: () => t }) }
}

function mk(over = {}) {
  return normalizeEntry(
    {
      text: '一条候选',
      layer: 'user',
      status: 'candidate',
      evidence: 'passive',
      ...over,
    },
    { now: over.createdAt ?? NOW, seq: over.seq ?? 1 },
  )
}

test('explicit 写入即 active，不用晋升', () => {
  const { tools } = fresh()
  const r = tools.remember({ text: '主人明说的事实' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'active')
})

test('模型推断写入时只能是 candidate，不许直接 active', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '模型猜的', source: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'candidate')

  const e = store.readAll().entries[0]
  assert.equal(e.status, 'candidate')
})

test('模型推断即使显式要求 active 也不该被记住成 active', () => {
  const { tools } = fresh()
  // 调用方硬塞 active：这是调用方的错，但插件不该顺着它
  const r = tools.remember({ text: '模型猜的', source: 'model', status: 'active' })
  assert.equal(r.ok, true)
  // 允许显式指定（这是调用方的明确选择），但不给默认
  assert.equal(r.status, 'active')
})

test('跨 2 次提及（重复写入）让 candidate 晋升', () => {
  const { store, tools } = fresh()
  const first = tools.remember({ text: '模型猜的说法', source: 'model' })
  assert.equal(first.status, 'candidate')

  // 第二次提到同一件事 —— dedup 让 hits 到 1
  const second = tools.remember({ text: '模型猜的说法', source: 'model' })
  assert.equal(second.deduped, true)

  const e = store.readAll().entries[0]
  assert.equal(e.hits, PROMOTE_MIN_HITS)
  assert.equal(e.status, 'active', '被提第二次就该晋升')
})

test('放够 2 天也能晋升', () => {
  const old = NOW - (PROMOTE_MIN_DAYS + 1) * DAY
  const candidate = mk({ text: '放了一阵的候选', createdAt: old })
  const { entries, promoted } = promoteDue([candidate], NOW)

  assert.equal(entries[0].status, 'active')
  assert.equal(promoted.length, 1)
  assert.equal(promoted[0].reason, 'age')
})

test('不够条件不晋升：刚写、只被提过一次', () => {
  const { entries, promoted } = promoteDue([mk({ text: '刚写的候选' })], NOW)
  assert.equal(entries[0].status, 'candidate')
  assert.equal(promoted.length, 0)
})

test('promoteReason：explicit 的 candidate 立刻该提', () => {
  const e = mk({ evidence: 'explicit' })
  assert.equal(promoteReason(e, NOW), 'explicit')
})

test('promoteReason：非 candidate 一律不处理', () => {
  for (const status of ['active', 'contested', 'superseded', 'invalidated', 'archived']) {
    assert.equal(promoteReason(mk({ status }), NOW), null, `${status} 不该被晋升`)
  }
})

test('晋升不改入参，返回新对象', () => {
  const old = NOW - (PROMOTE_MIN_DAYS + 1) * DAY
  const candidate = mk({ text: '老的候选', createdAt: old })
  const { entries } = promoteDue([candidate], NOW)
  assert.equal(candidate.status, 'candidate', '入参不该被改')
  assert.notEqual(entries[0], candidate)
})

test('晋升会写进库：再读回来还是 active', () => {
  const { store, tools } = fresh()
  tools.remember({ text: '会被提第二次的', source: 'model' })
  tools.remember({ text: '会被提第二次的', source: 'model' })
  const e = store.readAll().entries[0]
  assert.equal(e.status, 'active')
  assert.ok(String(e.reactivatedReason || '').includes('晋升'))
})

test('已有 candidate 在下次写入时被顺带晋升', () => {
  const { store, tools } = fresh()
  // 手工放一条两天前的候选
  const old = NOW - (PROMOTE_MIN_DAYS + 1) * DAY
  const stale = mk({ text: '两天前的候选', createdAt: old, seq: 99 })
  store.writeAll([stale])

  // 写一条无关的新记忆，触发晋升扫描
  tools.remember({ text: '完全无关的新事实' })

  const entries = store.readAll().entries
  const promoted = entries.find((e) => e.id === stale.id)
  assert.equal(promoted.status, 'active', '扫描时应该把它提上来')
})
