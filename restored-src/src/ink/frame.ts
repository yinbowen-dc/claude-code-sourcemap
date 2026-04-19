/**
 * @file frame.ts
 * @description 帧（Frame）数据结构与帧间差异分析模块。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件处于「渲染产物」层：
 *   React 组件树 → DOM → Yoga 布局 → renderNodeToOutput → Screen（屏幕缓冲区）→ Frame（本文件）
 *                                                                                      ↓
 *                                                                              log-update 差分渲染
 *
 * 主要职责：
 *  1. 定义 Frame 类型：封装一次渲染的全部输出（屏幕内容、视口大小、光标位置、滚动提示）。
 *  2. 定义 Patch / Diff 类型：描述两帧之间的最小终端操作序列（写字符、移光标、超链接等）。
 *  3. 定义 FrameEvent 类型：携带每帧耗时明细，供性能分析（onFrame 回调）使用。
 *  4. 提供 emptyFrame 工厂函数：在第一帧渲染之前生成空白占位帧。
 *  5. 提供 shouldClearScreen 函数：根据前后两帧判断是否需要全量清屏（resize / 溢出）。
 */

import type { Cursor } from './cursor.js'
import type { Size } from './layout/geometry.js'
import type { ScrollHint } from './render-node-to-output.js'
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './screen.js'

/** 一帧的完整渲染结果，由 createRenderer 生成后交给 log-update 进行差分输出 */
export type Frame = {
  /** 本帧的屏幕字符缓冲区，记录每个终端单元格的内容与样式 */
  readonly screen: Screen
  /** 当前终端视口的宽高（列数 × 行数），用于检测 resize 和溢出 */
  readonly viewport: Size
  /** 光标位置与可见性，由 renderNodeToOutput / useDeclaredCursor 决定 */
  readonly cursor: Cursor
  /** DECSTBM 滚动优化提示，仅在全屏（alt-screen）模式下非 null，
   *  告知 log-update 可用终端硬件滚动代替逐行重写，以降低闪烁 */
  readonly scrollHint?: ScrollHint | null
  /** 若为 true，表示某个 ScrollBox 还有未消费的 pendingScrollDelta，
   *  需要调度下一帧继续处理滚动动画 */
  readonly scrollDrainPending?: boolean
}

/**
 * 创建一个空白占位帧（0×0 屏幕），用于 Ink 实例初始化时尚无任何渲染结果的阶段。
 * log-update 在拿到真实第一帧之前以此作为 prevFrame，避免空指针。
 *
 * @param rows          终端行数（视口高度）
 * @param columns       终端列数（视口宽度）
 * @param stylePool     样式对象池，用于零分配样式复用
 * @param charPool      字符对象池
 * @param hyperlinkPool 超链接对象池
 */
export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    // 创建一个 0×0 的空屏幕缓冲区，不占任何终端空间
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    // 视口大小记录实际终端尺寸，后续帧可与之对比检测 resize
    viewport: { width: columns, height: rows },
    // 光标默认置于左上角且可见
    cursor: { x: 0, y: 0, visible: true },
  }
}

/**
 * 全量清屏的触发原因：
 *  - 'resize'   : 终端窗口大小发生变化
 *  - 'offscreen': 渲染内容高度超出当前视口行数（内容溢出）
 *  - 'clear'    : 外部主动要求清屏
 */
export type FlickerReason = 'resize' | 'offscreen' | 'clear'

/**
 * 每帧的性能事件，通过 ink 实例的 onFrame 回调暴露给调用方（如性能监控面板）。
 * phases 字段仅在启用帧计时仪表（frame-timing instrumentation）时填充。
 */
export type FrameEvent = {
  /** 本帧从开始到结束的总耗时（毫秒） */
  durationMs: number
  /** 各渲染子阶段的耗时明细（毫秒）及辅助计数器，启用仪表后才有值 */
  phases?: {
    /** createRenderer 输出阶段：DOM → Yoga 布局 → 屏幕缓冲区 */
    renderer: number
    /** LogUpdate.render() 阶段：屏幕缓冲区 diff → Patch[]（热路径） */
    diff: number
    /** optimize() 阶段：Patch 合并/去重 */
    optimize: number
    /** writeDiffToTerminal() 阶段：Patch 序列化为 ANSI → 写入 stdout */
    write: number
    /** 优化前的 Patch 总数，反映本帧变化量 */
    patches: number
    /** Yoga calculateLayout() 耗时（在 resetAfterCommit 中调用，早于 onRender） */
    yoga: number
    /** React 协调（reconcile）耗时：从 scrollMutated 到 resetAfterCommit；无 commit 时为 0 */
    commit: number
    /** 本帧 layoutNode() 调用次数（递归统计，含缓存命中返回） */
    yogaVisited: number
    /** measureFunc（文本换行/宽度）调用次数，是 Yoga 的主要开销来源 */
    yogaMeasured: number
    /** 通过 _hasL 单槽缓存的早期返回次数 */
    yogaCacheHits: number
    /** 当前存活的 Yoga Node 实例总数（创建数 − 释放数），持续增长表示内存泄漏 */
    yogaLive: number
  }
  /** 本帧发生的全量清屏事件列表，每条记录描述一次闪烁及其原因 */
  flickers: Array<{
    /** 渲染内容期望占用的终端行数 */
    desiredHeight: number
    /** 当前终端实际可用行数 */
    availableHeight: number
    /** 触发清屏的原因 */
    reason: FlickerReason
  }>
}

/**
 * 终端差分操作单元（Patch）。
 * Diff = Patch[]，是 log-update 将两帧差异转化为最小终端操作序列的产物。
 * writeDiffToTerminal 将 Patch[] 序列化为 ANSI 转义序列后写入 stdout。
 *
 * 各变体说明：
 *  - stdout       : 直接输出文本内容
 *  - clear        : 清除 count 行（向上删除）
 *  - clearTerminal: 全量清屏（resize / offscreen / clear 触发），附带调试信息
 *  - cursorHide   : 隐藏光标（渲染期间防止光标闪烁）
 *  - cursorShow   : 显示光标
 *  - cursorMove   : 将光标移动到绝对坐标 (x, y)
 *  - cursorTo     : 将光标移动到当前行的 col 列
 *  - carriageReturn: 发送回车（\r），将光标移至行首
 *  - hyperlink    : 发送 OSC 8 超链接转义，设置后续文本的链接 URI
 *  - styleStr     : 预序列化的样式过渡字符串（来自 StylePool.transition()），零分配
 */
export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      type: 'clearTerminal'
      reason: FlickerReason
      // log-update 触发滚动回溯 diff 时填充此调试信息。
      // ink.tsx 使用 triggerY 配合 findOwnerChainAtRow 将闪烁归因到具体的 React 组件。
      debug?: { triggerY: number; prevLine: string; nextLine: string }
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  // 来自 StylePool.transition() 的预序列化样式过渡字符串——
  // 按 (fromId, toId) 缓存，热身后零分配
  | { type: 'styleStr'; str: string }

/** 两帧之间的差异操作序列，由 log-update 的 diff 阶段生成 */
export type Diff = Patch[]

/**
 * 判断是否需要全量清屏，以及清屏的原因。
 *
 * 流程：
 *  1. 比较视口尺寸：若宽或高发生变化，返回 'resize'（终端窗口被拖动缩放）。
 *  2. 检查溢出：若当前帧或前一帧的屏幕高度 ≥ 视口行数，返回 'offscreen'。
 *     溢出时终端光标会进入滚动回溯区，必须全量清屏后才能正确重建画面。
 *  3. 两种情况均不满足时返回 undefined，log-update 执行普通增量差分。
 *
 * @param prevFrame 前一帧的渲染结果
 * @param frame     当前帧的渲染结果
 * @returns 清屏原因，或 undefined（无需清屏）
 */
export function shouldClearScreen(
  prevFrame: Frame,
  frame: Frame,
): FlickerReason | undefined {
  // 检测视口尺寸变化（终端 resize 事件）
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width
  if (didResize) {
    // 终端大小已改变，必须清屏重绘，否则旧内容位置错乱
    return 'resize'
  }

  // 当前帧的屏幕高度是否超出视口（内容会溢入终端滚动缓冲区）
  const currentFrameOverflows = frame.screen.height >= frame.viewport.height
  // 前一帧的屏幕高度是否超出视口（若超出，光标恢复时已在滚动缓冲区中）
  const previousFrameOverflowed =
    prevFrame.screen.height >= prevFrame.viewport.height
  if (currentFrameOverflows || previousFrameOverflowed) {
    // 任意一帧溢出都需要清屏，以确保光标和内容位置一致
    return 'offscreen'
  }

  // 无需清屏，log-update 走增量 diff 路径
  return undefined
}
