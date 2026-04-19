/**
 * 【API 请求转储与调试工具模块】api/dumpPrompts.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层的调试辅助工具，仅在 ant（内部员工）环境下激活
 * - 由 api/claude.ts 通过 createDumpPromptsFetch() 注入到每个 Anthropic SDK 客户端
 * - 将每次 API 请求（系统提示、工具定义、用户消息）和响应持久化到 JSONL 文件
 * - 供 /issue 命令读取最近的 API 请求，打包上报为 bug report
 *
 * 核心功能：
 * - createDumpPromptsFetch(): 返回一个 fetch 包装器，拦截 API 请求并异步记录到 JSONL 文件
 * - addApiRequestToCache(): 在内存中缓存最近 5 次 API 请求（仅 ant 用户）
 * - getLastApiRequests(): 返回内存缓存的最近 API 请求列表（用于 /issue 命令）
 * - dumpRequest(): 核心解析逻辑，将 POST body 解析为结构化的 JSONL 条目
 * - getDumpPromptsPath(): 返回当前会话/代理的 JSONL 文件路径
 *
 * 文件格式（每行一个 JSON 对象）：
 * - { type: "init", timestamp, data: { system, tools, model, ... } }：首次请求时的初始化数据
 * - { type: "system_update", timestamp, data: { ... } }：system/tools 变化时写入
 * - { type: "message", timestamp, data: { role: "user", ... } }：新增用户消息
 * - { type: "response", timestamp, data: { ... } }：API 响应（仅 ant 用户）
 *
 * 性能考虑：
 * - 请求/响应解析均通过 setImmediate/异步 IIFE 延迟执行，不阻塞实际 API 调用
 * - 通过 "指纹" 机制（model|toolNames|systemLength）避免对结构不变的请求重复序列化
 */

import type { ClientOptions } from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

/** 计算字符串的 SHA-256 哈希值（用于初始化数据的内容变更检测） */
function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// 仅为 ant 用户在内存中缓存最近几次 API 请求（供 /issue 命令使用）
const MAX_CACHED_REQUESTS = 5
const cachedApiRequests: Array<{ timestamp: string; request: unknown }> = []

/** 每个会话/代理的转储状态 */
type DumpState = {
  initialized: boolean          // 是否已写入第一条 init 记录
  messageCountSeen: number      // 已处理的消息总数（用于增量写入）
  lastInitDataHash: string      // 上次 init 数据的哈希值（用于变更检测）
  // 廉价指纹：跳过 stringify+hash 的快速变更检测
  // 当 model/tools/system 结构与上次相同时，跳过耗时的序列化+哈希操作
  lastInitFingerprint: string
}

// 按会话/代理 ID 存储转储状态，避免不同代理之间的状态污染
const dumpState = new Map<string, DumpState>()

/**
 * 返回内存中缓存的最近 API 请求列表（浅拷贝）
 *
 * 供 /issue 命令使用，将最近的请求打包到 bug report 中
 */
export function getLastApiRequests(): Array<{
  timestamp: string
  request: unknown
}> {
  return [...cachedApiRequests]
}

/** 清空 API 请求内存缓存（用于测试或会话重置） */
export function clearApiRequestCache(): void {
  cachedApiRequests.length = 0
}

/** 清除指定会话/代理的转储状态（用于会话重置） */
export function clearDumpState(agentIdOrSessionId: string): void {
  dumpState.delete(agentIdOrSessionId)
}

/** 清除所有会话的转储状态 */
export function clearAllDumpState(): void {
  dumpState.clear()
}

/**
 * 将 API 请求添加到内存缓存（仅 ant 用户）
 *
 * 维护一个最近 MAX_CACHED_REQUESTS（5）条请求的环形缓冲区，
 * 超出上限时丢弃最旧的记录。
 */
export function addApiRequestToCache(requestData: unknown): void {
  if (process.env.USER_TYPE !== 'ant') return
  cachedApiRequests.push({
    timestamp: new Date().toISOString(),
    request: requestData,
  })
  if (cachedApiRequests.length > MAX_CACHED_REQUESTS) {
    cachedApiRequests.shift() // 移除最旧的记录（FIFO）
  }
}

/**
 * 返回指定会话/代理的 JSONL 转储文件路径
 *
 * 路径格式：~/.claude/dump-prompts/<sessionId>.jsonl
 * 不同会话/代理使用不同文件，避免混入
 */
export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'dump-prompts',
    `${agentIdOrSessionId ?? getSessionId()}.jsonl`,
  )
}

/**
 * 异步追加一组 JSONL 条目到文件（fire-and-forget）
 *
 * 自动创建父目录（若不存在），并在末尾追加换行。
 * 失败时静默忽略（不影响正常 API 调用）。
 */
function appendToFile(filePath: string, entries: string[]): void {
  if (entries.length === 0) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, entries.join('\n') + '\n'))
    .catch(() => {})
}

/**
 * 计算请求初始化数据的轻量指纹
 *
 * 指纹格式：`${model}|${toolNames}|${systemLength}`
 * 用于快速判断 system/tools 是否发生结构性变化，
 * 避免每次请求都执行耗时的 stringify+hash 操作（system prompt + tool schemas 可达数 MB）
 */
function initFingerprint(req: Record<string, unknown>): string {
  const tools = req.tools as Array<{ name?: string }> | undefined
  const system = req.system as unknown[] | string | undefined
  const sysLen =
    typeof system === 'string'
      ? system.length
      : Array.isArray(system)
        ? system.reduce(
            (n: number, b) => n + ((b as { text?: string }).text?.length ?? 0),
            0,
          )
        : 0
  const toolNames = tools?.map(t => t.name ?? '').join(',') ?? ''
  return `${req.model}|${toolNames}|${sysLen}`
}

/**
 * 解析并记录单次 API 请求到 JSONL 文件（核心转储逻辑）
 *
 * 工作流程：
 * 1. 解析 JSON body，添加到内存缓存
 * 2. 非 ant 用户仅更新内存缓存，不写文件
 * 3. 计算 init 指纹，检查 system/tools 是否变更：
 *    - 首次请求：写入 init 记录（含完整 system、tools、model 等）
 *    - 后续请求但 system/tools 变更：写入 system_update 记录
 * 4. 提取新增的 user 消息（从 messageCountSeen 开始），追加到文件
 *    （assistant 消息在响应中捕获，不在此处记录）
 *
 * @param body - API 请求的 JSON 字符串 body
 * @param ts - 请求时间戳（ISO 格式）
 * @param state - 当前会话的转储状态
 * @param filePath - 目标 JSONL 文件路径
 */
function dumpRequest(
  body: string,
  ts: string,
  state: DumpState,
  filePath: string,
): void {
  try {
    const req = jsonParse(body) as Record<string, unknown>
    addApiRequestToCache(req) // 所有用户都更新内存缓存

    if (process.env.USER_TYPE !== 'ant') return // 非 ant 用户不写文件
    const entries: string[] = []
    const messages = (req.messages ?? []) as Array<{ role?: string }>

    // 写入 init 数据（system、tools、metadata）在首次请求时，
    // 或在 system/tools 变化时写入 system_update。
    // 先用廉价指纹检测：system+tools 在对话轮次间通常不变，
    // 指纹不变时跳过耗时的 300ms stringify 操作。
    const fingerprint = initFingerprint(req)
    if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
      const { messages: _, ...initData } = req // 从 init 数据中排除 messages（单独记录）
      const initDataStr = jsonStringify(initData)
      const initDataHash = hashString(initDataStr)
      state.lastInitFingerprint = fingerprint
      if (!state.initialized) {
        // 首次请求：写入完整 init 记录
        state.initialized = true
        state.lastInitDataHash = initDataHash
        // 复用 initDataStr 而非重新序列化，timestamp ISO 字符串不含需要转义的字符
        entries.push(
          `{"type":"init","timestamp":"${ts}","data":${initDataStr}}`,
        )
      } else if (initDataHash !== state.lastInitDataHash) {
        // system/tools 发生变化：写入 system_update 记录
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"system_update","timestamp":"${ts}","data":${initDataStr}}`,
        )
      }
    }

    // 只记录新增的 user 消息（从上次已处理位置开始，assistant 消息在响应中捕获）
    for (const msg of messages.slice(state.messageCountSeen)) {
      if (msg.role === 'user') {
        entries.push(
          jsonStringify({ type: 'message', timestamp: ts, data: msg }),
        )
      }
    }
    state.messageCountSeen = messages.length // 更新已处理消息计数

    appendToFile(filePath, entries)
  } catch {
    // 忽略解析错误，不影响正常 API 调用
  }
}

/**
 * 创建用于指定会话/代理的 dump-prompts fetch 包装器
 *
 * 工作流程：
 * 1. 拦截 POST 请求（API 调用）
 * 2. 通过 setImmediate 异步（非阻塞）解析请求 body 并写入 JSONL 文件
 * 3. 等待实际 fetch 响应
 * 4. 若响应成功（且为 ant 用户），异步克隆并解析响应体：
 *    - SSE 流式响应：读取完整流，解析所有 data: ... 行，存储为 { stream: true, chunks: [...] }
 *    - 非流式响应：直接解析 JSON
 *    - 追加到 JSONL 文件
 *
 * 注意：请求和响应的解析均为异步，不阻塞关键路径
 *
 * @param agentIdOrSessionId - 会话或代理的唯一 ID（用于确定 JSONL 文件路径和状态）
 */
export function createDumpPromptsFetch(
  agentIdOrSessionId: string,
): ClientOptions['fetch'] {
  const filePath = getDumpPromptsPath(agentIdOrSessionId)

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    // 获取或初始化当前会话/代理的转储状态
    const state = dumpState.get(agentIdOrSessionId) ?? {
      initialized: false,
      messageCountSeen: 0,
      lastInitDataHash: '',
      lastInitFingerprint: '',
    }
    dumpState.set(agentIdOrSessionId, state)

    let timestamp: string | undefined

    if (init?.method === 'POST' && init.body) {
      timestamp = new Date().toISOString()
      // 解析和序列化请求体（系统提示 + 工具 schema 可达数 MB，耗时数百 ms）
      // 通过 setImmediate 延迟执行，不阻塞实际的 API 请求（这是调试工具，不在关键路径上）
      setImmediate(dumpRequest, init.body as string, timestamp, state, filePath)
    }

    // 发起实际的 API 请求（不等待上面的 setImmediate）
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const response = await globalThis.fetch(input, init)

    // 异步保存响应（仅 ant 用户、请求成功时）
    if (timestamp && response.ok && process.env.USER_TYPE === 'ant') {
      const cloned = response.clone() // 克隆响应，因为 response body 只能读取一次
      void (async () => {
        try {
          const isStreaming = cloned.headers
            .get('content-type')
            ?.includes('text/event-stream')

          let data: unknown
          if (isStreaming && cloned.body) {
            // 处理 SSE 流式响应：读取完整流并解析所有事件
            const reader = cloned.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
              }
            } finally {
              reader.releaseLock()
            }
            // 将 SSE 缓冲区解析为 JSON chunk 数组
            const chunks: unknown[] = []
            for (const event of buffer.split('\n\n')) {
              for (const line of event.split('\n')) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    chunks.push(jsonParse(line.slice(6)))
                  } catch {
                    // 忽略单个 chunk 的解析错误
                  }
                }
              }
            }
            data = { stream: true, chunks }
          } else {
            // 非流式响应：直接解析 JSON
            data = await cloned.json()
          }

          // 将响应追加到 JSONL 文件
          await fs.appendFile(
            filePath,
            jsonStringify({ type: 'response', timestamp, data }) + '\n',
          )
        } catch {
          // 响应保存失败时静默忽略（best effort）
        }
      })()
    }

    return response
  }
}
