/**
 * markdownConfigLoader.ts — Markdown 配置文件加载模块
 *
 * 【系统流程定位】
 * 本模块处于 Claude Code 配置层的核心位置，负责从三类来源扫描并加载
 * `.claude/<subdir>/*.md` 格式的配置文件（commands/agents/skills/workflows 等），
 * 为 Claude Code 提供自定义斜杠命令、Agent 定义、技能脚本等可扩展配置。
 *
 * 【主要职责】
 * 1. CLAUDE_CONFIG_DIRECTORIES：枚举所有支持的配置子目录名称（含 TEMPLATES 特性标志门控）；
 * 2. loadMarkdownFilesForSubdir()：主入口，memoize（lodash）加速重复调用，
 *    从 managed / user / project 三类来源并行加载，支持 inode 去重（symlink 场景）；
 * 3. getProjectDirsUpToHome()：从 cwd 向上遍历到 git root（或 home），
 *    收集所有 `.claude/<subdir>` 目录，支持 worktree 回退到主仓库；
 * 4. resolveStopBoundary()：处理嵌套 git 仓库（submodule/vendored clone）场景，
 *    将遍历停止边界扩大到 session 的 git root；
 * 5. findMarkdownFilesNative()：Node.js fs 原生实现，与 ripgrep 互为备选，
 *    bigint inode + 循环检测防止符号链接循环；
 * 6. extractDescriptionFromMarkdown() / parseToolListString() 等解析辅助函数。
 */
import { feature } from 'bun:bundle'
import { statSync } from 'fs'
import { lstat, readdir, readFile, realpath, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import { normalizePathForComparison } from './file.js'
import type { FrontmatterData } from './frontmatterParser.js'
import { parseFrontmatter } from './frontmatterParser.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { parseToolListFromCLI } from './permissions/permissionSetup.js'
import { ripGrep } from './ripgrep.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from './settings/constants.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { isRestrictedToPluginOnly } from './settings/pluginOnlyPolicy.js'

/**
 * Claude 配置目录名称枚举。
 *
 * 这些子目录位于 `.claude/` 下，每个目录存放不同类型的 Markdown 配置文件：
 * - commands：自定义斜杠命令（/my-command）
 * - agents：子 Agent 定义（独立系统提示 + 工具集）
 * - output-styles：输出格式风格配置
 * - skills：可复用技能脚本
 * - workflows：多步骤工作流定义
 * - templates（可选）：通过 TEMPLATES 特性标志启用的模板目录
 */
// Claude configuration directory names
export const CLAUDE_CONFIG_DIRECTORIES = [
  'commands',
  'agents',
  'output-styles',
  'skills',
  'workflows',
  ...(feature('TEMPLATES') ? (['templates'] as const) : []),
] as const

export type ClaudeConfigDirectory = (typeof CLAUDE_CONFIG_DIRECTORIES)[number]

/** 已加载的 Markdown 文件元数据结构 */
export type MarkdownFile = {
  filePath: string        // 文件绝对路径
  baseDir: string         // 所属基准目录（managed/user/project 之一）
  frontmatter: FrontmatterData  // 解析后的 frontmatter 元数据
  content: string         // frontmatter 之后的正文内容
  source: SettingSource   // 来源类型（policySettings/userSettings/projectSettings）
}

/**
 * 从 Markdown 内容中提取描述文本。
 *
 * 流程：
 * 1. 逐行扫描，找到第一个非空行；
 * 2. 若为标题行（`# xxx`），剥去 `#` 前缀后返回标题文本；
 * 3. 超过 100 字符时截断并加省略号；
 * 4. 若无有效行则返回默认描述。
 *
 * @param content Markdown 正文内容
 * @param defaultDescription 无有效行时的回退描述
 * @returns 描述字符串（≤100 字符）
 */
export function extractDescriptionFromMarkdown(
  content: string,
  defaultDescription: string = 'Custom item',
): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      // 若为标题行，剥去 # 前缀，只保留标题文本
      const headerMatch = trimmed.match(/^#+\s+(.+)$/)
      const text = headerMatch?.[1] ?? trimmed

      // 超过 100 字符时截断
      return text.length > 100 ? text.substring(0, 97) + '...' : text
    }
  }
  return defaultDescription
}

/**
 * 从 frontmatter 中解析工具列表（支持字符串和数组两种格式）。
 *
 * 处理规则：
 * - undefined/null → 返回 null（交由调用方决定默认值）
 * - 其他假值（空字符串等）→ 返回空数组（无工具）
 * - 字符串 → 包装为 [字符串] 再解析
 * - 数组 → 过滤非字符串后解析
 * - 包含通配符 '*' → 返回 ['*']（所有工具）
 *
 * @param toolsValue frontmatter 中 tools 字段的原始值
 * @returns 解析后的工具名称数组，或 null（表示字段缺失）
 */
function parseToolListString(toolsValue: unknown): string[] | null {
  // 返回 null 表示字段缺失，让调用方决定默认值
  if (toolsValue === undefined || toolsValue === null) {
    return null
  }

  // 其他假值（如空字符串）表示明确设置为"无工具"
  if (!toolsValue) {
    return []
  }

  let toolsArray: string[] = []
  if (typeof toolsValue === 'string') {
    // 字符串形式：单个工具名
    toolsArray = [toolsValue]
  } else if (Array.isArray(toolsValue)) {
    // 数组形式：过滤掉非字符串元素
    toolsArray = toolsValue.filter(
      (item): item is string => typeof item === 'string',
    )
  }

  if (toolsArray.length === 0) {
    return []
  }

  // 通过 CLI 工具列表解析器进行规范化处理
  const parsedTools = parseToolListFromCLI(toolsArray)
  if (parsedTools.includes('*')) {
    // 通配符：返回简化表示
    return ['*']
  }
  return parsedTools
}

/**
 * 解析 Agent frontmatter 中的工具列表。
 *
 * Agent 的工具语义与斜杠命令不同：
 * - 字段缺失（undefined）→ undefined（使用所有工具）
 * - 字段存在但为空/null → []（不允许任何工具）
 * - '*' 通配符 → undefined（等同于所有工具）
 *
 * @param toolsValue frontmatter tools 字段原始值
 * @returns 工具名称数组（undefined 表示允许所有工具）
 */
export function parseAgentToolsFromFrontmatter(
  toolsValue: unknown,
): string[] | undefined {
  const parsed = parseToolListString(toolsValue)
  if (parsed === null) {
    // 字段缺失：对 agents 来说 undefined=所有工具
    return toolsValue === undefined ? undefined : []
  }
  // '*' 通配符也映射为 undefined（允许所有工具）
  if (parsed.includes('*')) {
    return undefined
  }
  return parsed
}

/**
 * 解析斜杠命令 frontmatter 中的 allowed-tools 字段。
 *
 * 斜杠命令的工具语义：
 * - 字段缺失或为空 → []（默认无工具）
 * - 与 Agent 不同，缺失时不意味着"全部"
 *
 * @param toolsValue frontmatter allowed-tools 字段原始值
 * @returns 允许的工具名称数组
 */
export function parseSlashCommandToolsFromFrontmatter(
  toolsValue: unknown,
): string[] {
  const parsed = parseToolListString(toolsValue)
  if (parsed === null) {
    // 斜杠命令缺省为无工具
    return []
  }
  return parsed
}

/**
 * 获取文件的设备号+inode 唯一标识符，用于去重检测。
 *
 * 背景：
 * 当 ~/.claude 被 symlink 到项目目录层次中时，同一个物理文件可能通过不同路径被发现多次。
 * 通过设备号+inode 组合可精确识别这种重复情况。
 *
 * 使用 bigint: true 处理大 inode（ExFAT 等文件系统），
 * 避免 Number 精度不足（53 位）导致不同大 inode 相互混淆（误报重复）。
 *
 * NFS/FUSE 等网络挂载文件系统可能对所有文件报告 dev=0/ino=0，
 * 此时返回 null 跳过去重（保守策略：宁可包含重复，不漏文件）。
 *
 * @param filePath 文件路径
 * @returns "设备号:inode" 字符串，或 null（无法识别时）
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    const stats = await lstat(filePath, { bigint: true })
    // dev=0 且 ino=0 的文件系统（NFS/FUSE）无法可靠识别，跳过去重
    if (stats.dev === 0n && stats.ino === 0n) {
      return null
    }
    return `${stats.dev}:${stats.ino}`
  } catch {
    // 文件无法 stat（不存在、权限拒绝等），返回 null 跳过去重
    return null
  }
}

/**
 * 计算 getProjectDirsUpToHome 向上遍历的停止边界。
 *
 * 通常情况下，遍历停止于 cwd 最近的 `.git` 目录所在位置。
 * 但若 Bash 工具 cd 进入了一个嵌套 git 仓库（submodule/vendored clone），
 * 该嵌套 root 不应成为停止边界——否则父项目的 `.claude/` 将不可达（#31905）。
 *
 * 边界扩大的条件（两者同时满足）：
 * 1. cwd 最近的 `.git` 所属规范仓库 ≠ session 所属规范仓库（即确为嵌套非 worktree）；
 * 2. 该嵌套 `.git` 位于 session 项目树内部。
 *
 * Worktree 不触发此扩大：其 `.git` 文件通过 findCanonicalGitRoot 解析回主仓库，
 * 规范仓库相同，走旧逻辑；worktree 的 `.claude/<subdir>` 缺失时由
 * loadMarkdownFilesForSubdir 单独处理回退。
 *
 * @param cwd 当前工作目录
 * @returns 遍历停止边界路径，若不在 git 仓库中则返回 null
 */
function resolveStopBoundary(cwd: string): string | null {
  const cwdGitRoot = findGitRoot(cwd)
  const sessionGitRoot = findGitRoot(getProjectRoot())
  if (!cwdGitRoot || !sessionGitRoot) {
    return cwdGitRoot
  }
  // findCanonicalGitRoot：worktree .git 文件 → 解析到主仓库；submodule/standalone 克隆不变
  const cwdCanonical = findCanonicalGitRoot(cwd)
  if (
    cwdCanonical &&
    normalizePathForComparison(cwdCanonical) ===
      normalizePathForComparison(sessionGitRoot)
  ) {
    // 同一规范仓库（主仓库或其 worktree），使用最近 .git 作为停止边界
    return cwdGitRoot
  }
  // 不同规范仓库。检查是否嵌套在 session 项目树内部
  const nCwdGitRoot = normalizePathForComparison(cwdGitRoot)
  const nSessionRoot = normalizePathForComparison(sessionGitRoot)
  if (
    nCwdGitRoot !== nSessionRoot &&
    nCwdGitRoot.startsWith(nSessionRoot + sep)
  ) {
    // 嵌套仓库——跳过它，使用 session 项目 root 作为停止边界
    return sessionGitRoot
  }
  // 兄弟仓库或其他情况，使用旧逻辑（最近 .git）
  return cwdGitRoot
}

/**
 * 从 cwd 向上遍历到 git root（或 home），收集所有存在的 `.claude/<subdir>` 目录。
 *
 * 遍历策略：
 * - 从 cwd 开始，每轮检查 `当前目录/.claude/<subdir>` 是否存在（statSync）；
 * - 停止条件一：到达 home 目录（home 目录的 `~/.claude/<subdir>` 由调用方单独处理）；
 * - 停止条件二：到达 git root（防止 git 仓库之外的父目录配置泄漏进来）；
 * - 停止条件三：到达文件系统根目录（parent === current）。
 * - resolveStopBoundary 处理嵌套仓库场景，将边界扩大到 session git root。
 *
 * 使用 statSync（同步）而非 existsSync 是为了区分"不存在"和"意外错误"，
 * 对后者通过 isFsInaccessible 重抛，避免静默吞掉意外异常。
 *
 * @param subdir 配置子目录名称（如 "commands"、"agents"）
 * @param cwd 当前工作目录（遍历起点）
 * @returns 存在的 `.claude/<subdir>` 目录路径数组（从最近到最远）
 */
export function getProjectDirsUpToHome(
  subdir: ClaudeConfigDirectory,
  cwd: string,
): string[] {
  const home = resolve(homedir()).normalize('NFC')
  // 计算遍历停止边界（处理嵌套 git 仓库）
  const gitRoot = resolveStopBoundary(cwd)
  let current = resolve(cwd)
  const dirs: string[] = []

  while (true) {
    // 到达 home 目录时停止（home 的 .claude/<subdir> 由调用方处理）
    // 使用规范化比较处理 Windows 驱动器字母大小写（C:\ vs c:\）
    if (
      normalizePathForComparison(current) === normalizePathForComparison(home)
    ) {
      break
    }

    const claudeSubdir = join(current, '.claude', subdir)
    // 检查目录是否存在（同步，区分"不存在"与"意外错误"）。
    // statSync + 显式错误处理，而非 existsSync——重抛意外异常。
    // 下游 loadMarkdownFiles 对 TOCTOU 窗口（读取前目录消失）有容错。
    try {
      statSync(claudeSubdir)
      dirs.push(claudeSubdir)
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) throw e
      // 目录不存在或无权访问，跳过
    }

    // 到达 git root 后停止遍历，防止父目录配置泄漏进项目
    if (
      gitRoot &&
      normalizePathForComparison(current) ===
        normalizePathForComparison(gitRoot)
    ) {
      break
    }

    // 向上一级
    const parent = dirname(current)

    // 到达文件系统根（parent === current）时停止
    if (parent === current) {
      break
    }

    current = parent
  }

  return dirs
}

/**
 * 从 managed、user、project 三类来源加载指定子目录的 Markdown 文件（memoize 缓存）。
 *
 * 【加载流程】
 * 1. 确定三类来源目录：managedDir（策略文件）、userDir（~/.claude/<subdir>）、
 *    projectDirs（cwd 向上遍历到 git root 的所有 .claude/<subdir>）；
 * 2. Git worktree 回退：若 worktree 没有检出 `.claude/<subdir>`（sparse checkout），
 *    则回退到主仓库的对应目录（避免 full-checkout worktree 重复加载）；
 * 3. 三类来源并行加载（Promise.all），按 managed > user > project 优先级合并；
 * 4. inode 去重：通过 getFileIdentity 检测 symlink 导致的物理文件重复。
 *
 * 缓存 Key 由 `${subdir}:${cwd}` 组成，相同参数直接返回缓存结果。
 *
 * @param subdir 子目录名称（如 "commands"、"agents"）
 * @param cwd 当前工作目录
 * @returns 去重后的 MarkdownFile 数组（含文件路径、frontmatter、正文、来源标签）
 */
export const loadMarkdownFilesForSubdir = memoize(
  async function (
    subdir: ClaudeConfigDirectory,
    cwd: string,
  ): Promise<MarkdownFile[]> {
    const searchStartTime = Date.now()
    // 确定三类来源目录
    const userDir = join(getClaudeConfigHomeDir(), subdir)
    const managedDir = join(getManagedFilePath(), '.claude', subdir)
    const projectDirs = getProjectDirsUpToHome(subdir, cwd)

    // Git worktree 回退逻辑：
    // sparse-checkout 模式下，worktree 可能没有检出 .claude/<subdir>，
    // getProjectDirsUpToHome 在 worktree root（.git 文件所在）停止，看不到主仓库。
    // 仅当 worktree root 对应 .claude/<subdir> 不存在时，才追加主仓库路径；
    // full-checkout worktree 已包含相同内容，无需追加（避免重复）。
    // projectDirs 已通过 statSync 过滤了不存在的目录，直接比对即可。
    const gitRoot = findGitRoot(cwd)
    const canonicalRoot = findCanonicalGitRoot(cwd)
    if (gitRoot && canonicalRoot && canonicalRoot !== gitRoot) {
      const worktreeSubdir = normalizePathForComparison(
        join(gitRoot, '.claude', subdir),
      )
      const worktreeHasSubdir = projectDirs.some(
        dir => normalizePathForComparison(dir) === worktreeSubdir,
      )
      if (!worktreeHasSubdir) {
        // worktree 缺失该子目录，回退到主仓库
        const mainClaudeSubdir = join(canonicalRoot, '.claude', subdir)
        if (!projectDirs.includes(mainClaudeSubdir)) {
          projectDirs.push(mainClaudeSubdir)
        }
      }
    }

    // 三类来源并行加载，并分别标注来源类型
    const [managedFiles, userFiles, projectFilesNested] = await Promise.all([
      // managed 文件：始终加载（策略文件，最高优先级）
      loadMarkdownFiles(managedDir).then(_ =>
        _.map(file => ({
          ...file,
          baseDir: managedDir,
          source: 'policySettings' as const,
        })),
      ),
      // user 文件：受 userSettings 启用状态控制，agents 目录还受 pluginOnly 策略限制
      isSettingSourceEnabled('userSettings') &&
      !(subdir === 'agents' && isRestrictedToPluginOnly('agents'))
        ? loadMarkdownFiles(userDir).then(_ =>
            _.map(file => ({
              ...file,
              baseDir: userDir,
              source: 'userSettings' as const,
            })),
          )
        : Promise.resolve([]),
      // project 文件：受 projectSettings 启用状态控制，同样受 pluginOnly 策略限制
      isSettingSourceEnabled('projectSettings') &&
      !(subdir === 'agents' && isRestrictedToPluginOnly('agents'))
        ? Promise.all(
            projectDirs.map(projectDir =>
              loadMarkdownFiles(projectDir).then(_ =>
                _.map(file => ({
                  ...file,
                  baseDir: projectDir,
                  source: 'projectSettings' as const,
                })),
              ),
            ),
          )
        : Promise.resolve([]),
    ])

    // 展平嵌套的 project 文件数组（每个目录对应一个数组）
    const projectFiles = projectFilesNested.flat()

    // 按优先级合并：managed > user > project
    const allFiles = [...managedFiles, ...userFiles, ...projectFiles]

    // inode 去重：防止同一物理文件通过 symlink 不同路径被加载多次
    const fileIdentities = await Promise.all(
      allFiles.map(file => getFileIdentity(file.filePath)),
    )

    const seenFileIds = new Map<string, SettingSource>()
    const deduplicatedFiles: MarkdownFile[] = []

    for (const [i, file] of allFiles.entries()) {
      const fileId = fileIdentities[i] ?? null
      if (fileId === null) {
        // 无法识别文件身份（NFS/FUSE 等），保守包含（fail open）
        deduplicatedFiles.push(file)
        continue
      }
      const existingSource = seenFileIds.get(fileId)
      if (existingSource !== undefined) {
        // 已经通过其他路径加载过该物理文件，跳过
        logForDebugging(
          `Skipping duplicate file '${file.filePath}' from ${file.source} (same inode already loaded from ${existingSource})`,
        )
        continue
      }
      seenFileIds.set(fileId, file.source)
      deduplicatedFiles.push(file)
    }

    const duplicatesRemoved = allFiles.length - deduplicatedFiles.length
    if (duplicatesRemoved > 0) {
      logForDebugging(
        `Deduplicated ${duplicatesRemoved} files in ${subdir} (same inode via symlinks or hard links)`,
      )
    }

    // 上报目录搜索性能遥测数据
    logEvent(`tengu_dir_search`, {
      durationMs: Date.now() - searchStartTime,
      managedFilesFound: managedFiles.length,
      userFilesFound: userFiles.length,
      projectFilesFound: projectFiles.length,
      projectDirsSearched: projectDirs.length,
      subdir:
        subdir as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    return deduplicatedFiles
  },
  // 自定义 memoize Key：由 subdir 和 cwd 共同决定缓存条目
  (subdir: ClaudeConfigDirectory, cwd: string) => `${subdir}:${cwd}`,
)

/**
 * 使用 Node.js fs API 原生遍历目录，查找所有 `.md` 文件。
 *
 * 存在原因：
 * 1. ripgrep 在 native build 模式下启动性能较差（影响 app 启动体验）；
 * 2. 作为 ripgrep 不可用时的回退实现；
 * 3. 可通过 CLAUDE_CODE_USE_NATIVE_FILE_SEARCH 环境变量显式启用。
 *
 * 符号链接处理：
 * - 跟随符号链接（等同于 ripgrep 的 --follow 标志）；
 * - 使用设备号+inode（bigint）追踪已访问目录，检测符号链接循环；
 * - 在不支持 inode 的系统上回退到 realpath 规范化路径。
 *
 * 不遵守 .gitignore（与 ripgrep --no-ignore 行为一致）。
 *
 * @param dir 要搜索的根目录
 * @param signal 超时取消信号（3 秒）
 * @returns 找到的 .md 文件路径数组
 */
async function findMarkdownFilesNative(
  dir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const files: string[] = []
  const visitedDirs = new Set<string>() // 已访问目录集合（inode 或 realpath）

  /** 递归遍历目录 */
  async function walk(currentDir: string): Promise<void> {
    if (signal.aborted) {
      return
    }

    // 循环检测：记录已访问目录的 device+inode（bigint 处理大 inode）
    // 见：https://github.com/anthropics/claude-code/issues/13893
    try {
      const stats = await stat(currentDir, { bigint: true })
      if (stats.isDirectory()) {
        const dirKey =
          stats.dev !== undefined && stats.ino !== undefined
            ? `${stats.dev}:${stats.ino}` // Unix/Linux：设备号 + inode
            : await realpath(currentDir)   // Windows：规范化绝对路径

        if (visitedDirs.has(dirKey)) {
          // 已访问过该目录（符号链接循环），跳过
          logForDebugging(
            `Skipping already visited directory (circular symlink): ${currentDir}`,
          )
          return
        }
        visitedDirs.add(dirKey)
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Failed to stat directory ${currentDir}: ${errorMessage}`)
      return
    }

    try {
      const entries = await readdir(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        if (signal.aborted) {
          break
        }

        const fullPath = join(currentDir, entry.name)

        try {
          // 符号链接处理：isFile()/isDirectory() 对符号链接返回 false，需单独处理
          if (entry.isSymbolicLink()) {
            try {
              const stats = await stat(fullPath) // stat() 会跟随符号链接
              if (stats.isDirectory()) {
                await walk(fullPath) // 跟随目录符号链接继续遍历
              } else if (stats.isFile() && entry.name.endsWith('.md')) {
                files.push(fullPath) // 跟随文件符号链接，收集 .md 文件
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              logForDebugging(
                `Failed to follow symlink ${fullPath}: ${errorMessage}`,
              )
            }
          } else if (entry.isDirectory()) {
            await walk(fullPath) // 普通目录：递归遍历
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(fullPath) // 普通 .md 文件：收集
          }
        } catch (error) {
          // 跳过无法访问的文件/目录（权限等问题）
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(`Failed to access ${fullPath}: ${errorMessage}`)
        }
      }
    } catch (error) {
      // readdir 失败（如权限拒绝），记录日志后继续
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Failed to read directory ${currentDir}: ${errorMessage}`)
    }
  }

  await walk(dir)
  return files
}

/**
 * 从指定目录加载所有 Markdown 文件并解析 frontmatter。
 *
 * 文件搜索策略：
 * - 默认：ripgrep（启动快、久经验证）
 * - 可选：Node.js 原生（CLAUDE_CODE_USE_NATIVE_FILE_SEARCH 环境变量启用）
 *
 * 使用 AbortSignal.timeout(3000) 防止搜索超时阻塞。
 * 目录不存在或无权访问时静默返回空数组（TOCTOU 安全）。
 *
 * @param dir 要扫描的目录路径（如 "~/.claude/commands"）
 * @returns 包含路径、frontmatter、内容的文件对象数组
 */
async function loadMarkdownFiles(dir: string): Promise<
  {
    filePath: string
    frontmatter: FrontmatterData
    content: string
  }[]
> {
  // 选择文件搜索实现：ripgrep（默认）或 Node.js 原生（显式启用）
  const useNative = isEnvTruthy(process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH)
  const signal = AbortSignal.timeout(3000) // 3 秒超时
  let files: string[]
  try {
    files = useNative
      ? await findMarkdownFilesNative(dir, signal)
      : await ripGrep(
          // 参数说明：列出文件、包含隐藏文件、跟随符号链接、不忽略文件、只找 *.md
          ['--files', '--hidden', '--follow', '--no-ignore', '--glob', '*.md'],
          dir,
          signal,
        )
  } catch (e: unknown) {
    // 目录不存在或无权访问时静默返回空数组（TOCTOU 处理）
    if (isFsInaccessible(e)) return []
    throw e
  }

  // 并行读取并解析所有找到的文件
  const results = await Promise.all(
    files.map(async filePath => {
      try {
        const rawContent = await readFile(filePath, { encoding: 'utf-8' })
        // 解析 YAML frontmatter，分离元数据和正文
        const { frontmatter, content } = parseFrontmatter(rawContent, filePath)

        return {
          filePath,
          frontmatter,
          content,
        }
      } catch (error) {
        // 单个文件读取/解析失败不影响其他文件，记录日志后跳过
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logForDebugging(
          `Failed to read/parse markdown file:  ${filePath}: ${errorMessage}`,
        )
        return null
      }
    }),
  )

  // 过滤掉读取失败的文件（null 项）
  return results.filter(_ => _ !== null)
}
