/**
 * nohup 命令的规格（Spec）定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 nohup 命令的 Fig Autocomplete 规格。
 * nohup 用于在终端关闭（SIGHUP 信号）后继续运行子命令，常用于后台任务。
 * command 参数标记为 isCommand: true，表示该参数本身是一个可执行命令，
 * 使权限前缀匹配模块（shellPrefix.ts）能够递归解析被包装的子命令，
 * 从而正确评估 `nohup <子命令>` 的权限。
 */
import type { CommandSpec } from '../registry.js'

/**
 * nohup 命令的 CommandSpec 规格对象。
 * 作为"包装命令"，其唯一参数标记为 isCommand: true，
 * 权限系统会对该子命令递归执行权限校验，而非仅检查 nohup 自身。
 */
const nohup: CommandSpec = {
  name: 'nohup', // 命令名，与 registry 查询键精确匹配
  description: 'Run a command immune to hangups',
  args: {
    name: 'command',
    description: 'Command to run with nohup',
    isCommand: true, // 标记此参数为子命令，触发权限递归检查
  },
}

export default nohup
