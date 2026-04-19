/**
 * 语义版本号比较工具模块
 *
 * 在 Claude Code 系统中的位置：
 * 运行时环境检测 → 版本兼容性校验 → semver
 *
 * 主要功能：
 * 封装 semver（语义版本号）比较操作，提供统一的 gt/gte/lt/lte/satisfies/order 接口。
 * 在 Bun 环境下使用内置的 Bun.semver（比 npm semver 快约 20 倍），
 * 在 Node.js 环境下懒加载 npm 的 semver 包作为备选。
 *
 * 快速路径：Bun.semver.order() 是原生实现，性能最优。
 * 回退路径：npm semver 包，始终使用 { loose: true } 以提高兼容性。
 */

// 懒加载缓存：仅在 Node.js 环境中首次使用时加载 npm semver 包
let _npmSemver: typeof import('semver') | undefined

/**
 * 懒加载 npm semver 包
 *
 * 函数流程：
 * 1. 检查缓存变量 _npmSemver 是否已赋值
 * 2. 若未赋值，通过 require() 同步加载 'semver' 模块并缓存
 * 3. 返回缓存的模块引用
 *
 * 使用懒加载而非模块顶层 import，是为了在 Bun 环境中避免不必要的加载开销。
 */
function getNpmSemver(): typeof import('semver') {
  if (!_npmSemver) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _npmSemver = require('semver') as typeof import('semver')
  }
  return _npmSemver
}

/**
 * 判断版本 a 是否严格大于版本 b (a > b)
 *
 * Bun 快速路径：Bun.semver.order 返回 1 表示 a > b
 * Node.js 回退：npm semver.gt，loose 模式
 */
export function gt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    // Bun 原生 semver，order 返回值：1 = a>b, 0 = 相等, -1 = a<b
    return Bun.semver.order(a, b) === 1
  }
  return getNpmSemver().gt(a, b, { loose: true })
}

/**
 * 判断版本 a 是否大于或等于版本 b (a >= b)
 *
 * Bun 快速路径：Bun.semver.order 返回 >= 0 表示 a >= b
 * Node.js 回退：npm semver.gte，loose 模式
 */
export function gte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) >= 0
  }
  return getNpmSemver().gte(a, b, { loose: true })
}

/**
 * 判断版本 a 是否严格小于版本 b (a < b)
 *
 * Bun 快速路径：Bun.semver.order 返回 -1 表示 a < b
 * Node.js 回退：npm semver.lt，loose 模式
 */
export function lt(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) === -1
  }
  return getNpmSemver().lt(a, b, { loose: true })
}

/**
 * 判断版本 a 是否小于或等于版本 b (a <= b)
 *
 * Bun 快速路径：Bun.semver.order 返回 <= 0 表示 a <= b
 * Node.js 回退：npm semver.lte，loose 模式
 */
export function lte(a: string, b: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b) <= 0
  }
  return getNpmSemver().lte(a, b, { loose: true })
}

/**
 * 判断给定版本是否满足某个版本范围（semver range）
 *
 * @param version - 待检测的版本号字符串
 * @param range - 版本范围表达式，如 ">=1.0.0 <2.0.0"
 *
 * Bun 快速路径：Bun.semver.satisfies
 * Node.js 回退：npm semver.satisfies，loose 模式
 */
export function satisfies(version: string, range: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.satisfies(version, range)
  }
  return getNpmSemver().satisfies(version, range, { loose: true })
}

/**
 * 比较两个版本号的大小，返回三路比较结果
 *
 * @returns  1 表示 a > b，0 表示 a == b，-1 表示 a < b
 *
 * Bun 快速路径：Bun.semver.order（直接返回 -1|0|1）
 * Node.js 回退：npm semver.compare，loose 模式
 */
export function order(a: string, b: string): -1 | 0 | 1 {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(a, b)
  }
  return getNpmSemver().compare(a, b, { loose: true })
}
