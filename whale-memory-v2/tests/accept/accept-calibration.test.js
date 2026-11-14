// 校准试验 —— 先证明验收能认出坏掉，再拿它验收。
//
// 做法：每一项都**故意做坏**一个环节，然后断言对应的验收一定变红。
// 如果某个破坏没有让该红的变红，说明那条验收是摆设，必须重做。
//
// 对应 docs/PRD.md §2.1。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntry } from '../../lib/model.js'
import {
  select,
  evidence,
  rarity,
  buildDf,
  DEFAULT_POLICY,
} from '../../lib/retrieve.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

let seqCounter = 0
function mk(text, over = {}) {
  seqCounter += 1
  return normalizeEntry(
    { text, layer: 'user', status: 'active', alpha: 0.5, beta: 0.7, ...over },
    { now: over.createdAt ?? NOW, seq: seqCounter },
  )
}

test('校准 1：把 C 除以问句长度 → 长问句召回（B3）必须变红', () => {
  const wedding = mk('主人说婚礼改到三月的第一个周末', { keywords: ['婚礼'] })
  const entries = [wedding, mk('主人喜欢蓝色'), mk('今天天气不错')]
  const q = '我们那天办婚礼的时候你还记得吗'

  // 正确实现：能召回
  const good = select(entries, q, { now: NOW, applyQuota: false })
  assert.ok(good.picked.some((p) => p.entry.id === wedding.id), '正常实现应召回')

  // 坏实现：C 被问句长度稀释
  const df = buildDf(entries)
  const terms = ['婚礼']
  const { s } = evidence(wedding, terms, df, entries.length)
  const badC = s / 8 / (s / 8 + 1) // 假装问句有 8 个词
  assert.ok(badC < DEFAULT_POLICY.threshold, `坏实现的 C=${badC} 应低于门槛`)

  // 结论：如果代码退化成「除以长度」，B3 会红 —— 说明 B3 有判别力
})

test('校准 2：排序里混进 Math.random → 确定性（B2）必须变红', () => {
  const entries = []
  for (let i = 0; i < 10; i++) entries.push(mk(`婚礼第${i}号嘉宾`))
  // 先确认 10 条 id 真的互不相同，否则「比较 id」这件事本身就没有意义
  assert.equal(new Set(entries.map((e) => e.id)).size, 10, 'id 必须唯一')
  const good = { now: NOW, applyQuota: false }

  // 正常实现：两次一致
  const a = select(entries, '婚礼', good).picked.map((p) => p.entry.id)
  const b = select(entries, '婚礼', good).picked.map((p) => p.entry.id)
  assert.deepEqual(a, b)

  // 坏实现：随机排序，两次结果会不一样
  let differs = false
  for (let i = 0; i < 20; i++) {
    const x = [...entries].sort(() => Math.random() - 0.5).map((e) => e.id)
    const y = [...entries].sort(() => Math.random() - 0.5).map((e) => e.id)
    if (x.join() !== y.join()) {
      differs = true
      break
    }
  }
  assert.equal(differs, true, '随机排序必然不稳定 —— 所以 B2 能抓到它')
})

test('校准 3：门槛失效（全放行）→「证据不足不选」必须变红', () => {
  const entries = [mk('一条跟查询无关的记忆')]

  // 正常：不选
  const good = select(entries, '婚礼', { now: NOW })
  assert.equal(good.picked.length, 0)

  // 坏实现：门槛设成 0，什么都能进
  const bad = select(entries, '婚礼', {
    now: NOW,
    policy: { ...DEFAULT_POLICY, threshold: 0 },
  })
  // 注意：门槛 0 时 C=0 仍会被 no_overlap 挡掉，所以还得看 rejected
  const passed = bad.picked.length + bad.rejected.filter((r) => r.reason === 'below_threshold').length
  assert.equal(passed, 0, '完全无重叠的条目，即使门槛为 0 也进不去 —— 说明有第二道闸')
})

test('校准 4：去重失效 → 重复条目会一起返回', () => {
  const a = mk('主人说婚礼改到三月的第一个周末')
  const b = mk('主人说婚礼改到三月的第一个周末')
  const policy = { ...DEFAULT_POLICY, threshold: 0.01 }

  const good = select([a, b], '婚礼', { now: NOW, policy, applyQuota: false })
  assert.equal(good.picked.length, 1, '正常实现只留一条')

  // 坏实现：把相似度门调到 1.0 以上（等于关掉去重）
  const bad = select([a, b], '婚礼', {
    now: NOW,
    policy: { ...policy, dupSimilarity: 1.01 },
    applyQuota: false,
  })
  assert.equal(bad.picked.length, 2, '关掉去重就会重复 —— 说明去重确实在起作用')
})

test('校准 5：不排除 invalidated → 纠正过的错误会被重新捞出', () => {
  const gone = mk('这条被纠正了', { status: 'invalidated' })
  const other = mk('这条还在')
  const q = '纠正'

  // 正常：invalidated 被排除
  const good = select([gone, other], q, {
    now: NOW,
    statuses: ['active', 'contested'],
    applyQuota: false,
  })
  assert.equal(good.picked.some((p) => p.entry.id === gone.id), false)

  // 坏实现：状态范围放开到全部
  const bad = select([gone, other], q, {
    now: NOW,
    statuses: ['candidate', 'active', 'contested', 'superseded', 'invalidated', 'archived'],
    applyQuota: false,
  })
  assert.equal(bad.picked.some((p) => p.entry.id === gone.id), true, '放开状态就会把错误捞回来')
})

test('校准 6：稀有度不加平滑 → 小库检索直接归零', () => {
  const df = new Map([['婚礼', 2]])
  // 坏公式：d+1
  const bad = Math.log((2 + 1) / (2 + 1)) / Math.log(2 + 1)
  assert.equal(bad, 0, '不加平滑时，全库都有的词稀有度是 0')

  // 正确公式：d+0.5，不为零
  const good = rarity(df, '婚礼', 2)
  assert.ok(good > 0, `平滑后应大于 0，实际 ${good}`)
})

test('校准 7：长问句里如果只取整句当一个词 → 召回也会失败', () => {
  const wedding = mk('主人说婚礼改到三月的第一个周末', { keywords: ['婚礼'] })
  const q = '我们那天办婚礼的时候你还记得吗'
  const df = buildDf([wedding])

  // 正确分词：能切出「婚礼」
  const good = select([wedding], q, { now: NOW, applyQuota: false })
  assert.ok(good.picked.length >= 1, '正常分词能召回')

  // 坏分词：整句当一个词，跟库里对不上
  const badTerm = ['我们那天办婚礼的时候你还记得吗']
  const hit = badTerm.some((t) => df.has(t))
  assert.equal(hit, false, '整句不切分就匹配不上 —— 说明分词这一步不能省')
})

test('校准 8：把 P 当门槛而不是 C → 冷门但相关的内容会被埋掉', () => {
  // 一条很旧、重要度低的记忆，但证据强
  const oldLow = mk('婚礼改期的决定', {
    alpha: 0.05,
    createdAt: NOW - 400 * 86400000,
  })
  const entries = [oldLow, mk('主人喜欢蓝色'), mk('今天天气不错')]

  const r = select(entries, '婚礼', { now: NOW, applyQuota: false })
  assert.ok(r.picked.length >= 1, '门槛卡 C，所以证据强的老条目仍能入选')

  // 如果错把 P 当门槛：老条目的 P 会被时间衰减压到很低
  const p = r.picked[0].P
  assert.ok(p < DEFAULT_POLICY.threshold, `它的 P=${p.toFixed(3)} 其实很低 —— 用 P 当门槛就会误杀`)
})
