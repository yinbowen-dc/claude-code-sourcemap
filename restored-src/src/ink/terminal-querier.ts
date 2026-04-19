/**
 * 文件：terminal-querier.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 Ink 渲染层的终端能力探测系统中。
 * Claude Code 启动时需要异步检测终端支持的功能（同步输出、键盘协议、光标位置等），
 * 而这些查询的响应通过 stdin 流返回，与普通键盘输入共用同一条流。
 * `TerminalQuerier` 提供了一套无超时的查询-响应机制，
 * 利用 DA1 响应的全终端普适性作为"哨兵"来隐式终止未答复的查询。
 *
 * 【主要功能】
 * - `TerminalQuerier` 类：维护一个有序队列，匹配 stdin 回复与发出的查询
 * - `send<T>(query)`: 发送查询并等待匹配响应，DA1 哨兵到达则以 undefined 超时
 * - `flush()`: 发送 DA1 哨兵，将所有未响应查询以 undefined resolve，并等待 DA1 回复
 * - 查询构建器：`decrqm`、`da1`、`da2`、`kittyKeyboard`、`cursorPosition`、`oscColor`、`xtversion`
 *
 * 【DA1 哨兵机制】
 * - 所有终端（自 VT100 起）均响应 DA1（CSI c）
 * - 终端按序回复查询，因此若你的查询响应先于 DA1 到达，说明终端支持该功能；
 *   反之 DA1 先到达，则说明终端忽略了该查询（不支持）
 * - 这样可以实现无超时的能力探测
 */

import type { TerminalResponse } from './parse-keypress.js'
import { csi } from './termio/csi.js'
import { osc } from './termio/osc.js'

/** 终端查询描述符：一对出站请求序列 + 入站响应匹配器。
 *  由 `decrqm()`、`oscColor()`、`kittyKeyboard()` 等构建函数生成。 */
export type TerminalQuery<T extends TerminalResponse = TerminalResponse> = {
  /** 写入 stdout 的转义序列（查询请求） */
  request: string
  /** 在 stdin 流中识别期望响应的匹配函数 */
  match: (r: TerminalResponse) => r is T
}

// 各种终端响应类型的精确提取（方便泛型约束）
type DecrpmResponse = Extract<TerminalResponse, { type: 'decrpm' }>
type Da1Response = Extract<TerminalResponse, { type: 'da1' }>
type Da2Response = Extract<TerminalResponse, { type: 'da2' }>
type KittyResponse = Extract<TerminalResponse, { type: 'kittyKeyboard' }>
type CursorPosResponse = Extract<TerminalResponse, { type: 'cursorPosition' }>
type OscResponse = Extract<TerminalResponse, { type: 'osc' }>
type XtversionResponse = Extract<TerminalResponse, { type: 'xtversion' }>

// -- 查询构建器 --

/**
 * DECRQM：请求 DEC 私有模式状态（CSI ? mode $ p）。
 * 终端以 DECRPM（CSI ? mode ; status $ y）响应，或忽略。
 *
 * @param mode DEC 私有模式编号（例如 2026 = 同步输出）
 */
export function decrqm(mode: number): TerminalQuery<DecrpmResponse> {
  return {
    request: csi(`?${mode}$p`),
    match: (r): r is DecrpmResponse => r.type === 'decrpm' && r.mode === mode,
  }
}

/**
 * 主设备属性查询（CSI c）。每个终端都会响应此查询 ——
 * 内部由 flush() 用作通用哨兵。若需要 DA1 参数，也可直接调用。
 */
export function da1(): TerminalQuery<Da1Response> {
  return {
    request: csi('c'),
    match: (r): r is Da1Response => r.type === 'da1',
  }
}

/**
 * 次设备属性查询（CSI > c）。返回终端名称/版本号。
 */
export function da2(): TerminalQuery<Da2Response> {
  return {
    request: csi('>c'),
    match: (r): r is Da2Response => r.type === 'da2',
  }
}

/**
 * 查询当前 Kitty 键盘协议标志（CSI ? u）。
 * 终端以 CSI ? flags u 响应，或忽略。
 */
export function kittyKeyboard(): TerminalQuery<KittyResponse> {
  return {
    request: csi('?u'),
    match: (r): r is KittyResponse => r.type === 'kittyKeyboard',
  }
}

/**
 * DECXCPR：使用 DEC 私有标记请求光标位置（CSI ? 6 n）。
 * 终端以 CSI ? row ; col R 响应。`?` 标记至关重要 ——
 * 普通 DSR 形式（CSI 6 n → CSI row;col R）与修改键 F3 的序列歧义，
 * 加 `?` 可与 Shift+F3 等区分开。
 */
export function cursorPosition(): TerminalQuery<CursorPosResponse> {
  return {
    request: csi('?6n'),
    match: (r): r is CursorPosResponse => r.type === 'cursorPosition',
  }
}

/**
 * OSC 动态颜色查询（例如 OSC 11 查背景色，OSC 10 查前景色）。
 * `?` 数据槽要求终端返回当前值。
 *
 * @param code OSC 命令编号（10=前景色, 11=背景色, 12=光标色）
 */
export function oscColor(code: number): TerminalQuery<OscResponse> {
  return {
    request: osc(code, '?'),
    match: (r): r is OscResponse => r.type === 'osc' && r.code === code,
  }
}

/**
 * XTVERSION：请求终端名称/版本（CSI > 0 q）。
 * 终端以 DCS > | name ST 响应（例如 "xterm.js(5.5.0)"），或忽略。
 * 此查询经由 pty 传递，能穿越 SSH —— 即使 TERM_PROGRAM 未转发，
 * 也能识别客户端终端。用于检测 xterm.js 以补偿滚轮行为。
 */
export function xtversion(): TerminalQuery<XtversionResponse> {
  return {
    request: csi('>0q'),
    match: (r): r is XtversionResponse => r.type === 'xtversion',
  }
}

// -- 查询器主体 --

/** 哨兵请求序列（DA1），仅由 flush() 内部写入，不对外暴露 */
const SENTINEL = csi('c')

// 队列中的挂起项：普通查询（带匹配器和 resolve）或 DA1 哨兵（仅 resolve）
type Pending =
  | {
      kind: 'query'
      match: (r: TerminalResponse) => boolean
      resolve: (r: TerminalResponse | undefined) => void
    }
  | { kind: 'sentinel'; resolve: () => void }

export class TerminalQuerier {
  /**
   * 按发送顺序交错排列的查询和哨兵队列。
   * 终端按序回复，因此每个 flush() 屏障只清空它之前的未答复查询 ——
   * 来自不同调用方的并发批次因此相互隔离。
   */
  private queue: Pending[] = []

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 发送查询并等待其响应。
   *
   * 【流程】
   * - 将查询入队，同时向 stdout 写出查询序列
   * - 当 `query.match` 在 stdin 中匹配到对应 TerminalResponse 时，以该响应 resolve
   * - 若 flush() 的 DA1 哨兵先于匹配响应到达，则以 `undefined` resolve
   *   （表示终端不支持该查询）
   * - 不会 reject；无超时；若从不调用 flush() 且终端不回复，Promise 将永远挂起
   *
   * @param query 由查询构建器创建的 TerminalQuery 对象
   * @returns Promise<T | undefined>，T 为匹配到的响应类型
   */
  send<T extends TerminalResponse>(
    query: TerminalQuery<T>,
  ): Promise<T | undefined> {
    return new Promise(resolve => {
      this.queue.push({
        kind: 'query',
        match: query.match,
        resolve: r => resolve(r as T | undefined),
      })
      this.stdout.write(query.request)
    })
  }

  /**
   * 发送 DA1 哨兵，并等待其响应到达。
   *
   * 【副作用】
   * - DA1 响应到达时，所有在哨兵之前仍处于挂起状态的查询均以 `undefined` resolve
   *   （终端未响应这些查询 → 不支持）
   * - 这是使 send() 无超时的核心屏障机制
   *
   * 即使队列为空，调用此方法仍会等待一次 DA1 往返，可用于探测终端响应能力。
   */
  flush(): Promise<void> {
    return new Promise(resolve => {
      this.queue.push({ kind: 'sentinel', resolve })
      this.stdout.write(SENTINEL)
    })
  }

  /**
   * 将 stdin 中解析到的终端响应分发给对应的挂起查询或哨兵。
   * 由 App.tsx 的 processKeysInBatch 对每个 `kind: 'response'` 项调用。
   *
   * 【匹配策略】
   * 1. 优先查找队列中第一个匹配的挂起查询（FIFO，取第一个 match 成功的项）
   *    这允许调用方显式 send(da1()) 来获取 DA1 参数 ——
   *    写入两次 DA1 时，终端会回复两次：第一次匹配显式查询，第二次触发哨兵
   * 2. 否则，若此响应是 DA1，触发第一个挂起的哨兵：
   *    将哨兵之前所有未匹配的查询以 undefined resolve（终端忽略了它们），
   *    并完成对应 flush() 的 Promise
   *    只清到第一个哨兵，保持后续批次完整
   * 3. 未请求的响应（无匹配查询，也无哨兵）静默丢弃
   *
   * @param r 从 stdin 解析出的终端响应
   */
  onResponse(r: TerminalResponse): void {
    // 在队列中寻找第一个能匹配此响应的查询项
    const idx = this.queue.findIndex(p => p.kind === 'query' && p.match(r))
    if (idx !== -1) {
      // 找到匹配的查询：从队列取出并 resolve
      const [q] = this.queue.splice(idx, 1)
      if (q?.kind === 'query') q.resolve(r)
      return
    }

    if (r.type === 'da1') {
      // DA1 响应到达：寻找队列中第一个哨兵
      const s = this.queue.findIndex(p => p.kind === 'sentinel')
      if (s === -1) return
      // 将哨兵之前所有未答复的查询以 undefined resolve，并 resolve 哨兵本身
      for (const p of this.queue.splice(0, s + 1)) {
        if (p.kind === 'query') p.resolve(undefined)
        else p.resolve()
      }
    }
  }
}
