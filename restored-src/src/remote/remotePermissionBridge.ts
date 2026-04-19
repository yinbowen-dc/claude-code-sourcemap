/**
 * @file remotePermissionBridge.ts
 * @description 远程权限桥接工具 —— Claude Code 远程协作运行（CCR）架构中的权限请求适配层。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   RemoteSessionManager（接收 CCR 控制消息）
 *     └─► remotePermissionBridge（本文件）
 *           ├─► createSyntheticAssistantMessage  → 为权限请求伪造 AssistantMessage 供 UI 使用
 *           └─► createToolStub                   → 为本地未知工具创建最小化存根，路由到 FallbackPermissionRequest
 *
 * 核心问题：
 *   CCR 容器负责实际执行工具调用，本地 CLI 只负责展示权限弹窗。
 *   但权限弹窗（ToolUseConfirm）需要一个真实的 AssistantMessage 和 Tool 对象，
 *   而本地并没有这些。本文件通过两个工厂函数伪造出最小可用的对象，
 *   使权限流程能够在本地正常运行。
 */

import { randomUUID } from 'crypto'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { Tool } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import { jsonStringify } from '../utils/slowOperations.js'

/**
 * 为远程权限请求创建伪造的 AssistantMessage。
 *
 * 流程说明：
 *   CCR 容器发起工具调用（如文件写入、命令执行），并通过 control_request 通知本地 CLI
 *   请求用户授权。ToolUseConfirm 组件要求传入一个 AssistantMessage 才能渲染权限弹窗。
 *   由于本地没有真实的 AssistantMessage（工具在远端运行），此函数构造一个最小化的
 *   合规对象，其中包含与原始请求匹配的 tool_use 内容块。
 *
 * @param request   来自 CCR 的权限请求（含工具名、工具输入等）
 * @param requestId 此次权限请求的唯一 ID，用于后续 allow/deny 回复
 * @returns 符合 AssistantMessage 接口的伪造消息对象
 */
export function createSyntheticAssistantMessage(
  request: SDKControlPermissionRequest,
  requestId: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(), // 生成随机 UUID，避免与真实消息冲突
    message: {
      id: `remote-${requestId}`, // 以 "remote-" 为前缀区分远程消息
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use', // 模拟工具调用内容块，供权限弹窗提取工具信息
          id: request.tool_use_id,
          name: request.tool_name,
          input: request.input,
        },
      ],
      model: '',              // 远程模式下本地不知道模型名，填空字符串
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      usage: {
        input_tokens: 0,              // 远程执行，本地无 token 计数
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as AssistantMessage['message'],
    requestId: undefined, // 本地无请求 ID
    timestamp: new Date().toISOString(), // 使用当前时间作为消息时间戳
  }
}

/**
 * 为本地未加载的工具创建最小化存根（Tool stub）。
 *
 * 流程说明：
 *   远端 CCR 容器可能使用本地 CLI 不认识的工具（如 MCP 工具）。
 *   权限系统需要一个 Tool 对象来决定是否调用 FallbackPermissionRequest。
 *   此函数返回一个满足 Tool 接口最低要求的假工具：
 *   - 总是处于启用状态（isEnabled: true）
 *   - 总是需要权限（needsPermissions: true）
 *   - renderToolUseMessage 显示最多前 3 个输入参数，供用户判断是否授权
 *
 * @param toolName 远端工具的名称
 * @returns 最小化的 Tool 存根对象
 */
export function createToolStub(toolName: string): Tool {
  return {
    name: toolName,
    inputSchema: {} as Tool['inputSchema'], // 本地不知道 schema，使用空对象占位
    isEnabled: () => true,                  // 存根工具始终处于启用状态
    userFacingName: () => toolName,         // 直接使用工具名作为用户可见名称
    renderToolUseMessage: (input: Record<string, unknown>) => {
      const entries = Object.entries(input)
      if (entries.length === 0) return ''
      // 最多取前 3 个参数，以 "key: value" 格式拼接，给用户摘要信息
      return entries
        .slice(0, 3)
        .map(([key, value]) => {
          // 字符串值直接使用，其他类型序列化为 JSON 字符串
          const valueStr =
            typeof value === 'string' ? value : jsonStringify(value)
          return `${key}: ${valueStr}`
        })
        .join(', ')
    },
    call: async () => ({ data: '' }),  // 存根工具不会被实际调用，返回空数据
    description: async () => '',       // 本地无描述信息
    prompt: () => '',                  // 本地无系统提示注入
    isReadOnly: () => false,           // 保守处理：视为非只读，保证权限提示弹出
    isMcp: false,
    needsPermissions: () => true,      // 未知工具必须请求权限，不可自动放行
  } as unknown as Tool
}
