/**
 * ClickEvent —— 终端鼠标点击事件类
 *
 * 【在 Claude Code 系统中的位置】
 * 属于 Ink 事件系统层，是终端鼠标交互的核心数据载体。
 * 当用户在启用鼠标追踪的终端（如 <AlternateScreen> 内）点击鼠标左键时，
 * dispatcher.ts 的 dispatchClick() 会创建此事件并沿 DOM 树进行捕获/冒泡分发，
 * 最终触发组件上注册的 onClick 处理器。
 *
 * 【主要功能】
 * 封装鼠标点击的位置信息（绝对屏幕坐标和相对容器坐标），
 * 以及点击目标单元格是否为空白的信息，供事件处理器做精细的响应判断。
 *
 * 【事件传播模型】
 * - 从命中的最深节点向上冒泡（bubbles）
 * - 调用 stopImmediatePropagation() 可阻止后续祖先节点的 onClick 触发
 * - localCol/localRow 在每个处理器被调用前由 dispatchClick 重新计算，
 *   确保每个容器组件看到的是相对于自身的坐标
 */
import { Event } from './event.js'

/**
 * 鼠标左键点击事件。
 *
 * 在左键释放（无拖拽）时触发，仅当鼠标追踪启用时有效（即 <AlternateScreen> 内部）。
 * 从最深命中节点向上通过 parentNode 进行冒泡分发。
 * 调用 stopImmediatePropagation() 可阻止祖先节点的 onClick 触发。
 */
export class ClickEvent extends Event {
  /** 点击位置的屏幕列号（0-indexed，相对于终端左边界） */
  readonly col: number
  /** 点击位置的屏幕行号（0-indexed，相对于终端顶部） */
  readonly row: number
  /**
   * 点击列相对于当前处理器所在 Box 的偏移（col - box.x）。
   * 在每个处理器被调用前由 dispatchClick 重新计算，
   * 确保容器组件看到的是相对于自身边界的坐标，而非子组件的坐标。
   */
  localCol = 0
  /** 点击行相对于当前处理器所在 Box 的偏移（row - box.y） */
  localRow = 0
  /**
   * 标识被点击的终端单元格是否为空白（屏幕缓冲区中两个压缩字（packed words）均为 0）。
   * 处理器可用此字段忽略文本右侧空白区域的点击，
   * 防止意外点击终端空白处触发状态切换。
   */
  readonly cellIsBlank: boolean

  /**
   * 创建一个点击事件实例。
   *
   * @param col          点击的屏幕列号（0-indexed）
   * @param row          点击的屏幕行号（0-indexed）
   * @param cellIsBlank  被点击的单元格是否为空白
   */
  constructor(col: number, row: number, cellIsBlank: boolean) {
    super()         // 调用 Event 基类构造函数
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
  }
}
