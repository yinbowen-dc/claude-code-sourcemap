/**
 * @file get-max-width.ts
 * @description 计算 Yoga 布局节点可用内容宽度的工具函数。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「布局辅助」层：
 *   React 组件 → Yoga 布局计算 → renderNodeToOutput（使用 getMaxWidth 确定文本折行宽度）
 *                                                          ↑
 *                                                     本文件（剔除内边距与边框后的净可用宽度）
 *
 * 主要职责：
 *  - 从 Yoga 节点已计算的宽度中减去左右内边距（padding）和边框（border），
 *    得到文本内容可以安全占用的最大列数。
 *  - 避免文本因内边距/边框而溢出父容器，保证折行逻辑与布局结果一致。
 *
 * 注意：返回值可能大于父容器宽度（见下方函数注释），调用方应自行 clamp。
 */

import { LayoutEdge, type LayoutNode } from './layout/node.js'

/**
 * 返回 Yoga 节点的内容可用宽度（计算宽度 − 左右内边距 − 左右边框）。
 *
 * 警告：在 column 方向的 flex 父容器中，宽度是交叉轴方向，
 * align-items: stretch 不会将子节点收缩到低于其固有尺寸，
 * 因此文本节点可能溢出（这是标准 CSS 行为）。
 * Yoga 对叶子节点做两次度量：
 *  - AtMost  阶段确定宽度  → getComputedWidth()  反映较宽的 AtMost 结果
 *  - Exactly 阶段确定高度  → getComputedHeight() 反映较窄的 Exactly 结果
 * 使用此值进行折行的调用方应将结果 clamp 到实际屏幕可用空间，
 * 以确保渲染出的行数与布局高度保持一致。
 *
 * @param yogaNode Yoga 布局节点（计算布局后调用）
 * @returns 内容区域的最大可用列数（可能为负，调用方应做下界保护）
 */
const getMaxWidth = (yogaNode: LayoutNode): number => {
  return (
    // 先取 Yoga 计算出的节点总宽度
    yogaNode.getComputedWidth() -
    // 减去左内边距
    yogaNode.getComputedPadding(LayoutEdge.Left) -
    // 减去右内边距
    yogaNode.getComputedPadding(LayoutEdge.Right) -
    // 减去左边框宽度
    yogaNode.getComputedBorder(LayoutEdge.Left) -
    // 减去右边框宽度
    yogaNode.getComputedBorder(LayoutEdge.Right)
  )
}

export default getMaxWidth
