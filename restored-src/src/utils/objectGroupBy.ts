/**
 * 【文件定位】TC39 Object.groupBy 兼容性垫片 — Claude Code 工具层通用数据处理工具
 *
 * 在 Claude Code 的系统架构中，本文件处于\"工具函数层\"：
 *   业务逻辑 → [本模块：按 key 分组可迭代集合] → 分组结果
 *
 * 主要职责：
 *   提供 TC39 规范的 Object.groupBy 语义，兼容尚未原生支持该方法的 Node.js 版本。
 *   将可迭代集合按 keySelector 函数的返回值分组，返回以 key 为键的 Partial Record。
 *
 * 规范参考：https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.groupby
 *
 * 用法示例：
 *   objectGroupBy([1, 2, 3, 4], x => x % 2 === 0 ? 'even' : 'odd')
 *   // → { odd: [1, 3], even: [2, 4] }
 */

/**
 * 将可迭代集合按 keySelector 函数的返回值分组（TC39 Object.groupBy 的 TypeScript 实现）。
 *
 * 流程：
 *   1. 创建无原型链的纯空对象作为结果容器（避免继承 Object.prototype 上的属性冲突）
 *   2. 遍历可迭代集合，对每个元素调用 keySelector 获取分组 key
 *   3. 若该 key 对应的分组不存在则初始化为空数组
 *   4. 将当前元素追加到对应分组
 *
 * 类型安全：
 *   - K extends PropertyKey 确保 key 只能是 string | number | symbol
 *   - 返回 Partial<Record<K, T[]>> 表明不是所有 key 都必然存在（按需创建）
 *
 * @param items - 要分组的可迭代集合
 * @param keySelector - 从元素和索引计算分组 key 的函数
 * @returns 以 key 为键、元素数组为值的分组结果
 */
export function objectGroupBy<T, K extends PropertyKey>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => K,
): Partial<Record<K, T[]>> {
  // 使用 Object.create(null) 创建无原型链的对象，避免 key 与 Object.prototype 属性冲突
  const result = Object.create(null) as Partial<Record<K, T[]>>
  let index = 0
  for (const item of items) {
    // 计算当前元素的分组 key（传入索引以支持基于位置的分组）
    const key = keySelector(item, index++)
    // 首次遇到该 key 时初始化对应数组
    if (result[key] === undefined) {
      result[key] = []
    }
    // 将元素追加到对应分组（TypeScript 需要非空断言，因为上一步已确保初始化）
    result[key].push(item)
  }
  return result
}
