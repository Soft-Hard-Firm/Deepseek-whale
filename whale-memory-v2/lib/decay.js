// 遗忘与压缩：按「多久没被提起」逐级加深压缩，但不删条目。
//
// 口径见 docs/设计文档.md §6、docs/任务清单.md T9、docs/PRD.md D1–D3。
//
// 三条规矩：
//   1. 没固化（不能独立站住）的条目**不压**，只标记待固化（D1）
//   2. 压缩分级只升不降，一次扫描不会来回反悔（D2）
//   3. 到顶（level 4）也只是「只剩一行目录」，条目不物理删除
//
// 与 §6.2 的一处取舍：
//   §6.2 说「被再次提起 → 回退一级」。这里**不回退**——压缩级别单调上升，
//   靠原文库保证细节不丢。理由：让注入内容在时间上稳定，别今天长、明天短。

import { DAY } from './retrieve.js'
import { MAX_COMPRESSION } from './model.js'

/**
 * 达到第 i 级需要的**累计**未提及天数。
 *
 * 对应 §6.2：21 天压一段、再 45 天压几句、再 60 天压主题、再 120 天只剩目录。
 */
export const CUMULATIVE_DAYS = Object.freeze([0, 21, 66, 126, 246])

/** 太短的一律先当没固化。 */
const MIN_CLAIM_CHARS = 8

/** 以指代词开头的句子，脱离上下文就站不住。 */
const POINTER_START = /^(这个|那个|这些|那些|它|他|她|这|那|上面|前面|刚才|刚才说的)/

/** 按码点算长度。 */
function charCount(s) {
  return Array.from(String(s ?? '')).length
}

/** 这条最后一次被提起是什么时候。 */
export function lastTouched(entry) {
  const enc = Array.isArray(entry?.encodings) ? entry.encodings : []
  return Math.max(
    entry?.lastHit || 0,
    entry?.createdAt || 0,
    ...enc.filter((n) => Number.isFinite(n)),
  )
}

/**
 * 这条是否已经变成「能独立站住的主张」。
 *
 * 显式标记优先；否则用保守的启发式 —— 宁可判「没固化」也不误压。
 */
export function isStandaloneClaim(entry) {
  if (!entry) return false
  if (entry.consolidated === true) return true

  const text = String(entry.text ?? '').trim()
  if (charCount(text) < MIN_CLAIM_CHARS) return false
  if (POINTER_START.test(text)) return false
  return true
}

/** 按时间算，这条现在该在第几级（只算目标，不改）。 */
export function targetLevel(entry, now) {
  const current = entry?.compressionLevel ?? 0
  if (!Number.isFinite(now)) return current

  const days = Math.max(0, (now - lastTouched(entry)) / DAY)

  let level = current
  for (let i = current; i < CUMULATIVE_DAYS.length; i++) {
    if (days >= CUMULATIVE_DAYS[i]) level = i
  }
  return Math.min(level, MAX_COMPRESSION)
}

/**
 * 扫一遍，给出压缩计划。
 *
 * 不改入参；返回新数组和变更清单。
 *
 * @returns {{ entries: object[], changed: Array<{id, from, to}>, pending: string[] }}
 */
export function planDecay(entries, now) {
  const changed = []
  const pending = []

  const next = entries.map((e) => {
    // 只压「还会被注入」的。superseded / invalidated / archived 都已经不注入了，
    // 压它们既省不下上下文，又会让历史变得不可读
    if (e.status !== 'active' && e.status !== 'contested') return e

    if (!isStandaloneClaim(e)) {
      // 未固化：只标记，绝不压（D1）
      if (e.pendingConsolidation) return e
      pending.push(e.id)
      return { ...e, pendingConsolidation: true }
    }

    const to = targetLevel(e, now)
    const from = e.compressionLevel ?? 0
    if (to <= from) {
      // 已经够压了，顺手把「待固化」标掉
      return e.pendingConsolidation ? { ...e, pendingConsolidation: false } : e
    }

    changed.push({ id: e.id, from, to })
    return {
      ...e,
      compressionLevel: to,
      pendingConsolidation: false,
      updatedAt: now,
    }
  })

  return { entries: next, changed, pending }
}
