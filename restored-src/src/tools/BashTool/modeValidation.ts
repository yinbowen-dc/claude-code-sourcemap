/**
 * BashTool/modeValidation.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责基于当前权限模式（permission mode）
 * 对 bash 命令进行模式感知的权限判断。
 * 在 BashTool 的权限校验流程中，checkPermissionMode 作为模式特定检查点被调用，
 * 其结果可以短路后续通用权限检查。
 *
 * 【主要功能】
 * - ACCEPT_EDITS_ALLOWED_COMMANDS：acceptEdits 模式下允许自动批准的文件系统命令白名单。
 * - isFilesystemCommand：判断命令是否属于文件系统命令（类型守卫）。
 * - validateCommandForMode（内部）：针对单条子命令检查当前模式是否允许自动批准。
 * - checkPermissionMode（导出）：主入口，拆分复合命令后逐一检查，
 *   返回 allow / ask / passthrough。
 * - getAutoAllowedCommands（导出）：根据模式返回自动允许的命令列表，
 *   供 UI 提示或其他逻辑使用。
 *
 * 【当前支持的模式】
 * - acceptEdits 模式：自动批准文件系统命令（mkdir、touch、rm、rmdir、mv、cp、sed）。
 * - bypassPermissions / dontAsk 模式：由主权限流程处理，此模块直接 passthrough。
 */

import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'

/**
 * ACCEPT_EDITS_ALLOWED_COMMANDS
 *
 * 【说明】
 * 在 acceptEdits 模式下，BashTool 自动批准的文件系统操作命令白名单。
 * 这些命令被视为文件编辑操作的辅助命令（创建目录、移动/复制/删除文件等），
 * 符合 acceptEdits 模式的语义（用户已接受文件编辑，文件系统操作同样自动允许）。
 */
const ACCEPT_EDITS_ALLOWED_COMMANDS = [
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
] as const

type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]

/**
 * isFilesystemCommand
 *
 * 【函数作用】
 * 类型守卫：判断给定字符串是否为 ACCEPT_EDITS_ALLOWED_COMMANDS 中的文件系统命令。
 * 用于 validateCommandForMode 中对基础命令名进行类型安全的白名单检查。
 */
function isFilesystemCommand(command: string): command is FilesystemCommand {
  return ACCEPT_EDITS_ALLOWED_COMMANDS.includes(command as FilesystemCommand)
}

/**
 * validateCommandForMode
 *
 * 【函数作用】
 * 对单条子命令执行模式感知的权限判断。
 * 当前逻辑：
 *   - 若当前模式为 acceptEdits 且命令为白名单文件系统命令，
 *     返回 allow（携带 mode: 'acceptEdits' 决策原因）。
 *   - 否则返回 passthrough，表示此模块不处理该命令。
 *
 * 【参数】
 * @param cmd - 单条子命令字符串（已由 splitCommand_DEPRECATED 拆分）
 * @param toolPermissionContext - 包含当前权限模式的上下文对象
 */
function validateCommandForMode(
  cmd: string,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCmd = cmd.trim()
  const [baseCmd] = trimmedCmd.split(/\s+/)

  if (!baseCmd) {
    return {
      behavior: 'passthrough',
      message: 'Base command not found',
    }
  }

  // In Accept Edits mode, auto-allow filesystem operations
  if (
    toolPermissionContext.mode === 'acceptEdits' &&
    isFilesystemCommand(baseCmd)
  ) {
    return {
      behavior: 'allow',
      updatedInput: { command: cmd },
      decisionReason: {
        type: 'mode',
        mode: 'acceptEdits',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: `No mode-specific handling for '${baseCmd}' in ${toolPermissionContext.mode} mode`,
  }
}

/**
 * checkPermissionMode
 *
 * 【函数作用】
 * 模式感知权限检查的主入口。
 * 检查当前权限模式是否对命令有特殊处理逻辑：
 *   1. bypassPermissions / dontAsk 模式：由主流程处理，直接 passthrough。
 *   2. 其他模式（当前为 acceptEdits）：将复合命令拆分为子命令，
 *      逐一调用 validateCommandForMode，任一命令命中模式规则则返回对应结果。
 *   3. 全部 passthrough 则返回 passthrough。
 *
 * Checks if commands should be handled differently based on the current permission mode
 *
 * This is the main entry point for mode-based permission logic.
 * Currently handles Accept Edits mode for filesystem commands,
 * but designed to be extended for other modes.
 *
 * @param input - The bash command input
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'ask' if the command needs approval in current mode
 * - 'passthrough' if no mode-specific handling applies
 */
export function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // Skip if in bypass mode (handled elsewhere)
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'passthrough',
      message: 'Bypass mode is handled in main permission flow',
    }
  }

  // Skip if in dontAsk mode (handled in main permission flow)
  if (toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'passthrough',
      message: 'DontAsk mode is handled in main permission flow',
    }
  }

  // 将复合命令拆分为独立子命令，逐一进行模式感知检查
  const commands = splitCommand_DEPRECATED(input.command)

  // Check each subcommand
  for (const cmd of commands) {
    const result = validateCommandForMode(cmd, toolPermissionContext)

    // If any command triggers mode-specific behavior, return that result
    if (result.behavior !== 'passthrough') {
      return result
    }
  }

  // No mode-specific handling needed
  return {
    behavior: 'passthrough',
    message: 'No mode-specific validation required',
  }
}

/**
 * getAutoAllowedCommands
 *
 * 【函数作用】
 * 根据当前权限模式返回自动允许的命令列表（只读数组）。
 * 在 acceptEdits 模式下返回 ACCEPT_EDITS_ALLOWED_COMMANDS，
 * 其他模式返回空数组。
 * 供 UI 提示或其他需要展示允许命令列表的逻辑使用。
 */
export function getAutoAllowedCommands(
  mode: ToolPermissionContext['mode'],
): readonly string[] {
  return mode === 'acceptEdits' ? ACCEPT_EDITS_ALLOWED_COMMANDS : []
}
