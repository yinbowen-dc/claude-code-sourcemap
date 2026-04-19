/**
 * srun 命令规格定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 SLURM 集群作业管理命令 srun 的 CommandSpec 规格，
 * 供 registry.ts 的 getCommandSpec() 优先查找，用于权限前缀匹配（shellPrefix.ts）。
 * srun 是"包装命令"（args.isCommand: true），在 SLURM 集群节点上分发并执行指定命令；
 * 权限检查器需递归检查被包装子命令的执行权限。
 * 该规格补充了 @withfig/autocomplete 中缺失的 srun 条目。
 */
import type { CommandSpec } from '../registry.js'

/**
 * srun 命令的 CommandSpec 规格对象。
 * 包含两个核心资源分配选项（-n/--ntasks 与 -N/--nodes），
 * 以及一个标记为 isCommand: true 的子命令参数，触发权限递归检查。
 */
const srun: CommandSpec = {
  name: 'srun', // 命令名，与 registry 查询键精确匹配
  description: 'Run a command on SLURM cluster nodes',
  options: [
    {
      name: ['-n', '--ntasks'], // 同时接受短选项 -n 和长选项 --ntasks
      description: 'Number of tasks',
      args: {
        name: 'count',
        description: 'Number of tasks to run', // 指定并行任务数量
      },
    },
    {
      name: ['-N', '--nodes'],
      description: 'Number of nodes',
      args: {
        name: 'count',
        description: 'Number of nodes to allocate', // 指定分配的集群节点数
      },
    },
  ],
  args: {
    name: 'command',
    description: 'Command to run on the cluster',
    isCommand: true, // 标记此参数为子命令，在集群节点上执行
  },
}

export default srun
