/**
 * voice（/voice）命令注册入口
 *
 * 本文件在 Claude Code 命令系统中负责注册语音模式开关命令。
 * 用户执行 /voice 后，可以开启或关闭"按住说话"（Push-to-Talk）语音输入功能，
 * 通过麦克风实时录音并经语音转文字（STT）服务转化为文本输入。
 *
 * 可用性控制（双重门控）：
 *   1. isEnabled：通过 GrowthBook 特性开关检查语音功能是否已向当前用户灰度开放；
 *   2. isHidden（动态 getter）：仅当语音模式整体可用（isVoiceModeEnabled）时才显示，
 *      避免在未登录 claude.ai 或 kill-switch 关闭时暴露入口。
 *
 * 平台限制：仅 claude.ai 账号用户可用（availability: ['claude-ai']），
 * API key 直连模式下语音 STT 服务不可访问，不显示此命令。
 */
import type { Command } from '../../commands.js'
import {
  isVoiceGrowthBookEnabled,
  isVoiceModeEnabled,
} from '../../voice/voiceModeEnabled.js'

const voice = {
  // 纯本地命令，执行结果为文本，不调用 Claude 模型 API
  type: 'local',
  // 用户可见的命令名称
  name: 'voice',
  description: 'Toggle voice mode',
  // 仅对 claude.ai 登录用户展示，API key 用户无语音 STT 服务权限
  availability: ['claude-ai'],
  // 通过 GrowthBook 远程配置检查语音功能是否对当前用户开放（灰度控制）
  isEnabled: () => isVoiceGrowthBookEnabled(),
  /**
   * 动态隐藏逻辑：当语音模式整体不可用时（未登录、kill-switch 关闭等情况），
   * 将命令从帮助列表和命令补全中隐藏，避免用户看到无法使用的命令。
   * isVoiceModeEnabled() 综合了登录状态和平台开关，返回 false 时隐藏。
   */
  get isHidden() {
    return !isVoiceModeEnabled()
  },
  // 语音模式切换需要交互式终端，不支持管道/脚本等非交互场景
  supportsNonInteractive: false,
  // 懒加载执行模块，仅在命令被触发时才引入 voice.ts
  load: () => import('./voice.js'),
} satisfies Command

export default voice
