/**
 * sleep 命令的规格（Spec）定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 sleep 命令的 Fig Autocomplete 规格。
 * sleep 用于暂停执行指定时长，接受纯数字（秒）或带单位后缀的时间字符串
 *（如 5s / 2m / 1h）。由于 sleep 不包装子命令，无需 isCommand 标记。
 */
import type { CommandSpec } from '../registry.js'

/**
 * sleep 命令的 CommandSpec 规格对象。
 * 只有单个必填参数 duration，不携带任何选项（options），
 * 也不包装子命令，权限系统仅需检查 sleep 本身是否被允许执行。
 */
const sleep: CommandSpec = {
  name: 'sleep', // 命令名，与 registry 查询键精确匹配
  description: 'Delay for a specified amount of time',
  args: {
    name: 'duration',
    description: 'Duration to sleep (seconds or with suffix like 5s, 2m, 1h)',
    isOptional: false, // 时长为必填参数，缺少时命令无法执行
  },
}

export default sleep
