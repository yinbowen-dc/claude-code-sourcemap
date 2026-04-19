/**
 * voice 命令的执行逻辑
 *
 * 本文件是 /voice 命令的核心实现层，负责对语音模式进行"带预检的开关切换"。
 * 在 Claude Code 语音功能链路中，本文件处于以下位置：
 *   用户执行 /voice
 *     → voice/index.ts 懒加载本文件
 *     → call() 执行预检与设置写入
 *     → settingsChangeDetector 通知 UI 层热更新语音按钮状态
 *
 * 关闭路径（Toggle OFF）：无需预检，直接写入配置并返回。
 *
 * 开启路径（Toggle ON）需依次通过以下 5 项预检：
 *   1. 全局语音模式可用性检查（登录状态 + kill-switch）
 *   2. 录音环境可用性检查（麦克风硬件）
 *   3. STT 流服务可用性检查（API 密钥 / OAuth token）
 *   4. 录音工具依赖检查（SoX 等系统工具是否已安装）
 *   5. 麦克风权限探测（提前触发 OS 权限授权弹窗）
 *
 * 所有检查通过后，写入配置、通知变更、上报事件并构造语言提示文本返回。
 */
import { normalizeLanguageForSTT } from '../../hooks/useVoice.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js'

// 语言提示最多显示的次数：超过此次数后不再重复提示当前 STT 语言
const LANG_HINT_MAX_SHOWS = 2

/**
 * voice 命令的入口函数，实现语音模式的带预检开关切换。
 *
 * 执行流程：
 *   - 若全局语音功能不可用（kill-switch / 未登录）→ 提前返回错误提示
 *   - 若当前已开启 → 直接关闭并返回（无需预检）
 *   - 若当前已关闭 → 依次执行 5 项预检，全部通过后写入配置开启语音
 *   - 开启后构造语言提示文本（含 STT 语言代码或回退警告）并返回
 */
export const call: LocalCommandCall = async () => {
  // ── 预检 0：全局语音可用性（登录状态 + 平台 kill-switch）──
  if (!isVoiceModeEnabled()) {
    // 区分两种不可用原因：未登录时给出登录引导，其他情况（kill-switch）给通用提示
    if (!isAnthropicAuthEnabled()) {
      return {
        type: 'text' as const,
        value:
          'Voice mode requires a Claude.ai account. Please run /login to sign in.',
      }
    }
    return {
      type: 'text' as const,
      value: 'Voice mode is not available.',
    }
  }

  // 读取当前用户设置，判断语音是否已开启
  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true

  // ── 关闭路径：直接写入配置，无需任何预检 ──
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      // 设置文件存在语法错误时，写入失败，提示用户检查配置文件
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    // 通知 UI 层配置已变更，触发语音按钮状态热更新
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Voice mode disabled.',
    }
  }

  // ── 开启路径：执行预检后再启用 ──
  // 懒加载语音相关服务模块，避免非语音场景加载不必要的依赖
  const { isVoiceStreamAvailable } = await import(
    '../../services/voiceStreamSTT.js'
  )
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // ── 预检 1：录音环境可用性（麦克风硬件是否存在）──
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      // 优先使用 reason 字段中的具体原因，否则给通用提示
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  // ── 预检 2：STT 流服务可用性（OAuth token 或 API key 是否存在）──
  if (!isVoiceStreamAvailable()) {
    return {
      type: 'text' as const,
      value:
        'Voice mode requires a Claude.ai account. Please run /login to sign in.',
    }
  }

  // ── 预检 3：录音工具依赖检查（SoX 等系统级录音工具是否已安装）──
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    // 若有已知的安装命令，在提示中一并展示，降低用户安装门槛
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  // ── 预检 4：麦克风权限探测 ──
  // 提前触发 OS 权限授权弹窗，避免用户第一次按住说话时才看到弹窗，影响体验
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    // 根据操作系统给出对应的权限设置路径指引
    if (process.platform === 'win32') {
      guidance = 'Settings → Privacy → Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      // macOS 路径
      guidance = 'System Settings → Privacy & Security → Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
    }
  }

  // ── 所有预检通过：写入配置开启语音 ──
  const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
  if (result.error) {
    // 设置文件写入失败，提示检查配置文件语法
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  // 通知 UI 层配置变更，触发语音按钮激活状态热更新
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })

  // 获取 Push-to-Talk 快捷键的可读显示文本（如 "Space"）
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  // 将用户配置的语言规范化为 STT 服务支持的语言代码
  const stt = normalizeLanguageForSTT(currentSettings.language)
  const cfg = getGlobalConfig()

  // ── 语言提示逻辑 ──
  // 若 STT 语言发生变化（含首次启用）则重置提示计数器
  const langChanged = cfg.voiceLangHintLastLanguage !== stt.code
  // langChanged 时从 0 开始计数，否则取历史计数
  const priorCount = langChanged ? 0 : (cfg.voiceLangHintShownCount ?? 0)
  // 未发生语言回退且未超过最大显示次数时才展示提示
  const showHint = !stt.fellBackFrom && priorCount < LANG_HINT_MAX_SHOWS

  let langNote = ''
  if (stt.fellBackFrom) {
    // 用户配置的语言不受 STT 支持，已回退为英语，给出警告和修改指引
    langNote = ` Note: "${stt.fellBackFrom}" is not a supported dictation language; using English. Change it via /config.`
  } else if (showHint) {
    // 展示当前 STT 使用的语言代码，引导用户通过 /config 修改
    langNote = ` Dictation language: ${stt.code} (/config to change).`
  }

  // 语言变更或需展示提示时，更新全局配置中的提示计数和最后语言记录
  if (langChanged || showHint) {
    saveGlobalConfig(prev => ({
      ...prev,
      // showHint 为 true 时递增计数，否则（langChanged 但不显示提示）保持为 0
      voiceLangHintShownCount: priorCount + (showHint ? 1 : 0),
      voiceLangHintLastLanguage: stt.code,
    }))
  }

  // 返回开启成功的提示，包含快捷键说明和可选的语言提示
  return {
    type: 'text' as const,
    value: `Voice mode enabled. Hold ${key} to record.${langNote}`,
  }
}
