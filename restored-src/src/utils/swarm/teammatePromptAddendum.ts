/**
 * Teammate 系统提示词附录（teammatePromptAddendum.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Swarm 多智能体系统的系统提示词构建阶段，由 systemPrompt.ts
 * 等上层模块在为 teammate 实例构建完整系统提示词时附加到主提示词末尾。
 * 它是 teammate 与 leader / 其他 teammate 进行通信的关键行为规范。
 *
 * 【主要职责】
 * 向以 teammate 身份运行的 Claude 实例说明：
 * 1. 其在团队中的通信约束（纯文本回复对外不可见）；
 * 2. 必须使用 SendMessage 工具发送消息给指定成员或广播；
 * 3. 工作通过任务系统和 teammate 消息系统进行协调。
 */

/**
 * 附加到 teammate 系统提示词末尾的指令文本。
 *
 * 【作用说明】
 * 这段文本明确告知运行在 teammate 角色中的 Claude 实例：
 * - 纯文本响应在团队中对其他成员不可见，必须使用工具发送消息；
 * - 用户主要与 team lead 交互，teammate 通过任务系统和消息工具协同工作；
 * - SendMessage 的目标可以是具体的 "<name>"（点对点）或 "*"（广播，需谨慎使用）。
 */
export const TEAMMATE_SYSTEM_PROMPT_ADDENDUM = `
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team:
- Use the SendMessage tool with \`to: "<name>"\` to send messages to specific teammates
- Use the SendMessage tool with \`to: "*"\` sparingly for team-wide broadcasts

Just writing a response in text is not visible to others on your team - you MUST use the SendMessage tool.

The user interacts primarily with the team lead. Your work is coordinated through the task system and teammate messaging.
`
