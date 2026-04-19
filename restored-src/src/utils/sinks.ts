/**
 * 启动时数据汇聚（Sink）初始化模块。
 *
 * 在 Claude Code 系统中，该模块是叶子模块（Leaf Module），
 * 不依赖 setup.ts，专门供以下入口点调用：
 * - 默认命令：由 setup() 间接调用
 * - 子命令、守护进程（daemon）、桥接（bridge）：直接调用 initSinks()
 *
 * 之所以单独抽取为叶子模块，是为了规避
 * setup → commands → bridge → setup 的循环导入问题。
 *
 * 主要导出：
 * - `initSinks()`：幂等地初始化错误日志汇和分析事件汇
 */
import { initializeAnalyticsSink } from '../services/analytics/sink.js'
import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * 同时挂载错误日志汇（ErrorLogSink）和分析事件汇（AnalyticsSink），
 * 并排放在挂载前已排队的事件。两个初始化函数均为幂等操作，
 * 多次调用不会产生副作用。
 */
export function initSinks(): void {
  // 初始化错误日志汇：收集并持久化运行时错误
  initializeErrorLogSink()
  // 初始化分析事件汇：将遥测事件发送到分析后端
  initializeAnalyticsSink()
}
