/**
 * Anthropic API Beta 头部常量
 *
 * 本文件集中管理所有向 Anthropic API 发送请求时使用的 beta 功能头部字符串。
 * 这些头部字符串用于在 API 请求的 `anthropic-beta` 请求头中启用实验性或预发布功能。
 *
 * 设计说明：
 * - 部分 beta 头部通过 `feature()` 门控（GrowthBook 功能开关），仅对特定用户群开放
 * - 部分 beta 头部根据 USER_TYPE 环境变量区分内部员工（ant）与外部用户
 * - Bedrock / Vertex AI 对 beta 头部的支持存在差异，需要分别处理
 * - 本文件不含业务逻辑，仅声明常量，以保持依赖树简洁
 */
import { feature } from 'bun:bundle'

// Claude Code 基础 beta 标识，用于识别 CLI 客户端
export const CLAUDE_CODE_20250219_BETA_HEADER = 'claude-code-20250219'
// 交错思考（Interleaved Thinking）beta，允许在工具调用间插入思考步骤
export const INTERLEAVED_THINKING_BETA_HEADER =
  'interleaved-thinking-2025-05-14'
// 1M token 上下文窗口 beta
export const CONTEXT_1M_BETA_HEADER = 'context-1m-2025-08-07'
// 上下文管理 beta，支持自动上下文压缩等功能
export const CONTEXT_MANAGEMENT_BETA_HEADER = 'context-management-2025-06-27'
// 结构化输出 beta，支持 JSON schema 约束的模型输出
export const STRUCTURED_OUTPUTS_BETA_HEADER = 'structured-outputs-2025-12-15'
// 网络搜索工具 beta
export const WEB_SEARCH_BETA_HEADER = 'web-search-2025-03-05'
// 工具搜索 beta 头部因供应商不同而有所区别：
// - Claude API / Foundry（第一方）：advanced-tool-use-2025-11-20
// - Vertex AI / Bedrock（第三方）：tool-search-tool-2025-10-19
export const TOOL_SEARCH_BETA_HEADER_1P = 'advanced-tool-use-2025-11-20'
export const TOOL_SEARCH_BETA_HEADER_3P = 'tool-search-tool-2025-10-19'
// 推理努力（Effort）控制 beta，允许调整模型的思考深度
export const EFFORT_BETA_HEADER = 'effort-2025-11-24'
// 任务预算 beta，用于限制单次任务的资源消耗
export const TASK_BUDGETS_BETA_HEADER = 'task-budgets-2026-03-13'
// 提示缓存作用域 beta，支持细粒度的提示缓存控制
export const PROMPT_CACHING_SCOPE_BETA_HEADER =
  'prompt-caching-scope-2026-01-05'
// 快速模式 beta，优化低延迟响应场景
export const FAST_MODE_BETA_HEADER = 'fast-mode-2026-02-01'
// 思考内容脱敏 beta，将思考块从响应中移除以降低输出大小
export const REDACT_THINKING_BETA_HEADER = 'redact-thinking-2026-02-12'
// token 高效工具 beta，减少工具定义占用的 token 数量
export const TOKEN_EFFICIENT_TOOLS_BETA_HEADER =
  'token-efficient-tools-2026-03-28'
// 连接器文本摘要 beta，由 CONNECTOR_TEXT 功能开关控制；未启用时为空字符串
export const SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER = feature('CONNECTOR_TEXT')
  ? 'summarize-connector-text-2026-03-13'
  : ''
// AFK 模式 beta（自动离开/后台运行），由 TRANSCRIPT_CLASSIFIER 功能开关控制
export const AFK_MODE_BETA_HEADER = feature('TRANSCRIPT_CLASSIFIER')
  ? 'afk-mode-2026-01-31'
  : ''
// CLI 内部 beta，仅对 Anthropic 内部员工（USER_TYPE=ant）开放；外部用户为空字符串
export const CLI_INTERNAL_BETA_HEADER =
  process.env.USER_TYPE === 'ant' ? 'cli-internal-2026-02-09' : ''
// 顾问工具 beta
export const ADVISOR_BETA_HEADER = 'advisor-tool-2026-03-01'

/**
 * Bedrock 供应商专用 beta 头部集合。
 *
 * Bedrock 仅支持有限数量的 beta 头部，且必须通过 extraBodyParams 传递，
 * 而不能放在标准请求头中。本集合记录哪些 beta 字符串应走 Bedrock
 * extraBodyParams 路径，以避免在 Bedrock 请求头中重复发送。
 */
export const BEDROCK_EXTRA_PARAMS_HEADERS = new Set([
  INTERLEAVED_THINKING_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_3P,
])

/**
 * Vertex AI countTokens API 允许使用的 beta 头部白名单。
 * 其他 beta 头部在 Vertex countTokens 接口会导致 400 错误，因此需要过滤。
 */
export const VERTEX_COUNT_TOKENS_ALLOWED_BETAS = new Set([
  CLAUDE_CODE_20250219_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
])
