/**
 * tag 命令注册入口（commands/tag/index.ts）
 *
 * 本文件将 /tag 命令注册到 Claude Code 全局命令系统。
 * 该命令允许用户为当前会话切换（添加/移除）可搜索的标签，
 * 便于在 Anthropic 内部工具中按标签筛选和归类会话记录。
 *
 * 在系统流程中的位置：
 *   用户输入 /tag <tag-name> → 命令注册表匹配 → load() 懒加载 tag.js
 *   → 读取当前会话标签集合 → 切换指定标签（存在则移除，不存在则添加）
 *   → 持久化到会话存储。
 *
 * 访问控制：isEnabled 检查 USER_TYPE 环境变量，仅 Anthropic 内部员工
 *（USER_TYPE === 'ant'）可见和使用此命令，防止外部用户访问内部标签系统。
 */

import type { Command } from '../../commands.js'

/**
 * tag 命令描述对象。
 * - isEnabled: 仅当 USER_TYPE 为 'ant'（Anthropic 内部员工）时启用，
 *   这是一个内部调试/运营工具，不对普通用户开放。
 * - argumentHint: '<tag-name>' 提示用户必须传入标签名称参数。
 * - type: 'local-jsx' 渲染切换确认和当前标签状态的 React 组件。
 */
const tag = {
  type: 'local-jsx',
  name: 'tag',
  description: 'Toggle a searchable tag on the current session',
  isEnabled: () => process.env.USER_TYPE === 'ant',  // 仅 Anthropic 内部员工可访问
  argumentHint: '<tag-name>',    // 标签名为必填参数
  load: () => import('./tag.js'),
} satisfies Command

export default tag
