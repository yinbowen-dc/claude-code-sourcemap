/**
 * BashTool/pathValidation.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责对 bash 命令中涉及文件系统路径的操作进行权限校验。
 * 在 BashTool 主权限流程中，checkPathConstraints 作为路径约束检查入口被调用，
 * 确保命令只能访问允许的工作目录集合中的路径。
 *
 * 【主要功能】
 * - PathCommand 类型：支持路径校验的命令枚举（cd、ls、find、rm、cat、grep 等40+命令）。
 * - PATH_EXTRACTORS：命令 → 路径提取函数映射，负责从各命令的 args 中提取出路径字符串。
 * - COMMAND_OPERATION_TYPE：命令 → 操作类型（read/write/create）映射，用于权限判断。
 * - filterOutFlags：提取非 flag 位置参数，正确处理 `--` 结束符（防止 `-/../etc` 路径绕过）。
 * - parsePatternCommand：解析 grep/rg 风格的命令（模式 + 路径）。
 * - checkDangerousRemovalPaths（内部）：对 rm/rmdir 命令检测危险路径（如 /），
 *   即使存在允许规则也强制要求用户批准。
 * - validateCommandPaths（内部）：单命令路径验证核心，包括命令特定 validator、
 *   cd 复合命令写操作拦截、逐路径 validatePath 调用。
 * - createPathChecker：创建命令特定的路径检查器闭包，集成危险路径检测和权限建议。
 * - validateSinglePathCommand（内部）：解析单条子命令字符串，提取路径，运行路径检查。
 * - validateSinglePathCommandArgv（内部）：AST argv 直接路径检查版本（避免 shell-quote 漏洞）。
 * - validateOutputRedirections（内部）：验证输出重定向目标路径的安全性。
 * - astRedirectsToOutputRedirections（内部）：将 AST Redirect[] 转换为重定向校验格式。
 * - checkPathConstraints（导出）：主入口，整合进程替换检测、重定向校验、命令路径校验。
 * - stripWrappersFromArgv（导出）：从 AST argv 中剥除安全包装命令（timeout/nice/stdbuf/env/nohup/time）。
 * - 辅助函数：skipTimeoutFlags、skipStdbufFlags、skipEnvFlags（用于 stripWrappersFromArgv）。
 */
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Redirect, SimpleCommand } from '../../utils/bash/ast.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { allWorkingDirectories } from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  expandTilde,
  type FileOperationType,
  formatDirectoryList,
  isDangerousRemovalPath,
  validatePath,
} from '../../utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

/**
 * PathCommand
 *
 * 【类型说明】
 * 支持路径约束校验的 bash 命令枚举类型。
 * 只有列于此处的命令才会触发 PATH_EXTRACTORS 中对应的路径提取和 validatePath 校验；
 * 未列出的命令在路径校验层不做路径级别的 allow/deny 判断。
 */
export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

/**
 * checkDangerousRemovalPaths
 *
 * 【函数作用】
 * 对 rm/rmdir 命令检测是否操作了危险路径（如 `/`、`/home`、`/usr` 等系统关键目录）。
 * 即使存在用户配置的允许规则，危险路径仍强制要求用户手动批准（不可被规则自动通过），
 * 防止因允许规则误配置导致灾难性数据丢失（如 `rm -rf /`）。
 *
 * 注意：路径在验证时不解析符号链接（/tmp 在 macOS 上是 /private/tmp 的符号链接，
 * 但 /tmp 本身也应被视为危险路径，不解析链接可以正确拦截此类情况）。
 *
 * Checks if an rm/rmdir command targets dangerous paths that should always
 * require explicit user approval, even if allowlist rules exist.
 */
function checkDangerousRemovalPaths(
  command: 'rm' | 'rmdir',
  args: string[],
  cwd: string,
): PermissionResult {
  // Extract paths using the existing path extractor
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)

  for (const path of paths) {
    // Expand tilde and resolve to absolute path
    // NOTE: We check the path WITHOUT resolving symlinks, because dangerous paths
    // like /tmp should be caught even though /tmp is a symlink to /private/tmp on macOS
    const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)

    // Check if this is a dangerous path (using the non-symlink-resolved path)
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: 'ask',
        message: `Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: {
          type: 'other',
          reason: `Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        // Don't provide suggestions - we don't want to encourage saving dangerous commands
        suggestions: [],
      }
    }
  }

  // No dangerous paths found
  return {
    behavior: 'passthrough',
    message: `No dangerous removals detected for ${command} command`,
  }
}

/**
 * filterOutFlags
 *
 * 【函数作用】
 * 从命令 args 中提取非 flag 的位置参数（路径），正确处理 POSIX `--` 结束符。
 *
 * 【安全说明】
 * 大多数命令（rm、cat、touch 等）在遇到 `--` 后将所有后续参数视为位置参数，
 * 即使它们以 `-` 开头。朴素的 `!arg.startsWith('-')` 过滤会丢弃 `--` 后的路径参数，
 * 导致 `rm -- -/../.claude/settings.local.json` 这类攻击路径被静默跳过（验证器看到零个路径）。
 * 正确处理 `--` 后，此类路径会被提取并校验（由 isClaudeConfigFilePath / pathInAllowedWorkingPath 拦截）。
 *
 * SECURITY: Extract positional (non-flag) arguments, correctly handling the
 * POSIX `--` end-of-options delimiter.
 */
function filterOutFlags(args: string[]): string[] {
  const result: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

/**
 * parsePatternCommand
 *
 * 【函数作用】
 * 解析 grep/rg 风格的命令参数（格式：[flags] pattern [files...]），
 * 提取其中的文件路径参数。
 * 正确处理：
 *   - `-e`/`--regexp`/`-f`/`--file` 等带模式的 flag（标记模式已找到）
 *   - 需要参数的 flag（flagsWithArgs，跳过其参数）
 *   - `--` 结束符（其后所有参数均为路径）
 *
 * @param args - 命令参数列表（不含命令名）
 * @param flagsWithArgs - 需要跳过后续参数的 flag 集合
 * @param defaults - 无路径时的默认值（如 rg 默认为 ['.']）
 */
// Helper: Parse grep/rg style commands (pattern then paths)
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = []
  let patternFound = false
  // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
  // positional regardless of leading `-`. See filterOutFlags() doc comment.
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // Pattern flags mark that we've found the pattern
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // Skip next arg if flag needs it
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // First non-flag is pattern, rest are paths
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * PATH_EXTRACTORS
 *
 * 【说明】
 * 命令 → 路径提取函数的映射表。
 * 对每种 PathCommand，定义如何从其 args 中提取需要进行路径校验的字符串列表。
 *
 * 各命令的特殊处理说明：
 * - cd：无参数时返回 home 目录，否则将所有参数拼接为单一路径（含空格路径）。
 * - ls：过滤 flag 后若无路径则默认为 `.`。
 * - find：收集全局选项（-H/-L/-P）之前的非 flag 参数作为搜索起点，同时提取 -newer/-samefile 等的路径参数；
 *         支持 `--` 后将所有参数视为路径（防止 `find -- -/../../etc` 绕过）。
 * - rm/rmdir/mv/cp/cat/… 简单命令：直接过滤 flag（filterOutFlags）。
 * - tr：跳过字符集参数（-d 时跳过 1 个，否则跳过 2 个）。
 * - grep/rg：parsePatternCommand 解析模式+路径。
 * - sed：跳过 -e/-f 表达式/脚本 flag，剩余为文件路径；-f 的脚本文件本身也加入路径验证。
 * - jq：跳过过滤器，后续为文件路径；无文件则读 stdin（返回空数组）。
 * - git：仅 `git diff --no-index` 需要路径校验（其他 git 子命令受 git 自身安全模型约束）。
 *
 * Extracts paths from command arguments for different path commands.
 * Each command has specific logic for how it handles paths and flags.
 */
export const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
> = {
  // cd: special case - all args form one path
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls: filter flags, default to current dir
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find: collect paths until hitting a real flag, also check path-taking flags
  // SECURITY: `find -- -path` makes `-path` a starting point (not a predicate).
  // GNU find supports `--` to allow search roots starting with `-`. After `--`,
  // we conservatively collect all remaining args as paths to validate. This
  // over-includes predicates like `-name foo`, but find is a read-only op and
  // predicates resolve to paths within cwd (allowed), so no false blocks for
  // legitimate use. The over-inclusion ensures attack paths like
  // `find -- -/../../etc` are caught.
  find: args => {
    const paths: string[] = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags
      if (arg.startsWith('-')) {
        // Global options don't stop collection
        if (['-H', '-L', '-P'].includes(arg)) continue

        // Mark that we've seen a non-global flag
        foundNonGlobalFlag = true

        // Check if this flag takes a path argument
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // Skip the path we just processed
          }
        }
        continue
      }

      // Only collect non-flag arguments before first non-global flag
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // All simple commands: just filter out flags
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr: special case - skip character sets
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // Skip SET1 or SET1+SET2
  },

  // grep: pattern then paths, defaults to stdin
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // Special: if -r/-R flag present and no paths, use current dir
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg: pattern then paths, defaults to current dir
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed: processes files in-place or reads from stdin
  sed: args => {
    const paths: string[] = []
    let skipNext = false
    let scriptFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags (only before `--`)
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f flag: next arg is a script file that needs validation
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // Add script file to paths for validation
            skipNext = true
          }
          scriptFound = true
        }
        // -e flag: next arg is expression, not a file
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // Combined flags like -ie or -nf
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // First non-flag is the script (if not already found via -e/-f)
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // Rest are file paths
      paths.push(arg)
    }

    return paths
  },

  // jq: filter then file paths (similar to grep)
  // The jq command structure is: jq [flags] filter [files...]
  // If no files are provided, jq reads from stdin
  jq: args => {
    const paths: string[] = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // Pattern flags mark that we've found the filter
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // Skip next arg if flag needs it
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // First non-flag is filter, rest are file paths
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // If no file paths, jq reads from stdin (no paths to validate)
    return paths
  },

  // git: handle subcommands that access arbitrary files outside the repository
  git: args => {
    // git diff --no-index is special - it explicitly compares files outside git's control
    // This flag allows git diff to compare any two files on the filesystem, not just
    // files within the repository, which is why it needs path validation
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // SECURITY: git diff --no-index accepts `--` before file paths.
        // Use filterOutFlags which handles `--` correctly instead of naive
        // startsWith('-') filtering, to catch paths like `-/../etc/passwd`.
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index expects exactly 2 paths
      }
    }
    // Other git commands (add, rm, mv, show, etc.) operate within the repository context
    // and are already constrained by git's own security model, so they don't need
    // additional path validation
    return []
  },
}

/**
 * SUPPORTED_PATH_COMMANDS
 *
 * 【说明】
 * 所有需要进行路径校验的命令名称列表，直接从 PATH_EXTRACTORS 键集动态生成，
 * 保证两者始终同步，避免手动维护遗漏。
 * 在 validateSinglePathCommand / validateSinglePathCommandArgv 中作为白名单判断
 * 命令是否需要进入路径校验逻辑。
 */
const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[]

/**
 * ACTION_VERBS
 *
 * 【说明】
 * 为每种 PathCommand 提供人类可读的操作描述动词短语，
 * 用于在路径被拒绝时构造面向用户的错误消息。
 * 格式："`command` in '`path`' was blocked. Claude Code may only `ACTION_VERBS[command]` the allowed directories."
 * 例如：mkdir → "create directories in"，rm → "remove files from"。
 */
const ACTION_VERBS: Record<PathCommand, string> = {
  cd: 'change directories to',
  ls: 'list files in',
  find: 'search files in',
  mkdir: 'create directories in',
  touch: 'create or modify files in',
  rm: 'remove files from',
  rmdir: 'remove directories from',
  mv: 'move files to/from',
  cp: 'copy files to/from',
  cat: 'concatenate files from',
  head: 'read the beginning of files from',
  tail: 'read the end of files from',
  sort: 'sort contents of files from',
  uniq: 'filter duplicate lines from files in',
  wc: 'count lines/words/bytes in files from',
  cut: 'extract columns from files in',
  paste: 'merge files from',
  column: 'format files from',
  tr: 'transform text from files in',
  file: 'examine file types in',
  stat: 'read file stats from',
  diff: 'compare files from',
  awk: 'process text from files in',
  strings: 'extract strings from files in',
  hexdump: 'display hex dump of files from',
  od: 'display octal dump of files from',
  base64: 'encode/decode files from',
  nl: 'number lines in files from',
  grep: 'search for patterns in files from',
  rg: 'search for patterns in files from',
  sed: 'edit files in',
  git: 'access files with git from',
  jq: 'process JSON from files in',
  sha256sum: 'compute SHA-256 checksums for files in',
  sha1sum: 'compute SHA-1 checksums for files in',
  md5sum: 'compute MD5 checksums for files in',
}

/**
 * COMMAND_OPERATION_TYPE
 *
 * 【说明】
 * 将每种 PathCommand 映射到其对应的文件操作类型（read / write / create）。
 * 该映射决定在路径校验中如何判断权限：
 *   - read：仅需读取权限（cat、ls、grep 等）
 *   - write：需要写入权限（rm、rmdir、mv、cp、sed 等）
 *   - create：需要创建权限（mkdir、touch 等，以及输出重定向）
 * 同时影响 createPathChecker 中权限建议的内容（读操作建议 ReadRule，写/创建操作建议 addDirectories）。
 */
export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

/**
 * COMMAND_VALIDATOR
 *
 * 【说明】
 * 命令级前置校验器映射表（可选）。
 * 仅部分命令需要前置校验，目前只有 mv 和 cp：
 *   - 当 mv/cp 带有任何以 `-` 开头的 flag 时返回 false（拒绝），
 *     因为某些 flag（如 --target-directory=PATH）会改变路径提取语义，
 *     可能导致路径校验被绕过。
 *   - 保守策略：所有带 flag 的 mv/cp 统一要求人工批准，避免路径注入风险。
 *
 * Command-specific validators that run before path validation.
 * Returns true if the command is valid, false if it should be rejected.
 * Used to block commands with flags that could bypass path validation.
 */
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  mv: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
  cp: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
}

/**
 * validateCommandPaths
 *
 * 【函数作用】
 * 对单条路径命令执行完整的路径权限校验，是路径校验的核心执行函数。
 *
 * 【执行流程】
 *   1. 通过 PATH_EXTRACTORS 提取命令参数中的路径列表。
 *   2. 若命令有前置校验器（COMMAND_VALIDATOR），先执行前置校验；
 *      mv/cp 带 flag 时直接返回 ask（避免 --target-directory 等绕过路径提取）。
 *   3. 若复合命令含 cd 且当前命令为写/创建操作，返回 ask 要求人工批准，
 *      防止 `cd .claude/ && mv test.txt settings.json` 类路径解析绕过攻击。
 *   4. 对每条提取的路径调用 validatePath，任一路径不在允许范围内则：
 *      - deny 规则命中 → 返回 deny
 *      - 其他 → 返回 ask，附带 blockedPath
 *   5. 全部通过 → 返回 passthrough。
 *
 * @param command - 要检查的路径命令名称
 * @param args - 命令参数列表（不含命令名本身）
 * @param cwd - 当前工作目录
 * @param toolPermissionContext - 包含允许路径集合的权限上下文
 * @param compoundCommandHasCd - 复合命令中是否存在 cd 子命令
 * @param operationTypeOverride - 可选，覆盖默认的 COMMAND_OPERATION_TYPE 映射
 */
function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // SECURITY: Check command-specific validators (e.g., to block flags that could bypass path validation)
  // Some commands like mv/cp have flags (--target-directory=PATH) that can bypass path extraction,
  // so we block ALL flags for these commands to ensure security.
  const validator = COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: `${command} with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate ${command} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
      decisionReason: {
        type: 'other',
        reason: `${command} command with flags requires manual approval`,
      },
    }
  }

  // SECURITY: Block write operations in compound commands containing 'cd'
  // This prevents bypassing path safety checks via directory changes before operations.
  // Example attack: cd .claude/ && mv test.txt settings.json
  // This would bypass the check for .claude/settings.json because paths are resolved
  // relative to the original CWD, not accounting for the cd's effect.
  //
  // ALTERNATIVE APPROACH: Instead of blocking all writes with cd, we could track the
  // effective CWD through the command chain (e.g., after "cd .claude/", subsequent
  // commands would be validated with CWD=".claude/"). This would be more permissive
  // but requires careful handling of:
  // - Relative paths (cd ../foo)
  // - Special cd targets (cd ~, cd -, cd with no args)
  // - Multiple cd commands in sequence
  // - Error cases where cd target cannot be determined
  // For now, we take the conservative approach of requiring manual approval.
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass',
      },
    }
  }

  for (const path of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      path,
      cwd,
      toolPermissionContext,
      operationType,
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // Use security check's custom reason if available (type: 'other' or 'safetyCheck')
      // Otherwise use the standard "was blocked" message
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : `${command} in '${resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`

      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
      }
    }
  }

  // All paths are valid - return passthrough
  return {
    behavior: 'passthrough',
    message: `Path validation passed for ${command} command`,
  }
}

/**
 * createPathChecker
 *
 * 【函数作用】
 * 工厂函数：为指定命令创建一个路径校验闭包（checker）。
 * 返回的 checker 签名与 validateCommandPaths 类似，但额外执行：
 *   1. 先调用 validateCommandPaths（含 deny 规则检查）。
 *   2. 若结果为 deny，直接返回，不被后续逻辑覆盖。
 *   3. 对 rm/rmdir 还需额外调用 checkDangerousRemovalPaths，
 *      阻止 `rm -rf /`、`rm -rf ~` 等危险路径（优先于通用拒绝消息）。
 *   4. 对 ask 结果，附加 suggestions（建议操作）：
 *      - 读操作 → 建议添加 ReadRule（只读白名单规则）
 *      - 写/创建操作 → 建议添加目录 + 切换 acceptEdits 模式
 *
 * @param command - 目标路径命令
 * @param operationTypeOverride - 可选，覆盖 COMMAND_OPERATION_TYPE[command]
 * @returns 可复用的路径校验函数（(args, cwd, context, compoundCommandHasCd) => PermissionResult）
 */
export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    // First check normal path validation (which includes explicit deny rules)
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    )

    // If explicitly denied, respect that (don't override with dangerous path message)
    if (result.behavior === 'deny') {
      return result
    }

    // Check for dangerous removal paths AFTER explicit deny rules but BEFORE other results
    // This ensures the check runs even if the user has allowlist rules or if glob patterns
    // were rejected, but respects explicit deny rules. Dangerous patterns get a specific
    // error message that overrides generic glob pattern rejection messages.
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // If it's a passthrough, return it directly
    if (result.behavior === 'passthrough') {
      return result
    }

    // If it's an ask decision, add suggestions based on the operation type
    if (result.behavior === 'ask') {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const suggestions: PermissionUpdate[] = []

      // Only suggest adding directory/rules if we have a blocked path
      if (result.blockedPath) {
        if (operationType === 'read') {
          // For read operations, suggest a Read rule for the directory (only if it exists)
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // For write/create operations, suggest adding the directory
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // For write operations, also suggest enabling accept-edits mode
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      result.suggestions = suggestions
    }

    // Return the decision directly
    return result
  }
}

/**
 * parseCommandArguments
 *
 * 【函数作用】
 * 使用 shell-quote 将命令字符串解析为参数数组，将 glob 对象转换为字符串。
 *
 * 【说明】
 * shell-quote 会将 *.txt 等 glob 模式解析为 `{ op: 'glob', pattern: '...' }` 对象，
 * 而路径校验需要字符串形式，因此需要在此统一转换。
 * 若解析失败（malformed shell 语法），返回空数组，让调用方安全跳过。
 *
 * 【已知限制】
 * shell-quote 存在单引号反斜杠 bug（参见 validateSinglePathCommandArgv 注释），
 * 在含有 `'\''` 等结构时可能静默返回 []，导致路径校验被跳过。
 * AST 路径（validateSinglePathCommandArgv）通过直接使用 tree-sitter argv 绕过该问题。
 *
 * Parses command arguments using shell-quote, converting glob objects to strings.
 * This is necessary because shell-quote parses patterns like *.txt as glob objects,
 * but we need them as strings for path validation.
 */
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, env => `$${env}`)
  if (!parseResult.success) {
    // Malformed shell syntax, return empty array
    return []
  }
  const parsed = parseResult.tokens
  const extractedArgs: string[] = []

  for (const arg of parsed) {
    if (typeof arg === 'string') {
      // Include empty strings - they're valid arguments (e.g., grep "" /tmp/t)
      extractedArgs.push(arg)
    } else if (
      typeof arg === 'object' &&
      arg !== null &&
      'op' in arg &&
      arg.op === 'glob' &&
      'pattern' in arg
    ) {
      // shell-quote parses glob patterns as objects, but we need them as strings for validation
      extractedArgs.push(String(arg.pattern))
    }
  }

  return extractedArgs
}

/**
 * validateSinglePathCommand
 *
 * 【函数作用】
 * 基于 shell-quote 的单条命令路径校验（传统路径）。
 * 是 checkPathConstraints 在无 AST 时调用的校验函数。
 *
 * 【执行流程】
 *   1. 调用 stripSafeWrappers 剥除 timeout/nohup/nice 等包装命令，
 *      防止 `timeout 10 rm -rf /` 被误判为 timeout 命令而跳过路径检查。
 *   2. 调用 parseCommandArguments 解析参数（shell-quote 路径）。
 *   3. 若基础命令不在 SUPPORTED_PATH_COMMANDS 中，返回 passthrough。
 *   4. 对 sed 命令额外判断是否为只读模式（sedCommandIsAllowedByAllowlist），
 *      只读 sed 的文件参数视为读操作而非写操作。
 *   5. 调用 createPathChecker 生成校验器并执行路径校验。
 *
 * Validates a single command for path constraints and shell safety.
 *
 * This function:
 * 1. Parses the command arguments
 * 2. Checks if it's a path command (cd, ls, find)
 * 3. Validates for shell injection patterns
 * 4. Validates all paths are within allowed directories
 *
 * @param cmd - The command string to validate
 * @param cwd - Current working directory
 * @param toolPermissionContext - Context containing allowed directories
 * @param compoundCommandHasCd - Whether the full compound command contains a cd
 * @returns PermissionResult - 'passthrough' if not a path command, otherwise validation result
 */
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // SECURITY: Strip wrapper commands (timeout, nice, nohup, time) before extracting
  // the base command. Without this, dangerous commands wrapped with these utilities
  // would bypass path validation since the wrapper command (e.g., 'timeout') would
  // be checked instead of the actual command (e.g., 'rm').
  // Example: 'timeout 10 rm -rf /' would otherwise see 'timeout' as the base command.
  const strippedCmd = stripSafeWrappers(cmd)

  // Parse command into arguments, handling quotes and globs
  const extractedArgs = parseCommandArguments(strippedCmd)
  if (extractedArgs.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }

  // Check if this is a path command we need to validate
  const [baseCmd, ...args] = extractedArgs
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }

  // For read-only sed commands (e.g., sed -n '1,10p' file.txt),
  // validate file paths as read operations instead of write operations.
  // sed is normally classified as 'write' for path validation, but when the
  // command is purely reading (line printing with -n), file args are read-only.
  const operationTypeOverride =
    baseCmd === 'sed' && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ('read' as FileOperationType)
      : undefined

  // Validate all paths are within allowed directories
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * validateSinglePathCommandArgv
 *
 * 【函数作用】
 * 基于 AST 派生 argv 的单条命令路径校验（AST 路径）。
 * 与 validateSinglePathCommand 功能相同，但直接使用 tree-sitter 解析出的 argv，
 * 规避 shell-quote 单引号反斜杠 bug 导致 parseCommandArguments 静默返回 [] 而跳过路径校验的问题。
 *
 * 【与 validateSinglePathCommand 的区别】
 *   - 输入为 SimpleCommand（AST 节点），而非原始命令字符串。
 *   - 调用 stripWrappersFromArgv（argv 级别包装命令剥除），而非 stripSafeWrappers（文本级别）。
 *   - 对 sed 的只读检查仍需基于文本（cmd.text）进行，并先剥除包装命令。
 *
 * Like validateSinglePathCommand but operates on AST-derived argv directly
 * instead of re-parsing the command string with shell-quote. Avoids the
 * shell-quote single-quote backslash bug that causes parseCommandArguments
 * to silently return [] and skip path validation.
 */
function validateSinglePathCommandArgv(
  cmd: SimpleCommand,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(cmd.argv)
  if (argv.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }
  const [baseCmd, ...args] = argv
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }
  // sed read-only override: use .text for the allowlist check since
  // sedCommandIsAllowedByAllowlist takes a string. argv is already
  // wrapper-stripped but .text is raw tree-sitter span (includes
  // `timeout 5 ` prefix), so strip here too.
  const operationTypeOverride =
    baseCmd === 'sed' &&
    sedCommandIsAllowedByAllowlist(stripSafeWrappers(cmd.text))
      ? ('read' as FileOperationType)
      : undefined
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * validateOutputRedirections
 *
 * 【函数作用】
 * 校验输出重定向目标路径（`>` 和 `>>`）是否在允许范围内。
 *
 * 【安全说明】
 *   - 若复合命令含 cd 且存在重定向，返回 ask，防止以下攻击：
 *     `cd .claude/ && echo "malicious" > settings.json`
 *     此时路径相对原始 cwd 校验，但写入实际发生在 cd 后的目录中。
 *   - `/dev/null` 始终被允许（丢弃输出，无安全风险）。
 *   - 非 /dev/null 的重定向目标：调用 validatePath 校验；
 *     deny 规则命中 → 返回 deny；
 *     其他不允许 → 返回 ask，附 suggestions（addDirectories）。
 *
 * @param redirections - 待校验的输出重定向列表（target + operator）
 * @param cwd - 当前工作目录
 * @param toolPermissionContext - 权限上下文
 * @param compoundCommandHasCd - 复合命令中是否含 cd
 */
function validateOutputRedirections(
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // SECURITY: Block output redirections in compound commands containing 'cd'
  // This prevents bypassing path safety checks via directory changes before redirections.
  // Example attack: cd .claude/ && echo "malicious" > settings.json
  // The redirection target would be validated relative to the original CWD, but the
  // actual write happens in the changed directory after 'cd' executes.
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: 'ask',
      message: `Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass',
      },
    }
  }
  for (const { target } of redirections) {
    // /dev/null is always safe - it discards output
    if (target === '/dev/null') {
      continue
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      'create', // Treat > and >> as create operations
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // Use security check's custom reason if available (type: 'other' or 'safetyCheck')
      // Otherwise use the standard message for deny rules or working directory restrictions
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : decisionReason?.type === 'rule'
            ? `Output redirection to '${resolvedPath}' was blocked by a deny rule.`
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

      // If denied by a deny rule, return 'deny' behavior
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: 'addDirectories',
            directories: [getDirectoryForPath(resolvedPath)],
            destination: 'session',
          },
        ],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No unsafe redirections found',
  }
}

/**
 * checkPathConstraints
 *
 * 【函数作用】
 * 路径约束检查的主入口，是 BashTool 权限校验流程中路径安全检查的核心函数。
 *
 * 【执行流程】
 *   1. 进程替换检测（非 AST 路径）：命令中含 `>(...)`/`<(...)` 时要求人工批准，
 *      防止通过进程替换将写入目标隐藏在重定向检测之外。
 *   2. 输出重定向提取：AST 路径使用 astRedirectsToOutputRedirections，
 *      传统路径使用 extractOutputRedirections（shell-quote）。
 *   3. 若检测到变量展开语法（$VAR / %VAR%）的危险重定向，返回 ask。
 *   4. 调用 validateOutputRedirections 校验所有输出重定向目标。
 *   5. 遍历子命令：
 *      - AST 路径：使用 validateSinglePathCommandArgv（避免 shell-quote 单引号 bug）。
 *      - 传统路径：使用 validateSinglePathCommand（shell-quote 解析）。
 *   6. 全部通过 → 返回 passthrough。
 *
 * 【设计原则】
 * 始终返回 passthrough，让其他权限检查模块继续运行，
 * 只在发现路径约束违规时才返回 ask/deny 短路后续检查。
 *
 * @returns
 * - 'ask' if any path command or redirection tries to access outside allowed directories
 * - 'passthrough' if no path commands were found or if all are within allowed directories
 */
export function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  // SECURITY: Process substitution >(cmd) can execute commands that write to files
  // without those files appearing as redirect targets. For example:
  //   echo secret > >(tee .git/config)
  // The tee command writes to .git/config but it's not detected as a redirect.
  // Require explicit approval for any command containing process substitution.
  // Skip on AST path — process_substitution is in DANGEROUS_TYPES and
  // already returned too-complex before reaching here.
  if (!astCommands && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: 'ask',
      message:
        'Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Process substitution requires manual approval',
      },
    }
  }

  // SECURITY: When AST-derived redirects are available, use them directly
  // instead of re-parsing with shell-quote. shell-quote has a known
  // single-quote backslash bug that silently merges redirect operators into
  // garbled tokens on a successful parse (not a parse failure, so the
  // fail-closed guard doesn't help). The AST already resolved targets
  // correctly and checkSemantics validated them.
  const { redirections, hasDangerousRedirection } = astRedirects
    ? astRedirectsToOutputRedirections(astRedirects)
    : extractOutputRedirections(input.command)

  // SECURITY: If we found a redirection operator with a target containing shell expansion
  // syntax ($VAR or %VAR%), require manual approval since the target can't be safely validated.
  if (hasDangerousRedirection) {
    return {
      behavior: 'ask',
      message: 'Shell expansion syntax in paths requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  if (redirectionResult.behavior !== 'passthrough') {
    return redirectionResult
  }

  // SECURITY: When AST-derived commands are available, iterate them with
  // pre-parsed argv instead of re-parsing via splitCommand_DEPRECATED + shell-quote.
  // shell-quote has a single-quote backslash bug that causes
  // parseCommandArguments to silently return [] and skip path validation
  // (isDangerousRemovalPath etc). The AST already resolved argv correctly.
  if (astCommands) {
    for (const cmd of astCommands) {
      const result = validateSinglePathCommandArgv(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  } else {
    const commands = splitCommand_DEPRECATED(input.command)
    for (const cmd of commands) {
      const result = validateSinglePathCommand(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  }

  // Always return passthrough to let other permission checks handle the command
  return {
    behavior: 'passthrough',
    message: 'All path commands validated successfully',
  }
}

/**
 * astRedirectsToOutputRedirections
 *
 * 【函数作用】
 * 将 AST 解析出的 Redirect[] 转换为 validateOutputRedirections 所需的格式。
 *
 * 【转换规则】
 *   - `>`、`>|`、`&>` → operator: '>'（普通覆盖写入）
 *   - `>>`、`&>>` → operator: '>>'（追加写入）
 *   - `>&` + 仅数字目标（如 2>&1、>&10）→ 跳过（fd 复制，非文件写入）
 *   - `>&` + 非数字目标 → operator: '>'（deprecated 文件重定向形式）
 *   - `<`、`<<`、`<&`、`<<<` → 输入重定向，跳过
 *
 * 【安全说明】
 * AST 目标路径已由 tree-sitter 正确解析，checkSemantics 也已验证，
 * 不存在 shell 变量展开风险，因此 hasDangerousRedirection 始终为 false。
 *
 * Convert AST-derived Redirect[] to the format expected by
 * validateOutputRedirections. Filters to output-only redirects (excluding
 * fd duplications like 2>&1) and maps operators to '>' | '>>'.
 */
function astRedirectsToOutputRedirections(redirects: Redirect[]): {
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      case '>&':
        // >&N (digits only) is fd duplication (e.g. 2>&1, >&10), not a file
        // write. >&file is the deprecated form of &>file (redirect to file).
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // input redirects — skip
        break
    }
  }
  // AST targets are fully resolved (no shell expansion) — checkSemantics
  // already validated them. No dangerous redirections are possible.
  return { redirections, hasDangerousRedirection: false }
}

// ───────────────────────────────────────────────────────────────────────────
// Argv-level safe-wrapper stripping (timeout, nice, stdbuf, env, time, nohup)
//
// This is the CANONICAL stripWrappersFromArgv. bashPermissions.ts still
// exports an older narrower copy (timeout/nice-n-N only) that is DEAD CODE
// — no prod consumer — but CANNOT be removed: bashPermissions.ts is right
// at Bun's feature() DCE complexity threshold, and deleting ~80 lines from
// that module silently breaks feature('BASH_CLASSIFIER') evaluation (drops
// every pendingClassifierCheck spread). Verified in PR #21503 round 3:
// baseline classifier tests 30/30 pass, after deletion 22/30 fail. See
// team memory: bun-feature-dce-cliff.md. Hit 3× in PR #21075 + twice in
// #21503. The expanded version lives here (the only prod consumer) instead.
//
// KEEP IN SYNC with:
//   - SAFE_WRAPPER_PATTERNS in bashPermissions.ts (text-based stripSafeWrappers)
//   - the wrapper-stripping loop in checkSemantics (src/utils/bash/ast.ts ~1860)
// If you add a wrapper in either, add it here too. Asymmetry means
// checkSemantics exposes the wrapped command to semantic checks but path
// validation sees the wrapper name → passthrough → wrapped paths never
// validated (PR #21503 review comment 2907319120).
// ───────────────────────────────────────────────────────────────────────────

// SECURITY: allowlist for timeout flag VALUES (signals are TERM/KILL/9,
// durations are 5/5s/10.5). Rejects $ ( ) ` | ; & and newlines that
// previously matched via [^ \t]+ — `timeout -k$(id) 10 ls` must NOT strip.
// 安全白名单：timeout flag 值必须为合法字母数字+少量符号，阻止 $(...) 等注入
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * skipTimeoutFlags
 *
 * 【函数作用】
 * 解析 timeout 命令的 GNU 风格 flag（长/短格式、融合/空格分隔），
 * 返回 DURATION 参数在 argv 数组中的下标；
 * 若 flag 无法识别（可能存在注入风险）则返回 -1（保守拒绝）。
 *
 * 【安全说明】
 * flag 值通过 TIMEOUT_FLAG_VALUE_RE 白名单校验，
 * 防止 `timeout -k$(id) 10 ls` 中的命令注入绕过包装命令剥除。
 * 未知 flag 统一返回 -1，让调用方保留原始 argv（不剥除包装）。
 *
 * Parse timeout's GNU flags (long + short, fused + space-separated) and
 * return the argv index of the DURATION token, or -1 if flags are unparseable.
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // end-of-options marker
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * skipStdbufFlags
 *
 * 【函数作用】
 * 解析 stdbuf 命令的 flag（-i/-o/-e，融合/空格分隔/长等号格式），
 * 返回被包装命令在 argv 中的下标；
 * 未识别 flag 或无 flag（stdbuf 无参数时无效）返回 -1。
 *
 * 【安全说明】
 * 与 checkSemantics（ast.ts）中的 stdbuf 处理保持同步。
 * 未知 flag → 返回 -1（fail closed），保留原始 argv，防止路径校验被跳过。
 *
 * Parse stdbuf's flags (-i/-o/-e in fused/space-separated/long-= forms).
 * Returns argv index of wrapped COMMAND, or -1 if unparseable or no flags
 * consumed (stdbuf without flags is inert). Mirrors checkSemantics (ast.ts).
 */
function skipStdbufFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2
    else if (/^-[ioe]./.test(arg)) i++
    else if (/^--(input|output|error)=/.test(arg)) i++
    else if (arg.startsWith('-'))
      return -1 // unknown flag: fail closed
    else break
  }
  return i > 1 && i < a.length ? i : -1
}

/**
 * skipEnvFlags
 *
 * 【函数作用】
 * 解析 `env` 命令的 VAR=val 赋值参数和安全 flag（-i/-0/-v/-u NAME），
 * 返回被包装命令在 argv 中的下标；
 * 遇到不安全 flag（-S/-C/-P 或未知 flag）时返回 -1（fail closed）。
 *
 * 【安全说明】
 * -S（argv 拆分器）、-C（改变工作目录）、-P（修改 PATH）等 flag 具有安全风险，
 * 统一拒绝（返回 -1），不剥除 env 包装，保留原始 argv。
 * 与 checkSemantics（ast.ts）中的 env 处理保持同步。
 *
 * Parse env's VAR=val and safe flags (-i/-0/-v/-u NAME). Returns argv index
 * of wrapped COMMAND, or -1 if unparseable/no wrapped cmd. Rejects -S (argv
 * splitter), -C/-P (altwd/altpath). Mirrors checkSemantics (ast.ts).
 */
function skipEnvFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) i++
    else if (arg === '-i' || arg === '-0' || arg === '-v') i++
    else if (arg === '-u' && a[i + 1]) i += 2
    else if (arg.startsWith('-'))
      return -1 // -S/-C/-P/unknown: fail closed
    else break
  }
  return i < a.length ? i : -1
}

/**
 * stripWrappersFromArgv
 *
 * 【函数作用】
 * argv 级别的包装命令剥除函数（正规版本）。
 * 迭代剥除 time、nohup、timeout、nice、stdbuf、env 等安全包装命令，
 * 直到 argv 首元素不再是已知包装命令为止（不动点迭代）。
 *
 * 【支持的包装命令及处理方式】
 *   - time / nohup：直接跳过（处理 `-- ` 分隔符）
 *   - timeout：调用 skipTimeoutFlags 解析 flag，再跳过 DURATION 参数；
 *              DURATION 必须匹配 `^\d+(?:\.\d+)?[smhd]?$`，否则返回原始 argv。
 *   - nice：处理三种形式：`nice -n N cmd`、`nice -N cmd`（legacy）、`nice cmd`。
 *   - stdbuf：调用 skipStdbufFlags；flag 未识别时 fail closed。
 *   - env：调用 skipEnvFlags；不安全 flag 时 fail closed。
 *
 * 【规范说明】
 * 这是路径校验模块中 stripWrappersFromArgv 的唯一生产消费者（正规版本）。
 * bashPermissions.ts 中存在旧的窄版本（仅处理 timeout/nice -n N），
 * 由于 Bun DCE 问题无法删除（见注释 bun-feature-dce-cliff.md），但不被生产使用。
 * 需与以下代码保持同步：
 *   - bashPermissions.ts 中的 SAFE_WRAPPER_PATTERNS（文本级 stripSafeWrappers）
 *   - ast.ts checkSemantics 中的包装命令剥除循环（约第 1860 行）
 *
 * Argv-level counterpart to stripSafeWrappers (bashPermissions.ts). Strips
 * wrapper commands from AST-derived argv. Env vars are already separated
 * into SimpleCommand.envVars so no env-var stripping here.
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      // SECURITY (PR #21503 round 3): unrecognized duration (`.5`, `+5`,
      // `inf` — strtod formats GNU timeout accepts) → return a unchanged.
      // Safe because checkSemantics (ast.ts) fails CLOSED on the same input
      // and runs first in bashToolHasPermission, so we never reach here.
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (a[0] === 'nice') {
      // SECURITY (PR #21503 round 3): mirror checkSemantics — handle bare
      // `nice cmd` and legacy `nice -N cmd`, not just `nice -n N cmd`.
      // Previously only `-n N` was stripped: `nice rm /outside` →
      // baseCmd='nice' → passthrough → /outside never path-validated.
      if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2]))
        a = a.slice(a[3] === '--' ? 4 : 3)
      else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === '--' ? 3 : 2)
      else a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'stdbuf') {
      // SECURITY (PR #21503 round 3): PR-WIDENED. Pre-PR, `stdbuf -o0 -eL rm`
      // was rejected by fragment check (old checkSemantics slice(2) left
      // name='-eL'). Post-PR, checkSemantics strips both flags → name='rm'
      // → passes. But stripWrappersFromArgv returned unchanged →
      // baseCmd='stdbuf' → not in SUPPORTED_PATH_COMMANDS → passthrough.
      const i = skipStdbufFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else if (a[0] === 'env') {
      // Same asymmetry: checkSemantics strips env, we didn't.
      const i = skipEnvFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else {
      return a
    }
  }
}
