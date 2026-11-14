import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools, TOOL_SPECS, fingerprint } from '../../lib/tools.js'
import { PINNED_CAP, ALPHA_PIN } from '../../lib/model.js'

const BASE = Date.parse('2026-11-15T06:00:00+08:00')

function fresh(t = BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tools-'))
  const store = createStore({ dir, now: () => t })
  const tools = createTools({ store, clock: () => t })
  return { dir, store, tools }
}

test('fingerprint：去标点后取前 12 字', () => {
  assert.equal(fingerprint('主人说：发布窗口是每周三！'), '主人说发布窗口是每周三')
  assert.equal(fingerprint('主人说：发布窗口是每周三！'), fingerprint('主人说发布窗口是每周三'))
  // 只取前 12 字：第 13 个字不同也算同一条
  assert.equal(fingerprint('甲'.repeat(12) + '乙'), fingerprint('甲'.repeat(12) + '丙'))
})

test('remember：写入 active，带 sourceRef，原文可查', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '主人说发布窗口是每周三' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'active')

  const data = store.readAll()
  assert.equal(data.entries.length, 1)
  const e = data.entries[0]
  assert.ok(e.sourceRef, '应有 sourceRef')
  assert.equal(store.readOriginal(e.sourceRef).text, '主人说发布窗口是每周三')
})

test('remember：A2 模型推断进 candidate', () => {
  const { tools } = fresh()
  const r = tools.remember({ text: '主人可能喜欢蓝色', status: 'candidate', source: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'candidate')
})

test('remember：A3 重复文本不新增，只加 hits', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '主人讨厌别人拿肥当字面意思开玩笑' })
  const b = tools.remember({ text: '主人讨厌别人拿肥当字面意思开玩笑！' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.deduped, true)
  assert.equal(b.id, a.id)

  const data = store.readAll()
  assert.equal(data.entries.length, 1)
  assert.equal(data.entries[0].hits, 1)
})

test('remember：A4 同 factKey 旧条 superseded', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '主人用 npm', factKey: '工具.包管理' })
  const b = tools.remember({ text: '主人改用 pnpm', factKey: '工具.包管理' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)

  const data = store.readAll()
  const old = data.entries.find((e) => e.id === a.id)
  const now = data.entries.find((e) => e.id === b.id)
  assert.equal(old.status, 'superseded')
  assert.ok(old.supersededAt > 0)
  assert.equal(now.status, 'active')
})

test('remember：A7 常驻层满额拒绝，原条目不变', () => {
  const { store, tools } = fresh()
  for (let i = 0; i < PINNED_CAP; i++) {
    const r = tools.remember({ text: `常驻第${i}条`, alpha: ALPHA_PIN })
    assert.equal(r.ok, true)
  }
  const before = store.readAll().entries.length
  const r = tools.remember({ text: '再来一条常驻', alpha: ALPHA_PIN })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'layer_full')
  assert.equal(store.readAll().entries.length, before)
})

test('remember：空正文、超长正文、非法层被拒', () => {
  const { tools } = fresh()
  assert.equal(tools.remember({ text: '' }).error, 'invalid_param')
  assert.equal(tools.remember({ text: '字'.repeat(601) }).error, 'text_too_long')
  assert.equal(tools.remember({ text: '正常', layer: 'nope' }).error, 'invalid_layer')
})

test('search：B6 不带 query 返回索引概览', () => {
  const { tools } = fresh()
  tools.remember({ text: '第一条' })
  tools.remember({ text: '第二条', layer: 'project' })

  const r = tools.search({})
  assert.equal(r.ok, true)
  assert.equal(r.index.total, 2)
  assert.equal(r.index.byLayer.project, 1)
  assert.equal(r.index.byLayer.user, 1)
  assert.ok(r.index.hint)
})

test('search：带 query 返回摘要，不返回正文', () => {
  const { tools } = fresh()
  tools.remember({ text: '主人说发布窗口是每周三' })
  tools.remember({ text: '主人喜欢蓝色' })

  const r = tools.search({ query: '发布窗口' })
  assert.equal(r.ok, true)
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0].summary.includes('发布窗口'), true)
  assert.equal('text' in r.hits[0], false, '默认不返回正文')
})

test('search：不命中返回空数组', () => {
  const { tools } = fresh()
  tools.remember({ text: '主人喜欢蓝色' })
  const r = tools.search({ query: '量子' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.hits, [])
})

test('recall：G2 按 id 读正文和原文', () => {
  const { tools } = fresh()
  const a = tools.remember({ text: '主人说这个方案先别动' })
  const r = tools.recall({ id: a.id })
  assert.equal(r.ok, true)
  assert.equal(r.text, '主人说这个方案先别动')
  assert.equal(r.source, '主人说这个方案先别动')
  assert.equal(r.sourceMissing, false)
  assert.equal(r.nextOffset, null)
})

test('recall：不存在的 id 返回 not_found', () => {
  const { tools } = fresh()
  const r = tools.recall({ id: 'm_不存在' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})

test('recall：G3 原文被删后仍可读，标 sourceMissing', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '会被删掉原文的一条' })
  const e = store.readAll().entries[0]
  fs.unlinkSync(path.join(store.paths.origDir, e.sourceRef.split('#')[0] + '.jsonl'))

  const r = tools.recall({ id: a.id })
  assert.equal(r.ok, true)
  assert.equal(r.text, '会被删掉原文的一条')
  assert.equal(r.source, null)
  assert.equal(r.sourceMissing, true)
})

test('update：改正文，摘要跟着更新', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '旧内容一共有很长很长的一段话' })
  const r = tools.update({ id: a.id, text: '新内容' })
  assert.equal(r.ok, true)
  const e = store.readAll().entries.find((x) => x.id === a.id)
  assert.equal(e.text, '新内容')
  assert.equal(e.summary, '新内容')
})

test('update：同时改正文和状态，正文不丢', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '旧内容' })
  const r = tools.update({ id: a.id, text: '改过的内容', status: 'archived' })
  assert.equal(r.ok, true)
  const e = store.readAll().entries.find((x) => x.id === a.id)
  assert.equal(e.text, '改过的内容')
  assert.equal(e.status, 'archived')
})

test('update：非法状态转移被拒', () => {
  const { tools } = fresh()
  const a = tools.remember({ text: '活着的一条' })
  tools.update({ id: a.id, status: 'invalidated' })
  const r = tools.update({ id: a.id, status: 'active' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad_transition')
})

test('forget：只改状态，不物理删除，仍可检索', () => {
  const { store, tools } = fresh()
  const a = tools.remember({ text: '这条要被忘掉' })
  const r = tools.forget({ id: a.id, reason: '主人说忘了' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'invalidated')

  const data = store.readAll()
  assert.equal(data.entries.length, 1, '不许物理删除')
  assert.equal(data.entries[0].status, 'invalidated')

  const s = tools.search({ query: '忘掉' })
  assert.equal(s.hits.length, 1, '被纠正的仍可追溯')
})

test('TOOL_SPECS：参数是完整 JSON Schema，且带三条规矩', () => {
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    assert.equal(spec.name, name)
    assert.equal(spec.parameters.type, 'object', `${name} 根上要有 type`)
    assert.equal(spec.parameters.additionalProperties, false)
  }
  const r = TOOL_SPECS.remember.description
  assert.ok(r.includes('一条只装一件事'))
  assert.ok(r.includes('不要在回复里说「记下了」'))
  assert.ok(r.includes('时间由系统给'))
})
