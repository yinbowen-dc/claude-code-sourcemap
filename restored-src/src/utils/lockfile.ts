/**
 * lockfile.ts — proper-lockfile 懒加载代理模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是 `proper-lockfile` npm 包的懒加载代理层。
 * 文件锁定功能用于防止多个 Claude Code 进程并发写入同一文件（如配置文件、
 * 会话记录），避免数据损坏。
 *
 * 【懒加载的必要性】
 * proper-lockfile 依赖 graceful-fs，graceful-fs 在首次 require 时会对 Node.js
 * 内置 fs 模块的所有方法进行猴子补丁（monkey-patching），耗时约 8ms。
 * 若直接静态导入 proper-lockfile，这 8ms 开销会无条件进入所有启动路径，
 * 即使用户执行 `claude --help` 这类完全不需要文件锁的命令也无法避免。
 *
 * 解决方案：将 proper-lockfile 的 require() 延迟到第一次实际调用锁函数时执行，
 * 使大多数轻量级命令不承担这个启动开销。
 *
 * 【主要功能】
 * 1. lock      — 异步获取文件锁，返回用于释放锁的函数；
 * 2. lockSync  — 同步获取文件锁，返回用于释放锁的函数；
 * 3. unlock    — 异步释放文件锁；
 * 4. check     — 异步检查文件是否已被锁定。
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

/** proper-lockfile 的完整类型（用于类型推断）。 */
type Lockfile = typeof import('proper-lockfile')

// 懒加载单例：首次调用锁函数时初始化
let _lockfile: Lockfile | undefined

/**
 * 获取 proper-lockfile 模块实例（懒加载）。
 * 首次调用时通过 require() 加载模块（触发 graceful-fs 的猴子补丁），
 * 后续调用直接返回缓存的模块引用。
 *
 * 使用 require() 而非 import() 的原因：
 *   - 同步加载，避免将所有锁调用变为双层 async；
 *   - proper-lockfile 是 CommonJS 包，require() 更自然。
 */
function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

/**
 * 异步获取文件锁。
 * 若文件已被锁定，抛出异常（不等待，立即失败）。
 *
 * @param file    - 要锁定的文件路径（锁文件会创建在同目录下）
 * @param options - proper-lockfile 锁选项（重试次数、过期时间等）
 * @returns 释放锁的函数（调用后删除锁文件）
 */
export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

/**
 * 同步获取文件锁。
 * 适用于无法使用 async/await 的初始化场景。
 *
 * @param file    - 要锁定的文件路径
 * @param options - proper-lockfile 锁选项
 * @returns 同步释放锁的函数
 */
export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

/**
 * 异步释放文件锁（删除锁文件）。
 *
 * @param file    - 要解锁的文件路径
 * @param options - proper-lockfile 解锁选项
 */
export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

/**
 * 异步检查文件是否已被锁定。
 *
 * @param file    - 要检查的文件路径
 * @param options - proper-lockfile 检查选项
 * @returns true 表示文件当前被锁定
 */
export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}
