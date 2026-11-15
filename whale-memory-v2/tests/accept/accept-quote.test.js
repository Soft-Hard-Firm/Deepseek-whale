// 验收用例：E2 引用原话必须是来源子串。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'

const NOW = Date.parse('2026-11-15T22:30:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quote-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('E2 引用能在来源原文里找到时，正常入库并留下 quote', () => {
  const { store, tools } = fresh()
  const source = '主人说：「这个方案先别动，等下周一起看。」然后就去吃饭了。'
  const r = tools.remember({
    text: '主人要求方案先别动',
    quote: '这个方案先别动，等下周一起看',
    quoteSource: source,
  })

  assert.equal(r.ok, true)
  const e = store.readAll().entries.find((x) => x.id === r.id)
  assert.equal(e.quote, '这个方案先别动，等下周一起看')
})

test('E2 引用在来源里找不到时拒收', () => {
  const { store, tools } = fresh()
  const r = tools.remember({
    text: '主人要求方案先别动',
    quote: '这个方案明天就上线',
    quoteSource: '主人说：「这个方案先别动，等下周一起看。」',
  })

  assert.equal(r.ok, false)
  assert.equal(r.error, 'quote_mismatch')
  assert.equal(store.readAll().entries.length, 0, '没通过就不许写')
})

test('E2 只给引用不给来源，无法验证，拒收', () => {
  const { tools } = fresh()
  const r = tools.remember({
    text: '主人说过一句话',
    quote: '随便编的一句',
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'quote_unverifiable')
})

test('不给引用时一切照常', () => {
  const { tools } = fresh()
  const r = tools.remember({ text: '主人喜欢蓝色' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'active')
})

test('空字符串的 quote 当没给', () => {
  const { tools } = fresh()
  const r = tools.remember({ text: '主人喜欢蓝色', quote: '', quoteSource: '' })
  assert.equal(r.ok, true)
})

test('引用可以很长，但必须真在来源里', () => {
  const long = '这是一段很长的原文，'.repeat(20)
  const { tools } = fresh()
  const ok = tools.remember({
    text: '长引用',
    quote: '这是一段很长的原文，这是一段很长的原文',
    quoteSource: long,
  })
  assert.equal(ok.ok, true)

  const bad = tools.remember({
    text: '长引用二',
    quote: '这段话在原文里其实没有出现过',
    quoteSource: long,
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'quote_mismatch')
})

test('拒收不会留下半条数据', () => {
  const { store, tools } = fresh()
  tools.remember({ text: '正常的一条' })
  const before = store.readAll().entries.length

  tools.remember({ text: '带假引用', quote: '没出现过的话', quoteSource: '完全无关的原文' })

  assert.equal(store.readAll().entries.length, before, '拒收后条目数不该变')
})
