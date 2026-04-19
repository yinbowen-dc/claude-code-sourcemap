/**
 * 并发会话管理模块。
 *
 * 在 Claude Code 系统中，该模块管理同一项目目录下多个并发 Claude 会话的状态，
 * 通过 ~/.claude/projects/<hash>/sessions/ 目录下的锁文件追踪活跃会话：
 * - 注册/注销当前会话
 * - 枚举同一项目下的其他并发会话
 * - 会话切换时自动更新状态
 */
import { feature } from 'bun:bundle'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

/** 返回会话 PID 文件所在目录路径（~/.claude/sessions/） */
function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

/**
 * 从环境变量读取会话类型覆盖值。
 *
 * 由 spawner（`claude --bg`、daemon supervisor）在启动子进程时注入 CLAUDE_CODE_SESSION_KIND，
 * 这样子进程可以自行注册 PID 文件，无需父进程代为写入——退出时的清理钩子也可自动生效。
 * 通过 feature gate 控制，确保该环境变量字符串在外部构建中被 DCE 移除。
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    // 仅识别已知的后台会话类型，其余值忽略
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * 判断当前 REPL 是否运行在 `claude --bg` tmux 会话中。
 *
 * 为 true 时，/exit、Ctrl+C、Ctrl+D 等退出路径应 detach 已附加的客户端，
 * 而非直接杀死进程（后台会话需保持存活）。
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * 为当前会话写入 PID 文件并注册退出清理钩子。
 *
 * 注册范围：所有顶层会话（交互式 CLI、SDK（vscode/desktop/ts/py/-p）、bg/daemon 子进程）
 * 均会注册，使 `claude ps` 能枚举用户正在运行的所有实例。
 * 跳过 teammates/subagents：它们是 swarm 内部并发，混入后会污染 ps 输出。
 *
 * @returns 注册成功返回 true，跳过或失败返回 false（错误记录到 debug 日志，不抛出）
 */
export async function registerSession(): Promise<boolean> {
  // subagent（teammate）跳过注册，避免 ps 噪音
  if (getAgentId() != null) return false

  // 默认为 interactive；bg/daemon 子进程通过环境变量传入
  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  // 注册退出清理：进程正常退出时删除 PID 文件
  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT is fine (already deleted or never written)
    }
  })

  try {
    // 创建 sessions 目录（权限 700，仅当前用户可访问）
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeFile(
      pidFile,
      jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
        // UDS 收件箱功能开启时写入消息套接字路径
        ...(feature('UDS_INBOX')
          ? { messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
          : {}),
        // bg 会话功能开启时写入会话名/日志路径/代理标识
        ...(feature('BG_SESSIONS')
          ? {
              name: process.env.CLAUDE_CODE_SESSION_NAME,
              logPath: process.env.CLAUDE_CODE_SESSION_LOG,
              agent: process.env.CLAUDE_CODE_AGENT,
            }
          : {}),
      }),
    )
    // --resume / /resume 会通过 switchSession 修改 getSessionId()。
    // 不订阅此事件的话，PID 文件中的 sessionId 会过时，
    // 导致 `claude ps` 的 sparkline 读取错误的对话记录。
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/**
 * 以 patch 对象更新当前进程的 PID 文件（读-改-写）。
 *
 * 用于更新会话名、sessionId、bridgeSessionId 等字段，供 `claude ps` 读取最新状态。
 * 采用 best-effort 策略：文件不存在（会话未注册）或读写失败时静默忽略，记录 debug 日志。
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    // 读取当前文件内容，合并 patch 后写回
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

/** 更新会话名称到 PID 文件，名称为空时跳过（best-effort）。 */
export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * 将当前会话的 Remote Control（桥接）session ID 写入 PID 文件。
 *
 * 用于对等枚举时去重：同一会话通过 UDS 和 bridge 均可达时，只显示一次（本地优先）。
 * 桥接断开时传入 null 清除旧值，防止重连后旧 ID 错误地抑制合法的远程会话条目。
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * 推送实时活动状态到 PID 文件，供 `claude ps` 显示。
 *
 * 由 REPL 的状态变更 effect 触发（fire-and-forget）；
 * 写入失败时 ps 仅对该次刷新回退到 transcript-tail 派生状态，不影响功能。
 * BG_SESSIONS feature gate 关闭时直接跳过。
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  // 附加 updatedAt 时间戳，便于 ps 判断数据新鲜度
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * 统计当前活跃的并发 CLI 会话数（含本进程）。
 *
 * 遍历 sessions 目录下的 PID 文件，过滤掉因崩溃遗留的过时文件并删除之。
 * 任何错误均返回 0（保守估计），不影响主流程。
 * WSL 环境下跳过过时文件清理：~/.claude/sessions/ 可能通过符号链接与 Windows 原生
 * Claude 共享，WSL 无法探测 Windows PID，会误删活跃会话的文件。
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // 严格文件名校验：只处理 `<pid>.json` 格式的文件。
    // parseInt 的前缀宽松解析（如 "2026-03-14_notes.md" → PID 2026）
    // 会把用户文件误判为过时 PID 并删除——静默数据丢失。见 issue #34210。
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      // 当前进程直接计数
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // 过时文件（进程已崩溃）：清除之。WSL 下跳过（见函数注释）。
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
