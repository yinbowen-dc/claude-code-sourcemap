/**
 * managedEnvConstants.ts — 受管理环境变量常量定义模块
 *
 * 【系统流程定位】
 * 本模块是 Claude Code 安全配置层的核心常量定义文件，
 * 被 managedEnv.ts（环境变量应用逻辑）引用，
 * 也被远程托管设置（remoteManagedSettings）和权限检查模块使用。
 *
 * 【主要职责】
 * 1. PROVIDER_MANAGED_ENV_VARS：列举所有推理路由相关的环境变量，
 *    当宿主（Host）通过 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 声明其管理路由时，
 *    这些变量不允许被用户的 settings.json 覆盖；
 * 2. isProviderManagedEnvVar()：判断一个变量名是否属于受宿主管理的变量
 *    （精确匹配 + 前缀匹配 VERTEX_REGION_CLAUDE_*）；
 * 3. DANGEROUS_SHELL_SETTINGS：可执行任意 Shell 代码的危险设置项列表；
 * 4. SAFE_ENV_VARS：允许在信任对话框之前就从设置中应用的安全环境变量白名单，
 *    是"哪些变量无安全风险"的权威来源。
 */

/**
 * 推理路由相关的环境变量集合。
 *
 * 当 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 为真时，这些变量会被从
 * settings 来源的 env 对象中剥离，防止用户 ~/.claude/settings.json
 * 将请求重定向到非预期的 Provider（如将 Bedrock 的配置覆盖掉）。
 *
 * 说明：
 * - 包含 Provider 选择（USE_BEDROCK/VERTEX/FOUNDRY）
 * - 包含各 Provider 的端点 URL 和项目标识
 * - 包含区域路由（前缀 VERTEX_REGION_CLAUDE_* 通过 isProviderManagedEnvVar 匹配）
 * - 包含各类认证 key / token
 * - 包含默认模型名称（模型 ID 格式因 Provider 而异）
 *
 * @[MODEL LAUNCH] 新模型通常无需修改此处，VERTEX_REGION_CLAUDE_* 通过前缀匹配。
 *                  新增 Provider 或新的路由配置变量需要手动添加到此 Set。
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // 标志位本身——settings 不能在宿主设置后再取消它
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // Provider 选择变量
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // 各 Provider 的端点/基础 URL 及项目/资源标识
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  // Vertex 区域路由（每个模型的覆盖变量通过前缀匹配，见下方 PROVIDER_MANAGED_ENV_PREFIXES）
  'CLOUD_ML_REGION',
  // 认证 key / token
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  // 默认模型名称——不同 Provider 使用不同的模型 ID 格式
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
])

/**
 * 受宿主管理的环境变量前缀列表。
 * 用于前缀匹配，覆盖随模型发布而增加的 Vertex 区域覆盖变量。
 * 使用前缀而非逐一列举，避免每次新模型发布都需要更新此文件。
 */
const PROVIDER_MANAGED_ENV_PREFIXES = [
  // 每模型的 Vertex 区域覆盖——随模型版本增加，前缀匹配避免遗漏
  'VERTEX_REGION_CLAUDE_',
]

/**
 * 判断给定的环境变量名是否属于受宿主管理的推理路由变量。
 *
 * 流程：
 * 1. 转大写后在精确集合中查找；
 * 2. 若未找到，检查是否匹配任意受管理前缀（如 VERTEX_REGION_CLAUDE_*）。
 *
 * @param key 环境变量名（大小写不敏感）
 * @returns 若属于受管理变量则返回 true
 */
export function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    // 精确匹配：在固定集合中查找
    PROVIDER_MANAGED_ENV_VARS.has(upper) ||
    // 前缀匹配：处理随模型扩展的 Vertex 区域变量
    PROVIDER_MANAGED_ENV_PREFIXES.some(p => upper.startsWith(p))
  )
}

/**
 * 可执行任意 Shell 代码的危险设置项列表。
 *
 * 这些设置值会被当作 Shell 命令执行（如 apiKeyHelper 定义一个 Shell 脚本来获取 API Key），
 * 因此不能通过不受信任的来源（如项目目录中的 settings.json）注入。
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'apiKeyHelper',        // 自定义 API Key 获取脚本
  'awsAuthRefresh',      // AWS 认证刷新脚本
  'awsCredentialExport', // AWS 凭证导出脚本
  'gcpAuthRefresh',      // GCP 认证刷新脚本
  'otelHeadersHelper',   // OTEL 请求头辅助脚本
  'statusLine',          // 状态栏脚本
] as const

/**
 * 可以在信任对话框之前从设置中应用的安全环境变量白名单。
 *
 * 【安全设计】
 * 这是"哪些环境变量安全"的权威来源（Source of Truth）。
 * 不在此列表中的变量被认为是危险的，通过远程托管设置注入时会触发安全对话框。
 *
 * 【危险变量举例（不在此列表中）】
 * 重定向到攻击者控制的服务器：
 *   - ANTHROPIC_BASE_URL, HTTP_PROXY, HTTPS_PROXY
 *   - OTEL_EXPORTER_OTLP_ENDPOINT
 * 信任攻击者控制的服务器：
 *   - NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS
 * 切换到攻击者控制的项目：
 *   - ANTHROPIC_FOUNDRY_RESOURCE, ANTHROPIC_API_KEY, AWS_BEARER_TOKEN_BEDROCK
 *
 * 此列表包含 Claude Code 特有的配置变量、模型选择、遥测控制等，
 * 这些变量不会导致流量被重定向或凭证被替换。
 */
export const SAFE_ENV_VARS = new Set([
  // 自定义模型选项及描述
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  // 默认模型选择（Haiku / Opus / Sonnet 各层级）
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  // Foundry API Key（不涉及端点重定向）
  'ANTHROPIC_FOUNDRY_API_KEY',
  // 主模型及快速小模型选择
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'ANTHROPIC_SMALL_FAST_MODEL',
  // AWS 区域/Profile（不包含凭证本身）
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  // Bash 工具超时与输出长度控制
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  // Claude Code 行为开关
  'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // Provider 选择（安全：仅切换 Provider 类型，不含端点 URL）
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  // UI 功能开关
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_TELEMETRY',
  'ENABLE_TOOL_SEARCH',
  // MCP 输出与超时控制
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  // OTEL 遥测配置（仅 Headers/Protocol，不含 Endpoint URL）
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  // 工具搜索配置
  'USE_BUILTIN_RIPGREP',
  // Vertex 每模型区域覆盖（各具体模型版本）
  'VERTEX_REGION_CLAUDE_3_5_HAIKU',
  'VERTEX_REGION_CLAUDE_3_5_SONNET',
  'VERTEX_REGION_CLAUDE_3_7_SONNET',
  'VERTEX_REGION_CLAUDE_4_0_OPUS',
  'VERTEX_REGION_CLAUDE_4_0_SONNET',
  'VERTEX_REGION_CLAUDE_4_1_OPUS',
  'VERTEX_REGION_CLAUDE_4_5_SONNET',
  'VERTEX_REGION_CLAUDE_4_6_SONNET',
  'VERTEX_REGION_CLAUDE_HAIKU_4_5',
])
