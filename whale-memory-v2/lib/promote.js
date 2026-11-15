// 候选晋升：把「模型推断、还没被证实」的记忆转成可用事实。
//
// 口径见 docs/任务清单.md T8、docs/设计文档.md §2。
//
// 三条规矩：
//   1. explicit（用户明说）写入即 active —— 不需要晋升
//   2. 模型推断只能是 candidate，**写入时就不许直接 active**
//   3. candidate 要被「再次提及」或「放够时间」才晋升，不能凭一次推断就当真

import { DAY } from './retrieve.js'

/** 首次写入算 0 次重复；再被提一次（hits 到 1）就是「跨 2 次提及」。 */
export const PROMOTE_MIN_HITS = 1

/** 没人再提它，放够这么久也算站住脚。 */
export const PROMOTE_MIN_DAYS = 2

/** 这条要不要晋升？返回原因或 null。 */
export function promoteReason(entry, now) {
  if (!entry || entry.status !== 'candidate') return null
  if (!Number.isFinite(now)) return null

  // 用户明说的东西本来就不该停在 candidate
  if (entry.evidence === 'explicit') return 'explicit'

  if ((entry.hits ?? 0) >= PROMOTE_MIN_HITS) return 'repeat'

  const age = now - (entry.createdAt ?? now)
  if (age >= PROMOTE_MIN_DAYS * DAY) return 'age'

  return null
}

/**
 * 扫一遍，把该晋升的挑出来。
 *
 * 不改入参；返回新数组和一份晋升清单，方便调用方落盘和记日志。
 *
 * @returns {{ entries: object[], promoted: Array<{id, reason}> }}
 */
export function promoteDue(entries, now) {
  const promoted = []
  const next = entries.map((e) => {
    const reason = promoteReason(e, now)
    if (!reason) return e
    promoted.push({ id: e.id, reason })
    return {
      ...e,
      status: 'active',
      updatedAt: now,
      reactivatedReason: `candidate 晋升：${reason}`,
    }
  })
  return { entries: next, promoted }
}
