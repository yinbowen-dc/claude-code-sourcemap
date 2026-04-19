/**
 * SDK 核心类型公共出口（sdk/coreTypes.ts）
 *
 * 【在系统中的位置】
 * 本文件是 Claude Code Agent SDK 可序列化核心类型的"统一出口层"，
 * 位于 entrypoints/sdk/ 目录下，处于整个类型导出体系的第二层：
 *
 *   外部调用方 (SDK 消费者)
 *       ↑
 *   agentSdkTypes.ts      ← 顶层出口（再导出本文件所有内容）
 *       ↑
 *   sdk/coreTypes.ts      ← 本文件（核心可序列化类型的汇集点）
 *       ├─> ../sandboxTypes.ts           （沙盒配置类型）
 *       ├─> ./coreTypes.generated.ts     （由 Zod Schema 自动生成的类型）
 *       └─> ./sdkUtilityTypes.ts         （无法用 Zod 表达的实用工具类型）
 *
 * 【主要职责】
 * 1. 将沙盒配置类型从 sandboxTypes.ts 再导出，供 SDK 消费者直接引用
 * 2. 将所有由 scripts/generate-sdk-types.ts 自动生成的类型全量再导出
 * 3. 导出无法用 Zod Schema 表达的特殊实用工具类型（NonNullableUsage）
 * 4. 提供两个运行时常量数组（HOOK_EVENTS、EXIT_REASONS），供运行时枚举和类型守卫使用
 *
 * 【类型生成流程】
 * coreSchemas.ts（Zod Schema 定义）
 *     → scripts/generate-sdk-types.ts（代码生成脚本）
 *     → coreTypes.generated.ts（生成的 TypeScript 类型文件）
 *     → 本文件再导出（提供给 SDK 消费者）
 *
 * 修改流程：先修改 coreSchemas.ts 中的 Zod Schema，
 * 然后运行 `bun scripts/generate-sdk-types.ts` 重新生成类型，
 * 不要直接修改 coreTypes.generated.ts。
 */

// 从 sandboxTypes.ts 再导出沙盒相关配置类型
// 这些类型同时被 SDK 和设置验证器使用，以此文件为单一来源
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'

// 再导出所有由 Zod Schema 自动生成的 TypeScript 类型
// 包括：消息类型（SDKMessage、SDKUserMessage 等）、会话类型、Hook 输入/输出类型、
// 权限类型、MCP 服务器配置类型、Agent 定义类型、账户信息类型等
export * from './coreTypes.generated.js'

// 再导出无法通过 Zod Schema 表达的实用工具类型
// NonNullableUsage：对 Anthropic API 的 Usage 类型进行 NonNullable 映射，
// 确保所有 token 计数字段均为 number 而非 number | null
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// ============================================================================
// 运行时常量数组（Runtime Const Arrays）
// 以下常量在运行时可用，同时也作为类型的派生来源
// ============================================================================

/**
 * 所有支持的 Hook 事件名称常量数组
 *
 * 【用途】
 * - 运行时枚举：列出系统当前支持的全部 Hook 事件类型
 * - 类型推断：通过 `typeof HOOK_EVENTS[number]` 派生出 `HookEvent` 联合字面量类型
 * - SDK 消费者可用此数组做运行时验证（如判断某个事件名是否有效）
 *
 * 事件分类：
 * - 工具生命周期：PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、PermissionDenied
 * - 用户交互：Notification、UserPromptSubmit、Elicitation、ElicitationResult
 * - 会话生命周期：SessionStart、SessionEnd、Stop、StopFailure
 * - 子 Agent：SubagentStart、SubagentStop
 * - 对话压缩：PreCompact、PostCompact
 * - 配置变化：ConfigChange、InstructionsLoaded
 * - 工作区：WorktreeCreate、WorktreeRemove
 * - 系统状态：Setup、TeammateIdle、CwdChanged、FileChanged
 * - 任务管理：TaskCreated、TaskCompleted
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

/**
 * 会话退出原因常量数组
 *
 * 【用途】
 * - 运行时枚举：描述会话正常或异常结束的所有可能原因
 * - 类型推断：通过 `typeof EXIT_REASONS[number]` 派生 `ExitReason` 联合字面量类型
 *
 * 枚举值含义：
 * - clear：用户主动通过 /clear 命令清除会话
 * - resume：会话被恢复（续接已有会话）后退出
 * - logout：用户登出触发的会话结束
 * - prompt_input_exit：用户在提示输入阶段直接退出（如 Ctrl+D）
 * - other：其他原因（兜底值）
 * - bypass_permissions_disabled：因 bypassPermissions 被禁用而强制退出
 */
export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
