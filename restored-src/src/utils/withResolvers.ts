/**
 * Promise.withResolvers() 的 polyfill 实现。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是底层异步工具层，为整个 Claude Code 代码库提供
 * ES2024 的 Promise.withResolvers() API。由于 package.json 声明
 * Node.js 最低版本为 18，而该原生 API 在 Node 22+ 才可用，
 * 因此通过此模块提供跨版本兼容的实现。
 *
 * 主要功能：
 * - 返回包含 { promise, resolve, reject } 的对象
 * - 允许在 Promise 构造函数外部持有并调用 resolve/reject
 * - 适用于需要延迟解析的异步协调场景
 */

// ES2024 标准接口：包含 promise 本体和解析/拒绝函数的结构体
export function withResolvers<T>(): PromiseWithResolvers<T> {
  // 在外部声明 resolve/reject，以便构造函数之外可以持有引用
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void

  // 创建 Promise，并在执行器中将 resolve/reject 赋值给外部变量
  const promise = new Promise<T>((res, rej) => {
    resolve = res // 保存 resolve 函数引用供外部调用
    reject = rej  // 保存 reject 函数引用供外部调用
  })

  // 返回三元组：promise 本体 + 解析函数 + 拒绝函数
  return { promise, resolve, reject }
}
