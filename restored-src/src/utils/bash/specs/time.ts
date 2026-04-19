/**
 * time 命令规格定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 time 命令的 CommandSpec 规格，
 * 供 registry.ts 的 getCommandSpec() 优先查找，用于权限前缀匹配（shellPrefix.ts）。
 * time 是"包装命令"（args.isCommand: true），对子命令计时并在执行结束后
 * 输出 real/user/sys 三项耗时统计。权限检查器需递归检查被包装子命令的权限。
 */
import type { CommandSpec } from '../registry.js'

/**
 * time 命令的 CommandSpec 规格对象。
 * 参数标记为 isCommand: true，表示该参数是完整子命令，
 * 权限系统将递归展开并检查该子命令的执行权限。
 */
const time: CommandSpec = {
  name: 'time', // 命令名，与 registry 查询键精确匹配
  description: 'Time a command',
  args: {
    name: 'command',
    description: 'Command to time',
    isCommand: true, // 标记此参数为子命令，触发权限递归检查
  },
}

export default time
