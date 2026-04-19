/**
 * bridgeUI.ts — Bridge CLI 状态栏渲染器（chalk 版）
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 模式（Remote Control）UI 层
 *     └─> bridgeMain.ts / replBridge.ts（调用方）
 *           └─> bridgeUI.ts（本文件）——在终端中渲染 Bridge 连接状态栏
 *                 ├─ QR 码生成与显示（空格键切换）
 *                 ├─ 连接动画（connecting spinner）
 *                 ├─ 状态行（Ready / Connected / Reconnecting / Failed）
 *                 ├─ 多会话容量指示与每会话子列表
 *                 ├─ 工具活动摘要行（30 秒过期）
 *                 └─ 底栏页脚文字 + 快捷键提示
 *
 * 设计说明：
 *   本文件是 chalk 版（非 React/Ink 版）的 CLI 渲染器，
 *   通过 ANSI 转义序列（光标上移 + 清屏）实现"原地刷新"效果。
 *   React/Ink 版本见 bridge.tsx，两者通过 bridgeStatusUtil.ts 中的
 *   纯函数共享颜色/文本计算逻辑。
 *
 *   createBridgeLogger 是本文件的唯一导出，返回 BridgeLogger 接口的实现，
 *   包含所有状态更新方法（printBanner / updateIdleStatus / setAttached 等）。
 */
import chalk from 'chalk'
import { toString as qrToString } from 'qrcode'
import {
  BRIDGE_FAILED_INDICATOR,
  BRIDGE_READY_INDICATOR,
  BRIDGE_SPINNER_FRAMES,
} from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { logForDebugging } from '../utils/debug.js'
import {
  buildActiveFooterText,
  buildBridgeConnectUrl,
  buildBridgeSessionUrl,
  buildIdleFooterText,
  FAILED_FOOTER_TEXT,
  formatDuration,
  type StatusState,
  TOOL_DISPLAY_EXPIRY_MS,
  timestamp,
  truncatePrompt,
  wrapWithOsc8Link,
} from './bridgeStatusUtil.js'
import type {
  BridgeConfig,
  BridgeLogger,
  SessionActivity,
  SpawnMode,
} from './types.js'

/** QR 码生成选项：UTF-8 字符绘制、L 级纠错（最小密度）、小尺寸 */
const QR_OPTIONS = {
  type: 'utf8' as const,
  errorCorrectionLevel: 'L' as const,
  small: true,
}

/**
 * 异步生成 QR 码并返回每行字符串数组。
 * 过滤掉空行以避免多余的空白。
 */
async function generateQr(url: string): Promise<string[]> {
  const qr = await qrToString(url, QR_OPTIONS)
  return qr.split('\n').filter((line: string) => line.length > 0)
}

/**
 * 创建 Bridge CLI 日志记录器（BridgeLogger 接口实现）。
 *
 * 工厂函数，返回实现了 BridgeLogger 接口的对象，管理终端底部状态栏的
 * 渲染与刷新。所有状态变量均封装在闭包内：
 *   - 状态机变量（currentState / currentStateText）
 *   - 连接 URL / QR 码缓存
 *   - 工具活动摘要
 *   - 多会话列表
 *   - Connecting 动画定时器
 *
 * @param options.verbose 是否输出详细信息（printBanner 时显示版本/环境 ID 等）
 * @param options.write 底层输出函数（默认为 process.stdout.write）
 * @returns BridgeLogger 接口实现
 */
export function createBridgeLogger(options: {
  verbose: boolean
  write?: (s: string) => void
}): BridgeLogger {
  const write = options.write ?? ((s: string) => process.stdout.write(s))
  const verbose = options.verbose

  // 当前终端底部显示的状态行总视觉行数（用于 ANSI 清除计算）
  let statusLineCount = 0

  // 状态机变量
  let currentState: StatusState = 'idle'    // 当前连接状态
  let currentStateText = 'Ready'            // 状态栏显示文本
  let repoName = ''                          // 仓库名称（状态行后缀）
  let branch = ''                            // 当前分支（状态行后缀）
  let debugLogPath = ''                      // ANT-ONLY 调试日志路径

  // 连接 URL 缓存（printBanner 时根据 staging/prod 构建）
  let connectUrl = ''
  let cachedIngressUrl = ''
  let cachedEnvironmentId = ''
  let activeSessionUrl: string | null = null // 会话激活后显示的 URL

  // QR 码状态
  let qrLines: string[] = []  // QR 码每行字符串
  let qrVisible = false        // 是否显示 QR 码（空格键切换）

  // 工具活动摘要（第二状态行，30 秒过期）
  let lastToolSummary: string | null = null
  let lastToolTime = 0

  // 多会话容量指示
  let sessionActive = 0                              // 当前活跃会话数
  let sessionMax = 1                                  // 最大并发会话数
  let spawnModeDisplay: 'same-dir' | 'worktree' | null = null // 衍生模式（w 键提示）
  let spawnMode: SpawnMode = 'single-session'         // 实际衍生模式

  // 多会话子列表（键为兼容 sessionId，值为标题/URL/活动）
  const sessionDisplayInfo = new Map<
    string,
    { title?: string; url: string; activity?: SessionActivity }
  >()

  // Connecting 动画状态
  let connectingTimer: ReturnType<typeof setInterval> | null = null
  let connectingTick = 0  // 帧计数器（对 BRIDGE_SPINNER_FRAMES 取模）

  /**
   * 计算字符串在终端中占用的实际视觉行数（考虑折行）。
   *
   * 逻辑行通过 \n 分隔，每逻辑行根据视觉宽度和终端列宽计算折行数。
   * 末尾的 \n 不额外计一行（光标已在下一行开头）。
   * 用于 clearStatusLines() 精确上移光标行数。
   */
  function countVisualLines(text: string): number {
    // eslint-disable-next-line custom-rules/prefer-use-terminal-size
    const cols = process.stdout.columns || 80 // 非 React CLI 上下文，直接读取 columns
    let count = 0
    // 按 \n 拆分为逻辑行
    for (const logical of text.split('\n')) {
      if (logical.length === 0) {
        // 连续 \n 之间的空段 → 算作 1 行
        count++
        continue
      }
      const width = stringWidth(logical)
      count += Math.max(1, Math.ceil(width / cols)) // 折行后的实际行数
    }
    // 末尾 \n 的最后一个空段不计（光标已在下一行，未占用额外视觉行）
    if (text.endsWith('\n')) {
      count--
    }
    return count
  }

  /**
   * 向终端写出状态文本，并将其视觉行数累加到 statusLineCount。
   * 后续 clearStatusLines() 依赖此计数向上移动光标。
   */
  function writeStatus(text: string): void {
    write(text)
    statusLineCount += countVisualLines(text)
  }

  /**
   * 清除终端底部当前显示的所有状态行。
   *
   * 使用 ANSI 转义序列：
   *   \x1b[{N}A — 光标上移 N 行
   *   \x1b[J     — 清除光标到屏幕末尾
   * 清除后将 statusLineCount 重置为 0。
   */
  function clearStatusLines(): void {
    if (statusLineCount <= 0) return
    logForDebugging(`[bridge:ui] clearStatusLines count=${statusLineCount}`)
    write(`\x1b[${statusLineCount}A`) // 光标上移 N 行
    write('\x1b[J') // 清除光标到屏幕末尾
    statusLineCount = 0
  }

  /**
   * 打印永久性日志行（写入后不被状态刷新覆盖）。
   *
   * 先清除底部状态行，再写入日志，不恢复状态行——
   * 下一次 renderStatusLine() 调用时会重新渲染状态。
   */
  function printLog(line: string): void {
    clearStatusLines()
    write(line)
  }

  /**
   * 异步重新生成指定 URL 的 QR 码，完成后刷新状态行。
   * QR 码生成失败时只记录调试日志，不中断主流程。
   */
  function regenerateQr(url: string): void {
    generateQr(url)
      .then(lines => {
        qrLines = lines
        renderStatusLine()
      })
      .catch(e => {
        logForDebugging(`QR code generation failed: ${e}`, { level: 'error' })
      })
  }

  /**
   * 渲染"正在连接"动画行（printBanner 后、首次 updateIdleStatus 前显示）。
   *
   * 清除旧状态行后，写入当前帧的 spinner 字符 + "Connecting" + 仓库/分支后缀。
   */
  function renderConnectingLine(): void {
    clearStatusLines()

    const frame =
      BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName) // · 仓库名
    }
    if (branch) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch) // · 分支名
    }
    writeStatus(
      `${chalk.yellow(frame)} ${chalk.yellow('Connecting')}${suffix}\n`,
    )
  }

  /**
   * 启动 Connecting 动画定时器（每 150ms 推进一帧）。
   * 调用前先停止已有的定时器（防止重复启动）。
   * 第一次 updateIdleStatus() 调用时通过 stopConnecting() 停止。
   */
  function startConnecting(): void {
    stopConnecting()
    renderConnectingLine()
    connectingTimer = setInterval(() => {
      connectingTick++
      renderConnectingLine()
    }, 150)
  }

  /**
   * 停止 Connecting 动画定时器（清除 setInterval）。
   */
  function stopConnecting(): void {
    if (connectingTimer) {
      clearInterval(connectingTimer)
      connectingTimer = null
    }
  }

  /**
   * 根据当前状态机变量渲染并写出完整的状态块。
   *
   * 渲染流程（idle / attached / titled 状态）：
   *   1. 清除旧状态行
   *   2. 可选：QR 码行（qrVisible）
   *   3. ANT-ONLY 调试日志路径行（仅 USER_TYPE=ant）
   *   4. 主状态行（indicator + 状态文本 + 仓库/分支后缀）
   *   5. 多会话容量/列表行（sessionMax > 1）或单会话模式行（sessionMax === 1）
   *   6. 工具活动摘要行（单会话模式、已连接、30 秒内）
   *   7. 底栏页脚文字 + 快捷键提示
   *
   * reconnecting / failed 状态由各自的专用方法处理，此函数直接返回。
   */
  function renderStatusLine(): void {
    if (currentState === 'reconnecting' || currentState === 'failed') {
      // reconnecting / failed 由 updateReconnectingStatus / updateFailedStatus 专门处理，
      // 此处提前返回避免 toggleQr / setSpawnModeDisplay 等调用方误清除这些状态的显示
      return
    }

    clearStatusLines()

    const isIdle = currentState === 'idle'

    // 可选：在状态行上方显示 QR 码
    if (qrVisible) {
      for (const line of qrLines) {
        writeStatus(`${chalk.dim(line)}\n`)
      }
    }

    // 根据状态决定指示符和颜色（idle=绿色，attached/titled=青色）
    const indicator = BRIDGE_READY_INDICATOR
    const indicatorColor = isIdle ? chalk.green : chalk.cyan
    const baseColor = isIdle ? chalk.green : chalk.cyan
    const stateText = baseColor(currentStateText)

    // 构建状态行后缀（仓库名 · 分支名）
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
    }
    // worktree 模式下每个会话有自己的分支，显示 bridge 的分支会产生误导
    if (branch && spawnMode !== 'worktree') {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
    }

    // ANT-ONLY：内部员工显示调试日志路径
    if (process.env.USER_TYPE === 'ant' && debugLogPath) {
      writeStatus(
        `${chalk.yellow('[ANT-ONLY] Logs:')} ${chalk.dim(debugLogPath)}\n`,
      )
    }
    writeStatus(`${indicatorColor(indicator)} ${stateText}${suffix}\n`)

    // 多会话模式：显示容量行 + 每个会话的标题/活动子列表
    if (sessionMax > 1) {
      const modeHint =
        spawnMode === 'worktree'
          ? 'New sessions will be created in an isolated worktree'
          : 'New sessions will be created in the current directory'
      writeStatus(
        `    ${chalk.dim(`Capacity: ${sessionActive}/${sessionMax} \u00b7 ${modeHint}`)}\n`,
      )
      for (const [, info] of sessionDisplayInfo) {
        const titleText = info.title
          ? truncatePrompt(info.title, 35)
          : chalk.dim('Attached')
        const titleLinked = wrapWithOsc8Link(titleText, info.url) // OSC 8 可点击链接
        const act = info.activity
        const showAct = act && act.type !== 'result' && act.type !== 'error' // 仅显示进行中的活动
        const actText = showAct
          ? chalk.dim(` ${truncatePrompt(act.summary, 40)}`)
          : ''
        writeStatus(`    ${titleLinked}${actText}
`)
      }
    }

    // 单会话槽（sessionMax === 1）的模式行
    if (sessionMax === 1) {
      const modeText =
        spawnMode === 'single-session'
          ? 'Single session \u00b7 exits when complete'
          : spawnMode === 'worktree'
            ? `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in an isolated worktree`
            : `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in the current directory`
      writeStatus(`    ${chalk.dim(modeText)}\n`)
    }

    // 工具活动摘要行（单会话模式、已连接且 30 秒内有工具调用）
    if (
      sessionMax === 1 &&
      !isIdle &&
      lastToolSummary &&
      Date.now() - lastToolTime < TOOL_DISPLAY_EXPIRY_MS
    ) {
      writeStatus(`  ${chalk.dim(truncatePrompt(lastToolSummary, 60))}\n`)
    }

    // 底栏：空行分隔 + 页脚文字 + 快捷键提示
    const url = activeSessionUrl ?? connectUrl // 会话激活时用会话 URL，否则用连接 URL
    if (url) {
      writeStatus('\n')
      const footerText = isIdle
        ? buildIdleFooterText(url)
        : buildActiveFooterText(url)
      const qrHint = qrVisible
        ? chalk.dim.italic('space to hide QR code')
        : chalk.dim.italic('space to show QR code')
      const toggleHint = spawnModeDisplay
        ? chalk.dim.italic(' \u00b7 w to toggle spawn mode')
        : ''
      writeStatus(`${chalk.dim(footerText)}\n`)
      writeStatus(`${qrHint}${toggleHint}\n`)
    }
  }

  return {
    /**
     * 打印启动 Banner（仅在 Bridge 初始化时调用一次）。
     *
     * 构建 connectUrl 并生成初始 QR 码，写出版本/配置信息（verbose 模式），
     * 然后启动 Connecting 动画——等待后端注册完成。
     */
    printBanner(config: BridgeConfig, environmentId: string): void {
      cachedIngressUrl = config.sessionIngressUrl
      cachedEnvironmentId = environmentId
      connectUrl = buildBridgeConnectUrl(environmentId, cachedIngressUrl)
      regenerateQr(connectUrl) // 异步生成初始 QR 码

      if (verbose) {
        write(chalk.dim(`Remote Control`) + ` v${MACRO.VERSION}\n`)
      }
      if (verbose) {
        if (config.spawnMode !== 'single-session') {
          write(chalk.dim(`Spawn mode: `) + `${config.spawnMode}\n`)
          write(
            chalk.dim(`Max concurrent sessions: `) + `${config.maxSessions}\n`,
          )
        }
        write(chalk.dim(`Environment ID: `) + `${environmentId}\n`)
      }
      if (config.sandbox) {
        write(chalk.dim(`Sandbox: `) + `${chalk.green('Enabled')}\n`)
      }
      write('\n')

      // 启动 Connecting 动画——首次 updateIdleStatus() 调用时停止
      startConnecting()
    },

    /**
     * 打印会话开始日志（verbose 模式下显示提示词摘要和 sessionId）。
     */
    logSessionStart(sessionId: string, prompt: string): void {
      if (verbose) {
        const short = truncatePrompt(prompt, 80)
        printLog(
          chalk.dim(`[${timestamp()}]`) +
            ` Session started: ${chalk.white(`"${short}"`)} (${chalk.dim(sessionId)})\n`,
        )
      }
    },

    /**
     * 打印会话完成日志（显示持续时间和 sessionId）。
     */
    logSessionComplete(sessionId: string, durationMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.green('completed')} (${formatDuration(durationMs)}) ${chalk.dim(sessionId)}\n`,
      )
    },

    /**
     * 打印会话失败日志（显示错误信息和 sessionId）。
     */
    logSessionFailed(sessionId: string, error: string): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.red('failed')}: ${error} ${chalk.dim(sessionId)}\n`,
      )
    },

    /**
     * 打印通用状态日志行（带时间戳）。
     */
    logStatus(message: string): void {
      printLog(chalk.dim(`[${timestamp()}]`) + ` ${message}\n`)
    },

    /**
     * 打印详细调试日志（仅 verbose 模式下输出）。
     */
    logVerbose(message: string): void {
      if (verbose) {
        printLog(chalk.dim(`[${timestamp()}] ${message}`) + '\n')
      }
    },

    /**
     * 打印错误日志（红色，带时间戳）。
     */
    logError(message: string): void {
      printLog(chalk.red(`[${timestamp()}] Error: ${message}`) + '\n')
    },

    /**
     * 打印重连成功日志（显示断线持续时间）。
     */
    logReconnected(disconnectedMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` ${chalk.green('Reconnected')} after ${formatDuration(disconnectedMs)}\n`,
      )
    },

    /**
     * 设置仓库名称和分支名（用于状态行后缀）。
     */
    setRepoInfo(repo: string, branchName: string): void {
      repoName = repo
      branch = branchName
    },

    /**
     * 设置调试日志路径（ANT-ONLY 模式下在状态行上方显示）。
     */
    setDebugLogPath(path: string): void {
      debugLogPath = path
    },

    /**
     * 更新状态为 idle（Ready），重置工具活动和会话 URL，重新生成 QR 码。
     * 在 Bridge 注册完成（后端确认）或会话结束后调用。
     */
    updateIdleStatus(): void {
      stopConnecting()

      currentState = 'idle'
      currentStateText = 'Ready'
      lastToolSummary = null
      lastToolTime = 0
      activeSessionUrl = null
      regenerateQr(connectUrl) // 回到环境连接 URL 的 QR 码
      renderStatusLine()
    },

    /**
     * 更新状态为 attached（Connected），表示用户已连接。
     *
     * 单会话模式下切换 QR 码和底栏 URL 为会话专属 URL；
     * 多会话模式下保持环境 URL（用户可继续扫码发起新会话）。
     */
    setAttached(sessionId: string): void {
      stopConnecting()
      currentState = 'attached'
      currentStateText = 'Connected'
      lastToolSummary = null
      lastToolTime = 0
      // 多会话：底栏/QR 保持环境连接 URL，每个会话的链接在子列表中显示
      if (sessionMax <= 1) {
        activeSessionUrl = buildBridgeSessionUrl(
          sessionId,
          cachedEnvironmentId,
          cachedIngressUrl,
        )
        regenerateQr(activeSessionUrl) // 单会话：切换到会话 URL 的 QR 码
      }
      renderStatusLine()
    },

    /**
     * 更新状态为 reconnecting（重连中）。
     *
     * 清除旧状态行后显示黄色 spinner + 重连提示（等待时间 + 断线时长）。
     * reconnecting 状态由此方法专属渲染，renderStatusLine 在此状态下直接返回。
     */
    updateReconnectingStatus(delayStr: string, elapsedStr: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'reconnecting'

      // 可选：在重连行上方显示 QR 码
      if (qrVisible) {
        for (const line of qrLines) {
          writeStatus(`${chalk.dim(line)}\n`)
        }
      }

      const frame =
        BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
      connectingTick++ // 推进帧计数（下次重连更新时显示不同帧）
      writeStatus(
        `${chalk.yellow(frame)} ${chalk.yellow('Reconnecting')} ${chalk.dim('\u00b7')} ${chalk.dim(`retrying in ${delayStr}`)} ${chalk.dim('\u00b7')} ${chalk.dim(`disconnected ${elapsedStr}`)}\n`,
      )
    },

    /**
     * 更新状态为 failed（不可恢复的错误）。
     *
     * 显示红色失败指示符 + 错误信息 + 固定页脚文字。
     * failed 状态由此方法专属渲染，renderStatusLine 在此状态下直接返回。
     */
    updateFailedStatus(error: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'failed'

      let suffix = ''
      if (repoName) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
      }
      if (branch) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
      }

      writeStatus(
        `${chalk.red(BRIDGE_FAILED_INDICATOR)} ${chalk.red('Remote Control Failed')}${suffix}\n`,
      )
      writeStatus(`${chalk.dim(FAILED_FOOTER_TEXT)}\n`)

      if (error) {
        writeStatus(`${chalk.red(error)}\n`) // 显示具体错误信息
      }
    },

    /**
     * 更新当前会话的工具活动摘要，并刷新状态行。
     *
     * 仅缓存 tool_start 类型的活动（result/error 不更新摘要）。
     * lastToolTime 记录最后工具调用时间，用于 30 秒过期判断。
     */
    updateSessionStatus(
      _sessionId: string,
      _elapsed: string,
      activity: SessionActivity,
      _trail: string[],
    ): void {
      // 只在 tool_start 时缓存工具活动摘要
      if (activity.type === 'tool_start') {
        lastToolSummary = activity.summary
        lastToolTime = Date.now()
      }
      renderStatusLine()
    },

    /**
     * 停止动画并清除所有状态行（用于进程退出前的清理）。
     */
    clearStatus(): void {
      stopConnecting()
      clearStatusLines()
    },

    /**
     * 切换 QR 码显示状态（空格键处理器调用）。
     */
    toggleQr(): void {
      qrVisible = !qrVisible
      renderStatusLine()
    },

    /**
     * 更新多会话容量计数。
     *
     * 相同值时提前返回（避免不必要的状态重新渲染）。
     * 不主动触发渲染——状态定时器会在下一个节拍（tick）调用 renderStatusLine。
     */
    updateSessionCount(active: number, max: number, mode: SpawnMode): void {
      if (sessionActive === active && sessionMax === max && spawnMode === mode)
        return
      sessionActive = active
      sessionMax = max
      spawnMode = mode
      // 不在此处主动渲染——状态 ticker 有自己的节拍，下次 tick 会拾取新值
    },

    /**
     * 设置衍生模式显示（'same-dir' / 'worktree' / null）。
     *
     * 同步更新 spawnMode（影响下一次渲染的模式提示和分支可见性）。
     * 不主动渲染——调用方（w 键处理器）会随后调用 refreshDisplay()。
     */
    setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void {
      if (spawnModeDisplay === mode) return
      spawnModeDisplay = mode
      // 同步 spawnMode 以使下次渲染显示正确的模式提示和分支可见性
      if (mode) spawnMode = mode
    },

    /**
     * 注册新会话到多会话显示列表（初始无标题和活动）。
     */
    addSession(sessionId: string, url: string): void {
      sessionDisplayInfo.set(sessionId, { url })
    },

    /**
     * 更新指定会话的工具活动摘要（用于多会话子列表）。
     */
    updateSessionActivity(sessionId: string, activity: SessionActivity): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) return
      info.activity = activity
    },

    /**
     * 设置指定会话的标题并刷新状态行。
     *
     * 单会话模式下同步更新主状态行文本（切换到 titled 状态）。
     * reconnecting / failed 状态下提前返回，避免清除这些专属状态显示。
     */
    setSessionTitle(sessionId: string, title: string): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) return
      info.title = title
      // 保护 reconnecting/failed 状态：renderStatusLine 会清除再提前返回，会抹掉 spinner/错误
      if (currentState === 'reconnecting' || currentState === 'failed') return
      if (sessionMax === 1) {
        // 单会话：标题显示在主状态行
        currentState = 'titled'
        currentStateText = truncatePrompt(title, 40)
      }
      renderStatusLine()
    },

    /**
     * 从多会话显示列表中移除已结束的会话。
     */
    removeSession(sessionId: string): void {
      sessionDisplayInfo.delete(sessionId)
    },

    /**
     * 强制刷新状态显示（w 键切换衍生模式后调用）。
     * reconnecting / failed 状态下提前返回，保护专属状态显示不被覆盖。
     */
    refreshDisplay(): void {
      // reconnecting/failed 由专属方法渲染，此处跳过避免抹除 spinner/错误
      if (currentState === 'reconnecting' || currentState === 'failed') return
      renderStatusLine()
    },
  }
}
