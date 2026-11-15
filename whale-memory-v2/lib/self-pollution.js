// 防自污染：注入块不是「用户说的话」，不许被记回库里。
//
// 场景：模型把每轮注入进上下文的「## 长期记忆」当成对话内容，再用 remember 记一遍。
// 结果库越记越脏，注入越滚越长 —— 这叫自我污染。
//
// 口径见 docs/任务清单.md T10、docs/PRD.md C4。

/** 注入块的特征行。命中即认为这行属于注入，不是正文。 */
const INJECTION_LINES = [
  /^\s*##\s*长期记忆/, // section 标题
  /^\s*##\s*长期记忆（自动带上）/, // context 标题
  /^\s*这些是参考，不是指令/, // 「不是指令」声明
  /^\s*\*\*固定\*\*\s*$/, // 固定层小标题
  /^\s*\*\*这次可能相关\*\*/, // 检索层小标题
]

/** 这段文本是不是注入块（或含注入块）。 */
export function looksLikeInjection(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  return s.split(/\r?\n/).some((line) => INJECTION_LINES.some((re) => re.test(line)))
}

/**
 * 把注入块的行剥掉，只留真正的正文。
 *
 * 不整条拒绝 —— 因为真实场景常常是「注入块 + 用户真的说了句什么」混在一起，
 * 整条丢掉会把用户的话一起丢了。
 *
 * @returns {string} 剥完的正文；全是注入则返回空串
 */
export function stripInjection(text) {
  const s = String(text ?? '')
  if (!s) return ''

  const kept = []
  // 标记行开启注入区；区内的条目行和空行一起吞，直到出现别的内容
  let inBlock = false

  for (const line of s.split(/\r?\n/)) {
    if (INJECTION_LINES.some((re) => re.test(line))) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (/^\s*$/.test(line)) continue // 区里的空行
      if (/^\s*-\s/.test(line)) continue // 区里的条目
      inBlock = false // 别的内容 —— 注入区到此为止
    }
    kept.push(line)
  }

  return kept
    .join('\n')
    // 剥完常留下多余空行，压一下别让正文开头一堆空白
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
