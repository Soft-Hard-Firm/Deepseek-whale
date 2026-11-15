// 数据模型：字段校验、状态转移、注入与检索的准入判断。
//
// 口径见 docs/数据契约.md §2、docs/设计文档.md §2。

export const LAYERS = Object.freeze(['user', 'project', 'knowledge', 'working'])
export const STATUSES = Object.freeze([
  'candidate',
  'active',
  'contested',
  'superseded',
  'invalidated',
  'archived',
])
export const EVIDENCES = Object.freeze(['explicit', 'engage', 'passive'])
export const SOURCES = Object.freeze(['explicit', 'model', 'import'])

export const MAX_TEXT_CHARS = 600
export const MAX_SUMMARY_CHARS = 60
export const PINNED_CAP = 30

/** 压缩等级上限（4 = 只留一行目录，条目不删）。 */
export const MAX_COMPRESSION = 4
export const ALPHA_PIN = 1.0

export class ModelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ModelError'
    this.code = code
  }
}

// 状态转移表。空数组 = 终态（不可再转）。
const TRANSITIONS = Object.freeze({
  candidate: ['active', 'archived'],
  active: ['superseded', 'invalidated', 'contested', 'archived'],
  contested: ['active', 'superseded', 'invalidated'],
  superseded: [],
  invalidated: [],
  archived: ['active'],
})

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/** 终态：不会再变。 */
export function isTerminal(status) {
  const allowed = TRANSITIONS[status]
  return Array.isArray(allowed) && allowed.length === 0
}

/** 能不能进注入面。 */
export function shouldInject(entry) {
  return entry?.status === 'active' || entry?.status === 'contested'
}

/** 能不能当正面证据用（被纠正/被取代的不算）。 */
export function isPositiveEvidence(entry) {
  return entry?.status === 'active' || entry?.status === 'contested'
}

/** 能不能出现在检索结果里（被纠正仍可追溯）。 */
export function isSearchable(entry) {
  return STATUSES.includes(entry?.status)
}

function countChars(s) {
  return Array.from(String(s)).length
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 生成条目 id。用注入的 now。 */
export function makeId(now, seq) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  return `m_${day}_${String(seq).padStart(4, '0')}`
}

/** 从正文兜一个摘要（判断相关性用，不是正文的替代）。 */
export function deriveSummary(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const head = s.split(/[。！？!?；;]/)[0] || s
  return Array.from(head).slice(0, MAX_SUMMARY_CHARS).join('')
}

/**
 * 补默认值并做基础校验，返回一个完整条目。
 * 不合法抛 ModelError。
 */
export function normalizeEntry(input, { now, seq = 0 } = {}) {
  if (input == null || typeof input !== 'object') {
    throw new ModelError('bad_entry', '条目必须是对象')
  }
  const nowMs = isFiniteNumber(now) ? now : Date.now()

  // 时间锚点：这件事**什么时候发生的**，不是「什么时候写进来的」。
  // 流水线整理历史会话时必须给，否则「用户那天说明天去杭州」会被记成写入当天的事。
  let t = nowMs
  if (input.createdAt !== undefined && input.createdAt !== null) {
    if (!isFiniteNumber(input.createdAt)) {
      throw new ModelError('invalid_time', 'createdAt 必须是毫秒时间戳')
    }
    if (input.createdAt < 0) throw new ModelError('invalid_time', 'createdAt 不能是负数')
    // 允许一点时钟偏差，但明显在未来就是调用方搞错了
    if (input.createdAt > nowMs + 24 * 3600 * 1000) {
      throw new ModelError('invalid_time', 'createdAt 在未来，可能是把秒当成了毫秒')
    }
    t = input.createdAt
  }

  const text = String(input.text ?? '')
  if (!text.trim()) throw new ModelError('empty_text', '正文不能为空')
  if (countChars(text) > MAX_TEXT_CHARS) {
    throw new ModelError('text_too_long', `正文超过 ${MAX_TEXT_CHARS} 字，请拆分`)
  }

  const layer = input.layer ?? 'user'
  if (!LAYERS.includes(layer)) throw new ModelError('invalid_layer', `层名非法：${layer}`)

  const status = input.status ?? 'active'
  if (!STATUSES.includes(status)) throw new ModelError('invalid_status', `状态非法：${status}`)

  const alpha = isFiniteNumber(input.alpha) ? input.alpha : 0.5
  if (alpha < 0 || alpha > 1) throw new ModelError('invalid_alpha', 'alpha 必须在 0~1')

  const beta = isFiniteNumber(input.beta) ? input.beta : 0.7
  if (beta < -1 || beta > 1) throw new ModelError('invalid_beta', 'beta 必须在 -1~1')

  const evidence = input.evidence ?? 'explicit'
  if (!EVIDENCES.includes(evidence)) {
    throw new ModelError('invalid_evidence', `证据类型非法：${evidence}`)
  }

  const source = input.source ?? 'explicit'
  if (!SOURCES.includes(source)) throw new ModelError('invalid_source', `来源非法：${source}`)

  const summary = String(input.summary ?? deriveSummary(text)).slice(0, MAX_SUMMARY_CHARS)
  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 12)
    : []

  const entry = {
    id: input.id || makeId(t, seq),
    text,
    summary,
    layer,
    project: String(input.project ?? '全局'),
    status,
    alpha,
    beta,
    evidence,
    counterEvidence: Array.isArray(input.counterEvidence) ? [...input.counterEvidence] : [],
    encodings: [t],
    // 压缩等级：0=原文，1-3=逐级压缩，4=只剩目录
    compressionLevel: Number.isInteger(input.compressionLevel) ? input.compressionLevel : 0,
    // 是否已成「能独立站住的主张」—— 没固化的不压
    consolidated: Boolean(input.consolidated),
    // 引用原话（必须能在来源原文里找到，校验在写入时做）
    quote: input.quote ? String(input.quote) : null,
    lastHit: 0,
    hits: 0,
    keywords,
    factKey: input.factKey ?? null,
    supersedes: input.supersedes ?? null,
    supersededAt: null,
    invalidatedBy: null,
    createdAt: t,
    source,
    sourceRef: input.sourceRef ?? null,
    sourceMissing: Boolean(input.sourceMissing),
    schemaVersion: 1,
  }
  return entry
}

/** 存储前/读入后的严格校验。不合法抛 ModelError。 */
export function validateEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    throw new ModelError('bad_entry', '条目必须是对象')
  }
  if (typeof entry.id !== 'string' || !entry.id) throw new ModelError('missing_id', '缺 id')
  if (typeof entry.text !== 'string' || !entry.text.trim()) {
    throw new ModelError('empty_text', '正文不能为空')
  }
  if (countChars(entry.text) > MAX_TEXT_CHARS) {
    throw new ModelError('text_too_long', `正文超过 ${MAX_TEXT_CHARS} 字`)
  }
  if (!LAYERS.includes(entry.layer)) throw new ModelError('invalid_layer', `层名非法：${entry.layer}`)
  if (!STATUSES.includes(entry.status)) {
    throw new ModelError('invalid_status', `状态非法：${entry.status}`)
  }
  const lv = entry.compressionLevel ?? 0
  if (!Number.isInteger(lv) || lv < 0 || lv > MAX_COMPRESSION) {
    throw new ModelError('invalid_compression', `压缩等级必须是 0~${MAX_COMPRESSION} 的整数`)
  }
  if (!isFiniteNumber(entry.alpha) || entry.alpha < 0 || entry.alpha > 1) {
    throw new ModelError('invalid_alpha', 'alpha 必须在 0~1')
  }
  if (!isFiniteNumber(entry.beta) || entry.beta < -1 || entry.beta > 1) {
    throw new ModelError('invalid_beta', 'beta 必须在 -1~1')
  }
  if (!EVIDENCES.includes(entry.evidence)) {
    throw new ModelError('invalid_evidence', `证据类型非法：${entry.evidence}`)
  }
  if (!Array.isArray(entry.keywords)) throw new ModelError('invalid_keywords', 'keywords 必须是数组')
  return true
}

/**
 * 状态转移。返回新对象，不改原对象。
 * 非法转移抛 ModelError('bad_transition')。
 */
export function transition(entry, to, { now, by = null, reason = null } = {}) {
  if (!STATUSES.includes(to)) throw new ModelError('invalid_status', `状态非法：${to}`)
  if (entry.status === to) return { ...entry }
  if (!canTransition(entry.status, to)) {
    throw new ModelError(
      'bad_transition',
      `不允许从 ${entry.status} 转到 ${to}`,
    )
  }
  const t = isFiniteNumber(now) ? now : Date.now()
  const next = { ...entry, status: to }
  if (to === 'superseded') {
    next.supersededAt = t
    if (reason) next.supersedeReason = reason
  }
  if (to === 'invalidated') {
    next.invalidatedBy = by
    next.invalidatedAt = t
    if (reason) next.invalidateReason = reason
  }
  if (to === 'active') {
    next.activationAnchor = t
    if (reason) next.reactivatedReason = reason
  }
  return next
}

/**
 * 把「时间」的各种写法归一成毫秒时间戳。
 *
 * 接受：毫秒数字、ISO 字符串、`YYYY-MM-DD`。解析不了就返回 undefined（当没给）。
 * 纯日期按**本地**当天 0 点，因为写 `at=2026-10-17` 的人想的是那天，不是 UTC 那天。
 */
export function parseTime(v) {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  const s = String(v).trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}

/** 记一次被用到：hits+1、lastHit、encodings 追加。 */
export function markUsed(entry, now) {
  const t = isFiniteNumber(now) ? now : Date.now()
  return {
    ...entry,
    hits: (entry.hits || 0) + 1,
    lastHit: t,
    encodings: [...(entry.encodings || []), t],
  }
}

/** 常驻层是否已满（alpha = 1.0 的条目数）。 */
export function pinnedCount(entries) {
  return entries.filter((e) => e.alpha === ALPHA_PIN && e.status !== 'archived').length
}

/** 常驻层还能不能再加。满额拒绝，不挤已有条目。 */
export function canPin(entries) {
  return pinnedCount(entries) < PINNED_CAP
}
