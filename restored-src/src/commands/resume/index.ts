/**
 * resume 命令的入口描述文件。
 *
 * 在 Claude Code 会话管理流程中，本文件声明了 /resume（及别名 /continue）命令，
 * 允许用户从会话列表中恢复之前的对话。命令系统加载此描述符后，当用户触发
 * /resume 时，通过懒加载拉起 resume.js 中的 JSX 界面（通常为交互式会话选择器），
 * 支持按会话 ID 或关键词搜索历史对话。
 */
import type { Command } from '../../commands.js'

// 声明 resume 命令描述符，显式标注类型以获得完整的类型检查
const resume: Command = {
  type: 'local-jsx',              // 渲染 JSX 组件，用于展示历史会话列表 UI
  name: 'resume',                 // 主命令名，对应 /resume 指令
  description: 'Resume a previous conversation',
  aliases: ['continue'],          // 别名 /continue，提升用户易用性
  argumentHint: '[conversation id or search term]', // 支持 ID 或搜索词定位历史会话
  load: () => import('./resume.js'), // 懒加载会话恢复的 JSX 实现
}

export default resume
