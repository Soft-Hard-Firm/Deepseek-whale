// 验收用例：T3 工具层。标题即 PRD 编号。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accept-tools-'))
  const store = createStore({ dir, now: () => NOW })
  return { dir, store, tools: createTools({ store, clock: () => NOW }) }
}

test('A3 同一事实重复写入，不产生两条 active，hits 递增', () => {
  const { store, tools } = fresh()
  const first = tools.remember({ text: '主人讨厌别人拿肥当字面意思开玩笑' })
  const second = tools.remember({ text: '主人讨厌别人拿肥当字面意思开玩笑。' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.id, first.id)

  const data = store.readAll()
  assert.equal(data.entries.length, 1)
  assert.equal(data.entries[0].status, 'active')
  assert.equal(data.entries[0].hits, 1)
})

test('A4 factKey 相同的新事实，旧条 superseded 且可追溯', () => {
  const { store, tools } = fresh()
  const oldOne = tools.remember({ text: '主人用 npm', factKey: '工具.包管理' })
  tools.remember({ text: '主人改用 pnpm', factKey: '工具.包管理' })

  const entries = store.readAll().entries
  const old = entries.find((e) => e.id === oldOne.id)
  assert.equal(old.status, 'superseded')
  assert.ok(old.supersededAt > 0)

  // 旧条不再注入，但仍可检索到
  const s = tools.search({ query: 'npm' })
  assert.equal(s.hits.some((h) => h.id === oldOne.id), true)
  assert.equal(s.hits.find((h) => h.id === oldOne.id).status, 'superseded')
})

test('A6 archived 条目仍可被 search 找到', () => {
  const { tools } = fresh()
  const a = tools.remember({ text: '这条要归档' })
  const r = tools.update({ id: a.id, status: 'archived' })
  assert.equal(r.ok, true)

  const s = tools.search({ query: '归档' })
  assert.equal(s.hits.length, 1)
  assert.equal(s.hits[0].status, 'archived')
})

test('B6 不带查询调用检索，返回库的索引概览', () => {
  const { tools } = fresh()
  tools.remember({ text: '第一条', layer: 'user' })
  tools.remember({ text: '第二条', layer: 'knowledge' })

  const r = tools.search({})
  assert.equal(r.ok, true)
  assert.equal(r.index.total, 2)
  assert.equal(r.index.byLayer.knowledge, 1)
  assert.ok(Number.isFinite(r.index.oldestAt))
  assert.ok(r.index.hint.length > 0)
})

test('G1 每条写入都带 sourceRef，且能反查到原文', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '主人原话：这个方案先别动' })
  const e = store.readAll().entries.find((x) => x.id === a.id)
  assert.ok(e.sourceRef)
  assert.equal(store.readOriginal(e.sourceRef).text, '主人原话：这个方案先别动')
})

test('G2 从记忆能翻到原始出处', () => {
  const { tools } = fresh()
  const a = tools.remember({ text: '主人说周三发版' })
  const r = tools.recall({ id: a.id })
  assert.equal(r.ok, true)
  assert.equal(r.text, '主人说周三发版')
  assert.equal(r.source, '主人说周三发版')
  assert.equal(r.sourceMissing, false)
})
