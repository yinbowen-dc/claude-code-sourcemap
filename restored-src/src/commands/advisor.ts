/**
 * /advisor 命令实现模块。
 *
 * 在 Claude Code 的模型配置流程中，此文件实现了"顾问模型"（Advisor Model）的
 * 查询、设置与取消功能。顾问模型是一个辅助大模型，可在主模型处理复杂任务时提供
 * 二次意见或策略建议。该命令仅对满足权限条件的用户（canUserConfigureAdvisor）可见，
 * 并会在主模型不支持 advisor 功能时给出相应警告。
 *
 * 对应命令：/advisor [<model>|off]
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  canUserConfigureAdvisor,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../utils/advisor.js'
import {
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

/**
 * /advisor 命令的核心执行函数。
 *
 * 根据用户传入的参数，分三种情况处理：
 * 1. 无参数：查询当前顾问模型状态，并提示主模型是否支持 advisor 功能
 * 2. 参数为 "unset"/"off"：禁用顾问模型，同时更新持久化设置
 * 3. 其他参数：验证模型名称有效性 → 检查能否用作 advisor → 保存并提示是否生效
 *
 * @param args 用户输入的命令参数（已由命令框架传入）
 * @param context 命令执行上下文，含 AppState 读写能力
 */
const call: LocalCommandCall = async (args, context) => {
  // 规范化参数：去空格并转小写，方便后续字符串比较
  const arg = args.trim().toLowerCase()
  // 获取当前主模型，用于判断该模型是否支持 advisor 特性
  const baseModel = parseUserSpecifiedModel(
    context.getAppState().mainLoopModel ?? getDefaultMainLoopModelSetting(),
  )

  // --- 情况 1：无参数，仅查询当前状态 ---
  if (!arg) {
    const current = context.getAppState().advisorModel
    if (!current) {
      // 尚未配置顾问模型，引导用户设置
      return {
        type: 'text',
        value:
          'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor opus").',
      }
    }
    if (!modelSupportsAdvisor(baseModel)) {
      // 已配置但主模型不支持，标记为非活跃状态并说明原因
      return {
        type: 'text',
        value: `Advisor: ${current} (inactive)\nThe current model (${baseModel}) does not support advisors.`,
      }
    }
    // 正常运行中，提示如何修改或禁用
    return {
      type: 'text',
      value: `Advisor: ${current}\nUse "/advisor unset" to disable or "/advisor <model>" to change.`,
    }
  }

  // --- 情况 2：用户要求禁用 advisor ---
  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    // 若当前已有顾问模型则清除，否则保持状态不变（避免不必要的重渲染）
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    // 同步更新用户级持久化设置
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return {
      type: 'text',
      value: prev
        ? `Advisor disabled (was ${prev}).`
        : 'Advisor already unset.',
    }
  }

  // --- 情况 3：用户尝试设置新的顾问模型 ---
  // 将用户输入的简短别名（如 "opus"）转换为 API 规范模型名
  const normalizedModel = normalizeModelStringForAPI(arg)
  // 进一步解析为内部使用的模型标识符
  const resolvedModel = parseUserSpecifiedModel(arg)
  // 调用 API 验证模型是否真实存在且可用
  const { valid, error } = await validateModel(resolvedModel)
  if (!valid) {
    return {
      type: 'text',
      value: error
        ? `Invalid advisor model: ${error}`
        : `Unknown model: ${arg} (${resolvedModel})`,
    }
  }

  // 检查该模型是否符合 advisor 的特定约束（如最低能力要求）
  if (!isValidAdvisorModel(resolvedModel)) {
    return {
      type: 'text',
      value: `The model ${arg} (${resolvedModel}) cannot be used as an advisor`,
    }
  }

  // 更新 AppState 中的顾问模型（幂等：若与当前值相同则不触发重渲染）
  context.setAppState(s => {
    if (s.advisorModel === normalizedModel) return s
    return { ...s, advisorModel: normalizedModel }
  })
  // 持久化写入用户设置文件
  updateSettingsForSource('userSettings', { advisorModel: normalizedModel })

  // 若主模型不支持 advisor，给出警告但仍完成设置（方便用户提前配置）
  if (!modelSupportsAdvisor(baseModel)) {
    return {
      type: 'text',
      value: `Advisor set to ${normalizedModel}.\nNote: Your current model (${baseModel}) does not support advisors. Switch to a supported model to use the advisor.`,
    }
  }

  return {
    type: 'text',
    value: `Advisor set to ${normalizedModel}.`,
  }
}

/**
 * /advisor 命令注册描述符。
 *
 * isEnabled / isHidden 均依赖 canUserConfigureAdvisor()，
 * 确保该命令只对有权限的用户可见并可用。
 * supportsNonInteractive=true 允许在非交互式管道模式下调用。
 */
const advisor = {
  type: 'local',
  name: 'advisor',
  description: 'Configure the advisor model',
  // 接受模型名或 "off" 关键字
  argumentHint: '[<model>|off]',
  // 仅授权用户可启用此命令
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    // 无权限用户在命令列表中也不显示此命令
    return !canUserConfigureAdvisor()
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
