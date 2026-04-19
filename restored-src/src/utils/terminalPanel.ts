/**
 * 【文件定位】UI 交互层 — 内置终端面板（Terminal Panel）
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户按下 Meta+J（Option+J）
 *     → REPL 键盘事件处理器调用 getTerminalPanel().toggle()
 *     → 本模块挂起 Ink UI，进入/恢复 tmux 会话
 *     → 用户在 tmux 中操作完毕后再次按 Meta+J（绑定为 detach-client）
 *     → Ink UI 恢复渲染
 *
 * 主要职责：
 *   1. getTerminalPanelSocket() — 生成每个 Claude Code 实例专属的 tmux socket 名称
 *   2. getTerminalPanel()       — 懒加载单例 TerminalPanel 对象
 *   3. TerminalPanel 类         — 管理 tmux 会话的完整生命周期：
 *      - checkTmux()    — 检测 tmux 是否可用（缓存检测结果）
 *      - hasSession()   — 检查 tmux 会话是否已存在
 *      - createSession() — 创建新的 tmux 会话并绑定 Meta+J 快捷键
 *      - attachSession() — 挂载到已有 tmux 会话（阻塞，直到用户离开）
 *      - showShell()    — 切换到备用屏幕，调用 tmux 或直接 shell
 *      - runShellDirect() — tmux 不可用时的 fallback：直接 spawnSync shell
 *
 * 隔离原则：
 *   每个 Claude Code 实例使用独立 socket（claude-panel-<sessionId[0:8]>），
 *   互不干扰，且与 tmuxSocket.ts 管理的工具执行 socket 也完全隔离。
 *
 * 与 promptEditor.ts 使用相同的"挂起 Ink - 操作 - 恢复 Ink"模式。
 */

import { spawn, spawnSync } from 'child_process'
import { getSessionId } from '../bootstrap/state.js'
import instances from '../ink/instances.js'
import { registerCleanup } from './cleanupRegistry.js'
import { pwd } from './cwd.js'
import { logForDebugging } from './debug.js'

// tmux 会话名称固定为 'panel'，通过不同的 socket 区分不同实例
const TMUX_SESSION = 'panel'

/**
 * 获取当前 Claude Code 实例的终端面板专属 tmux socket 名称。
 *
 * 格式：claude-panel-<sessionId 前 8 字符>
 * 使用 sessionId 前缀确保同一台机器上的多个 Claude Code 实例互相隔离。
 * 取前 8 字符是在唯一性与名称简短性之间的权衡。
 *
 * @returns tmux socket 名称字符串
 */
export function getTerminalPanelSocket(): string {
  // 使用 session UUID 前 8 位，在保证唯一性的同时保持名称简短
  const sessionId = getSessionId()
  return `claude-panel-${sessionId.slice(0, 8)}`
}

// 模块级单例，懒加载
let instance: TerminalPanel | undefined

/**
 * 获取（或创建）终端面板单例。
 * 第一次调用时构造 TerminalPanel 对象，后续调用复用同一实例。
 *
 * @returns 当前实例的 TerminalPanel 对象
 */
export function getTerminalPanel(): TerminalPanel {
  if (!instance) {
    instance = new TerminalPanel()
  }
  return instance
}

class TerminalPanel {
  // tmux 是否可用的缓存结果（undefined 表示尚未检测）
  private hasTmux: boolean | undefined
  // 防止重复注册清理钩子
  private cleanupRegistered = false

  // ── 对外 API ─────────────────────────────────────────────────────

  /** 切换终端面板：若面板未显示则显示，若已显示则通过 tmux detach 返回 */
  toggle(): void {
    this.showShell()
  }

  // ── tmux 辅助方法 ────────────────────────────────────────────────

  /**
   * 检测系统中是否安装了 tmux。
   * 结果缓存在 this.hasTmux 中，避免重复执行 spawnSync。
   */
  private checkTmux(): boolean {
    if (this.hasTmux !== undefined) return this.hasTmux
    // 执行 tmux -V 检查是否有 tmux 可执行文件
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
    this.hasTmux = result.status === 0
    if (!this.hasTmux) {
      logForDebugging(
        'Terminal panel: tmux not found, falling back to non-persistent shell',
      )
    }
    return this.hasTmux
  }

  /**
   * 检查当前实例专属的 tmux 会话是否已存在。
   * 使用 `has-session` 命令，通过专属 socket（-L）访问隔离环境。
   */
  private hasSession(): boolean {
    const result = spawnSync(
      'tmux',
      ['-L', getTerminalPanelSocket(), 'has-session', '-t', TMUX_SESSION],
      { encoding: 'utf-8' },
    )
    return result.status === 0
  }

  /**
   * 创建新的 tmux 会话。
   *
   * 执行流程：
   *   1. 读取用户 $SHELL 和当前工作目录
   *   2. 以 -d 后台模式创建 tmux 会话（不立即进入前台）
   *   3. 绑定 Meta+J 为 detach-client，让用户能快捷返回 Claude Code
   *   4. 配置状态栏提示文字"Alt+J to return to Claude"
   *   5. 注册进程退出清理钩子（kill-server），确保实例退出时 tmux 服务也终止
   *
   * @returns 创建成功返回 true，失败返回 false（不抛出异常）
   */
  private createSession(): boolean {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    const socket = getTerminalPanelSocket()

    // 后台创建会话（-d = detached），使用登录 shell（-l）
    const result = spawnSync(
      'tmux',
      [
        '-L',
        socket,
        'new-session',
        '-d',       // 后台创建，不立即挂载
        '-s',
        TMUX_SESSION,
        '-c',
        cwd,
        shell,
        '-l',       // 以登录 shell 启动
      ],
      { encoding: 'utf-8' },
    )

    if (result.status !== 0) {
      logForDebugging(
        `Terminal panel: failed to create tmux session: ${result.stderr}`,
      )
      return false
    }

    // 将 5 条 tmux 配置命令用 ';' 串联为 1 次 spawnSync 调用，减少进程开销：
    //   - 绑定 Meta+J 为 detach-client（返回 Claude Code）
    //   - 清除默认状态栏样式/内容
    //   - 设置右侧状态栏文字提示
    // biome-ignore format: one tmux command per line
    spawnSync('tmux', [
      '-L', socket,
      'bind-key', '-n', 'M-j', 'detach-client', ';',
      'set-option', '-g', 'status-style', 'bg=default', ';',
      'set-option', '-g', 'status-left', '', ';',
      'set-option', '-g', 'status-right', ' Alt+J to return to Claude ', ';',
      'set-option', '-g', 'status-right-style', 'fg=brightblack',
    ])

    // 注册清理钩子：Claude Code 退出时销毁此 tmux 服务器
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true
      registerCleanup(async () => {
        // 使用 spawn（非阻塞）而非 spawnSync（阻塞），避免序列化 gracefulShutdown 的 Promise.all
        // .on('error') 吞掉 ENOENT（若 tmux 在此期间消失），防止 uncaughtException 噪音
        spawn('tmux', ['-L', socket, 'kill-server'], {
          detached: true,
          stdio: 'ignore',
        })
          .on('error', () => {})
          .unref()
      })
    }

    return true
  }

  /**
   * 挂载到已有 tmux 会话（阻塞，直到用户按 Meta+J 离开）。
   * stdio 继承父进程，直接与终端交互。
   */
  private attachSession(): void {
    spawnSync(
      'tmux',
      ['-L', getTerminalPanelSocket(), 'attach-session', '-t', TMUX_SESSION],
      { stdio: 'inherit' },
    )
  }

  // ── 显示 shell ──────────────────────────────────────────────────

  /**
   * 核心方法：暂停 Ink UI，显示 shell，返回后恢复 Ink UI。
   *
   * 执行流程：
   *   1. 获取当前 stdout 对应的 Ink 实例（若无则报错退出）
   *   2. 调用 enterAlternateScreen() 挂起 Ink，切换到备用屏幕
   *   3. 优先使用 tmux（持久会话）；tmux 不可用则直接启动 shell
   *   4. 无论成功或失败，finally 块中调用 exitAlternateScreen() 恢复 Ink
   */
  private showShell(): void {
    const inkInstance = instances.get(process.stdout)
    if (!inkInstance) {
      logForDebugging('Terminal panel: no Ink instance found, aborting')
      return
    }

    // 进入备用屏幕（保留原有 Ink 渲染内容，切换后不可见）
    inkInstance.enterAlternateScreen()
    try {
      if (this.checkTmux() && this.ensureSession()) {
        // tmux 可用且会话已就绪，挂载到 tmux 会话
        this.attachSession()
      } else {
        // fallback：直接启动非持久 shell
        this.runShellDirect()
      }
    } finally {
      // 无论上述代码是否抛出，都恢复 Ink UI
      inkInstance.exitAlternateScreen()
    }
  }

  // ── 辅助方法 ────────────────────────────────────────────────────

  /**
   * 确保 tmux 会话已就绪：若不存在则创建。
   * @returns 会话已存在或创建成功返回 true，创建失败返回 false
   */
  private ensureSession(): boolean {
    if (this.hasSession()) return true
    return this.createSession()
  }

  /**
   * tmux 不可用时的降级方案：直接通过 spawnSync 启动交互式登录 shell。
   * 会话不持久——用户退出 shell 后状态丢失。
   */
  private runShellDirect(): void {
    const shell = process.env.SHELL || '/bin/bash'
    const cwd = pwd()
    // -i 交互模式，-l 登录 shell；stdio 继承终端
    spawnSync(shell, ['-i', '-l'], {
      stdio: 'inherit',
      cwd,
      env: process.env,
    })
  }
}
