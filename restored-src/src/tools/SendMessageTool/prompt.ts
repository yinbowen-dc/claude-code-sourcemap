/**
 * SendMessageTool/prompt.ts — 消息发送工具的提示词构建
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SendMessageTool 子模块 → 提示词层
 *
 * 主要功能：
 *   - 导出工具功能简介（DESCRIPTION）
 *   - 动态构建工具系统提示词（getPrompt），根据 UDS_INBOX 构建标志决定是否添加跨会话章节
 *
 * 设计说明：
 *   - feature('UDS_INBOX')：编译时标志，控制 UDS socket / bridge 地址格式是否包含在提示词中
 *   - 不启用 UDS_INBOX 时，只支持 teammate 名称和广播（"*"）两种目标
 *   - 启用 UDS_INBOX 时，增加跨会话消息路由（uds: 和 bridge: 地址）
 */

import { feature } from 'bun:bundle'

// 工具功能的静态简介，供工具列表和自动分类器使用
export const DESCRIPTION = 'Send a message to another agent'

/**
 * 动态构建 SendMessage 工具的系统提示词
 *
 * 整体流程：
 *   1. 根据 feature('UDS_INBOX') 决定是否在路由表中追加 uds/bridge 地址行
 *   2. 根据 feature('UDS_INBOX') 决定是否追加「Cross-session」跨会话章节
 *   3. 将以上内容嵌入到完整的 Markdown 提示词模板中并返回
 *
 * 提示词包含以下核心章节：
 *   - 收件人（to）路由表：支持 teammate 名称、广播（*）、以及可选的 uds/bridge 地址
 *   - 跨会话使用说明（仅 UDS_INBOX 启用时）
 *   - 协议响应说明：如何处理 shutdown_request / plan_approval_request 等结构化消息
 *
 * @returns 完整的提示词字符串
 */
export function getPrompt(): string {
  // UDS_INBOX 启用时，路由表中追加 uds: 和 bridge: 两行
  const udsRow = feature('UDS_INBOX')
    ? `\n| \`"uds:/path/to.sock"\` | Local Claude session's socket (same machine; use \`ListPeers\`) |
| \`"bridge:session_..."\` | Remote Control peer session (cross-machine; use \`ListPeers\`) |`
    : ''
  // UDS_INBOX 启用时，追加跨会话消息示例和收件地址发现说明
  const udsSection = feature('UDS_INBOX')
    ? `\n\n## Cross-session

Use \`ListPeers\` to discover targets, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**`
    : ''
  return `
# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |${udsRow}

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.${udsSection}

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.
`.trim()
}
