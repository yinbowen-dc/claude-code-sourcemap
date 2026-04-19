/**
 * 代码高亮懒加载模块。
 *
 * 在 Claude Code 系统中，该模块以共享 Promise 单例的方式懒加载 cli-highlight 和 highlight.js，
 * 供 Fallback.tsx、markdown.ts、events.ts、getLanguageName 等多处共用：
 * - getCliHighlightPromise()：返回全局共享的高亮库加载 Promise（首次调用时触发加载）
 * - getLanguageName()：根据文件扩展名查询 highlight.js 语言注册表，返回语言名称
 *
 * 注：highlight.js 类型定义携带 DOM 引用，通过 /// <reference lib="dom" /> 保持
 * 当前 tsconfig（lib: ["ESNext"]）下的类型兼容性。
 */
// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import { extname } from 'path'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// 全局共享的高亮库加载 Promise，供 Fallback.tsx、markdown.ts、events.ts、getLanguageName 复用。
// highlight.js 会随 cli-highlight 一同加载进模块缓存，第二次 import() 直接命中缓存，无额外开销。
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

// 缓存 highlight.js 的 getLanguage 函数，避免重复动态导入
let loadedGetLanguage: typeof import('highlight.js').getLanguage | undefined

/**
 * 实际执行高亮库的动态导入。首次调用时触发模块加载，
 * 同时顺带缓存 highlight.js 的 getLanguage 函数供 getLanguageName 使用。
 * 若加载失败（如环境不支持）则静默返回 null。
 */
async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // cli-highlight 已将 highlight.js 拉入模块缓存，此处直接命中缓存，无额外网络/IO 开销
    const highlightJs = await import('highlight.js')
    loadedGetLanguage = highlightJs.getLanguage
    return {
      highlight: cliHighlight.highlight,
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    // 加载失败时返回 null，调用方需做空值检查
    return null
  }
}

/**
 * 返回全局共享的高亮库加载 Promise。
 * 利用 ??= 确保多个并发调用者复用同一 Promise，只触发一次模块加载。
 */
export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * 根据文件路径（如 "foo/bar.ts"）查询 highlight.js 语言注册表，返回语言名称（如 "TypeScript"）。
 * 内部先等待共享的 cli-highlight 加载完成，再读取缓存的 getLanguage 函数。
 * 所有调用方均为遥测场景（OTel 属性、权限弹窗事件），以 fire-and-forget 方式使用。
 */
export async function getLanguageName(file_path: string): Promise<string> {
  // 等待高亮库加载，确保 loadedGetLanguage 已被赋值
  await getCliHighlightPromise()
  // 截取扩展名（去掉前缀点号）
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  // 查询 highlight.js 语言注册表，未知扩展名时回退为 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
