#!/usr/bin/env node
// 回填原文库：给没有 sourceRef 的条目补上原文出处。
//
// 背景：迁移只搬了条目、没重建原文库，导致 265 条的 `recall` 翻不到出处。
// 这个脚本把条目正文按原文格式补写进去，并回填 sourceRef。
//
// 只补缺的，不动已有的（已有的 sourceRef 可能是更早的真实出处，不能覆盖）。

import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'

function parseArgs(argv) {
  const out = { dryRun: false, dir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--dir') out.dir = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true
  }
  return out
}

const HELP = `
回填原文库：给没有 sourceRef 的条目补原文。

用法：
  node bin/backfill-original.js [--dry-run] [--dir <库目录>]

默认目录：~/.dsh/whale-memory-v2
`

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }

  const home = process.env.USERPROFILE || os.homedir()
  const dir = args.dir || path.join(home, '.dsh', 'whale-memory-v2')
  const store = createStore({ dir })
  const data = store.readAll()
  const entries = [...data.entries]

  let backfilled = 0
  let skipped = 0
  const samples = []

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.sourceRef) {
      skipped++
      continue
    }
    if (!e.text || !String(e.text).trim()) {
      skipped++
      continue
    }

    if (!args.dryRun) {
      const { sourceRef } = store.appendOriginal(e.text, {
        src: 'backfill',
        layer: e.layer,
        forId: e.id,
      })
      entries[i] = { ...e, sourceRef }
    }
    backfilled++
    if (samples.length < 5) samples.push({ id: e.id, chars: Array.from(e.text).length })
  }

  if (backfilled > 0 && !args.dryRun) {
    store.writeAll(entries)
  }

  const lines = []
  lines.push('=== 原文回填 ===')
  lines.push(`库目录    ${dir}`)
  lines.push(`条目总数  ${entries.length}`)
  lines.push(`已回填    ${backfilled}`)
  lines.push(`跳过      ${skipped}（已有 sourceRef 或正文为空）`)
  lines.push(`模式      ${args.dryRun ? 'dry-run（未写盘）' : '已写入'}`)
  if (samples.length) {
    lines.push('')
    lines.push('抽样：')
    for (const s of samples) lines.push(`  ${s.id}  ${s.chars} 字`)
  }
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

process.exit(main())
