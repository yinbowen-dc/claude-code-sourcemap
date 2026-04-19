/**
 * sandbox-toggle 命令注册入口（commands/sandbox-toggle/index.ts）
 *
 * 本文件将 /sandbox 命令注册到 Claude Code 全局命令系统，用于配置沙箱隔离模式。
 * 沙箱模式通过系统级隔离机制（如 macOS Sandbox、Linux seccomp 等）限制 Bash 工具的
 * 执行权限，防止未经授权的文件系统访问和网络操作。
 *
 * 在系统流程中的位置：
 *   用户输入 /sandbox → 命令注册表匹配 → load() 懒加载 sandbox-toggle.js
 *   → 渲染沙箱配置界面（开启/关闭/排除规则设置）→ 更新本地配置文件。
 *
 * 特殊设计：
 *   - description 使用 getter 实现动态内容，每次渲染时读取最新的沙箱状态；
 *   - isHidden 使用 getter 确保非支持平台（Windows 等）自动隐藏该命令。
 */

import figures from 'figures'
import type { Command } from '../../commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

/**
 * /sandbox 命令描述对象。
 * description 和 isHidden 均为 getter，以便在每次命令列表渲染时动态反映当前沙箱状态。
 */
const command = {
  name: 'sandbox',
  /**
   * 动态生成命令描述，实时反映当前沙箱配置状态。
   * 描述格式：`<状态图标> <状态文本> (⏎ to configure)`
   *
   * 状态图标逻辑：
   *   - ⚠（warning）：依赖项缺失（如 sandbox 二进制不存在）
   *   - ✔（tick）：沙箱已启用
   *   - ○（circle）：沙箱已禁用
   *
   * 状态文本逻辑（从左到右叠加）：
   *   - 基础状态：'sandbox disabled' / 'sandbox enabled' / 'sandbox enabled (auto-allow)'
   *   - 若允许非沙箱命令回退：追加 ', fallback allowed'
   *   - 若设置被策略锁定：追加 ' (managed)'
   */
  get description() {
    const currentlyEnabled = SandboxManager.isSandboxingEnabled()      // 沙箱当前是否激活
    const autoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled() // 沙箱模式下是否自动允许 Bash
    const allowUnsandboxed = SandboxManager.areUnsandboxedCommandsAllowed() // 是否允许非沙箱命令作为 fallback
    const isLocked = SandboxManager.areSandboxSettingsLockedByPolicy()  // 是否被管理员策略锁定
    const hasDeps = SandboxManager.checkDependencies().errors.length === 0 // 沙箱依赖是否完整

    // Show warning icon if dependencies missing, otherwise enabled/disabled status
    // 依赖缺失时显示警告图标，否则根据启用状态显示勾/圆
    let icon: string
    if (!hasDeps) {
      icon = figures.warning
    } else {
      icon = currentlyEnabled ? figures.tick : figures.circle
    }

    let statusText = 'sandbox disabled'
    if (currentlyEnabled) {
      statusText = autoAllow
        ? 'sandbox enabled (auto-allow)'
        : 'sandbox enabled'

      // Add unsandboxed fallback status
      // 若存在非沙箱命令回退允许规则，在状态文本末尾追加说明
      statusText += allowUnsandboxed ? ', fallback allowed' : ''
    }

    if (isLocked) {
      // 被组织策略管控时追加 (managed)，提示用户无法手动修改
      statusText += ' (managed)'
    }

    return `${icon} ${statusText} (⏎ to configure)`
  },
  argumentHint: 'exclude "command pattern"', // 提示用户可传排除规则模式
  /**
   * 动态控制命令可见性：仅在支持平台且平台在启用列表中时显示。
   * 非支持平台（如 Windows）或未在启用列表中的平台自动隐藏该命令。
   */
  get isHidden() {
    return (
      !SandboxManager.isSupportedPlatform() ||        // 平台本身不支持沙箱
      !SandboxManager.isPlatformInEnabledList()        // 平台未加入沙箱启用白名单
    )
  },
  immediate: true,      // 立即执行，无需等待 AI 响应
  type: 'local-jsx',    // 渲染 JSX 配置界面
  load: () => import('./sandbox-toggle.js'),
} satisfies Command

export default command
