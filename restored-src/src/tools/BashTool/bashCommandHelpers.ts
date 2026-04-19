/**
 * BashTool/bashCommandHelpers.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件是 BashTool 权限检查管道中专门处理"复合/管道命令"的辅助模块。
 * 在整体权限流程中：
 *   1. bashPermissions.ts 是权限检查的总协调器，当遇到含管道符（|）或
 *      复合结构（子 shell、命令组）的命令时，会调用本文件的
 *      checkCommandOperatorPermissions 入口函数。
 *   2. 本文件将管道命令拆分为多个独立段（segment），分别通过完整权限系统
 *      检查每一段，最终聚合结果：全通过 → allow；有拒绝 → deny；否则 → ask。
 *   3. 包含一个关键安全检查：跨段 cd+git 检测，防止裸仓库 fsmonitor 注入攻击。
 *
 * 【主要功能】
 * - 导出 CommandIdentityCheckers 类型：用于注入 cd/git 命令识别函数
 * - 导出 checkCommandOperatorPermissions：公开入口，解析 AST 并委托内部逻辑
 * - 内部函数 bashToolCheckCommandOperatorPermissions：处理子 shell/命令组/管道
 * - 内部函数 segmentedCommandPermissionResult：逐段检查并聚合权限结果
 * - 内部函数 buildSegmentWithoutRedirections：剥离输出重定向以避免误判
 */

import type { z } from 'zod/v4'
import {
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from '../../utils/bash/ParsedCommand.js'
import { type Node, PARSE_ABORTED } from '../../utils/bash/parser.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { createPermissionRequestMessage } from '../../utils/permissions/permissions.js'
import { BashTool } from './BashTool.js'
import { bashCommandIsSafeAsync_DEPRECATED } from './bashSecurity.js'

/**
 * CommandIdentityCheckers
 *
 * 注入给管道段检查逻辑的两个命令识别函数：
 * - isNormalizedCdCommand：判断一条命令是否为规范化 cd 命令
 * - isNormalizedGitCommand：判断一条命令是否为规范化 git 命令
 *
 * 通过依赖注入而非直接导入，避免循环依赖并提升可测试性。
 */
export type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}

/**
 * segmentedCommandPermissionResult
 *
 * 【函数作用】
 * 对管道命令的各个独立段逐一执行完整权限检查，并聚合最终结果。
 *
 * 【检查流程】
 * 1. 多 cd 检测：若多个段都含 cd 命令，要求用户批准（清晰性原则）。
 * 2. 跨段 cd+git 安全检测：若不同段分别含有 cd 和 git，要求批准以防裸仓库攻击。
 * 3. 逐段递归检查：每段单独经过 bashToolHasPermissionFn 全量权限系统。
 * 4. 结果聚合：
 *    - 任一段 deny → 整体 deny
 *    - 全部 allow → 整体 allow
 *    - 其余情况（有 ask）→ 整体 ask，并收集建议规则
 *
 * @param input            原始 BashTool 输入（含完整命令字符串等）
 * @param segments         已拆分的管道段命令列表（已去除输出重定向）
 * @param bashToolHasPermissionFn  对单条命令执行完整权限检查的回调
 * @param checkers         cd/git 命令识别函数集合
 */
async function segmentedCommandPermissionResult(
  input: z.infer<typeof BashTool.inputSchema>,
  segments: string[],
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
): Promise<PermissionResult> {
  // 统计所有段中包含 cd 命令的数量
  const cdCommands = segments.filter(segment => {
    const trimmed = segment.trim()
    return checkers.isNormalizedCdCommand(trimmed)
  })
  // 多个 cd 命令同时出现会让工作目录变化难以追踪，强制要求批准
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // SECURITY: Check for cd+git across pipe segments to prevent bare repo fsmonitor bypass.
  // When cd and git are in different pipe segments (e.g., "cd sub && echo | git status"),
  // each segment is checked independently and neither triggers the cd+git check in
  // bashPermissions.ts. We must detect this cross-segment pattern here.
  // Each pipe segment can itself be a compound command (e.g., "cd sub && echo"),
  // so we split each segment into subcommands before checking.
  // 【安全说明】跨段 cd+git 检测：
  //   若 cd 和 git 分别位于不同的管道段，bashPermissions.ts 中的
  //   单段 cd+git 检测会被绕过。此处需在管道层面再次检测该组合，
  //   防止攻击者通过裸仓库的 fsmonitor hook 注入恶意代码执行。
  {
    let hasCd = false
    let hasGit = false
    for (const segment of segments) {
      // 每个管道段本身可能是复合命令（如 "cd sub && echo"），需进一步拆分
      const subcommands = splitCommand_DEPRECATED(segment)
      for (const sub of subcommands) {
        const trimmed = sub.trim()
        if (checkers.isNormalizedCdCommand(trimmed)) {
          hasCd = true
        }
        if (checkers.isNormalizedGitCommand(trimmed)) {
          hasGit = true
        }
      }
    }
    // cd 和 git 跨段共存，触发安全拦截
    if (hasCd && hasGit) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 用 Map 存储每个段对应的权限检查结果，保持顺序不变
  const segmentResults = new Map<string, PermissionResult>()

  // 逐段调用完整权限系统进行检查
  for (const segment of segments) {
    const trimmedSegment = segment.trim()
    if (!trimmedSegment) continue // 跳过空段（如连续管道符产生的空字符串）

    // 以当前段替换 input.command，递归调用权限检查
    const segmentResult = await bashToolHasPermissionFn({
      ...input,
      command: trimmedSegment,
    })
    segmentResults.set(trimmedSegment, segmentResult)
  }

  // 若任一段被拒绝，整体命令拒绝；取第一个 deny 段的消息
  const deniedSegment = Array.from(segmentResults.entries()).find(
    ([, result]) => result.behavior === 'deny',
  )

  if (deniedSegment) {
    const [segmentCommand, segmentResult] = deniedSegment
    return {
      behavior: 'deny',
      message:
        segmentResult.behavior === 'deny'
          ? segmentResult.message
          : `Permission denied for: ${segmentCommand}`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // 全部段均为 allow，整体允许
  const allAllowed = Array.from(segmentResults.values()).every(
    result => result.behavior === 'allow',
  )

  if (allAllowed) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // 存在需要批准的段：收集各段提供的规则建议，汇总后一并展示给用户
  const suggestions: PermissionUpdate[] = []
  for (const [, result] of segmentResults) {
    if (
      result.behavior !== 'allow' &&
      'suggestions' in result &&
      result.suggestions
    ) {
      suggestions.push(...result.suggestions)
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: segmentResults,
  }

  // 返回 ask，附带所有建议规则（若有）供用户快速批准
  return {
    behavior: 'ask',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  }
}

/**
 * buildSegmentWithoutRedirections
 *
 * 【函数作用】
 * 在对管道段进行权限检查前，剥除输出重定向部分（`> file`、`>> file` 等）。
 * 这样可以避免将重定向目标文件名误判为子命令名。
 *
 * 【快速路径】
 * 若段中不含 `>`，直接返回原字符串，跳过解析开销。
 *
 * 【实现说明】
 * 使用 ParsedCommand.parse 解析命令，调用 withoutOutputRedirections()
 * 获取去除重定向后的命令文本，同时保留原始引号。
 * 若解析失败，回退到原始字符串（保守策略）。
 *
 * @param segmentCommand  单个管道段的命令字符串
 * @returns               去除输出重定向后的命令字符串
 */
async function buildSegmentWithoutRedirections(
  segmentCommand: string,
): Promise<string> {
  // 快速路径：没有 > 符号时跳过 AST 解析，直接返回原命令
  if (!segmentCommand.includes('>')) {
    return segmentCommand
  }

  // 使用 ParsedCommand 剥离重定向，同时保留引号内容不变
  const parsed = await ParsedCommand.parse(segmentCommand)
  return parsed?.withoutOutputRedirections() ?? segmentCommand
}

/**
 * checkCommandOperatorPermissions
 *
 * 【函数作用】
 * 公开入口函数。负责将命令字符串或预解析的 AST 根节点转化为
 * IParsedCommand 对象，然后委托给内部的
 * bashToolCheckCommandOperatorPermissions 执行实际检查。
 *
 * 【解析策略】
 * - 若已有有效的 AST 根节点（astRoot），使用 buildParsedCommandFromRoot
 *   直接构建 ParsedCommand，避免重复解析。
 * - 若 astRoot 为 null 或 PARSE_ABORTED，回退到 ParsedCommand.parse
 *   重新解析命令字符串。
 * - 若解析仍失败，返回 passthrough（让上层逻辑处理）。
 *
 * @param input                  BashTool 输入对象
 * @param bashToolHasPermissionFn  单条命令权限检查回调
 * @param checkers               cd/git 命令识别函数
 * @param astRoot                预解析的 AST 根节点（可为 null/PARSE_ABORTED）
 */
export async function checkCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | null | typeof PARSE_ABORTED,
): Promise<PermissionResult> {
  // 优先使用已有 AST 根节点构建 ParsedCommand，减少重复解析开销
  const parsed =
    astRoot && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  // 解析彻底失败时，passthrough 让调用方按默认逻辑处理
  if (!parsed) {
    return { behavior: 'passthrough', message: 'Failed to parse command' }
  }
  return bashToolCheckCommandOperatorPermissions(
    input,
    bashToolHasPermissionFn,
    checkers,
    parsed,
  )
}

/**
 * bashToolCheckCommandOperatorPermissions
 *
 * 【函数作用】
 * 核心内部逻辑：基于已解析的 IParsedCommand 对象，依次执行：
 *   1. 子 shell / 命令组检测：不安全的复合结构直接要求批准。
 *   2. 管道段检测：若只有一段（无管道），返回 passthrough 让正常流程处理。
 *   3. 多管道段处理：对每段剥除重定向后，调用 segmentedCommandPermissionResult。
 *
 * 【子 shell / 命令组检测】
 * 优先使用 tree-sitter 分析（compoundStructure.hasSubshell /
 * compoundStructure.hasCommandGroup）；若不可用，回退到
 * isUnsafeCompoundCommand_DEPRECATED。检测到后调用
 * bashCommandIsSafeAsync_DEPRECATED 获取更具体的错误信息。
 *
 * @param input                  BashTool 输入对象
 * @param bashToolHasPermissionFn  单条命令权限检查回调
 * @param checkers               cd/git 命令识别函数
 * @param parsed                 已解析的命令结构对象
 */
async function bashToolCheckCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  parsed: IParsedCommand,
): Promise<PermissionResult> {
  // 1. 检查是否含有不安全的复合结构（子 shell 或命令组）
  const tsAnalysis = parsed.getTreeSitterAnalysis()
  // 优先使用 tree-sitter 提供的结构化分析；旧版回退使用正则匹配
  const isUnsafeCompound = tsAnalysis
    ? tsAnalysis.compoundStructure.hasSubshell ||
      tsAnalysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (isUnsafeCompound) {
    // 命令含有 shell 操作符（如子 shell `()`、命令组 `{}`）无法作为子命令拆分
    // 调用遗留安全检查以获取更具体的拒绝原因
    const safetyResult = await bashCommandIsSafeAsync_DEPRECATED(input.command)

    const decisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : 'This command uses shell operators that require approval for safety',
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
      // 不安全的复合命令不提供建议规则，因为无法为其自动生成允许规则
    }
  }

  // 2. 获取管道段列表（ParsedCommand 保留了原始引号信息）
  const pipeSegments = parsed.getPipeSegments()

  // 若只有一段（无管道符），本函数不处理，由正常流程负责
  if (pipeSegments.length <= 1) {
    return {
      behavior: 'passthrough',
      message: 'No pipes found in command',
    }
  }

  // 3. 对每个管道段并行剥除输出重定向（保留引号）
  const segments = await Promise.all(
    pipeSegments.map(segment => buildSegmentWithoutRedirections(segment)),
  )

  // 将去重定向后的各段交给聚合检查函数统一处理
  return segmentedCommandPermissionResult(
    input,
    segments,
    bashToolHasPermissionFn,
    checkers,
  )
}
