/**
 * Computer Use 单轮清理模块。
 *
 * 在 Claude Code 系统中，该模块在每次 Computer Use 工具调用轮次结束后执行清理：
 * - cleanupComputerUseAfterTurn()：取消隐藏本轮被隐藏的应用（最多等待 UNHIDE_TIMEOUT_MS = 5000ms）、
 *   释放 computer-use.lock 文件锁、向操作系统发送"已完成使用您的计算机"通知，
 *   并注销 Esc 全局热键。
 */
import type { ToolUseContext } from '../../Tool.js'

import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { withResolvers } from '../withResolvers.js'
import { isLockHeldLocally, releaseComputerUseLock } from './computerUseLock.js'
import { unregisterEscHotkey } from './escHotkey.js'

// cu.apps.unhide 不在 drainRunLoop 30 秒兜底机制保护的四个 @MainActor 方法之列。
// 在中止路径（用户因操作缓慢按下 Ctrl+C）中，若此处挂起会导致中止流程卡死。
// 设置宽松超时 —— 取消隐藏应该是瞬时的；若超过 5 秒则说明出现异常，
// 继续执行优于无限等待。Swift 调用会在后台继续运行；我们只是停止阻塞等待它。
const UNHIDE_TIMEOUT_MS = 5000

/**
 * chicago MCP surface 的轮次结束清理：自动取消隐藏
 * `prepareForAction` 隐藏的应用，然后释放基于文件的锁。
 *
 * 在三处被调用：正常轮次结束（`stopHooks.ts`）、
 * 流式传输中的中止（`query.ts` aborted_streaming）、
 * 工具执行中的中止（`query.ts` aborted_tools）。
 * 三者均通过受 `feature('CHICAGO_MCP')` 门控的动态 import 到达此处。
 * 下方动态导入 `executor.js`（包含两个 native 模块），
 * 使非 CU 轮次不会因加载 native 模块只是 no-op 而产生开销。
 *
 * 对非 CU 轮次低开销 no-op：两个门控检查均无系统调用。
 */
export async function cleanupComputerUseAfterTurn(
  ctx: Pick<
    ToolUseContext,
    'getAppState' | 'setAppState' | 'sendOSNotification'
  >,
): Promise<void> {
  const appState = ctx.getAppState()

  const hidden = appState.computerUseMcpState?.hiddenDuringTurn
  if (hidden && hidden.size > 0) {
    const { unhideComputerUseApps } = await import('./executor.js')
    const unhide = unhideComputerUseApps([...hidden]).catch(err =>
      logForDebugging(
        `[Computer Use MCP] auto-unhide failed: ${errorMessage(err)}`,
      ),
    )
    const timeout = withResolvers<void>()
    const timer = setTimeout(timeout.resolve, UNHIDE_TIMEOUT_MS)
    await Promise.race([unhide, timeout.promise]).finally(() =>
      clearTimeout(timer),
    )
    ctx.setAppState(prev =>
      prev.computerUseMcpState?.hiddenDuringTurn === undefined
        ? prev
        : {
            ...prev,
            computerUseMcpState: {
              ...prev.computerUseMcpState,
              hiddenDuringTurn: undefined,
            },
          },
    )
  }

  // 零系统调用预检查，使非 CU 轮次不触及磁盘。释放操作幂等
  // （若已释放或由其他 session 持有，返回 false）。
  if (!isLockHeldLocally()) return

  // 在锁释放前注销热键，确保泵保持（pump-retain）在 CU session 结束时立即释放。
  // 幂等 —— 若获取时注册失败则 no-op。
  // 吞掉抛出的错误，防止 NAPI 注销错误阻止锁释放 ——
  // 锁被持有会在下次 CU session 时提示"已被其他 session 使用"。
  try {
    unregisterEscHotkey()
  } catch (err) {
    logForDebugging(
      `[Computer Use MCP] unregisterEscHotkey failed: ${errorMessage(err)}`,
    )
  }

  if (await releaseComputerUseLock()) {
    ctx.sendOSNotification?.({
      message: 'Claude is done using your computer',
      notificationType: 'computer_use_exit',
    })
  }
}
