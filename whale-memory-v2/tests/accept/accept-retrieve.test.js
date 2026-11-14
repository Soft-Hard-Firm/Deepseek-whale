// 验收用例：T4 检索层。标题即 PRD B 类编号。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { select } from '../../lib/retrieve.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accept-retrieve-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('B1 无关短句「在吗」不触发记忆检索', () => {
  const { tools } = fresh()
  tools.remember({ text: '主人说婚礼改到三月' })
  tools.remember({ text: '主人喜欢蓝色' })
  tools.remember({ text: '主人用 pnpm' })

  const r = tools.search({ query: '在吗' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.hits, [], '「在吗」不该捞任何东西出来')
})

test('B2 同一句话问两次，选出的条目完全一致', () => {
  const { tools } = fresh()
  for (const t of ['主人说婚礼改到三月', '主人喜欢蓝色', '主人用 pnpm', '主人周报在周五交']) {
    tools.remember({ text: t })
  }
  const first = tools.search({ query: '主人' })
  const second = tools.search({ query: '主人' })
  assert.deepEqual(
    first.hits.map((h) => h.id),
    second.hits.map((h) => h.id),
  )
})

test('B3 含关键实体的长问句能召回对应记忆', () => {
  const { tools } = fresh()
  const wedding = tools.remember({ text: '主人说婚礼改到三月的第一个周末' })
  tools.remember({ text: '主人喜欢蓝色' })
  tools.remember({ text: '今天天气不错' })

  const r = tools.search({ query: '我们那天办婚礼的时候你还记得吗' })
  assert.ok(
    r.hits.some((h) => h.id === wedding.id),
    '长问句里的「婚礼」要能召回那条',
  )
})

test('B4 全库 3 条时，短问句不会一条都想不起来', () => {
  const { tools } = fresh()
  const wedding = tools.remember({ text: '主人说婚礼改到三月的第一个周末' })
  tools.remember({ text: '主人喜欢蓝色' })
  tools.remember({ text: '今天天气不错' })

  const r = tools.search({ query: '婚礼' })
  assert.ok(r.hits.length >= 1, '小库检索不能空手而归')
  assert.equal(r.hits[0].id, wedding.id)
})

test('B5 检索结果带时间与来源', () => {
  const { tools } = fresh()
  tools.remember({ text: '主人说婚礼改到三月' })
  const r = tools.search({ query: '婚礼' })
  assert.ok(r.hits.length >= 1)
  for (const h of r.hits) {
    assert.ok(Number.isFinite(h.at), '每条要带时间')
    assert.ok(typeof h.id === 'string' && h.id.length > 0, '每条要能定位到来源 id')
    assert.ok(typeof h.status === 'string')
  }
})

test('检索只给摘要，不给正文（正文走 recall）', () => {
  const { tools } = fresh()
  tools.remember({ text: '主人说婚礼改到三月' })
  const r = tools.search({ query: '婚礼' })
  assert.ok(r.hits.length >= 1)
  assert.equal('text' in r.hits[0], false)
})

test('注入与检索分开：注入只选 active/contested，检索能翻到 archived', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accept-split-'))
  const store = createStore({ dir, now: () => NOW })
  const tools = createTools({ store, clock: () => NOW })
  const a = tools.remember({ text: '婚礼改到三月' })
  tools.update({ id: a.id, status: 'archived' })

  const entries = store.readAll().entries
  const inject = select(entries, '婚礼', { now: NOW })
  assert.equal(inject.picked.length, 0, '归档的不进注入')

  const found = tools.search({ query: '婚礼' })
  assert.equal(found.hits.length, 1, '但检索翻得到')
})
