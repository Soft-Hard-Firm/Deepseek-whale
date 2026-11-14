import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createStore, StoreError } from '../../lib/store.js'

const BASE = Date.parse('2026-11-15T05:00:00+08:00')

function tmpStore(t = BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-'))
  const store = createStore({ dir, now: () => t })
  return { dir, store }
}

test('空库：读不抛错，返回空数组', () => {
  const { store } = tmpStore()
  const data = store.readAll()
  assert.deepEqual(data.entries, [])
  assert.equal(data.schemaVersion, 1)
  assert.equal(store.exists(), false)
})

test('写读往返：条目原样回来', () => {
  const { store } = tmpStore()
  store.writeAll([{ id: 'm1', text: '一条事实', layer: 'user', status: 'active' }])
  const data = store.readAll()
  assert.equal(data.entries.length, 1)
  assert.equal(data.entries[0].text, '一条事实')
  assert.equal(store.exists(), true)
})

test('原子替换：写完后不残留 .tmp 文件', () => {
  const { dir, store } = tmpStore()
  store.writeAll([{ id: 'm1', text: 'a' }])
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))
  assert.deepEqual(leftovers, [])
})

test('坏文件：不静默覆盖，抛 store_corrupt，文件内容不变', () => {
  const { store } = tmpStore()
  const before = '{ 这不是合法 JSON'
  fs.mkdirSync(path.dirname(store.paths.memPath), { recursive: true })
  fs.writeFileSync(store.paths.memPath, before, 'utf8')

  assert.throws(() => store.readAll(), (e) => {
    assert.equal(e.code, 'store_corrupt')
    return true
  })
  // 写也要被挡住，且原文件不动
  assert.throws(() => store.writeAll([]), (e) => e.code === 'store_corrupt')
  assert.equal(fs.readFileSync(store.paths.memPath, 'utf8'), before)
})

test('恢复：坏文件改名保留，从备份还原到一致', () => {
  const { store } = tmpStore()
  const entries = [{ id: 'm1', text: '要保住的一条' }]
  store.writeAll(entries)
  const backup = store.backup()
  assert.equal(backup.ok, true)
  assert.equal(store.verifyLatestBackup().ok, true)

  // 弄坏
  fs.writeFileSync(store.paths.memPath, '坏了', 'utf8')
  const result = store.recover()
  assert.equal(result.ok, true)
  assert.equal(result.from !== null, true)

  const after = store.readAll()
  assert.deepEqual(after.entries, entries)

  // 坏文件被改名保留，不直接删掉
  const corrupt = fs.readdirSync(path.dirname(store.paths.memPath))
    .filter((f) => f.includes('.corrupt.'))
  assert.equal(corrupt.length, 1)
})

test('没有备份时恢复：以空库启动并留告警', () => {
  const { store } = tmpStore()
  fs.mkdirSync(path.dirname(store.paths.memPath), { recursive: true })
  fs.writeFileSync(store.paths.memPath, '坏的', 'utf8')
  const result = store.recover()
  assert.equal(result.ok, true)
  assert.equal(result.warn, 'no_backup')
  assert.deepEqual(store.readAll().entries, [])
  assert.equal(store.readState().warn, 'no_backup')
})

test('原文：只追加，不修改已有行', () => {
  const { store } = tmpStore()
  const a = store.appendOriginal('第一句', { src: 'test' })
  const b = store.appendOriginal('第二句', { src: 'test' })
  assert.equal(a.sourceRef.endsWith('#1'), true)
  assert.equal(b.sourceRef.endsWith('#2'), true)

  const file = path.join(store.paths.origDir, a.sourceRef.split('#')[0] + '.jsonl')
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).text, '第一句')
  assert.equal(JSON.parse(lines[1]).text, '第二句')
})

test('原文：按 sourceRef 能读回来，读不到返回 null', () => {
  const { store } = tmpStore()
  const { sourceRef } = store.appendOriginal('可溯源的一句')
  const rec = store.readOriginal(sourceRef)
  assert.equal(rec.text, '可溯源的一句')
  assert.equal(store.readOriginal('2099-01#1'), null)
  assert.equal(store.readOriginal('乱写'), null)
})

test('锁：已有未过期锁时返回 lock_held', () => {
  const { dir, store } = tmpStore()
  store.writeAll([{ id: 'm1', text: 'a' }])
  // 手写一个未过期的锁（时钟固定，age=0）
  fs.writeFileSync(
    store.paths.lockPath,
    JSON.stringify({ pid: 99999, at: BASE }),
    'utf8',
  )
  assert.throws(() => store.writeAll([]), (e) => e.code === 'lock_held')
})

test('锁：过期锁可接管', () => {
  let t = BASE
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-'))
  const store = createStore({ dir, now: () => t })
  store.writeAll([{ id: 'm1', text: 'a' }])
  // 一个很旧的锁
  fs.writeFileSync(store.paths.lockPath, JSON.stringify({ pid: 1, at: BASE - 60000 }), 'utf8')
  t = BASE
  assert.doesNotThrow(() => store.writeAll([{ id: 'm2', text: 'b' }]))
  assert.equal(store.readAll().entries[0].id, 'm2')
})

test('备份校验：篡改内容会被 sha256 发现', () => {
  const { store } = tmpStore()
  store.writeAll([{ id: 'm1', text: 'a' }])
  const { path: bak } = store.backup()
  assert.equal(store.verifyLatestBackup().ok, true)

  // 解压、改内容、写回
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(bak)).toString('utf8'))
  for (const f of archive.manifest.files) {
    if (f.name === '记忆.json') archive.memory = '被改过了'
  }
  fs.writeFileSync(bak, zlib.gzipSync(Buffer.from(JSON.stringify(archive), 'utf8')))

  const v = store.verifyLatestBackup()
  assert.equal(v.ok, false)
  assert.equal(v.code, 'backup_mismatch')
})
