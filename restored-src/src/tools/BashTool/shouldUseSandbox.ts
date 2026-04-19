/**
 * BashTool/shouldUseSandbox.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责决定是否对某条 bash 命令启用沙箱（sandbox）执行。
 * BashTool 在执行命令前调用 shouldUseSandbox，若返回 true 则通过 SandboxManager 隔离执行。
 *
 * 【重要说明】
 * excludedCommands（排除命令列表）是用户便利配置，不是安全边界。
 * 真正的安全控制是权限系统（向用户弹出批准对话框）。
 * 即使命令被排除出沙箱，权限系统仍会正常运行。
 *
 * 【主要功能】
 * - containsExcludedCommand（内部）：
 *     检查命令是否命中动态禁用命令（仅 ant 用户）或用户配置的排除列表。
 *     采用与 filterRulesByContentsMatchingInput 相同的迭代不动点方式
 *     剥除环境变量前缀和安全包装命令，支持 `FOO=bar bazel ...` 等形式的匹配。
 * - shouldUseSandbox（导出）：
 *     综合判断是否应对当前命令启用沙箱。
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

/**
 * SandboxInput
 *
 * 【类型说明】
 * shouldUseSandbox 的输入类型，包含可选的命令字符串和禁用沙箱标志。
 */
type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

/**
 * containsExcludedCommand
 *
 * 【函数作用】
 * 检查命令是否应被排除出沙箱（即不使用沙箱执行）。
 * 两类排除来源：
 *   1. 动态禁用命令（仅 ant 用户）：通过 GrowthBook 特性标志 tengu_sandbox_disabled_commands 配置，
 *      包含 substrings（子字符串匹配）和 commands（命令前缀匹配）两种规则。
 *   2. 用户配置的排除命令：从 settings.sandbox.excludedCommands 读取。
 *
 * 【环境变量和包装命令剥除】
 * 采用迭代不动点方法（与 filterRulesByContentsMatchingInput 一致），
 * 反复调用 stripAllLeadingEnvVars 和 stripSafeWrappers，
 * 直到无新候选产生，以处理 `timeout 300 FOO=bar bazel run` 等交替嵌套模式。
 *
 * NOTE: excludedCommands is a user-facing convenience feature, not a security boundary.
 * It is not a security bug to be able to bypass excludedCommands — the sandbox permission
 * system (which prompts users) is the actual security control.
 */
function containsExcludedCommand(command: string): boolean {
  // 动态禁用命令检查（仅对 ant 用户生效）
  // Check dynamic config for disabled commands and substrings (only for ants)
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // 子字符串匹配：命令包含任意禁用子串即命中
    // Check if command contains any disabled substrings
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // 命令前缀匹配：拆分复合命令后逐段检查首个词
    // Check if command starts with any disabled commands
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // 命令解析失败（如语法错误）时，保守地视为未排除，
      // 让后续验证模块处理，避免渲染工具调用消息时崩溃
      // If we can't parse the command (e.g., malformed bash syntax),
      // treat it as not excluded to allow other validation checks to handle it
      // This prevents crashes when rendering tool use messages
    }
  }

  // 读取用户配置的排除命令列表
  // Check user-configured excluded commands from settings
  const settings = getSettings_DEPRECATED()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  // 无用户排除规则，直接返回 false
  if (userExcludedCommands.length === 0) {
    return false
  }

  // 将复合命令拆分为独立子命令逐一检查，防止复合命令因首段匹配而逃逸沙箱
  // Split compound commands (e.g. "docker ps && curl evil.com") into individual
  // subcommands and check each one against excluded patterns. This prevents a
  // compound command from escaping the sandbox just because its first subcommand
  // matches an excluded pattern.
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    // 解析失败时将整条命令视为单个子命令
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // 对每个子命令生成候选字符串集合：
    // 通过迭代剥除环境变量前缀（stripAllLeadingEnvVars）和安全包装命令（stripSafeWrappers），
    // 直至不动点（无新候选产生），以匹配 `FOO=bar bazel ...`、`timeout 30 bazel ...` 等形式。
    // Also try matching with env var prefixes and wrapper commands stripped, so
    // that `FOO=bar bazel ...` and `timeout 30 bazel ...` match `bazel:*`. Not a
    // security boundary (see NOTE at top); the &&-split above already lets
    // `export FOO=bar && bazel ...` match. BINARY_HIJACK_VARS kept as a heuristic.
    //
    // We iteratively apply both stripping operations until no new candidates are
    // produced (fixed-point), matching the approach in filterRulesByContentsMatchingInput.
    // This handles interleaved patterns like `timeout 300 FOO=bar bazel run`
    // where single-pass composition would fail.
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    // 不动点迭代：每轮对新增候选施加两种剥除操作
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        // 剥除环境变量前缀（带二进制劫持变量黑名单）
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        // 剥除安全包装命令（如 timeout、sudo 等）
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    // 对所有候选字符串逐一与用户排除规则进行匹配
    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            // 前缀规则：命令完全相等或以 "<prefix> " 开头
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            // 精确规则：命令字符串完全匹配
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            // 通配符规则：使用 matchWildcardPattern 进行模式匹配
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

/**
 * shouldUseSandbox
 *
 * 【函数作用】
 * 综合判断当前命令是否应在沙箱中执行。判断逻辑：
 *   1. 若沙箱功能未启用（SandboxManager.isSandboxingEnabled() = false），直接返回 false。
 *   2. 若用户明确禁用沙箱（dangerouslyDisableSandbox=true）且策略允许非沙箱命令，返回 false。
 *   3. 若无命令字符串，返回 false。
 *   4. 若命令命中用户配置的排除列表，返回 false。
 *   5. 否则返回 true，使用沙箱执行。
 */
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  // 沙箱功能未启用，直接跳过
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // 用户明确禁用且策略允许，跳过沙箱
  // Don't sandbox if explicitly overridden AND unsandboxed commands are allowed by policy
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  // 无命令字符串，无需沙箱
  if (!input.command) {
    return false
  }

  // 命令在用户排除列表中，不使用沙箱
  // Don't sandbox if the command contains user-configured excluded commands
  if (containsExcludedCommand(input.command)) {
    return false
  }

  // 所有条件均通过，使用沙箱执行
  return true
}
