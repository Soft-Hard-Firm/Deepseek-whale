// 工具层：remember / search / update / forget / recall。
//
// 口径见 docs/数据契约.md §3、docs/设计文档.md §4。
// 所有函数同步返回，不抛异常 —— 失败一律 { ok: false, error, text }。

import {
  normalizeEntry,
  validateEntry,
  transition,
  shouldInject,
  isSearchable,
  canTransition,
  canPin,
  markUsed,
  deriveSummary,
  ModelError,
  LAYERS,
  STATUSES,
  ALPHA_PIN,
} from './model.js'
import { StoreError } from './store.js'
import { select, DEFAULT_POLICY } from './retrieve.js'
import { promoteDue } from './promote.js'
import { parseTime } from './model.js'
import { redact } from './privacy.js'
import { stripInjection } from './self-pollution.js'
import { planDecay } from './decay.js'
import {
  readUserMessages,
  DEFAULT_DAYS,
  DEFAULT_LIMIT,
  DATA_NOT_INSTRUCTION,
} from './digest.js'
import {
  groupByDay,
  pickNextBatch,
  parseBlocks,
  dayKey,
  BLOCK_FORMAT_HELP,
  MAX_BATCH_MESSAGES,
} from './ingest.js'

// 检索比注入宽松：门槛低、名额大，且能被翻到的状态都要查得到
const SEARCH_POLICY = { ...DEFAULT_POLICY, threshold: 0.15, maxItems: 100 }
const SEARCHABLE_STATUSES = ['candidate', 'active', 'contested', 'superseded', 'archived']

/** 会验证失败时抛的自家错误。 */
export class ToolError extends Error {
  constructor(code, text) {
    super(text)
    this.name = 'ToolError'
    this.code = code
  }
}

/** 去掉标点与空白，用于去重指纹。 */
export function normalizeForFingerprint(s) {
  return String(s || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

/** 去重指纹：规范化后的前 12 个字。 */
export function fingerprint(text) {
  return Array.from(normalizeForFingerprint(text)).slice(0, 12).join('')
}

/** 把一个工具异常转成返回对象。 */
/** 取正整数，非法就给默认值。 */
function positiveInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback
}

/** 毫秒时间戳 → 「11-15 22:30」。 */
function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toFailure(e) {
  if (e instanceof ToolError) return { ok: false, error: e.code, text: e.message }
  if (e instanceof ModelError) return { ok: false, error: e.code, text: e.message }
  if (e instanceof StoreError) return { ok: false, error: e.code, text: e.message }
  return { ok: false, error: 'internal', text: String(e && e.message ? e.message : e) }
}

/** 必填字符串。 */
function needString(input, key, max = 10000) {
  const v = input?.[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolError('invalid_param', `${key} 必须是非空字符串`)
  }
  if (Array.from(v).length > max) {
    throw new ToolError('invalid_param', `${key} 超过 ${max} 字`)
  }
  return v
}

function optString(input, key, max = 300) {
  const v = input?.[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError('invalid_param', `${key} 必须是字符串`)
  if (Array.from(v).length > max) throw new ToolError('invalid_param', `${key} 超过 ${max} 字`)
  return v
}

function optNumber(input, key, lo, hi) {
  const v = input?.[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    throw new ToolError('invalid_param', `${key} 必须在 ${lo}~${hi}`)
  }
  return v
}

/** 简单分词：中文按 2 字滑窗，英文数字按整词。给最简检索用。 */
export function gramsOf(text) {
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
 * 创建工具集。
 * @param {object} deps
 * @param {object} deps.store  由 createStore 创建
 * @param {() => number} deps.clock
 */
export function createTools({ store, clock = () => Date.now() }) {
  const now = () => clock()

  /** 读库并保证 entries 是数组。 */
  function load() {
    const data = store.readAll()
    return data
  }

  function save(entries) {
    // 写死前再校验一遍：坏条目不许进库
    for (const e of entries) validateEntry(e)
    store.writeAll(entries)
  }

  /** 写盘前顺手把够格的候选提上来，并把晋升结果带回去。 */
  function saveWithPromotion(entries) {
    const { entries: next, promoted } = promoteDue(entries, now())
    save(next)
    return { entries: next, promoted }
  }

  // ── remember ───────────────────────────────────────────
  function remember(input = {}) {
    try {
      // 长度限制交给 normalizeEntry —— 这里抢先拦会把 text_too_long 变成 invalid_param
      const rawText = needString(input, 'text')
      // 注入块不是用户说的话，先剥掉再谈别的
      const stripped = stripInjection(rawText)
      if (!stripped.trim()) {
        throw new ToolError('empty_text', '这段内容只有注入块，没有要记的东西')
      }
      // 密钥、密码这类东西在入库前就替掉；原文也替，否则只是把明文挪了个地方
      const { text, hits: redacted } = redact(stripped)
      const layer = input.layer ?? 'user'
      if (!LAYERS.includes(layer)) throw new ToolError('invalid_layer', `层名非法：${layer}`)

      const data = load()
      const entries = [...data.entries]

      // 常驻层满额：拒绝，不挤已有条目
      const wantPin = input.alpha === ALPHA_PIN
      if (wantPin && !canPin(entries)) {
        throw new ToolError(
          'layer_full',
          '常驻层已满。这条要么写进普通层，要么明确替换某一条，不能自动挤掉。',
        )
      }

      // 同 factKey：旧条取代
      const factKey = optString(input, 'factKey', 200)
      if (factKey) {
        const idx = entries.findIndex(
          (e) => e.factKey === factKey && e.status === 'active' && e.layer === layer,
        )
        if (idx >= 0) {
          entries[idx] = transition(entries[idx], 'superseded', {
            now: now(),
            reason: '同 factKey 的新事实写入',
          })
        }
      }

      // 去重指纹：前 12 字相同 = 同一条，只加 hits
      const fp = fingerprint(text)
      if (fp) {
        // candidate 也要算：同一条推断被提第二次，就是「再次提及」，不该滚成两条
        const dup = entries.find(
          (e) =>
            (e.status === 'active' || e.status === 'candidate') &&
            e.layer === layer &&
            fingerprint(e.text) === fp,
        )
        if (dup) {
          const used = markUsed(dup, now())
          const i = entries.indexOf(dup)
          entries[i] = used
          const { entries: after, promoted } = saveWithPromotion(entries)
          const finalEntry = after.find((e) => e.id === used.id) ?? used
          return {
            ok: true,
            id: used.id,
            status: finalEntry.status,
            deduped: true,
            ...(promoted.length ? { promoted: promoted.length } : {}),
          }
        }
      }

      // 引用原话必须能在来源原文里找到 —— 防的是「编一句用户没说过的话当引用」
      const quote = optString(input, 'quote', 600)
      const quoteSource = optString(input, 'quoteSource', 20000)
      if (quote) {
        if (!quoteSource) {
          throw new ToolError(
            'quote_unverifiable',
            '给了引用就必须同时给来源原文，否则没法验证这句是不是真的',
          )
        }
        if (!quoteSource.includes(quote)) {
          throw new ToolError('quote_mismatch', '引用的这句话在来源原文里找不到')
        }
      }

      // 写原文，拿 sourceRef
      const { sourceRef } = store.appendOriginal(text, {
        src: input.source ?? 'explicit',
        layer,
      })

      const entry = normalizeEntry(
        {
          text,
          layer,
          project: input.project,
          // 模型推断写入时不许直接 active，只能进 candidate
          status: input.status ?? (input.source === 'model' ? 'candidate' : 'active'),
          alpha: input.alpha,
          beta: input.beta,
          // source 与 evidence 是两件事：模型推断出来的东西，证据也只能算被动得知
          evidence:
            input.evidence ?? (input.source === 'model' ? 'passive' : 'explicit'),
          keywords: input.keywords,
          factKey,
          supersedes: input.supersedes,
          quote,
          // 这件事什么时候发生的；不给就是写入时刻
          createdAt: parseTime(input.at),
          source: input.source,
          sourceRef,
        },
        { now: now(), seq: entries.length + 1 },
      )
      entries.push(entry)
      const { entries: after, promoted } = saveWithPromotion(entries)
      const finalEntry = after.find((e) => e.id === entry.id) ?? entry
      return {
        ok: true,
        id: entry.id,
        status: finalEntry.status,
        ...(promoted.length ? { promoted: promoted.length } : {}),
        ...(redacted.length ? { redacted: redacted.length, redactedKinds: redacted.map((h) => h.kind) } : {}),
      }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── search ─────────────────────────────────────────────
  function search(input = {}) {
    try {
      const data = load()
      const all = data.entries

      // 无 query：返回索引概览
      const query = optString(input, 'query', 2000)
      if (!query) {
        const byLayer = {}
        const byStatus = {}
        let oldest = null
        let newest = null
        for (const e of all) {
          byLayer[e.layer] = (byLayer[e.layer] || 0) + 1
          byStatus[e.status] = (byStatus[e.status] || 0) + 1
          if (oldest == null || e.createdAt < oldest) oldest = e.createdAt
          if (newest == null || e.createdAt > newest) newest = e.createdAt
        }
        return {
          ok: true,
          index: {
            total: all.length,
            byLayer,
            byStatus,
            oldestAt: oldest,
            newestAt: newest,
            hint: '怎么查：给关键词、给时间范围、或按 id 读原文',
          },
        }
      }

      const limit = Math.min(optNumber(input, 'limit', 1, 100) ?? 8, 100)
      const layerFilter = optString(input, 'layer', 20)
      const projectFilter = optString(input, 'project', 100)

      // 交给检索层：饱和评分 + 两层稀有度 + 门槛卡 C + 去重
      const { picked } = select(all, query, {
        now: now(),
        policy: SEARCH_POLICY,
        layer: layerFilter,
        project: projectFilter,
        statuses: SEARCHABLE_STATUSES,
        applyQuota: false,
      })

      const hits = picked.slice(0, limit).map(({ entry, C, P, nearMiss }) => ({
        id: entry.id,
        summary: entry.summary,
        layer: entry.layer,
        project: entry.project,
        status: entry.status,
        alpha: entry.alpha,
        beta: entry.beta,
        at: entry.createdAt,
        C: Number(C.toFixed(3)),
        P: Number(P.toFixed(3)),
        ...(nearMiss ? { nearMiss: true } : {}),
      }))
      return { ok: true, hits }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── recall ─────────────────────────────────────────────
  function recall(input = {}) {
    try {
      const id = needString(input, 'id', 200)
      const data = load()
      const entry = data.entries.find((e) => e.id === id)
      if (!entry) throw new ToolError('not_found', `没有这条记忆：${id}`)

      const offset = optNumber(input, 'offset', 0, 1e6) ?? 0
      const limit = Math.min(optNumber(input, 'limit', 1, 16000) ?? 2000, 16000)
      const chars = Array.from(entry.text)
      const slice = chars.slice(offset, offset + limit).join('')
      const nextOffset = offset + limit < chars.length ? offset + limit : null

      const original = entry.sourceRef ? store.readOriginal(entry.sourceRef) : null
      return {
        ok: true,
        id: entry.id,
        text: slice,
        at: entry.createdAt,
        sourceRef: entry.sourceRef,
        source: original ? original.text : null,
        sourceMissing: Boolean(entry.sourceRef) && original === null,
        offset,
        nextOffset,
        totalChars: chars.length,
      }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── update ─────────────────────────────────────────────
  function update(input = {}) {
    try {
      const id = needString(input, 'id', 200)
      const data = load()
      const entries = [...data.entries]
      const idx = entries.findIndex((e) => e.id === id)
      if (idx < 0) throw new ToolError('not_found', `没有这条记忆：${id}`)
      const cur = entries[idx]

      let next = { ...cur }
      if (input.text !== undefined) {
        const text = needString(input, 'text', 600)
        next.text = text
        if (input.summary === undefined) next.summary = deriveSummary(text)
      }
      if (input.summary !== undefined) next.summary = String(input.summary).slice(0, 60)
      if (input.alpha !== undefined) {
        const a = optNumber(input, 'alpha', 0, 1)
        if (a === ALPHA_PIN && cur.alpha !== ALPHA_PIN && !canPin(entries.filter((e) => e.id !== id))) {
          throw new ToolError('layer_full', '常驻层已满，不能再加一条常驻')
        }
        next.alpha = a
      }
      if (input.beta !== undefined) next.beta = optNumber(input, 'beta', -1, 1)
      if (input.keywords !== undefined) {
        if (!Array.isArray(input.keywords)) throw new ToolError('invalid_param', 'keywords 必须是数组')
        next.keywords = input.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 12)
      }
      if (input.status !== undefined) {
        if (!STATUSES.includes(input.status)) {
          throw new ToolError('invalid_status', `状态非法：${input.status}`)
        }
        if (input.status !== cur.status) {
          if (!canTransition(cur.status, input.status)) {
            throw new ToolError(
              'bad_transition',
              `不允许从 ${cur.status} 转到 ${input.status}`,
            )
          }
          // 只把状态相关字段合进 next —— 不能整体替换，否则前面改过的 text 会丢
          const t = transition(cur, input.status, {
            now: now(),
            by: input.by ?? null,
            reason: input.reason ?? null,
          })
          next.status = t.status
          for (const k of [
            'supersededAt',
            'invalidatedBy',
            'invalidatedAt',
            'activationAnchor',
            'supersedeReason',
            'invalidateReason',
            'reactivatedReason',
          ]) {
            if (k in t) next[k] = t[k]
          }
        }
      }
      if (input.project !== undefined) next.project = String(input.project)
      if (input.layer !== undefined) {
        if (!LAYERS.includes(input.layer)) throw new ToolError('invalid_layer', `层名非法：${input.layer}`)
        next.layer = input.layer
      }

      validateEntry(next)
      entries[idx] = next
      save(entries)
      return { ok: true, id, status: next.status }
    } catch (e) {
      return toFailure(e)
    }
  }

  function curTextIfEdited(cur, input) {
    return input.text !== undefined ? input.text : cur.text
  }

  // ── ingest / ingest_commit ─────────────────────────────
  // 拾取流水线：取一批 → 模型交块 → 解析落盘 → 记进度。

  /** 读整理进度。 */
  function readIngest() {
    const st = store.readState() || {}
    return st.ingest && typeof st.ingest === 'object' ? st.ingest : { doneDays: [] }
  }

  /** 取下一批要整理的会话。 */
  async function ingest(input = {}) {
    try {
      const progress = readIngest()
      const lastAt = progress.lastIngestedAt ?? 0
      // 从上一次整理到的地方接着读，别每次重扫全部会话
      const since = Math.max(Number.isFinite(input.since) ? input.since : 0, lastAt)

      const r = await readUserMessages({
        since,
        limit: 100000, // 流水线自己分批，不让 digest 的条数上限截断
        sessionsDir: input.sessionsDir,
        maxChars: 2000,
      })
      if (!r.ok) {
        return { ok: false, error: r.error, text: `读不了会话：${r.error}` }
      }

      const batch = pickNextBatch(r.messages, lastAt)

      if (!batch) {
        return {
          ok: true,
          text:
            lastAt > 0
              ? '没有新的会话待整理了。'
              : '没有待整理的会话（会话目录里没有用户消息）。',
          done: true,
        }
      }

      store.writeState({
        ingest: { ...progress, currentBatch: { days: batch.days, lastAt: batch.lastAt } },
      })

      const lines = batch.messages.map((m) => `- [${stamp(m.at)}] ${m.text}`)
      const head = [
        `待整理：${batch.days.join('、')}（共 ${batch.messages.length} 条用户消息${batch.truncated ? '，本批有截断' : ''}）`,
        '',
        '读完后，挑出**长期有效**的，按下面的格式交回来：',
        '',
      ]

      return {
        ok: true,
        days: batch.days,
        count: batch.messages.length,
        text: [...head, lines.join('\n'), '', '---', '', BLOCK_FORMAT_HELP].join('\n'),
      }
    } catch (e) {
      return toFailure(e)
    }
  }

  /** 收模型交的块：解析、去重、落盘、记进度。 */
  function ingestCommit(input = {}) {
    try {
      const block = needString(input, 'block', 200000)
      const { items, ledger, errors } = parseBlocks(block)

      const result = { added: 0, deduped: 0, failed: 0 }
      const failures = []

      // 进度要在循环前读：循环里要用它的 currentBatch 兜底时间
      const progress = readIngest()
      // 没给 at 的，用这批会话的时间兜底 —— 至少别记成「整理当天」
      const fallbackAt = progress.currentBatch?.lastAt ?? undefined

      for (const it of items) {
        const r = remember({ ...it, at: it.createdAt ?? fallbackAt })
        if (!r.ok) {
          result.failed++
          if (failures.length < 5) failures.push(`${r.error}: ${it.text.slice(0, 30)}`)
        } else if (r.deduped) {
          result.deduped++
        } else {
          result.added++
        }
      }

      // 进度只在块里交了内容时才前进 —— 空块不该把一天标成「整理完」
      let advanced = null
      if (result.added + result.deduped > 0) {
        const cur = progress.currentBatch || {}
        const ledgerDay = typeof ledger?.['已整理到'] === 'string' ? ledger['已整理到'] : null
        const newDone = new Set(progress.doneDays || [])
        for (const d of cur.days || []) newDone.add(d)
        if (ledgerDay) newDone.add(ledgerDay)

        advanced = [...newDone].sort()
        store.writeState({
          ingest: {
            ...progress,
            // 按时间戳前进：同一天里有截断时，下一批能接着往下走
            lastIngestedAt: Math.max(progress.lastIngestedAt ?? 0, cur.lastAt ?? 0),
            doneDays: advanced,
            currentBatch: null,
            lastCommitAt: now(),
            lastCommitted: result.added + result.deduped,
          },
        })
      }

      const lines = [
        `解析到 ${items.length} 条：新增 ${result.added}，去重 ${result.deduped}，失败 ${result.failed}。`,
      ]
      if (errors.length) lines.push(`块格式问题 ${errors.length} 处：${errors.slice(0, 3).join('；')}`)
      if (failures.length) lines.push(`失败样例：${failures.join('；')}`)
      if (advanced) lines.push(`已标记 ${advanced.length} 天为整理完。`)
      else if (items.length === 0) lines.push('没解析到任何记忆，进度未前进 —— 检查块格式。')

      return { ...result, ok: true, errors: errors.length, text: lines.join('\n') }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── digest ─────────────────────────────────────────────
  // 把近几天用户说过的话捞出来，交给模型判断哪些值得记。
  // 插件自己不会记东西，这是「补漏」那一半。
  async function digest(input = {}) {
    try {
      const days = positiveInt(input.days, DEFAULT_DAYS)
      const limit = positiveInt(input.limit, DEFAULT_LIMIT)
      const since = now() - days * 86400000

      const r = await readUserMessages({ since, limit, sessionsDir: input.sessionsDir })

      if (!r.ok) {
        const why =
          r.error === 'zstd_unavailable'
            ? '当前 Node 不支持 zstd 解压'
            : r.error === 'sessions_dir_missing'
              ? '找不到会话目录'
              : String(r.error)
        return { ok: false, error: r.error, text: why }
      }

      if (!r.count) {
        // 带上诊断：0 条可能是「真的没说话」，也可能是「一个文件都没扫到」
        return {
          ok: true,
          text:
            `最近 ${days} 天没有可整理的用户消息。` +
            `（目录 ${r.root}，${r.filesFound} 个文件 / ${r.sessions} 个最近改过；` +
            `解压失败 ${r.stats?.failed?.length ?? 0} 个，总行数 ${r.stats?.lines ?? 0}，` +
            `坏 JSON ${r.stats?.badJson ?? 0}，类型 ${JSON.stringify(r.stats?.types ?? {})}；` +
            `node ${process.versions.node}，pid ${process.pid} 运行 ${Math.round(process.uptime())}s）` +
            (r.stats?.failed?.length ? ` 首个失败：${r.stats.failed[0]}` : ''),
        }
      }

      const lines = r.messages.map((m) => `- [${stamp(m.at)}] ${m.text}`)
      const head = [
        `最近 ${days} 天，用户在 ${r.sessions} 个会话里说过的话（共 ${r.count} 条${r.truncated ? '，只给了最近的' : ''}）：`,
        '',
      ]
      const tail = [
        '',
        '---',
        '挑出其中**长期有效**的（偏好、约定、纠正、身份、反复提到的事），用 remember 记；' +
          '一次性的任务细节不用记。记之前先 search，别重复。',
        DATA_NOT_INSTRUCTION,
      ]

      return { ok: true, count: r.count, text: [...head, ...lines, ...tail].join('\n') }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── maintain ───────────────────────────────────────────
  // 维护：把该压缩的压一级。低频操作，显式触发 —— 不挂在每次写入后面，
  // 否则每写一条都可能改全库，副作用不可控。
  function maintain(input = {}) {
    try {
      const dryRun = input.dryRun === true
      const data = load()
      const { entries, changed, pending } = planDecay(data.entries, now())

      const touched = changed.length > 0 || pending.length > 0
      if (touched && !dryRun) save(entries)

      return {
        ok: true,
        changed: changed.length,
        pending: pending.length,
        dryRun,
        // 只回前 20 条，结果会被重发，别把整库吐出去
        items: changed.slice(0, 20),
      }
    } catch (e) {
      return toFailure(e)
    }
  }

  // ── forget ─────────────────────────────────────────────
  function forget(input = {}) {
    try {
      const id = needString(input, 'id', 200)
      const reason = optString(input, 'reason', 500)
      const data = load()
      const entries = [...data.entries]
      const idx = entries.findIndex((e) => e.id === id)
      if (idx < 0) throw new ToolError('not_found', `没有这条记忆：${id}`)
      const cur = entries[idx]

      // 只改状态，不物理删除
      const target = cur.status === 'active' || cur.status === 'contested'
        ? 'invalidated'
        : 'archived'
      const next = transition(cur, target, { now: now(), by: 'user', reason: reason ?? null })
      entries[idx] = next
      save(entries)
      return { ok: true, id, status: next.status }
    } catch (e) {
      return toFailure(e)
    }
  }

  return {
    remember,
    search,
    recall,
    update,
    forget,
    maintain,
    digest,
    ingest,
    ingestCommit,
    // TOOL_SPECS 用的 key 是下划线形态，两个名字都留着
    ingest_commit: ingestCommit,
  }
}

/**
 * 工具定义（给宿主注册用）。参数一律是完整 JSON Schema。
 */
export const TOOL_SPECS = {
  remember: {
    name: 'remember',
    description:
      '把一件事记进长期记忆。**一条只装一件事** —— 一个属性、一个约定、一次事件；' +
      '「她身高一米七、体重五十二、平时侧睡」是三件事，分三次记。' +
      '只记长期有价值的：用户明确说的重要的话、约定、喜好、状态。' +
      '不记日常琐事，不记自己做过的事。**记的时候安静地记，不要在回复里说「记下了」** —— 那很像在汇报工作。' +
      '**时间由系统给，不要写「今天」「昨天」。**',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '一句话说清。**时间由系统给，不要写「今天」「昨天」**。' },
        layer: { type: 'string', enum: [...LAYERS], description: 'user=关于用户 / project=项目 / knowledge=可复用经验 / working=临时' },
        project: { type: 'string' },
        alpha: { type: 'number', description: '**要不要每轮都挂在用户眼前**：1=不主动提就会出事（雷点、约定、禁忌）；0.5=其余全部' },
        beta: { type: 'number', description: '**能不能当事实用**：1=用户明说 / 0.7=默认 / 0=玩笑或猜测' },
        keywords: { type: 'array', items: { type: 'string' } },
        factKey: { type: 'string', description: '同一条事只留最新时填「对象.方面」，不许写具体值' },
        quote: { type: 'string', description: '要记的「原话」片段。**给了它就必须给 quoteSource**，否则拒收——防止把没说过的话当引用' },
        quoteSource: { type: 'string', description: '原话出自的原文。quote 必须是它的子串，否则拒收' },
        at: {
          type: 'string',
          description:
            '这件事**什么时候发生的**（不是什么时候写的）。ISO 时间或 YYYY-MM-DD。' +
            '整理历史会话、补记旧事时必须给，否则时间线会错位。',
        },
        supersedes: { type: 'string' },
      },
    },
  },
  search: {
    name: 'search',
    description:
      '检索记忆。**不带 query 时返回库的索引概览**（有什么、多少条、时间范围）。' +
      '默认只返回摘要，不返回正文 —— 要正文用 recall。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: '默认 8，上限 100。结果会在这一轮之后每一步被重发，别要太多。' },
        layer: { type: 'string', enum: [...LAYERS] },
        project: { type: 'string' },
      },
    },
  },
  recall: {
    name: 'recall',
    description: '按 id 读一条记忆的正文和原始出处。想不起来细节时用它翻原文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number', description: '默认 2000，上限 16000' },
      },
    },
  },
  update: {
    name: 'update',
    description: '改一条已有记忆的内容、重要度、可信度、关键词或状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        summary: { type: 'string' },
        alpha: { type: 'number' },
        beta: { type: 'number' },
        keywords: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        layer: { type: 'string', enum: [...LAYERS] },
        status: { type: 'string', enum: [...STATUSES] },
        reason: { type: 'string' },
      },
    },
  },
  ingest: {
    name: 'ingest',
    description:
      '批量整理历史会话（第 1 步）：取一批还没整理过的会话内容。' +
      '读完按工具里给的块格式交回来，调 ingest_commit 落盘。' +
      '有断点续跑：整理过的天不会再给。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'number', description: '只看这个时间戳之后的会话（可选）' },
      },
    },
  },
  ingest_commit: {
    name: 'ingest_commit',
    description:
      '批量整理历史会话（第 2 步）：把按块格式写好的内容交上来，' +
      '插件会解析、去重、逐条落盘，并把这一批标成已整理。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['block'],
      properties: {
        block: { type: 'string', description: '按 ingest 里给的格式写好的完整块' },
      },
    },
  },
  digest: {
    name: 'digest',
    description:
      '把最近几天「用户说过的话」捞出来，用来补记漏掉的记忆。' +
      '插件不会自动记东西 —— 想补漏时调它，读完后用 remember 记下其中长期有效的事。' +
      '只返回用户消息（不含你自己说的），已脱敏。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'number', description: `回看多少天，默认 ${DEFAULT_DAYS}` },
        limit: { type: 'number', description: `最多返回多少条，默认 ${DEFAULT_LIMIT}` },
      },
    },
  },
  maintain: {
    name: 'maintain',
    description:
      '维护记忆库：把「很久没被提起」的条目压深一级（0→1→2→3→4）。' +
      '**不删除**，到顶也只是只剩一行目录。没固化的条目只会被标记，不会被压。' +
      '这是低频操作，需要时手动跑；dryRun=true 只算计划不改库。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: '只算计划，不写盘' },
      },
    },
  },
  forget: {
    name: 'forget',
    description: '让一条记忆退出使用。**只改状态，不物理删除**，之后仍可追溯。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
}
