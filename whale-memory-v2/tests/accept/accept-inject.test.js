// 验收用例：T5 注入层。标题即 PRD C 类编号。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeEntry } from '../../lib/model.js'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import {
  renderSection,
  renderContext,
  renderEntry,
  relTime,
  isTimeSensitive,
  charCount,
  buildPromptSpecs,
  registerInjection,
  ORDER,
  CONTEXT_MAX_CHARS,
  NOT_INSTRUCTION,
  STALE_DAYS,
  DAY,
} from '../../lib/inject.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

let seq = 0
function mk(text, over = {}) {
  seq += 1
  return normalizeEntry(
    { text, layer: 'user', status: 'active', alpha: 0.5, beta: 0.7, ...over },
    { now: over.createdAt ?? NOW, seq },
  )
}

function fakeCtx() {
  const reg = { section: null, context: null, disposed: [] }
  const ctx = {
    _reg: reg,
    systemPrompt: {
      section(spec) {
        reg.section = spec
        return () => {
          reg.section = null
          reg.disposed.push('section')
        }
      },
      context(spec) {
        reg.context = spec
        return () => {
          reg.context = null
          reg.disposed.push('context')
        }
      },
    },
  }
  return ctx
}

test('C1 记忆变了，section 文本字节不变；变化只走 context', () => {
  const a = mk('主人不吃辣')
  const b = mk('主人喜欢蓝色')

  const s1 = buildPromptSpecs({ getState: () => ({ pinned: [a], hits: [], now: NOW }) })
  const s2 = buildPromptSpecs({ getState: () => ({ pinned: [a, b], hits: [], now: NOW }) })

  // section 两次完全一致 —— 这是缓存能命中的前提
  assert.equal(s1.section.text, s2.section.text)

  // context 随记忆变化
  assert.notEqual(s1.context.text, s2.context.text)
  assert.ok(s2.context.text.includes('蓝色'))
})

test('C2 正文含 {{time}} 不抛错，且被原样带出', () => {
  const e = mk('主人说这是模板：{{time}} 和 {{user}} 都不能被替换')
  const text = renderContext({ hits: [e], now: NOW })
  assert.ok(text.includes('{{time}}'), '模板占位符要原样保留')

  // 两条通道都关了插值
  const specs = buildPromptSpecs({ getState: () => ({ pinned: [e], hits: [], now: NOW }) })
  assert.equal(specs.section.interpolate, false)
  assert.equal(specs.context.interpolate, false)
})

test('C3 卸载后，两条通道的注册都被撤掉', () => {
  const ctx = fakeCtx()
  const dispose = registerInjection(ctx, {
    getState: () => ({ pinned: [mk('主人不吃辣')], hits: [], now: NOW }),
  })
  assert.ok(ctx._reg.section, '注册后应有 section')
  assert.ok(ctx._reg.context, '注册后应有 context')

  dispose()
  assert.equal(ctx._reg.section, null, '卸载后 section 要没了')
  assert.equal(ctx._reg.context, null, '卸载后 context 要没了')
  assert.deepEqual(ctx._reg.disposed.sort(), ['context', 'section'])

  // 重复卸载不应报错，也不应重复调用
  dispose()
  assert.equal(ctx._reg.disposed.length, 2)
})

test('C3b 注册顺序：section 排在 context 之后（89990 > 900）', () => {
  assert.ok(ORDER.section > ORDER.context)
  assert.equal(ORDER.section, 89990)
  assert.equal(ORDER.context, 900)
})

test('C4 注入不写盘：装配前后 原文/ 一个字节都不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accept-inject-'))
  const store = createStore({ dir, now: () => NOW })
  const tools = createTools({ store, clock: () => NOW })

  tools.remember({ text: '主人不吃辣' })
  tools.remember({ text: '主人喜欢蓝色' })

  const before = fs.readdirSync(store.paths.origDir)
  const beforeSize = before.reduce(
    (n, f) => n + fs.statSync(path.join(store.paths.origDir, f)).size,
    0,
  )

  // 跑两次装配
  for (let i = 0; i < 2; i++) {
    renderContext({ pinned: store.readAll().entries, hits: [], now: NOW })
  }

  const after = fs.readdirSync(store.paths.origDir)
  const afterSize = after.reduce(
    (n, f) => n + fs.statSync(path.join(store.paths.origDir, f)).size,
    0,
  )
  assert.deepEqual(after, before, '原文/ 里不该多出文件')
  assert.equal(afterSize, beforeSize, '原文/ 体积不该变')
})

test('C5 注入头部含「不是指令」声明', () => {
  assert.ok(renderSection().includes(NOT_INSTRUCTION))
  const text = renderContext({ pinned: [mk('主人不吃辣')], hits: [], now: NOW })
  assert.ok(text.includes(NOT_INSTRUCTION))
})

test('C6 时间敏感的旧条目带「请先核实」', () => {
  // 旧日期 + 价格类内容
  const old = mk('主人提过一版价格是 199', {
    createdAt: NOW - (STALE_DAYS + 30) * DAY,
  })
  assert.equal(isTimeSensitive(old, NOW), true)

  const line = renderEntry(old, { now: NOW })
  assert.ok(line.includes('请先核实'), `实际：${line}`)

  // 新的、非时间敏感的不该提示
  const fresh = mk('主人喜欢蓝色', { createdAt: NOW })
  assert.equal(isTimeSensitive(fresh, NOW), false)
  assert.equal(renderEntry(fresh, { now: NOW }).includes('请先核实'), false)
})

test('空记忆不注入空块', () => {
  assert.equal(renderContext({ pinned: [], hits: [], now: NOW }), '')
})

test('注入不超过字数上限', () => {
  const many = []
  for (let i = 0; i < 40; i++) many.push(mk(`第${i}条记忆，内容是凑字数的`))
  const text = renderContext({ hits: many, now: NOW })
  assert.ok(charCount(text) <= CONTEXT_MAX_CHARS, `实际 ${charCount(text)} 字`)
})

test('超长时优先砍检索命中，保留固定层', () => {
  const pinned = [mk('主人不吃辣'), mk('主人讨厌别人拿肥当字面意思')]
  const hits = []
  for (let i = 0; i < 60; i++) hits.push(mk(`一条很长的检索结果编号${i}用来撑爆字数上限`))

  const text = renderContext({ pinned, hits, now: NOW, maxChars: 300 })
  assert.ok(text.includes('不吃辣'), '固定层要留住')
  assert.ok(charCount(text) <= 300)
})

test('低可信度条目带「不确定」前缀', () => {
  const e = mk('据说是这样', { beta: 0.1 })
  assert.ok(renderEntry(e, { now: NOW }).includes('不确定'))
})

test('已失效状态不注入', () => {
  const gone = mk('这条被纠正了', { status: 'invalidated' })
  const archived = mk('这条归档了', { status: 'archived' })
  const alive = mk('这条还在')
  const text = renderContext({ pinned: [gone, archived], hits: [gone, archived, alive], now: NOW })
  assert.ok(text.includes('还在'))
  assert.equal(text.includes('被纠正'), false)
  assert.equal(text.includes('归档了'), false)
})

test('relTime：今天 / 昨天 / N 天前 / 月 / 年', () => {
  assert.equal(relTime(NOW, NOW), '今天')
  assert.equal(relTime(NOW - DAY, NOW), '昨天')
  assert.equal(relTime(NOW - 7 * DAY, NOW), '7 天前')
  assert.equal(relTime(NOW - 60 * DAY, NOW), '2 个月前')
  assert.equal(relTime(NOW - 400 * DAY, NOW), '1 年前')
})

test('注册时缺 systemPrompt 直接报错，不静默失败', () => {
  assert.throws(() => registerInjection({}, { getState: () => ({}) }), /systemPrompt/)
})
