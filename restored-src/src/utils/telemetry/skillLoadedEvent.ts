/**
 * telemetry/skillLoadedEvent.ts — 会话启动时的技能加载事件上报
 *
 * 在 Claude Code 的分析（Analytics）体系中，本文件负责在每次会话启动时
 * 上报当前可用的所有技能（Skills）信息，用于统计不同会话中技能的分布情况。
 *
 * 数据流向：
 *   getSkillToolCommands(cwd) → 技能列表
 *   getCharBudget(tokens) → 技能字符预算
 *   logEvent('tengu_skill_loaded', ...) → BigQuery / 分析后端
 *
 * 隐私处理：
 *   - 技能名称通过 _PROTO_skill_name 路由到 BigQuery 的特权列，
 *     不经过 additional_metadata（避免 PII 泄露）
 *   - source / loaded_from / kind 字段均经过验证，不含代码或文件路径
 */

import { getSkillToolCommands } from '../../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getCharBudget } from '../../tools/SkillTool/prompt.js'

/**
 * 在会话启动时为每个可用技能上报 tengu_skill_loaded 事件。
 *
 * 执行流程：
 *   1. 调用 getSkillToolCommands(cwd) 获取当前工作目录下的所有技能命令
 *   2. 计算上下文窗口的字符预算（skillBudget）
 *   3. 遍历技能列表，跳过非 'prompt' 类型的技能
 *   4. 对每个技能调用 logEvent 上报分析事件
 *
 * @param cwd                 - 当前工作目录，用于查找技能配置文件
 * @param contextWindowTokens - 上下文窗口大小（token 数），用于计算字符预算
 */
export async function logSkillsLoaded(
  cwd: string,
  contextWindowTokens: number,
): Promise<void> {
  // 获取当前目录下所有可用的技能工具命令
  const skills = await getSkillToolCommands(cwd)
  // 根据上下文窗口大小计算技能内容的字符预算
  const skillBudget = getCharBudget(contextWindowTokens)

  for (const skill of skills) {
    // 只上报 prompt 类型的技能（跳过非提示词类型）
    if (skill.type !== 'prompt') continue

    logEvent('tengu_skill_loaded', {
      // _PROTO_skill_name 路由到 BigQuery 的特权 skill_name 列
      // 未脱敏的名称不写入 additional_metadata，确保 PII 安全
      _PROTO_skill_name:
        skill.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      // 技能来源（经过验证不含代码或文件路径）
      skill_source:
        skill.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 技能加载来源（如 user / org / marketplace 等）
      skill_loaded_from:
        skill.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 当前会话的技能字符预算
      skill_budget: skillBudget,
      // 可选的技能类型字段（如 'slash-command' 等）
      ...(skill.kind && {
        skill_kind:
          skill.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }
}
