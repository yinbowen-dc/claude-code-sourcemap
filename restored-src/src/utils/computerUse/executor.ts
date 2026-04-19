/**
 * CLI ComputerExecutor 实现模块。
 *
 * 在 Claude Code 系统中，该模块封装两个原生模块实现 ComputerExecutor 接口：
 * - `@ant/computer-use-input`（Rust/enigo）：鼠标、键盘、前台应用控制
 * - `@ant/computer-use-swift`（Swift）：SCContentFilter 截图、NSWorkspace 应用管理、TCC 权限
 *
 * 与 Cowork 参考实现的主要差异（CLI deltas）：
 * - 无 withClickThrough：终端无窗口，点击穿透括号为空操作
 * - 以终端作为代理宿主：getTerminalBundleId() 检测终端模拟器并传给 Swift 侧，
 *   使其在隐藏和 z-order 激活遍历中豁免终端本身
 * - 剪贴板通过 pbcopy/pbpaste 实现，无 Electron clipboard 模块
 * - createCliExecutor()：创建 CLI 版 ComputerExecutor 实例
 * - unhideComputerUseApps()：取消隐藏在 Computer Use 过程中被隐藏的应用
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '@ant/computer-use-mcp'

import { API_RESIZE_PARAMS, targetImageSize } from '@ant/computer-use-mcp'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { sleep } from '../sleep.js'
import {
  CLI_CU_CAPABILITIES,
  CLI_HOST_BUNDLE_ID,
  getTerminalBundleId,
} from './common.js'
import { drainRunLoop } from './drainRunLoop.js'
import { notifyExpectedEscape } from './escHotkey.js'
import { requireComputerUseInput } from './inputLoader.js'
import { requireComputerUseSwift } from './swiftLoader.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// JPEG 截图质量，0.75 在文件大小和图像质量之间取得平衡
const SCREENSHOT_JPEG_QUALITY = 0.75

/**
 * 将逻辑坐标（logical points）转换为物理像素，再映射到 API 目标尺寸。
 *
 * macOS 的 Retina 屏幕中，逻辑点 × scaleFactor = 物理像素；
 * 再经过 targetImageSize 缩放，确保截图符合 API 期望分辨率，
 * 同时保持 scaleCoord 坐标系一致。详见 targetImageSize + COORDINATES.md。
 */
function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  // 逻辑分辨率乘以 scaleFactor 得到物理像素（Retina 屏为 2x）
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  // 按 API_RESIZE_PARAMS 规范缩放至目标尺寸
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

/**
 * 通过系统 pbpaste 命令读取剪贴板内容。
 *
 * CLI 环境下无 Electron clipboard 模块，使用 macOS 原生命令行工具替代。
 * 非零退出码视为错误并抛出，调用方需处理异常。
 */
async function readClipboardViaPbpaste(): Promise<string> {
  const { stdout, code } = await execFileNoThrow('pbpaste', [], {
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbpaste exited with code ${code}`)
  }
  return stdout
}

/**
 * 通过系统 pbcopy 命令将文本写入剪贴板。
 *
 * 文本通过 stdin 传给 pbcopy，避免 shell 转义问题。
 * 非零退出码视为写入失败并抛出异常。
 */
async function writeClipboardViaPbcopy(text: string): Promise<void> {
  const { code } = await execFileNoThrow('pbcopy', [], {
    input: text,
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbcopy exited with code ${code}`)
  }
}

// Input 模块的类型别名，方便各 helper 函数的参数类型注解
type Input = ReturnType<typeof requireComputerUseInput>

/**
 * 判断给定按键序列是否为单独的 Escape 键（不带任何修饰键）。
 *
 * enigo 接受 "escape" 和 "esc" 两种拼写，CGEventTap 的豁免孔也需同步支持。
 * 注意：ctrl+escape、alt+escape 等组合键不属于 bare escape，不应触发中止。
 */
function isBareEscape(parts: readonly string[]): boolean {
  // 必须是单元素序列，排除组合键（如 ctrl+escape）
  if (parts.length !== 1) return false
  const lower = parts[0]!.toLowerCase()
  // enigo 接受 "escape" 和 "esc" 两种写法，需同时支持
  return lower === 'escape' || lower === 'esc'
}

/**
 * 即时移动鼠标后等待 50ms，使 HID 事件经过 AppKit→NSEvent 完成一次轮询。
 *
 * 该延迟确保下一步的点击或滚动能正确读取 NSEvent.mouseLocation，
 * 同时避免中间动画帧触发 hover 状态或产生多余的 leftMouseDragged 事件。
 * 用于 click、scroll 和 drag-from 起始点；drag-to 终点使用 animatedMove。
 */
const MOVE_SETTLE_MS = 50

async function moveAndSettle(
  input: Input,
  x: number,
  y: number,
): Promise<void> {
  await input.moveMouse(x, y, false)
  // 等待 HID 事件完成 AppKit 轮询（50ms 经过实测验证）
  await sleep(MOVE_SETTLE_MS)
}

/**
 * 按逆序释放已按下的修饰键（最后按下的最先释放）。
 *
 * 错误被吞掉，避免 release 失败掩盖真正的异常。
 * 使用 pop() 逐个弹出而非快照长度：即使 drainRunLoop 超时后孤儿 lambda
 * 在 finally 调用之后继续向 pressed 追加，下一次迭代仍能释放，
 * 不会留下卡住的按键。孤儿标志 orphaned 负责在下一次 check 停止 lambda。
 */
async function releasePressed(input: Input, pressed: string[]): Promise<void> {
  let k: string | undefined
  while ((k = pressed.pop()) !== undefined) {
    try {
      await input.key(k, 'release')
    } catch {
      // 最佳努力释放，吞掉错误，避免掩盖原始异常
    }
  }
}

/**
 * 用修饰键包装 fn()：先逐个 press 修饰键，执行 fn()，最后逆序 release。
 *
 * `pressed` 仅记录实际已按下的键：mid-press 抛出时只释放已确认按下的键，
 * 避免 stuck modifiers（卡住的修饰键）问题。finally 覆盖 press 阶段和 fn() 的异常。
 * 调用方必须已在 drainRunLoop() 内，因为 key() 会将任务派发到主队列。
 */
async function withModifiers<T>(
  input: Input,
  mods: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const pressed: string[] = []
  try {
    for (const m of mods) {
      await input.key(m, 'press')
      // 仅记录实际已按下的修饰键，确保 finally 只释放已确认按下的键
      pressed.push(m)
    }
    return await fn()
  } finally {
    await releasePressed(input, pressed)
  }
}

/**
 * 通过剪贴板粘贴方式输入长文本（Cowork typeViaClipboard 的 CLI 移植版）。
 *
 * 执行流程：
 *   1. 保存用户当前剪贴板内容（pbpaste）
 *   2. 将目标文本写入剪贴板（pbcopy）
 *   3. 读回验证：写入可能无声失败，若读回不匹配则拒绝粘贴（避免粘贴乱内容）
 *   4. 模拟 Cmd+V 按键
 *   5. 等待 100ms：防止粘贴效果与剪贴板恢复产生竞态（过早恢复导致粘贴恢复内容）
 *   6. 在 finally 块中恢复剪贴板：即使中途抛出也不会破坏用户剪贴板
 */
async function typeViaClipboard(input: Input, text: string): Promise<void> {
  let saved: string | undefined
  try {
    // 步骤1：保存当前剪贴板内容
    saved = await readClipboardViaPbpaste()
  } catch {
    logForDebugging(
      '[computer-use] pbpaste before paste failed; proceeding without restore',
    )
  }

  try {
    // 步骤2：将目标文本写入剪贴板
    await writeClipboardViaPbcopy(text)
    // 步骤3：读回验证，防止剪贴板写入无声失败
    if ((await readClipboardViaPbpaste()) !== text) {
      throw new Error('Clipboard write did not round-trip.')
    }
    // 步骤4：模拟 Cmd+V 粘贴
    await input.keys(['command', 'v'])
    // 步骤5：等待 100ms，确保粘贴效果完成后再恢复剪贴板
    await sleep(100)
  } finally {
    // 步骤6：恢复用户原来的剪贴板内容，失败则静默忽略
    if (typeof saved === 'string') {
      try {
        await writeClipboardViaPbcopy(saved)
      } catch {
        logForDebugging('[computer-use] clipboard restore after paste failed')
      }
    }
  }
}

/**
 * 缓动动画移动鼠标（ease-out-cubic，60fps），主要用于 drag 操作的目标点移动。
 *
 * 参考 Cowork 的 animateMouseMovement + animatedMove：
 * - 持续时间按距离等比例，速率 2000px/s，上限 0.5s
 * - 当子功能开关关闭或距离小于约 2 帧时，退化为 moveAndSettle
 * - 仅用于 drag 的 press→to 拖动路径：目标应用可能监听 leftMouseDragged 事件，
 *   缓慢移动给应用足够时间处理中间坐标（如滚动条、窗口缩放等）
 */
async function animatedMove(
  input: Input,
  targetX: number,
  targetY: number,
  mouseAnimationEnabled: boolean,
): Promise<void> {
  // 若鼠标动画功能关闭，直接使用即时移动
  if (!mouseAnimationEnabled) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const start = await input.mouseLocation()
  const deltaX = targetX - start.x
  const deltaY = targetY - start.y
  const distance = Math.hypot(deltaX, deltaY)
  // 距离不足 1px，无需移动
  if (distance < 1) return
  // 按 2000px/s 计算持续时间，最长 0.5s
  const durationSec = Math.min(distance / 2000, 0.5)
  // 持续时间不足约 2 帧（33ms），退化为即时移动
  if (durationSec < 0.03) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const frameRate = 60
  const frameIntervalMs = 1000 / frameRate
  const totalFrames = Math.floor(durationSec * frameRate)
  for (let frame = 1; frame <= totalFrames; frame++) {
    // t 归一化帧进度 [0, 1]
    const t = frame / totalFrames
    // ease-out-cubic 缓动函数：慢速减速效果
    const eased = 1 - Math.pow(1 - t, 3)
    await input.moveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
      false,
    )
    if (frame < totalFrames) {
      await sleep(frameIntervalMs)
    }
  }
  // 最后一帧无额外睡眠，但需等待 HID 完成轮询后调用方才能读取 NSEvent.mouseLocation
  await sleep(MOVE_SETTLE_MS)
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * 创建 CLI 版 ComputerExecutor 实例。
 *
 * 整合 Swift（截图、应用管理、显示信息）和 Rust/enigo（鼠标、键盘）两个原生模块，
 * 返回符合 ComputerExecutor 接口的对象，供 MCP 工具调用。
 *
 * 关键 CLI 差异（相比 Cowork Electron 版本）：
 * - 无 withClickThrough（终端无窗口，点击穿透为空操作）
 * - 以终端为代理宿主（surrogateHost），隐藏/激活遍历时豁免终端自身
 * - 剪贴板通过 pbcopy/pbpaste 而非 Electron clipboard 模块实现
 */
export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'darwin') {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control is macOS-only.`,
    )
  }

  // Swift 模块在工厂函数时立即加载，所有执行器方法都需要它
  // Input 模块通过 requireComputerUseInput() 懒加载，仅截图操作时不会拉取 enigo .node
  const cu = requireComputerUseSwift()

  const { getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts
  const terminalBundleId = getTerminalBundleId()
  // 终端 bundleId 作为代理宿主，隐藏/激活遍历时豁免终端本身；未检测到则使用哨兵 ID
  const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID
  // Swift 0.2.1 的 captureExcluding/captureRegion 接受 ALLOW 列表（名称虽带 excluding，实为白名单）
  // 终端不在用户授权列表中会自然排除，但为安全起见在此过滤，防止终端出现在截图中
  const withoutTerminal = (allowed: readonly string[]): string[] =>
    terminalBundleId === null
      ? [...allowed]
      : allowed.filter(id => id !== terminalBundleId)

  logForDebugging(
    terminalBundleId
      ? `[computer-use] terminal ${terminalBundleId} → surrogate host (hide-exempt, activate-skip, screenshot-excluded)`
      : '[computer-use] terminal not detected; falling back to sentinel host',
  )

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    // ── Pre-action sequence (hide + defocus) ────────────────────────────

    /**
     * 执行操作前的准备序列：隐藏非白名单应用并将焦点切换到目标。
     *
     * prepareDisplay 非 @MainActor，其内部 .hide() 调用产生的窗口管理器事件
     * 需要 CFRunLoop 泵送才能实时处理，否则事件堆积后集中刷新会导致窗口闪烁。
     * CLI 环境需手动调用 drainRunLoop，Electron 版本则持续运行 CFRunLoop 无需此操作。
     * 失败时记录警告并返回空数组，继续执行主操作（前台门控在 toolCalls.ts 处理）。
     */
    async prepareForAction(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<string[]> {
      if (!getHideBeforeActionEnabled()) {
        return []
      }
      // prepareDisplay 非 @MainActor（内部用 plain Task{}），但其 .hide() 调用
      // 会向 CFRunLoop 排队窗口管理器事件。不泵送时，这些事件在 ~1s 的 usleeps
      // 期间堆积，待下一次有泵调用时集中刷新，导致可见的窗口闪烁。
      // Electron 持续泵 CFRunLoop 故 Cowork 不受影响。
      // 安全预算：最坏情况 100ms + 5×200ms = ~1.1s，远低于 drainRunLoop 的 30s 上限。
      return drainRunLoop(async () => {
        try {
          const result = await cu.apps.prepareDisplay(
            allowlistBundleIds,
            surrogateHost,
            displayId,
          )
          if (result.activated) {
            logForDebugging(
              `[computer-use] prepareForAction: activated ${result.activated}`,
            )
          }
          return result.hidden
        } catch (err) {
          logForDebugging(
            `[computer-use] prepareForAction failed; continuing to action: ${errorMessage(err)}`,
            { level: 'warn' },
          )
          return []
        }
      })
    },

    async previewHideSet(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      return cu.apps.previewHideSet(
        [...allowlistBundleIds, surrogateHost],
        displayId,
      )
    },

    // ── Display ──────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return cu.display.getSize(displayId)
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return cu.display.listAll()
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return cu.apps.findWindowDisplays(bundleIds)
    },

    /**
     * 截图前的一体化准备流程（隐藏应用 + 截图），减少多次 IPC 往返的时间窗口。
     *
     * 预先计算目标尺寸，通过 drainRunLoop 泵送 CFRunLoop 确保截图时窗口状态稳定。
     */
    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const d = cu.display.getSize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      return drainRunLoop(() =>
        cu.resolvePrepareCapture(
          withoutTerminal(opts.allowedBundleIds),
          surrogateHost,
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.preferredDisplayId,
          opts.autoResolve,
          opts.doHide,
        ),
      )
    },

    /**
     * 截图当前屏幕，排除非白名单应用（captureExcluding 实为白名单语义）。
     *
     * 预先计算 targetImageSize，使 API 端转码器早返回，无需服务端再次缩放，
     * 保持 scaleCoord 坐标系与截图坐标一致。详见 COORDINATES.md。
     */
    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      const d = cu.display.getSize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      return drainRunLoop(() =>
        cu.screenshot.captureExcluding(
          withoutTerminal(opts.allowedBundleIds),
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.displayId,
        ),
      )
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      allowedBundleIds: string[],
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      const d = cu.display.getSize(displayId)
      const [outW, outH] = computeTargetDims(
        regionLogical.w,
        regionLogical.h,
        d.scaleFactor,
      )
      return drainRunLoop(() =>
        cu.screenshot.captureRegion(
          withoutTerminal(allowedBundleIds),
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          outW,
          outH,
          SCREENSHOT_JPEG_QUALITY,
          displayId,
        ),
      )
    },

    // ── Keyboard ─────────────────────────────────────────────────────────

    /**
     * xdotool 风格的按键序列（如 "ctrl+shift+a"），按 '+' 分割后传给 keys()。
     *
     * keys() 将任务派发到 DispatchQueue.main，drainRunLoop 泵 CFRunLoop 使其解析。
     * Rust 的错误路径清理（enigo_wrap.rs）会在每次调用时释放修饰键，
     * 因此 mid-loop 抛出不会留下卡住的按键。每次迭代间隔 8ms（125Hz USB 轮询节拍）。
     */
    async key(keySequence: string, repeat?: number): Promise<void> {
      const input = requireComputerUseInput()
      const parts = keySequence.split('+').filter(p => p.length > 0)
      // 仅单独的 Escape 需要打豁免孔；ctrl+escape 等组合键不会触发中止
      const isEsc = isBareEscape(parts)
      const n = repeat ?? 1
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          // 多次重复之间等待 8ms（USB 125Hz 轮询间隔）
          if (i > 0) {
            await sleep(8)
          }
          // 模型合成 Esc 前通知 CGEventTap，打开 100ms 豁免孔，避免误触中止回调
          if (isEsc) {
            notifyExpectedEscape()
          }
          await input.keys(parts)
        }
      })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      const input = requireComputerUseInput()
      // press/release 各自包装在 drainRunLoop 中；sleep 在外部，避免受 drainRunLoop 30s 超时限制。
      // pressed 追踪实际已按键，mid-press 异常仍能正确释放已按的键。
      // orphaned 防范超时孤儿竞态：若 press 阶段的 drainRunLoop 超时但 esc-hotkey 泵保持运行，
      // 孤儿 lambda 可能在 finally 的 releasePressed 快照长度后继续 push，导致按键卡住。
      // orphaned 标志使 lambda 在下一次迭代停止。
      const pressed: string[] = []
      let orphaned = false
      try {
        await drainRunLoop(async () => {
          for (const k of keyNames) {
            // 检查孤儿标志：若父 drainRunLoop 已超时，停止继续按键
            if (orphaned) return
            // 单独 Escape：通知 CGEventTap 打豁免孔，同 key()
            if (isBareEscape([k])) {
              notifyExpectedEscape()
            }
            await input.key(k, 'press')
            pressed.push(k)
          }
        })
        // 持键时长不受 drainRunLoop 超时约束
        await sleep(durationMs)
      } finally {
        // 设置孤儿标志，防止超时后 lambda 继续追加
        orphaned = true
        await drainRunLoop(() => releasePressed(input, pressed))
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      const input = requireComputerUseInput()
      if (opts.viaClipboard) {
        // typeViaClipboard 内部的 keys(['command','v']) 需要 CFRunLoop 泵送
        await drainRunLoop(() => typeViaClipboard(input, text))
        return
      }
      // toolCalls.ts 处理 grapheme 循环和 8ms 间隔，每次调用传入单个字素
      // typeText 不派发到主队列，无需 drainRunLoop
      await input.typeText(text)
    },

    readClipboard: readClipboardViaPbpaste,

    writeClipboard: writeClipboardViaPbcopy,

    // ── Mouse ────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      await moveAndSettle(requireComputerUseInput(), x, y)
    },

    /**
     * 移动鼠标后点击。修饰键通过 withModifiers 包装确保 press/release 配对。
     *
     * AppKit 根据时间和位置接近度计算 NSEvent.clickCount，
     * 因此双击/三击无需手动设置 CGEvent clickState 字段。
     * 有修饰键时需要 drainRunLoop，无修饰键路径则无需泵送。
     */
    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (modifiers && modifiers.length > 0) {
        await drainRunLoop(() =>
          withModifiers(input, modifiers, () =>
            input.mouseButton(button, 'click', count),
          ),
        )
      } else {
        await input.mouseButton(button, 'click', count)
      }
    },

    async mouseDown(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'press')
    },

    async mouseUp(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'release')
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return requireComputerUseInput().mouseLocation()
    },

    /**
     * 从 from 拖拽到 to。
     *
     * from 为 undefined 时从当前光标位置开始（支持省略 start_coordinate 的 left_click_drag）。
     * 鼠标按下后等待 50ms：让 enigo 的 move_mouse 读到 NSEvent.pressedMouseButtons，
     * 使移动事件类型正确为 leftMouseDragged 而非 mouseMoved。
     * finally 确保即使 animatedMove 抛出也会释放左键，防止左键卡住。
     */
    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      const input = requireComputerUseInput()
      if (from !== undefined) {
        await moveAndSettle(input, from.x, from.y)
      }
      await input.mouseButton('left', 'press')
      await sleep(MOVE_SETTLE_MS)
      try {
        await animatedMove(input, to.x, to.y, getMouseAnimationEnabled())
      } finally {
        await input.mouseButton('left', 'release')
      }
    },

    /**
     * 移动到目标位置后滚动。垂直轴优先（更常用），水平轴失败不影响垂直方向结果。
     */
    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (dy !== 0) {
        await input.mouseScroll(dy, 'vertical')
      }
      if (dx !== 0) {
        await input.mouseScroll(dx, 'horizontal')
      }
    },

    // ── App management ───────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      const info = requireComputerUseInput().getFrontmostAppInfo()
      if (!info || !info.bundleId) return null
      return { bundleId: info.bundleId, displayName: info.appName }
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      return cu.apps.appUnderPoint(x, y)
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      // ComputerUseInstalledApp 包含 {bundleId, displayName, path}
      // InstalledApp 额外有可选的 iconDataUrl，此处留空，审批对话框通过 getAppIcon() 懒加载图标
      return drainRunLoop(() => cu.apps.listInstalled())
    },

    async getAppIcon(path: string): Promise<string | undefined> {
      return cu.apps.iconDataUrl(path) ?? undefined
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return cu.apps.listRunning()
    },

    async openApp(bundleId: string): Promise<void> {
      await cu.apps.open(bundleId)
    },
  }
}

/**
 * 取消隐藏在 Computer Use 操作期间被隐藏的应用（模块级导出，非 executor 对象方法）。
 *
 * 由 stopHooks.ts / query.ts 在每轮结束时调用，在 executor 生命周期之外执行。
 * 调用方 fire-and-forget 并使用 .catch() 处理错误。
 * bundleIds 为空时提前返回，避免无效的 Swift IPC 调用。
 */
export async function unhideComputerUseApps(
  bundleIds: readonly string[],
): Promise<void> {
  if (bundleIds.length === 0) return
  const cu = requireComputerUseSwift()
  await cu.apps.unhide([...bundleIds])
}
