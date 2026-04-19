/**
 * 自定义树形结构渲染模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块是 CLI 输出层的底层格式化工具，用于将嵌套对象结构以树形文本形式
 * 呈现在终端界面（Ink/React）中。调用方包括需要可视化工具输出、配置信息
 * 或层级数据的各类 UI 组件。
 *
 * 主要功能：
 * - 将任意嵌套的 TreeNode 对象渲染为带分支符号的树形文本
 * - 支持 Ink 主题颜色（分支符号、键名、值分别可配置颜色）
 * - 通过 WeakSet 检测并安全处理循环引用
 * - 支持数组节点展示（显示为 [Array(N)]）
 * - 可配置是否显示值、是否隐藏函数属性
 */

import figures from 'figures'
import { color } from '../components/design-system/color.js'
import type { Theme, ThemeName } from './theme.js'

/**
 * 树节点类型：键映射到子节点（嵌套对象）、叶值（字符串）或 undefined。
 */
export type TreeNode = {
  [key: string]: TreeNode | string | undefined
}

/**
 * treeify() 的配置选项。
 */
export type TreeifyOptions = {
  showValues?: boolean       // 是否在叶节点显示值，默认 true
  hideFunctions?: boolean    // 是否隐藏函数类型属性，默认 false
  useColors?: boolean        // 保留字段（暂未使用）
  themeName?: ThemeName      // 主题名称，默认 'dark'
  treeCharColors?: {
    treeChar?: keyof Theme   // 分支符号（├ └ │）的颜色键
    key?: keyof Theme        // 属性名的颜色键
    value?: keyof Theme      // 属性值的颜色键
  }
}

/**
 * 树形渲染所用的分支符号集合。
 */
type TreeCharacters = {
  branch: string      // 中间分支：├
  lastBranch: string  // 末尾分支：└
  line: string        // 竖线连接符：│
  empty: string       // 最后一项的缩进占位：空格
}

// 使用 figures 库提供的跨平台 Unicode 分支符号
const DEFAULT_TREE_CHARS: TreeCharacters = {
  branch: figures.lineUpDownRight,  // '├'
  lastBranch: figures.lineUpRight,  // '└'
  line: figures.lineVertical,       // '│'
  empty: ' ',
}

/**
 * 将嵌套对象渲染为带颜色的树形文本字符串。
 *
 * 灵感来源：https://github.com/notatestuser/treeify
 * 在其基础上增加了 Ink 主题颜色、循环引用检测和数组展示。
 *
 * 流程：
 * 1. 解构选项，设置默认值
 * 2. 初始化行缓冲区和循环引用检测 WeakSet
 * 3. 递归调用内部 growBranch() 函数构建每一行
 * 4. 对空对象返回着色的 "(empty)" 字符串
 * 5. 特殊处理单个空白键的情况（不显示键名，直接显示值）
 * 6. 将所有行用换行符连接后返回
 *
 * @param obj 要渲染的树节点对象
 * @param options 渲染选项
 * @returns 树形文本字符串
 */
export function treeify(obj: TreeNode, options: TreeifyOptions = {}): string {
  const {
    showValues = true,
    hideFunctions = false,
    themeName = 'dark',
    treeCharColors = {},
  } = options

  const lines: string[] = []          // 已渲染的行缓冲区
  const visited = new WeakSet<object>() // 循环引用检测集合

  /**
   * 对文本应用主题颜色（若指定了颜色键）。
   * @param text 要着色的文本
   * @param colorKey 主题颜色键，未指定则原样返回
   */
  function colorize(text: string, colorKey?: keyof Theme): string {
    if (!colorKey) return text
    return color(colorKey, themeName)(text)
  }

  /**
   * 递归渲染树的一个分支节点，将每行结果追加到 lines 数组。
   *
   * 流程：
   * 1. 字符串节点 → 直接输出值行
   * 2. 非对象/null → 视 showValues 决定是否输出值行
   * 3. 检测循环引用 → 输出 "[Circular]" 行
   * 4. 过滤键列表（可选隐藏函数属性）
   * 5. 遍历键：
   *    a. 循环引用值 → 单行显示 "[Circular]"
   *    b. 嵌套对象（非数组）→ 先输出键行，再递归渲染子节点
   *    c. 数组 → 输出 "[Array(N)]" 行
   *    d. 其他值 → 视 showValues 决定输出格式
   *
   * @param node 当前节点（TreeNode 或字符串）
   * @param prefix 当前行的前缀缩进（含父级连接符）
   * @param _isLast 是否为父级最后一个子节点（保留参数）
   * @param depth 当前递归深度，首层为 0
   */
  function growBranch(
    node: TreeNode | string,
    prefix: string,
    _isLast: boolean,
    depth: number = 0,
  ): void {
    // 叶节点：直接输出字符串值
    if (typeof node === 'string') {
      lines.push(prefix + colorize(node, treeCharColors.value))
      return
    }

    // 非对象/null：按 showValues 决定是否显示
    if (typeof node !== 'object' || node === null) {
      if (showValues) {
        const valueStr = String(node)
        lines.push(prefix + colorize(valueStr, treeCharColors.value))
      }
      return
    }

    // 循环引用检测
    if (visited.has(node)) {
      lines.push(prefix + colorize('[Circular]', treeCharColors.value))
      return
    }
    visited.add(node) // 标记当前节点已访问

    // 过滤键列表（可选隐藏函数属性）
    const keys = Object.keys(node).filter(key => {
      const value = node[key]
      if (hideFunctions && typeof value === 'function') return false
      return true
    })

    keys.forEach((key, index) => {
      const value = node[key]
      const isLastKey = index === keys.length - 1
      // 首层第一个节点不加额外前缀（避免顶层多一个缩进）
      const nodePrefix = depth === 0 && index === 0 ? '' : prefix

      // 根据是否为末尾节点选择分支符号
      const treeChar = isLastKey
        ? DEFAULT_TREE_CHARS.lastBranch
        : DEFAULT_TREE_CHARS.branch
      const coloredTreeChar = colorize(treeChar, treeCharColors.treeChar)
      // 空白键不显示键名（用于纯值节点）
      const coloredKey =
        key.trim() === '' ? '' : colorize(key, treeCharColors.key)

      let line =
        nodePrefix + coloredTreeChar + (coloredKey ? ' ' + coloredKey : '')

      // 非空白键时在键名后加冒号
      const shouldAddColon = key.trim() !== ''

      // 循环引用值：单行输出
      if (value && typeof value === 'object' && visited.has(value)) {
        const coloredValue = colorize('[Circular]', treeCharColors.value)
        lines.push(
          line + (shouldAddColon ? ': ' : line ? ' ' : '') + coloredValue,
        )
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // 嵌套对象（非数组）：先输出键行，再递归
        lines.push(line)
        // 计算子层的前缀：末尾节点用空格，中间节点用竖线
        const continuationChar = isLastKey
          ? DEFAULT_TREE_CHARS.empty
          : DEFAULT_TREE_CHARS.line
        const coloredContinuation = colorize(
          continuationChar,
          treeCharColors.treeChar,
        )
        const nextPrefix = nodePrefix + coloredContinuation + ' '
        growBranch(value, nextPrefix, isLastKey, depth + 1)
      } else if (Array.isArray(value)) {
        // 数组：显示为 "[Array(N)]" 格式，不展开数组内容
        lines.push(
          line +
            (shouldAddColon ? ': ' : line ? ' ' : '') +
            '[Array(' +
            value.length +
            ')]',
        )
      } else if (showValues) {
        // 叶值：函数显示为 "[Function]"，其他转为字符串
        const valueStr =
          typeof value === 'function' ? '[Function]' : String(value)
        const coloredValue = colorize(valueStr, treeCharColors.value)
        line += (shouldAddColon ? ': ' : line ? ' ' : '') + coloredValue
        lines.push(line)
      } else {
        // showValues=false 且非对象/数组：仅输出键行
        lines.push(line)
      }
    })
  }

  // 空对象：返回 "(empty)"
  const keys = Object.keys(obj)
  if (keys.length === 0) {
    return colorize('(empty)', treeCharColors.value)
  }

  // 特殊情况：仅有一个空白键且值为字符串（纯值节点）
  // 直接显示 "└ value"，不显示空键名
  if (
    keys.length === 1 &&
    keys[0] !== undefined &&
    keys[0].trim() === '' &&
    typeof obj[keys[0]] === 'string'
  ) {
    const firstKey = keys[0]
    const coloredTreeChar = colorize(
      DEFAULT_TREE_CHARS.lastBranch,
      treeCharColors.treeChar,
    )
    const coloredValue = colorize(obj[firstKey] as string, treeCharColors.value)
    return coloredTreeChar + ' ' + coloredValue
  }

  // 从根节点开始渲染整棵树
  growBranch(obj, '', true)
  return lines.join('\n')
}
