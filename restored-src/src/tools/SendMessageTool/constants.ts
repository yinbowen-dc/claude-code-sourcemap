/**
 * SendMessageTool/constants.ts — 消息发送工具的名称常量
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/SendMessageTool）→ 常量定义层
 *
 * 主要功能：
 *   - 导出 SendMessage 工具的注册名称常量
 *   - 供工具注册、权限系统和跨文件引用使用
 */

// SendMessage 工具的注册名称，供模型调用时识别
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'
