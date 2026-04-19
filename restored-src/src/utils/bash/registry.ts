/**
 * 命令规格（Spec）注册表模块。
 *
 * 在 Claude Code 系统中，该模块负责加载和缓存命令的 Fig Autocomplete 规格，
 * 供权限前缀匹配（prefix.ts）和补全（shellCompletion.ts）等模块使用：
 * - CommandSpec / Argument / Option 类型：描述命令的子命令、参数和选项结构
 *   - Argument.isCommand：标记"包装命令"参数（如 sudo、timeout 内的子命令）
 *   - Argument.isModule：标记 python -m 类模块参数
 *   - Argument.isScript：标记脚本文件参数
 * - loadFigSpec()：按命令名从 @withfig/autocomplete 动态加载规格，带路径注入防御
 * - getCommandSpec()：带 LRU 缓存的规格查询，优先内置 specs，其次动态加载
 */
import { memoizeWithLRU } from '../memoize.js'
import specs from './specs/index.js'

export type CommandSpec = {
  name: string
  description?: string
  subcommands?: CommandSpec[]
  args?: Argument | Argument[]
  options?: Option[]
}

export type Argument = {
  name?: string
  description?: string
  isDangerous?: boolean
  isVariadic?: boolean // repeats infinitely e.g. echo hello world
  isOptional?: boolean
  isCommand?: boolean // wrapper commands e.g. timeout, sudo
  isModule?: string | boolean // for python -m and similar module args
  isScript?: boolean // script files e.g. node script.js
}

export type Option = {
  name: string | string[]
  description?: string
  args?: Argument | Argument[]
  isRequired?: boolean
}

/**
 * 按命令名从 @withfig/autocomplete 动态加载规格。
 * 路径注入防御：拒绝包含 /、\、.. 或以 - 开头的命令名，
 * 防止恶意命令名穿越目录或加载意外模块。
 */
export async function loadFigSpec(
  command: string,
): Promise<CommandSpec | null> {
  if (!command || command.includes('/') || command.includes('\\')) return null
  if (command.includes('..')) return null
  if (command.startsWith('-') && command !== '-') return null

  try {
    const module = await import(`@withfig/autocomplete/build/${command}.js`)
    return module.default || module
  } catch {
    return null
  }
}
/**
 * 带 LRU 缓存的命令规格查询。
 * 优先从内置 specs 数组查找（精确名称匹配），
 * 未找到则调用 loadFigSpec() 动态加载，结果缓存以命令名为键。
 */
export const getCommandSpec = memoizeWithLRU(
  async (command: string): Promise<CommandSpec | null> => {
    const spec =
      specs.find(s => s.name === command) ||
      (await loadFigSpec(command)) ||
      null
    return spec
  },
  (command: string) => command,
)
