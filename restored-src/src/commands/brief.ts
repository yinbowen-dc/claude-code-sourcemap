/**
 * /brief 命令实现模块。
 *
 * 在 Claude Code 的 Kairos 输出模式管理流程中，此文件实现了 /brief 命令，
 * 允许用户切换"Brief-only 模式"。启用该模式后，Claude 的所有用户可见输出
 * 必须通过 BriefTool 发送，直接输出的纯文本将被过滤器隐藏。
 *
 * 此命令由 GrowthBook 特性标志 tengu_kairos_brief_config 控制可见性，
 * 且只有满足权限条件（isBriefEntitled）的用户才能开启该模式。
 * 关闭模式始终允许，以避免用户在会话中途被卡住。
 *
 * 对应命令：/brief（无参数，每次调用切换开关状态）
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '../tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '../tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod guards against fat-fingered GB pushes (same pattern as pollConfig.ts /
// cronScheduler.ts). A malformed config falls back to DEFAULT_BRIEF_CONFIG
// entirely rather than being partially trusted.
// 使用 Zod 对 GrowthBook 配置进行类型校验，防止推送格式错误的配置导致运行时崩溃
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

// 默认配置：斜杠命令默认不启用，需通过 GrowthBook 特性标志显式开启
const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// No TTL — this gate controls slash-command *visibility*, not a kill switch.
// CACHED_MAY_BE_STALE still has one background-update flip (first call kicks
// off fetch; second call sees fresh value), but no additional flips after that.
// The tool-availability gate (tengu_kairos_brief in isBriefEnabled) keeps its
// 5-min TTL because that one IS a kill switch.
/**
 * 从 GrowthBook 获取 Brief 命令的可见性配置。
 *
 * 使用无 TTL 的缓存策略（控制命令可见性，非 kill-switch），
 * 若配置格式不合法则回退到默认值，确保降级安全。
 *
 * @returns 经过 Zod 校验的 BriefConfig 对象
 */
function getBriefConfig(): BriefConfig {
  // 从 GrowthBook 读取原始配置值（可能已过期，但可见性不需要强一致性）
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  // Zod 解析失败时安全回退，不抛出异常
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

/**
 * /brief 命令注册描述符与内联实现。
 *
 * isEnabled 同时检查编译期 KAIROS/KAIROS_BRIEF 特性标志和运行时 GrowthBook 配置，
 * 确保此命令只在 Kairos 系列实验中且配置明确启用时才对用户可见。
 * immediate=true 表示切换操作立即生效，无需等待 AI 轮次完成。
 */
const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: 'Toggle brief-only mode',
  isEnabled: () => {
    // 检查编译期特性标志，两个 Kairos 实验中任意一个满足即可
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      // 进一步检查 GrowthBook 运行时配置是否开启了斜杠命令入口
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  // 立即执行：切换模式无需等待 AI 响应
  immediate: true,
  load: () =>
    Promise.resolve({
      /**
       * Brief 模式切换的核心逻辑。
       *
       * 流程：
       * 1. 读取当前 isBriefOnly 状态并取反，确定切换目标
       * 2. 开启时检查用户权限（isBriefEntitled），无权限则拒绝并记录分析事件
       * 3. 同步更新 userMsgOptIn 标志（控制 BriefTool 是否出现在工具列表中）
       * 4. 更新 AppState（幂等：状态未变则不触发重渲染）
       * 5. 向下一轮对话注入 system-reminder，确保模型感知到工具列表的变化
       *
       * @param onDone 命令完成时向 UI 注入系统消息的回调
       * @param context 命令执行上下文，含 AppState 读写能力
       */
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        // 读取当前状态并取反，实现切换语义
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // Entitlement check only gates the on-transition — off is always
        // allowed so a user whose GB gate flipped mid-session isn't stuck.
        // 仅在"开启"时检查权限；"关闭"始终允许，防止用户被卡住
        if (newState && !isBriefEntitled()) {
          logEvent('tengu_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('Brief tool is not enabled for your account', {
            display: 'system',
          })
          return null
        }

        // Two-way: userMsgOptIn tracks isBriefOnly so the tool is available
        // exactly when brief mode is on. This invalidates prompt cache on
        // each toggle (tool list changes), but a stale tool list is worse —
        // when /brief is enabled mid-session the model was previously left
        // without the tool, emitting plain text the filter hides.
        // 同步更新 userMsgOptIn：控制 BriefTool 是否注入工具列表（会使 prompt cache 失效）
        setUserMsgOptIn(newState)

        // 幂等更新 AppState，避免不必要的重渲染
        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        // 记录切换事件至分析系统
        logEvent('tengu_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // The tool list change alone isn't a strong enough signal mid-session
        // (model may keep emitting plain text from inertia, or keep calling a
        // tool that just vanished). Inject an explicit reminder into the next
        // turn's context so the transition is unambiguous.
        // Skip when Kairos is active: isBriefEnabled() short-circuits on
        // getKairosActive() so the tool never actually leaves the list, and
        // the Kairos system prompt already mandates SendUserMessage.
        // Inline <system-reminder> wrap — importing wrapInSystemReminder from
        // utils/messages.ts pulls constants/xml.ts into the bridge SDK bundle
        // via this module's import chain, tripping the excluded-strings check.
        // 构建 system-reminder 消息：明确告知模型工具列表已变化，防止模型因惯性继续用旧方式输出
        // Kairos 激活时不注入（其系统 prompt 已强制要求使用 SendUserMessage）
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>\n${
                newState
                  ? `Brief mode is now enabled. Use the ${BRIEF_TOOL_NAME} tool for all user-facing output — plain text outside it is hidden from the user's view.`
                  : `Brief mode is now disabled. The ${BRIEF_TOOL_NAME} tool is no longer available — reply with plain text.`
              }\n</system-reminder>`,
            ]

        // 向 UI 注入系统通知，并携带 metaMessages 注入到下一轮的对话上下文
        onDone(
          newState ? 'Brief-only mode enabled' : 'Brief-only mode disabled',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
