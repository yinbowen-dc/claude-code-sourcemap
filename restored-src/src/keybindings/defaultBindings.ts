/**
 * @file defaultBindings.ts
 * @description 键位绑定系统的默认配置层。
 *
 * 【在 Claude Code 系统中的位置与作用】
 * 本文件处于键位绑定流水线的"数据源"起点：
 *   defaultBindings（本文件）→ loadUserBindings（加载并合并用户覆盖）
 *     → resolver（解析按键事件为 action）→ useKeybinding（React Hook 响应）
 *
 * 职责：
 * - 定义所有内置快捷键，按 UI 上下文（Context）分组，形成 `DEFAULT_BINDINGS` 数组。
 * - 处理平台差异（Windows / macOS / Linux）及运行时差异（Node.js / Bun 版本）。
 * - 用户的 keybindings.json 会在此基础上追加，通过"后者优先"规则实现覆盖。
 *
 * 注意：ctrl+c / ctrl+d 虽在此定义，但被 reservedShortcuts.ts 标记为不可重绑，
 * 用户尝试覆盖时 validate.ts 会给出错误提示。
 */

import { feature } from 'bun:bundle'
import { satisfies } from 'src/utils/semver.js'
import { isRunningWithBun } from '../utils/bundledMode.js'
import { getPlatform } from '../utils/platform.js'
import type { KeybindingBlock } from './types.js'

/**
 * Default keybindings that match current Claude Code behavior.
 * These are loaded first, then user keybindings.json overrides them.
 */

// 图片粘贴快捷键的平台差异：
// - Windows：使用 alt+v（因为 ctrl+v 已被系统占用作为粘贴）
// - 其他平台：使用 ctrl+v
const IMAGE_PASTE_KEY = getPlatform() === 'windows' ? 'alt+v' : 'ctrl+v'

// 仅修饰键的和弦（如 shift+tab）在不支持 VT 模式的 Windows Terminal 上可能失效。
// 参考 issue：https://github.com/microsoft/terminal/issues/879#issuecomment-618801651
// Node.js 从 24.2.0 / 22.17.0 起启用 VT 模式：https://github.com/nodejs/node/pull/58358
// Bun 从 1.2.23 起启用 VT 模式：https://github.com/oven-sh/bun/pull/21161
const SUPPORTS_TERMINAL_VT_MODE =
  getPlatform() !== 'windows' || // 非 Windows 平台直接支持
  (isRunningWithBun()
    ? satisfies(process.versions.bun, '>=1.2.23')         // Bun 运行时的版本门槛
    : satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0')) // Node.js 版本门槛

// 模式切换快捷键的平台差异：
// - Windows 且不支持 VT 模式：使用 meta+m（shift+tab 不可靠）
// - 其他情况：使用 shift+tab
const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    // 全局上下文：无论焦点在哪里都生效的快捷键
    context: 'Global',
    bindings: {
      // ctrl+c 和 ctrl+d 使用特殊的"双击计时"处理逻辑。
      // 在此定义是为了让 resolver 能找到它们，但用户不能重绑——
      // reservedShortcuts.ts 的校验会在用户尝试覆盖时报错。
      'ctrl+c': 'app:interrupt',   // 中断当前操作（双击退出）
      'ctrl+d': 'app:exit',         // 退出程序（双击退出）
      'ctrl+l': 'app:redraw',       // 重绘终端界面
      'ctrl+t': 'app:toggleTodos',  // 切换 Todo 面板
      'ctrl+o': 'app:toggleTranscript', // 切换对话记录面板
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? { 'ctrl+shift+b': 'app:toggleBrief' as const } // 切换摘要面板（KAIROS 特性）
        : {}),
      'ctrl+shift+o': 'app:toggleTeammatePreview', // 切换 Teammate 预览
      'ctrl+r': 'history:search',   // 打开历史命令搜索
      // 文件导航。cmd+ 绑定仅在支持 kitty 协议的终端生效；
      // ctrl+shift 是更兼容的备用方案。
      ...(feature('QUICK_SEARCH')
        ? {
            'ctrl+shift+f': 'app:globalSearch' as const, // 全局搜索
            'cmd+shift+f': 'app:globalSearch' as const,  // 全局搜索（kitty 终端）
            'ctrl+shift+p': 'app:quickOpen' as const,    // 快速打开文件
            'cmd+shift+p': 'app:quickOpen' as const,     // 快速打开文件（kitty 终端）
          }
        : {}),
      ...(feature('TERMINAL_PANEL') ? { 'meta+j': 'app:toggleTerminal' } : {}), // 切换终端面板
    },
  },
  {
    // 聊天上下文：聊天输入框获得焦点时生效
    context: 'Chat',
    bindings: {
      escape: 'chat:cancel',   // 取消当前输入或操作
      // ctrl+x 作为和弦前缀，避免遮蔽 readline 的编辑快捷键（ctrl+a/b/e/f/...）
      'ctrl+x ctrl+k': 'chat:killAgents',     // 终止所有 agent
      [MODE_CYCLE_KEY]: 'chat:cycleMode',     // 循环切换输入模式（平台差异键）
      'meta+p': 'chat:modelPicker',           // 打开模型选择器
      'meta+o': 'chat:fastMode',              // 切换快速模式
      'meta+t': 'chat:thinkingToggle',        // 切换"思考"显示
      enter: 'chat:submit',                   // 提交消息
      up: 'history:previous',                 // 上一条历史命令
      down: 'history:next',                   // 下一条历史命令
      // 编辑快捷键（正在迁移中）
      // Undo 绑定了两个键以兼容不同终端行为：
      // - ctrl+_ 用于传统终端（发送 \x1f 控制字符）
      // - ctrl+shift+- 用于 Kitty 协议（发送带修饰符的物理键）
      'ctrl+_': 'chat:undo',
      'ctrl+shift+-': 'chat:undo',
      // ctrl+x ctrl+e 是 readline 原生的"编辑并执行"绑定
      'ctrl+x ctrl+e': 'chat:externalEditor',
      'ctrl+g': 'chat:externalEditor',        // 打开外部编辑器（备用绑定）
      'ctrl+s': 'chat:stash',                 // 暂存当前输入
      // 图片粘贴快捷键（平台差异键，见文件顶部）
      [IMAGE_PASTE_KEY]: 'chat:imagePaste',
      ...(feature('MESSAGE_ACTIONS')
        ? { 'shift+up': 'chat:messageActions' as const } // 打开消息操作菜单
        : {}),
      // 语音激活（按住说话）。此处注册是为了让 getShortcutDisplay 能找到它，
      // 避免触发 fallback 的分析日志。如需重绑，在配置中添加 voice:pushToTalk（后者优先）；
      // 如需禁用，使用 /voice 命令——直接 null 解绑 space 会导致空格键无法输入。
      ...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {}),
    },
  },
  {
    // 自动补全上下文：补全菜单可见时生效
    context: 'Autocomplete',
    bindings: {
      tab: 'autocomplete:accept',     // 接受当前补全项
      escape: 'autocomplete:dismiss', // 关闭补全菜单
      up: 'autocomplete:previous',    // 选择上一个补全项
      down: 'autocomplete:next',      // 选择下一个补全项
    },
  },
  {
    // 设置上下文：设置菜单打开时生效
    context: 'Settings',
    bindings: {
      // 设置菜单只用 escape 关闭（不使用 'n'）
      escape: 'confirm:no',
      // 配置面板列表导航（复用 Select 的 action）
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',  // vim 风格向上
      j: 'select:next',      // vim 风格向下
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      // 切换/激活选中的设置项（仅 space——enter 保存并关闭）
      space: 'select:accept',
      // 保存并关闭配置面板
      enter: 'settings:close',
      // 进入搜索模式
      '/': 'settings:search',
      // 重试加载使用数据（仅在出错时有效）
      r: 'settings:retry',
    },
  },
  {
    // 确认对话框上下文：确认/权限对话框显示时生效
    context: 'Confirmation',
    bindings: {
      y: 'confirm:yes',       // 确认
      n: 'confirm:no',        // 取消
      enter: 'confirm:yes',   // 回车确认
      escape: 'confirm:no',   // Esc 取消
      // 对话框含列表时的导航
      up: 'confirm:previous',
      down: 'confirm:next',
      tab: 'confirm:nextField',       // 切换到下一个字段
      space: 'confirm:toggle',        // 切换选项
      // 循环模式（用于文件权限对话框和团队对话框）
      'shift+tab': 'confirm:cycleMode',
      // 切换权限说明的展开/折叠
      'ctrl+e': 'confirm:toggleExplanation',
      // 切换权限调试信息
      'ctrl+d': 'permission:toggleDebug',
    },
  },
  {
    // 标签页上下文：标签页导航激活时生效
    context: 'Tabs',
    bindings: {
      // 标签页循环导航
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      right: 'tabs:next',
      left: 'tabs:previous',
    },
  },
  {
    // 对话记录上下文：查看对话记录时生效
    context: 'Transcript',
    bindings: {
      'ctrl+e': 'transcript:toggleShowAll', // 切换展示全部内容
      'ctrl+c': 'transcript:exit',          // 退出记录视图
      escape: 'transcript:exit',
      // q——分页器惯例（less、tmux copy-mode）。Transcript 是只读模态视图，
      // 没有输入提示符，q 不会被当作字面字符。
      q: 'transcript:exit',
    },
  },
  {
    // 历史搜索上下文：按 ctrl+r 进入历史搜索模式时生效
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'historySearch:next',    // 搜索下一条匹配历史
      escape: 'historySearch:accept',    // 接受选中项（不执行）
      tab: 'historySearch:accept',
      'ctrl+c': 'historySearch:cancel',  // 取消搜索
      enter: 'historySearch:execute',    // 接受并立即执行
    },
  },
  {
    // 任务上下文：前台有 bash 命令或 agent 正在运行时生效
    context: 'Task',
    bindings: {
      // 将前台任务切换到后台运行（bash 命令、agent）
      // 在 tmux 中，用户需按两次 ctrl+b（第一次是 tmux 前缀转义）
      'ctrl+b': 'task:background',
    },
  },
  {
    // 主题选择器上下文：主题选择面板打开时生效
    context: 'ThemePicker',
    bindings: {
      'ctrl+t': 'theme:toggleSyntaxHighlighting', // 切换语法高亮
    },
  },
  {
    // 滚动上下文：滚动区域获得焦点时生效
    context: 'Scroll',
    bindings: {
      pageup: 'scroll:pageUp',       // 向上翻页
      pagedown: 'scroll:pageDown',   // 向下翻页
      wheelup: 'scroll:lineUp',      // 鼠标滚轮向上
      wheeldown: 'scroll:lineDown',  // 鼠标滚轮向下
      'ctrl+home': 'scroll:top',     // 滚到顶部
      'ctrl+end': 'scroll:bottom',   // 滚到底部
      // 选区复制。ctrl+shift+c 是终端标准复制键。
      // cmd+c 仅在使用 kitty 键盘协议的终端（kitty/WezTerm/ghostty/iTerm2）生效，
      // 因为只有这些终端会将 super 修饰符传递给 pty——其他终端不会触发。
      // Esc 清除选区和上下文相关的 ctrl+c 通过原始 useInput 处理，以便有条件地传播事件。
      'ctrl+shift+c': 'selection:copy', // 复制选中文本
      'cmd+c': 'selection:copy',         // 复制选中文本（kitty 终端）
    },
  },
  {
    // 帮助上下文：帮助覆盖层打开时生效
    context: 'Help',
    bindings: {
      escape: 'help:dismiss', // 关闭帮助面板
    },
  },
  // 附件导航（选择对话框中的图片附件）
  {
    context: 'Attachments',
    bindings: {
      right: 'attachments:next',       // 下一个附件
      left: 'attachments:previous',    // 上一个附件
      backspace: 'attachments:remove', // 删除当前附件
      delete: 'attachments:remove',
      down: 'attachments:exit',        // 退出附件选择
      escape: 'attachments:exit',
    },
  },
  // 底部状态栏导航（任务、团队、diff、循环状态等）
  {
    context: 'Footer',
    bindings: {
      up: 'footer:up',
      'ctrl+p': 'footer:up',
      down: 'footer:down',
      'ctrl+n': 'footer:down',
      right: 'footer:next',             // 切换到下一个状态指示器
      left: 'footer:previous',          // 切换到上一个状态指示器
      enter: 'footer:openSelected',     // 打开选中项
      escape: 'footer:clearSelection',  // 清除选中状态
    },
  },
  // 消息选择器（回退对话框）导航
  {
    context: 'MessageSelector',
    bindings: {
      up: 'messageSelector:up',
      down: 'messageSelector:down',
      k: 'messageSelector:up',   // vim 风格
      j: 'messageSelector:down', // vim 风格
      'ctrl+p': 'messageSelector:up',
      'ctrl+n': 'messageSelector:down',
      'ctrl+up': 'messageSelector:top',    // 跳到第一条消息
      'shift+up': 'messageSelector:top',
      'meta+up': 'messageSelector:top',
      'shift+k': 'messageSelector:top',
      'ctrl+down': 'messageSelector:bottom',  // 跳到最后一条消息
      'shift+down': 'messageSelector:bottom',
      'meta+down': 'messageSelector:bottom',
      'shift+j': 'messageSelector:bottom',
      enter: 'messageSelector:select',    // 确认选中的消息
    },
  },
  // PromptInput 在光标激活时会卸载，因此不存在键冲突。
  ...(feature('MESSAGE_ACTIONS')
    ? [
        {
          context: 'MessageActions' as const,
          bindings: {
            up: 'messageActions:prev' as const,
            down: 'messageActions:next' as const,
            k: 'messageActions:prev' as const,   // vim 风格
            j: 'messageActions:next' as const,   // vim 风格
            // meta 在 macOS 上等同于 cmd；super 用于 kitty 键盘协议——两者都绑定。
            'meta+up': 'messageActions:top' as const,
            'meta+down': 'messageActions:bottom' as const,
            'super+up': 'messageActions:top' as const,
            'super+down': 'messageActions:bottom' as const,
            // 鼠标选区在 shift+方向键时会扩展（ScrollKeybindingHandler:573）——
            // 正确的分层 UX：先 esc 清除选区，再 shift+↑ 跳转。
            'shift+up': 'messageActions:prevUser' as const,
            'shift+down': 'messageActions:nextUser' as const,
            escape: 'messageActions:escape' as const,
            'ctrl+c': 'messageActions:ctrlc' as const,
            // 与 MESSAGE_ACTIONS 对称。未导入——避免将 React/ink 引入此配置模块。
            enter: 'messageActions:enter' as const,
            c: 'messageActions:c' as const,
            p: 'messageActions:p' as const,
          },
        },
      ]
    : []),
  // Diff 对话框导航
  {
    context: 'DiffDialog',
    bindings: {
      escape: 'diff:dismiss',           // 关闭 diff 对话框
      left: 'diff:previousSource',      // 切换到上一个来源
      right: 'diff:nextSource',         // 切换到下一个来源
      up: 'diff:previousFile',          // 上一个文件
      down: 'diff:nextFile',            // 下一个文件
      enter: 'diff:viewDetails',        // 查看详情
      // 注意：detail 模式中 diff:back 由左方向键处理
    },
  },
  // 模型选择器的推理强度调节（仅限 Anthropic 内部）
  {
    context: 'ModelPicker',
    bindings: {
      left: 'modelPicker:decreaseEffort',  // 降低推理强度
      right: 'modelPicker:increaseEffort', // 提高推理强度
    },
  },
  // Select 组件导航（用于 /model、/resume、权限提示等）
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      down: 'select:next',
      j: 'select:next',           // vim 风格
      k: 'select:previous',       // vim 风格
      'ctrl+n': 'select:next',
      'ctrl+p': 'select:previous',
      enter: 'select:accept',     // 确认选择
      escape: 'select:cancel',    // 取消选择
    },
  },
  // 插件对话框操作（管理、浏览、发现插件）
  // 列表导航（select:*）使用上面的 Select 上下文
  {
    context: 'Plugin',
    bindings: {
      space: 'plugin:toggle',  // 切换插件启用状态
      i: 'plugin:install',     // 安装插件
    },
  },
]
