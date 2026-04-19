/**
 * heapdump 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/heapdump` 命令的注册描述符。
 * 该命令属于隐藏的内部调试工具，不会在 `/help` 列表中向普通用户显示。
 * 触发后将调用 `heapdump.js` 把当前 Node.js 进程的 JS 堆内存快照写至 ~/Desktop，
 * 帮助 Anthropic 工程师诊断内存问题。
 */
import type { Command } from '../../commands.js'

/**
 * heapdump 命令描述符对象
 *
 * - type: 'local' 表示本地执行，不渲染 JSX UI
 * - isHidden: true 使该命令在帮助文档和命令列表中不可见，属于内部专用命令
 * - supportsNonInteractive: 允许在脚本/批处理场景中执行（无需用户交互）
 * - load: 懒加载实现模块，按需导入以减少启动开销
 */
const heapDump = {
  type: 'local',
  name: 'heapdump',
  description: 'Dump the JS heap to ~/Desktop',
  // 隐藏此命令，不在 /help 的命令列表中展示
  isHidden: true,
  supportsNonInteractive: true,
  // 按需懒加载实际的堆转储执行逻辑
  load: () => import('./heapdump.js'),
} satisfies Command

export default heapDump
