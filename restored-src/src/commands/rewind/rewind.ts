/**
 * rewind 命令核心实现（commands/rewind/rewind.ts）
 *
 * 本文件实现 /rewind 命令的执行逻辑：通过调用上下文提供的消息选择器 UI，
 * 让用户从对话历史中选取一个检查点，进而将代码文件和会话消息回滚到该状态。
 *
 * 在 Claude Code 整体流程中的位置：
 *   /rewind 触发 → rewind/index.ts 注册项 → 本文件 call()
 *   → context.openMessageSelector() 弹出选择器 UI
 *   → 用户选择后由框架层执行实际的文件/消息回滚操作。
 *
 * 设计说明：本文件逻辑极简，UI 交互和回滚逻辑均委托给框架层（ToolUseContext），
 * 命令本身只负责触发入口，符合单一职责原则。
 */

import type { LocalCommandResult } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'

/**
 * /rewind 命令的主执行函数。
 *
 * 执行流程：
 *   1. 检查上下文是否提供了 openMessageSelector 回调（交互式终端下才存在）；
 *   2. 若存在，调用它以弹出历史消息选择器，让用户选择回滚目标；
 *   3. 返回 { type: 'skip' } 跳过消息追加，避免在对话流中产生额外的系统消息。
 *
 * @param _args    命令参数（本命令不使用参数，以 _ 前缀标记）
 * @param context  工具调用上下文，openMessageSelector 由渲染层注入
 */
export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  if (context.openMessageSelector) {
    // 调用框架注入的消息选择器，弹出历史检查点选择 UI
    context.openMessageSelector()
  }
  // Return a skip message to not append any messages.
  // 返回 skip 类型，告知命令系统不向对话追加任何消息（回滚操作本身无需文字回复）
  return { type: 'skip' }
}
