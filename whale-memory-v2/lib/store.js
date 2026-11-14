// 存储层：文件读写、原子替换、锁、原文追加、备份恢复。
//
// 边界（见 docs/数据契约.md）：
//   · 记忆.json      投影层，可整体重写
//   · 原文/*.jsonl   只追加，永不修改
//   · 备份/*.json.gz 带 sha256，可校验
//   · 写前取锁，落盘完成才返回成功
//
// 不在这里做的事：条目的字段校验与状态转移（那是 model.js）。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const SCHEMA_VERSION = 1
const LOCK_STALE_MS = 2000
const MAX_TEXT_CHARS = 4000

export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 按本地日期算分片名。用注入的 now，便于测试。 */
function shardOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
}

/**
 * 创建一个 store。
 * @param {object} opts
 * @param {string} opts.dir 数据目录
 * @param {() => number} [opts.now] 时钟，测试注入
 */
export function createStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new StoreError('bad_dir', '缺少数据目录')

  const memPath = path.join(dir, '记忆.json')
  const origDir = path.join(dir, '原文')
  const backupDir = path.join(dir, '备份')
  const lockPath = path.join(dir, '记忆.json.lock')
  const statePath = path.join(dir, '状态.json')

  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(origDir, { recursive: true })
    fs.mkdirSync(backupDir, { recursive: true })
  }

  // ── 锁 ──────────────────────────────────────────────────
  // 独占创建锁文件；过期锁（超过 LOCK_STALE_MS）视为崩溃残留，可接管。
  function acquireLock() {
    ensureDirs()
    const deadline = now() + LOCK_STALE_MS
    // 注入的时钟可能是固定值（测试），所以用次数兜底，不单靠时间。
    const MAX_ATTEMPTS = 4
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }), 'utf8')
        fs.closeSync(fd)
        return
      } catch (e) {
        if (e.code !== 'EEXIST') throw new StoreError('lock_failed', `取锁失败：${e.message}`)
        // 锁已存在：过期就接管，否则报 lock_held
        let age = Infinity
        try {
          const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
          age = now() - Number(raw.at || 0)
        } catch {
          age = Infinity
        }
        if (age > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath) } catch { /* 别人先删了，无所谓 */ }
          continue
        }
        if (now() >= deadline || attempt === MAX_ATTEMPTS - 1) {
          throw new StoreError('lock_held', '另一个进程正在写记忆库')
        }
      }
    }
    throw new StoreError('lock_held', '另一个进程正在写记忆库')
  }

  function releaseLock() {
    try { fs.unlinkSync(lockPath) } catch { /* 已经不在了 */ }
  }

  // ── 原子写 ──────────────────────────────────────────────
  function atomicWrite(file, content) {
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, content, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* 清理失败不掩盖原错误 */ }
      throw new StoreError('write_failed', `替换文件失败：${e.message}`)
    }
  }

  // ── 读 ──────────────────────────────────────────────────
  function blank() {
    return { schemaVersion: SCHEMA_VERSION, entries: [], updatedAt: 0 }
  }

  /**
   * 读整库。文件不存在返回空库（不抛错）。
   * 内容损坏抛 store_corrupt —— 调用方决定是否 recover()。
   */
  function readAll() {
    if (!fs.existsSync(memPath)) return blank()
    let raw
    try {
      raw = fs.readFileSync(memPath, 'utf8')
    } catch (e) {
      throw new StoreError('store_corrupt', `读不出来：${e.message}`)
    }
    if (!raw.trim()) return blank()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new StoreError('store_corrupt', `不是合法 JSON：${e.message}`)
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) {
      throw new StoreError('store_corrupt', '结构不符：缺 entries 数组')
    }
    return {
      schemaVersion: Number(parsed.schemaVersion) || SCHEMA_VERSION,
      entries: parsed.entries,
      updatedAt: Number(parsed.updatedAt) || 0,
    }
  }

  /**
   * 写整库。先读一遍确认可读（坏文件不静默覆盖），再原子替换。
   * 返回 { ok: true, count, bytes } 或抛 StoreError。
   */
  function writeAll(entries) {
    if (!Array.isArray(entries)) throw new StoreError('bad_input', 'entries 必须是数组')
    // 坏文件不覆盖：这里故意读一次，损坏就抛出去
    readAll()
    acquireLock()
    try {
      const payload = JSON.stringify(
        { schemaVersion: SCHEMA_VERSION, entries, updatedAt: now() },
        null,
        2,
      )
      atomicWrite(memPath, payload)
      return { ok: true, count: entries.length, bytes: Buffer.byteLength(payload) }
    } finally {
      releaseLock()
    }
  }

  // ── 原文 ────────────────────────────────────────────────
  /**
   * 追加一条原文。只追加，绝不修改已有行。
   * 返回 sourceRef（"2026-11#3"，分片#行号）。
   */
  function appendOriginal(text, meta = {}) {
    const raw = text == null ? '' : String(text)
    const t = now()
    const shard = shardOf(t)
    const file = path.join(origDir, `${shard}.jsonl`)
    ensureDirs()

    let lineNo = 0
    if (fs.existsSync(file)) {
      lineNo = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
    }
    const rec = {
      id: `o_${shard}_${lineNo + 1}`,
      t,
      text: Array.from(raw).slice(0, MAX_TEXT_CHARS).join(''),
      trunc: Array.from(raw).length > MAX_TEXT_CHARS,
      ...meta,
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
    return { sourceRef: `${shard}#${lineNo + 1}`, id: rec.id, truncated: rec.trunc }
  }

  /** 按 sourceRef 取原文。找不到返回 null（不抛错，条目照常用）。 */
  function readOriginal(sourceRef) {
    if (typeof sourceRef !== 'string' || !sourceRef.includes('#')) return null
    const [shard, lineStr] = sourceRef.split('#')
    const lineNo = Number(lineStr)
    if (!Number.isSafeInteger(lineNo) || lineNo < 1) return null
    const file = path.join(origDir, `${shard}.jsonl`)
    if (!fs.existsSync(file)) return null
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const line = lines[lineNo - 1]
    if (!line) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  // ── 状态 ────────────────────────────────────────────────
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      return isPlainObject(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch, updatedAt: now() }
    ensureDirs()
    atomicWrite(statePath, JSON.stringify(next, null, 2))
    return next
  }

  // ── 备份与恢复 ──────────────────────────────────────────
  /** 生成一个带 sha256 的备份包。返回路径与校验信息。 */
  function backup() {
    ensureDirs()
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const files = []
    const shards = fs.existsSync(origDir)
      ? fs.readdirSync(origDir).filter((f) => f.endsWith('.jsonl'))
      : []
    for (const name of shards) {
      const buf = fs.readFileSync(path.join(origDir, name))
      files.push({ name: `原文/${name}`, sha256: sha256(buf), bytes: buf.length })
    }
    let memBytes = null
    if (fs.existsSync(memPath)) {
      memBytes = fs.readFileSync(memPath)
      files.push({ name: '记忆.json', sha256: sha256(memBytes), bytes: memBytes.length })
    }
    const manifest = { version: SCHEMA_VERSION, createdAt: now(), files }
    const archive = { manifest, events: {}, memory: memBytes ? memBytes.toString('utf8') : null }
    for (const name of shards) {
      archive.events[name] = fs.readFileSync(path.join(origDir, name), 'utf8')
    }
    const out = path.join(backupDir, `events-${stamp}.json.gz`)
    fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(archive), 'utf8')))
    return { ok: true, path: out, files: files.length, manifest }
  }

  /** 校验最新备份：重新解压后逐文件比对 sha256。 */
  function verifyLatestBackup() {
    ensureDirs()
    const all = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json.gz')).sort()
    if (!all.length) return { ok: false, code: 'no_backup', text: '没有备份' }
    const file = path.join(backupDir, all[all.length - 1])
    let archive
    try {
      archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
    } catch (e) {
      return { ok: false, code: 'backup_corrupt', text: `备份读不出来：${e.message}` }
    }
    const bad = []
    for (const f of archive.manifest?.files || []) {
      const content = f.name === '记忆.json' ? archive.memory : archive.events?.[path.basename(f.name)]
      if (content == null) { bad.push(`${f.name}: 缺内容`); continue }
      if (sha256(Buffer.from(content, 'utf8')) !== f.sha256) bad.push(`${f.name}: sha256 不符`)
    }
    return bad.length
      ? { ok: false, code: 'backup_mismatch', text: bad.join('；') }
      : { ok: true, path: file, files: archive.manifest.files.length }
  }

  /**
   * 损坏恢复：把坏文件改名保留，再从最新备份恢复。
   * 没有备份时以空库启动，并在状态里记一次告警。
   */
  function recover() {
    ensureDirs()
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    let savedCorrupt = null
    if (fs.existsSync(memPath)) {
      savedCorrupt = `${memPath}.corrupt.${stamp}`
      fs.renameSync(memPath, savedCorrupt)
    }
    const verified = verifyLatestBackup()
    if (verified.ok) {
      const archive = JSON.parse(
        zlib.gunzipSync(fs.readFileSync(verified.path)).toString('utf8'),
      )
      if (archive.memory != null) atomicWrite(memPath, archive.memory)
      for (const [name, content] of Object.entries(archive.events || {})) {
        fs.writeFileSync(path.join(origDir, name), content, 'utf8')
      }
      writeState({ lastRecoverAt: now(), recoveredFrom: verified.path })
      return { ok: true, from: verified.path, savedCorrupt }
    }
    atomicWrite(memPath, JSON.stringify(blank(), null, 2))
    writeState({ lastRecoverAt: now(), recoveredFrom: null, warn: 'no_backup' })
    return { ok: true, from: null, savedCorrupt, warn: 'no_backup' }
  }

  function exists() {
    return fs.existsSync(memPath)
  }

  return {
    dir,
    paths: { memPath, origDir, backupDir, lockPath, statePath },
    readAll,
    writeAll,
    appendOriginal,
    readOriginal,
    readState,
    writeState,
    backup,
    verifyLatestBackup,
    recover,
    exists,
  }
}
