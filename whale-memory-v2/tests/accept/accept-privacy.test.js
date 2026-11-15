// 验收用例：T11 隐私脱敏（PRD E1）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../../lib/store.js'
import { createTools } from '../../lib/tools.js'
import { redact, hasSensitive } from '../../lib/privacy.js'

const NOW = Date.parse('2026-11-15T19:00:00+08:00')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-privacy-'))
  const store = createStore({ dir, now: () => NOW })
  return { store, tools: createTools({ store, clock: () => NOW }) }
}

test('E1 含密码的文本入库前被替换成占位符', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '主人说密码是 abc123xyz' })
  assert.equal(r.ok, true)
  assert.ok(r.redacted >= 1)

  const e = store.readAll().entries[0]
  assert.equal(e.text.includes('abc123xyz'), false, '密码不该进库')
  assert.ok(e.text.includes('[已脱敏:password]'))
  assert.ok(e.text.includes('密码是'), '交代语要留着，不然这句话没意义')
})

test('原文里也不能留明文', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '密码是 SuperSecret99' })
  const e = store.readAll().entries.find((x) => x.id === r.id)
  const original = store.readOriginal(e.sourceRef)
  assert.equal(original.text.includes('SuperSecret99'), false, '原文也得脱敏')
})

test('API key / token 被替换', () => {
  for (const sample of [
    'sk-abcdefghijklmnop1234',
    // 假的：拼出来，源码里不留完整 token（真的会被 GitHub secret scanning 拦下）
    'ghp_' + 'a'.repeat(24),
    'api_key: abcd1234efgh5678ijkl',
    'Authorization: Bearer abcdefghijklmnop123456',
  ]) {
    const { text, hits } = redact(`这是 ${sample} 记住`)
    assert.ok(hits.length >= 1, `${sample} 应被识别`)
    assert.equal(text.includes(sample.split(/[:\s]/).pop()), false, `${sample} 的密文不该留下`)
  }
})

test('手机号 / 身份证 / 银行卡被替换', () => {
  assert.ok(redact('电话是 13812345678').text.includes('[已脱敏:phone]'))
  assert.ok(redact('身份证 110101199003071234').text.includes('[已脱敏:idcard]'))
  assert.ok(redact('卡号 6222021234567890123').text.includes('[已脱敏:bankcard]'))
})

test('不误伤普通文本：时间、条数、版本号', () => {
  for (const safe of [
    '现在是 1794690517789 毫秒',
    '库里有 265 条记忆',
    '版本 0.1.0，日期 2026-11-15',
    'T1 到 T7 做完了',
  ]) {
    const { hits } = redact(safe)
    assert.equal(hits.length, 0, `不该误伤：${safe}`)
  }
})

test('hasSensitive 能当快速判断用', () => {
  assert.equal(hasSensitive('密码是 abc'), true)
  assert.equal(hasSensitive('主人喜欢蓝色'), false)
})

test('脱敏不影响条目其它字段', () => {
  const { store, tools } = fresh()
  const r = tools.remember({ text: '密码是 abc123，主人喜欢蓝色', keywords: ['蓝色'] })
  const e = store.readAll().entries.find((x) => x.id === r.id)
  assert.equal(e.layer, 'user')
  assert.deepEqual(e.keywords, ['蓝色'])
  assert.ok(e.summary.includes('主人喜欢蓝色') || e.summary.includes('蓝色'))
})
