/**
 * sessionRunner.ts — Claude Code 子进程会话生成器工厂
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 工作项处理流程（sessionRunner.ts / remoteBridgeCore.ts）
 *     └─> sessionRunner.ts（本文件）——生成/管理 Claude Code 子进程会话
 *
 * 主要功能：
 *   - safeFilenameId：净化会话 ID，使其适用于文件名（防止路径穿越）
 *   - toolSummary：将工具名+输入映射为可读摘要（如 "Reading src/foo.ts"）
 *   - extractActivities：从子进程 NDJSON 输出行中提取 SessionActivity（工具启动/文本/结果/错误）
 *   - extractUserMessageText：从 NDJSON 行中提取首条真实用户消息文本（跳过工具结果和合成消息）
 *   - inputPreview：为调试日志构建工具输入的短摘要
 *   - createSessionSpawner：工厂函数，返回 SessionSpawner，spawn Claude Code 子进程
 *
 * 子进程通信协议：
 *   - stdout：NDJSON 行（stream-json 格式），包含 assistant/user/result/control_request 消息
 *   - stdin：NDJSON 行（stream-json 格式），包含 update_environment_variables（令牌刷新）等
 *   - stderr：错误输出，维护最近 MAX_STDERR_LINES 行的环形缓冲
 *
 * 子进程退出状态映射：
 *   - SIGTERM / SIGINT → 'interrupted'
 *   - exit code 0 → 'completed'
 *   - 其他 exit code → 'failed'
 */
import { type ChildProcess, spawn } from 'child_process'
import { createWriteStream, type WriteStream } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { debugTruncate } from './debugUtils.js'
import type {
  SessionActivity,
  SessionDoneStatus,
  SessionHandle,
  SessionSpawner,
  SessionSpawnOpts,
} from './types.js'

/** 每个会话保留的最大历史活动条数（环形缓冲大小） */
const MAX_ACTIVITIES = 10
/** 每个会话保留的最大 stderr 行数（环形缓冲大小） */
const MAX_STDERR_LINES = 10

/**
 * 净化会话 ID，使其可安全用于文件名。
 *
 * 将所有非字母数字/下划线/连字符字符替换为下划线，
 * 防止路径穿越（如 ../）或文件系统特殊字符引起的问题。
 *
 * 例：'cse_abc-123/xyz' → 'cse_abc-123_xyz'
 */
export function safeFilenameId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 子进程 CLI 发出的工具权限请求（control_request 消息类型）。
 *
 * 当子进程需要执行某个具体工具调用时，通过 stdout 输出此类型消息，
 * bridge 将其转发给服务端，等待用户审批/拒绝。
 *
 * type 固定为 'control_request'，subtype 固定为 'can_use_tool'
 * （区别于一般能力检查，这是针对单次调用的权限请求）。
 */
export type PermissionRequest = {
  type: 'control_request'
  request_id: string
  request: {
    /** 单次调用权限检查——"我可以用这些输入运行这个工具吗？" */
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
    tool_use_id: string
  }
}

/**
 * createSessionSpawner 的依赖注入参数类型。
 *
 * 通过依赖注入传入，使单元测试可以 mock 具体实现。
 *   - execPath：Claude Code 可执行文件路径（或 node runtime 路径）
 *   - scriptArgs：可执行文件的前置参数（npm 安装时为脚本路径，编译二进制时为空数组）
 *   - env：传给子进程的环境变量基础集合
 *   - verbose：是否开启详细日志（子进程 stderr 转发到父进程 stderr）
 *   - sandbox：是否在沙盒模式下运行（设置 CLAUDE_CODE_FORCE_SANDBOX=1）
 *   - debugFile：调试日志文件路径（可选）
 *   - permissionMode：权限模式（如 'auto'，传给子进程 --permission-mode 参数）
 *   - onDebug：调试日志回调
 *   - onActivity：会话活动通知回调（工具启动、文本输出等）
 *   - onPermissionRequest：子进程权限请求通知回调
 */
type SessionSpawnerDeps = {
  execPath: string
  /**
   * 可执行文件前置参数（编译二进制为空数组，npm 安装包含脚本路径）。
   * 若缺少此参数，node runtime 会将 --sdk-url 误判为 node 选项并以
   * "bad option: --sdk-url" 退出（见 anthropics/claude-code#28334）。
   */
  scriptArgs: string[]
  env: NodeJS.ProcessEnv
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  permissionMode?: string
  onDebug: (msg: string) => void
  onActivity?: (sessionId: string, activity: SessionActivity) => void
  onPermissionRequest?: (
    sessionId: string,
    request: PermissionRequest,
    accessToken: string,
  ) => void
}

/** 工具名称到可读动词的映射表（用于状态显示的活动摘要生成） */
const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Bash: 'Running',
  Glob: 'Searching',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching',
  Task: 'Running task',
  FileReadTool: 'Reading',
  FileWriteTool: 'Writing',
  FileEditTool: 'Editing',
  GlobTool: 'Searching',
  GrepTool: 'Searching',
  BashTool: 'Running',
  NotebookEditTool: 'Editing notebook',
  LSP: 'LSP',
}

/**
 * 根据工具名和输入参数生成可读的活动摘要字符串。
 *
 * 优先级：file_path > filePath > pattern > command（截断 60 字符）> url > query
 * 若均无目标，只返回动词（如 "Running"）。
 *
 * 例：toolSummary('Read', {file_path: 'src/foo.ts'}) → "Reading src/foo.ts"
 *     toolSummary('Bash', {command: 'npm test'}) → "Running npm test"
 */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const verb = TOOL_VERBS[name] ?? name // 未映射的工具直接用工具名作动词
  const target =
    (input.file_path as string) ??
    (input.filePath as string) ??
    (input.pattern as string) ??
    (input.command as string | undefined)?.slice(0, 60) ?? // command 截断 60 字符防止过长
    (input.url as string) ??
    (input.query as string) ??
    ''
  if (target) {
    return `${verb} ${target}`
  }
  return verb // 无目标时仅返回动词
}

/**
 * 从子进程 stdout 的单行 NDJSON 中提取 SessionActivity 列表。
 *
 * 解析流程：
 *   1. 尝试 JSON 解析——失败时返回空数组（非 NDJSON 行，如 debug 输出）
 *   2. 根据 msg.type 分支处理：
 *      - 'assistant'：遍历 content 数组，提取 tool_use（→tool_start）和 text（→text）活动
 *      - 'result'：根据 subtype 生成 result 或 error 活动
 *      - 其他类型：忽略
 *   3. 每个活动均记录调试日志
 *
 * 注意：'user' 类型由调用方单独处理（extractUserMessageText），此函数不处理。
 */
function extractActivities(
  line: string,
  sessionId: string,
  onDebug: (msg: string) => void,
): SessionActivity[] {
  let parsed: unknown
  try {
    parsed = jsonParse(line) // 尝试 JSON 解析
  } catch {
    return [] // 非 JSON 行（如 debug 输出），跳过
  }

  if (!parsed || typeof parsed !== 'object') {
    return [] // 非对象类型，跳过
  }

  const msg = parsed as Record<string, unknown>
  const activities: SessionActivity[] = []
  const now = Date.now()

  switch (msg.type) {
    case 'assistant': {
      const message = msg.message as Record<string, unknown> | undefined
      if (!message) break
      const content = message.content
      if (!Array.isArray(content)) break

      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>

        if (b.type === 'tool_use') {
          // 工具调用 block：生成 tool_start 活动
          const name = (b.name as string) ?? 'Tool'
          const input = (b.input as Record<string, unknown>) ?? {}
          const summary = toolSummary(name, input)
          activities.push({
            type: 'tool_start',
            summary,
            timestamp: now,
          })
          onDebug(
            `[bridge:activity] sessionId=${sessionId} tool_use name=${name} ${inputPreview(input)}`,
          )
        } else if (b.type === 'text') {
          // 文本 block：生成 text 活动（截断前 80 字符显示）
          const text = (b.text as string) ?? ''
          if (text.length > 0) {
            activities.push({
              type: 'text',
              summary: text.slice(0, 80),
              timestamp: now,
            })
            onDebug(
              `[bridge:activity] sessionId=${sessionId} text "${text.slice(0, 100)}"`,
            )
          }
        }
      }
      break
    }
    case 'result': {
      const subtype = msg.subtype as string | undefined
      if (subtype === 'success') {
        // 成功结果：生成 result 活动
        activities.push({
          type: 'result',
          summary: 'Session completed',
          timestamp: now,
        })
        onDebug(
          `[bridge:activity] sessionId=${sessionId} result subtype=success`,
        )
      } else if (subtype) {
        // 非成功结果（如错误）：生成 error 活动，取 errors[0] 或默认错误描述
        const errors = msg.errors as string[] | undefined
        const errorSummary = errors?.[0] ?? `Error: ${subtype}`
        activities.push({
          type: 'error',
          summary: errorSummary,
          timestamp: now,
        })
        onDebug(
          `[bridge:activity] sessionId=${sessionId} result subtype=${subtype} error="${errorSummary}"`,
        )
      } else {
        onDebug(
          `[bridge:activity] sessionId=${sessionId} result subtype=undefined`,
        )
      }
      break
    }
    default:
      break // 其他消息类型（user/control_request 等）由调用方单独处理
  }

  return activities
}

/**
 * 从 replayed SDKUserMessage NDJSON 行中提取真实用户消息文本。
 *
 * 过滤规则（返回 undefined）：
 *   - parent_tool_use_id != null：工具结果包装的用户消息（子代理结果）
 *   - isSynthetic：合成消息（如注意事项消息）
 *   - isReplay：重放消息标记
 *
 * 内容提取：
 *   - content 为字符串：直接使用
 *   - content 为数组：取第一个 type='text' block 的 text 字段
 *
 * 返回 trim 后的非空字符串，否则返回 undefined（调用方继续等待下一条真实消息）。
 */
function extractUserMessageText(
  msg: Record<string, unknown>,
): string | undefined {
  // 跳过工具结果用户消息（子代理结果包装）和合成/重放消息——均非真实用户输入
  if (msg.parent_tool_use_id != null || msg.isSynthetic || msg.isReplay)
    return undefined

  const message = msg.message as Record<string, unknown> | undefined
  const content = message?.content
  let text: string | undefined
  if (typeof content === 'string') {
    text = content // content 直接为字符串
  } else if (Array.isArray(content)) {
    // content 为 block 数组，取第一个 text block
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text'
      ) {
        text = (block as Record<string, unknown>).text as string | undefined
        break
      }
    }
  }
  text = text?.trim()
  return text ? text : undefined // 空字符串视为无效，返回 undefined
}

/**
 * 为调试日志构建工具输入参数的短摘要字符串。
 *
 * 遍历 input 对象的字符串值，最多取 3 个字段，
 * 每个字段截断到 100 字符，格式为 key="value"。
 *
 * 例：{file_path: 'src/foo.ts', command: 'npm test'} → 'file_path="src/foo.ts" command="npm test"'
 */
function inputPreview(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === 'string') {
      parts.push(`${key}="${val.slice(0, 100)}"`)
    }
    if (parts.length >= 3) break // 最多 3 个字段
  }
  return parts.join(' ')
}

/**
 * 创建 Claude Code 子进程会话生成器（SessionSpawner）。
 *
 * 工厂函数，接受依赖注入参数，返回 SessionSpawner 对象。
 * 每次调用 spawn(opts, dir) 会生成一个新的 Claude Code 子进程并返回 SessionHandle。
 *
 * spawn 流程：
 *   1. 解析调试文件路径（支持会话 ID 后缀唯一化）
 *   2. 创建 transcript stream（原始 NDJSON 写入文件，用于事后分析）
 *   3. 组装子进程参数（--print --sdk-url --session-id --input/output-format --replay-user-messages 等）
 *   4. 组装子进程环境变量（屏蔽父进程 OAuth token，注入 session access token，可选 CCR v2 变量）
 *   5. spawn 子进程（stdio: pipe，windowsHide: true）
 *   6. 注册 stderr readline 监听（环形缓冲 MAX_STDERR_LINES 行，verbose 时转发到父进程 stderr）
 *   7. 注册 stdout readline 监听（NDJSON 解析 → extractActivities → onActivity / onPermissionRequest）
 *   8. 创建 done Promise（监听 'close' 事件，映射为 completed/interrupted/failed）
 *   9. 构造并返回 SessionHandle（包含 kill/forceKill/writeStdin/updateAccessToken 方法）
 */
export function createSessionSpawner(deps: SessionSpawnerDeps): SessionSpawner {
  return {
    spawn(opts: SessionSpawnOpts, dir: string): SessionHandle {
      // 调试文件路径解析：
      // 1. 若 deps.debugFile 已指定，添加会话 ID 后缀保证唯一性（支持带扩展名的路径）
      // 2. 若 verbose 模式或 ant 内部用户，自动生成临时目录路径
      // 3. 否则不生成调试文件
      const safeId = safeFilenameId(opts.sessionId)
      let debugFile: string | undefined
      if (deps.debugFile) {
        const ext = deps.debugFile.lastIndexOf('.')
        if (ext > 0) {
          // 有扩展名：在扩展名前插入 -{safeId}（如 bridge.log → bridge-cse_xxx.log）
          debugFile = `${deps.debugFile.slice(0, ext)}-${safeId}${deps.debugFile.slice(ext)}`
        } else {
          // 无扩展名：直接追加 -{safeId}
          debugFile = `${deps.debugFile}-${safeId}`
        }
      } else if (deps.verbose || process.env.USER_TYPE === 'ant') {
        // verbose 或 ant 用户：自动生成 /tmp/claude/bridge-session-{safeId}.log
        debugFile = join(tmpdir(), 'claude', `bridge-session-${safeId}.log`)
      }

      // Transcript 文件：将原始 NDJSON 行追加写入文件，用于事后分析
      // 仅在 deps.debugFile 已指定时创建（避免默认情况产生大量临时文件）
      let transcriptStream: WriteStream | null = null
      let transcriptPath: string | undefined
      if (deps.debugFile) {
        transcriptPath = join(
          dirname(deps.debugFile),
          `bridge-transcript-${safeId}.jsonl`,
        )
        transcriptStream = createWriteStream(transcriptPath, { flags: 'a' }) // 追加模式
        transcriptStream.on('error', err => {
          deps.onDebug(
            `[bridge:session] Transcript write error: ${err.message}`,
          )
          transcriptStream = null // 发生错误后停止写入
        })
        deps.onDebug(`[bridge:session] Transcript log: ${transcriptPath}`)
      }

      // 组装子进程命令行参数
      const args = [
        ...deps.scriptArgs, // npm 安装时包含脚本路径，编译二进制时为空
        '--print', // 非交互式打印模式
        '--sdk-url',
        opts.sdkUrl, // WebSocket/HTTP 会话端点 URL
        '--session-id',
        opts.sessionId, // 会话唯一标识符
        '--input-format',
        'stream-json', // stdin 格式：NDJSON 流
        '--output-format',
        'stream-json', // stdout 格式：NDJSON 流
        '--replay-user-messages', // 重放已有用户消息（断线重连时恢复上下文）
        ...(deps.verbose ? ['--verbose'] : []), // verbose 模式
        ...(debugFile ? ['--debug-file', debugFile] : []), // 调试日志文件
        ...(deps.permissionMode
          ? ['--permission-mode', deps.permissionMode] // 权限模式（如 'auto'）
          : []),
      ]

      // 组装子进程环境变量
      const env: NodeJS.ProcessEnv = {
        ...deps.env, // 继承父进程环境变量
        // 屏蔽父进程 OAuth token，避免子进程误用 bridge 的 OAuth 凭证做推理请求
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge', // 标记运行环境类型为 bridge
        ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }), // 沙盒模式强制开关
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken, // session JWT（子进程推理用）
        // v1 模式：HybridTransport（WS 读 + POST 写）到 session-ingress
        // v2 模式下无害——transportUtils 先检查 CLAUDE_CODE_USE_CCR_V2
        CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
        // v2 模式：SSETransport + CCRClient 到 CCR /v1/code/sessions/* 端点
        // 与 environment-manager 在容器路径中设置的变量相同
        ...(opts.useCcrV2 && {
          CLAUDE_CODE_USE_CCR_V2: '1', // 开启 CCR v2 transport
          CLAUDE_CODE_WORKER_EPOCH: String(opts.workerEpoch), // worker 代次（心跳/状态请求携带）
        }),
      }

      deps.onDebug(
        `[bridge:session] Spawning sessionId=${opts.sessionId} sdkUrl=${opts.sdkUrl} accessToken=${opts.accessToken ? 'present' : 'MISSING'}`,
      )
      deps.onDebug(`[bridge:session] Child args: ${args.join(' ')}`)
      if (debugFile) {
        deps.onDebug(`[bridge:session] Debug log: ${debugFile}`)
      }

      // 生成子进程，三个流均为 pipe 模式：
      //   stdin：接收父进程（bridge）的控制消息（令牌刷新等）
      //   stdout：输出 NDJSON 消息（assistant/result/control_request 等）
      //   stderr：错误输出（日志/异常堆栈）
      const child: ChildProcess = spawn(deps.execPath, args, {
        cwd: dir, // 工作目录（由 SpawnMode 决定）
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true, // Windows 下隐藏子进程窗口
      })

      deps.onDebug(
        `[bridge:session] sessionId=${opts.sessionId} pid=${child.pid}`,
      )

      const activities: SessionActivity[] = [] // 活动历史环形缓冲
      let currentActivity: SessionActivity | null = null // 当前（最新）活动
      const lastStderr: string[] = [] // stderr 最近行环形缓冲
      let sigkillSent = false // 防重复 SIGKILL 标志
      let firstUserMessageSeen = false // 首条用户消息已检测标志

      // 注册 stderr 监听：缓冲最近 N 行，verbose 时转发到父进程 stderr
      if (child.stderr) {
        const stderrRl = createInterface({ input: child.stderr })
        stderrRl.on('line', line => {
          if (deps.verbose) {
            process.stderr.write(line + '\n') // verbose 模式：转发到父进程 stderr
          }
          // 维护环形缓冲（超出 MAX_STDERR_LINES 时弹出最旧的一行）
          if (lastStderr.length >= MAX_STDERR_LINES) {
            lastStderr.shift()
          }
          lastStderr.push(line)
        })
      }

      // 注册 stdout NDJSON 监听：解析消息，提取活动和权限请求
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout })
        rl.on('line', line => {
          // 将原始 NDJSON 行写入 transcript 文件（若已初始化）
          if (transcriptStream) {
            transcriptStream.write(line + '\n')
          }

          // 调试日志：记录从子进程 CLI 流向 bridge 的所有消息
          deps.onDebug(
            `[bridge:ws] sessionId=${opts.sessionId} <<< ${debugTruncate(line)}`,
          )

          // verbose 模式：将原始输出转发到父进程 stderr（便于实时调试）
          if (deps.verbose) {
            process.stderr.write(line + '\n')
          }

          // 从 NDJSON 行提取 SessionActivity 并更新活动缓冲
          const extracted = extractActivities(
            line,
            opts.sessionId,
            deps.onDebug,
          )
          for (const activity of extracted) {
            // 维护活动环形缓冲（超出 MAX_ACTIVITIES 时弹出最旧的条目）
            if (activities.length >= MAX_ACTIVITIES) {
              activities.shift()
            }
            activities.push(activity)
            currentActivity = activity // 更新当前活动指针

            deps.onActivity?.(opts.sessionId, activity) // 通知外部监听方（BridgeLogger 等）
          }

          // 独立检测 control_request（权限请求）和 user 消息（首条用户文本）。
          // extractActivities 已解析同一行但忽略了 'user' 类型和权限请求；
          // 此处重新解析（NDJSON 行较小，重解析开销可忽略），保持各路径独立。
          {
            let parsed: unknown
            try {
              parsed = jsonParse(line)
            } catch {
              // 非 JSON 行，跳过检测
            }
            if (parsed && typeof parsed === 'object') {
              const msg = parsed as Record<string, unknown>

              if (msg.type === 'control_request') {
                // 权限请求：subtype='can_use_tool' 时通知 onPermissionRequest 回调
                const request = msg.request as
                  | Record<string, unknown>
                  | undefined
                if (
                  request?.subtype === 'can_use_tool' &&
                  deps.onPermissionRequest
                ) {
                  deps.onPermissionRequest(
                    opts.sessionId,
                    parsed as PermissionRequest,
                    opts.accessToken,
                  )
                }
                // interrupt 类型为转级别控制，由子进程内部（print.ts）处理，bridge 不需要响应
              } else if (
                msg.type === 'user' &&
                !firstUserMessageSeen &&
                opts.onFirstUserMessage
              ) {
                // 用户消息：提取第一条真实用户文本，触发 onFirstUserMessage 回调（用于会话标题派生）
                const text = extractUserMessageText(msg)
                if (text) {
                  firstUserMessageSeen = true // 标记已处理，后续用户消息忽略
                  opts.onFirstUserMessage(text)
                }
              }
            }
          }
        })
      }

      // 创建会话完成 Promise，监听子进程 'close' 事件
      const done = new Promise<SessionDoneStatus>(resolve => {
        child.on('close', (code, signal) => {
          // 子进程退出时关闭 transcript stream
          if (transcriptStream) {
            transcriptStream.end()
            transcriptStream = null
          }

          if (signal === 'SIGTERM' || signal === 'SIGINT') {
            // 收到 SIGTERM（graceful kill）或 SIGINT（Ctrl+C）→ 'interrupted'
            deps.onDebug(
              `[bridge:session] sessionId=${opts.sessionId} interrupted signal=${signal} pid=${child.pid}`,
            )
            resolve('interrupted')
          } else if (code === 0) {
            // 正常退出（exit code 0）→ 'completed'
            deps.onDebug(
              `[bridge:session] sessionId=${opts.sessionId} completed exit_code=0 pid=${child.pid}`,
            )
            resolve('completed')
          } else {
            // 非零 exit code → 'failed'
            deps.onDebug(
              `[bridge:session] sessionId=${opts.sessionId} failed exit_code=${code} pid=${child.pid}`,
            )
            resolve('failed')
          }
        })

        child.on('error', err => {
          // spawn 失败（如可执行文件不存在）→ 'failed'
          deps.onDebug(
            `[bridge:session] sessionId=${opts.sessionId} spawn error: ${err.message}`,
          )
          resolve('failed')
        })
      })

      // 构造 SessionHandle 对象，提供会话生命周期管理接口
      const handle: SessionHandle = {
        sessionId: opts.sessionId,
        done, // 会话完成 Promise
        activities, // 活动历史缓冲（引用，外部可观察）
        accessToken: opts.accessToken, // 当前 session JWT（可通过 updateAccessToken 更新）
        lastStderr, // stderr 最近行缓冲（引用，外部可观察）
        get currentActivity(): SessionActivity | null {
          return currentActivity // getter 返回最新活动（实时更新）
        },
        kill(): void {
          // 优雅终止：发送 SIGTERM，给子进程机会清理资源
          if (!child.killed) {
            deps.onDebug(
              `[bridge:session] Sending SIGTERM to sessionId=${opts.sessionId} pid=${child.pid}`,
            )
            // Windows 不支持 SIGTERM 信号名，使用默认 kill()
            if (process.platform === 'win32') {
              child.kill()
            } else {
              child.kill('SIGTERM')
            }
          }
        },
        forceKill(): void {
          // 强制终止：发送 SIGKILL（立即终止，无法被捕获）
          // 注意：child.killed 在 kill() 调用时即设置，而非进程真正退出时。
          // 使用独立的 sigkillSent 标志，避免在 SIGTERM 后重复发送 SIGKILL。
          if (!sigkillSent && child.pid) {
            sigkillSent = true
            deps.onDebug(
              `[bridge:session] Sending SIGKILL to sessionId=${opts.sessionId} pid=${child.pid}`,
            )
            if (process.platform === 'win32') {
              child.kill()
            } else {
              child.kill('SIGKILL')
            }
          }
        },
        writeStdin(data: string): void {
          // 向子进程 stdin 写入数据（仅在 stdin 未销毁时有效）
          if (child.stdin && !child.stdin.destroyed) {
            deps.onDebug(
              `[bridge:ws] sessionId=${opts.sessionId} >>> ${debugTruncate(data)}`,
            )
            child.stdin.write(data)
          }
        },
        updateAccessToken(token: string): void {
          handle.accessToken = token // 更新 handle 上的 accessToken 引用
          // 通过 stdin 向子进程发送令牌刷新消息。
          // 子进程的 StructuredIO 处理 update_environment_variables 消息，
          // 直接设置 process.env，使 getSessionIngressAuthToken() 在下次
          // refreshHeaders 调用时读取到新令牌。
          handle.writeStdin(
            jsonStringify({
              type: 'update_environment_variables',
              variables: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: token },
            }) + '\n', // NDJSON 需以换行符结尾
          )
          deps.onDebug(
            `[bridge:session] Sent token refresh via stdin for sessionId=${opts.sessionId}`,
          )
        },
      }

      return handle
    },
  }
}

/** 导出内部测试用函数（仅供单元测试使用） */
export { extractActivities as _extractActivitiesForTesting }
