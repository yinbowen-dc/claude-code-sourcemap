/**
 * heapdump 命令实现模块
 *
 * 本文件是 `/heapdump` 命令的核心执行逻辑，是 Claude Code 内部调试工具链的一部分。
 * 当用户触发 `/heapdump` 命令时，由 index.ts 描述符懒加载本模块，
 * 随后 commands 框架调用 `call()` 函数，将 Node.js 堆内存快照写入 ~/Desktop，
 * 供开发人员使用 Chrome DevTools 等工具进行内存泄漏分析。
 */
import { performHeapDump } from '../../utils/heapDumpService.js'

/**
 * heapdump 命令的执行入口
 *
 * 调用底层 `performHeapDump` 服务完成实际的堆转储操作，并将结果包装为
 * commands 框架规定的文本响应格式返回给调用方。
 * 成功时返回堆快照文件路径与诊断文件路径；失败时返回包含错误原因的提示信息。
 *
 * @returns 包含 type:'text' 与 value 字段的对象，value 内容视成功与否而定
 */
export async function call(): Promise<{ type: 'text'; value: string }> {
  // 调用堆转储服务，将堆快照和诊断文件写入磁盘
  const result = await performHeapDump()

  // 转储失败时，返回包含具体错误原因的失败提示
  if (!result.success) {
    return {
      type: 'text',
      value: `Failed to create heap dump: ${result.error}`,
    }
  }

  // 成功时返回两个文件的绝对路径：堆快照路径 + 诊断文件路径，换行分隔
  return {
    type: 'text',
    value: `${result.heapPath}\n${result.diagPath}`,
  }
}
