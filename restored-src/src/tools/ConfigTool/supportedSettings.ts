/**
 * ConfigTool/supportedSettings.ts
 *
 * 【在系统中的位置】
 * 本文件是 ConfigTool 的核心配置注册表，定义了 Claude Code 中所有可供 AI 模型
 * 读写的用户配置项（Settings）。ConfigTool.ts 和 prompt.ts 均直接依赖本文件。
 *
 * 【主要功能】
 * 1. 定义 SettingConfig 类型，描述每个配置项的元数据：
 *    - source：存储后端（'global' = ~/.claude.json，'settings' = settings.json）
 *    - type：值类型（boolean / string）
 *    - options / getOptions：枚举型选项列表（静态或动态获取）
 *    - appStateKey：写入后需同步的 AppState 字段名
 *    - validateOnWrite：写入前异步校验钩子
 *    - formatOnRead：读取时的展示转换钩子
 * 2. SUPPORTED_SETTINGS：所有可配置项的注册表（Record<string, SettingConfig>）
 *    - 部分配置项通过 feature() 构建时标志条件注册（VOICE_MODE、BRIDGE_MODE、KAIROS 等）
 *    - 部分配置项仅对 Anthropic 内部用户开放（USER_TYPE === 'ant'）
 * 3. 导出辅助函数：isSupported、getConfig、getAllKeys、getOptionsForSetting、getPath
 */

import { feature } from 'bun:bundle'
import { getRemoteControlAtStartup } from '../../utils/config.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from '../../utils/configConstants.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { THEME_NAMES, THEME_SETTINGS } from '../../utils/theme.js'

/** 可立即同步到 AppState 的字段键名集合（写入配置后触发 UI 即时刷新） */
type SyncableAppStateKey = 'verbose' | 'mainLoopModel' | 'thinkingEnabled'

/** 单个配置项的元数据描述 */
type SettingConfig = {
  source: 'global' | 'settings'    // 存储后端
  type: 'boolean' | 'string'       // 值类型
  description: string              // 在提示词中展示的说明文字
  path?: string[]                  // 嵌套存储路径（默认按 "." 分割键名）
  options?: readonly string[]      // 静态枚举选项
  getOptions?: () => string[]      // 动态获取枚举选项（如运行时模型列表）
  appStateKey?: SyncableAppStateKey // 写入后需同步的 AppState 键名
  /** 写入/设置值时的异步校验钩子 */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** 读取/获取值时的展示格式化钩子 */
  formatOnRead?: (v: unknown) => unknown
}

/**
 * 所有可配置项的注册表。
 * 键名即配置键（如 "theme"、"permissions.defaultMode"），值为 SettingConfig。
 * 某些配置项通过 Bun 构建时标志（feature()）或运行时环境变量条件注册。
 */
export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  // UI 主题：根据是否启用 AUTO_THEME 特性选择不同的选项集
  theme: {
    source: 'global',
    type: 'string',
    description: 'Color theme for the UI',
    options: feature('AUTO_THEME') ? THEME_SETTINGS : THEME_NAMES,
  },
  // 编辑器键位绑定模式（normal / vim / emacs 等）
  editorMode: {
    source: 'global',
    type: 'string',
    description: 'Key binding mode',
    options: EDITOR_MODES,
  },
  // 详细调试输出开关，写入后立即同步 AppState.verbose
  verbose: {
    source: 'global',
    type: 'boolean',
    description: 'Show detailed debug output',
    appStateKey: 'verbose',
  },
  // 通知渠道偏好（terminal / system 等）
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: 'Preferred notification channel',
    options: NOTIFICATION_CHANNELS,
  },
  // 上下文满时自动压缩会话
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Auto-compact when context is full',
  },
  // 自动记忆功能（AI 自动提炼重要信息到 CLAUDE.md）
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable auto-memory',
  },
  // 后台记忆整合（dream 模式，异步归纳长期知识）
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable background memory consolidation',
  },
  // 文件检查点（代码回滚 rewind 功能的基础）
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable file checkpointing for code rewind',
  },
  // 显示每次对话轮次耗时
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      'Show turn duration message after responses (e.g., "Cooked for 1m 6s")',
  },
  // 在支持 OSC 9;4 的终端显示进度条
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Show OSC 9;4 progress indicator in supported terminals',
  },
  // Todo/任务追踪功能开关
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable todo/task tracking',
  },
  // 模型覆盖：动态获取可用模型列表，写入时校验模型 ID，读取时 null 显示为 "default"
  model: {
    source: 'settings',
    type: 'string',
    description: 'Override the default model',
    appStateKey: 'mainLoopModel',
    getOptions: () => {
      try {
        // 过滤掉 value=null 的"默认模型"占位项
        return getModelOptions()
          .filter(o => o.value !== null)
          .map(o => o.value as string)
      } catch {
        // 降级：返回最常用的三个模型名称
        return ['sonnet', 'opus', 'haiku']
      }
    },
    validateOnWrite: v => validateModel(String(v)),
    formatOnRead: v => (v === null ? 'default' : v),
  },
  // 扩展思考模式（extended thinking）全局开关
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable extended thinking (false to disable)',
    appStateKey: 'thinkingEnabled',
  },
  // 工具调用默认权限模式；TRANSCRIPT_CLASSIFIER 特性开启时增加 'auto' 选项
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: 'Default permission mode for tool usage',
    options: feature('TRANSCRIPT_CLASSIFIER')
      ? ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']
      : ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  // Claude 回复语言及语音听写语言偏好
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")',
  },
  // 队友（teammate）生成方式：tmux / in-process / auto
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      'How to spawn teammates: "tmux" for traditional tmux, "in-process" for same process, "auto" to choose automatically',
    options: TEAMMATE_MODES,
  },
  // ── 仅限 Anthropic 内部用户（USER_TYPE === 'ant'）──────────────────────
  ...(process.env.USER_TYPE === 'ant'
    ? {
        // Bash 权限规则 AI 分类器开关（仅 ant 可见）
        classifierPermissionsEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description:
            'Enable AI-based classification for Bash(prompt:...) permission rules',
        },
      }
    : {}),
  // ── 构建时 VOICE_MODE 特性标志控制 ────────────────────────────────────
  ...(feature('VOICE_MODE')
    ? {
        // 语音听写（按住说话）功能开关
        voiceEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description: 'Enable voice dictation (hold-to-talk)',
        },
      }
    : {}),
  // ── 构建时 BRIDGE_MODE 特性标志控制 ───────────────────────────────────
  ...(feature('BRIDGE_MODE')
    ? {
        // 远程控制启动开关（true | false | "default" 特殊值）
        remoteControlAtStartup: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Enable Remote Control for all sessions (true | false | default)',
          // formatOnRead 始终返回平台感知后的实际值（忽略传入的 v）
          formatOnRead: () => getRemoteControlAtStartup(),
        },
      }
    : {}),
  // ── 构建时 KAIROS / KAIROS_PUSH_NOTIFICATION 特性标志控制 ─────────────
  ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? {
        // Claude 空闲完成后向手机推送通知（需要远程控制）
        taskCompleteNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when idle after Claude finishes (requires Remote Control)',
        },
        // 等待权限确认或问题回复时向手机推送通知
        inputNeededNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when a permission prompt or question is waiting (requires Remote Control)',
        },
        // 允许 Claude 自主判断时机向手机推送通知
        agentPushNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Allow Claude to push to your mobile device when it deems it appropriate (requires Remote Control)',
        },
      }
    : {}),
}

/** 判断给定键名是否为已注册的配置项 */
export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

/** 根据键名获取配置项元数据，不存在则返回 undefined */
export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

/** 获取所有已注册配置项的键名列表 */
export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_SETTINGS)
}

/**
 * 获取指定配置项的枚举选项列表。
 * 优先使用静态 options，否则调用动态 getOptions()；不适用则返回 undefined。
 */
export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

/**
 * 获取配置项的存储路径数组。
 * 若 SettingConfig 未显式指定 path，则按 "." 分割键名作为路径（如 "permissions.defaultMode" → ['permissions', 'defaultMode']）。
 */
export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split('.')
}
