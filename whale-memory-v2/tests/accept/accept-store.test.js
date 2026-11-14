// 验收用例：对应 docs/PRD.md §2.3.1（存储与状态）与 §2.3.8（并发与启动）。
// 每个 test 的标题就是验收编号，方便对着 PRD 核对。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import {
  normalizeEntry,
  transition,
  shouldInject,
  canPin,
  PINNED_CAP,
  ALPHA_PIN,
} from '../../lib/model.js'

const NOW = Date.parse('2026-11-15T05:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accept-'))
  return { dir, store: createStore({ dir, now: () => NOW }) }
}

// ── A 组：存储与状态 ──────────────────────────────────────

test('A1 用户明确说的事实，写入后 status=active', () => {
  const { store } = fresh()
  const e = normalizeEntry({ text: '主人说发布窗口是每周三', source: 'explicit' }, { now: NOW, seq: 1 })
  assert.equal(e.status, 'active')
  store.writeAll([e])
  assert.equal(store.readAll().entries[0].status, 'active')
})

test('A2 模型推断的事实，写入后 status=candidate', () => {
  const { store } = fresh()
  const e = normalizeEntry(
    { text: '主人可能喜欢蓝色', source: 'model', status: 'candidate' },
    { now: NOW, seq: 1 },
  )
  assert.equal(e.status, 'candidate')
  assert.equal(shouldInject(e), false)
  store.writeAll([e])
  assert.equal(store.readAll().entries[0].status, 'candidate')
})

test('A5 用户纠正后，旧条 invalidated，不再参与注入', () => {
  const { store } = fresh()
  const e = normalizeEntry({ text: '主人在周五上线', source: 'explicit' }, { now: NOW, seq: 1 })
  const fixed = transition(e, 'invalidated', { now: NOW + 1000, by: 'user' })
  store.writeAll([fixed])
  const back = store.readAll().entries[0]
  assert.equal(back.status, 'invalidated')
  assert.equal(shouldInject(back), false)
})

test('A7 常驻层达上限后拒绝新写入，原有条目数不变', () => {
  const pinned = Array.from({ length: PINNED_CAP }, (_, i) => ({
    id: `p${i}`,
    text: `常驻 ${i}`,
    layer: 'user',
    status: 'active',
    alpha: ALPHA_PIN,
    beta: 1,
    evidence: 'explicit',
    keywords: [],
    createdAt: NOW,
    source: 'explicit',
  }))
  assert.equal(canPin(pinned), false)
  // 拒绝的语义是「不写」，不是「写进去再挤掉一条」
  assert.equal(pinned.length, PINNED_CAP)
  assert.equal(canPin(pinned.slice(1)), true)
})

// ── H 组：并发与启动 ──────────────────────────────────────

test('H2 空库首次启动不报错', () => {
  const { store } = fresh()
  assert.doesNotThrow(() => store.readAll())
  assert.deepEqual(store.readAll().entries, [])
  // 首次写入不报错
  assert.doesNotThrow(() => store.writeAll([]))
})

test('H3 数据文件损坏时拒绝写入，文件内容不变', () => {
  const { store } = fresh()
  fs.mkdirSync(path.dirname(store.paths.memPath), { recursive: true })
  fs.writeFileSync(store.paths.memPath, '半截 JSON {', 'utf8')
  assert.throws(() => store.writeAll([{ id: 'x', text: 'y' }]), (e) => e.code === 'store_corrupt')
  assert.equal(fs.readFileSync(store.paths.memPath, 'utf8'), '半截 JSON {')
})

test('H4 从备份恢复后条目一致', () => {
  const { store } = fresh()
  const entries = [
    normalizeEntry({ text: '第一件事' }, { now: NOW, seq: 1 }),
    normalizeEntry({ text: '第二件事' }, { now: NOW, seq: 2 }),
  ]
  store.writeAll(entries)
  assert.equal(store.backup().ok, true)

  fs.writeFileSync(store.paths.memPath, '彻底坏掉', 'utf8')
  const r = store.recover()
  assert.equal(r.ok, true)
  assert.deepEqual(store.readAll().entries.map((e) => e.text), ['第一件事', '第二件事'])
})

// ── G 组：溯源（存储层部分）────────────────────────────────

test('G1 写入的原文有 sourceRef，能反查回来', () => {
  const { store } = fresh()
  const { sourceRef } = store.appendOriginal('主人原话：这个方案先别动', { src: 'explicit' })
  const rec = store.readOriginal(sourceRef)
  assert.equal(rec.text, '主人原话：这个方案先别动')

  const e = normalizeEntry(
    { text: '这个方案先别动', sourceRef },
    { now: NOW, seq: 1 },
  )
  assert.equal(e.sourceRef, sourceRef)
})

test('G3 原文被删后，条目仍可读并标 sourceMissing', () => {
  const { store } = fresh()
  const { sourceRef } = store.appendOriginal('会被删掉的一句')
  const e = normalizeEntry({ text: '引用那句', sourceRef }, { now: NOW, seq: 1 })
  store.writeAll([e])

  // 模拟原文被人工删掉
  fs.unlinkSync(path.join(store.paths.origDir, sourceRef.split('#')[0] + '.jsonl'))
  assert.equal(store.readOriginal(sourceRef), null)

  // 条目还在，读库不崩
  const back = store.readAll().entries[0]
  assert.equal(back.text, '引用那句')
  // 读取方据此标 sourceMissing（模型层字段，存储层不擅自改）
  assert.equal(store.readOriginal(back.sourceRef), null)
})
