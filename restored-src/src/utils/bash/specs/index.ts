/**
 * 内置命令规格（Spec）汇总导出模块。
 *
 * 在 Claude Code 系统中，该文件将所有手工维护的内置命令规格对象聚合为数组，
 * 由 registry.ts 的 getCommandSpec() 在尝试动态加载 @withfig/autocomplete 之前
 * 优先检索，以确保对关键命令（如 timeout、srun、pyright 等）拥有精确的权限
 * 前缀解析与 Tab 补全能力。
 * 若需新增命令规格，只需在此文件中追加导入并加入导出数组即可生效。
 */
import type { CommandSpec } from '../registry.js'
import alias from './alias.js'   // shell 内置别名命令
import nohup from './nohup.js'   // 忽略 SIGHUP 的包装命令
import pyright from './pyright.js' // Python 静态类型检查工具
import sleep from './sleep.js'   // 延时暂停命令
import srun from './srun.js'     // SLURM 集群作业分发命令
import time from './time.js'     // 子命令计时包装命令
import timeout from './timeout.js' // 超时限制包装命令

// 按优先级排列：pyright 最先，确保其精确规格优先于 @withfig/autocomplete 的同名条目
export default [
  pyright,  // Python 类型检查，@withfig/autocomplete 中定义不够精确
  timeout,  // 包装命令，需递归权限检查
  sleep,    // 非包装命令，简单时长参数
  alias,    // shell 内置，isVariadic + isOptional
  nohup,    // 包装命令，需递归权限检查
  time,     // 包装命令，需递归权限检查
  srun,     // SLURM 包装命令，需递归权限检查
] satisfies CommandSpec[] // 类型断言：确保数组每项均符合 CommandSpec 约束
