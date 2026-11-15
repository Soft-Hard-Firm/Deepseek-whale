// 检索层：分词、两层稀有度、饱和评分、选条、去重。
//
// 口径见 docs/设计文档.md §5。
//
// P0 不建索引：直接线性扫描全部条目。规模策略见 §5.5。
//
// ⚠ 通用词表是**精简版**（见 COMMON_WORDS），不是完整中文词频。
//   它只用来压掉「表示」「正式」「今天」这类在通用中文里极常见的词，
//   不追求覆盖度。T13 换成完整词表前，别把它当精确依据。

export const DAY = 86400000

/** 分词：中文按 2 字滑窗，英文数字按整词。 */
export function tokenize(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const seg of s.split(/[\s\p{P}\p{S}]+/u)) {
    if (!seg) continue
    const chars = Array.from(seg)
    if (chars.length === 1) out.add(chars[0])
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * 精简高频词表 —— 只收那些「在通用中文里太常见、不配当线索」的词。
 * 不是停用词表，也不是完整词频；漏掉的词只是没被压，不会误伤。
 */
export const COMMON_WORDS = new Set([
  // 虚词与代词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就',
  '不', '人', '都', '一', '上', '也', '很', '到', '说', '要', '去', '会', '着', '没有',
  '看', '好', '自己', '这个', '那个', '什么', '怎么', '可以', '已经', '还是', '因为',
  '所以', '但是', '如果', '然后', '而且', '或者', '不过', '就是', '这样', '那样',
  // 常见实词（在通用中文里高频，但在记忆库里通常不是线索）
  '今天', '明天', '昨天', '现在', '刚才', '最近', '目前', '现在', '时候', '时间',
  '问题', '事情', '东西', '地方', '情况', '方式', '方法', '办法', '结果', '原因',
  '表示', '正式', '过后', '之前', '之后', '以上', '以下', '之间', '其中', '其他',
  '非常', '特别', '比较', '一样', '一些', '这些', '那些', '这里', '那里', '哪里',
  '需要', '应该', '可能', '觉得', '认为', '知道', '明白', '同意', '决定', '开始',
  '进行', '完成', '结束', '继续', '记得', '想起', '告诉', '回答', '问过',
])

/** 通用词：命中即不当线索。 */
export function isCommon(term) {
  return COMMON_WORDS.has(String(term))
}

/** 默认参数。全部可覆盖，测试里会改。 */
export const DEFAULT_POLICY = Object.freeze({
  baseline: 0.3,
  activationWeight: 1.0,
  importanceWeight: 0.8,
  emotionWeight: 0, // 数据契约暂无 emotion 字段，先留位置
  baseHalfLifeDays: 30,
  emotionHalfLifeDays: 30,
  threshold: 0.35,
  maxItems: 8,
  rarityK: 1.0,
  bodyPrice: 0.6, // 只在正文里命中的打折
  keywordPrice: 1.0, // 在 keywords / summary 里命中的全价
  dupSimilarity: 0.8,
  nearMissRatio: 0.75, // 全空时补「差一点」的线
})

/** 库内词频（df）。 */
export function buildDf(entries) {
  const df = new Map()
  for (const e of entries) {
    for (const t of tokenize(`${e.summary || ''} ${e.text || ''} ${(e.keywords || []).join(' ')}`)) {
      df.set(t, (df.get(t) || 0) + 1)
    }
  }
  return df
}

/**
 * 库内稀有度：这个词在整个库里有多罕见。0~1。
 *
 * 用 `d + 0.5` 平滑，不用 `d + 1`：小库里「全库都有的词」用后者会直接算成 0，
 * 整库检索一起失效。平滑后它仍然很低（≈0.17），但不为零。
 */
export function rarity(df, term, total) {
  const n = Math.max(1, total | 0)
  const d = df.get(term) || 0
  if (!d) return 0
  const v = Math.log((n + 1) / (d + 0.5)) / Math.log(n + 1)
  return v > 0 ? Math.min(1, v) : 0
}

/** 鲜活度：A0 × 2^(-天数/H)，H 随重要度延长。 */
export function activation(entry, now, policy = DEFAULT_POLICY) {
  const enc = Array.isArray(entry.encodings) && entry.encodings.length
    ? entry.encodings
    : [entry.createdAt || now]
  const last = Math.max(...enc)
  const days = Math.max(0, (now - last) / DAY)
  const H = policy.baseHalfLifeDays * (1 + 2 * (entry.alpha ?? 0.5))
  const A0 = 1
  return A0 * Math.pow(2, -days / H)
}

/**
 * 证据强度 C = s / (s + K)。
 * s 是命中词的稀有度之和 —— **不除以问句长度**。
 */
export function evidence(entry, queryTerms, df, total, policy = DEFAULT_POLICY) {
  const inKeywords = tokenize(`${(entry.keywords || []).join(' ')} ${entry.summary || ''}`)
  const inBody = tokenize(entry.text || '')
  let s = 0
  for (const q of queryTerms) {
    if (!inKeywords.has(q) && !inBody.has(q)) continue
    const price = inKeywords.has(q) ? policy.keywordPrice : policy.bodyPrice
    s += rarity(df, q, total) * price
  }
  return { s, C: s / (s + policy.rarityK) }
}

/** 总分 P = C × (基线 + 鲜活×A + 重要×α + 情绪×E)。 */
export function score(entry, queryTerms, df, total, now, policy = DEFAULT_POLICY) {
  const { s, C } = evidence(entry, queryTerms, df, total, policy)
  const A = activation(entry, now, policy)
  const E = 0 // 暂无 emotion 字段
  const alpha = entry.alpha ?? 0.5
  const P =
    C *
    (policy.baseline +
      policy.activationWeight * A +
      policy.importanceWeight * alpha +
      policy.emotionWeight * E)
  return { C, P, A, s }
}

/** 查句里哪些词能当线索：先过通用词表，再过库内 df 门。 */
export function pickQueryTerms(query, df, total, policy = DEFAULT_POLICY) {
  const raw = [...tokenize(query)]
  const multi = raw.filter((t) => Array.from(t).length > 1)
  const base = multi.length ? multi : raw

  // 第一道：通用中文里太常见的，不当线索
  const notCommon = base.filter((t) => !isCommon(t))

  // 第二道：库里 1% 以上出现的，不当线索
  const gate = Math.max(3, Math.floor(total * 0.01))
  const rare = notCommon.filter((t) => {
    const d = df.get(t) || 0
    return d > 0 && d <= gate
  })

  // 安全垫一：筛完不足 2 个 → 退回过通用门的
  // 安全垫二：筛完在库里一点证据都不值 → 也退回
  const worth = rare.some((t) => rarity(df, t, total) > 0)
  if (rare.length >= 2 && worth) return rare
  if (notCommon.length) return notCommon
  return base
}

/** 名额：最高分越高，允许给越多。纯函数，方便单独校准。 */
export function computeQuota(topP, policy = DEFAULT_POLICY) {
  if (topP >= 0.6) return policy.maxItems
  if (topP >= 0.5) return Math.min(4, policy.maxItems)
  if (topP >= 0.4) return Math.min(3, policy.maxItems)
  return 1
}

/** 词像度：共有词数 ÷ 短的那条的词数。 */
export function similarity(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0
  let common = 0
  for (const t of aSet) if (bSet.has(t)) common++
  return common / Math.min(aSet.size, bSet.size)
}

/**
 * 选条。
 * @returns {{ picked: Array<{entry, C, P, A}>, rejected: Array<{entry, reason}> }}
 */
/**
 * 这条在 `at` 那一刻**是否有效**。
 *
 * 「有效」= 那时已经产生、且那时还没被取代 / 作废。
 *
 * 只认有时间的失效标记。`archived` 没有时间戳，一律当成一直有效 ——
 * 归档是「不再注入」，不是「当时就不成立」。
 */
export function effectiveAt(entry, at) {
  if (!entry || !Number.isFinite(at)) return false
  if (!Number.isFinite(entry.createdAt) || entry.createdAt > at) return false
  if (Number.isFinite(entry.supersededAt) && entry.supersededAt <= at) return false
  if (Number.isFinite(entry.invalidatedAt) && entry.invalidatedAt <= at) return false
  return true
}

export function select(
  entries,
  query,
  {
    now,
    policy = DEFAULT_POLICY,
    layer,
    project,
    // 注入只看 active/contested；检索还要能翻到 superseded / archived（PRD A4/A6）
    statuses = ['active', 'contested'],
    applyQuota = true,
    // 给了 asOf 就是「查那一刻有效的事实」，不看现在的状态
    asOf,
  } = {},
) {
  const t = Number.isFinite(now) ? now : Date.now()
  // 时刻查询时，评分的时间基准也用那一刻：衰减该按「站在那时看」
  const scoreAt = Number.isFinite(asOf) ? asOf : t

  const pool = entries.filter((e) => {
    if (Number.isFinite(asOf)) {
      if (!effectiveAt(e, asOf)) return false
    } else if (!statuses.includes(e.status)) {
      return false
    }
    if (layer && e.layer !== layer) return false
    if (project && e.project !== project) return false
    return true
  })

  const df = buildDf(pool)
  const total = pool.length
  const terms = pickQueryTerms(query, df, total, policy)
  if (!terms.length) return { picked: [], rejected: [], terms: [] }

  const rejected = []
  const candidates = []
  for (const e of pool) {
    const sc = score(e, terms, df, total, scoreAt, policy)
    if (sc.C <= 0) {
      rejected.push({ entry: e, reason: 'no_overlap' })
      continue
    }
    // 门槛卡 C，不卡 P
    if (sc.C < policy.threshold) {
      rejected.push({ entry: e, reason: 'below_threshold', C: sc.C, P: sc.P })
      continue
    }
    candidates.push({ entry: e, ...sc })
  }

  // 全空时补一条「差一点」
  if (!candidates.length) {
    let near = null
    for (const r of rejected) {
      if (r.reason !== 'below_threshold') continue
      if (r.C < policy.threshold * policy.nearMissRatio) continue
      if (!near || r.P > near.P) near = r
    }
    if (near) candidates.push({ entry: near.entry, C: near.C, P: near.P, A: 0, nearMiss: true })
  }

  // 按 P 排序（确定性：同分按 createdAt 降序，再按 id）
  candidates.sort(
    (a, b) =>
      b.P - a.P ||
      (b.entry.createdAt || 0) - (a.entry.createdAt || 0) ||
      String(a.entry.id).localeCompare(String(b.entry.id)),
  )

  // 去重：几乎一样的只留分高的（名额分配之前）
  const kept = []
  for (const c of candidates) {
    const set = tokenize(c.entry.text || '')
    const dup = kept.find((k) => similarity(set, k._set) >= policy.dupSimilarity)
    if (dup) continue
    kept.push({ ...c, _set: set })
  }

  // 名额跟着最高分走 —— 这是**注入**策略，检索不走这条（applyQuota=false）
  const top = kept.length ? kept[0].P : 0
  const quota = applyQuota ? computeQuota(top, policy) : policy.maxItems

  const picked = kept.slice(0, quota).map(({ _set, ...rest }) => rest)
  return { picked, rejected: rejected.filter((r) => !picked.some((p) => p.entry.id === r.entry.id)), terms }
}
