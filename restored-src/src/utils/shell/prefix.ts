/**
 * 基于 Haiku LLM 的命令前缀提取模块（通用版）。
 *
 * 在 Claude Code 系统中，该模块位于权限检查流程的核心位置，
 * 供 BashTool 和 PowerShellTool 共享使用：
 *   Shell 工具（BashTool/PowerShellTool）→ createCommandPrefixExtractor()
 *   → getCommandPrefixImpl()（Haiku 查询）→ 权限系统
 *
 * 核心机制：
 * - `createCommandPrefixExtractor()`：创建带 LRU 缓存（200 条）的前缀提取函数，
 *   失败时自动驱逐缓存项，防止中止/失败的 Haiku 调用污染后续查找。
 * - `createSubcommandPrefixExtractor()`：为复合命令（含子命令）并发提取前缀。
 * - `getCommandPrefixImpl()`：核心 Haiku 查询逻辑，含超时警告、结果校验、
 *   危险前缀拦截（DANGEROUS_SHELL_PREFIXES 和 `git`）。
 *
 * 安全设计：
 * - `DANGEROUS_SHELL_PREFIXES`：Shell 可执行文件黑名单，绝不接受为裸前缀，
 *   防止 "bash:*" 等前缀绕过权限系统放行任意命令。
 * - 检测到命令注入（command_injection_detected）时返回 commandPrefix=null。
 *
 * 主要导出：
 * - `DANGEROUS_SHELL_PREFIXES`（内部常量，隐式使用）
 * - `CommandPrefixResult`：单命令前缀结果类型
 * - `CommandSubcommandPrefixResult`：含子命令前缀的结果类型
 * - `PrefixExtractorConfig`：提取器配置类型
 * - `createCommandPrefixExtractor()`：创建 LRU 缓存化的前缀提取函数
 * - `createSubcommandPrefixExtractor()`：创建支持子命令的前缀提取函数
 */

import chalk from 'chalk'
import type { QuerySource } from '../../constants/querySource.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryHaiku } from '../../services/api/claude.js'
import { startsWithApiErrorPrefix } from '../../services/api/errors.js'
import { memoizeWithLRU } from '../memoize.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'

/**
 * 绝不接受为裸前缀的 Shell 可执行文件集合。
 * 允许例如 "bash:*" 会使任意命令通过权限检查，
 * 彻底破坏权限系统。包含 Unix shells 和 Windows 等效项。
 */
const DANGEROUS_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash.exe',
])

/** 单命令前缀提取结果：包含检测到的命令前缀，或 null（无法确定时） */
export type CommandPrefixResult = {
  /** 检测到的命令前缀，或 null（无法确定前缀时） */
  commandPrefix: string | null
}

/** 含子命令前缀的复合命令结果：在单命令结果基础上增加子命令前缀 Map */
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/** 创建命令前缀提取器的配置类型 */
export type PrefixExtractorConfig = {
  /** 工具名称，用于日志和警告消息 */
  toolName: string

  /** 包含 Haiku 查询示例的策略规范文本 */
  policySpec: string
  /** 分析事件名称，用于日志记录 */
  eventName: string

  /** API 调用的来源标识符 */
  querySource: QuerySource

  /** 可选的预检函数，可短路 Haiku 调用（如 isHelpCommand for Bash） */
  preCheck?: (command: string) => CommandPrefixResult | null
}

/**
 * 创建带 LRU 缓存的命令前缀提取函数。
 *
 * 使用两层缓存机制：外层 memoize 函数创建 Promise 并附加 .catch 处理器，
 * 在 Promise rejected 时驱逐该缓存项，防止中止或失败的 Haiku 调用
 * 污染后续查找。Identity guard 确保 LRU 驱逐后不会错误删除更新的 Promise。
 *
 * LRU 上限为 200 条，防止高频会话中无限增长。
 *
 * @param config 提取器配置
 * @returns 带 LRU 缓存的异步前缀提取函数
 */
export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const { toolName, policySpec, eventName, querySource, preCheck } = config

  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandPrefixResult | null> => {
      const promise = getCommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        toolName,
        policySpec,
        eventName,
        querySource,
        preCheck,
      )
      // 失败时驱逐缓存项，防止中止的调用污染后续轮次。
      // Identity guard：LRU 驱逐后，同 key 可能已有新 Promise，
      // 过期的 rejection 不应删除新 Promise。
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // 仅按命令字符串缓存
    200,
  )

  return memoized
}

/**
 * 创建支持子命令的复合命令前缀提取函数（带 LRU 缓存）。
 *
 * 使用与 createCommandPrefixExtractor 相同的两层缓存模式：
 * .catch 处理器在 rejected 时驱逐缓存项，防止污染。
 *
 * @param getPrefix 单命令前缀提取函数（来自 createCommandPrefixExtractor）
 * @param splitCommand 将复合命令拆分为子命令数组的函数
 * @returns 带缓存的异步函数，返回主命令和所有子命令的前缀
 */
export function createSubcommandPrefixExtractor(
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommand: (command: string) => string[] | Promise<string[]>,
) {
  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandSubcommandPrefixResult | null> => {
      const promise = getCommandSubcommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        getPrefix,
        splitCommand,
      )
      // 失败时驱逐缓存项，防止过期结果污染后续轮次
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // 仅按命令字符串缓存
    200,
  )

  return memoized
}

/**
 * 核心前缀提取实现：向 Haiku 发起查询并校验结果。
 *
 * 流程：
 * 1. 测试环境直接返回 null（跳过 API 调用）
 * 2. 执行预检（preCheck），可短路 Haiku 调用
 * 3. 设置 10 秒超时警告定时器
 * 4. 查询 Haiku，传入工具策略规范（tengu_cork_m4q feature flag 控制是否启用 prompt cache）
 * 5. 校验响应：
 *    - API 错误 → null
 *    - command_injection_detected → commandPrefix=null（安全拦截）
 *    - 危险 Shell 前缀或 `git` → commandPrefix=null（权限保护）
 *    - "none" → commandPrefix=null（未检测到前缀）
 *    - 前缀不是命令的前缀 → commandPrefix=null（校验失败）
 *    - 有效前缀 → commandPrefix=prefix
 */
async function getCommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  toolName: string,
  policySpec: string,
  eventName: string,
  querySource: QuerySource,
  preCheck?: (command: string) => CommandPrefixResult | null,
): Promise<CommandPrefixResult | null> {
  // 测试环境跳过 Haiku API 调用
  if (process.env.NODE_ENV === 'test') {
    return null
  }

  // 运行预检（如 isHelpCommand for Bash），可提前返回结果
  if (preCheck) {
    const preCheckResult = preCheck(command)
    if (preCheckResult !== null) {
      return preCheckResult
    }
  }

  let preflightCheckTimeoutId: NodeJS.Timeout | undefined
  const startTime = Date.now()
  let result: CommandPrefixResult | null = null

  try {
    // 设置 10 秒超时警告：若 Haiku 查询过慢，向用户提示可能的 API 问题
    preflightCheckTimeoutId = setTimeout(
      (tn, nonInteractive) => {
        const message = `[${tn}Tool] Pre-flight check is taking longer than expected. Run with ANTHROPIC_LOG=debug to check for failed or slow API requests.`
        if (nonInteractive) {
          // 非交互模式：输出 JSON 格式日志到 stderr
          process.stderr.write(jsonStringify({ level: 'warn', message }) + '\n')
        } else {
          // 交互模式：在 console 输出黄色警告
          // biome-ignore lint/suspicious/noConsole: intentional warning
          console.warn(chalk.yellow(`⚠️  ${message}`))
        }
      },
      10000, // 10 秒超时阈值
      toolName,
      isNonInteractiveSession,
    )

    // feature flag：tengu_cork_m4q 控制是否将 policySpec 放入 system prompt（启用 prompt cache）
    const useSystemPromptPolicySpec = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_cork_m4q',
      false,
    )

    // 向 Haiku 发起查询
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt(
        useSystemPromptPolicySpec
          ? [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\n${policySpec}`,
            ]
          : [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\nThis policy spec defines how to determine the prefix of a ${toolName} command:`,
            ],
      ),
      userPrompt: useSystemPromptPolicySpec
        ? `Command: ${command}`
        : `${policySpec}\n\nCommand: ${command}`,
      signal: abortSignal,
      options: {
        enablePromptCaching: useSystemPromptPolicySpec,
        querySource,
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 查询完成，清除超时警告定时器
    clearTimeout(preflightCheckTimeoutId)
    const durationMs = Date.now() - startTime

    // 提取响应文本（兼容字符串和 content block 数组两种格式）
    const prefix =
      typeof response.message.content === 'string'
        ? response.message.content
        : Array.isArray(response.message.content)
          ? (response.message.content.find(_ => _.type === 'text')?.text ??
            'none')
          : 'none'

    if (startsWithApiErrorPrefix(prefix)) {
      // API 错误，无法确定前缀
      logEvent(eventName, {
        success: false,
        error:
          'API error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = null
    } else if (prefix === 'command_injection_detected') {
      // Haiku 检测到可疑命令注入，视为无前缀可用
      logEvent(eventName, {
        success: false,
        error:
          'command_injection_detected' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (
      prefix === 'git' ||
      DANGEROUS_SHELL_PREFIXES.has(prefix.toLowerCase())
    ) {
      // 绝不接受裸 `git` 或 Shell 可执行文件作为前缀（权限系统安全保护）
      logEvent(eventName, {
        success: false,
        error:
          'dangerous_shell_prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (prefix === 'none') {
      // 未检测到前缀
      logEvent(eventName, {
        success: false,
        error:
          'prefix "none"' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else {
      // 校验返回的前缀是否确实是命令字符串的前缀
      if (!command.startsWith(prefix)) {
        // Haiku 返回的前缀不是命令的前缀，校验失败
        logEvent(eventName, {
          success: false,
          error:
            'command did not start with prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs,
        })
        result = {
          commandPrefix: null,
        }
      } else {
        // 前缀有效
        logEvent(eventName, {
          success: true,
          durationMs,
        })
        result = {
          commandPrefix: prefix,
        }
      }
    }

    return result
  } catch (error) {
    // 查询出现异常，清除超时定时器后重新抛出（让 memoize 的 .catch 驱逐缓存项）
    clearTimeout(preflightCheckTimeoutId)
    throw error
  }
}

/**
 * 复合命令子命令前缀提取实现。
 *
 * 流程：
 * 1. 用 splitCommandFn 将复合命令拆分为子命令数组
 * 2. 并发提取主命令前缀和所有子命令前缀（Promise.all）
 * 3. 若主命令前缀提取失败，返回 null
 * 4. 将子命令前缀收集到 Map 并与主命令前缀合并返回
 */
async function getCommandSubcommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommandFn: (command: string) => string[] | Promise<string[]>,
): Promise<CommandSubcommandPrefixResult | null> {
  // 将复合命令拆分为子命令列表
  const subcommands = await splitCommandFn(command)

  // 并发提取主命令和所有子命令的前缀
  const [fullCommandPrefix, ...subcommandPrefixesResults] = await Promise.all([
    getPrefix(command, abortSignal, isNonInteractiveSession),
    ...subcommands.map(async subcommand => ({
      subcommand,
      prefix: await getPrefix(subcommand, abortSignal, isNonInteractiveSession),
    })),
  ])

  // 主命令前缀提取失败，返回 null
  if (!fullCommandPrefix) {
    return null
  }

  // 将有效的子命令前缀收集到 Map
  const subcommandPrefixes = subcommandPrefixesResults.reduce(
    (acc, { subcommand, prefix }) => {
      if (prefix) {
        acc.set(subcommand, prefix)
      }
      return acc
    },
    new Map<string, CommandPrefixResult>(),
  )

  return {
    ...fullCommandPrefix,
    subcommandPrefixes,
  }
}
