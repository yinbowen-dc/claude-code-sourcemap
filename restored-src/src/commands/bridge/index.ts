/**
 * /remote-control（别名 /rc）命令的入口注册模块。
 *
 * 在 Claude Code 的 Bridge 远程控制子系统中，此文件将 Remote Control 命令
 * 注册到命令中心。该命令允许用户将当前终端会话连接到远程控制服务，
 * 使外部客户端（如浏览器扩展或移动端）可以通过 Bridge 协议向 Claude 发送指令。
 *
 * 命令的可见性由两个条件联合控制：
 * 1. 编译时特性标志 BRIDGE_MODE 必须启用
 * 2. 运行时 isBridgeEnabled() 检查必须通过（例如配置了正确的环境变量）
 */
import { feature } from 'bun:bundle'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import type { Command } from '../../commands.js'

/**
 * 判断 Remote Control 命令是否应当启用。
 *
 * 同时检查编译期特性标志（feature('BRIDGE_MODE')）与运行时条件（isBridgeEnabled()），
 * 两者均满足才允许命令对用户可见并可用。
 *
 * @returns 是否启用 Remote Control 命令
 */
function isEnabled(): boolean {
  // 编译时检查：若 BRIDGE_MODE 特性未打包，直接禁用以减少代码体积
  if (!feature('BRIDGE_MODE')) {
    return false
  }
  // 运行时检查：验证 Bridge 连接所需的环境配置是否就绪
  return isBridgeEnabled()
}

/**
 * /remote-control 命令注册描述符。
 *
 * immediate=true 表示命令被触发后立即执行（无需等待当前轮次的 AI 响应完成），
 * 适合连接管理类操作。isHidden 与 isEnabled 保持同步，使命令在不可用时
 * 从帮助列表中完全隐藏。
 */
const bridge = {
  type: 'local-jsx',
  // 用户面向名称为 remote-control，区分内部实现名 bridge
  name: 'remote-control',
  // /rc 作为快捷别名，方便快速访问
  aliases: ['rc'],
  description: 'Connect this terminal for remote-control sessions',
  argumentHint: '[name]',
  isEnabled,
  get isHidden() {
    // 动态属性：每次访问时重新计算，与 isEnabled 状态保持一致
    return !isEnabled()
  },
  // 立即执行模式：连接操作不阻塞当前对话流程
  immediate: true,
  // 懒加载实际的 Bridge 连接逻辑
  load: () => import('./bridge.js'),
} satisfies Command

export default bridge
