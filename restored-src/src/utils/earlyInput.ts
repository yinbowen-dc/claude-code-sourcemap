/**
 * 早期输入捕获模块（earlyInput.ts）
 *
 * 【在系统流程中的位置】
 * 该模块在 cli.tsx 启动序列的最早期被调用，早于 Ink REPL 初始化。
 * 解决的问题：用户执行 `claude` 后立即开始输入，这些按键在 REPL 就绪前会丢失。
 * 通过在 REPL 初始化前开启 stdin raw mode 捕获输入，REPL 就绪后将缓冲内容注入。
 *
 * 【主要功能】
 * - startCapturingEarlyInput()：在启动序列早期开始捕获 stdin 字符
 * - stopCapturingEarlyInput()：停止捕获并移除 readable 事件监听器
 * - consumeEarlyInput()：获取并清空缓冲内容（自动停止捕获）
 * - hasEarlyInput()：非消费式检查是否有缓冲内容
 * - seedEarlyInput()：预填充缓冲内容（用于测试或编程注入）
 * - isCapturingEarlyInput()：查询当前是否处于捕获状态
 */

import { lastGrapheme } from './intl.js'

// 早期输入字符缓冲区（模块级变量，在 start/stop/consume 之间保持状态）
let earlyInputBuffer = ''
// 当前是否正在捕获标志
let isCapturing = false
// readable 事件处理器引用，用于后续移除监听器
let readableHandler: (() => void) | null = null

/**
 * 在 REPL 初始化之前尽早开始捕获 stdin 字符。
 *
 * 【流程说明】
 * 1. 只在交互式终端（stdin 为 TTY）且非 print 模式下捕获
 *    （raw mode 会禁用 ISIG，使 -p 模式无法被 Ctrl+C 中断）
 * 2. 设置 stdin encoding 为 utf8，开启 raw mode，调用 ref() 防止进程提前退出
 * 3. 注册 readable 事件监听器，循环读取 stdin 数据块并调用 processChunk()
 * 4. 若 setRawMode 不可用（如 CI 环境），静默跳过捕获
 */
export function startCapturingEarlyInput(): void {
  // 仅在交互式 TTY 下捕获；-p/--print 模式下 raw mode 会阻止 Ctrl+C 终止进程
  if (
    !process.stdin.isTTY ||
    isCapturing ||
    process.argv.includes('-p') ||
    process.argv.includes('--print')
  ) {
    return
  }

  isCapturing = true
  earlyInputBuffer = ''

  // 设置 stdin 为 raw mode，使用与 Ink 相同的 'readable' 事件模式，确保兼容性
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    // ref() 防止 Node.js 事件循环因没有其他任务而提前退出
    process.stdin.ref()

    // readable 事件处理器：循环读取所有可用数据块
    readableHandler = () => {
      let chunk = process.stdin.read()
      while (chunk !== null) {
        if (typeof chunk === 'string') {
          processChunk(chunk)
        }
        chunk = process.stdin.read()
      }
    }

    // 注册 readable 事件，stdin 有数据时触发
    process.stdin.on('readable', readableHandler)
  } catch {
    // setRawMode 失败（如非 TTY 环境），静默跳过，不影响启动流程
    isCapturing = false
  }
}

/**
 * 处理一个 stdin 数据块，将有效字符追加到缓冲区。
 *
 * 【流程说明】
 * - Ctrl+C（code 3）：停止捕获并以退出码 130 退出（此时关机机制尚未初始化）
 * - Ctrl+D（code 4）：EOF，停止捕获
 * - Backspace（code 127/8）：使用 lastGrapheme() 删除最后一个字素簇（支持多字节字符）
 * - ESC 序列（0x1B 开头）：跳过整个转义序列（箭头键、功能键、焦点事件等），
 *   结束字节范围为 0x40–0x7E
 * - 其他控制字符（< 32，除 Tab/LF/CR）：跳过
 * - CR（code 13）：转换为 LF 追加
 * - 可打印字符：直接追加到缓冲区
 */
function processChunk(str: string): void {
  let i = 0
  while (i < str.length) {
    const char = str[i]!
    const code = char.charCodeAt(0)

    // Ctrl+C（code 3）：停止捕获并退出（启动早期关机机制尚未就绪）
    if (code === 3) {
      stopCapturingEarlyInput()
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(130) // Ctrl+C 的标准退出码
      return
    }

    // Ctrl+D（code 4）：EOF，停止捕获
    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }

    // Backspace（code 127 或 8）：删除最后一个字素簇（支持 Emoji 等多码点字符）
    if (code === 127 || code === 8) {
      if (earlyInputBuffer.length > 0) {
        const last = lastGrapheme(earlyInputBuffer)
        // 删除最后一个字素簇的所有字节（至少 1 个）
        earlyInputBuffer = earlyInputBuffer.slice(0, -(last.length || 1))
      }
      i++
      continue
    }

    // ESC 序列（0x1B 开头）：跳过整个序列（箭头键、功能键、焦点事件等）
    // 结束条件：遇到 0x40–0x7E 范围内的终止字节（@ 到 ~）
    if (code === 27) {
      i++ // 跳过 ESC 字符本身
      // 跳过序列中间字节，直到遇到终止字节或字符串结束
      while (
        i < str.length &&
        !(str.charCodeAt(i) >= 64 && str.charCodeAt(i) <= 126)
      ) {
        i++
      }
      if (i < str.length) i++ // 跳过终止字节
      continue
    }

    // 跳过其他控制字符（code < 32），保留 Tab(9)、LF(10)、CR(13)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      i++
      continue
    }

    // 将回车符（CR，code 13）转换为换行符（LF）
    if (code === 13) {
      earlyInputBuffer += '\n'
      i++
      continue
    }

    // 可打印字符及允许的控制字符（Tab、LF）追加到缓冲区
    earlyInputBuffer += char
    i++
  }
}

/**
 * 停止捕获早期输入，移除 readable 事件监听器。
 *
 * 【流程说明】
 * 1. 已停止捕获时直接返回（幂等）
 * 2. 移除 readable 事件监听器，清空处理器引用
 * 3. 不重置 stdin 状态（raw mode）：由 Ink REPL 自行管理，
 *    避免与 REPL 同期初始化时发生竞争条件
 */
export function stopCapturingEarlyInput(): void {
  // 幂等：已停止时直接返回
  if (!isCapturing) {
    return
  }

  isCapturing = false

  // 移除 readable 事件监听器，清空处理器引用
  if (readableHandler) {
    process.stdin.removeListener('readable', readableHandler)
    readableHandler = null
  }

  // 不调用 setRawMode(false)：REPL 的 Ink 实例会管理 stdin 状态，
  // 在此重置可能与 REPL 自身初始化产生竞争条件
}

/**
 * 消费（读取并清空）缓冲的早期输入内容。
 *
 * 【流程说明】
 * 1. 自动调用 stopCapturingEarlyInput() 停止继续捕获
 * 2. trim() 去除首尾空白后返回缓冲内容
 * 3. 清空缓冲区，防止重复消费
 *
 * @returns  trim 后的缓冲文本（REPL 就绪后将其注入到输入框）
 */
export function consumeEarlyInput(): string {
  // 消费时自动停止捕获
  stopCapturingEarlyInput()
  const input = earlyInputBuffer.trim()
  // 清空缓冲区，防止重复消费
  earlyInputBuffer = ''
  return input
}

/**
 * 非消费式检查是否有缓冲的早期输入内容。
 *
 * @returns  缓冲区经 trim 后有内容时返回 true
 */
export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

/**
 * 预填充早期输入缓冲区，使 REPL 渲染时输入框显示预设文本。
 *
 * 【使用场景】
 * 用于测试或编程式注入（如通过命令行参数预填充初始提示词）。
 * 不会自动提交，用户仍可编辑后回车发送。
 *
 * @param text  要预填充到缓冲区的文本
 */
export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

/**
 * 检查早期输入捕获是否当前处于活动状态。
 *
 * @returns  正在捕获时返回 true
 */
export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
