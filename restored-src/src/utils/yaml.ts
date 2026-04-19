/**
 * YAML 解析封装模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是配置解析层的底层工具，被需要解析 YAML 格式数据的
 * 各类模块调用（如配置文件读取、工具输入解析等）。
 *
 * 主要功能：
 * - 在 Bun 运行时优先使用内置的 Bun.YAML（零开销，无需额外包）
 * - 在 Node.js 运行时懒加载 npm 的 yaml 包（约 270KB）
 * - 通过运行时检测实现无缝跨运行时兼容
 *
 * 性能考量：
 * - Bun 原生 YAML 解析器为内置功能，无模块加载开销
 * - yaml npm 包体积约 270KB，通过懒加载避免 Bun 构建中引入不必要的体积
 */

/**
 * 解析 YAML 格式字符串为 JavaScript 值。
 *
 * 流程：
 * 1. 检测当前运行时是否为 Bun（typeof Bun !== 'undefined'）
 * 2. Bun 环境 → 调用 Bun.YAML.parse()（内置，零成本）
 * 3. Node.js 环境 → 通过 require() 懒加载 yaml npm 包并调用 parse()
 *
 * @param input 要解析的 YAML 字符串
 * @returns 解析后的 JavaScript 值（对象、数组、基本类型等）
 */
export function parseYaml(input: string): unknown {
  // 检测 Bun 运行时：Bun 全局对象存在时使用内置解析器
  if (typeof Bun !== 'undefined') {
    return Bun.YAML.parse(input)
  }
  // Node.js 环境：懒加载 yaml 包，避免 Bun 构建中引入 ~270KB 的解析器
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('yaml') as typeof import('yaml')).parse(input)
}
