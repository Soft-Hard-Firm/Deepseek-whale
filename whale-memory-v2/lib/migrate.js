// 迁移：旧 whale-memory（SQLite）→ 新格式。
//
// 口径见 docs/设计文档.md §9。
//
// 三条硬约束：
//   1. **只读打开旧库**，绝不写。旧库 hash 必须前后一致。（PRD F3）
//   2. 逐条列出转换结果，不做静默丢弃。
//   3. 数量必须一致 —— 少一条就是丢数据。（PRD F1）

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { normalizeEntry } from './model.js'

/** 旧库 level → 新 layer。
 *
 * 设计文档写的是「一一对应」，实际旧库有 7 种 level、新库只有 4 层，
 * 做不到一一对应。这里显式映射，并在报告里逐条写出，不静默吞掉差异。
 */
export const LEVEL_TO_LAYER = Object.freeze({
  user: 'user',
  project: 'project',
  relation: 'knowledge', // 关系史：属于可复用经验
  lesson: 'knowledge',
  rule: 'knowledge',
  fact: 'knowledge',
  topic: 'working', // 进行中的话题
})

/** 旧库 status → 新 status。 */
export const STATUS_MAP = Object.freeze({
  active: 'active',
  archived: 'archived',
  stale: 'archived', // 设计文档：stale 并入 archived
})

/** importance 1–4 → alpha。 */
export const IMPORTANCE_TO_ALPHA = Object.freeze({
  1: 0.3,
  2: 0.5,
  3: 0.7,
  4: 0.9,
})

/** 迁移后统一的 beta：不伪造精确值。 */
export const MIGRATED_BETA = 0.7

/** 把旧 keywords（空格分隔字符串）拆成数组。 */
export function splitKeywords(raw) {
  return String(raw ?? '')
    .split(/[\s,，、|]+/)
    .map((k) => k.trim())
    .filter(Boolean)
}

/** 文件 sha256，用来证明旧库没被改。 */
export function fileHash(path) {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex')
}

/**
 * 单条转换。不做 I/O，方便单测。
 * @returns {{ entry: object|null, report: object }}
 */
export function convertRow(row, { now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now()
  const report = {
    legacyId: row.id,
    level: row.level,
    status: row.status,
    importance: row.importance,
    pinned: row.pinned,
    action: 'converted',
    warnings: [],
  }

  const layer = LEVEL_TO_LAYER[row.level]
  if (!layer) {
    report.action = 'skipped'
    report.warnings.push(`未知 level「${row.level}」，跳过`)
    return { entry: null, report }
  }
  if (row.level !== layer) report.layerNote = `${row.level} → ${layer}`

  const status = STATUS_MAP[row.status]
  if (!status) {
    report.action = 'skipped'
    report.warnings.push(`未知 status「${row.status}」，跳过`)
    return { entry: null, report }
  }
  if (row.status !== status) report.statusNote = `${row.status} → ${status}`

  // pinned 优先于 importance
  const alpha =
    row.pinned === 1
      ? 1.0
      : (IMPORTANCE_TO_ALPHA[row.importance] ?? 0.5)
  if (row.pinned === 1) report.alphaNote = 'pinned → alpha 1.0'

  const text = String(row.content ?? '')
  if (!text.trim()) {
    report.action = 'skipped'
    report.warnings.push('正文为空，跳过')
    return { entry: null, report }
  }

  // 旧库正文可能超过新的 600 字上限
  const chars = Array.from(text)
  let finalText = text
  if (chars.length > 600) {
    finalText = chars.slice(0, 600).join('')
    report.warnings.push(`正文 ${chars.length} 字，截到 600`)
  }

  try {
    const entry = normalizeEntry(
      {
        text: finalText,
        layer,
        project: row.project?.trim() || '全局',
        status,
        alpha,
        beta: MIGRATED_BETA,
        // 旧库没记录证据类型，不伪造：统一 explicit
        evidence: 'explicit',
        keywords: splitKeywords(row.keywords),
        source: 'import',
      },
      { now: row.created_at || t, seq: row.id },
    )
    // 保留原始创建时间，别让迁移把「很久以前的事」刷新成今天
    entry.createdAt = row.created_at || t
    entry.updatedAt = row.updated_at || entry.createdAt
    entry.encodings = [entry.createdAt]
    report.newId = entry.id
    return { entry, report }
  } catch (e) {
    report.action = 'failed'
    report.warnings.push(String(e?.message ?? e))
    return { entry: null, report }
  }
}

/**
 * 全量迁移。
 *
 * @param {object} opts
 * @param {string} opts.legacyPath SQLite 旧库路径
 * @param {object} [opts.store]    目标 store；dryRun 时可不传
 * @param {boolean} [opts.dryRun]  只转换不写盘
 * @param {() => number} [opts.clock]
 */
export function migrate({ legacyPath, store, dryRun = false, clock = () => Date.now() } = {}) {
  if (!legacyPath) throw new Error('migrate：缺少 legacyPath')
  if (!fs.existsSync(legacyPath)) throw new Error(`migrate：旧库不存在 ${legacyPath}`)

  const hashBefore = fileHash(legacyPath)

  // 只读打开 —— 这是 F3 的第一道保险
  const { DatabaseSync } = require_node_sqlite()
  const db = new DatabaseSync(legacyPath, { readOnly: true })
  let rows
  try {
    rows = db.prepare('SELECT * FROM memories ORDER BY id').all()
  } finally {
    db.close()
  }

  const now = clock()
  const entries = []
  const reports = []
  for (const row of rows) {
    const { entry, report } = convertRow(row, { now })
    reports.push(report)
    if (entry) entries.push(entry)
  }

  const byAction = {}
  for (const r of reports) byAction[r.action] = (byAction[r.action] || 0) + 1

  const summary = {
    legacyPath,
    legacyCount: rows.length,
    converted: entries.length,
    skipped: byAction.skipped || 0,
    failed: byAction.failed || 0,
    byAction,
    dryRun,
    hashBefore,
    hashAfter: null,
    hashUnchanged: null,
  }

  if (!dryRun) {
    if (!store) throw new Error('migrate：非 dryRun 时必须提供 store')

    // 目标库已存在就不覆盖 —— 迁移不该吃掉已有数据
    const existing = store.readAll()
    if (existing.entries.length > 0) {
      throw new Error(
        `migrate：目标库已有 ${existing.entries.length} 条，拒绝覆盖。先备份或换目录。`,
      )
    }
    store.writeAll(entries)
  }

  const hashAfter = fileHash(legacyPath)
  summary.hashAfter = hashAfter
  summary.hashUnchanged = hashAfter === hashBefore
  if (!summary.hashUnchanged) {
    // 这条不抛错，但必须让人看见
    summary.warnings = ['旧库文件在迁移过程中发生了变化 —— F3 不成立']
  }

  return { summary, reports, entries }
}

const nodeRequire = createRequire(import.meta.url)

/** node:sqlite 是实验性 API，动态取，避免顶层 import 在旧 Node 上直接炸。 */
function require_node_sqlite() {
  const { DatabaseSync } = nodeRequire('node:sqlite')
  return { DatabaseSync }
}
