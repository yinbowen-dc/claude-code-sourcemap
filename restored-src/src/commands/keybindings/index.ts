/**
 * keybindings 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/keybindings` 命令的注册描述符。
 * 该命令用于打开或创建用户的键位绑定配置文件（keybindings.json），
 * 允许用户在外部编辑器中自定义快捷键。
 *
 * 功能门控：
 * - `isEnabled` 通过 `isKeybindingCustomizationEnabled()` 检查特性开关，
 *   该功能目前处于预览阶段，仅当特性开关打开时才对用户可见。
 * - `supportsNonInteractive: false` — 命令需要打开编辑器，不支持无界面批处理模式。
 */
import type { Command } from '../../commands.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'

/**
 * keybindings 命令描述符对象
 *
 * - name: 'keybindings' — 用户通过 `/keybindings` 触发
 * - isEnabled — 运行时检测键位绑定自定义特性是否已开启（预览功能门控）
 * - supportsNonInteractive: false — 需要启动外部编辑器，不可在非交互模式下运行
 * - type: 'local' — 本地执行，调用 call() 返回文本结果，不渲染 JSX UI
 * - load — 懒加载 keybindings.js 中的实际执行逻辑（文件创建 + 编辑器打开）
 */
const keybindings = {
  name: 'keybindings',
  description: 'Open or create your keybindings configuration file',
  // 键位绑定自定义为预览功能，通过特性开关控制是否启用
  isEnabled: () => isKeybindingCustomizationEnabled(),
  // 需要打开外部编辑器，禁止在非交互模式下调用
  supportsNonInteractive: false,
  type: 'local',
  // 按需懒加载键位绑定文件创建与编辑器打开逻辑
  load: () => import('./keybindings.js'),
} satisfies Command

export default keybindings
