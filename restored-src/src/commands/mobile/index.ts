/**
 * commands/mobile/index.ts
 *
 * 【在系统流程中的位置】
 * 命令注册层 — 负责向 REPL 主循环注册 /mobile 命令（及其别名 /ios、/android）。
 * 启动时由命令加载器统一扫描，与其他 local-jsx 命令一同挂载到斜杠命令列表。
 *
 * 【主要功能】
 * 声明 `mobile` 命令的元数据对象。该命令在终端内渲染一个二维码，
 * 引导用户扫码下载 Claude 移动端 App（iOS / Android），
 * 实现 PC 端与移动端之间的无缝跳转入口。
 * 通过 `aliases` 字段同时响应 /ios 和 /android，方便平台相关的直达触发。
 */

import type { Command } from '../../commands.js'

// 命令描述符：声明 /mobile（别名 /ios、/android）的元数据及懒加载入口
const mobile = {
  // 'local-jsx'：在本地终端中以 React/Ink 渲染 QR 码组件
  type: 'local-jsx',
  name: 'mobile',
  // 别名列表，允许用户分别用 /ios 或 /android 触发同一命令
  aliases: ['ios', 'android'],
  description: 'Show QR code to download the Claude mobile app',
  // 懒加载：仅在命令被触发时才引入 mobile.js 的组件实现
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
