/**
 * @file layout/engine.ts
 * 布局引擎工厂函数
 *
 * 在 Claude Code 的 Ink 布局体系中，本文件处于布局引擎抽象层：
 *   DOM reconciler（React 自定义渲染器 hostConfig）
 *   → 【本文件：createLayoutNode 统一创建布局节点入口】
 *   → yoga.ts（实际的 Yoga WASM 绑定实现）
 *   → LayoutNode（布局计算接口，定义于 node.ts）
 *
 * 设计目的：
 *  - 将「创建布局节点」的调用方与具体布局引擎实现（Yoga）解耦
 *  - 若未来需要替换布局引擎，只需修改本文件的委托目标（yoga.ts）
 *    和 node.ts 的接口，上层代码零修改
 *  - 统一的工厂函数便于在测试中注入 mock 布局节点
 */

import type { LayoutNode } from './node.js'
import { createYogaLayoutNode } from './yoga.js'

/**
 * 创建新的布局节点（当前实现委托给 Yoga WASM 引擎）。
 *
 * 由 DOM reconciler 的 createInstance / createTextInstance 调用，
 * 为每个 Ink 虚拟 DOM 节点分配对应的 Yoga 布局节点。
 *
 * @returns 实现了 LayoutNode 接口的 Yoga 节点实例
 */
export function createLayoutNode(): LayoutNode {
  // 委托给 Yoga WASM 绑定，创建一个新的 Yoga 节点实例
  return createYogaLayoutNode()
}
