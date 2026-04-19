/**
 * doctor 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/doctor 命令用于对当前安装环境进行
 * 全面的健康检查与诊断，帮助用户发现并修复常见的配置问题，例如：
 * API 密钥缺失、Node.js 版本不兼容、网络连接异常、权限问题等。
 *
 * 本文件仅声明命令元数据，诊断逻辑和 Ink 渲染界面在 doctor.js 中，
 * 通过懒加载方式引入。可通过环境变量 DISABLE_DOCTOR_COMMAND 禁用该命令。
 */
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const doctor: Command = {
  name: 'doctor',
  description: 'Diagnose and verify your Claude Code installation and settings',
  // 若环境变量 DISABLE_DOCTOR_COMMAND 为真值，则在当前会话中禁用该命令
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  // local-jsx 类型：使用 Ink React 组件渲染诊断报告界面
  type: 'local-jsx',
  load: () => import('./doctor.js'),
}

export default doctor
