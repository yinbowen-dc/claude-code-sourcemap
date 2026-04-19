/**
 * /add-dir 命令的核心校验逻辑模块。
 *
 * 在 Claude Code 的权限与文件系统管理流程中，此文件负责在用户添加新工作目录前
 * 执行完整的合法性验证：路径存在性检查、类型检查（是否为目录）、以及是否已被现有
 * 工作目录覆盖的重复性检查。验证通过后，由上层命令将路径写入权限上下文。
 *
 * 对应命令：/add-dir <path>
 */
import chalk from 'chalk'
import { stat } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import { getErrnoCode } from '../../utils/errors.js'
import { expandPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  pathInWorkingPath,
} from '../../utils/permissions/filesystem.js'

/**
 * 添加目录操作的结果类型联合。
 * 每种情况均携带足够的上下文信息，供 addDirHelpMessage 生成友好的用户提示。
 */
export type AddDirectoryResult =
  | {
      resultType: 'success'
      absolutePath: string
    }
  | {
      resultType: 'emptyPath'
    }
  | {
      resultType: 'pathNotFound' | 'notADirectory'
      directoryPath: string
      absolutePath: string
    }
  | {
      resultType: 'alreadyInWorkingDirectory'
      directoryPath: string
      workingDir: string
    }

/**
 * 验证指定路径是否可被添加为新的工作目录。
 *
 * 校验流程：
 * 1. 检查路径不为空
 * 2. 展开 ~ 并规范化路径（消除尾部斜杠以统一存储键，避免 /foo 与 /foo/ 被视为两个不同路径）
 * 3. 通过单次 stat 系统调用判断路径是否存在且为目录；对权限不足错误也视作"未找到"
 * 4. 检查该路径是否已包含在某个现有工作目录内，避免冗余授权
 *
 * @param directoryPath 用户输入的原始路径字符串
 * @param permissionContext 当前工具权限上下文，包含已注册的工作目录列表
 * @returns 描述校验结果的联合类型对象
 */
export async function validateDirectoryForWorkspace(
  directoryPath: string,
  permissionContext: ToolPermissionContext,
): Promise<AddDirectoryResult> {
  // 空路径快速返回，避免后续无意义的文件系统操作
  if (!directoryPath) {
    return {
      resultType: 'emptyPath',
    }
  }

  // resolve() strips the trailing slash expandPath can leave on absolute
  // inputs, so /foo and /foo/ map to the same storage key (CC-33).
  // expandPath 处理 ~ 符号，resolve 规范化路径并去除尾部斜杠
  const absolutePath = resolve(expandPath(directoryPath))

  // Check if path exists and is a directory (single syscall)
  try {
    const stats = await stat(absolutePath)
    // stat 成功但不是目录（如普通文件），返回 notADirectory
    if (!stats.isDirectory()) {
      return {
        resultType: 'notADirectory',
        directoryPath,
        absolutePath,
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // Match prior existsSync() semantics: treat any of these as "not found"
    // rather than re-throwing. EACCES/EPERM in particular must not crash
    // startup when a settings-configured additional directory is inaccessible.
    // ENOENT：路径不存在；ENOTDIR：路径前缀非目录；EACCES/EPERM：权限问题，均视为"未找到"
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'EPERM'
    ) {
      return {
        resultType: 'pathNotFound',
        directoryPath,
        absolutePath,
      }
    }
    // 其他未预期的系统错误向上抛出
    throw e
  }

  // Get current permission context
  // 获取当前所有已注册工作目录（包括主目录与附加目录）
  const currentWorkingDirs = allWorkingDirectories(permissionContext)

  // Check if already within an existing working directory
  // 遍历已有工作目录，若新路径已被包含则提示用户无需重复添加
  for (const workingDir of currentWorkingDirs) {
    if (pathInWorkingPath(absolutePath, workingDir)) {
      return {
        resultType: 'alreadyInWorkingDirectory',
        directoryPath,
        workingDir,
      }
    }
  }

  // 所有检查通过，返回成功结果及规范化后的绝对路径
  return {
    resultType: 'success',
    absolutePath,
  }
}

/**
 * 根据目录校验结果生成用户可读的提示消息。
 *
 * 将 AddDirectoryResult 各枚举分支映射到人类友好的文本：
 * - 成功时告知已添加的绝对路径
 * - 失败时给出具体原因，对"非目录"情况还会提示父目录作为备选
 *
 * @param result validateDirectoryForWorkspace 的返回值
 * @returns 带有 chalk 颜色标记的提示字符串
 */
export function addDirHelpMessage(result: AddDirectoryResult): string {
  switch (result.resultType) {
    case 'emptyPath':
      return 'Please provide a directory path.'
    case 'pathNotFound':
      // 使用 chalk.bold 高亮显示路径，增强可读性
      return `Path ${chalk.bold(result.absolutePath)} was not found.`
    case 'notADirectory': {
      // 推断父目录，引导用户改用父目录
      const parentDir = dirname(result.absolutePath)
      return `${chalk.bold(result.directoryPath)} is not a directory. Did you mean to add the parent directory ${chalk.bold(parentDir)}?`
    }
    case 'alreadyInWorkingDirectory':
      // 提示用户该路径已被现有工作目录覆盖，无需重复添加
      return `${chalk.bold(result.directoryPath)} is already accessible within the existing working directory ${chalk.bold(result.workingDir)}.`
    case 'success':
      return `Added ${chalk.bold(result.absolutePath)} as a working directory.`
  }
}
