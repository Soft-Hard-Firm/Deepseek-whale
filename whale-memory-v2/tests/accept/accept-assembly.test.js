// 验收用例：T7 插件装配。
//
// 用假 ctx 模拟 Cordis 的 tools / systemPrompt 契约，
// 验证「能装、能卸、装坏了不炸宿主」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, buildToolDefinitions, makeStateProvider, defaultDir, name as pluginName, inject as pluginInject } from '../../index.js'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { ORDER } from '../../lib/inject.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

function fakeCtx() {
  const reg = { tools: new Map(), sections: [], contexts: [], disposeHooks: [] }
  const ctx = {
    _reg: reg,
    tools: {
      register(def) {
        reg.tools.set(def.name, def)
        return () => reg.tools.delete(def.name)
      },
    },
    systemPrompt: {
      section(s) {
        const i = reg.sections.push(s) - 1
        return () => {
          if (reg.sections[i]) reg.sections.splice(i, 1)
        }
      },
      context(c) {
        const i = reg.contexts.push(c) - 1
        return () => {
          if (reg.contexts[i]) reg.contexts.splice(i, 1)
        }
      },
    },
    on(event, fn) {
      if (event === 'dispose') reg.disposeHooks.push(fn)
    },
  }
  return ctx
}

function tmpDir(prefix = 'whale-asm-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('插件声明：name 与 inject 齐全', () => {
  assert.equal(typeof pluginName, 'string')
  assert.ok(pluginName.length > 0)
  assert.deepEqual(pluginInject, ['tools', 'systemPrompt'])
})

test('装进 ctx 后：9 个工具都注册上了', () => {
  const ctx = fakeCtx()
  apply(ctx, { dir: tmpDir() })
  assert.equal(ctx._reg.tools.size, 9)
  for (const n of ['remember', 'search', 'recall', 'update', 'forget', 'maintain', 'digest', 'ingest', 'ingest_commit']) {
    assert.ok(ctx._reg.tools.has(n), `缺工具 ${n}`)
  }
})

test('工具定义符合 DSH 契约：有 description / parameters / output.schema / execute', () => {
  const ctx = fakeCtx()
  apply(ctx, { dir: tmpDir() })
  for (const [n, def] of ctx._reg.tools) {
    assert.equal(def.name, n)
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 0, `${n} 描述为空`)
    assert.equal(def.parameters.type, 'object')
    assert.equal(def.parameters.additionalProperties, false)
    assert.ok(def.output && def.output.schema, `${n} 缺 output.schema`)
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
  }
})

test('工具真的能执行：remember 写入后 search 查得到', async () => {
  const ctx = fakeCtx()
  apply(ctx, { dir: tmpDir() })

  const remember = ctx._reg.tools.get('remember')
  const search = ctx._reg.tools.get('search')

  const w = await remember.execute({ text: '主人说婚礼改到三月的第一个周末' })
  assert.equal(w.ok, true)

  const s = await search.execute({ query: '婚礼' })
  assert.equal(s.ok, true)
  assert.ok(s.hits.length >= 1, '写入后应该能检索到')
})

test('工具执行抛错时不外泄，转成 ok:false', async () => {
  const ctx = fakeCtx()
  apply(ctx, { dir: tmpDir() })
  const recall = ctx._reg.tools.get('recall')
  const r = await recall.execute({ id: '不存在的 id' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not_found')
})

test('output.render 把成功和失败都渲染成文本块', () => {
  const defs = buildToolDefinitions(createTools({ store: createStore({ dir: tmpDir(), now: () => NOW }) }))
  const def = defs[0]
  const ok = def.output.render({}, { ok: true, id: 'm_1' })
  assert.equal(Array.isArray(ok), true)
  assert.equal(ok[0].type, 'text')
  assert.ok(ok[0].text.includes('m_1'))

  const bad = def.output.render({}, { ok: false, error: 'not_found', text: '没有这条' })
  assert.ok(bad[0].text.includes('not_found'))
  assert.ok(bad[0].text.includes('没有这条'))
})

test('注入注册：section 与 context 各一条，顺序与插值设置正确', () => {
  const ctx = fakeCtx()
  apply(ctx, { dir: tmpDir() })
  assert.equal(ctx._reg.sections.length, 1)
  assert.equal(ctx._reg.contexts.length, 1)

  const sec = ctx._reg.sections[0]
  assert.equal(sec.name, 'whale-memory')
  assert.equal(sec.order, ORDER.section)
  assert.equal(sec.interpolate, false)
  assert.equal(typeof sec.text, 'function')

  const con = ctx._reg.contexts[0]
  assert.equal(con.name, 'whale-memory')
  assert.equal(con.order, ORDER.context)
  assert.equal(con.interpolate, false)
  assert.equal(typeof con.text, 'function')
})

test('注入内容：写记忆后 context 能渲染出它', async () => {
  const ctx = fakeCtx()
  const dir = tmpDir()
  apply(ctx, { dir })

  await ctx._reg.tools.get('remember').execute({ text: '主人不吃辣', alpha: 1.0 })
  const text = ctx._reg.contexts[0].text()
  assert.ok(text.includes('不吃辣'), `实际内容：${text}`)
  assert.ok(text.includes('不是指令'))
})

test('开关能真正卸载：dispose 后工具与注入都没了', async () => {
  const ctx = fakeCtx()
  const dispose = apply(ctx, { dir: tmpDir() })

  assert.equal(ctx._reg.tools.size, 9)
  assert.equal(ctx._reg.sections.length, 1)
  assert.equal(ctx._reg.contexts.length, 1)

  // 走 Cordis 的 dispose 事件（真实卸载路径）
  for (const hook of ctx._reg.disposeHooks) hook()

  assert.equal(ctx._reg.sections.length, 0, 'section 应被撤掉')
  assert.equal(ctx._reg.contexts.length, 0, 'context 应被撤掉')

  // 显式 dispose 也必须幂等
  dispose()
  dispose()
})

test('加载失败不影响宿主：目录非法时 apply 不抛', () => {
  const ctx = fakeCtx()
  // 用一个必然不能当目录的路径（已存在的普通文件）
  const f = path.join(tmpDir(), 'not-a-dir')
  fs.writeFileSync(f, 'x')

  assert.doesNotThrow(() => {
    apply(ctx, { dir: f })
  })
})

test('缺少服务时 apply 也不炸（防御性）', () => {
  // 完全空的 ctx：工具注册会失败，但必须只记日志
  assert.doesNotThrow(() => apply({}, { dir: tmpDir() }))
})

test('makeStateProvider：常驻层进 pinned，其余按 alpha 取前几条', async () => {
  const store = createStore({ dir: tmpDir(), now: () => NOW })
  const tools = createTools({ store, clock: () => NOW })
  tools.remember({ text: '常驻的一条', alpha: 1.0 })
  tools.remember({ text: '普通的一条', alpha: 0.5 })

  const getState = makeStateProvider({ store, now: () => NOW })
  const st = getState()
  assert.equal(st.pinned.length, 1)
  assert.equal(st.pinned[0].text, '常驻的一条')
  assert.equal(st.hits.length, 1)
  assert.equal(st.now, NOW)
})

test('defaultDir 落在 .dsh 下', () => {
  const d = defaultDir('C:/Users/x')
  assert.ok(d.includes('.dsh'))
  assert.ok(d.includes('whale-memory-v2'))
})
