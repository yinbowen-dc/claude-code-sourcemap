/**
 * timeout 命令规格定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 timeout 命令的 CommandSpec 规格，
 * 供 registry.ts 的 getCommandSpec() 优先查找，用于权限前缀匹配（shellPrefix.ts）。
 * timeout 是"包装命令"（args[1].isCommand: true），在指定时限内运行子命令，
 * 超时后默认发送 SIGTERM。权限检查器通过参数数组顺序识别时长（非命令）
 * 和被包装子命令（isCommand），并对后者递归进行权限校验。
 */
import type { CommandSpec } from '../registry.js'

/**
 * timeout 命令的 CommandSpec 规格对象。
 * args 为有序数组：第一个元素为必填的超时时长，
 * 第二个元素为被包装的子命令（isCommand: true），触发权限递归检查。
 */
const timeout: CommandSpec = {
  name: 'timeout', // 命令名，与 registry 查询键精确匹配
  description: 'Run a command with a time limit',
  args: [
    {
      name: 'duration',
      description: 'Duration to wait before timing out (e.g., 10, 5s, 2m)',
      isOptional: false, // 超时时长为必填，不可省略
    },
    {
      name: 'command',
      description: 'Command to run',
      isCommand: true, // 标记此参数为子命令，触发权限递归检查
    },
  ],
}

export default timeout
