/**
 * alias 命令的规格（Spec）定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 shell 内置 alias 命令的 Fig Autocomplete 规格，
 * 供 registry.ts 的 getCommandSpec() 在权限前缀解析（shellPrefix.ts）和
 * Tab 补全（shellCompletion.ts）时使用。
 * alias 的参数为可选可变参数：单独执行 `alias` 可列出所有当前别名，
 * `alias name=value` 则创建新别名。
 */
import type { CommandSpec } from '../registry.js'

/**
 * alias 命令的 CommandSpec 规格对象。
 * 参数设为可选且可变（isOptional + isVariadic），
 * 允许零参数（列出别名）或多个 name=value 定义同时传入。
 */
const alias: CommandSpec = {
  name: 'alias', // 命令名，与 registry 查询键精确匹配
  description: 'Create or list command aliases',
  args: {
    name: 'definition',
    description: 'Alias definition in the form name=value',
    isOptional: true, // 无参数时列出所有已定义别名
    isVariadic: true, // 支持一次定义多个别名：alias a=x b=y
  },
}

export default alias
