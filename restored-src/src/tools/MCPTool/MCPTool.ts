/**
 * MCPTool.ts — MCP 工具通用骨架实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件定义了 MCPTool —— MCP（Model Context Protocol）工具的通用骨架。
 * MCPTool 本身是一个占位符（placeholder），其大部分属性（name、description、
 * prompt、call、userFacingName）在 mcpClient.ts 中被真实 MCP 工具覆盖。
 * 设计意图是通过 buildTool() 建立工具接口契约，
 * 真正的业务逻辑由 mcpClient.ts 在运行时动态注入。
 *
 * 【主要功能】
 * 1. inputSchema（懒加载）：z.object({}).passthrough()
 *    - passthrough() 允许任意额外字段，因为各 MCP 工具定义自己的参数 Schema
 * 2. outputSchema（懒加载）：z.string()（MCP 工具执行结果为字符串）
 * 3. MCPTool 工具定义（骨架）：
 *    - isMcp: true（标记为 MCP 工具）
 *    - isOpenWorld: () => false（在 mcpClient.ts 中覆盖）
 *    - name: 'mcp'（占位符，在 mcpClient.ts 中覆盖为实际工具名）
 *    - description/prompt：返回空字符串占位符（在 mcpClient.ts 中覆盖）
 *    - call: 返回空字符串（在 mcpClient.ts 中覆盖为真实调用逻辑）
 *    - checkPermissions: 返回 passthrough（权限逻辑由 mcpClient.ts 处理）
 *    - isResultTruncated: 基于行数判断输出是否被截断
 *    - mapToolResultToToolResultBlockParam: 将字符串结果映射为 tool_result 消息
 * 4. 重新导出 MCPProgress 类型（打破循环导入）
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

/**
 * 输入 Schema（懒加载）：允许任意参数对象（passthrough）。
 *
 * 使用 passthrough() 的原因：
 * 各 MCP 工具定义各自的参数结构，无法在此处预知。
 * passthrough() 允许传入任意额外字段而不被 Zod 过滤，
 * 实际的参数校验由各 MCP 工具自身的 Schema 在 mcpClient.ts 中处理。
 */
export const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 输出 Schema（懒加载）：MCP 工具执行结果为字符串。
 * MCP 工具的输出经过序列化处理后统一以字符串形式返回。
 */
export const outputSchema = lazySchema(() =>
  z.string().describe('MCP tool execution result'),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// 从集中式类型定义文件重新导出 MCPProgress，打破循环导入依赖
export type { MCPProgress } from '../../types/tools.js'

/**
 * MCPTool 工具定义（骨架）。
 *
 * 本工具定义是占位符，提供工具接口契约。
 * mcpClient.ts 在运行时通过对象扩展将真实的 MCP 工具属性覆盖到此骨架上，
 * 包括 name、description、prompt、call、userFacingName 等。
 *
 * 注意事项：
 * - isMcp: true 标记在覆盖后保留，用于框架内部识别 MCP 工具
 * - passthrough 输入 Schema 确保各种 MCP 工具参数均可通过
 */
export const MCPTool = buildTool({
  /** 标记为 MCP 工具，供框架内部区分和特殊处理 */
  isMcp: true,
  /** 是否为开放世界工具（在 mcpClient.ts 中覆盖为实际值） */
  isOpenWorld() {
    return false
  },
  /** 占位符名称（在 mcpClient.ts 中覆盖为实际 MCP 工具名称） */
  name: 'mcp',
  maxResultSizeChars: 100_000,
  /** 占位符描述（在 mcpClient.ts 中覆盖为实际工具描述） */
  async description() {
    return DESCRIPTION
  },
  /** 占位符 prompt（在 mcpClient.ts 中覆盖为实际工具 prompt） */
  async prompt() {
    return PROMPT
  },
  /** 懒加载输入 Schema（passthrough，允许任意参数） */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema（字符串类型） */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /** 占位符 call 实现（在 mcpClient.ts 中覆盖为实际 MCP 调用逻辑） */
  async call() {
    return {
      data: '',
    }
  },
  /**
   * 权限检查：返回 passthrough（MCP 工具权限管理由 mcpClient.ts 处理）。
   * passthrough 表示权限决定推迟到上层框架处理。
   */
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  renderToolUseMessage,
  /** 占位符用户可见名称（在 mcpClient.ts 中覆盖为实际服务器+工具名） */
  userFacingName: () => 'mcp',
  /** 进度消息渲染（MCP 工具可能有流式进度通知） */
  renderToolUseProgressMessage,
  renderToolResultMessage,
  /**
   * 检查输出是否被截断（基于输出行数与最大行数比较）。
   *
   * @param output - MCP 工具执行结果字符串
   * @returns true 表示输出被截断
   */
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(output)
  },
  /**
   * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
   * MCP 工具结果已经是字符串，直接作为 content 返回。
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
