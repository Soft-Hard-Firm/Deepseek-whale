// 拾取流水线：会话文件 → 按天切片 → 模型交结构化块 → 解析落盘 → 断点续跑。
//
// 口径见 docs/设计文档.md §4.2、docs/数据契约.md §3.8。
//
// 为什么要有它（而不是只靠 digest）：
//   digest 每次重捞最近 N 条，**没有进度**。面对 6000 行、24MB 的会话，
//   处理不完就永远处理不完。批量导入历史必须有断点续跑。
//
// 分工：
//   ingest        —— 取「下一批」：某一天的用户消息原文 + 块格式说明
//   ingest_commit —— 收模型交的块，解析、去重，再交给 remember 逐条落盘
//
// 落盘不在这里做：复用 remember 的校验链（剥注入 → 脱敏 → 引用 → 晋升），
// 流水线只负责「把模型交的块变成条目规格」。

import { redact } from './privacy.js'
import { stripInjection } from './self-pollution.js'
import { LAYERS, parseTime } from './model.js'
import { LEVEL_TO_LAYER } from './migrate.js'

/** 一个块头。 */
const HEAD_RE = /^<<<记忆(?:\s+([^>]*))?>>>\s*$/

/** 提交块里的账本行。 */
const LEDGER_RE = /^<<<账本>>>\s*$/

/** 一条记忆的正文行。 */
const ITEM_RE = /^\s*[-*]\s+(.+)$/

/** 属性：key=value，值可以带引号。 */
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g

/** 一次最多给模型多少条消息（切片过大模型读不动）。 */
export const MAX_BATCH_MESSAGES = 120

/** 一次最多接受多少条记忆（防止模型一口气交几千条把库撑爆）。 */
export const MAX_COMMIT_ITEMS = 200

function charCount(s) {
  return Array.from(String(s ?? '')).length
}

/**
 * 把毫秒时间戳变成**本地**日期键 `YYYY-MM-DD`。
 *
 * 用本地时间：整理历史时人对「哪一天」的直觉是本地日期。
 */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 解析一个块头的属性串。 */
export function parseAttrs(raw) {
  const out = {}
  let m
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(raw || '')) !== null) {
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    out[m[1]] = value
  }
  return out
}

/**
 * 解析模型交的结构化块。
 *
 * 格式：
 * ```
 * <<<记忆 layer=rule project=记忆系统 alpha=0.9 beta=1>>>
 * - 内容一
 * - 内容二
 * <<<账本>>>
 * {"已整理到":"2026-11-14"}
 * ```
 *
 * 一个头管它下面的所有 `- ` 行（共享头部的属性）。
 *
 * 解析失败**不抛**：返回 `errors`，让调用方如实报告 —— 模型写错格式是常态，
 * 不该让整批失败。
 *
 * @returns {{ items: object[], ledger: object|null, errors: string[] }}
 */
export function parseBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const items = []
  const errors = []
  let ledger = null

  let header = null
  let pending = 0 // 当前头部下已收集的条目数

  for (const line of lines) {
    const hm = HEAD_RE.exec(line.trim())
    if (hm) {
      const attrs = parseAttrs(hm[1])
      // 旧层名（rule / lesson / fact / topic / relation）映射到新四层。
      // 设计文档里的块例子用的就是旧的 level 名，模型照着写不该被拒。
      const layer = LEVEL_TO_LAYER[attrs.layer] || attrs.layer
      if (!layer) {
        errors.push(`块头缺 layer：${line.trim()}`)
        header = null
      } else if (!LAYERS.includes(layer)) {
        errors.push(`层名非法「${layer}」，跳过这一块`)
        header = null
      } else {
        // 映射结果要写回去，否则后面 push 用的还是原始层名
        header = { ...attrs, layer }
        pending = 0
      }
      continue
    }

    if (LEDGER_RE.test(line.trim())) {
      header = null
      continue
    }

    if (!header) {
      if (ledger === null && line.trim().startsWith('{')) {
        try {
          ledger = JSON.parse(line.trim())
        } catch {
          errors.push('账本不是合法 JSON')
        }
      }
      continue
    }

    const im = ITEM_RE.exec(line)
    if (!im) continue

    const raw = im[1].trim()
    if (!raw) continue

    const { text: clean } = redact(stripInjection(raw))
    if (!clean.trim()) {
      errors.push('一条内容剥完是空的，跳过')
      continue
    }

    items.push({
      text: clean,
      layer: header.layer,
      project: header.project || '全局',
      // 块头可以写 at=2026-10-17，指定「这件事什么时候发生的」
      createdAt: parseTime(header.at),
      alpha: header.alpha,
      beta: header.beta,
      status: header.status,
      evidence: header.evidence,
      source: 'import',
      projectFromBlock: true,
    })
    pending++
  }

  if (items.length > MAX_COMMIT_ITEMS) {
    errors.push(`一次最多 ${MAX_COMMIT_ITEMS} 条，超出的已丢弃`)
    items.length = MAX_COMMIT_ITEMS
  }

  return { items, ledger, errors }
}

/**
 * 把用户消息按天分组。
 *
 * @param {Array<{at:number, text:string}>} messages
 * @returns {Array<{day:string, messages:Array<{at,text}>}>}  按日期升序
 */
export function groupByDay(messages) {
  const map = new Map()
  for (const m of messages) {
    const k = dayKey(m.at)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(m)
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, msgs]) => ({ day, messages: msgs.sort((x, y) => x.at - y.at) }))
}

/**
 * 挑下一批还没整理的消息。
 *
 * **进度按时间戳走，不按天**。原因：单独一天就可能超过一批的上限
 * （实测有的天光用户消息就 120+ 条）。如果按天记进度，这一天永远整理不完 ——
 * 每次取的还是同样的前 N 条，死循环。
 *
 * @param {Array<{at:number,text:string}>} messages  全部消息，按时间升序
 * @param {number} lastAt  已经整理到哪个时间戳（不含）
 * @returns {{ messages:Array, days:string[], lastAt:number, truncated:boolean } | null}
 */
export function pickNextBatch(messages, lastAt = 0) {
  const pending = messages.filter((m) => m.at > lastAt)
  if (!pending.length) return null

  const take = pending.slice(0, MAX_BATCH_MESSAGES)
  const days = [...new Set(take.map((m) => dayKey(m.at)))].sort()

  return {
    messages: take,
    days,
    // 下一批从这里之后接着取
    lastAt: take[take.length - 1].at,
    truncated: pending.length > take.length,
  }
}

/** 块格式说明：给模型看的，和 parseBlocks 必须一字不差地对应。 */
export const BLOCK_FORMAT_HELP = `交回格式（必须严格照抄，插件按这个解析）：

<<<记忆 layer=<user|project|knowledge|working> project=<项目名> alpha=<0~1> beta=<0~1> at=<这件事发生的日期>>>
- 一条记忆，只讲一件事
- 又一条
<<<账本>>>
{"已整理到":"<这一批的最后一天，YYYY-MM-DD>"}

规矩：
- 一个 <<<记忆>>> 头管它下面的所有 "- " 行，它们共享同一层和项目
- 不同层或不同项目就再写一个头
- layer 必须是 user / project / knowledge / working 之一
- **at 要写这件事实际发生的日期**（不是今天）。这批会话是哪天的就写哪天的；
  写对了，「明天去杭州」才会被记成那天的事，而不是整理当天的事
- **过了一个星期再看，这条还有用吗？** 答不上就不收
- 一次性的任务细节（今天做什么、这个报错是什么）不要收
- 收完记得写 <<<账本>>>，否则进度不会前进`

/** 计数：块里的条目数（给报告用）。 */
export function countItems(items) {
  return items.reduce((n, i) => n + charCount(i.text), 0)
}
