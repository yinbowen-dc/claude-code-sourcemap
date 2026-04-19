/**
 * Vim 模式状态机类型定义
 *
 * 【文件在系统中的位置与作用】
 * 本文件位于 Claude Code Vim 模式实现层的核心，是整个 Vim 输入处理状态机的
 * 类型基础。它定义了从按键输入到命令执行全链路所需的所有类型，供 motions.ts、
 * operators.ts、textObjects.ts 和 transitions.ts 共同使用。
 *
 * 【设计原则】
 * 类型本身即文档——阅读类型定义即可理解系统运行机制。
 * TypeScript 的联合类型确保 switch 语句的穷举性检查，防止漏处理状态。
 *
 * 状态图（State Diagram）：
 * ```
 *                              VimState（总状态）
 *   ┌──────────────────────────────┬──────────────────────────────────────┐
 *   │  INSERT（插入模式）           │  NORMAL（普通模式）                   │
 *   │  （追踪已输入文本）           │  （CommandState 子状态机）            │
 *   │                              │                                      │
 *   │                              │  idle ──┬─[d/c/y]──► operator        │
 *   │                              │         ├─[1-9]────► count           │
 *   │                              │         ├─[fFtT]───► find            │
 *   │                              │         ├─[g]──────► g               │
 *   │                              │         ├─[r]──────► replace         │
 *   │                              │         └─[><]─────► indent          │
 *   │                              │                                      │
 *   │                              │  operator ─┬─[motion]──► execute     │
 *   │                              │            ├─[0-9]────► operatorCount│
 *   │                              │            ├─[ia]─────► operatorTextObj
 *   │                              │            └─[fFtT]───► operatorFind │
 *   └──────────────────────────────┴──────────────────────────────────────┘
 * ```
 */

// ============================================================================
// 核心原子类型（Core Types）
// ============================================================================

/** 操作符类型：delete（删除）、change（修改）、yank（复制） */
export type Operator = 'delete' | 'change' | 'yank'

/** 查找跳转类型：f/F（含目标字符）、t/T（至目标字符前） */
export type FindType = 'f' | 'F' | 't' | 'T'

/** 文本对象作用域：inner（不含边界）或 around（含边界/空白） */
export type TextObjScope = 'inner' | 'around'

// ============================================================================
// 状态机类型（State Machine Types）
// ============================================================================

/**
 * Vim 完整状态。模式字段决定追踪哪些数据。
 *
 * - INSERT 模式：追踪已输入文本（用于点号重复）
 * - NORMAL 模式：追踪正在解析的命令（子状态机）
 *
 * 该联合类型是 transitions.ts 中 `transition()` 函数的主要输入/输出类型。
 */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }  // 插入模式：记录本次插入的字符串
  | { mode: 'NORMAL'; command: CommandState } // 普通模式：携带命令解析子状态

/**
 * 普通模式下的命令子状态机。
 *
 * 每个状态精确描述当前等待哪类输入：
 * - idle：空闲，等待新命令首键
 * - count：已收到数字前缀，等待后续命令
 * - operator：已收到操作符，等待动作/文本对象
 * - operatorCount：操作符后跟数字前缀，等待动作/文本对象
 * - operatorFind：操作符后跟 f/F/t/T，等待目标字符
 * - operatorTextObj：操作符后跟 i/a，等待文本对象类型
 * - find：独立 f/F/t/T，等待目标字符
 * - g：已收到 'g'，等待第二键（如 gg/gj/gk）
 * - operatorG：操作符后收到 'g'，等待第二键
 * - replace：已收到 'r'，等待替换字符
 * - indent：已收到 '>' 或 '<'，等待第二次重复完成双键命令
 *
 * TypeScript 联合类型确保 switch 语句穷举所有状态，避免遗漏。
 */
export type CommandState =
  | { type: 'idle' }                                                     // 空闲态，等待命令起始键
  | { type: 'count'; digits: string }                                    // 已输入数字前缀，等待命令
  | { type: 'operator'; op: Operator; count: number }                    // 已输入操作符，等待动作
  | { type: 'operatorCount'; op: Operator; count: number; digits: string } // 操作符后的数字前缀
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType } // 操作符 + f/F/t/T
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjScope  // 文本对象作用域（inner/around）
    }
  | { type: 'find'; find: FindType; count: number }    // 独立跳转命令，等待目标字符
  | { type: 'g'; count: number }                       // 已收到 'g'，等待第二键
  | { type: 'operatorG'; op: Operator; count: number } // 操作符 + 'g'，等待第二键
  | { type: 'replace'; count: number }                 // 已收到 'r'，等待替换字符
  | { type: 'indent'; dir: '>' | '<'; count: number }  // 已收到一个缩进方向键

/**
 * 跨命令的持久状态（Persistent State）。
 *
 * 该类型是 Vim "记忆"的载体，保存最近一次变更、最近一次跳转、
 * 以及默认寄存器内容，以支持点号重复（.）和粘贴（p/P）操作。
 *
 * 与 VimState/CommandState 不同，PersistentState 在命令执行完成后
 * 依然保留，直到被新命令覆盖。
 */
export type PersistentState = {
  lastChange: RecordedChange | null           // 最近一次可重复的变更（用于 . 命令）
  lastFind: { type: FindType; char: string } | null // 最近一次查找（用于 ; 和 , 重复）
  register: string                            // 默认寄存器内容（用于 p/P 粘贴）
  registerIsLinewise: boolean                 // 寄存器内容是否为行级（影响粘贴方式）
}

/**
 * 已记录变更类型（Recorded Change）——用于点号重复（.）。
 *
 * 联合类型覆盖所有可被 . 重复的命令类型：
 * - insert：插入模式输入的文本
 * - operator：操作符 + 动作（如 dw、c$）
 * - operatorTextObj：操作符 + 文本对象（如 diw、ca(）
 * - operatorFind：操作符 + 查找（如 df,）
 * - replace：单字符替换（r）
 * - x：删除当前字符（x）
 * - toggleCase：大小写翻转（~）
 * - indent：缩进（>> 或 <<）
 * - openLine：新建行（o/O）
 * - join：合并行（J）
 *
 * 每个分支携带足够的信息以精确重放对应命令。
 */
export type RecordedChange =
  | { type: 'insert'; text: string }                           // 插入模式文本
  | {
      type: 'operator'
      op: Operator       // 操作符类型
      motion: string     // 动作键字符串
      count: number      // 重复次数
    }
  | {
      type: 'operatorTextObj'
      op: Operator       // 操作符类型
      objType: string    // 文本对象类型键（'w'/'('/'\"' 等）
      scope: TextObjScope // inner/around 作用域
      count: number
    }
  | {
      type: 'operatorFind'
      op: Operator       // 操作符类型
      find: FindType     // f/F/t/T 查找方向
      char: string       // 目标字符
      count: number
    }
  | { type: 'replace'; char: string; count: number }           // r 替换
  | { type: 'x'; count: number }                               // x 删除
  | { type: 'toggleCase'; count: number }                      // ~ 大小写翻转
  | { type: 'indent'; dir: '>' | '<'; count: number }          // >> / << 缩进
  | { type: 'openLine'; direction: 'above' | 'below' }         // o/O 开新行
  | { type: 'join'; count: number }                            // J 合并行

// ============================================================================
// 按键分组常量（Key Groups - Named constants, no magic strings）
// ============================================================================

/**
 * 操作符按键映射表。
 *
 * 将 d/c/y 映射到对应的 Operator 字符串字面量。
 * `as const satisfies` 确保值类型收窄为字面量类型，同时验证所有值均为合法 Operator。
 */
export const OPERATORS = {
  d: 'delete', // d → 删除操作
  c: 'change', // c → 修改操作
  y: 'yank',   // y → 复制操作
} as const satisfies Record<string, Operator>

/**
 * 判断某个键是否为操作符键（d/c/y）。
 * 用于 transitions.ts 中的按键分类。
 */
export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return key in OPERATORS // 检查键名是否在 OPERATORS 映射中
}

/**
 * 简单动作键集合（不需要额外输入即可完成的移动键）。
 *
 * 包含：
 * - h/l/j/k：基础方向移动
 * - w/b/e/W/B/E：单词级移动
 * - 0/^/$：行首/首非空白/行尾
 *
 * 不包含需要第二次按键的 f/F/t/T/g/r 等。
 */
export const SIMPLE_MOTIONS = new Set([
  'h',
  'l',
  'j',
  'k', // 基础方向移动
  'w',
  'b',
  'e',
  'W',
  'B',
  'E', // 单词级移动（小写 vim-word，大写 WORD）
  '0',
  '^',
  '$', // 行位置移动
])

/**
 * 查找跳转键集合（f/F/t/T）。
 * 这些键需要后跟一个目标字符才能完成命令。
 */
export const FIND_KEYS = new Set(['f', 'F', 't', 'T'])

/**
 * 文本对象作用域键映射（i → inner，a → around）。
 * `as const satisfies` 保证值类型为 TextObjScope 字面量。
 */
export const TEXT_OBJ_SCOPES = {
  i: 'inner',  // i → inner（不含边界）
  a: 'around', // a → around（含边界/空白）
} as const satisfies Record<string, TextObjScope>

/**
 * 判断某个键是否为文本对象作用域键（i/a）。
 * 用于 transitions.ts 中在操作符后识别文本对象命令。
 */
export function isTextObjScopeKey(
  key: string,
): key is keyof typeof TEXT_OBJ_SCOPES {
  return key in TEXT_OBJ_SCOPES // 检查是否为 'i' 或 'a'
}

/**
 * 文本对象类型键集合。
 *
 * 包含所有合法的文本对象类型字符：
 * - w/W：vim-word / WORD
 * - " ' `：引号对象
 * - ( ) b / [ ] / { } B / < >：括号对象
 *
 * 在 transitions.ts 中，收到 i/a 后下一个键需在此集合中才视为合法文本对象。
 */
export const TEXT_OBJ_TYPES = new Set([
  'w',
  'W', // vim-word / WORD
  '"',
  "'",
  '`', // 引号对象
  '(',
  ')',
  'b', // 圆括号（b 是 ( 的别名）
  '[',
  ']', // 方括号
  '{',
  '}',
  'B', // 花括号（B 是 { 的别名）
  '<',
  '>', // 尖括号
])

/** Vim 计数上限，防止用户输入过大数字导致性能问题 */
export const MAX_VIM_COUNT = 10000

// ============================================================================
// 状态工厂函数（State Factories）
// ============================================================================

/**
 * 创建初始 VimState。
 *
 * 系统启动时默认进入 INSERT 模式（与 Claude Code 文本输入框的交互习惯一致），
 * 插入文本记录为空字符串。
 */
export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' } // 默认插入模式，无历史输入
}

/**
 * 创建初始 PersistentState。
 *
 * 所有持久字段重置为"无记忆"初始值：
 * - lastChange / lastFind 均为 null（无历史可重复）
 * - register 为空字符串，registerIsLinewise 为 false
 */
export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,          // 无上次变更记录
    lastFind: null,            // 无上次查找记录
    register: '',              // 寄存器为空
    registerIsLinewise: false, // 默认非行级寄存器
  }
}
