/**
 * ScheduleCronTool/prompt.ts — Cron 调度系统的功能开关与提示词构建
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ ScheduleCronTool 子模块 → 配置与提示词层
 *
 * 主要功能：
 *   1. 提供两个功能开关函数：
 *      - isKairosCronEnabled()：整个 cron 调度系统的统一开关（构建时 + 运行时双重控制）
 *      - isDurableCronEnabled()：磁盘持久化任务的细粒度开关
 *   2. 导出三个工具的名称常量
 *   3. 提供动态构建工具描述和提示词的函数（根据持久化开关动态调整内容）
 *
 * 设计说明：
 *   - 使用 GrowthBook 的 5 分钟缓存刷新窗口，兼顾实时性与性能
 *   - CLAUDE_CODE_DISABLE_CRON 环境变量可在本地优先级最高地禁用整个调度系统
 *   - 默认值均为 true，确保 Bedrock/Vertex/Foundry 等禁用遥测的场景也能正常使用
 */

import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { DEFAULT_CRON_JITTER_CONFIG } from '../../utils/cronTasks.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

// GrowthBook 功能开关的缓存刷新间隔：5 分钟
const KAIROS_CRON_REFRESH_MS = 5 * 60 * 1000

// 循环任务的默认最大存活天数（从 jitter 配置中换算）
export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * Unified gate for the cron scheduling system. Combines the build-time
 * `feature('AGENT_TRIGGERS')` flag (dead code elimination) with the runtime
 * `tengu_kairos_cron` GrowthBook gate on a 5-minute refresh window.
 *
 * AGENT_TRIGGERS is independently shippable from KAIROS — the cron module
 * graph (cronScheduler/cronTasks/cronTasksLock/cron.ts + the three tools +
 * /loop skill) has zero imports into src/assistant/ and no feature('KAIROS')
 * calls. The REPL.tsx kairosEnabled read is safe:
 * kairosEnabled is unconditionally in AppStateStore with default false, so
 * when KAIROS is off the scheduler just gets assistantMode: false.
 *
 * Called from Tool.isEnabled() (lazy, post-init) and inside useEffect /
 * imperative setup, never at module scope — so the disk cache has had a
 * chance to populate.
 *
 * The default is `true` — /loop is GA (announced in changelog). GrowthBook
 * is disabled for Bedrock/Vertex/Foundry and when DISABLE_TELEMETRY /
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC are set; a `false` default would
 * break /loop for those users (GH #31759). The GB gate now serves purely as
 * a fleet-wide kill switch — flipping it to `false` stops already-running
 * schedulers on their next isKilled poll tick, not just new ones.
 *
 * `CLAUDE_CODE_DISABLE_CRON` is a local override that wins over GB.
 *
 * Cron 调度系统的统一开关：
 *   - 构建时：由 feature('AGENT_TRIGGERS') 控制（死代码消除）
 *   - 运行时：由 GrowthBook 'tengu_kairos_cron' 开关控制（5 分钟缓存）
 *   - 本地覆盖：CLAUDE_CODE_DISABLE_CRON=true 可强制禁用（优先级最高）
 *   - 默认值为 true，确保禁用遥测的场景也能使用 /loop 功能
 */
export function isKairosCronEnabled(): boolean {
  return feature('AGENT_TRIGGERS')
    ? !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON) && // 本地环境变量优先
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_cron',  // GrowthBook 功能开关名称
          true,                 // 默认值为 true（GA 功能）
          KAIROS_CRON_REFRESH_MS,
        )
    : false // 构建时未启用 AGENT_TRIGGERS，直接返回 false
}

/**
 * Kill switch for disk-persistent (durable) cron tasks. Narrower than
 * {@link isKairosCronEnabled} — flipping this off forces `durable: false` at
 * the call() site, leaving session-only cron (in-memory, GA) untouched.
 *
 * Defaults to `true` so Bedrock/Vertex/Foundry and DISABLE_TELEMETRY users get
 * durable cron. Does NOT consult CLAUDE_CODE_DISABLE_CRON (that kills the whole
 * scheduler via isKairosCronEnabled).
 *
 * 磁盘持久化任务的细粒度开关：
 *   - 关闭此开关仅禁用 durable 功能，不影响 session-only 内存任务
 *   - 默认值 true，不受 CLAUDE_CODE_DISABLE_CRON 影响
 */
export function isDurableCronEnabled(): boolean {
  return getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_kairos_cron_durable', // GrowthBook 持久化子功能开关
    true,                        // 默认启用持久化
    KAIROS_CRON_REFRESH_MS,
  )
}

// 三个 Cron 工具的名称常量，供工具注册和调用时使用
export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

/**
 * 构建 CronCreate 工具的描述文本
 * 根据是否启用持久化，决定描述中是否包含 durable 参数的说明
 *
 * @param durableEnabled 是否启用磁盘持久化功能
 * @returns 工具描述字符串
 */
export function buildCronCreateDescription(durableEnabled: boolean): string {
  return durableEnabled
    ? 'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .claude/scheduled_tasks.json; otherwise session-only.'
    : 'Schedule a prompt to run at a future time within this Claude session — either recurring on a cron schedule, or once at a specific time.'
}

/**
 * 构建 CronCreate 工具的完整系统提示词
 * 包含以下章节：
 *   - 一次性任务（one-shot）的创建规范
 *   - 循环任务（recurring）的创建规范
 *   - 错峰调度建议（避免 :00/:30 等整点）
 *   - 持久化策略（根据 durableEnabled 动态插入）
 *   - 运行时行为说明（调度器触发时机、jitter、自动过期）
 *
 * @param durableEnabled 是否启用磁盘持久化功能
 * @returns 完整的提示词字符串
 */
export function buildCronCreatePrompt(durableEnabled: boolean): string {
  // 根据持久化开关选择不同的持久化章节内容
  const durabilitySection = durableEnabled
    ? `## Durability

By default (durable: false) the job lives only in this Claude session — nothing is written to disk, and the job is gone when Claude exits. Pass durable: true to write to .claude/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.`
    : `## Session-only

Jobs live only in this Claude session — nothing is written to disk, and the job is gone when Claude exits.`

  // 持久化运行时行为说明（仅在 durable 启用时添加）
  const durableRuntimeNote = durableEnabled
    ? 'Durable jobs persist to .claude/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. '
    : ''

  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

${durabilitySection}

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). ${durableRuntimeNote}The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${CRON_DELETE_TOOL_NAME}.`
}

// CronDelete 工具的静态描述文本
export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'

/**
 * 构建 CronDelete 工具的系统提示词
 * 根据持久化开关说明从磁盘文件或内存存储删除任务的行为差异
 *
 * @param durableEnabled 是否启用磁盘持久化功能
 * @returns 提示词字符串
 */
export function buildCronDeletePrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .claude/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`
    : `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from the in-memory session store.`
}

// CronList 工具的静态描述文本
export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'

/**
 * 构建 CronList 工具的系统提示词
 * 根据持久化开关说明是否同时列出磁盘和内存中的任务
 *
 * @param durableEnabled 是否启用磁盘持久化功能
 * @returns 提示词字符串
 */
export function buildCronListPrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.claude/scheduled_tasks.json) and session-only.`
    : `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME} in this session.`
}
