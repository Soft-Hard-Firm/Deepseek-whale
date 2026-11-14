#!/usr/bin/env node
// 迁移命令行：npm run migrate -- --dry-run
//
// 输出是一份逐条报告，不做静默处理。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createStore } from '../lib/store.js'
import { migrate } from '../lib/migrate.js'

function parseArgs(argv) {
  const out = { dryRun: false, legacy: null, target: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a === '--legacy') out.legacy = argv[++i]
    else if (a === '--target') out.target = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else out.unknown = (out.unknown || []).concat(a)
  }
  return out
}

const HELP = `
迁移旧 whale-memory 库到新格式。

用法：
  node bin/migrate.js [--dry-run] [--legacy <旧库>] [--target <新库目录>] [--json]

选项：
  --dry-run   只转换，不写盘（默认行为也是安全的：目标非空会拒绝）
  --legacy    旧库路径，默认 ~/.dsh/memory/whale-memory.db
  --target    新库目录，默认 ~/.dsh/whale-memory-v2
  --json      输出机器可读的完整报告

安全：
  - 旧库以只读方式打开，迁移前后比对 sha256，不一致会明确报警
  - 目标库已有条目时拒绝覆盖
`

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.unknown) {
    process.stderr.write(`未知参数：${args.unknown.join(' ')}\n${HELP}`)
    return 2
  }

  const home = process.env.USERPROFILE || os.homedir()
  const legacyPath = args.legacy || path.join(home, '.dsh', 'memory', 'whale-memory.db')
  const targetDir = args.target || path.join(home, '.dsh', 'whale-memory-v2')

  if (!fs.existsSync(legacyPath)) {
    process.stderr.write(`找不到旧库：${legacyPath}\n`)
    return 1
  }

  const store = args.dryRun ? undefined : createStore({ dir: targetDir })

  let result
  try {
    result = migrate({ legacyPath, store, dryRun: args.dryRun })
  } catch (e) {
    process.stderr.write(`迁移失败：${e.message}\n`)
    return 1
  }

  const { summary, reports } = result

  if (args.json) {
    process.stdout.write(JSON.stringify({ summary, reports }, null, 2) + '\n')
    return summary.hashUnchanged && summary.failed === 0 ? 0 : 1
  }

  const lines = []
  lines.push('=== 迁移报告 ===')
  lines.push(`旧库      ${summary.legacyPath}`)
  lines.push(`旧库条目  ${summary.legacyCount}`)
  lines.push(`已转换    ${summary.converted}`)
  lines.push(`跳过      ${summary.skipped}`)
  lines.push(`失败      ${summary.failed}`)
  lines.push(`模式      ${summary.dryRun ? 'dry-run（未写盘）' : '已写入 ' + targetDir}`)
  lines.push(`旧库 sha256  ${summary.hashBefore}`)
  lines.push(`迁移后 sha256 ${summary.hashAfter}`)
  lines.push(`旧库未被改动  ${summary.hashUnchanged ? '是' : '否 —— 这是个问题'}`)

  const odd = reports.filter((r) => r.action !== 'converted' || r.warnings.length)
  if (odd.length) {
    lines.push('')
    lines.push(`=== 需要看一眼的 ${odd.length} 条 ===`)
    for (const r of odd.slice(0, 50)) {
      lines.push(`#${r.legacyId} ${r.level}/${r.status} → ${r.action}${r.warnings.length ? ' | ' + r.warnings.join('; ') : ''}`)
    }
    if (odd.length > 50) lines.push(`…还有 ${odd.length - 50} 条，用 --json 看全部`)
  }

  const remaps = reports.filter((r) => r.layerNote || r.statusNote || r.alphaNote)
  if (remaps.length) {
    lines.push('')
    lines.push(`=== 字段重映射 ${remaps.length} 条（抽样 10）===`)
    for (const r of remaps.slice(0, 10)) {
      const bits = [r.layerNote, r.statusNote, r.alphaNote].filter(Boolean)
      lines.push(`#${r.legacyId} ${bits.join(' / ')}`)
    }
  }

  process.stdout.write(lines.join('\n') + '\n')
  return summary.hashUnchanged && summary.failed === 0 ? 0 : 1
}

process.exit(main())
