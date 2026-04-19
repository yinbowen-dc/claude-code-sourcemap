/**
 * 文件：termio/osc.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的 OSC（Operating System Command，操作系统命令）
 * 序列生成与解析层。OSC 序列格式为 ESC ] code ; data BEL/ST，
 * 用于设置窗口标题、生成超链接、读写剪贴板、发送终端通知、上报进度等。
 * parser.ts 调用 parseOSC 解析输入流中的 OSC 序列；
 * useTerminalNotification.ts 和 terminal.ts 调用此处的生成函数构造输出序列。
 *
 * 【主要功能】
 * - `osc(...parts)`：生成 OSC 序列（kitty 用 ST 终止，其他用 BEL）
 * - `wrapForMultiplexer(sequence)`：将序列包裹为 tmux/screen DCS 透传格式
 * - `getClipboardPath()`：同步判断剪贴板写入路径（native/tmux-buffer/osc52）
 * - `setClipboard(text)`：异步写入剪贴板（优先原生工具，tmux buffer，最后 OSC 52）
 * - `parseOSC(content)`：解析 OSC 内容为语义 Action
 * - `parseOscColor(spec)`：解析 XParseColor 格式的颜色规格
 * - `link(url, params)`：生成 OSC 8 超链接序列
 * - `tabStatus(fields)`：生成 OSC 21337 标签状态序列
 * - `OSC/ITERM2/PROGRESS` 枚举：OSC 命令和子命令编号
 */

import { Buffer } from 'buffer'
import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './types.js'

/** OSC 序列前缀：ESC ] */
export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/** 字符串终止符（ST）：ESC \ —— OSC 序列的替代终止符（BEL 以外的选择） */
export const ST = ESC + '\\'

/**
 * 生成 OSC 序列：ESC ] p1;p2;...;pN <终止符>
 *
 * 【终止符选择】
 * - kitty：使用 ST（ESC \），因为 kitty 处理 BEL 时可能触发响铃
 * - 其他终端：使用 BEL（\x07），兼容性最好
 *
 * @param parts OSC 命令编号及数据参数（以 ';' 连接）
 * @returns 完整的 OSC 转义序列字符串
 */
export function osc(...parts: (string | number)[]): string {
  // kitty 终端使用 ST 终止符，避免 BEL 响铃
  const terminator = env.terminal === 'kitty' ? ST : BEL
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`
}

/**
 * 将转义序列包裹为终端多路复用器（tmux/screen）的 DCS 透传格式。
 *
 * 【背景】
 * tmux 和 GNU screen 会拦截所有转义序列；DCS 透传隧道将序列
 * 原样转发到外层终端，绕过多路复用器自身的解析器。
 *
 * 【注意事项】
 * - tmux 3.3+ 将此功能置于 `allow-passthrough` 选项之后（默认关闭）。
 *   关闭时 tmux 静默丢弃整个 DCS —— 不产生乱码，等同于未包裹的 OSC。
 * - 不要包裹 BEL：裸 \x07 会触发 tmux 的 bell-action（窗口标记）；
 *   包裹后的 \x07 作为不透明 DCS 载荷，tmux 永远看不到响铃。
 *
 * @param sequence 待透传的转义序列
 * @returns 包裹后的序列（在 tmux/screen 内），或原序列（不在多路复用器内）
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env['TMUX']) {
    // tmux DCS 透传：ESC P tmux ; <payload> ESC \，内部 ESC 需双写
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }
  if (process.env['STY']) {
    // GNU screen DCS 透传
    return `\x1bP${sequence}\x1b\\`
  }
  // 不在多路复用器内，直接返回原序列
  return sequence
}

/**
 * 同步判断 setClipboard() 将使用的剪贴板写入路径。
 * 调用方可据此显示诚实的提示信息，无需等待复制操作完成。
 *
 * 【路径说明】
 * - 'native'：将运行 pbcopy 或同等工具 —— 高置信度系统剪贴板写入
 * - 'tmux-buffer'：将运行 tmux load-buffer，但无原生工具 ——
 *   可用 prefix+] 粘贴。系统剪贴板取决于 tmux set-clipboard 选项
 *   + 外层终端 OSC 52 支持，此处无法确定
 * - 'osc52'：仅向 stdout 写出原始 OSC 52 序列 ——
 *   尽力而为；iTerm2 默认禁用 OSC 52
 *
 * 使用 SSH_CONNECTION 而非 SSH_TTY 判断是否在 SSH 会话中：
 * tmux 面板会永久继承 SSH_TTY，即使本地重连后也不清除；
 * 而 SSH_CONNECTION 在 tmux 的默认 update-environment 集合中，
 * 本地重连时会被清除。
 *
 * @returns 剪贴板写入路径标识符
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function getClipboardPath(): ClipboardPath {
  // 本地 macOS 且无 SSH 连接：使用原生 pbcopy
  const nativeAvailable =
    process.platform === 'darwin' && !process.env['SSH_CONNECTION']
  if (nativeAvailable) return 'native'
  // 在 tmux 内：使用 tmux load-buffer
  if (process.env['TMUX']) return 'tmux-buffer'
  // 其他情况：回退到 OSC 52
  return 'osc52'
}

/**
 * 将载荷包裹为 tmux 的 DCS 透传格式：ESC P tmux ; <payload> ESC \
 * tmux 会将载荷转发到外层终端，绕过自身解析器。
 * 内部 ESC 必须双写。需在 ~/.tmux.conf 中设置 `set -g allow-passthrough on`；
 * 未设置时 tmux 静默丢弃整个 DCS，无回归影响。
 *
 * @param payload 待透传的转义序列
 * @returns DCS 透传格式字符串
 */
function tmuxPassthrough(payload: string): string {
  return `${ESC}Ptmux;${payload.replaceAll(ESC, ESC + ESC)}${ST}`
}

/**
 * 通过 `tmux load-buffer` 将文本加载到 tmux 粘贴缓冲区。
 *
 * 【参数说明】
 * - -w 标志（tmux 3.2+）：通过 tmux 自身的 OSC 52 将缓冲区传播到外层终端剪贴板
 * - iTerm2 例外：tmux 发送的 OSC 52（空 selection 参数）会导致 iTerm2 在 SSH 下崩溃，
 *   因此对 iTerm2 丢弃 -w 标志
 *
 * @param text 要加载的文本内容
 * @returns 缓冲区加载成功时返回 true
 */
export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  // 不在 tmux 内时直接返回 false
  if (!process.env['TMUX']) return false
  // iTerm2 下省略 -w 以避免 SSH 崩溃（#22432）
  const args =
    process.env['LC_TERMINAL'] === 'iTerm2'
      ? ['load-buffer', '-']
      : ['load-buffer', '-w', '-']
  const { code } = await execFileNoThrow('tmux', args, {
    input: text,
    useCwd: false,
    timeout: 2000,
  })
  return code === 0
}

/**
 * 将文本写入系统剪贴板。
 *
 * 【写入策略（多路优先）】
 * 1. 若非 SSH 会话，立即 fire-and-forget 调用原生工具（pbcopy/wl-copy 等）——
 *    在 tmux await 之前先行启动，防止用户快速 cmd+tab 后粘贴时产生竞争
 * 2. 若在 tmux 内，await tmux load-buffer（确保缓冲区可用）
 * 3. 无论 tmux 结果如何，同时生成 OSC 52 序列供调用方写入 stdout：
 *    - tmux 成功：返回 DCS 透传包裹的 OSC 52
 *    - tmux 失败：返回裸 OSC 52
 *
 * @param text 要复制到剪贴板的文本
 * @returns 调用方应写入 stdout 的 OSC 52 序列（tmux 内为 DCS 包裹版）
 */
export async function setClipboard(text: string): Promise<string> {
  // 将文本编码为 base64，用于 OSC 52 序列
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const raw = osc(OSC.CLIPBOARD, 'c', b64)

  // 原生工具作为安全网 —— 在 tmux await 之前先行启动，
  // 防止快速 cmd+tab → 粘贴的竞争条件。
  // 用 SSH_CONNECTION（非 SSH_TTY）判断：tmux 面板会永久继承 SSH_TTY，
  // 但 SSH_CONNECTION 在本地重连时会被清除。fire-and-forget。
  if (!process.env['SSH_CONNECTION']) copyNative(text)

  // 等待 tmux 缓冲区加载
  const tmuxBufferLoaded = await tmuxLoadBuffer(text)

  // 内部 OSC 使用裸 BEL（不通过 osc()）—— ST 的 ESC 也需要双写，
  // 而 BEL 在 OSC 52 的所有终端中均可用。
  if (tmuxBufferLoaded) return tmuxPassthrough(`${ESC}]52;c;${b64}${BEL}`)
  return raw
}

// Linux 剪贴板工具缓存：undefined = 尚未探测，null = 无可用工具。
// 探测顺序：wl-copy（Wayland）→ xclip（X11）→ xsel（X11 备选）。
// 首次调用后缓存结果，后续 mouse-up 无需重复探测。
let linuxCopy: 'wl-copy' | 'xclip' | 'xsel' | null | undefined

/**
 * 调用原生剪贴板工具作为 OSC 52 的安全补充。
 * 仅在非 SSH 会话中调用（SSH 下这些工具会写入远程机器的剪贴板，
 * OSC 52 才是正确路径）。
 * fire-and-forget：失败静默忽略，因为 OSC 52 可能已成功。
 *
 * 【Linux 探测逻辑】
 * 首次调用时按 wl-copy → xclip → xsel 顺序探测，缓存第一个成功的工具；
 * 若全部失败则缓存 null，后续调用跳过探测。
 *
 * @param text 要复制到剪贴板的文本
 */
function copyNative(text: string): void {
  const opts = { input: text, useCwd: false, timeout: 2000 }
  switch (process.platform) {
    case 'darwin':
      // macOS：使用 pbcopy
      void execFileNoThrow('pbcopy', [], opts)
      return
    case 'linux': {
      // 已缓存 null = 无可用工具，直接返回
      if (linuxCopy === null) return
      // 使用已缓存的工具
      if (linuxCopy === 'wl-copy') {
        void execFileNoThrow('wl-copy', [], opts)
        return
      }
      if (linuxCopy === 'xclip') {
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts)
        return
      }
      if (linuxCopy === 'xsel') {
        void execFileNoThrow('xsel', ['--clipboard', '--input'], opts)
        return
      }
      // 首次调用：按顺序探测可用工具并缓存结果
      void execFileNoThrow('wl-copy', [], opts).then(r => {
        if (r.code === 0) {
          linuxCopy = 'wl-copy'
          return
        }
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts).then(
          r2 => {
            if (r2.code === 0) {
              linuxCopy = 'xclip'
              return
            }
            void execFileNoThrow('xsel', ['--clipboard', '--input'], opts).then(
              r3 => {
                // 缓存最终结果：成功的工具名称或 null
                linuxCopy = r3.code === 0 ? 'xsel' : null
              },
            )
          },
        )
      })
      return
    }
    case 'win32':
      // Windows：clip.exe 始终可用。Unicode 处理依赖系统区域编码，
      // 不完美但作为备选足够使用。
      void execFileNoThrow('clip', [], opts)
      return
  }
}

/** @internal 仅用于测试：重置 Linux 剪贴板工具缓存 */
export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined
}

/**
 * OSC 命令编号枚举。
 * 对应 OSC N 中的 N 值，决定序列的功能类型。
 */
export const OSC = {
  SET_TITLE_AND_ICON: 0,     // 同时设置窗口标题和图标名称
  SET_ICON: 1,               // 设置图标名称
  SET_TITLE: 2,              // 设置窗口标题
  SET_COLOR: 4,              // 设置颜色
  SET_CWD: 7,                // 设置当前工作目录（shell 集成）
  HYPERLINK: 8,              // OSC 8 超链接
  ITERM2: 9,                 // iTerm2 专有序列（通知、徽章、进度）
  SET_FG_COLOR: 10,          // 查询/设置前景色
  SET_BG_COLOR: 11,          // 查询/设置背景色
  SET_CURSOR_COLOR: 12,      // 查询/设置光标颜色
  CLIPBOARD: 52,             // OSC 52 剪贴板操作
  KITTY: 99,                 // Kitty 通知协议
  RESET_COLOR: 104,          // 重置颜色
  RESET_FG_COLOR: 110,       // 重置前景色
  RESET_BG_COLOR: 111,       // 重置背景色
  RESET_CURSOR_COLOR: 112,   // 重置光标颜色
  SEMANTIC_PROMPT: 133,      // 语义提示符标记（shell 集成）
  GHOSTTY: 777,              // Ghostty 通知协议
  TAB_STATUS: 21337,         // 标签状态扩展（自定义扩展）
} as const

/**
 * 将 OSC 内容字符串解析为语义 Action。
 *
 * 【流程】
 * 1. 提取命令编号（第一个 ';' 之前的部分）和数据（之后的部分）
 * 2. 将命令编号解析为整数
 * 3. 按命令编号分发到对应的解析逻辑：
 *    - 0/1/2：窗口/图标标题设置
 *    - 8：超链接（解析 params 键值对和 URL）
 *    - 21337：标签状态（调用 parseTabStatus）
 *    - 其他：返回 unknown 类型 Action
 *
 * @param content OSC 序列内容（不含 ESC ] 前缀和终止符）
 * @returns 语义 Action，或 null（解析失败）
 */
export function parseOSC(content: string): Action | null {
  // 分离命令编号和数据部分
  const semicolonIdx = content.indexOf(';')
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : ''

  const commandNum = parseInt(command, 10)

  // 窗口/图标标题命令
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } }
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } }
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } }
  }

  // OSC 8 超链接
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';')
    const paramsStr = parts[0] ?? ''
    const url = parts.slice(1).join(';')

    // 空 URL 表示超链接结束
    if (url === '') {
      return { type: 'link', action: { type: 'end' } }
    }

    // 解析 params 部分（冒号分隔的键=值对）
    const params: Record<string, string> = {}
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        // 有参数时才传入 params 对象
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    }
  }

  // OSC 21337 标签状态（自定义扩展）
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) }
  }

  // 未识别的 OSC 命令：返回 unknown 类型 Action
  return { type: 'unknown', sequence: `\x1b]${content}` }
}

/**
 * 解析 XParseColor 风格的颜色规格为 RGB Color 对象。
 *
 * 【支持的格式】
 * - `#RRGGBB`：6 位十六进制 RGB
 * - `rgb:R/G/B`：1–4 位十六进制每分量（按 XParseColor 规范缩放到 8 位）
 *
 * 缩放公式：value / (16^N - 1) × 255，其中 N 为十六进制位数。
 *
 * @param spec 颜色规格字符串
 * @returns 解析成功时返回 RGB Color，失败时返回 null
 */
export function parseOscColor(spec: string): Color | null {
  // 尝试解析 #RRGGBB 格式
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    }
  }
  // 尝试解析 rgb:R/G/B 格式（每分量 1-4 位十六进制）
  const rgb = spec.match(
    /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i,
  )
  if (rgb) {
    // XParseColor 缩放：N 位十六进制 → value / (16^N - 1) × 255
    const scale = (s: string) =>
      Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255)
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    }
  }
  return null
}

/**
 * 解析 OSC 21337 载荷字符串为 TabStatusAction 对象。
 *
 * 载荷格式：`key=value;key=value;...`，支持 `\;` 和 `\\` 转义。
 * 裸 key 或 `key=` 表示清除该字段；未知键忽略。
 *
 * @param data OSC 21337 的数据部分
 * @returns 解析后的 TabStatusAction 对象
 */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        // 空值清除字段，否则解析为颜色
        action.indicator = value === '' ? null : parseOscColor(value)
        break
      case 'status':
        // 空值清除字段，否则使用字符串值
        action.status = value === '' ? null : value
        break
      case 'status-color':
        // 空值清除字段，否则解析为颜色
        action.statusColor = value === '' ? null : parseOscColor(value)
        break
    }
  }
  return action
}

/**
 * 分割 OSC 21337 载荷中的键值对，支持 `\;` 和 `\\` 转义序列。
 * 生成器函数，逐一 yield [key, unescapedValue] 对。
 *
 * @param data OSC 21337 数据部分字符串
 */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = ''
  let val = ''
  let inVal = false  // 是否已遇到 '='，当前在值部分
  let esc = false    // 下一个字符是否被 '\\' 转义

  for (const c of data) {
    if (esc) {
      // 转义字符：原样追加（支持 \; 和 \\）
      if (inVal) val += c
      else key += c
      esc = false
    } else if (c === '\\') {
      // 设置转义标志
      esc = true
    } else if (c === ';') {
      // 分隔符：yield 当前键值对并重置状态
      yield [key, val]
      key = ''
      val = ''
      inVal = false
    } else if (c === '=' && !inVal) {
      // 键值分隔符：切换到值模式
      inVal = true
    } else if (inVal) {
      val += c
    } else {
      key += c
    }
  }
  // 处理最后一个未以 ';' 结尾的键值对
  if (key || inVal) yield [key, val]
}

// 输出生成函数

/**
 * 生成 OSC 8 超链接开始序列。
 *
 * 【自动 id 参数】
 * 自动根据 URL 派生 id= 参数，确保终端将同一链接的折行单元格归为一组
 * （规范规定：URI 相同且 id 非空的单元格相互关联；无 id 时每折行行都是独立链接，
 * 导致悬停不一致、提示截断等问题）。
 * 空 URL 生成关闭序列（空 params，符合规范）。
 *
 * @param url    目标 URL（空字符串生成关闭序列）
 * @param params 可选的额外参数键值对
 * @returns OSC 8 超链接序列字符串
 */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END
  // 合并 id 参数和额外参数
  const p = { id: osc8Id(url), ...params }
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':')
  return osc(OSC.HYPERLINK, paramStr, url)
}

/**
 * 根据 URL 生成 OSC 8 id 参数值（简单哈希，转为 36 进制字符串）。
 * 保证同一 URL 始终产生相同 id，使终端能正确关联折行的超链接单元格。
 *
 * @param url 目标 URL 字符串
 * @returns 36 进制哈希字符串
 */
function osc8Id(url: string): string {
  let h = 0
  // djb2 哈希变体：h = ((h << 5) - h + charCode) | 0
  for (let i = 0; i < url.length; i++)
    h = ((h << 5) - h + url.charCodeAt(i)) | 0
  // 转为无符号 32 位整数再转 36 进制
  return (h >>> 0).toString(36)
}

/** OSC 8 超链接结束序列（空 params 和空 URL） */
export const LINK_END = osc(OSC.HYPERLINK, '', '')

// iTerm2 OSC 9 子命令枚举

/** iTerm2 OSC 9 子命令编号 */
export const ITERM2 = {
  NOTIFY: 0,   // 发送通知
  BADGE: 2,    // 设置徽章文本
  PROGRESS: 4, // 进度上报
} as const

/** 进度操作码（与 ITERM2.PROGRESS 配合使用） */
export const PROGRESS = {
  CLEAR: 0,         // 清除进度条
  SET: 1,           // 设置进度值
  ERROR: 2,         // 错误状态
  INDETERMINATE: 3, // 不确定状态（无进度值）
} as const

/**
 * 清除 iTerm2 进度条的序列（OSC 9;4;0;BEL）。
 * 使用 BEL 终止符以确保在清理阶段始终能发送，不受终端类型影响。
 */
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`

/**
 * 清除终端标题的序列（OSC 0 + 空字符串 + BEL）。
 * 使用 BEL 终止符以确保清理时的兼容性。
 */
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`

/** 清除所有三个 OSC 21337 标签状态字段的序列，用于退出时清理 */
export const CLEAR_TAB_STATUS = osc(
  OSC.TAB_STATUS,
  'indicator=;status=;status-color=',
)

/**
 * 判断是否应发送 OSC 21337（标签状态指示器）序列。
 *
 * 目前仅限内部（ant）用户，因为该规范仍不稳定。
 * 不认识此序列的终端会静默丢弃，因此无条件发送是安全的。
 * 调用方必须用 wrapForMultiplexer() 包裹输出，
 * 以便 tmux/screen 通过 DCS 透传将序列传递到外层终端。
 *
 * @returns 若应发送标签状态序列则返回 true
 */
export function supportsTabStatus(): boolean {
  return process.env.USER_TYPE === 'ant'
}

/**
 * 生成 OSC 21337 标签状态序列。
 *
 * 省略的字段不会影响接收终端的当前值；
 * `null` 发送空值以清除该字段。
 * 状态文本中的 `;` 和 `\` 按规范进行转义。
 *
 * @param fields 要设置的标签状态字段（indicator、status、statusColor）
 * @returns OSC 21337 序列字符串
 */
export function tabStatus(fields: TabStatusAction): string {
  const parts: string[] = []
  // 将 Color 对象转为 #RRGGBB 十六进制字符串（非 rgb 类型返回空字符串）
  const rgb = (c: Color) =>
    c.type === 'rgb'
      ? `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('')}`
      : ''
  // 仅在字段存在于 fields 中时才追加（undefined = 未提及，不发送）
  if ('indicator' in fields)
    parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ''}`)
  if ('status' in fields)
    parts.push(
      // 转义状态文本中的 '\\' 和 ';'
      `status=${fields.status?.replaceAll('\\', '\\\\').replaceAll(';', '\\;') ?? ''}`,
    )
  if ('statusColor' in fields)
    parts.push(
      `status-color=${fields.statusColor ? rgb(fields.statusColor) : ''}`,
    )
  return osc(OSC.TAB_STATUS, parts.join(';'))
}
