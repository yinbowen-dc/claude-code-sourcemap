/**
 * 全局配置管理模块。
 *
 * 在 Claude Code 系统中，该模块负责读取、写入和监听 ~/.claude/settings.json 配置文件，
 * 提供跨会话持久化的全局设置管理：
 * - getGlobalConfig()：获取当前全局配置（带缓存）
 * - setGlobalConfig()：更新全局配置并持久化
 * - 支持文件监听（watchFile），配置变更时自动刷新缓存
 */
import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  BillingType,
  ReferralEligibilityResponse,
} from '../services/oauth/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// 可重入防护：防止 getConfig → logEvent → getGlobalConfig → getConfig
// 在配置文件损坏时产生无限递归。logEvent 的采样检查
// 从全局配置读取 GrowthBook 特性，这会再次调用 getConfig。
let insideGetConfig = false

// 图像尺寸信息，用于坐标映射（仅在图像被缩放时设置）
export type PastedContent = {
  id: number // 顺序数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 例如 'image/png'、'image/jpeg'
  filename?: string // 附件插槽中图像的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string // 拖拽到终端的图像的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // 信任对话框设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP 服务器审批字段 —— 已迁移至 settings，但为向后兼容而保留
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 已禁用的 MCP 服务器列表（所有范围）—— 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 默认禁用的内置 MCP 服务器的可选启用列表
  enabledMcpServers?: string[]
  // Worktree 会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** Spawn mode for `claude remote-control` multi-session. Set by first-run dialog or `w` toggle. */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // added 4/23/2025, not populated for existing users
  organizationRole?: string | null
  workspaceRole?: string | null
  // 由 /api/oauth/profile 填充
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO: 'emacs' 保留是为了向后兼容 —— 几个版本后移除
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated Use settings.apiKeyHelper instead.
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 用于区分基于保护机制的禁用与用户主动偏好
  autoUpdatesProtectedForNative?: boolean
  // 上次显示 Doctor 时的会话计数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 记录最后一次重置引导流程的版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 配合使用
  lastOnboardingVersion?: string
  // 记录最后查看发行说明的版本，用于管理发行说明显示
  lastReleaseNotesSeen?: string
  // 最后一次拉取更新日志的时间戳（内容存储于 ~/.claude/cache/changelog.md）
  changelogLastFetched?: number
  // @deprecated - Migrated to ~/.claude/cache/changelog.md. Keep for migration support.
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // 至少成功连接过一次的 claude.ai MCP 连接器。
  // 用于门控"连接器不可用"/"需要授权"的启动通知：
  // 用户实际使用过的连接器出现故障时值得提示；
  // 但那种从第一天就需要授权、用户显然一直忽略的
  // 组织配置连接器，不应反复弹出通知打扰用户。
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated. Use the Notification hook instead (docs/hooks.md).
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 未设置环境变量时用户的主 API 密钥，通过 oauth 设置（TODO: 重命名）
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // 仅限内部：一次性自动隐匿模式说明是否已展示
  hasSeenUltraplanTerms?: boolean // 仅限内部：ultraplan 启动对话框中的一次性 CCR 条款通知是否已展示
  hasResetAutoModeOptInForDefaultOffer?: boolean // 仅限内部：一次性迁移守卫，重新提示流失的自动模式用户
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // 旧版字段 —— 保留以向后兼容
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 控制是否启用自动压缩
  showTurnDuration: boolean // 控制是否显示轮次耗时消息（如"Cooked for 1m 6s"）
  /**
   * @deprecated Use settings.env instead.
   */
  env: { [key: string]: string } // CLI 的环境变量设置
  hasSeenTasksHint?: boolean // 用户是否已看过任务提示
  hasUsedStash?: boolean // 用户是否使用过暂存功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否已将任务置于后台（Ctrl+B）
  queuedCommandUpHintCount?: number // 用户已看到排队命令向上提示的次数
  diffTool?: DiffTool // 显示差异时使用的工具（终端或 vscode）

  // 终端设置状态追踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 偏好设置备份文件路径
  appleTerminalBackupPath?: string // Terminal.app 偏好设置备份文件路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 设置是否正在进行中

  // 按键绑定安装状态追踪
  shiftEnterKeyBindingInstalled?: boolean // Shift+Enter 按键绑定是否已安装（适用于 iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // Option 键作为 Meta 键是否已安装（适用于 Terminal.app）

  // IDE 配置项
  autoConnectIde?: boolean // 启动时若恰好有一个有效 IDE，是否自动连接
  autoInstallIdeExtension?: boolean // 在 IDE 内运行时，是否自动安装 IDE 扩展插件

  // IDE 对话框
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 终端名称 → IDE 引导是否已展示过的映射表
  ideHintShownCount?: number // /ide 命令提示已展示的次数
  hasIdeAutoConnectDialogBeenShown?: boolean // IDE 自动连接对话框是否已展示过

  tipsHistory: {
    [tipId: string]: number // 键为 tipId，值为提示最后展示时的 numStartups 启动次数
  }

  // /buddy 伴侣灵魂 —— 读取时从 userId 重新生成骨骼数据。参见 src/buddy/。
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // 反馈调查状态追踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 会话记录分享提示追踪（"不再询问"）
  transcriptShareDismissed?: boolean

  // 记忆使用次数追踪
  memoryUsageCount: number // 用户添加到记忆的次数

  // Sonnet-1M 相关配置
  hasShownS1MWelcomeV2?: Record<string, boolean> // 各组织是否已展示过 Sonnet-1M v2 欢迎消息
  // 各组织的 Sonnet-1M 订阅用户访问权限缓存 —— 键为组织 ID
  // hasAccess 等价于 "hasAccessAsDefault"，但旧名称保留以向后兼容。
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // 各组织的 Sonnet-1M 按量付费用户访问权限缓存 —— 键为组织 ID
  // hasAccess 等价于 "hasAccessAsDefault"，但旧名称保留以向后兼容。
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // 各组织的访客通行证资格缓存 —— 键为组织 ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // 各账户的 Grove 配置缓存 —— 键为账户 UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  // 访客通行证追加销售追踪
  passesUpsellSeenCount?: number // 访客通行证追加销售已展示的次数
  hasVisitedPasses?: boolean // 用户是否访问过 /passes 命令
  passesLastSeenRemaining?: number // 最后一次看到的剩余通行证数量 —— 数量增加时重置追加销售

  // 超额信用授予追加销售追踪（按组织 UUID 键控 —— 多组织用户）。
  // 使用内联类型而非 import()，因为 config.ts 在 SDK 构建表面中，
  // SDK 打包工具无法解析 CLI 服务模块。
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number // 超额信用追加销售已展示的次数
  hasVisitedExtraUsage?: boolean // 用户是否访问过 /extra-usage —— 访问后隐藏信用追加销售

  // 语音模式通知追踪
  voiceNoticeSeenCount?: number // "语音模式可用"通知已展示的次数
  voiceLangHintShownCount?: number // /voice 听写语言提示已展示的次数
  voiceLangHintLastLanguage?: string // 提示最后展示时的已解析 STT 语言代码 —— 语言变化时重置计数
  voiceFooterHintSeenCount?: number // "按住 X 键说话"底部提示已展示的会话次数

  // Opus 1M 合并通知追踪
  opus1mMergeNoticeSeenCount?: number // opus-1m-merge 通知已展示的次数

  // 实验注册通知追踪（按实验 ID 键控）
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan 实验配置
  hasShownOpusPlanWelcome?: Record<string, boolean> // 各组织是否已展示过 OpusPlan 欢迎消息

  // 提示队列使用次数追踪
  promptQueueUseCount: number // 用户使用提示队列的次数

  // /btw 使用次数追踪
  btwUseCount: number // 用户使用 /btw 命令的次数

  // 计划模式使用追踪
  lastPlanModeUse?: number // 最后一次使用计划模式的时间戳

  // 订阅通知追踪
  subscriptionNoticeCount?: number // 订阅通知已展示的次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅追加销售已展示的次数（已废弃）
  recommendedSubscription?: string // 来自 Statsig 的缓存配置值（已废弃）

  // Todo 功能配置
  todoFeatureEnabled: boolean // Todo 功能是否已启用
  showExpandedTodos?: boolean // 是否展开显示 Todo 列表（即使为空时也展开）
  showSpinnerTree?: boolean // 是否显示队友旋转树而非圆形标识

  // 首次启动时间追踪
  firstStartTime?: string // Claude Code 在本机首次启动的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户空闲多久后收到"Claude 已完成生成"通知（毫秒）

  githubActionSetupCount?: number // 用户设置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack 应用的次数

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端标签页状态指示器（OSC 21337）。启用时在标签侧边栏输出
  // 彩色圆点 + 状态文本，并去掉标题中的旋转前缀（圆点已表达同样含义，前缀冗余）。
  showStatusInTerminalTab?: boolean

  // 推送通知开关（通过 /config 设置）。默认关闭 —— 需显式选择启用。
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code 使用情况追踪
  claudeCodeFirstTokenDate?: string // 用户首次获取 Claude Code OAuth 令牌的 ISO 时间戳

  // 模型切换提示追踪（仅限内部）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择了"不再显示"
  modelSwitchCalloutLastShown?: number // 最后展示时的时间戳（24 小时内不重复显示）
  modelSwitchCalloutVersion?: string

  // Effort 提示追踪 —— 对 Opus 4.6 用户仅显示一次
  effortCalloutDismissed?: boolean // v1 旧版，读取以为已看过 v1 的 Pro 用户屏蔽 v2
  effortCalloutV2Dismissed?: boolean

  // 远程连接提示追踪 —— 首次启用 bridge 前显示一次
  remoteDialogSeen?: boolean

  // initReplBridge 的 oauth_expired_unrefreshable 跳过逻辑的跨进程退避机制。
  // `expiresAt` 为去重键 —— 内容寻址，/login 替换令牌时自动清除。
  // `failCount` 限制假阳性：瞬时刷新失败（认证服务器 5xx、锁错误）
  // 在退避生效前允许 3 次重试，与 useReplBridge 的 MAX_CONSECUTIVE_INIT_FAILURES 保持一致。
  // 死令牌账户最多写入 3 次配置；健康+瞬时抖动账户约 210s 后自愈。
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // 桌面版追加销售启动对话框追踪
  desktopUpsellSeenCount?: number // 总展示次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 用户选择了"不再询问"

  // 空闲返回对话框追踪
  idleReturnDismissed?: boolean // 用户选择了"不再询问"

  // Opus 4.5 Pro 迁移追踪
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1M 迁移追踪
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → 当前 Opus 迁移（显示一次性通知）
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 迁移（Pro/Max/团队高级版）
  sonnet45To46MigrationTimestamp?: number

  // 缓存的 Statsig 门控值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 Statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook 特性值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖值（仅限内部，通过 /config Gates 标签页设置）。
  // 在环境变量覆盖之后、真实解析值之前生效。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示追踪 —— 存储最后展示的提示，防止重复展示
  lastShownEmergencyTip?: string

  // 文件选择器 gitignore 行为
  respectGitignore: boolean // 文件选择器是否遵守 .gitignore 文件（默认 true）。注：.ignore 文件始终被遵守

  // /copy 命令行为
  copyFullResponse: boolean // /copy 是否始终复制完整响应而非显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 松开鼠标时自动复制到剪贴板（undefined → true；让 cmd+c 通过无操作"正常工作"）

  // GitHub 仓库路径映射（用于 teleport 目录切换）
  // 键："owner/repo"（小写），值：该仓库克隆到的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // claude-cli:// 深度链接启动的终端模拟器。在交互式会话中从 TERM_PROGRAM
  // 捕获，因为深度链接处理器以无头模式运行（LaunchServices/xdg），不设置 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 安装配置
  iterm2It2SetupComplete?: boolean // it2 安装是否已验证完成
  preferTmuxOverIterm2?: boolean // 用户偏好：始终使用 tmux 而非 iTerm2 分屏

  // 自动补全排名的技能使用情况追踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方市场自动安装追踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否已尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（若适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 最后一次尝试的时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 最早可重试的时间

  // Claude in Chrome 设置
  hasCompletedClaudeInChromeOnboarding?: boolean // Claude in Chrome 引导是否已展示过
  claudeInChromeDefaultEnabled?: boolean // Claude in Chrome 是否默认启用（undefined 表示使用平台默认值）
  cachedChromeExtensionInstalled?: boolean // Chrome 扩展是否已安装的缓存结果

  // Chrome 扩展配对状态（跨会话持久化）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP 插件推荐偏好
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件推荐
  lspRecommendationNeverPlugins?: string[] // 永不推荐的插件 ID 列表
  lspRecommendationIgnoredCount?: number // 已忽略推荐的次数（达到 5 次后停止推荐）

  // Claude Code 提示协议状态（来自 CLI/SDK 的 <claude-code-hint /> 标签）。
  // 按提示类型嵌套，便于未来扩展（docs、mcp 等）而无需新增顶层键。
  claudeCodeHints?: {
    // 用户已被提示过的插件 ID。一次性展示语义：
    // 无论 yes/no 响应均记录，不再重复提示。最多 100 条以限制配置增长——
    // 超过后完全停止提示。
    plugin?: string[]
    // 用户在对话框中选择了"不再显示插件安装提示"。
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 是否启用 Haiku 生成的权限请求解释（默认 true）

  // 队友生成模式：'auto' | 'tmux' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'in-process' // 队友的生成方式（默认：'auto'）
  // 工具调用未传递模型时新队友使用的模型。
  // undefined = 硬编码 Opus（向后兼容）；null = 领队模型；string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 特性门控）
  prStatusFooterEnabled?: boolean // 是否在页脚显示 PR 审查状态（默认 true）

  // Tmux 实时面板可见性（仅限内部，通过 Enter 键在 tmux 圆形标识上切换）
  tungstenPanelVisible?: boolean

  // 来自 API 的组织级快速模式状态缓存。
  // 用于检测跨会话变更并通知用户。
  penguinModeOrgEnabled?: boolean

  // 后台刷新最后运行时间（快速模式、配额、通行证、客户端数据）的纪元毫秒数。
  // 与 tengu_cicada_nap_ms 配合使用，限制 API 调用频率
  startupPrefetchedAt?: number

  // 启动时运行远程控制（需要 BRIDGE_MODE）
  // undefined = 使用默认值（优先级规则见 getRemoteControlAtStartup()）
  remoteControlAtStartup?: boolean

  // 来自最后一次 API 响应的额外用量禁用原因缓存
  // undefined = 无缓存，null = 额外用量已启用，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知追踪（仅限内部）
  autoPermissionsNotificationCount?: number // 自动权限通知已展示的次数

  // 推测执行配置（仅限内部）
  speculationEnabled?: boolean // 是否启用推测执行（默认 true）


  // 服务端实验的客户端数据（启动引导阶段获取）。
  clientDataCache?: Record<string, unknown> | null

  // 模型选择器的附加模型选项（启动引导阶段获取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // 组织级设置变化频率低；跨进程持久化可避免每次 `claude -p` 调用时冷启动 API。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 最后一次应用的迁移集版本。等于 CURRENT_MIGRATION_VERSION 时，
  // runMigrations() 跳过所有同步迁移，避免每次启动执行 11× saveGlobalConfig 的锁+重读操作。
  migrationVersion?: number
}

/**
 * GlobalConfig 的工厂函数，每次调用返回全新的默认配置对象。
 * 使用工厂函数而非深克隆常量——嵌套容器（数组、Record）均为空值，
 * 工厂函数以零克隆代价提供全新引用，避免多处共享同一对象。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查当前工作目录是否已通过信任对话框确认。
 *
 * 本函数向上遍历父目录，检查是否有父目录已被信任。
 * 对目录授予信任意味着其所有子目录也被隐式信任。
 *
 * @returns 是否已接受信任对话框（即"不应再次显示"）
 */
// 会话级信任锁存标志：一旦为 true 永不回退，避免重复计算
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

/**
 * 检查当前会话是否已接受信任对话框，带单向锁存优化。
 * 信任状态在一次会话中只会 false→true（不会反向），
 * 因此一旦为 true 即锁存；false 不缓存，确保每次调用都能感知到
 * 用户在会话途中接受信任的操作。
 */
export function checkHasTrustDialogAccepted(): boolean {
  // 信任只会 false→true，锁存后直接返回，无需重复计算。
  // false 不缓存——每次调用都重新检查，以便在会话中途接受信任时立即生效。
  // （lodash memoize 不适用，因为它也会缓存 false）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

/**
 * 计算当前工作目录的信任对话框接受状态。
 * 依次检查：会话内存信任 → git 根/cwd 持久化信任 → 向上遍历父目录的持久化信任。
 */
function computeTrustDialogAccepted(): boolean {
  // 检查会话级信任（主目录场景：信任不写入磁盘，仅在内存中保存）
  // 从 home 目录运行时，信任接受仅保存在内存，允许 hooks 等特性在本次会话内正常工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 优先检查 saveCurrentProjectConfig 写入信任的主要位置（git 根或原始 cwd）
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 从当前工作目录逐级向上遍历父目录，检查持久化信任
  // 路径规范化后再查 JSON key，确保匹配一致性
  let currentPath = normalizePathForConfigKey(getCwd())

  // 向上遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 到达根目录时（父路径与当前路径相同）停止遍历
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录（非当前 cwd）是否受信任。
 * 从 `dir` 向上遍历祖先目录，只要有任意祖先持久化了信任即返回 true。
 * 与 checkHasTrustDialogAccepted 不同，此函数不检查会话信任和 memoized 项目路径——
 * 用于目标目录与当前 cwd 不同的场景（如 /assistant 安装到用户指定路径时）。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// 由于 Jest 不支持 mock ES 模块，测试专用配置只能放在此处
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测将 `fresh`（磁盘重读的配置）写回是否会丢失内存缓存中尚存的认证/入门状态。
 * 当 getConfig 读到损坏或截断的文件（来自另一进程的并发写或非原子回退路径）时
 * 会返回 DEFAULT_GLOBAL_CONFIG，若此时写回则会永久抹除认证信息。详见 GH #3117。
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  // 缓存有 oauthAccount 但新读取没有 → 会丢失 OAuth 认证
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  // 缓存已完成入门引导，但新读取显示未完成 → 会丢失入门状态
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

/**
 * 通过 updater 函数更新全局配置，并将结果持久化到磁盘。
 * - 测试环境：直接修改内存中的测试配置对象，跳过磁盘操作。
 * - 正常环境：通过 saveConfigWithLock 以锁文件方式安全写入；
 *   写入前过滤旧版 project.history 字段（已迁移到 history.jsonl）；
 *   写入成功后写透到内存缓存；锁失败时回退到无锁写入，
 *   但仍受 auth-loss guard 保护（GH #3117）。
 */
export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // updater 返回同一引用表示无变化，跳过
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // updater 返回同一引用表示无变化，跳过写入
        if (config === current) {
          return current
        }
        // 写入前清除 project.history 旧字段（已迁移到 history.jsonl）
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // 仅在实际写入时才写透缓存。若 auth-loss guard 触发或 updater 无变化，
    // 文件未被修改，缓存仍有效——此时写透会破坏 guard 所依赖的良好缓存状态。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // 锁文件失败时回退到无锁写入。这是一个竞态窗口：若另一进程正在写入
    // 或文件被截断，getConfig 会返回默认值。为避免抹除认证信息，
    // 若发现重读的配置缺少缓存中的认证数据，则拒绝写入。详见 GH #3117。
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // updater 返回同一引用表示无变化，跳过
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置内存缓存：config 为 null 表示首次加载前，mtime 为最后写入时间戳（ms）
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// 用于遥测的文件读取统计：mtime 和 size 用于检测 stale write（并发写入检测）
let lastReadFileStats: { mtime: number; size: number } | null = null
// 缓存命中/未命中计数，每次 reportConfigCacheStats 后清零
let configCacheHits = 0
let configCacheMisses = 0
// 本次会话中实际写入全局配置文件的总次数。
// 暴露给 ant-only 开发诊断（inc-4552），以便在写入频率异常时于 UI 中提前发现，
// 防止 ~/.claude.json 被损坏。
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

/**
 * 将配置缓存命中/未命中统计上报给 Statsig，并在上报后清零计数器。
 * 在会话结束的 cleanup 钩子中自动调用。
 */
function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  // 上报后清零，避免重复计算
  configCacheHits = 0
  configCacheMisses = 0
}

// 会话结束时上报缓存命中率统计
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * 将旧版 autoUpdaterStatus 字段迁移到新版 installMethod 和 autoUpdates 字段。
 * 迁移规则：
 * - 'migrated' → installMethod: 'local'（本地安装）
 * - 'installed' → installMethod: 'native'（原生安装）
 * - 'disabled' → autoUpdates: false（禁用自动更新）
 * - 'enabled'/'no_permissions'/'not_configured' → installMethod: 'global'（全局安装）
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // 已迁移（有 installMethod）则直接返回
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus 已从类型中移除，但旧配置中可能还存在
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // 根据旧字段推断安装方式和自动更新偏好
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // 默认启用，除非显式关闭

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // 已禁用时无法确定安装方式
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // 这些状态意味着全局安装
      installMethod = 'global'
      break
    case undefined:
      // 没有旧字段，保持默认值
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * 从 projects 配置中删除已迁移到 history.jsonl 的旧版 history 字段。
 * 仅在存在需要清理的条目时才创建新对象，无需清理时返回原引用。
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history 已从类型中移除，但旧配置中可能还存在
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      // 解构剔除 history 字段
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  // 无需清理时返回原引用，避免不必要的对象创建
  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile 轮询间隔（毫秒）：用于检测其他进程写入全局配置文件
const CONFIG_FRESHNESS_POLL_MS = 1000
// 防重复启动标志，确保 watcher 只注册一次
let freshnessWatcherStarted = false

/**
 * 启动全局配置文件的新鲜度监视器（fs.watchFile 轮询）。
 * 在 libuv 线程池上异步 stat，mtime 变化时异步读取新内容并更新内存缓存。
 * 幂等：只启动一次；测试环境跳过。
 *
 * 自有写入的去重：writeThroughGlobalConfigCache 记录的 mtime 使用 Date.now()，
 * 略晚于文件实际 mtime，因此 curr.mtimeMs <= cache.mtime 会跳过自己触发的回调，
 * 避免不必要的磁盘读取。
 */
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // 自有写入也会触发此回调——write-through 的 Date.now() 超前使得
      // cache.mtime > file mtime，因此 <= 条件可跳过自身写入。
      // Bun/Node 在文件不存在时（初始回调或删除后）触发 curr.mtimeMs=0，
      // <= 条件同样可处理此情况。
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // 读取期间 write-through 可能已推进缓存，避免回退到 watchFile 快照的旧状态
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          // 解析成功后合并默认值并执行字段迁移，更新内存缓存
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  // 会话结束时注销 watcher，避免资源泄漏
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

/**
 * 写透缓存：将刚写入磁盘的配置直接设置为内存缓存，
 * 同时将 mtime 设为 Date.now()，使其略晚于文件实际 mtime，
 * 确保 freshness watcher 在下次轮询时跳过这次自有写入。
 */
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  // 写透后重置文件统计，下次 stale write 检测将重新读取
  lastReadFileStats = null
}

/**
 * 获取全局配置，带两级路径优化：
 * - 快速路径（内存缓存已填充）：直接返回，无 I/O；
 *   自有写入通过 writeThroughGlobalConfigCache 保持最新，
 *   其他实例的写入由 freshness watcher 在后台异步更新缓存。
 * - 慢速路径（首次加载）：同步读取磁盘，执行字段迁移，填充缓存，
 *   启动 freshness watcher。此路径只运行一次，且在 UI 渲染前完成，
 *   同步 I/O 可接受。
 */
export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读。启动后此分支几乎总是命中——
  // 自有写入走 write-through，其他实例的写入由 freshness watcher 更新，
  // 此路径永不阻塞。
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // 慢速路径：启动时加载。同步 I/O 仅发生一次（UI 渲染前）可接受。
  // 先 stat 再读取：若竞态导致 mtime 偏旧，watcher 在下次轮询时自我修正。
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // 文件不存在，使用 Date.now() 作为初始 mtime
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    // 启动后台 freshness watcher，感知其他进程的写入
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 出现异常时回退到无缓存模式
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/**
 * 返回 remoteControlAtStartup 的有效值，按优先级依次检查：
 * 1. 用户显式配置（始终优先，尊重用户的 opt-out 选择）
 * 2. CCR 自动连接默认值（仅限 ant-only 构建，受 GrowthBook 功能门控）
 * 3. false（远程控制必须由用户显式开启）
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

/**
 * 查询截断 API Key 的用户响应状态：approved（已批准）、rejected（已拒绝）或 new（首次出现）。
 * 用于在用户首次使用自定义 API Key 时弹出授权对话框，并记住用户选择。
 */
export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

/**
 * 将配置对象写入磁盘（非锁文件版本，供 saveGlobalConfig 回退路径使用）。
 * 写入前用 lodash pickBy 过滤掉与默认值相同的字段，减少文件体积；
 * 使用 mode 0o600 确保文件仅所有者可读写。
 */
function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // 确保目标目录存在（FsOperations 的 mkdirSync 已是递归实现）
  const dir = dirname(file)
  const fs = getFsImplementation()
  fs.mkdirSync(dir)

  // 过滤掉与默认值相同的字段，只保存差异部分
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 以安全权限（0o600）写入配置文件，mode 仅对新建文件生效
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  // 仅统计全局配置文件的写入次数（用于诊断）
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * 通过锁文件安全写入配置，防止多 Claude 实例并发覆盖。
 * 流程：获取锁 → 检测 stale write → auth-loss guard → 应用 mergeFn → 备份旧文件 → 写入新文件。
 *
 * @returns true 表示实际执行了写入；false 表示跳过（无变化或 auth-loss guard 触发）。
 * 调用方依据返回值决定是否使缓存失效——跳过写入时不应触碰缓存，否则会破坏 guard 所依赖的有效缓存状态。
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（FsOperations 的 mkdirSync 已是递归实现）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // 默认的 onCompromised 会在 setTimeout 回调中抛出异常，变成未处理异常。
        // 改为日志记录——锁被抢占（例如事件循环停顿 10 秒后）是可恢复的情况。
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    // 锁等待超过 100ms 说明有其他 Claude 实例在写入，记录遥测
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // stale write 检测：自上次读取以来文件是否已被其他进程修改
    // 仅对全局配置文件检测（lastReadFileStats 专用于该文件）
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          // 记录 stale write 遥测事件（不阻止写入，仅供后续分析）
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // 文件不存在，无需 stale 检测
      }
    }

    // 重新读取当前配置以获取最新状态。若文件因并发写入或写入中途被 kill 而损坏，
    // getConfig 会返回默认值——此时不能写回，否则会覆盖良好的配置。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.claude.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // 应用 mergeFn 得到合并后的配置
    const mergedConfig = mergeFn(currentConfig)

    // mergeFn 返回同一引用表示无变化，跳过写入
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉与默认值相同的字段，减少文件体积
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 写入前创建带时间戳的备份，防止重置/损坏覆盖好的备份。
    // 备份存储在 ~/.claude/backups/，保持 home 目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 检查是否存在近期备份——启动时多次 saveGlobalConfig 调用在毫秒内触发，
      // 无此检查会在磁盘上堆积大量备份文件。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最新优先（时间戳按字典序排列）

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      // 距上次备份不足 60 秒时跳过，避免短时间内重复备份
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // 清理旧备份，仅保留最近 5 个
      const MAX_BACKUPS = 5
      // 重新获取备份列表（若刚创建了新备份）；否则复用前面获取的列表
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter(f => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      // 超出数量限制的旧备份予以删除
      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // 忽略备份清理失败，不影响主流程
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${e}`, {
          level: 'error',
        })
      }
      // 文件不存在或备份失败，继续执行写入
    }

    // 以安全权限（0o600）写入配置文件，mode 仅对新建文件生效
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 标志位：控制配置读取是否被允许（防止模块初始化期间过早读取配置）
let configReadingAllowed = false

/**
 * 开启配置读取权限，并预热全局配置（同步读取 ~/.claude.json）。
 * 幂等：多次调用安全，只有第一次调用会真正执行初始化。
 * 在应用启动流程中，此函数必须在任何配置读取之前调用；
 * 若在此之前尝试读取配置，控制台会输出警告以帮助发现问题。
 */
export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 幂等保护：已启用则直接返回
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 设置标志位后，之前触发的配置读取警告将消失
  configReadingAllowed = true
  // 目前所有配置共用同一个文件，只需检查全局配置
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * 返回配置备份文件的存储目录（~/.claude/backups/），
 * 统一存放备份文件以保持 home 目录整洁。
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

/**
 * 查找给定配置文件的最新备份文件。
 * 优先检查 ~/.claude/backups/，若不存在则回退到旧路径
 * （配置文件同级目录）以保持向后兼容。
 * 返回最新备份的完整路径，若不存在则返回 null。
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 优先检查新备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  // 回退到旧路径（配置文件同级目录）
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // 检查旧版备份文件（无时间戳）
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // 旧版备份不存在
    }
  } catch {
    // 忽略读取目录时的错误
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // 若配置在允许之前被访问，记录警告
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 解析前去除 BOM —— PowerShell 5.x 会在 UTF-8 文件中添加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 以文件路径和默认配置抛出 ConfigParseError
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件不存在的情况 —— 检查备份并返回默认值
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nClaude configuration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // 若 throwOnInvalid 为 true，重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误，以便用户了解情况
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // 守护：logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // 在配置文件损坏时会造成无限递归，因为
      // 采样检查从全局配置读取 GrowthBook 特性。
      // 仅在最外层调用时记录分析事件。
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // 记录错误以供监控
          logError(error)

          // 记录配置损坏的分析事件
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // 无备份
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )

      // 尝试备份已损坏的配置文件（仅在尚未备份时执行）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏内容是否与任何现有备份匹配
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // 忽略读取备份时的错误
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `Corrupted config backed up to: ${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // 忽略备份错误
        }
      }

      // 通知用户配置损坏及可用备份情况
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `The corrupted file has been backed up to: ${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`The corrupted file has already been backed up.\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// 用于配置查找的项目路径 memoize 函数
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 统一格式化以生成一致的 JSON 键（所有平台使用正斜杠）
    // 确保 C:\Users\... 和 C:/Users/... 映射到相同的键
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // 不确定为何变成了字符串
  // TODO: 修复上游问题
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 若无变更（返回相同引用），跳过写入
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // 若无变更（返回相同引用），跳过写入
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // 与 saveGlobalConfig 回退逻辑相同的竞态窗口 —— 拒绝用默认值覆盖良好的缓存配置。参见 GH #3117。
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 若无变更（返回相同引用），跳过写入
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * 若应跳过插件自动更新则返回 true。
 * 检查自动更新器是否已禁用，且 FORCE_AUTOUPDATE_PLUGINS 环境变量
 * 未设置为 'true'。该环境变量可在自动更新器被禁用时
 * 强制执行插件自动更新。
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem 仅在 feature('TEAMMEM') 为 true 时是有效的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 在外部构建中不可达，因为 TeamMem 不在 MemoryType 中
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// 仅供测试导出
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
