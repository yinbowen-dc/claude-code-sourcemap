/**
 * Asciicast 终端录制模块。
 *
 * 在 Claude Code 系统中，该模块为内部用户（USER_TYPE=ant）提供终端会话录制功能。
 * 通过拦截 process.stdout.write，将所有终端输出以 asciicast v2 格式记录到 .cast 文件，
 * 供后续回放或上传（/share 命令）使用。
 *
 * 主要功能：
 * 1. getRecordFilePath()：获取录制文件路径（惰性计算并缓存）
 * 2. installAsciicastRecorder()：安装录制器（拦截 stdout.write，写入 asciicast v2 header）
 * 3. flushAsciicastRecorder()：将缓冲数据强制写入磁盘（/share 前调用）
 * 4. getSessionRecordingPaths()：获取当前会话的所有 .cast 文件路径
 * 5. renameRecordingForSession()：--resume 后将录制文件重命名以匹配新会话 ID
 *
 * 注意：仅在 CLAUDE_CODE_TERMINAL_RECORDING=1 且 USER_TYPE=ant 时启用录制。
 */
import { appendFile, rename } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { sanitizePath } from './path.js'
import { jsonStringify } from './slowOperations.js'

// Mutable recording state — filePath is updated when session ID changes (e.g., --resume)
const recordingState: { filePath: string | null; timestamp: number } = {
  filePath: null,
  timestamp: 0,
}

/**
 * 获取 asciicast 录制文件路径。
 * 仅在 USER_TYPE=ant 且 CLAUDE_CODE_TERMINAL_RECORDING=1 时返回路径，否则返回 null。
 * 路径首次计算后缓存在 recordingState 中，路径格式为 {sessionId}-{timestamp}.cast。
 *
 * Get the asciicast recording file path.
 */
export function getRecordFilePath(): string | null {
  if (recordingState.filePath !== null) {
    return recordingState.filePath
  }
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  if (!isEnvTruthy(process.env.CLAUDE_CODE_TERMINAL_RECORDING)) {
    return null
  }
  // Record alongside the transcript.
  // Each launch gets its own file so --continue produces multiple recordings.
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const projectDir = join(projectsDir, sanitizePath(getOriginalCwd()))
  recordingState.timestamp = Date.now()
  recordingState.filePath = join(
    projectDir,
    `${getSessionId()}-${recordingState.timestamp}.cast`,
  )
  return recordingState.filePath
}

export function _resetRecordingStateForTesting(): void {
  recordingState.filePath = null
  recordingState.timestamp = 0
}

/**
 * 获取当前会话的所有 .cast 录制文件路径，按文件名（时间戳后缀）升序排列。
 *
 * Find all .cast files for the current session.
 */
export function getSessionRecordingPaths(): string[] {
  const sessionId = getSessionId()
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const projectDir = join(projectsDir, sanitizePath(getOriginalCwd()))
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- called during /share before upload, not in hot path
    const entries = getFsImplementation().readdirSync(projectDir)
    const names = (
      typeof entries[0] === 'string'
        ? entries
        : (entries as { name: string }[]).map(e => e.name)
    ) as string[]
    const files = names
      .filter(f => f.startsWith(sessionId) && f.endsWith('.cast'))
      .sort()
    return files.map(f => join(projectDir, f))
  } catch {
    return []
  }
}

/**
 * 将录制文件重命名以匹配当前会话 ID。
 * --resume/--continue 后会话 ID 变更时调用，确保 getSessionRecordingPaths() 能找到文件。
 * 重命名前先 flush 缓冲写入。
 *
 * Rename the recording file to match the current session ID.
 */
export async function renameRecordingForSession(): Promise<void> {
  const oldPath = recordingState.filePath
  if (!oldPath || recordingState.timestamp === 0) {
    return
  }
  const projectsDir = join(getClaudeConfigHomeDir(), 'projects')
  const projectDir = join(projectsDir, sanitizePath(getOriginalCwd()))
  const newPath = join(
    projectDir,
    `${getSessionId()}-${recordingState.timestamp}.cast`,
  )
  if (oldPath === newPath) {
    return
  }
  // Flush pending writes before renaming
  await recorder?.flush()
  const oldName = basename(oldPath)
  const newName = basename(newPath)
  try {
    await rename(oldPath, newPath)
    recordingState.filePath = newPath
    logForDebugging(`[asciicast] Renamed recording: ${oldName} → ${newName}`)
  } catch {
    logForDebugging(
      `[asciicast] Failed to rename recording from ${oldName} to ${newName}`,
    )
  }
}

type AsciicastRecorder = {
  flush(): Promise<void>
  dispose(): Promise<void>
}

let recorder: AsciicastRecorder | null = null

function getTerminalSize(): { cols: number; rows: number } {
  // Direct access to stdout dimensions — not in a React component
  // eslint-disable-next-line custom-rules/prefer-use-terminal-size
  const cols = process.stdout.columns || 80
  // eslint-disable-next-line custom-rules/prefer-use-terminal-size
  const rows = process.stdout.rows || 24
  return { cols, rows }
}

/**
 * 将缓冲的录制数据强制写入磁盘。
 * 在读取 .cast 文件（如 /share 命令上传前）调用。
 *
 * Flush pending recording data to disk.
 */
export async function flushAsciicastRecorder(): Promise<void> {
  await recorder?.flush()
}

/**
 * 安装 asciicast 录制器。
 * 拦截 process.stdout.write 以捕获所有终端输出并附加时间戳。
 * 必须在 Ink 挂载之前调用。写入使用缓冲写入器（500ms 或 10MB 触发 flush）。
 *
 * Install the asciicast recorder.
 */
export function installAsciicastRecorder(): void {
  const filePath = getRecordFilePath()
  if (!filePath) {
    return
  }

  const { cols, rows } = getTerminalSize()
  const startTime = performance.now()

  // Write the asciicast v2 header
  const header = jsonStringify({
    version: 2,
    width: cols,
    height: rows,
    timestamp: Math.floor(Date.now() / 1000),
    env: {
      SHELL: process.env.SHELL || '',
      TERM: process.env.TERM || '',
    },
  })

  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-time init before Ink mounts
    getFsImplementation().mkdirSync(dirname(filePath))
  } catch {
    // Directory may already exist
  }
  // eslint-disable-next-line custom-rules/no-sync-fs -- one-time init before Ink mounts
  getFsImplementation().appendFileSync(filePath, header + '\n', { mode: 0o600 })

  let pendingWrite: Promise<void> = Promise.resolve()

  const writer = createBufferedWriter({
    writeFn(content: string) {
      // Use recordingState.filePath (mutable) so writes follow renames from --resume
      const currentPath = recordingState.filePath
      if (!currentPath) {
        return
      }
      pendingWrite = pendingWrite
        .then(() => appendFile(currentPath, content))
        .catch(() => {
          // Silently ignore write errors — don't break the session
        })
    },
    flushIntervalMs: 500,
    maxBufferSize: 50,
    maxBufferBytes: 10 * 1024 * 1024, // 10MB
  })

  // Wrap process.stdout.write to capture output
  const originalWrite = process.stdout.write.bind(
    process.stdout,
  ) as typeof process.stdout.write
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    // Record the output event
    const elapsed = (performance.now() - startTime) / 1000
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    writer.write(jsonStringify([elapsed, 'o', text]) + '\n')

    // Pass through to the real stdout
    if (typeof encodingOrCb === 'function') {
      return originalWrite(chunk, encodingOrCb)
    }
    return originalWrite(chunk, encodingOrCb, cb)
  } as typeof process.stdout.write

  // Handle terminal resize events
  function onResize(): void {
    const elapsed = (performance.now() - startTime) / 1000
    const { cols: newCols, rows: newRows } = getTerminalSize()
    writer.write(jsonStringify([elapsed, 'r', `${newCols}x${newRows}`]) + '\n')
  }
  process.stdout.on('resize', onResize)

  recorder = {
    async flush(): Promise<void> {
      writer.flush()
      await pendingWrite
    },
    async dispose(): Promise<void> {
      writer.dispose()
      await pendingWrite
      process.stdout.removeListener('resize', onResize)
      process.stdout.write = originalWrite
    },
  }

  registerCleanup(async () => {
    await recorder?.dispose()
    recorder = null
  })

  logForDebugging(`[asciicast] Recording to ${filePath}`)
}
