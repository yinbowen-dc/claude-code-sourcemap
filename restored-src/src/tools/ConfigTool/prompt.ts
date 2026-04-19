/**
 * ConfigTool/prompt.ts
 *
 * 【在系统中的位置】
 * 本文件负责为 ConfigTool 动态生成发送给 Claude 模型的工具提示词（system prompt 片段）。
 * 提示词内容会随运行时可用的配置项和模型列表变化，因此不能硬编码为静态字符串。
 * 被 ConfigTool.ts 的 prompt() 钩子调用，最终随系统提示一起注入上下文。
 *
 * 【主要功能】
 * 1. generatePrompt()：遍历 SUPPORTED_SETTINGS 注册表，按来源（global/settings）分组，
 *    生成可配置项列表，并附上使用说明和示例。
 * 2. generateModelSection()：调用 getModelOptions() 获取运行时模型列表，
 *    生成动态模型子章节；若获取失败则降级为静态描述。
 * 3. 通过 GrowthBook 门控过滤语音设置（kill-switch 打开时从提示词中隐藏 voiceEnabled）。
 */

import { feature } from 'bun:bundle'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { isVoiceGrowthBookEnabled } from '../../voice/voiceModeEnabled.js'
import {
  getOptionsForSetting,
  SUPPORTED_SETTINGS,
} from './supportedSettings.js'

// 工具的静态简短描述，用于 ConfigTool.description()
export const DESCRIPTION = 'Get or set Claude Code configuration settings.'

/**
 * 从 SUPPORTED_SETTINGS 注册表动态生成完整工具提示词。
 *
 * 流程：
 * 1. 遍历所有注册配置项（跳过 model，单独生成章节；跳过被 GrowthBook 屏蔽的语音设置）
 * 2. 按 source 分为全局设置和项目设置两组
 * 3. 每条配置项格式化为 "- key: options - description"
 * 4. 拼接模型动态章节和使用示例，返回完整提示词字符串
 */
export function generatePrompt(): string {
  const globalSettings: string[] = []  // 全局配置项行（~/.claude.json）
  const projectSettings: string[] = [] // 项目配置项行（settings.json）

  for (const [key, config] of Object.entries(SUPPORTED_SETTINGS)) {
    // model 单独处理，附带动态模型列表，不放入通用列表
    if (key === 'model') continue
    // 语音设置在构建时注册，但运行时受 GrowthBook 门控；kill-switch 打开时从提示词隐藏
    if (
      feature('VOICE_MODE') &&
      key === 'voiceEnabled' &&
      !isVoiceGrowthBookEnabled()
    )
      continue

    const options = getOptionsForSetting(key)
    // 基础格式：- keyName
    let line = `- ${key}`

    if (options) {
      // 枚举型：列出所有允许值
      line += `: ${options.map(o => `"${o}"`).join(', ')}`
    } else if (config.type === 'boolean') {
      // 布尔型：固定显示 true/false
      line += `: true/false`
    }

    // 追加配置项描述
    line += ` - ${config.description}`

    // 按存储来源分组
    if (config.source === 'global') {
      globalSettings.push(line)
    } else {
      projectSettings.push(line)
    }
  }

  // 动态生成模型章节
  const modelSection = generateModelSection()

  return `Get or set Claude Code configuration settings.

  View or change Claude Code settings. Use when the user requests configuration changes, asks about current settings, or when adjusting a setting would benefit them.


## Usage
- **Get current value:** Omit the "value" parameter
- **Set new value:** Include the "value" parameter

## Configurable settings list
The following settings are available for you to change:

### Global Settings (stored in ~/.claude.json)
${globalSettings.join('\n')}

### Project Settings (stored in settings.json)
${projectSettings.join('\n')}

${modelSection}
## Examples
- Get theme: { "setting": "theme" }
- Set dark theme: { "setting": "theme", "value": "dark" }
- Enable vim mode: { "setting": "editorMode", "value": "vim" }
- Enable verbose: { "setting": "verbose", "value": true }
- Change model: { "setting": "model", "value": "opus" }
- Change permission mode: { "setting": "permissions.defaultMode", "value": "plan" }
`
}

/**
 * 动态生成"模型"章节：调用 getModelOptions() 获取当前可用模型列表，
 * 将每个模型格式化为 "value: 描述" 条目。
 * 若 getModelOptions() 抛出异常（如网络不可用），降级为静态占位文本。
 */
function generateModelSection(): string {
  try {
    const options = getModelOptions()
    const lines = options.map(o => {
      // null 值表示"使用默认模型"
      const value = o.value === null ? 'null/"default"' : `"${o.value}"`
      return `  - ${value}: ${o.descriptionForModel ?? o.description}`
    })
    return `## Model
- model - Override the default model. Available options:
${lines.join('\n')}`
  } catch {
    // 降级：提供静态简短描述
    return `## Model
- model - Override the default model (sonnet, opus, haiku, best, or full model ID)`
  }
}
