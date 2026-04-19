/**
 * Unicode 符号常量
 *
 * 本文件集中定义 Claude Code 终端界面中使用的所有 Unicode 符号和图标。
 * 这些符号分为多个功能类别，用于状态指示、UI 装饰和动画效果。
 *
 * 平台适配说明：
 * - BLACK_CIRCLE 在 macOS 上使用 ⏺（视觉上更对齐），其他平台使用 ●（兼容性更好）
 *
 * 符号分类：
 * - 基础符号：圆圈、项目符号、星号等通用图标
 * - 箭头符号：方向指示、消息流向指示
 * - 努力等级指示符：用于显示当前推理努力级别（low/medium/high/max）
 * - 媒体/触发状态：播放/暂停图标
 * - MCP 订阅指示符：资源更新、频道消息、跨会话注入
 * - 审查状态指示符：钻石图标用于 ultrareview 状态
 * - Bridge 动画帧：用于 bridge 连接状态的 spinner 动画
 */
import { env } from '../utils/env.js'

// 平台感知的主状态圆圈符号：macOS 使用 ⏺（垂直对齐更好），Windows/Linux 使用 ●
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
// 小圆点，用于列表项目符号
export const BULLET_OPERATOR = '∙'
// 泪滴星号，用于特殊状态标记
export const TEARDROP_ASTERISK = '✻'
export const UP_ARROW = '\u2191'    // ↑ - 用于 opus 1m 合并通知
export const DOWN_ARROW = '\u2193'  // ↓ - 用于滚动提示
export const LIGHTNING_BOLT = '↯'  // \u21af - 用于快速模式（fast mode）指示符
export const EFFORT_LOW = '○'      // \u25cb - 努力等级：低
export const EFFORT_MEDIUM = '◐'   // \u25d0 - 努力等级：中
export const EFFORT_HIGH = '●'     // \u25cf - 努力等级：高
export const EFFORT_MAX = '◉'      // \u25c9 - 努力等级：最高（仅 Opus 4.6）

// 媒体/触发状态指示符
export const PLAY_ICON = '\u25b6'  // ▶ - 播放/运行中
export const PAUSE_ICON = '\u23f8' // ⏸ - 暂停

// MCP 订阅相关指示符
export const REFRESH_ARROW = '\u21bb'  // ↻ - 资源更新指示符
export const CHANNEL_ARROW = '\u2190'  // ← - 入站频道消息指示符
export const INJECTED_ARROW = '\u2192' // → - 跨会话注入消息指示符
export const FORK_GLYPH = '\u2442'     // ⑂ - fork 指令指示符

// 审查状态指示符（ultrareview 钻石状态）
export const DIAMOND_OPEN = '\u25c7'    // ◇ - 运行中
export const DIAMOND_FILLED = '\u25c6'  // ◆ - 已完成/已失败
export const REFERENCE_MARK = '\u203b' // ※ - 来目印（komejirushi），用于 away 摘要回顾标记

// 问题标志指示符
export const FLAG_ICON = '\u2691' // ⚑ - 用于问题标志横幅

// 引用块指示符
export const BLOCKQUOTE_BAR = '\u258e'    // ▎ - 左四分之一块，用作引用行前缀
export const HEAVY_HORIZONTAL = '\u2501'  // ━ - 粗水平线，用于分隔线

// Bridge 连接状态 spinner 动画帧（循环播放以表示连接中）
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',         // ·|·
  '\u00b7/\u00b7',         // ·/·
  '\u00b7\u2014\u00b7',    // ·—·
  '\u00b7\\\u00b7',        // ·\·
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'  // ·✔︎· - bridge 已就绪
export const BRIDGE_FAILED_INDICATOR = '\u00d7'                    // × - bridge 连接失败
