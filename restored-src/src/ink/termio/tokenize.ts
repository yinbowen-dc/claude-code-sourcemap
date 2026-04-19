/**
 * 文件：termio/tokenize.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的词法分析层（Tokenizer），位于 ANSI 解析流水线的最底层。
 * 它接收原始终端输出字节流，识别转义序列边界，将字节流分割为文本块（text Token）
 * 和原始转义序列（sequence Token），供 parser.ts 进行语义解析。
 *
 * 【主要功能】
 * - `Token` 类型：{ type: 'text'|'sequence', value: string }
 * - `Tokenizer` 接口：{ feed, flush, reset, buffer }
 * - `createTokenizer(options?)`：创建有状态的流式 Tokenizer 实例
 *   - `options.x10Mouse`：是否启用 X10 鼠标报告格式处理（仅 stdin 使用）
 * - 内部状态机状态：
 *   ground → escape → escapeIntermediate / csi / ss3 / osc / dcs / apc
 * - `tokenize(input, state, buffer, flush, x10Mouse)`：核心纯函数，实现完整状态机
 *
 * 【关键设计】
 * - 流式（Streaming）：跨调用保持状态，可处理跨块的不完整序列
 * - 纯函数核心：tokenize() 无副作用，所有状态通过参数传入/返回值传出
 * - X10 鼠标特殊处理：CSI M + 3 原始字节，需与 CSI DL 区分（见注释）
 */

import { C0, ESC_TYPE, isEscFinal } from './ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from './csi.js'

/** Token 类型：文本块或原始转义序列 */
export type Token =
  | { type: 'text'; value: string }
  | { type: 'sequence'; value: string }

/**
 * 状态机状态枚举。
 *
 * - ground：正常文本模式，等待 ESC 开始序列
 * - escape：已接收 ESC，等待第二字节确定序列类型
 * - escapeIntermediate：ESC 后接中间字节（如 ESC (）
 * - csi：CSI（ESC [）序列内部，等待终止字节
 * - ss3：SS3（ESC O）序列，等待单个最终字节
 * - osc：OSC（ESC ]）序列内部，等待 BEL 或 ESC \ 终止
 * - dcs：DCS（ESC P）设备控制字符串，等待 BEL/ESC \ 终止
 * - apc：APC（ESC _）应用命令，等待 BEL/ESC \ 终止
 */
type State =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'

/**
 * 对外公开的 Tokenizer 接口。
 *
 * 实例跨调用保持内部状态（状态机状态和未完成序列缓冲区），
 * 实现对不完整序列的跨调用拼接。
 */
export type Tokenizer = {
  /** 送入输入字符串，返回完整的 Token 列表 */
  feed(input: string): Token[]
  /** 将缓冲区中不完整的序列强制作为 sequence Token 输出并重置 */
  flush(): Token[]
  /** 重置 Tokenizer 状态（清空缓冲区，回到 ground 状态） */
  reset(): void
  /** 返回当前缓冲区内容（尚未完成的序列片段） */
  buffer(): string
}

/**
 * Tokenizer 创建选项。
 */
type TokenizerOptions = {
  /**
   * 是否将 `CSI M` 识别为 X10 鼠标事件前缀并消费 3 字节的原始载荷。
   * 仅在处理 stdin 时启用 —— `\x1b[M` 在输出流中也是 CSI DL（Delete Lines），
   * 盲目消费 3 字节会破坏显示内容。默认为 false。
   */
  x10Mouse?: boolean
}

/**
 * 创建流式终端输入 Tokenizer 实例。
 *
 * 【流程】
 * - 实例内部持有 currentState 和 currentBuffer（不完整序列缓冲区）
 * - feed()：将 input 附加到 currentBuffer 后传入 tokenize() 纯函数
 *   将返回的新状态更新到实例，返回已完成的 Token 列表
 * - flush()：调用 tokenize() 并传入 flush=true，强制输出所有缓冲内容
 * - reset()：直接重置状态和缓冲区
 * - buffer()：读取当前缓冲区内容（只读）
 *
 * 【使用示例】
 * ```typescript
 * const tokenizer = createTokenizer()
 * const tokens1 = tokenizer.feed('hello\x1b[')  // 返回 text "hello"，ESC[ 留在缓冲区
 * const tokens2 = tokenizer.feed('A')            // 返回 sequence "\x1b[A"（CUU）
 * const remaining = tokenizer.flush()            // 强制输出任何剩余的不完整序列
 * ```
 *
 * @param options 可选的 Tokenizer 配置项
 * @returns Tokenizer 实例
 */
export function createTokenizer(options?: TokenizerOptions): Tokenizer {
  let currentState: State = 'ground'
  let currentBuffer = ''
  const x10Mouse = options?.x10Mouse ?? false  // X10 鼠标模式标志，默认禁用

  return {
    feed(input: string): Token[] {
      const result = tokenize(
        input,
        currentState,
        currentBuffer,
        false,       // flush=false：不强制输出不完整序列
        x10Mouse,
      )
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    flush(): Token[] {
      // flush=true：强制将缓冲区中任何不完整序列作为 sequence Token 输出
      const result = tokenize('', currentState, currentBuffer, true, x10Mouse)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    reset(): void {
      currentState = 'ground'
      currentBuffer = ''
    },

    buffer(): string {
      return currentBuffer
    },
  }
}

/**
 * 内部状态类型，用于在 tokenize() 函数调用间传递/返回状态。
 */
type InternalState = {
  state: State
  buffer: string
}

/**
 * 核心状态机函数：将输入字节流分割为文本和序列 Token。
 *
 * 【设计原则】
 * 这是一个纯函数，所有状态通过参数传入、通过返回值传出。
 * 实际处理时将 initialBuffer（上次调用残留）和 input 拼接为 data，
 * 然后逐字节扫描，按当前状态执行状态转换和 Token 输出。
 *
 * 【状态转换摘要】
 * - ground：ESC → 记录 seqStart，切换到 escape；其他字节 → 积累文本
 * - escape：
 *   - 0x5b([) → csi，0x5d(]) → osc，0x50(P) → dcs，0x5f(_) → apc
 *   - 0x4f(O) → ss3（单字节最终字节序列）
 *   - isCSIIntermediate → escapeIntermediate（中间字节，如字符集切换）
 *   - isEscFinal → 两字节 ESC 序列完成，emit
 *   - ESC → 双重 ESC：先 emit 第一个，再从当前位置开始新序列
 *   - 其他 → 无效序列，ESC 回退为文本
 * - escapeIntermediate：继续中间字节或遇终止字节 emit
 * - csi：特殊处理 X10 鼠标（见注释）；isCSIFinal → emit；isCSIParam/Intermediate → 继续；其他 → 中止
 * - ss3：0x40–0x7e → emit；其他 → 回退为文本
 * - osc/dcs/apc：BEL 或 ESC \ 终止 → emit；其他 → 继续积累
 *
 * 【输入结束处理】
 * - ground：flush 剩余文本
 * - flush=true：将所有缓冲内容强制作为 sequence Token 输出
 * - flush=false：将缓冲内容存入 result.buffer，下次调用继续
 *
 * @param input 本次调用的新输入字符串
 * @param initialState 上次调用结束时的状态
 * @param initialBuffer 上次调用结束时的缓冲区（不完整序列）
 * @param flush 是否强制输出所有缓冲内容
 * @param x10Mouse 是否启用 X10 鼠标特殊处理
 * @returns { tokens: 完成的 Token 列表, state: 新的内部状态 }
 */
function tokenize(
  input: string,
  initialState: State,
  initialBuffer: string,
  flush: boolean,
  x10Mouse: boolean,
): { tokens: Token[]; state: InternalState } {
  const tokens: Token[] = []
  const result: InternalState = {
    state: initialState,
    buffer: '',
  }

  // 将上次剩余的缓冲区与本次输入拼接，统一处理
  const data = initialBuffer + input
  let i = 0
  let textStart = 0   // 当前文本块的起始位置
  let seqStart = 0    // 当前序列的起始位置（ESC 的位置）

  /**
   * 将 [textStart, i) 范围内的文本作为 text Token 输出。
   * 输出后将 textStart 更新为 i（即清空已处理文本）。
   */
  const flushText = (): void => {
    if (i > textStart) {
      const text = data.slice(textStart, i)
      if (text) {
        tokens.push({ type: 'text', value: text })
      }
    }
    textStart = i
  }

  /**
   * 将给定序列字符串作为 sequence Token 输出，并重置状态到 ground。
   * 同时更新 textStart = i，使之后的文本从当前位置开始积累。
   *
   * @param seq 完整的转义序列字符串
   */
  const emitSequence = (seq: string): void => {
    if (seq) {
      tokens.push({ type: 'sequence', value: seq })
    }
    result.state = 'ground'
    textStart = i
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)

    switch (result.state) {
      case 'ground':
        if (code === C0.ESC) {
          // 遇到 ESC：先输出之前积累的文本，然后开始新序列
          flushText()
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          // 普通文本字节：继续积累
          i++
        }
        break

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          // ESC [ → CSI 序列（控制序列引入符）
          result.state = 'csi'
          i++
        } else if (code === ESC_TYPE.OSC) {
          // ESC ] → OSC 序列（操作系统命令）
          result.state = 'osc'
          i++
        } else if (code === ESC_TYPE.DCS) {
          // ESC P → DCS 序列（设备控制字符串）
          result.state = 'dcs'
          i++
        } else if (code === ESC_TYPE.APC) {
          // ESC _ → APC 序列（应用程序命令）
          result.state = 'apc'
          i++
        } else if (code === 0x4f) {
          // ESC O → SS3（Single Shift 3，应用模式光标键）
          result.state = 'ss3'
          i++
        } else if (isCSIIntermediate(code)) {
          // ESC 后跟中间字节（如 ESC ( 字符集切换序列）→ escapeIntermediate
          result.state = 'escapeIntermediate'
          i++
        } else if (isEscFinal(code)) {
          // 两字节 ESC 序列（ESC + 终止字节）：完整序列，立即 emit
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (code === C0.ESC) {
          // 双重 ESC：先 emit 第一个 ESC，再从当前位置开始新序列
          emitSequence(data.slice(seqStart, i))
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          // 无效字节：将 ESC 回退为普通文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'escapeIntermediate':
        // 中间字节之后：继续等待更多中间字节或最终字节
        if (isCSIIntermediate(code)) {
          // 继续积累中间字节
          i++
        } else if (isEscFinal(code)) {
          // 遇到终止字节：序列完成，emit
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效字节：整个序列（含中间字节）回退为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'csi':
        // X10 鼠标事件处理：CSI M + 3 原始字节（Cb+32, Cx+32, Cy+32）
        //
        // 背景：X10 鼠标报告格式在 ESC [ M 之后跟随 3 个原始字节，
        // 分别编码按钮（Cb+32）和坐标（Cx+32, Cy+32）。
        // 若不特殊处理，这 3 个字节会作为普通文本流出，产生乱码。
        //
        // 条件：
        // 1. x10Mouse=true（仅 stdin 使用，防止在输出解析中误触）
        // 2. 当前字节为 'M'（0x4d）且位于 ESC [ 之后（offset=2）
        // 3. 三个载荷字节的值均 ≥ 0x20（控制字节意味着这是 CSI DL，不是鼠标事件）
        //
        // 已知限制：
        // - 在 162–191 列 × 96–159 行区域，坐标字节形成有效 UTF-8 二字节序列，
        //   JavaScript 字符串长度检测失效，需要 latin1 stdin 才能正确处理。
        //   X10 的 223 列上限正是 SGR 鼠标模式（DEC 1006）的设计动机。
        if (
          x10Mouse &&
          code === 0x4d /* M */ &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            // 3 个载荷字节均已接收：消费全部 4 字节（M + 3）并 emit
            i += 4
            emitSequence(data.slice(seqStart, i))
          } else {
            // 数据不足：退出循环，等待更多输入；序列从 seqStart 重新缓冲
            i = data.length
          }
          break
        }
        if (isCSIFinal(code)) {
          // CSI 终止字节（0x40–0x7e）：序列完成，emit
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          // 参数字节（0x30–0x3f）或中间字节（0x20–0x2f）：继续积累
          i++
        } else {
          // 无效字节：中止 CSI 序列，将整个序列回退为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'ss3':
        // SS3 序列：ESC O 后跟单个最终字节（0x40–0x7e）
        if (code >= 0x40 && code <= 0x7e) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效字节：回退为文本
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'osc':
        // OSC 序列：等待 BEL（0x07）或 ESC \（ST）终止符
        if (code === C0.BEL) {
          // BEL 终止符（旧式，兼容性好）
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          // ESC \ 终止符（String Terminator，标准格式）
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          // 继续积累 OSC 内容字节
          i++
        }
        break

      case 'dcs':
      case 'apc':
        // DCS 和 APC 序列均以 BEL 或 ESC \ 终止
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break
    }
  }

  // ── 输入结束处理 ──
  if (result.state === 'ground') {
    // ground 状态：将剩余文本作为 text Token 输出
    flushText()
  } else if (flush) {
    // flush 模式：将缓冲中不完整的序列强制作为 sequence Token 输出
    const remaining = data.slice(seqStart)
    if (remaining) tokens.push({ type: 'sequence', value: remaining })
    result.state = 'ground'
  } else {
    // 非 flush 模式：将不完整序列保存到缓冲区，等待下次调用续传
    result.buffer = data.slice(seqStart)
  }

  return { tokens, state: result }
}
