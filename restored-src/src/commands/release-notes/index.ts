/**
 * release-notes 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/release-notes` → commands 注册表路由到本模块
 *   → 懒加载 release-notes.js（非 JSX，返回纯文本）
 *   → 输出版本更新日志文本到终端
 *
 * 主要功能：
 *   注册发布说明查看命令。类型为 'local'（非 JSX），执行后直接返回
 *   格式化的文本内容。supportsNonInteractive: true 表明此命令可在
 *   非交互式（headless / --print）模式下正常运行，适用于脚本调用或 CI 场景。
 */
import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: 'View release notes',
  name: 'release-notes',       // 斜杠命令名称
  type: 'local',               // 非 JSX 命令，执行结果为纯文本字符串
  supportsNonInteractive: true, // 可在 --print 等非交互模式下调用
  load: () => import('./release-notes.js'), // 懒加载更新日志获取与格式化逻辑
}

export default releaseNotes
