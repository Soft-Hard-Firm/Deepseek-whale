import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize,
  isCommon,
  rarity,
  buildDf,
  activation,
  evidence,
  score,
  pickQueryTerms,
  similarity,
  select,
  computeQuota,
  DEFAULT_POLICY,
  DAY,
} from '../../lib/retrieve.js'
import { normalizeEntry } from '../../lib/model.js'

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

function mk(text, over = {}) {
  return normalizeEntry(
    { text, layer: 'user', status: 'active', alpha: 0.5, beta: 0.7, ...over },
    { now: over.createdAt ?? NOW, seq: 1 },
  )
}

test('tokenize：中文出 2 字滑窗，英文数字按整词', () => {
  const t = tokenize('发布窗口 npm')
  assert.equal(t.has('发布'), true)
  assert.equal(t.has('布窗'), true)
  assert.equal(t.has('窗口'), true)
  assert.equal(t.has('发'), false, '多字片段不单独出单字')
  assert.equal(t.has('npm'), false, '英文按 bigram 切')
  assert.equal(t.has('np'), true)
  assert.equal(t.has('pm'), true)
})

test('isCommon：通用词不当线索，专名照常', () => {
  assert.equal(isCommon('表示'), true)
  assert.equal(isCommon('正式'), true)
  assert.equal(isCommon('今天'), true)
  assert.equal(isCommon('婚礼'), false)
  assert.equal(isCommon('鲸鱼'), false)
})

test('rarity：小库里全库都有的词不为 0（平滑过）', () => {
  const df = new Map([['常见', 2]])
  const r = rarity(df, '常见', 2)
  assert.ok(r > 0, `应大于 0，实际 ${r}`)
  assert.ok(r < 0.3, `应很低，实际 ${r}`)
})

test('rarity：罕见词明显高于常见词', () => {
  const df = new Map([['婚礼', 1], ['主人', 50]])
  const rare = rarity(df, '婚礼', 100)
  const common = rarity(df, '主人', 100)
  assert.ok(rare > common)
  assert.ok(rare > 0.7)
})

test('rarity：库里没出现的词算 0', () => {
  assert.equal(rarity(new Map(), '量子', 10), 0)
})

test('activation：重要度越高，淡得越慢', () => {
  const old = NOW - 60 * DAY
  const low = mk('低重要度', { alpha: 0.1, createdAt: old })
  const high = mk('高重要度', { alpha: 1, createdAt: old })
  const aLow = activation(low, NOW)
  const aHigh = activation(high, NOW)
  assert.ok(aHigh > aLow, `${aHigh} 应大于 ${aLow}`)
})

test('activation：同一天创建的条目接近 1', () => {
  const e = mk('刚写的')
  const a = activation(e, NOW)
  assert.ok(a > 0.95)
})

test('evidence：不除以查询词数（长问句只要命中稀有词，C 不被稀释）', () => {
  const e = mk('主人说婚礼改到三月', { keywords: ['婚礼'] })
  const df = buildDf([e])
  const short = evidence(e, ['婚礼'], df, 1)
  const long = evidence(e, ['婚礼', '量子', '喵喵', '哔哔'], df, 1)
  assert.equal(long.C, short.C, '多出来的无关词不该拉低 C')
})

test('evidence：关键词命中比正文命中权重高', () => {
  // 手工构造：summary 必须显式控制，否则 deriveSummary 会把正文也带进关键词通道
  const base = {
    layer: 'user', status: 'active', alpha: 0.5, beta: 0.7,
    text: '主人说婚礼改到三月', createdAt: NOW, encodings: [NOW], id: 'x',
  }
  const kw = { ...base, summary: '婚礼', keywords: ['婚礼'] }
  const body = { ...base, summary: '别的', keywords: [] }
  const df = buildDf([kw, body])
  const a = evidence(kw, ['婚礼'], df, 2)
  const b = evidence(body, ['婚礼'], df, 2)
  assert.ok(a.C > b.C, `关键词命中 ${a.C} 应高于正文命中 ${b.C}`)
})

test('pickQueryTerms：通用词被压掉', () => {
  const entries = [mk('今天天气不错'), mk('主人说明天开会')]
  const df = buildDf(entries)
  const terms = pickQueryTerms('今天会议表示什么', df, entries.length)
  assert.equal(terms.includes('表示'), false)
  assert.equal(terms.includes('今天'), false)
})

test('pickQueryTerms：筛不到东西时退回，不让检索空转', () => {
  const entries = [mk('主人喜欢蓝色')]
  const df = buildDf(entries)
  const terms = pickQueryTerms('表示正式今天', df, entries.length)
  assert.ok(terms.length > 0, '全被压掉时要退回一批，不能返回空')
})

test('similarity：共有词占短的那条的比例', () => {
  const a = tokenize('主人说周三发版')
  const b = tokenize('主人说周三发版了')
  assert.ok(similarity(a, b) > 0.8)
  const c = tokenize('完全不相干的内容')
  assert.equal(similarity(a, c), 0)
})

test('select：门槛卡 C，不卡 P —— 证据不足直接不选', () => {
  const entries = [mk('一条跟查询无关的记忆')]
  const { picked } = select(entries, '婚礼', { now: NOW })
  assert.equal(picked.length, 0)
})

test('select：全空时补一条「差一点」', () => {
  // 造一个正好落在门槛 75%~100% 之间的：词在 keywords 里全价，但库大使稀有度偏低
  const entries = []
  for (let i = 0; i < 200; i++) entries.push(mk(`填充条目第${i}条`))
  const target = mk('婚礼改到三月', { keywords: ['婚礼'] })
  entries.push(target)

  const policy = { ...DEFAULT_POLICY, threshold: 0.55 }
  const { picked } = select(entries, '婚礼', { now: NOW, policy })
  // threshold 0.55 必过不了（C≈0.48），但 C 在 0.75*0.55=0.4125 以上，应触发补录
  assert.equal(picked.length, 1)
  assert.equal(picked[0].nearMiss, true)
})

test('select：名额跟着最高分走（applyQuota=true）', () => {
  const entries = []
  for (let i = 0; i < 20; i++) entries.push(mk(`婚礼第${i}号嘉宾到场`))
  const policy = { ...DEFAULT_POLICY, threshold: 0.01, maxItems: 8 }
  const { picked } = select(entries, '婚礼', { now: NOW, policy, applyQuota: true })
  assert.ok(picked.length <= 8)
  assert.ok(picked.length > 0)
})

test('computeQuota：分数越高，允许给的名额越多', () => {
  const policy = { ...DEFAULT_POLICY, maxItems: 8 }
  assert.equal(computeQuota(0.62, policy), 8)
  assert.equal(computeQuota(0.55, policy), 4)
  assert.equal(computeQuota(0.42, policy), 3)
  assert.equal(computeQuota(0.1, policy), 1)
})

test('computeQuota：maxItems 小于档位时不会超出上限', () => {
  const policy = { ...DEFAULT_POLICY, maxItems: 2 }
  assert.equal(computeQuota(0.62, policy), 2)
  assert.equal(computeQuota(0.55, policy), 2)
  assert.equal(computeQuota(0.42, policy), 2)
})

test('select：几乎一样的条目只留一条', () => {
  const a = mk('主人说婚礼改到三月的第一个周末', { alpha: 0.9 })
  const b = mk('主人说婚礼改到三月的第一个周末', { alpha: 0.1 })
  const policy = { ...DEFAULT_POLICY, threshold: 0.01 }
  const { picked } = select([a, b], '婚礼', { now: NOW, policy, applyQuota: false })
  assert.equal(picked.length, 1, '去重后应只剩一条')
  assert.equal(picked[0].entry.alpha, 0.9, '应留分高的那条')
})

test('B2 确定性：同样输入跑两次，顺序与结果完全一致', () => {
  const entries = []
  for (let i = 0; i < 12; i++) entries.push(mk(`婚礼第${i}号嘉宾`, { alpha: 0.5 }))
  const opts = { now: NOW, applyQuota: false }
  const r1 = select(entries, '婚礼', opts)
  const r2 = select(entries, '婚礼', opts)
  assert.deepEqual(
    r1.picked.map((p) => p.entry.id),
    r2.picked.map((p) => p.entry.id),
  )
})

test('B3 长问句里含关键实体，能召回到那条', () => {
  const wedding = mk('主人说婚礼改到三月的第一个周末', { keywords: ['婚礼'] })
  const other = mk('主人喜欢蓝色')
  const noise = mk('今天天气不错')
  const q = '我们那天办婚礼的时候你还记得吗'
  const { picked } = select([wedding, other, noise], q, { now: NOW, applyQuota: false })
  assert.ok(picked.some((p) => p.entry.id === wedding.id), '长问句里的实体要能召回')
})

test('B4 小库只有 3 条时，短问句不会一条都想不起来', () => {
  const wedding = mk('主人说婚礼改到三月的第一个周末', { keywords: ['婚礼'] })
  const entries = [wedding, mk('主人喜欢蓝色'), mk('今天天气不错')]
  const { picked } = select(entries, '婚礼', {
    now: NOW,
    policy: { ...DEFAULT_POLICY, threshold: 0.15 },
  })
  assert.ok(picked.length >= 1, '小库检索不能空手而归')
})

test('select：invalidated 不出现在检索结果里', () => {
  const gone = mk('这条被纠正了', { status: 'invalidated' })
  const good = mk('这条还在')
  const { picked } = select([gone, good], '纠正', {
    now: NOW,
    statuses: ['active', 'contested'],
    applyQuota: false,
  })
  assert.equal(picked.some((p) => p.entry.id === gone.id), false)
})
