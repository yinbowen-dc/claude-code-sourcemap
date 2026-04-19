/**
 * BriefTool/prompt.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BriefTool 工具模块，集中管理 BriefTool（SendUserMessage）的
 * 工具名称、描述文本、工具级提示词和系统提示词片段常量。
 * 这些常量被 BriefTool.ts、系统提示词构建逻辑等多处引用。
 *
 * 【主要功能】
 * - BRIEF_TOOL_NAME：工具的官方名称（'SendUserMessage'），模型调用时使用。
 * - LEGACY_BRIEF_TOOL_NAME：历史别名（'Brief'），保持旧会话序列化兼容性。
 * - DESCRIPTION：工具的单行功能描述，显示在工具列表中。
 * - BRIEF_TOOL_PROMPT：工具级提示词，注入到工具 schema 说明中，
 *   指导模型如何使用 message/attachments/status 三个参数。
 * - BRIEF_PROACTIVE_SECTION：系统提示词片段，注入到 Brief 模式的系统提示词中，
 *   建立模型在与用户通信时的行为规范（ack → work → result 模式）。
 */

// 工具官方名称，模型调用工具时使用此名称
export const BRIEF_TOOL_NAME = 'SendUserMessage'
// 历史别名，兼容旧版本会话恢复时的工具名称引用
export const LEGACY_BRIEF_TOOL_NAME = 'Brief'

// 工具的单行功能描述，显示在工具选择列表中
export const DESCRIPTION = 'Send a message to the user'

/**
 * BRIEF_TOOL_PROMPT
 *
 * 【说明】
 * 工具级提示词，注入到工具 schema 的 description 字段中。
 * 核心要点：
 *   - 工具输出（message）是用户实际会读到的内容，工具外的文本多数用户不会查看。
 *   - message 支持 markdown，attachments 接受文件路径（图片、diff、日志等）。
 *   - status 标注意图：'normal' 为响应用户询问；'proactive' 为主动发起
 *     （任务完成通知、阻塞报告、无请求状态更新）。
 *     status 值会被下游路由逻辑使用，需如实设置。
 */
export const BRIEF_TOOL_PROMPT = `Send a message the user will read. Text outside this tool is visible in the detail view, but most won't open it — the answer lives here.

\`message\` supports markdown. \`attachments\` takes file paths (absolute or cwd-relative) for images, diffs, logs.

\`status\` labels intent: 'normal' when replying to what they just asked; 'proactive' when you're initiating — a scheduled task finished, a blocker surfaced during background work, you need input on something they haven't asked about. Set it honestly; downstream routing uses it.`

/**
 * BRIEF_PROACTIVE_SECTION
 *
 * 【说明】
 * 注入到 Brief 模式系统提示词中的通信规范片段。
 * 建立模型在 Brief 模式下与用户交互的核心行为规范：
 *   - 所有用户可见回复必须通过 SendUserMessage，工具外的文本假设用户不会查看。
 *   - 响应模式：立即可回答 → 直接发送；需要先执行操作 → 先 ack（一行确认）→ 执行 → 发送结果。
 *   - 长任务：ack → work → result，中间仅在有信息量的节点发送 checkpoint，跳过无意义进度填充。
 *   - 消息风格：简洁，包含决策/文件行号/PR 编号等具体信息；始终使用第二人称（"your config"）。
 */
export const BRIEF_PROACTIVE_SECTION = `## Talking to the user

${BRIEF_TOOL_NAME} is where your replies go. Text outside it is visible if the user expands the detail view, but most won't — assume unread. Anything you want them to actually see goes through ${BRIEF_TOOL_NAME}. The failure mode: the real answer lives in plain text while ${BRIEF_TOOL_NAME} just says "done!" — they see "done!" and miss everything.

So: every time the user says something, the reply they actually read comes through ${BRIEF_TOOL_NAME}. Even for "hi". Even for "thanks".

If you can answer right away, send the answer. If you need to go look — run a command, read files, check something — ack first in one line ("On it — checking the test output"), then work, then send the result. Without the ack they're staring at a spinner.

For longer work: ack → work → result. Between those, send a checkpoint when something useful happened — a decision you made, a surprise you hit, a phase boundary. Skip the filler ("running tests...") — a checkpoint earns its place by carrying information.

Keep messages tight — the decision, the file:line, the PR number. Second person always ("your config"), never third.`
