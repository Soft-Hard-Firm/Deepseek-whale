// 插件入口：把存储 / 工具 / 检索 / 注入接到真实 Cordis 上。
//
// 三条硬要求（docs/任务清单.md T7）：
//   1. 装进 DSH 后工具可用
//   2. 开关能真正卸载（disposer 必须全部兑现）
//   3. **加载失败不影响宿主启动** —— 任何异常只记日志，不往外抛
//
// 依赖的是真实契约（cordis_inspect 查到的）：
//   systemPrompt.section(section: PromptSection): () => void
//   systemPrompt.context(context: PromptContext): () => void
//   tools.register(definition: ToolDefinition, options?): () => void
// PromptSection / PromptContext 都要求 name；text 可以是函数。

import os from 'node:os'
import path from 'node:path'
import { createStore } from './lib/store.js'
import { createTools, TOOL_SPECS } from './lib/tools.js'
import { select, DEFAULT_POLICY } from './lib/retrieve.js'
import {
  registerInjection,
  renderSection,
  renderContext,
  ORDER,
} from './lib/inject.js'
import { ALPHA_PIN } from './lib/model.js'

export const name = 'whale-memory'

/** 硬依赖：没有这两个服务就不该启动。 */
export const inject = ['tools', 'systemPrompt']

const LOG_PREFIX = '[whale-memory]'

/** 默认库目录。 */
export function defaultDir(home = process.env.USERPROFILE || os.homedir()) {
  return path.join(home, '.dsh', 'whale-memory-v2')
}

/**
 * 把内部 { ok, error, text } 结果包成 DSH 的工具返回。
 *
 * DSH 的 ToolDefinition 需要 `output.schema` 和 `output.render`；
 * 这里统一渲染成文本块。（ContentBlock 用最通用的 `{ type: 'text', text }`。）
 */
function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }]
}

function makeOutput(schema) {
  return {
    schema,
    render(_args, value) {
      const v = value && typeof value === 'object' ? value : {}
      if (v.ok === false) {
        return textBlock(`失败（${v.error || 'unknown'}）：${v.text || ''}`)
      }
      return textBlock(JSON.stringify(v, null, 2))
    },
  }
}

/**
 * 把工具集包装成 DSH 的 ToolDefinition 列表。
 *
 * `specs` 是 TOOL_SPECS（名字 / 描述 / JSON Schema）；
 * `impl` 是 createTools() 的返回。
 */
export function buildToolDefinitions(impl, specs = TOOL_SPECS) {
  const out = []
  for (const [key, spec] of Object.entries(specs)) {
    const run = impl[key]
    if (typeof run !== 'function') continue
    out.push({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: makeOutput({ type: 'object' }),
      async execute(args) {
        // 内部工具是同步的；包一层 Promise 失败也要转成 ok:false，别让异常穿出去
        try {
          return run(args ?? {})
        } catch (e) {
          return { ok: false, error: 'internal', text: String(e?.message ?? e) }
        }
      },
    })
  }
  return out
}

/**
 * 计算每轮注入要用的状态。
 *
 * 这里不接用户消息 —— T7 只负责「有东西可注入」；
 * 真正的 query 来自会话消息，留到后续版本。
 * 现阶段注入的是：常驻层 + 全库按 alpha 排序的前几条。
 */
export function makeStateProvider({ store, now = () => Date.now() }) {
  return function getState() {
    const all = store.readAll().entries
    const pinned = all.filter((e) => e.alpha === ALPHA_PIN && e.status !== 'archived')
    const recent = all
      .filter((e) => e.status === 'active' && e.alpha !== ALPHA_PIN)
      .sort((a, b) => b.alpha - a.alpha || b.createdAt - a.createdAt)
      .slice(0, 6)
    return {
      pinned,
      hits: recent.map((entry) => ({ entry })),
      now: now(),
    }
  }
}

/**
 * 插件主体。
 *
 * @param {object} ctx   Cordis 上下文
 * @param {object} [config] { dir?: string, readOnly?: boolean }
 */
export function apply(ctx, config = {}) {
  let store = null
  let impl = null
  let offInjection = null

  // 全部注册都放进 effect —— 卸载时由 Cordis 保证回收
  const disposeAll = () => {
    // 逆序卸载，先撤注入再撤工具
    try {
      if (offInjection) offInjection()
    } catch (e) {
      console.warn(`${LOG_PREFIX} 卸载注入失败：`, e?.message ?? e)
    }
    offInjection = null
  }

  // 创建 store：失败也不许把宿主拖垮
  try {
    const dir = config.dir || defaultDir()
    store = createStore({ dir })
    impl = createTools({ store })
  } catch (e) {
    console.error(`${LOG_PREFIX} 初始化存储失败，记忆功能不可用：`, e?.message ?? e)
    return
  }

  // 注册工具
  try {
    const defs = buildToolDefinitions(impl)
    for (const def of defs) {
      const off = ctx.tools.register(def)
      // 由 ctx 统一回收；这里额外兜底一次，防止中途抛错留下半截
      if (typeof ctx.on === 'function') {
        const wrapped = off
        ctx.on('dispose', () => {
          try {
            wrapped()
          } catch {
            /* 已卸载 */
          }
        })
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} 注册工具失败：`, e?.message ?? e)
  }

  // 注册注入
  try {
    const getState = makeStateProvider({ store })
    offInjection = registerInjection(ctx, { getState })
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        try {
          offInjection?.()
        } catch {
          /* 已卸载 */
        }
      })
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} 注册注入失败：`, e?.message ?? e)
  }

  return disposeAll
}

export { createStore, createTools }
