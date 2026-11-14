// 验收用例：T6 迁移。标题即 PRD F 类编号。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createStore } from '../../lib/store.js'
import {
  migrate,
  convertRow,
  fileHash,
  splitKeywords,
  MIGRATED_BETA,
  LEVEL_TO_LAYER,
} from '../../lib/migrate.js'

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite')

const NOW = Date.parse('2026-11-15T06:00:00+08:00')

/** 造一个和真实旧库同构的 SQLite，避免测试依赖本机数据。 */
function makeLegacyDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-legacy-'))
  const p = path.join(dir, 'whale-memory.db')
  const db = new DatabaseSync(p)
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL, subcategory TEXT NOT NULL, project TEXT NOT NULL,
    content TEXT NOT NULL, keywords TEXT NOT NULL, importance INTEGER NOT NULL,
    status TEXT NOT NULL, pinned INTEGER NOT NULL, source TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    detail REAL NOT NULL, detail_at INTEGER NOT NULL,
    recall_count INTEGER NOT NULL, recall_at INTEGER NOT NULL,
    valid_until INTEGER NOT NULL)`)
  const ins = db.prepare(`INSERT INTO memories
    (level, subcategory, project, content, keywords, importance, status, pinned, source,
     created_at, updated_at, detail, detail_at, recall_count, recall_at, valid_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const r of rows) {
    ins.run(
      r.level ?? 'user',
      r.subcategory ?? '',
      r.project ?? '',
      r.content ?? '',
      r.keywords ?? '',
      r.importance ?? 2,
      r.status ?? 'active',
      r.pinned ?? 0,
      r.source ?? 'seed',
      r.created_at ?? NOW,
      r.updated_at ?? NOW,
      1,
      r.created_at ?? NOW,
      0,
      0,
      0,
    )
  }
  db.close()
  return p
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-target-'))
  return createStore({ dir, now: () => NOW })
}

test('F1 旧库每条都被转换，数量一致', () => {
  const rows = [
    { level: 'user', content: '主人不吃辣', pinned: 1 },
    { level: 'project', content: '项目用 pnpm' },
    { level: 'lesson', content: '踩过的坑' },
    { level: 'rule', content: '发布前跑测试' },
    { level: 'fact', content: '一个事实' },
    { level: 'topic', content: '进行中的话题' },
    { level: 'relation', content: '一次往来' },
    { level: 'project', content: '一条归档的', status: 'archived' },
    { level: 'topic', content: '一条旧话题', status: 'stale' },
  ]
  const legacy = makeLegacyDb(rows)
  const store = freshStore()
  const { summary } = migrate({ legacyPath: legacy, store, clock: () => NOW })

  assert.equal(summary.legacyCount, rows.length)
  assert.equal(summary.converted, rows.length)
  assert.equal(summary.failed, 0)

  const written = store.readAll().entries
  assert.equal(written.length, rows.length, '写进新库的条数要与旧库一致')
})

test('F2 迁移后 beta 全为 0.7', () => {
  const rows = []
  for (let i = 0; i < 12; i++) rows.push({ content: `第${i}条`, importance: (i % 4) + 1 })
  const legacy = makeLegacyDb(rows)
  const store = freshStore()
  migrate({ legacyPath: legacy, store, clock: () => NOW })

  const betas = new Set(store.readAll().entries.map((e) => e.beta))
  assert.deepEqual([...betas], [MIGRATED_BETA])
})

test('F3 迁移不修改旧库文件（sha256 前后一致）', () => {
  const legacy = makeLegacyDb([{ content: '不该被改' }])
  const before = fileHash(legacy)
  const store = freshStore()
  const { summary } = migrate({ legacyPath: legacy, store, clock: () => NOW })
  const after = fileHash(legacy)

  assert.equal(after, before)
  assert.equal(summary.hashUnchanged, true)
})

test('pinned 转成 alpha=1.0，importance 转成 0.3~0.9', () => {
  const rows = [
    { content: '钉住的', pinned: 1, importance: 1 },
    { content: '重要度 1', pinned: 0, importance: 1 },
    { content: '重要度 4', pinned: 0, importance: 4 },
  ]
  const legacy = makeLegacyDb(rows)
  const store = freshStore()
  migrate({ legacyPath: legacy, store, clock: () => NOW })
  const es = store.readAll().entries

  assert.equal(es.find((e) => e.text === '钉住的').alpha, 1.0)
  assert.equal(es.find((e) => e.text === '重要度 1').alpha, 0.3)
  assert.equal(es.find((e) => e.text === '重要度 4').alpha, 0.9)
})

test('level 七种都能映射，未知 level 跳过并报告，不静默丢', () => {
  for (const lv of ['user', 'project', 'lesson', 'rule', 'fact', 'topic', 'relation']) {
    const { entry, report } = convertRow(
      { id: 1, level: lv, status: 'active', content: '正文', importance: 2, pinned: 0, created_at: NOW },
      { now: NOW },
    )
    assert.ok(entry, `${lv} 应能转换`)
    assert.equal(entry.layer, LEVEL_TO_LAYER[lv])
    assert.equal(report.action, 'converted')
  }

  const bad = convertRow(
    { id: 9, level: '外星层级', status: 'active', content: '正文', importance: 2, pinned: 0 },
    { now: NOW },
  )
  assert.equal(bad.entry, null)
  assert.equal(bad.report.action, 'skipped')
  assert.ok(bad.report.warnings[0].includes('未知 level'))
})

test('stale → archived，并在报告里写出来', () => {
  const { entry, report } = convertRow(
    { id: 2, level: 'user', status: 'stale', content: '旧的', importance: 2, pinned: 0 },
    { now: NOW },
  )
  assert.equal(entry.status, 'archived')
  assert.ok(report.statusNote.includes('stale'))
})

test('空正文跳过；超长正文截断并警告', () => {
  const empty = convertRow(
    { id: 3, level: 'user', status: 'active', content: '   ', importance: 2, pinned: 0 },
    { now: NOW },
  )
  assert.equal(empty.report.action, 'skipped')
  assert.ok(empty.report.warnings[0].includes('为空'))

  const long = convertRow(
    {
      id: 4, level: 'user', status: 'active',
      content: '字'.repeat(700), importance: 2, pinned: 0,
    },
    { now: NOW },
  )
  assert.equal(long.report.action, 'converted')
  assert.equal(Array.from(long.entry.text).length, 600)
  assert.ok(long.report.warnings.some((w) => w.includes('截到 600')))
})

test('原始创建时间被保留，不会刷新成迁移当天', () => {
  const old = NOW - 200 * 86400000
  const { entry } = convertRow(
    { id: 5, level: 'user', status: 'active', content: '很早的事', importance: 2, pinned: 0, created_at: old },
    { now: NOW },
  )
  assert.equal(entry.createdAt, old)
  assert.equal(entry.encodings[0], old)
})

test('目标库非空时拒绝覆盖', () => {
  const legacy = makeLegacyDb([{ content: '新来的' }])
  const store = freshStore()
  store.writeAll([])
  // 先塞一条已有数据
  const { DatabaseSync: _ } = {}
  store.writeAll([
    {
      id: 'm_existing', text: '已有', summary: '已有', layer: 'user', project: '全局',
      status: 'active', alpha: 0.5, beta: 0.7, evidence: 'explicit',
      counterEvidence: [], encodings: [NOW], lastHit: 0, hits: 0,
      createdAt: NOW, updatedAt: NOW, keywords: [], source: 'explicit',
      sourceRef: null, sourceMissing: false, supersedes: null, factKey: null,
      supersededAt: 0, invalidatedBy: null, invalidatedAt: 0,
      activationAnchor: NOW, supersedeReason: null, invalidateReason: null,
      reactivatedReason: null,
    },
  ])

  assert.throws(
    () => migrate({ legacyPath: legacy, store, clock: () => NOW }),
    /拒绝覆盖/,
  )
})

test('dry-run 不写盘', () => {
  const legacy = makeLegacyDb([{ content: '试试' }])
  const store = freshStore()
  const { summary } = migrate({ legacyPath: legacy, store, dryRun: true, clock: () => NOW })
  assert.equal(summary.converted, 1)
  assert.equal(store.readAll().entries.length, 0, 'dry-run 不该写入任何东西')
})

test('splitKeywords 能拆空格 / 逗号 / 顿号', () => {
  assert.deepEqual(splitKeywords('调侃 肥 雷点'), ['调侃', '肥', '雷点'])
  assert.deepEqual(splitKeywords('a，b、c'), ['a', 'b', 'c'])
  assert.deepEqual(splitKeywords(''), [])
})
