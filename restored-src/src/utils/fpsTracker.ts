/**
 * 帧率追踪模块（FPS Tracker）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于终端 UI 性能监控层，配合 Ink 渲染循环工作，
 * 记录每帧渲染耗时，在会话结束时上报性能指标用于遥测分析。
 * 典型调用方：Ink App 的 onRender 回调，以及性能上报的数据采集入口。
 *
 * 【主要功能】
 * - FpsMetrics 类型：定义平均帧率（averageFps）与低帧率（low1PctFps）指标
 * - FpsTracker 类：记录每帧耗时，计算平均帧率与 1% 低帧率
 * - 1% 低帧率（low1PctFps）：取耗时最长的 1% 帧对应的帧率，
 *   是游戏行业衡量卡顿程度的标准指标，能识别偶发性同步阻塞
 * - 上报数据用于检测导致终端 UI 卡顿的慢操作或同步阻塞
 */

/**
 * 帧率指标数据类型。
 *
 * - averageFps：会话期间的平均帧率（总帧数 / 总时长）
 * - low1PctFps：最慢 1% 帧对应的帧率（衡量卡顿程度的关键指标）
 */
export type FpsMetrics = {
  averageFps: number  // 平均帧率（FPS）
  low1PctFps: number  // 1% 低帧率（最慢 1% 帧对应的 FPS，越高代表越流畅）
}

/**
 * FPS 追踪器，记录帧耗时并计算帧率指标。
 *
 * 【使用方式】
 * 在 Ink 渲染循环的每帧回调中调用 record(durationMs)，
 * 会话结束时调用 getMetrics() 获取汇总指标。
 */
export class FpsTracker {
  // 存储每帧的渲染耗时（毫秒），用于计算帧率分布
  private frameDurations: number[] = []
  // 第一帧渲染开始时间（performance.now()，毫秒），用于计算总时长
  private firstRenderTime: number | undefined
  // 最后一帧渲染结束时间（performance.now()，毫秒），用于计算总时长
  private lastRenderTime: number | undefined

  /**
   * 记录一帧的渲染耗时。
   *
   * 【流程】
   * 1. 获取当前高精度时间戳（performance.now()）；
   * 2. 若是第一帧，记录 firstRenderTime；
   * 3. 更新 lastRenderTime；
   * 4. 将 durationMs 追加到 frameDurations 数组。
   *
   * @param durationMs - 本帧渲染耗时（毫秒）
   */
  record(durationMs: number): void {
    const now = performance.now() // 获取高精度单调时钟时间
    if (this.firstRenderTime === undefined) {
      this.firstRenderTime = now // 记录首帧时间戳
    }
    this.lastRenderTime = now // 更新末帧时间戳
    this.frameDurations.push(durationMs) // 追加本帧耗时
  }

  /**
   * 计算并返回帧率指标（averageFps 和 low1PctFps）。
   *
   * 【计算方法】
   * - averageFps = 总帧数 / 总时长（秒）；
   * - low1PctFps：将所有帧耗时从大到小排序，取第 99 百分位（最慢的 1%）
   *   对应的帧耗时，再换算为帧率（1000 / 耗时）；
   * - 结果均四舍五入到小数点后两位。
   *
   * 若尚未记录任何帧、或总时长为零，返回 undefined。
   *
   * @returns 帧率指标对象，或 undefined（数据不足时）
   */
  getMetrics(): FpsMetrics | undefined {
    // 数据不足时无法计算，提前返回 undefined
    if (
      this.frameDurations.length === 0 ||
      this.firstRenderTime === undefined ||
      this.lastRenderTime === undefined
    ) {
      return undefined
    }

    // 计算首末帧之间的总时长（毫秒）
    const totalTimeMs = this.lastRenderTime - this.firstRenderTime
    if (totalTimeMs <= 0) {
      return undefined // 总时长为零，无法计算有意义的帧率
    }

    // 计算平均帧率：总帧数 / 总时长（秒）
    const totalFrames = this.frameDurations.length
    const averageFps = totalFrames / (totalTimeMs / 1000)

    // 计算 1% 低帧率：从大到小排序，取第 99 百分位的帧耗时
    const sorted = this.frameDurations.slice().sort((a, b) => b - a) // 降序排列
    // 取前 1% 中最后一个索引（Math.ceil(n*0.01) - 1 确保至少取一帧）
    const p99Index = Math.max(0, Math.ceil(sorted.length * 0.01) - 1)
    const p99FrameTimeMs = sorted[p99Index]! // 最慢 1% 帧中最"快"的那帧的耗时
    // 将帧耗时转换为帧率（耗时为 0 时视为无限帧率，取 0 作为保守值）
    const low1PctFps = p99FrameTimeMs > 0 ? 1000 / p99FrameTimeMs : 0

    return {
      averageFps: Math.round(averageFps * 100) / 100, // 四舍五入到两位小数
      low1PctFps: Math.round(low1PctFps * 100) / 100, // 四舍五入到两位小数
    }
  }
}
