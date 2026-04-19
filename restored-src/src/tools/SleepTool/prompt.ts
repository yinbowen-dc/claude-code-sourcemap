/**
 * SleepTool/prompt.ts — Sleep 工具的名称常量与提示词定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SleepTool 子模块 → 提示词层
 *
 * 主要功能：
 *   - 导出 Sleep 工具的注册名称常量（SLEEP_TOOL_NAME）
 *   - 导出工具功能简介（DESCRIPTION）
 *   - 导出完整的系统提示词（SLEEP_TOOL_PROMPT），指导模型如何正确使用 Sleep 工具
 *
 * 设计说明：
 *   - 引用 TICK_TAG 常量，说明 Sleep 工具可被周期性心跳唤醒的行为
 *   - 推荐用 Sleep 工具代替 Bash(sleep ...)，避免占用 shell 进程
 *   - 提示模型在每次唤醒前先检查是否有待处理工作，再决定是否继续休眠
 */

import { TICK_TAG } from '../../constants/xml.js'

// Sleep 工具的注册名称，供模型调用时识别
export const SLEEP_TOOL_NAME = 'Sleep'

// 工具功能的静态简介，供工具列表和自动分类器使用
export const DESCRIPTION = 'Wait for a specified duration'

/**
 * Sleep 工具的完整系统提示词
 *
 * 包含以下核心内容：
 *   - 使用场景：用户要求等待、无任务可做或等待外部事件时
 *   - TICK_TAG 心跳提示：定期唤醒，模型应在再次休眠前先检查是否有可做的工作
 *   - 并发安全说明：可与其他工具同时调用，互不干扰
 *   - 对比 Bash sleep 的优势：不持有 shell 进程资源
 *   - 成本提示：每次唤醒消耗一次 API 调用，prompt cache 在 5 分钟不活跃后过期
 */
export const SLEEP_TOOL_PROMPT = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

You may receive <${TICK_TAG}> prompts — these are periodic check-ins. Look for useful work to do before sleeping.

You can call this concurrently with other tools — it won't interfere with them.

Prefer this over \`Bash(sleep ...)\` — it doesn't hold a shell process.

Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.`
