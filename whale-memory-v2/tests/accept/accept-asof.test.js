// 验收用例：时光机查询（asOf）——查「某时刻为真」的事实。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { select, effectiveAt } from '../../lib/retrieve.js'

const T1 = Date.parse('2026-10-01T10:00:00+08:00') // 旧方案
const T2 = Date.parse('2026-10-20T10:00:00+08:00') // 被取代
const NOW = Date.parse('2026-11-16T00:20:00+08:00')

/** 一个可推进的时钟。 */
function clockAt(t) {
  let cur = t
  return {
    now: () => cur,
    set: (t2) => {
      cur = t2
    },
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-asof-'))
  const clock = clockAt(T1)
  const store = createStore({ dir, now: clock.now })
  return { store, tools: createTools({ store, clock: clock.now }), clock }
}

test('effectiveAt：产生前无效，取代后无效', () => {
  const e = { createdAt: T1, supersededAt: T2 }
  assert.equal(effectiveAt(e, T1 - 1000), false, '还没产生')
  assert.equal(effectiveAt(e, T1 + 1000), true, '在有效期内')
  assert.equal(effectiveAt(e, T2 - 1000), true, '取代前一秒仍有效')
  assert.equal(effectiveAt(e, T2), false, '被取代那一刻起无效')
})

test('effectiveAt：作废也按时效判定', () => {
  const e = { createdAt: T1, invalidatedAt: T2 }
  assert.equal(effectiveAt(e, T1 + 1000), true)
  assert.equal(effectiveAt(e, T2 + 1000), false)
})

test('effectiveAt：归档没有时间戳，视为一直有效', () => {
  const e = { createdAt: T1, status: 'archived' }
  assert.equal(effectiveAt(e, T1 + 1000), true)
})

test('时光机：方案被改之前问，拿到旧方案', () => {
  const { store, tools, clock } = setup()
  const id = tools.remember({ text: '方案 A：先做记忆插件', at: T1 }).id

  // 推进到 T2，用新方案取代旧的
  clock.set(T2)
  tools.remember({ text: '改成先做桌面端了' })
  tools.update({ id, status: 'superseded', reason: '改成方案 B 了' })

  // 站在 T1 附近问：应该看到方案 A
  const old = tools.search({ query: '方案', asOf: T1 + 1000 })
  assert.equal(old.ok, true)
  assert.ok(
    old.hits.some((h) => h.id === id),
    '那一刻方案 A 是有效的，应该查得到',
  )
  assert.ok(old.asOf, '应该回显时间锚点')

  // 刚被取代之后问：方案 A 还能翻到（检索要能追溯），但状态是「已取代」
  // 注意别把时钟推太远 —— 衰减会把分数压到门槛下，那测的就不是 asOf 了
  clock.set(T2 + 1000)
  const cur = tools.search({ query: '方案' })
  assert.equal(cur.ok, true)
  const hit = cur.hits.find((h) => h.id === id)
  assert.ok(hit, '检索要能翻到被取代的条目')
  assert.equal(hit.status, 'superseded', '但它已经不是有效状态')

  // 而时光机那边看到的是「有效」——这才是差别
  assert.ok(
    old.hits.find((h) => h.id === id),
    '回到那时，它还是有效的',
  )
})

test('时光机：还没产生的东西，回到过去查不到', () => {
  const { store, tools, clock } = setup()
  clock.set(T2)
  const id = tools.remember({ text: '方案 B：后来才定的' }).id

  const before = tools.search({ query: '方案', asOf: T1 })
  assert.equal(before.hits.some((h) => h.id === id), false, '那时还没它')
})

test('不给 asOf 时行为完全不变', () => {
  const { store, tools } = setup()
  const id = tools.remember({ text: '方案 A：先做记忆插件', at: T1 }).id
  const r = tools.search({ query: '方案' })
  assert.ok(r.hits.some((h) => h.id === id))
  assert.equal(r.asOf, undefined, '普通查询不该回显 asOf')
})

test('asOf 接受日期字符串', () => {
  const { tools } = setup()
  tools.remember({ text: '方案 A：先做记忆插件', at: T1 })
  const r = tools.search({ query: '方案', asOf: '2026-10-02' })
  assert.equal(r.ok, true)
  assert.ok(r.asOf > 0)
})

test('底层 select：asOf 时忽略当前 status，只看那时是否有效', () => {
  const a = {
    id: 'a',
    text: '方案 A',
    summary: '方案 A',
    layer: 'user',
    status: 'superseded',
    createdAt: T1,
    supersededAt: T2,
    alpha: 0.5,
    beta: 0.7,
    evidence: 'explicit',
    keywords: ['方案'],
    encodings: [T1],
    hits: 0,
    lastHit: 0,
  }
  // 现在的状态是 superseded，但站在 T1 那一刻它是有效的
  const { picked } = select([a], '方案', { now: NOW, asOf: T1 + 1000, applyQuota: false })
  assert.equal(picked.length, 1)

  const later = select([a], '方案', { now: NOW, asOf: T2 + 1000, applyQuota: false })
  assert.equal(later.picked.length, 0)
})

test('时光机：精度到毫秒，边界不差一毫秒', () => {
  const { store, tools, clock } = setup()
  const id = tools.remember({ text: '方案 A：先做记忆插件', at: T1 }).id
  clock.set(T2)
  tools.update({ id, status: 'superseded' })

  // 恰好等于 supersededAt 时已经无效
  const atBoundary = tools.search({ query: '方案', asOf: T2 })
  assert.equal(atBoundary.hits.some((h) => h.id === id), false)

  const justBefore = tools.search({ query: '方案', asOf: T2 - 1 })
  assert.equal(justBefore.hits.some((h) => h.id === id), true)
})
