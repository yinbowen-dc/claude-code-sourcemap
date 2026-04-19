/**
 * permissions 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/permissions`（或别名 `/allowed-tools`）→ commands 注册表路由
 *   到本模块 → 懒加载 permissions.js → 渲染权限管理 JSX 界面
 *
 * 主要功能：
 *   注册工具权限管理命令，允许用户查看并编辑"允许/拒绝"工具规则列表。
 *   通过 aliases 字段同时响应历史命令名 /allowed-tools，保持向后兼容。
 */
import type { Command } from '../../commands.js'

// 命令描述符：支持 allowed-tools 别名以兼容早期命令名称
const permissions = {
  type: 'local-jsx',                            // 本地进程内渲染 React 组件
  name: 'permissions',                          // 主命令名
  aliases: ['allowed-tools'],                   // 旧版命令名，向后兼容保留
  description: 'Manage allow & deny tool permission rules', // 帮助文本
  load: () => import('./permissions.js'),       // 懒加载权限管理 UI 实现
} satisfies Command

export default permissions
