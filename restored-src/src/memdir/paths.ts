/**
 * @file paths.ts
 * @description 记忆目录模块 — 记忆路径解析与功能开关
 *
 * 在 Claude Code 记忆系统中，该文件是所有路径计算的权威来源，负责：
 * 1. 判断自动记忆/记忆提取功能是否启用（isAutoMemoryEnabled / isExtractModeActive）
 * 2. 计算并缓存自动记忆目录路径（getAutoMemPath），支持多种覆盖机制
 * 3. 提供派生路径（每日日志路径、MEMORY.md 入口路径）
 * 4. 路径安全验证（validateMemoryPath）：防止路径穿越、UNC 路径、null 字节等攻击
 * 5. 检查给定路径是否在自动记忆目录内（isAutoMemPath）
 *
 * 路径解析优先级（getAutoMemPath）：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（Cowork 空间级挂载）
 *   2. settings.json autoMemoryDirectory 字段（仅 policy/flag/local/user 层，排除 project 层）
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/（默认计算路径）
 *
 * 安全设计：
 * - projectSettings 被故意排除在外（防止恶意仓库通过 autoMemoryDirectory: "~/.ssh" 获得写权限）
 * - validateMemoryPath 拒绝相对路径、根路径、Windows 驱动器根、UNC 路径、null 字节
 * - isAutoMemPath 使用 normalize() 防止 .. 段绕过
 */

import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 判断自动记忆功能是否启用（记忆目录读写、代理记忆、历史会话搜索均依赖此开关）。
 * 默认启用。优先级链（首个已定义的值获胜）：
 *   1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量
 *      - 1/true → 禁用；0/false → 启用（显式开启，覆盖后续所有检查）
 *   2. CLAUDE_CODE_SIMPLE（--bare 模式）→ 禁用
 *      （prompts.ts 已在 SIMPLE 模式下从系统提示中移除记忆节；
 *       此门控停止另一半：extractMemories 分叉、autoDream、/remember、/dream、团队同步）
 *   3. CCR（远程模式）且无 CLAUDE_CODE_REMOTE_MEMORY_DIR → 禁用（无持久存储）
 *   4. settings.json 中的 autoMemoryEnabled 字段（支持项目级禁用）
 *   5. 默认：启用
 *
 * @returns 自动记忆是否启用
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false // 环境变量显式禁用
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true  // 环境变量显式启用（0/false），覆盖后续检查
  }
  // --bare/SIMPLE 模式：系统提示已移除记忆节，此处同步禁用记忆相关副作用
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  // CCR 远程模式且无持久存储目录：无法保存记忆，禁用
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  // 读取 settings.json 中的显式配置（支持项目级或用户级禁用）
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true // 默认启用
}

/**
 * 判断记忆提取后台代理是否将在本次会话中运行。
 *
 * 主代理的提示始终包含完整的记忆保存指导，与此开关无关：
 * - 若主代理写入记忆，后台代理会跳过该时间段（extractMemories.ts 中的 hasMemoryWritesSince）
 * - 若主代理未写入，后台代理负责补充提取
 *
 * 注意：调用方还需单独门控 feature('EXTRACT_MEMORIES')——
 * 该检查不能放在此辅助函数内，因为 feature() 仅在直接用于 `if` 条件时才能被树摇。
 *
 * @returns 记忆提取代理是否激活
 */
export function isExtractModeActive(): boolean {
  // 功能开关 tengu_passport_quail：控制记忆提取代理的总开关
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    // 非交互式会话中，仅在 tengu_slate_thimble 功能开关启用时激活
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
}

/**
 * 返回持久记忆存储的基础目录。
 * 解析顺序：
 *   1. CLAUDE_CODE_REMOTE_MEMORY_DIR 环境变量（CCR 显式覆盖，由 SDK 以绝对路径传入）
 *   2. ~/.claude（默认配置主目录）
 *
 * @returns 记忆存储基础目录绝对路径
 */
export function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR // CCR 显式指定的远程存储目录
  }
  return getClaudeConfigHomeDir() // 默认使用 ~/.claude
}

/** 自动记忆子目录名称（相对于项目记忆基础目录） */
const AUTO_MEM_DIRNAME = 'memory'
/** MEMORY.md 索引文件名称 */
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * 规范化并验证候选自动记忆目录路径的安全性。
 *
 * 安全拒绝场景（可作为读取允许列表根目录的危险路径）：
 * - 相对路径（!isAbsolute）：如 "../foo"，将相对于 CWD 解释
 * - 根路径或过短路径（length < 3）："/" 或 "/a" 去除分隔符后过短
 * - Windows 驱动器根（C: 正则）："C:\" 去除分隔符后仅剩 "C:"
 * - UNC 路径（\\server\share）：网络路径，信任边界不透明
 * - null 字节：能通过 normalize() 但在系统调用中截断路径
 *
 * @param raw         候选路径字符串（undefined 或空字符串时直接返回 undefined）
 * @param expandTilde 是否展开 ~/ 前缀（settings.json 路径支持；环境变量路径不支持）
 * @returns           规范化后带尾部分隔符的路径，或 undefined（无效时）
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined // 空路径直接返回
  }
  let candidate = raw
  // settings.json 路径支持 ~/ 展开（用户友好）；
  // 环境变量覆盖不支持（Cowork/SDK 应始终传入绝对路径）
  // 仅展开 "~/<non-empty>" 形式——裸 "~"、"~/"、"~/."、"~/.." 等不展开，
  // 以防展开后得到 $HOME 或其父目录（与 "/" 或 "C:\" 同类危险）
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // 拒绝展开后退化为 $HOME 或其祖先的路径：
    // normalize('') = '.', normalize('.') = '.', normalize('foo/..') = '.',
    // normalize('..') = '..', normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined // 展开后等于 $HOME 或其父目录，拒绝
    }
    candidate = join(homedir(), rest) // 安全展开
  }
  // normalize() 可能保留尾部分隔符；先去除，再统一添加一个，满足 getAutoMemPath() 的尾分隔符约定
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||          // 拒绝相对路径
    normalized.length < 3 ||            // 拒绝过短路径（根路径或近根路径）
    /^[A-Za-z]:$/.test(normalized) ||   // 拒绝 Windows 驱动器根（如 "C:"）
    normalized.startsWith('\\\\') ||    // 拒绝 Windows UNC 路径
    normalized.startsWith('//') ||      // 拒绝 Unix UNC 风格路径
    normalized.includes('\0')           // 拒绝含 null 字节的路径
  ) {
    return undefined // 路径不安全，拒绝
  }
  // 添加尾部分隔符并 NFC 规范化，确保 Unicode 路径的一致性比较
  return (normalized + sep).normalize('NFC')
}

/**
 * 通过 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量获取完整记忆目录路径覆盖。
 * 设置后，getAutoMemPath()/getAutoMemEntrypoint() 直接返回此路径，
 * 不再计算 `{base}/projects/{sanitized-cwd}/memory/`。
 *
 * 用途：Cowork 将记忆重定向到空间级挂载点，避免每次会话的 CWD（含 VM 进程名）
 * 产生不同的项目键导致记忆分散。
 *
 * @returns 验证通过的覆盖路径，或 undefined（未设置或无效时）
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false, // 环境变量路径不支持 ~/ 展开，应始终传入绝对路径
  )
}

/**
 * 从 settings.json 获取用户自定义的自动记忆目录路径（支持 ~/ 展开）。
 *
 * 安全说明：projectSettings（.claude/settings.json，提交到仓库）被故意排除。
 * 原因：恶意仓库可通过设置 autoMemoryDirectory: "~/.ssh" 获得对敏感目录的
 * 静默写访问权限（filesystem.ts 的写入豁免在 isAutoMemPath() 匹配且
 * !hasAutoMemPathOverride() 为 true 时触发）。
 * 仅信任 policy/flag/local/user 层（与 hasSkipDangerousModePermissionPrompt() 等相同策略）。
 *
 * @returns 验证通过的路径，或 undefined（未配置或无效时）
 */
function getAutoMemPathSetting(): string | undefined {
  // 按优先级读取各层设置（policy > flag > local > user），排除 project 层
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true) // settings.json 路径支持 ~/ 展开
}

/**
 * 检查 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 是否已设置为有效覆盖路径。
 * 可用作信号：SDK 调用方已显式启用自动记忆机制——
 * 例如当自定义系统提示替换默认提示时，据此决定是否注入记忆提示。
 *
 * @returns 环境变量覆盖是否有效
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * 返回用于记忆目录路径计算的规范基础目录：
 * 优先使用规范 git 仓库根目录（确保同一仓库的所有 worktree 共享同一记忆目录，
 * 参见 anthropics/claude-code#24382），回退到稳定的项目根目录。
 *
 * @returns 规范 git 根目录路径，或回退到项目根目录路径
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * 返回自动记忆目录的完整路径（带尾部分隔符，NFC 规范化）。
 *
 * 解析优先级：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（Cowork 空间级挂载）
 *   2. settings.json autoMemoryDirectory 字段（仅受信任层：policy/flag/local/user）
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/（默认计算路径）
 *
 * 缓存策略：以 projectRoot 为键进行 memoize，原因：
 * - 渲染路径调用方（collapseReadSearchGroups → isAutoManagedMemoryFile）
 *   每次工具调用消息、每次 Messages 重渲染时均会触发；
 * - 每次未命中需调用 getSettingsForSource × 4 → parseSettingsFile（realpathSync + readFileSync）；
 * - 以 projectRoot 为键：测试中修改 mock 的 mid-block 场景会触发重新计算；
 *   环境变量/settings.json/CLAUDE_CONFIG_DIR 在生产环境中会话内稳定，
 *   测试间通过 per-test cache.clear 隔离。
 */
export const getAutoMemPath = memoize(
  (): string => {
    // 优先使用环境变量或 settings 覆盖路径
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    // 默认路径：<memoryBase>/projects/<sanitized-git-root>/memory/
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC') // NFC 规范化确保 Unicode 路径一致性
  },
  () => getProjectRoot(), // 缓存键：以 projectRoot 区分不同项目的路径
)

/**
 * 返回指定日期的自动记忆每日日志文件路径（默认今天）。
 * 格式：<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * 用于助手模式（feature('KAIROS')）：
 * - 不维护 MEMORY.md 为实时索引，改为追加到日期命名的日志文件
 * - 单独的夜间 /dream 技能将日志提炼为主题文件和 MEMORY.md
 *
 * @param date 目标日期，默认为当前日期
 * @returns    日志文件的绝对路径
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0') // 月份补零
  const dd = date.getDate().toString().padStart(2, '0')         // 日期补零
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * 返回自动记忆入口文件（MEMORY.md）的绝对路径。
 * 遵循与 getAutoMemPath() 相同的解析优先级。
 *
 * @returns MEMORY.md 的绝对路径
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * 检查给定绝对路径是否位于自动记忆目录内。
 *
 * 当 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 设置时，匹配该环境变量指定的目录。
 * 注意：此处返回 true 不意味着 filesystem.ts 写入豁免生效——
 * 写入豁免额外需要 !hasAutoMemPathOverride()（防止 Cowork 覆盖绕过 DANGEROUS_DIRECTORIES 检查）。
 *
 * settings.json 的 autoMemoryDirectory 则获得写入豁免：
 * 这是用户从受信任来源的显式选择（projectSettings 被排除）。
 *
 * @param absolutePath 待检查的绝对路径
 * @returns            该路径是否在自动记忆目录内
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // 安全：先 normalize 消除 .. 段，防止路径穿越绕过前缀检查
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}
