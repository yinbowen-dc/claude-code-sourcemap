/**
 * 键位绑定模板文件生成模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件负责生成 ~/.claude/keybindings.json 的初始模板文件，
 * 是用户首次运行 /keybindings 命令时的入口点：
 *
 *   defaultBindings（完整的内置默认绑定）
 *   reservedShortcuts（NON_REBINDABLE 保留键列表）
 *     → template（本文件，过滤保留键 + 序列化为带注释的 JSON 模板）
 *       ← /keybindings 命令调用此函数，写入 ~/.claude/keybindings.json
 *
 * 核心导出：
 *  - generateKeybindingsTemplate()：
 *    生成完整的 keybindings.json 模板内容（字符串），
 *    包含所有可自定义的默认绑定，排除 ctrl+c / ctrl+d / ctrl+m 等不可重绑键，
 *    并附带 $schema / $docs 元数据，便于编辑器提供智能提示。
 */

import { jsonStringify } from '../utils/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import {
  NON_REBINDABLE,
  normalizeKeyForComparison,
} from './reservedShortcuts.js'
import type { KeybindingBlock } from './types.js'

/**
 * Filter out reserved shortcuts that cannot be rebound.
 * These would cause /doctor to warn, so we exclude them from the template.
 */
function filterReservedShortcuts(blocks: KeybindingBlock[]): KeybindingBlock[] {
  const reservedKeys = new Set(
    NON_REBINDABLE.map(r => normalizeKeyForComparison(r.key)),
  )

  return blocks
    .map(block => {
      const filteredBindings: Record<string, string | null> = {}
      for (const [key, action] of Object.entries(block.bindings)) {
        if (!reservedKeys.has(normalizeKeyForComparison(key))) {
          filteredBindings[key] = action
        }
      }
      return { context: block.context, bindings: filteredBindings }
    })
    .filter(block => Object.keys(block.bindings).length > 0)
}

/**
 * Generate a template keybindings.json file content.
 * Creates a fully valid JSON file with all default bindings that users can customize.
 */
export function generateKeybindingsTemplate(): string {
  // Filter out reserved shortcuts that cannot be rebound
  const bindings = filterReservedShortcuts(DEFAULT_BINDINGS)

  // Format as object wrapper with bindings array
  const config = {
    $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
    $docs: 'https://code.claude.com/docs/en/keybindings',
    bindings,
  }

  return jsonStringify(config, null, 2) + '\n'
}
