/**
 * 上下文窗口升级检测模块（Context Window Upgrade Check）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件处于模型选项呈现的辅助提示层，当用户当前使用的模型有对应的
 * 1M 上下文窗口升级路径时，向其展示切换建议。
 *
 * 调用链路：
 *   渲染层（REPL / 上下文窗口警告组件）
 *     → getUpgradeMessage('warning' | 'tip')
 *     → getAvailableUpgrade()
 *     → checkOpus1mAccess / checkSonnet1mAccess（check1mAccess.ts）
 *     → getUserSpecifiedModelSetting（model.ts）
 *
 * 【主要功能】
 * - getAvailableUpgrade  : 检测当前模型是否有 1M 上下文升级路径（模块内部函数）
 * - getUpgradeMessage    : 根据展示场景（warning / tip）返回对应的升级提示字符串
 */

import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getUserSpecifiedModelSetting } from './model.js'

// @[MODEL LAUNCH]: Add a branch for the new model if it supports a 1M context upgrade path.
/**
 * 检测当前用户是否有可用的上下文窗口升级路径。
 *
 * 【升级条件】
 * 1. 当前模型设置为 'opus' 且 checkOpus1mAccess() 返回 true
 *    → 推荐升级至 opus[1m]（5 倍上下文倍率）
 * 2. 当前模型设置为 'sonnet' 且 checkSonnet1mAccess() 返回 true
 *    → 推荐升级至 sonnet[1m]（5 倍上下文倍率）
 * 其他情况（haiku、自定义模型等）暂无升级路径，返回 null。
 *
 * @returns 升级信息对象（alias/name/multiplier），或 null（无可用升级）
 */
function getAvailableUpgrade(): {
  alias: string
  name: string
  multiplier: number
} | null {
  // 获取用户当前配置的模型设置（别名或完整 ID）
  const currentModelSetting = getUserSpecifiedModelSetting()
  if (currentModelSetting === 'opus' && checkOpus1mAccess()) {
    // 当前为 Opus 且有权访问 1M 上下文，推荐升级
    return {
      alias: 'opus[1m]',
      name: 'Opus 1M',
      multiplier: 5,
    }
  } else if (currentModelSetting === 'sonnet' && checkSonnet1mAccess()) {
    // 当前为 Sonnet 且有权访问 1M 上下文，推荐升级
    return {
      alias: 'sonnet[1m]',
      name: 'Sonnet 1M',
      multiplier: 5,
    }
  }

  // 无可用升级路径
  return null
}

/**
 * 根据展示场景生成上下文窗口升级提示文字。
 *
 * 【场景说明】
 * - 'warning' : 用于上下文窗口接近上限时的警告提示，返回可直接执行的 /model 命令
 *               例如："/model opus[1m]"
 * - 'tip'     : 用于模型选择器旁的主动提示，返回功能说明文字
 *               例如："Tip: You have access to Opus 1M with 5x more context"
 *
 * @param context 展示场景类型（'warning' 或 'tip'）
 * @returns 提示字符串，若无可用升级则返回 null
 */
export function getUpgradeMessage(context: 'warning' | 'tip'): string | null {
  const upgrade = getAvailableUpgrade()
  // 无升级路径时不显示任何提示
  if (!upgrade) return null

  switch (context) {
    case 'warning':
      // 警告场景：返回用户可直接输入的 /model 命令
      return `/model ${upgrade.alias}`
    case 'tip':
      // 提示场景：返回功能说明文字，告知用户访问权限和上下文倍率
      return `Tip: You have access to ${upgrade.name} with ${upgrade.multiplier}x more context`
    default:
      return null
  }
}
