/**
 * BriefTool/BriefTool.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件定义 BriefTool（SendUserMessage）工具的完整实现，
 * 是 Claude Code "Brief 模式"（assistant mode / chat 视图）的核心组件。
 * 模型通过此工具将消息发送给用户，是 Brief 模式下模型与用户交互的主要输出通道。
 *
 * 【主要功能】
 * - inputSchema / outputSchema：定义工具的输入（message、attachments、status）
 *   和输出（message、attachments 元数据、sentAt 时间戳）结构。
 * - isBriefEntitled：资格检查——用户是否有权使用 Brief 工具（build flag + GB gate）。
 * - isBriefEnabled：激活检查——当前会话 Brief 工具是否实际启用（资格 + 用户 opt-in）。
 * - BriefTool：工具主体，通过 buildTool 构建，包含完整的工具定义。
 *
 * 【Brief 激活路径】
 * --brief 标志 | defaultView: 'chat' | /brief 命令 | /config | --tools 选项
 * | CLAUDE_CODE_BRIEF 环境变量（dev/testing bypass）| Kairos assistant mode（直接绕过 opt-in）
 *
 * 【DCE 优化说明】
 * feature('KAIROS') || feature('KAIROS_BRIEF') 的顶层 guard 是 Bun DCE 的
 * 关键加载点：在外部构建中可被常量折叠为 false，从而消除整个 BriefTool 对象。
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { plural } from '../../utils/stringUtils.js'
import { resolveAttachments, validateAttachmentPaths } from './attachments.js'
import {
  BRIEF_TOOL_NAME,
  BRIEF_TOOL_PROMPT,
  DESCRIPTION,
  LEGACY_BRIEF_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// inputSchema：BriefTool 的输入参数定义（懒加载，避免 Zod 在模块初始化时被求值）
const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .describe('The message for the user. Supports markdown formatting.'),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        'Optional file paths (absolute or relative to cwd) to attach. Use for photos, screenshots, diffs, logs, or any file the user should see alongside your message.',
      ),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        "Use 'proactive' when you're surfacing something the user hasn't asked for and needs to see now — task completion while they're away, a blocker you hit, an unsolicited status update. Use 'normal' when replying to something the user just said.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// attachments MUST remain optional — resumed sessions replay pre-attachment
// outputs verbatim and a required field would crash the UI renderer on resume.
// attachments 必须为 optional：会话恢复时会逐字重放之前的输出，必填字段会导致 UI 渲染崩溃
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('The message'),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          size: z.number(),
          isImage: z.boolean(),
          file_uuid: z.string().optional(),
        }),
      )
      .optional()
      .describe('Resolved attachment metadata'),
    sentAt: z
      .string()
      .optional()
      .describe(
        'ISO timestamp captured at tool execution on the emitting process. Optional — resumed sessions replay pre-sentAt outputs verbatim.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// Kairos Brief 功能的 GrowthBook 刷新间隔（5 分钟）
const KAIROS_BRIEF_REFRESH_MS = 5 * 60 * 1000

/**
 * isBriefEntitled
 *
 * 【函数作用】
 * Brief 工具资格检查——判断用户是否有权使用 Brief 工具。
 * 此检查不涉及用户是否已 opt-in，仅确认 opt-in 是否应被允许。
 *
 * 【资格条件（任一满足即可）】
 *   1. getKairosActive() = true（Kairos assistant mode 已激活）
 *   2. CLAUDE_CODE_BRIEF 环境变量为真值（dev/testing bypass，跳过 GB gate）
 *   3. GrowthBook 特性标志 tengu_kairos_brief = true（外部用户 AB 测试枚举）
 *
 * 【构建时 DCE 说明】
 * 使用正向三元表达式而非负向 early return，以便 Bun 在外部构建中
 * 将整个表达式常量折叠为 false，消除 GB gate 字符串引用。
 *
 * Entitlement check — is the user ALLOWED to use Brief? Combines build-time
 * flags with runtime GB gate + assistant-mode passthrough. No opt-in check
 * here — this decides whether opt-in should be HONORED, not whether the user
 * has opted in.
 *
 * Build-time OR-gated on KAIROS || KAIROS_BRIEF (same pattern as
 * PROACTIVE || KAIROS): assistant mode depends on Brief, so KAIROS alone
 * must bundle it. KAIROS_BRIEF lets Brief ship independently.
 *
 * Use this to decide whether `--brief` / `defaultView: 'chat'` / `--tools`
 * listing should be honored. Use `isBriefEnabled()` to decide whether the
 * tool is actually active in the current session.
 *
 * CLAUDE_CODE_BRIEF env var force-grants entitlement for dev/testing —
 * bypasses the GB gate so you can test without being enrolled. Still
 * requires an opt-in action to activate (--brief, defaultView, etc.), but
 * the env var alone also sets userMsgOptIn via maybeActivateBrief().
 */
export function isBriefEntitled(): boolean {
  // Positive ternary — see docs/feature-gating.md. Negative early-return
  // would not eliminate the GB gate string from external builds.
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? getKairosActive() ||
        isEnvTruthy(process.env.CLAUDE_CODE_BRIEF) ||
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_brief',
          false,
          KAIROS_BRIEF_REFRESH_MS,
        )
    : false
}

/**
 * isBriefEnabled
 *
 * 【函数作用】
 * Brief 工具激活检查——判断当前会话中 Brief 工具是否实际可用。
 * 结合资格检查（isBriefEntitled）和用户 opt-in 状态。
 *
 * 【激活条件】
 *   (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
 *   - Kairos assistant mode：绕过 opt-in，直接要求使用 SendUserMessage
 *   - 普通用户：需要显式 opt-in（通过上述激活路径之一）且通过资格检查
 *
 * 【GB kill-switch 说明】
 * GB 特性标志在 isBriefEntitled() 中重新检查（含 5 分钟刷新缓存），
 * 可在会话进行中通过关闭 tengu_kairos_brief 来禁用已 opt-in 的会话。
 * 没有 opt-in → 无论 GB 状态如何始终返回 false（修复"enrolled ant 默认开启 brief"问题）。
 *
 * 【DCE 说明】
 * 顶层 feature() guard 保证 Bun 在外部构建中可将此函数常量折叠为 false。
 * 单独组合 isBriefEntitled()（有自己的 guard）在语义上等价，但破坏跨边界的常量折叠。
 *
 * Unified activation gate for the Brief tool. Governs model-facing behavior
 * as a unit: tool availability, system prompt section (getBriefSection),
 * tool-deferral bypass (isDeferredTool), and todo-nag suppression.
 *
 * Activation requires explicit opt-in (userMsgOptIn) set by one of:
 *   - `--brief` CLI flag (maybeActivateBrief in main.tsx)
 *   - `defaultView: 'chat'` in settings (main.tsx init)
 *   - `/brief` slash command (brief.ts)
 *   - `/config` defaultView picker (Config.tsx)
 *   - SendUserMessage in `--tools` / SDK `tools` option (main.tsx)
 *   - CLAUDE_CODE_BRIEF env var (maybeActivateBrief — dev/testing bypass)
 * Assistant mode (kairosActive) bypasses opt-in since its system prompt
 * hard-codes "you MUST use SendUserMessage" (systemPrompt.md:14).
 *
 * The GB gate is re-checked here as a kill-switch AND — flipping
 * tengu_kairos_brief off mid-session disables the tool on the next 5-min
 * refresh even for opted-in sessions. No opt-in → always false regardless
 * of GB (this is the fix for "brief defaults on for enrolled ants").
 *
 * Called from Tool.isEnabled() (lazy, post-init), never at module scope.
 * getKairosActive() and getUserMsgOptIn() are set in main.tsx before any
 * caller reaches here.
 */
export function isBriefEnabled(): boolean {
  // Top-level feature() guard is load-bearing for DCE: Bun can constant-fold
  // the ternary to `false` in external builds and then dead-code the BriefTool
  // object. Composing isBriefEntitled() alone (which has its own guard) is
  // semantically equivalent but defeats constant-folding across the boundary.
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
    : false
}

/**
 * BriefTool
 *
 * 【说明】
 * SendUserMessage 工具的实现对象，由 buildTool 工厂函数构建。
 * 这是 Brief 模式下模型向用户发送消息的唯一标准通道。
 *
 * 【工具特性】
 * - 并发安全（isConcurrencySafe: true）：可与其他工具并发执行
 * - 只读（isReadOnly: true）：不修改文件系统
 * - 支持历史别名 'Brief'（LEGACY_BRIEF_TOOL_NAME），兼容旧会话序列化
 * - call 方法记录分析事件（proactive 状态、附件数量），并解析附件元数据
 */
export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  aliases: [LEGACY_BRIEF_TOOL_NAME],
  searchHint:
    'send a message to the user — your primary visible output channel',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return ''
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isBriefEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async validateInput({ attachments }, _context): Promise<ValidationResult> {
    if (!attachments || attachments.length === 0) {
      return { result: true }
    }
    return validateAttachmentPaths(attachments)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return BRIEF_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const n = output.attachments?.length ?? 0
    const suffix = n === 0 ? '' : ` (${n} ${plural(n, 'attachment')} included)`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Message delivered to user.${suffix}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ message, attachments, status }, context) {
    const sentAt = new Date().toISOString()
    logEvent('tengu_brief_send', {
      proactive: status === 'proactive',
      attachment_count: attachments?.length ?? 0,
    })
    if (!attachments || attachments.length === 0) {
      return { data: { message, sentAt } }
    }
    const appState = context.getAppState()
    const resolved = await resolveAttachments(attachments, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { message, attachments: resolved, sentAt },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
