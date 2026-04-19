/**
 * CursorDeclarationContext —— 终端光标位置声明 React Context
 *
 * 【在 Claude Code 系统中的位置】
 * 位于 Ink 自定义渲染层的组件上下文层，专门负责终端物理光标位置的协调。
 * 由根渲染组件（ink.tsx）提供，子组件（如文本输入框）通过此 Context
 * 声明自己期望光标所在的位置，渲染器在每帧输出完成后将光标移动至该位置。
 *
 * 【主要功能】
 * 解决终端 UI 中的光标位置问题：Ink 使用"重绘整屏"模式，每帧都会重新输出
 * 所有内容。若不主动移动光标，光标会停留在最后一个输出字符之后。
 * 本 Context 允许聚焦的输入组件声明"光标应在我内部的 (relativeX, relativeY) 处"，
 * 渲染器读取此声明后，在渲染完成时用 ANSI 序列将光标精确定位到正确位置。
 *
 * 【CursorDeclaration 字段说明】
 * - relativeX：相对于声明节点左边界的列偏移（终端单元宽度）
 * - relativeY：相对于声明节点顶边界的行偏移
 * - node：提供绝对坐标原点的 ink-box DOMElement（通过其 Yoga 布局计算绝对位置）
 *
 * 【setter 的条件清除机制】
 * CursorDeclarationSetter 的第二个参数 clearIfNode 实现了安全的条件清除：
 * 仅当当前已声明的节点与 clearIfNode 匹配时才清除声明，防止列表项组件在
 * 焦点切换时因布局 effect 执行顺序不确定而互相覆盖对方的声明。
 */
import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

/** 描述光标在某个 DOM 节点内的相对位置 */
export type CursorDeclaration = {
  /** 相对于声明节点左边界的列偏移（以终端字符宽度为单位） */
  readonly relativeX: number
  /** 相对于声明节点顶边界的行偏移 */
  readonly relativeY: number
  /** 提供绝对坐标原点的 ink-box DOMElement，渲染器通过其 Yoga 布局计算绝对位置 */
  readonly node: DOMElement
}

/**
 * 光标位置声明的 setter 函数类型。
 *
 * 第一个参数为声明对象或 null（null 表示清除声明）。
 * 第二个可选参数 clearIfNode：仅当当前已声明节点为 clearIfNode 时才执行清除操作。
 * 此条件清除机制使同级组件（如列表项）在相互传递焦点时保持安全，
 * 避免因 layout effect 顺序问题导致已聚焦组件的声明被刚失焦组件意外清除。
 */
export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

/**
 * CursorDeclarationContext 提供 setter 函数，
 * 聚焦的输入组件通过此 setter 向渲染器声明期望的光标位置。
 *
 * 默认值为空操作（no-op），确保在未被 Provider 包裹时不会出错。
 * 实际的 setter 实现由 ink.tsx 中的根渲染组件通过 Provider 注入。
 */
const CursorDeclarationContext = createContext<CursorDeclarationSetter>(
  () => {},  // 默认空操作
)

export default CursorDeclarationContext
