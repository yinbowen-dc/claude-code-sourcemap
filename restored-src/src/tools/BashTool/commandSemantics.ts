/**
 * BashTool/commandSemantics.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责将 bash 命令的退出码解释为"成功"或"错误"。
 * BashTool 执行命令后，调用 interpretCommandResult 判断命令是否真正出错，
 * 从而决定是否将退出码非零的情况报告给模型。
 *
 * 【主要功能】
 * - 定义 CommandSemantic 类型：将退出码映射为 isError + message。
 * - 维护 COMMAND_SEMANTICS 表：记录各命令的特殊退出码语义（如 grep 返回 1 表示"无匹配"而非错误）。
 * - 导出 interpretCommandResult：根据命令名称查找语义并返回解释结果。
 *
 * Command semantics configuration for interpreting exit codes in different contexts.
 *
 * Many commands use exit codes to convey information other than just success/failure.
 * For example, grep returns 1 when no matches are found, which is not an error condition.
 */

import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'

/**
 * CommandSemantic
 *
 * 【类型说明】
 * 命令语义函数：接收退出码、stdout、stderr，返回该退出码是否代表错误及可选的描述消息。
 */
export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * DEFAULT_SEMANTIC
 *
 * 【说明】
 * 默认语义：仅将退出码 0 视为成功，其余均视为错误。
 * Default semantic: treat only 0 as success, everything else as error
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * COMMAND_SEMANTICS
 *
 * 【说明】
 * 各命令的特殊退出码语义表。
 * 对于语义不符合"0=成功, 非0=失败"通用规则的命令，在此注册专用语义。
 *
 * Command-specific semantics
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=找到匹配, 1=无匹配（非错误）, 2+=真正错误
  // grep: 0=matches found, 1=no matches, 2+=error
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep 与 grep 相同语义
  // ripgrep has same semantics as grep
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find: 0=成功, 1=部分成功（某些目录不可访问）, 2+=错误
  // find: 0=success, 1=partial success (some dirs inaccessible), 2+=error
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff: 0=无差异, 1=存在差异（非错误）, 2+=错误
  // diff: 0=no differences, 1=differences found, 2+=error
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[: 0=条件为真, 1=条件为假（非错误）, 2+=错误
  // test/[: 0=condition true, 1=condition false, 2+=error
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ 是 test 的别名
  // [ is an alias for test
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // wc, head, tail, cat 等：仅在真正错误时失败，使用默认语义
  // wc, head, tail, cat, etc.: these typically only fail on real errors
  // so we use default semantics
])

/**
 * getCommandSemantic
 *
 * 【函数作用】
 * 根据命令字符串（可能是复合命令）提取基础命令名，
 * 从 COMMAND_SEMANTICS 中查找对应语义，未找到则返回默认语义。
 *
 * Get the semantic interpretation for a command
 */
function getCommandSemantic(command: string): CommandSemantic {
  // 提取基础命令名（启发式，不用于安全检查）
  // Extract the base command (first word, handling pipes)
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand)
  return semantic !== undefined ? semantic : DEFAULT_SEMANTIC
}

/**
 * extractBaseCommand
 *
 * 【函数作用】
 * 从单条命令字符串中提取命令名（第一个词）。
 *
 * Extract just the command name (first word) from a single command string.
 */
function extractBaseCommand(command: string): string {
  return command.trim().split(/\s+/)[0] || ''
}

/**
 * heuristicallyExtractBaseCommand
 *
 * 【函数作用】
 * 启发式地从复合命令中提取主命令名（用于确定退出码语义）。
 * 取最后一条子命令（因为管道中最后一个命令决定整体退出码）。
 * 注意：此函数结果不用于安全判断，可能存在误判。
 *
 * Extract the primary command from a complex command line;
 * May get it super wrong - don't depend on this for security
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitCommand_DEPRECATED(command)

  // 取最后一条子命令——它决定整体退出码
  // Take the last command as that's what determines the exit code
  const lastCommand = segments[segments.length - 1] || command

  return extractBaseCommand(lastCommand)
}

/**
 * interpretCommandResult
 *
 * 【函数作用】
 * 根据命令的语义规则解释命令执行结果。
 * 调用方将 command、exitCode、stdout、stderr 传入，
 * 获取 isError 和可选的描述 message。
 *
 * Interpret command result based on semantic rules
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const semantic = getCommandSemantic(command)
  const result = semantic(exitCode, stdout, stderr)

  return {
    isError: result.isError,
    message: result.message,
  }
}
