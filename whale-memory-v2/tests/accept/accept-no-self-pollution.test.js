// 验收用例：T10 注入不落库（防自污染，PRD C4）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { looksLikeInjection, stripInjection } from '../../lib/self-pollution.js'
import { renderContext, renderSection, NOT_INSTRUCTION } from '../../lib/inject.js'

const NOW = Date.parse('2026-11-15T19:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-selfpoll-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('C4 注入块本身被认出来', () => {
  assert.equal(looksLikeInjection(renderSection()), true)
  assert.equal(looksLikeInjection(`## 长期记忆（自动带上）\n${NOT_INSTRUCTION}\n\n**固定**\n- 主人不吃辣`), true)
  assert.equal(looksLikeInjection('主人今天说他不想吃饭'), false)
})

test('C4 纯注入块写不进库', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: `## 长期记忆（自动带上）\n${NOT_INSTRUCTION}` })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'empty_text')
  assert.equal(store.readAll().entries.length, 0)
})

test('C4 注入块混着真话时，只剥注入、留住真话', () => {
  const { store, tools } = fresh()
  const mixed = [
    '## 长期记忆（自动带上）',
    NOT_INSTRUCTION,
    '',
    '**固定**',
    '- 主人不吃辣',
    '',
    '顺便说一下，我下周要去杭州出差。',
  ].join('\n')

  const r = tools.remember({ text: mixed })
  assert.equal(r.ok, true)

  const e = store.readAll().entries[0]
  assert.equal(e.text.includes('## 长期记忆'), false, '标题不该留下')
  assert.equal(e.text.includes(NOT_INSTRUCTION), false, '声明不该留下')
  assert.equal(e.text.includes('主人不吃辣'), false, '注入里的旧条目不该被记成新条目')
  assert.ok(e.text.includes('杭州出差'), '用户真的说的话要留住')
})

test('C4 注入块不进原文归档', () => {
  const { store, tools } = fresh()
  const r = tools.remember({
    text: `**这次可能相关**（2 条）\n- 旧事情一\n- 旧事情二\n\n真正要记的是：主人换了新键盘。`,
  })
  const e = store.readAll().entries.find((x) => x.id === r.id)
  const original = store.readOriginal(e.sourceRef)
  assert.equal(original.text.includes('这次可能相关'), false)
  assert.equal(original.text.includes('旧事情一'), false)
  assert.ok(original.text.includes('新键盘'))
})

test('stripInjection 不动正常文本', () => {
  const normal = '主人说这个方案先别动，等下周一起看。'
  assert.equal(stripInjection(normal), normal)
})

test('剥完只剩空白时返回空串', () => {
  assert.equal(stripInjection('## 长期记忆\n\n'), '')
  assert.equal(stripInjection(''), '')
})

test('注入渲染本身不写盘（C4 的另一半）', () => {
  const { store, tools } = fresh()
  tools.remember({ text: '主人喜欢蓝色' })

  const before = fs.readdirSync(store.paths.origDir).length
  const beforeSize = fs
    .readdirSync(store.paths.origDir)
    .reduce((n, f) => n + fs.statSync(path.join(store.paths.origDir, f)).size, 0)

  for (let i = 0; i < 3; i++) {
    renderContext({ pinned: store.readAll().entries, hits: [], now: NOW })
    renderSection()
  }

  const after = fs.readdirSync(store.paths.origDir).length
  const afterSize = fs
    .readdirSync(store.paths.origDir)
    .reduce((n, f) => n + fs.statSync(path.join(store.paths.origDir, f)).size, 0)

  assert.equal(after, before)
  assert.equal(afterSize, beforeSize)
})
