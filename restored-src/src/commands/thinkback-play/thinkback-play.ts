/**
 * thinkback-play 命令的核心实现层。
 *
 * 本文件负责在 thinkback skill 安装目录中定位动画资源，
 * 并调用 playAnimation() 执行终端动画。
 * 执行链路：
 *   1. 从全局已安装插件注册表中查找 thinkback 插件的安装路径
 *   2. 拼接出 skill 目录（installPath/skills/thinkback）
 *   3. 将目录交给 playAnimation() 渲染帧动画
 *
 * 内外部用户使用不同的 marketplace 来源来区分插件 ID，
 * 从而支持 Anthropic 内部员工（USER_TYPE=ant）使用内部市场版本。
 */
import { join } from 'path'
import type { LocalCommandResult } from '../../commands.js'
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import { playAnimation } from '../thinkback/thinkback.js'

// 内部员工专用 marketplace 名称（通过 USER_TYPE=ant 标识）
const INTERNAL_MARKETPLACE_NAME = 'claude-code-marketplace'
// 要查找的 skill 目录名，对应 installPath/skills/thinkback
const SKILL_NAME = 'thinkback'

/**
 * 根据当前用户类型构造插件的全局唯一 ID。
 *
 * Anthropic 内部员工（USER_TYPE=ant）使用内部 marketplace，
 * 其余用户使用公开的官方 marketplace。
 * 返回的格式为 `thinkback@<marketplace>`，对应插件注册表的键。
 */
function getPluginId(): string {
  // 内部员工（ant）使用内部 marketplace，其余用户使用官方 marketplace
  const marketplaceName =
    process.env.USER_TYPE === 'ant'
      ? INTERNAL_MARKETPLACE_NAME
      : OFFICIAL_MARKETPLACE_NAME
  // 拼接成 "thinkback@<marketplace>" 格式作为插件注册表的键
  return `thinkback@${marketplaceName}`
}

/**
 * 命令的主执行函数，负责定位插件安装路径并触发动画播放。
 *
 * 流程：
 *   1. 加载 V2 版插件注册表，查询 thinkback 插件是否已安装
 *   2. 若未安装或路径缺失，返回提示文字告知用户先执行 /think-back
 *   3. 构造 skill 目录路径，调用 playAnimation() 渲染终端动画
 *   4. 将动画函数的结果消息包装为 LocalCommandResult 返回
 */
export async function call(): Promise<LocalCommandResult> {
  // 从磁盘加载 V2 格式的已安装插件配置文件
  const v2Data = loadInstalledPluginsV2()
  const pluginId = getPluginId()
  // 同一插件可能安装多个版本，取数组形式
  const installations = v2Data.plugins[pluginId]

  // 插件未安装：提示用户先运行 /think-back 进行安装
  if (!installations || installations.length === 0) {
    return {
      type: 'text' as const,
      value:
        'Thinkback plugin not installed. Run /think-back first to install it.',
    }
  }

  // 取第一个安装记录（通常只有一个）
  const firstInstall = installations[0]
  // 安装记录存在但路径字段缺失，属于异常状态
  if (!firstInstall?.installPath) {
    return {
      type: 'text' as const,
      value: 'Thinkback plugin installation path not found.',
    }
  }

  // 拼接 skill 目录：<installPath>/skills/thinkback
  const skillDir = join(firstInstall.installPath, 'skills', SKILL_NAME)
  // 调用共享的动画播放函数，传入 skill 目录以定位动画帧文件
  const result = await playAnimation(skillDir)
  // 将动画结果的消息字段包装为标准命令返回格式
  return { type: 'text' as const, value: result.message }
}
