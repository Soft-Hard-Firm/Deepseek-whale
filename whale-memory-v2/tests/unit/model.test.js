import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEntry,
  validateEntry,
  transition,
  canTransition,
  isTerminal,
  shouldInject,
  isPositiveEvidence,
  isSearchable,
  markUsed,
  pinnedCount,
  canPin,
  deriveSummary,
  ModelError,
  PINNED_CAP,
  ALPHA_PIN,
} from '../../lib/model.js'

const NOW = Date.parse('2026-11-15T05:00:00+08:00')

const base = (over = {}) =>
  normalizeEntry({ text: '一条事实', ...over }, { now: NOW, seq: 1 })

test('补默认值：不传的都填上', () => {
  const e = base()
  assert.equal(e.layer, 'user')
  assert.equal(e.project, '全局')
  assert.equal(e.status, 'active')
  assert.equal(e.alpha, 0.5)
  assert.equal(e.beta, 0.7)
  assert.equal(e.evidence, 'explicit')
  assert.equal(e.source, 'explicit')
  assert.equal(e.schemaVersion, 1)
  assert.deepEqual(e.encodings, [NOW])
})

test('摘要：没给就从正文兜一个', () => {
  const e = base({ text: '主人讨厌别人拿「肥」当字面意思开玩笑。后面还有' })
  assert.equal(e.summary, '主人讨厌别人拿「肥」当字面意思开玩笑')
  assert.equal(deriveSummary(''), '')
})

test('校验：空正文、超长正文、非法层、越界 alpha/beta', () => {
  assert.throws(() => normalizeEntry({ text: '   ' }, { now: NOW }), (e) => e.code === 'empty_text')
  assert.throws(
    () => normalizeEntry({ text: '字'.repeat(601) }, { now: NOW }),
    (e) => e.code === 'text_too_long',
  )
  assert.throws(() => base({ layer: 'nope' }), (e) => e.code === 'invalid_layer')
  assert.throws(() => base({ alpha: 1.5 }), (e) => e.code === 'invalid_alpha')
  assert.throws(() => base({ beta: -2 }), (e) => e.code === 'invalid_beta')
  assert.throws(() => base({ status: 'gone' }), (e) => e.code === 'invalid_status')
})

test('校验：最大正文长度按码点算，不按 UTF-16 单元', () => {
  // 600 个 emoji（每个 2 个 UTF-16 单元）应该通过
  const emoji = '🐋'.repeat(600)
  assert.doesNotThrow(() => normalizeEntry({ text: emoji }, { now: NOW }))
  // 601 应该被挡
  assert.throws(
    () => normalizeEntry({ text: '🐋'.repeat(601) }, { now: NOW }),
    (e) => e.code === 'text_too_long',
  )
})

test('状态机：合法转移全表', () => {
  const ok = [
    ['candidate', 'active'],
    ['candidate', 'archived'],
    ['active', 'superseded'],
    ['active', 'invalidated'],
    ['active', 'contested'],
    ['active', 'archived'],
    ['contested', 'active'],
    ['contested', 'superseded'],
    ['contested', 'invalidated'],
    ['archived', 'active'],
  ]
  for (const [from, to] of ok) assert.equal(canTransition(from, to), true, `${from}->${to}`)
})

test('状态机：非法转移被拒', () => {
  const bad = [
    ['superseded', 'active'],
    ['invalidated', 'active'],
    ['candidate', 'superseded'],
    ['active', 'candidate'],
  ]
  for (const [from, to] of bad) assert.equal(canTransition(from, to), false, `${from}->${to}`)
})

test('状态机：终态判定', () => {
  assert.equal(isTerminal('superseded'), true)
  assert.equal(isTerminal('invalidated'), true)
  assert.equal(isTerminal('active'), false)
  assert.equal(isTerminal('archived'), false)
})

test('transition：取代记时间，纠正记来源，激活记时间轴', () => {
  const a = base({ status: 'active' })
  const sup = transition(a, 'superseded', { now: NOW + 1000 })
  assert.equal(sup.status, 'superseded')
  assert.equal(sup.supersededAt, NOW + 1000)

  const inv = transition(a, 'invalidated', { now: NOW + 2000, by: 'user' })
  assert.equal(inv.status, 'invalidated')
  assert.equal(inv.invalidatedBy, 'user')

  const cand = base({ status: 'candidate' })
  const act = transition(cand, 'active', { now: NOW + 3000 })
  assert.equal(act.status, 'active')
  assert.equal(act.activationAnchor, NOW + 3000)
})

test('transition：非法转移抛 bad_transition，且不改原对象', () => {
  const sup = base({ status: 'superseded' })
  assert.throws(
    () => transition(sup, 'active', { now: NOW }),
    (e) => e.code === 'bad_transition',
  )
  assert.equal(sup.status, 'superseded')
})

test('不变式：candidate 不注入，superseded/invalidated/archived 不注入', () => {
  for (const s of ['candidate', 'superseded', 'invalidated', 'archived']) {
    assert.equal(shouldInject({ status: s }), false, s)
  }
  assert.equal(shouldInject({ status: 'active' }), true)
  assert.equal(shouldInject({ status: 'contested' }), true)
})

test('不变式：被纠正的不能当正面证据，但仍可检索', () => {
  assert.equal(isPositiveEvidence({ status: 'active' }), true)
  assert.equal(isPositiveEvidence({ status: 'contested' }), true)
  assert.equal(isPositiveEvidence({ status: 'invalidated' }), false)
  assert.equal(isPositiveEvidence({ status: 'superseded' }), false)

  for (const s of ['active', 'contested', 'superseded', 'invalidated', 'archived', 'candidate']) {
    assert.equal(isSearchable({ status: s }), true, s)
  }
})

test('记一次被用到：hits+1、lastHit、encodings 追加', () => {
  const e = base()
  const used = markUsed(e, NOW + 5000)
  assert.equal(used.hits, 1)
  assert.equal(used.lastHit, NOW + 5000)
  assert.deepEqual(used.encodings, [NOW, NOW + 5000])
  // 原对象不变
  assert.equal(e.hits, 0)
})

test('常驻层：满额后拒绝，不挤已有条目', () => {
  const entries = Array.from({ length: PINNED_CAP }, (_, i) => ({
    id: `m${i}`,
    status: 'active',
    alpha: ALPHA_PIN,
  }))
  assert.equal(pinnedCount(entries), PINNED_CAP)
  assert.equal(canPin(entries), false)
  assert.equal(canPin(entries.slice(1)), true)

  // 归档的不占常驻名额
  const withArchived = [
    ...entries.slice(1),
    { id: 'x', status: 'archived', alpha: ALPHA_PIN },
  ]
  assert.equal(pinnedCount(withArchived), PINNED_CAP - 1)
  assert.equal(canPin(withArchived), true)
})

test('validateEntry：缺 id、坏类型被拒', () => {
  const good = base()
  assert.equal(validateEntry(good), true)

  assert.throws(() => validateEntry({ ...good, id: '' }), (e) => e.code === 'missing_id')
  assert.throws(() => validateEntry({ ...good, keywords: '不是数组' }), (e) => e.code === 'invalid_keywords')
  assert.throws(() => validateEntry({ ...good, status: 'x' }), (e) => e.code === 'invalid_status')
  assert.throws(() => validateEntry(null), (e) => e.code === 'bad_entry')
})
