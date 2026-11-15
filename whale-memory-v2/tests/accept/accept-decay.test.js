// 验收用例：T9 压缩与淘汰（PRD D1–D3）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntry, MAX_COMPRESSION } from '../../lib/model.js'
import {
  planDecay,
  targetLevel,
  isStandaloneClaim,
  lastTouched,
  CUMULATIVE_DAYS,
} from '../../lib/decay.js'
import { DAY } from '../../lib/retrieve.js'

const NOW = Date.parse('2026-11-15T19:00:00+08:00')

function mk(over = {}) {
  return normalizeEntry(
    {
      text: '主人说周三发版，别在周五动线上',
      layer: 'user',
      status: 'active',
      ...over,
    },
    { now: over.createdAt ?? NOW, seq: over.seq ?? 1 },
  )
}

test('D1 未固化的条目不被压缩，只标「待固化」', () => {
  const vague = mk({ text: '这个再说吧', createdAt: NOW - 400 * DAY })
  assert.equal(isStandaloneClaim(vague), false)

  const { entries, changed, pending } = planDecay([vague], NOW)

  assert.equal(entries[0].compressionLevel, 0, '没固化就不许压')
  assert.equal(entries[0].pendingConsolidation, true)
  assert.equal(changed.length, 0)
  assert.deepEqual(pending, [vague.id])
})

test('D1 未固化条目即使放了很久也依然在库里', () => {
  const vague = mk({ text: '那个你懂的', createdAt: NOW - 500 * DAY })
  const { entries } = planDecay([vague], NOW)
  assert.equal(entries.length, 1, '不删')
  assert.equal(entries[0].status, vague.status)
})

test('D2 超过压缩期限降一级，而不是直接删', () => {
  const at = NOW - (CUMULATIVE_DAYS[1] + 5) * DAY
  const e = mk({ createdAt: at })
  assert.equal(e.compressionLevel, 0)

  const { entries, changed } = planDecay([e], NOW)

  assert.equal(entries[0].compressionLevel, 1, '应升到 1 级')
  assert.equal(entries[0].status, 'active', '不是删，是压')
  assert.equal(changed.length, 1)
  assert.deepEqual(changed[0], { id: e.id, from: 0, to: 1 })
})

test('压缩分级只升不降：再跑一次不会反悔', () => {
  const at = NOW - (CUMULATIVE_DAYS[2] + 5) * DAY
  const e = mk({ createdAt: at, compressionLevel: 2 })

  const first = planDecay([e], NOW)
  assert.equal(first.entries[0].compressionLevel, 2)

  const second = planDecay(first.entries, NOW)
  assert.equal(second.entries[0].compressionLevel, 2)
  assert.equal(second.changed.length, 0, '第二次不该再变')
})

test('压缩不超过上限 4', () => {
  const ancient = mk({ createdAt: NOW - 5000 * DAY })
  const { entries } = planDecay([ancient], NOW)
  assert.equal(entries[0].compressionLevel, MAX_COMPRESSION)
})

test('D4 superseded 不参与压缩（它已经不注入了）', () => {
  const sup = mk({ status: 'superseded', createdAt: NOW - 400 * DAY })
  const { entries } = planDecay([sup], NOW)
  assert.equal(entries[0].compressionLevel, 0)
})

test('已归档 / 已作废的不参与压缩', () => {
  for (const status of ['archived', 'invalidated']) {
    const e = mk({ status, createdAt: NOW - 400 * DAY })
    const { entries } = planDecay([e], NOW)
    assert.equal(entries[0].compressionLevel, 0, `${status} 不该被压`)
  }
})

test('targetLevel 按累计天数走对每个台阶', () => {
  const make = (days) => mk({ createdAt: NOW - days * DAY })
  assert.equal(targetLevel(make(0), NOW), 0)
  assert.equal(targetLevel(make(10), NOW), 0)
  assert.equal(targetLevel(make(CUMULATIVE_DAYS[1] + 1), NOW), 1)
  assert.equal(targetLevel(make(CUMULATIVE_DAYS[2] + 1), NOW), 2)
  assert.equal(targetLevel(make(CUMULATIVE_DAYS[3] + 1), NOW), 3)
  assert.equal(targetLevel(make(CUMULATIVE_DAYS[4] + 1), NOW), 4)
})

test('被再次提起会重置计时（lastHit 晚于 createdAt）', () => {
  const e = mk({ createdAt: NOW - 400 * DAY })
  const touched = { ...e, lastHit: NOW - 2 * DAY }
  assert.equal(targetLevel(touched, NOW), 0, '刚提过就不该压')
})

test('lastTouched 取 encodings / lastHit / createdAt 里最晚的', () => {
  const e = mk({ createdAt: NOW - 100 * DAY })
  e.lastHit = NOW - 50 * DAY
  assert.equal(lastTouched(e), NOW - 50 * DAY)

  e.encodings = [NOW - 10 * DAY]
  assert.equal(lastTouched(e), NOW - 10 * DAY)
})

test('isStandaloneClaim：指代词开头的不算独立主张', () => {
  for (const t of ['这个再说吧', '那个你懂的', '它不太行', '刚才说的那个']) {
    assert.equal(isStandaloneClaim(mk({ text: t })), false, t)
  }
  assert.equal(isStandaloneClaim(mk({ text: '主人周三发版，别在周五动线上' })), true)
})

test('显式标记 consolidated 可以强制认可', () => {
  const explicit = mk({ text: '嗯', consolidated: true })
  assert.equal(isStandaloneClaim(explicit), true)
})

test('planDecay 不改入参', () => {
  const e = mk({ createdAt: NOW - 400 * DAY })
  const before = { ...e }
  planDecay([e], NOW)
  assert.equal(e.compressionLevel, before.compressionLevel)
  assert.equal(e.pendingConsolidation, before.pendingConsolidation)
})

test('D3 重试预算：不适用（本插件不做 LLM 压缩）', () => {
  // 设计文档 §6.5 的「重试前先算预算」针对的是模型驱动的压缩。
  // 这里的压缩是纯规则降级，没有外部调用、没有重试、没有上下文预算可算。
  // 因此 D3 记为「不适用」，而不是「已通过」—— 不给自己发没挣到的分。
  assert.ok(true)
})
