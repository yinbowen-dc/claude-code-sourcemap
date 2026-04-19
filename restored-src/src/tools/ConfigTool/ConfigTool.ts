/**
 * 【ConfigTool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   ConfigTool 是用户级配置读写工具，AI 通过此工具查询或修改
 *   主题、模型、编辑器模式、权限默认值等设置。
 *   支持两种存储后端：
 *     - global：存储于 ~/.claude.json（通过 saveGlobalConfig）
 *     - settings：存储于项目 settings.json（通过 updateSettingsForSource）
 *   修改后通过 context.setAppState() 立即同步到 UI AppState。
 *
 * 主要功能：
 *   - GET 操作：读取并返回当前配置值
 *   - SET 操作：校验类型/选项 → 异步校验 → 写入存储 → 同步 AppState → 上报事件
 *   - 语音模式特殊前置检查：GrowthBook 开关 + 设备音频权限 + 麦克风授权
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'
import {
  getConfig,
  getOptionsForSetting,
  getPath,
  isSupported,
} from './supportedSettings.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

// 输入 Schema：setting 为配置键（如 "theme"），value 可选，省略时表示 GET 操作
const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe(
        'The setting key (e.g., "theme", "model", "permissions.defaultMode")',
      ),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('The new value. Omit to get current value.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：包含操作结果、新旧值及错误信息（可选）
const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(['get', 'set']).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,           // 工具注册名称 'Config'
  searchHint: 'get or set Claude Code settings (theme, model)',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    // 动态生成工具使用说明文档，包含当前所有可配置项
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Config'
  },
  shouldDefer: true,               // 延迟执行（等待用户批准写操作）
  isConcurrencySafe() {
    return true                    // GET 和 SET 都是并发安全的
  },
  isReadOnly(input: Input) {
    // value 未提供时为只读 GET 操作
    return input.value === undefined
  },
  toAutoClassifierInput(input) {
    // 用于自动分类器：GET 返回键名，SET 返回 "key = value"
    return input.value === undefined
      ? input.setting
      : `${input.setting} = ${input.value}`
  },
  async checkPermissions(input: Input) {
    // Auto-allow reading configs
    if (input.value === undefined) {
      // GET 操作自动放行，无需用户确认
      return { behavior: 'allow' as const, updatedInput: input }
    }
    // SET 操作需要用户确认
    return {
      behavior: 'ask' as const,
      message: `Set ${input.setting} to ${jsonStringify(input.value)}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. 检查该配置项是否受支持
    // 语音设置在构建时注册（feature('VOICE_MODE')），但需要在运行时额外 GrowthBook 检查。
    // 当 kill-switch 开启时，将 voiceEnabled 视为未知设置，避免泄露语音相关字符串。
    if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
      const { isVoiceGrowthBookEnabled } = await import(
        '../../voice/voiceModeEnabled.js'
      )
      if (!isVoiceGrowthBookEnabled()) {
        // GrowthBook 未启用语音功能，返回未知设置错误
        return {
          data: { success: false, error: `Unknown setting: "${setting}"` },
        }
      }
    }
    if (!isSupported(setting)) {
      // 不在 SUPPORTED_SETTINGS 注册表中，直接返回错误
      return {
        data: { success: false, error: `Unknown setting: "${setting}"` },
      }
    }

    const config = getConfig(setting)!  // 获取该设置的元配置（类型、存储路径等）
    const path = getPath(setting)       // 获取配置的存储路径（支持嵌套如 "permissions.defaultMode"）

    // 2. GET 操作：读取并返回当前值
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      // 若有 formatOnRead 格式化函数（如 model 的 null → "default"），则应用
      const displayValue = config.formatOnRead
        ? config.formatOnRead(currentValue)
        : currentValue
      return {
        data: { success: true, operation: 'get', setting, value: displayValue },
      }
    }

    // 3. SET 操作

    // 处理 "default" 特殊值：删除 remoteControlAtStartup 键，使其回退到平台默认值
    if (
      setting === 'remoteControlAtStartup' &&
      typeof value === 'string' &&
      value.toLowerCase().trim() === 'default'
    ) {
      saveGlobalConfig(prev => {
        if (prev.remoteControlAtStartup === undefined) return prev
        const next = { ...prev }
        delete next.remoteControlAtStartup  // 删除键以回退到平台默认
        return next
      })
      const resolved = getRemoteControlAtStartup()
      // 立即同步到 AppState，使 useReplBridge 能即时感知桥接模式变化
      context.setAppState(prev => {
        if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly)
          return prev
        return {
          ...prev,
          replBridgeEnabled: resolved,
          replBridgeOutboundOnly: false,
        }
      })
      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          value: resolved,
        },
      }
    }

    let finalValue: unknown = value

    // 强制转换并校验布尔值：接受 "true"/"false" 字符串
    if (config.type === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }
      if (typeof finalValue !== 'boolean') {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: `${setting} requires true or false.`,
          },
        }
      }
    }

    // 校验枚举选项（如 theme、editorMode 等有固定可选值的设置）
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: `Invalid value "${value}". Options: ${options.join(', ')}`,
        },
      }
    }

    // 异步校验（例如：验证 model 是否为有效的 API 模型）
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: result.error,
          },
        }
      }
    }

    // 语音模式前置检查：仅在启用语音功能且正在将 voiceEnabled 设为 true 时执行
    if (
      feature('VOICE_MODE') &&
      setting === 'voiceEnabled' &&
      finalValue === true
    ) {
      const { isVoiceModeEnabled } = await import(
        '../../voice/voiceModeEnabled.js'
      )
      if (!isVoiceModeEnabled()) {
        // 功能未启用（缺少 Claude.ai 账号 或 功能已关闭）
        const { isAnthropicAuthEnabled } = await import('../../utils/auth.js')
        return {
          data: {
            success: false,
            error: !isAnthropicAuthEnabled()
              ? 'Voice mode requires a Claude.ai account. Please run /login to sign in.'
              : 'Voice mode is not available.',
          },
        }
      }
      const { isVoiceStreamAvailable } = await import(
        '../../services/voiceStreamSTT.js'
      )
      const {
        checkRecordingAvailability,
        checkVoiceDependencies,
        requestMicrophonePermission,
      } = await import('../../services/voice.js')

      // 检查录音环境是否可用（如终端是否支持）
      const recording = await checkRecordingAvailability()
      if (!recording.available) {
        return {
          data: {
            success: false,
            error:
              recording.reason ??
              'Voice mode is not available in this environment.',
          },
        }
      }
      // 检查 VoiceStream 服务是否可用（需要 Claude.ai 账号）
      if (!isVoiceStreamAvailable()) {
        return {
          data: {
            success: false,
            error:
              'Voice mode requires a Claude.ai account. Please run /login to sign in.',
          },
        }
      }
      // 检查录音工具依赖（如 sox、ffmpeg 等）
      const deps = await checkVoiceDependencies()
      if (!deps.available) {
        return {
          data: {
            success: false,
            error:
              'No audio recording tool found.' +
              (deps.installCommand ? ` Run: ${deps.installCommand}` : ''),
          },
        }
      }
      // 检查麦克风权限，并按平台给出访问引导
      if (!(await requestMicrophonePermission())) {
        let guidance: string
        if (process.platform === 'win32') {
          guidance = 'Settings \u2192 Privacy \u2192 Microphone'
        } else if (process.platform === 'linux') {
          guidance = "your system's audio settings"
        } else {
          guidance =
            'System Settings \u2192 Privacy & Security \u2192 Microphone'
        }
        return {
          data: {
            success: false,
            error: `Microphone access is denied. To enable it, go to ${guidance}, then try again.`,
          },
        }
      }
    }

    // 记录修改前的旧值（用于返回 previousValue）
    const previousValue = getValue(config.source, path)

    // 4. 写入存储层
    try {
      if (config.source === 'global') {
        // 全局配置：写入 ~/.claude.json
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: 'Invalid setting path',
            },
          }
        }
        saveGlobalConfig(prev => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }  // 不可变更新
        })
      } else {
        // 项目配置：写入 settings.json，path 可能为嵌套路径（如 ["permissions","defaultMode"]）
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource('userSettings', update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5a. 语音模式特殊处理：通知 settingsChangeDetector 使 settings 缓存失效
      // 确保 AppState.settings 重新同步（useVoiceEnabled 从 settings.voiceEnabled 读取）
      if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
        const { settingsChangeDetector } = await import(
          '../../utils/settings/changeDetector.js'
        )
        settingsChangeDetector.notifyChange('userSettings')
      }

      // 5b. 若配置项关联了 AppState 键，同步到 AppState 以立即更新 UI
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState(prev => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      // 同步 remoteControlAtStartup 到 AppState（该配置键名与 AppState 字段名不同，
      // 无法使用通用 appStateKey 机制，需要手动同步）
      if (setting === 'remoteControlAtStartup') {
        const resolved = getRemoteControlAtStartup()
        context.setAppState(prev => {
          if (
            prev.replBridgeEnabled === resolved &&
            !prev.replBridgeOutboundOnly
          )
            return prev
          return {
            ...prev,
            replBridgeEnabled: resolved,
            replBridgeOutboundOnly: false,
          }
        })
      }

      // 上报配置变更分析事件
      logEvent('tengu_config_tool_changed', {
        setting:
          setting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: String(
          finalValue,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    // 将结构化输出转换为 API tool_result 格式
    if (content.success) {
      if (content.operation === 'get') {
        // GET 成功：返回 "key = value"
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      // SET 成功：返回确认消息
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Set ${content.setting} to ${jsonStringify(content.newValue)}`,
      }
    }
    // 失败：以 is_error 标记返回错误消息
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 从存储层读取配置值
 *
 * @param source - 'global' 读取 ~/.claude.json，'settings' 读取项目 settings.json
 * @param path - 配置路径数组，支持嵌套（如 ["permissions", "defaultMode"]）
 * @returns 配置值，若路径不存在则返回 undefined
 */
function getValue(source: 'global' | 'settings', path: string[]): unknown {
  if (source === 'global') {
    // 全局配置只支持一层路径（顶级键）
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  // 项目配置支持递归嵌套路径遍历
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * 将扁平路径 + 值构建为嵌套对象，用于 updateSettingsForSource 的深层合并
 *
 * 例如：path=["permissions","defaultMode"], value="plan"
 * → { permissions: { defaultMode: "plan" } }
 */
function buildNestedObject(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    // 递归终点：构造单键对象
    return { [key]: value }
  }
  // 递归构建嵌套层
  return { [key]: buildNestedObject(path.slice(1), value) }
}
