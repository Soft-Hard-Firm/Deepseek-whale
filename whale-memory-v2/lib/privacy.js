// 隐私脱敏：密钥、密码、token、手机号、身份证、银行卡，入库前一律替换。
//
// 口径见 docs/设计文档.md §8、docs/PRD.md §2.5（E1）。
//
// 两条原则：
//   1. 宁可多替一次，也不让密钥进库 —— 库会被注入进模型上下文，等于裸奔
//   2. 原文也要脱敏 —— 只脱条目、原文还是明文，等于没脱

/** 占位符前缀。 */
const TAG = '[已脱敏'

/**
 * 脱敏规则。顺序有意义：先认长得最像的那些，再认宽泛的。
 * 每条都返回「替换后文本」和「命中类型」。
 */
const RULES = [
  // ── 密钥类：先认前缀，避免被后面的通用规则吃掉 ──
  {
    kind: 'key',
    re: /\b(?:sk|ghp|gho|ghs|ghu|glpat|xox[abprs]|AKIA)[-_][A-Za-z0-9_-]{12,}/g,
  },
  {
    kind: 'key',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?key)\s*[:=：]\s*["']?[A-Za-z0-9_\-+/=.]{12,}["']?/gi,
  },
  {
    kind: 'token',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  },
  {
    kind: 'token',
    re: /\b(?:token|access_token|refresh_token|id_token)\s*[:=：]\s*["']?[A-Za-z0-9._~+/-]{12,}["']?/gi,
  },

  // ── 密码类：保留交代语，只吃值 ──
  {
    kind: 'password',
    re: /(密码|口令|passwd|password|pwd)\s*(?:是|为|[:=：])\s*["']?[^\s，。；,;"']+/gi,
  },

  // ── 身份证：18 位，先于银行卡 ──
  {
    kind: 'idcard',
    re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
  },

  // ── 手机号 ──
  {
    kind: 'phone',
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },

  // ── 银行卡：16~19 位连续数字 ──
  {
    kind: 'bankcard',
    re: /(?<!\d)\d{16,19}(?!\d)/g,
  },
]

/**
 * 把一段文本里的敏感内容替换掉。
 *
 * @returns {{ text: string, hits: Array<{kind: string, sample: string}> }}
 */
export function redact(input) {
  let text = String(input ?? '')
  const hits = []

  for (const rule of RULES) {
    text = text.replace(rule.re, (match) => {
      // 密码类规则会把交代语也匹配进来；保留前半，只替值
      let prefix = ''
      let secret = match
      if (rule.kind === 'password') {
        const m = /^(密码|口令|passwd|password|pwd)(\s*(?:是|为|[:=：])\s*)/i.exec(match)
        if (m) {
          prefix = m[1] + m[2]
          secret = match.slice(m[0].length)
        }
      } else if (rule.kind === 'token') {
        const m = /^((?:token|access_token|refresh_token|id_token)\s*[:=：]\s*)/i.exec(match)
        if (m) {
          prefix = m[1]
          secret = match.slice(m[0].length)
        }
      }

      hits.push({ kind: rule.kind, sample: mask(secret) })
      return `${prefix}${TAG}:${rule.kind}]`
    })
  }

  return { text, hits }
}

/** 只留首尾各 2 个字符，够人认「这被替了哪一条」，不够还原。 */
function mask(secret) {
  const s = String(secret).trim()
  const chars = Array.from(s)
  if (chars.length <= 4) return '*'.repeat(chars.length)
  return `${chars.slice(0, 2).join('')}…${chars.slice(-2).join('')}`
}

/** 有没有敏感内容。 */
export function hasSensitive(input) {
  return redact(input).hits.length > 0
}
