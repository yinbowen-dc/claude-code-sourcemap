/**
 * Vim 状态转换表（State Transition Table）
 *
 * 在 Claude Code 的 Vim 模式系统中，本文件处于按键解析与命令调度层：
 * - 上层：Vim 模式控制器接收原始按键事件，调用 transition() 驱动状态机
 * - 本层：以穷举的 switch 语句为核心，根据当前状态和输入键，决定"下一状态"和"执行动作"
 * - 下层：operators.ts 提供具体的文本变换函数；motions.ts 提供光标位移计算
 *
 * 设计原则：
 * - 本文件是所有 Normal 模式按键行为的唯一权威来源（single source of truth）
 * - 每个状态对应一个独立的 fromXxx() 函数，便于按状态定位与维护
 * - TransitionResult 的 next/execute 分离允许调用方延迟执行副作用
 */

import { resolveMotion } from './motions.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from './operators.js'
import {
  type CommandState,
  FIND_KEYS,
  type FindType,
  isOperatorKey,
  isTextObjScopeKey,
  MAX_VIM_COUNT,
  OPERATORS,
  type Operator,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type TextObjScope,
} from './types.js'

/**
 * 转换函数所需的完整上下文。
 *
 * 继承自 OperatorContext（文本读写、光标、寄存器等），
 * 并额外提供：
 * - onUndo：触发撤销操作（u 命令）
 * - onDotRepeat：触发点号重复（. 命令）
 */
export type TransitionContext = OperatorContext & {
  onUndo?: () => void        // 撤销回调（u 命令）
  onDotRepeat?: () => void   // 点号重复回调（. 命令）
}

/**
 * 状态转换的返回结果。
 *
 * - next：可选的下一状态；若省略则保持当前状态
 * - execute：可选的待执行函数；调用方在更新状态后执行副作用
 *
 * 两者均为可选：
 * - 仅 next：纯状态跳转（如进入 operator 状态等待 motion）
 * - 仅 execute：在当前状态执行命令后隐式回到 idle
 * - 两者均无：忽略该输入
 */
export type TransitionResult = {
  next?: CommandState     // 下一个命令状态
  execute?: () => void    // 待执行的副作用函数
}

/**
 * 主转换函数：根据当前状态类型分发到对应的状态处理函数。
 *
 * 使用 TypeScript 的穷举 switch 确保所有 CommandState 变体均被处理。
 *
 * @param state 当前命令状态
 * @param input 用户输入的按键字符串
 * @param ctx   执行上下文
 * @returns     转换结果（下一状态和/或执行函数）
 */
export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle':
      return fromIdle(input, ctx)
    case 'count':
      return fromCount(state, input, ctx)
    case 'operator':
      return fromOperator(state, input, ctx)
    case 'operatorCount':
      return fromOperatorCount(state, input, ctx)
    case 'operatorFind':
      return fromOperatorFind(state, input, ctx)
    case 'operatorTextObj':
      return fromOperatorTextObj(state, input, ctx)
    case 'find':
      return fromFind(state, input, ctx)
    case 'g':
      return fromG(state, input, ctx)
    case 'operatorG':
      return fromOperatorG(state, input, ctx)
    case 'replace':
      return fromReplace(state, input, ctx)
    case 'indent':
      return fromIndent(state, input, ctx)
  }
}

// ============================================================================
// 共享输入处理函数
// ============================================================================

/**
 * 处理在 idle 和 count 状态下均有效的通用 Normal 模式输入。
 *
 * 按优先级依次尝试匹配：
 * 1. 操作符键（d/c/y）→ 进入 operator 状态
 * 2. 简单移动键（h/j/k/l/w/b/e 等）→ 执行移动
 * 3. 查找键（f/F/t/T）→ 进入 find 状态
 * 4. 'g' → 进入 g 状态（等待 gj/gk/gg）
 * 5. 'r' → 进入 replace 状态
 * 6. '>'/'<' → 进入 indent 状态
 * 7. 各类单键命令（~/x/J/p/P/D/C/Y/G/./;/,/u/i/I/a/A/o/O）→ 直接执行
 *
 * @param input 用户输入
 * @param count 当前重复计数
 * @param ctx   执行上下文
 * @returns     转换结果，或 null（未匹配到任何命令）
 */
function handleNormalInput(
  input: string,
  count: number,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isOperatorKey(input)) {
    return { next: { type: 'operator', op: OPERATORS[input], count } } // 进入操作符状态
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return {
      execute: () => {
        const target = resolveMotion(input, ctx.cursor, count) // 计算移动目标
        ctx.setOffset(target.offset)                            // 应用新偏移
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return { next: { type: 'find', find: input as FindType, count } } // 进入查找状态
  }

  if (input === 'g') return { next: { type: 'g', count } }              // 进入 g 前缀状态
  if (input === 'r') return { next: { type: 'replace', count } }        // 进入替换字符状态
  if (input === '>' || input === '<') {
    return { next: { type: 'indent', dir: input, count } }              // 进入缩进状态
  }
  if (input === '~') {
    return { execute: () => executeToggleCase(count, ctx) }             // 切换大小写
  }
  if (input === 'x') {
    return { execute: () => executeX(count, ctx) }                      // 删除字符（x）
  }
  if (input === 'J') {
    return { execute: () => executeJoin(count, ctx) }                   // 合并行
  }
  if (input === 'p' || input === 'P') {
    return { execute: () => executePaste(input === 'p', count, ctx) }   // 粘贴（p 后/P 前）
  }
  if (input === 'D') {
    return { execute: () => executeOperatorMotion('delete', '$', 1, ctx) } // D：删除到行尾
  }
  if (input === 'C') {
    return { execute: () => executeOperatorMotion('change', '$', 1, ctx) } // C：修改到行尾
  }
  if (input === 'Y') {
    return { execute: () => executeLineOp('yank', count, ctx) }           // Y：复制整行
  }
  if (input === 'G') {
    return {
      execute: () => {
        // count=1 表示无 count，跳到最后一行；否则跳到第 N 行
        if (count === 1) {
          ctx.setOffset(ctx.cursor.startOfLastLine().offset) // 跳到文件末尾
        } else {
          ctx.setOffset(ctx.cursor.goToLine(count).offset)  // 跳到第 N 行
        }
      },
    }
  }
  if (input === '.') {
    return { execute: () => ctx.onDotRepeat?.() }   // 点号重复上次变更
  }
  if (input === ';' || input === ',') {
    return { execute: () => executeRepeatFind(input === ',', count, ctx) } // 重复查找（;正向/,反向）
  }
  if (input === 'u') {
    return { execute: () => ctx.onUndo?.() }         // 撤销
  }
  if (input === 'i') {
    return { execute: () => ctx.enterInsert(ctx.cursor.offset) } // 在光标处进入插入模式
  }
  if (input === 'I') {
    return {
      execute: () =>
        ctx.enterInsert(ctx.cursor.firstNonBlankInLogicalLine().offset), // 在行首非空白处进入插入模式
    }
  }
  if (input === 'a') {
    return {
      execute: () => {
        const newOffset = ctx.cursor.isAtEnd()
          ? ctx.cursor.offset          // 已在末尾：原地进入
          : ctx.cursor.right().offset  // 在光标后一位进入插入模式
        ctx.enterInsert(newOffset)
      },
    }
  }
  if (input === 'A') {
    return {
      execute: () => ctx.enterInsert(ctx.cursor.endOfLogicalLine().offset), // 在行尾进入插入模式
    }
  }
  if (input === 'o') {
    return { execute: () => executeOpenLine('below', ctx) } // 在下方开新行
  }
  if (input === 'O') {
    return { execute: () => executeOpenLine('above', ctx) } // 在上方开新行
  }

  return null // 未匹配到任何命令
}

/**
 * 处理操作符状态下的后续输入（motion / find / text object scope）。
 *
 * 在已知操作符（d/c/y）后，等待以下输入：
 * 1. 文本对象范围键（i/a）→ 进入 operatorTextObj 状态
 * 2. 查找键（f/F/t/T）→ 进入 operatorFind 状态
 * 3. 简单移动键（h/j/w/$ 等）→ 执行操作符+移动
 * 4. 'G' → 执行操作符+G（跳到末行）
 * 5. 'g' → 进入 operatorG 状态（等待 gg/gj/gk）
 *
 * @param op    当前操作符
 * @param count 重复计数
 * @param input 用户输入
 * @param ctx   执行上下文
 * @returns     转换结果，或 null（未匹配）
 */
function handleOperatorInput(
  op: Operator,
  count: number,
  input: string,
  ctx: TransitionContext,
): TransitionResult | null {
  if (isTextObjScopeKey(input)) {
    return {
      next: {
        type: 'operatorTextObj',
        op,
        count,
        scope: TEXT_OBJ_SCOPES[input], // 确定 inner/around 范围
      },
    }
  }

  if (FIND_KEYS.has(input)) {
    return {
      next: { type: 'operatorFind', op, count, find: input as FindType }, // 等待查找字符
    }
  }

  if (SIMPLE_MOTIONS.has(input)) {
    return { execute: () => executeOperatorMotion(op, input, count, ctx) } // 执行操作符+移动
  }

  if (input === 'G') {
    return { execute: () => executeOperatorG(op, count, ctx) } // 执行操作符+G
  }

  if (input === 'g') {
    return { next: { type: 'operatorG', op, count } } // 进入 operatorG 状态，等待 g/j/k
  }

  return null // 未匹配
}

// ============================================================================
// 各状态的转换函数——每个状态对应一个独立函数
// ============================================================================

/**
 * idle 状态下的输入处理。
 *
 * idle 是 Normal 模式的初始状态，接受所有命令的首键：
 * - '1'-'9'：开始计数序列（注意 '0' 是行首移动，不作为数字前缀）
 * - '0'：直接执行行首移动
 * - 其余：委托给 handleNormalInput
 */
function fromIdle(input: string, ctx: TransitionContext): TransitionResult {
  // '0' 是行首移动键，不能作为 count 前缀
  if (/[1-9]/.test(input)) {
    return { next: { type: 'count', digits: input } } // 开始累积数字
  }
  if (input === '0') {
    return {
      execute: () => ctx.setOffset(ctx.cursor.startOfLogicalLine().offset), // 跳到行绝对开头
    }
  }

  const result = handleNormalInput(input, 1, ctx) // count 默认为 1
  if (result) return result

  return {} // 未识别的输入：忽略
}

/**
 * count 状态下的输入处理。
 *
 * 已累积了至少一位数字，继续接受：
 * - 数字：追加到 digits 并限制在 MAX_VIM_COUNT 以内
 * - 非数字：将累积的数字作为 count，委托给 handleNormalInput
 * - 未匹配：回到 idle（取消计数）
 */
function fromCount(
  state: { type: 'count'; digits: string },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const count = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT) // 防止 count 过大
    return { next: { type: 'count', digits: String(count) } }
  }

  const count = parseInt(state.digits, 10) // 解析累积的 count
  const result = handleNormalInput(input, count, ctx)
  if (result) return result

  return { next: { type: 'idle' } } // 未匹配：取消计数，回到 idle
}

/**
 * operator 状态下的输入处理（已按下 d/c/y，等待 motion 或重复键）。
 *
 * - 操作符重复键（dd/cc/yy）→ 执行行操作
 * - 数字 → 进入 operatorCount 状态（如 d3w）
 * - 其余 → 委托给 handleOperatorInput；未匹配则回 idle
 */
function fromOperator(
  state: { type: 'operator'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // dd/cc/yy：操作符重复 = 行操作
  if (input === state.op[0]) {
    return { execute: () => executeLineOp(state.op, state.count, ctx) }
  }

  if (/[0-9]/.test(input)) {
    return {
      next: {
        type: 'operatorCount',
        op: state.op,
        count: state.count,
        digits: input, // 开始累积操作符后的 count（如 d3w 中的 3）
      },
    }
  }

  const result = handleOperatorInput(state.op, state.count, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } } // 未匹配：取消操作符，回 idle
}

/**
 * operatorCount 状态下的输入处理（操作符后跟了数字，如 d3）。
 *
 * - 数字：继续累积
 * - 非数字：将操作符 count 与 motion count 相乘得到有效 count，委托给 handleOperatorInput
 * - 未匹配：回 idle
 */
function fromOperatorCount(
  state: {
    type: 'operatorCount'
    op: Operator
    count: number
    digits: string
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (/[0-9]/.test(input)) {
    const newDigits = state.digits + input
    const parsedDigits = Math.min(parseInt(newDigits, 10), MAX_VIM_COUNT)
    return { next: { ...state, digits: String(parsedDigits) } } // 继续累积数字
  }

  const motionCount = parseInt(state.digits, 10)
  const effectiveCount = state.count * motionCount // 两个 count 相乘（如 2d3w = 6w）
  const result = handleOperatorInput(state.op, effectiveCount, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } } // 未匹配：回 idle
}

/**
 * operatorFind 状态下的输入处理（操作符+查找类型，等待目标字符）。
 *
 * 下一个任意字符均作为查找目标字符，直接执行操作。
 */
function fromOperatorFind(
  state: {
    type: 'operatorFind'
    op: Operator
    count: number
    find: FindType
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    execute: () =>
      executeOperatorFind(state.op, state.find, input, state.count, ctx), // 执行操作符+查找
  }
}

/**
 * operatorTextObj 状态下的输入处理（操作符+i/a，等待对象类型键）。
 *
 * - 识别的文本对象类型键：执行操作符+文本对象
 * - 其余：回 idle（取消操作）
 */
function fromOperatorTextObj(
  state: {
    type: 'operatorTextObj'
    op: Operator
    count: number
    scope: TextObjScope
  },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (TEXT_OBJ_TYPES.has(input)) {
    return {
      execute: () =>
        executeOperatorTextObj(state.op, state.scope, input, state.count, ctx), // 执行操作符+文本对象
    }
  }
  return { next: { type: 'idle' } } // 未识别的对象类型：取消操作
}

/**
 * find 状态下的输入处理（已按 f/F/t/T，等待目标字符）。
 *
 * 下一个任意字符均作为查找目标，执行字符查找并更新 lastFind 记录。
 */
function fromFind(
  state: { type: 'find'; find: FindType; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return {
    execute: () => {
      const result = ctx.cursor.findCharacter(input, state.find, state.count) // 执行字符查找
      if (result !== null) {
        ctx.setOffset(result)              // 应用查找结果
        ctx.setLastFind(state.find, input) // 记录供 ;/, 重复
      }
    },
  }
}

/**
 * g 状态下的输入处理（已按 g，等待第二键）。
 *
 * - 'j'/'k'：执行视觉行移动（gj/gk）
 * - 'g'：根据 count 跳转到指定行或文件首行
 * - 其余：回 idle（忽略未知 g 序列）
 */
function fromG(
  state: { type: 'g'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      execute: () => {
        const target = resolveMotion(`g${input}`, ctx.cursor, state.count) // gj/gk 视觉行移动
        ctx.setOffset(target.offset)
      },
    }
  }
  if (input === 'g') {
    // gg：有 count 时跳到第 N 行，无 count 时跳到文件首行
    if (state.count > 1) {
      return {
        execute: () => {
          const lines = ctx.text.split('\n')
          const targetLine = Math.min(state.count - 1, lines.length - 1) // count 是 1-based
          let offset = 0
          for (let i = 0; i < targetLine; i++) {
            offset += (lines[i]?.length ?? 0) + 1 // +1 计入换行符
          }
          ctx.setOffset(offset) // 跳到第 N 行行首
        },
      }
    }
    return {
      execute: () => ctx.setOffset(ctx.cursor.startOfFirstLine().offset), // 跳到文件首行
    }
  }
  return { next: { type: 'idle' } } // 未识别的 g 序列：回 idle
}

/**
 * operatorG 状态下的输入处理（操作符+g，等待第二键）。
 *
 * - 'j'/'k'：执行操作符+视觉行移动（dgj/dgk）
 * - 'g'：执行操作符+gg（跳到首行）
 * - 其余：回 idle（取消操作符）
 */
function fromOperatorG(
  state: { type: 'operatorG'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === 'j' || input === 'k') {
    return {
      execute: () =>
        executeOperatorMotion(state.op, `g${input}`, state.count, ctx), // 操作符+gj/gk
    }
  }
  if (input === 'g') {
    return { execute: () => executeOperatorGg(state.op, state.count, ctx) } // 操作符+gg
  }
  // 其他输入取消操作符
  return { next: { type: 'idle' } }
}

/**
 * replace 状态下的输入处理（已按 r，等待替换字符）。
 *
 * 特殊处理：空字符串输入（对应 Backspace/Delete）视为取消替换，回 idle。
 * 正常字符输入：执行字符替换。
 */
function fromReplace(
  state: { type: 'replace'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  // Backspace/Delete 在字面字符状态下以空字符串到达；r<BS> 在 Vim 中取消替换
  if (input === '') return { next: { type: 'idle' } }
  return { execute: () => executeReplace(input, state.count, ctx) } // 执行字符替换
}

/**
 * indent 状态下的输入处理（已按 >/<，等待重复键）。
 *
 * - 与状态中相同的方向键（>> 或 <<）：执行缩进
 * - 其余：回 idle（取消缩进操作）
 */
function fromIndent(
  state: { type: 'indent'; dir: '>' | '<'; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === state.dir) {
    return { execute: () => executeIndent(state.dir, state.count, ctx) } // 执行缩进
  }
  return { next: { type: 'idle' } } // 未匹配：取消缩进
}

// ============================================================================
// 特殊命令辅助函数
// ============================================================================

/**
 * 执行重复查找命令（;/,）。
 *
 * 读取上次 f/F/t/T 查找记录，根据 reverse 参数决定是否翻转方向后重新执行查找：
 * - false（';'）：与原方向相同
 * - true（','）：翻转方向（f↔F, t↔T）
 *
 * @param reverse true 表示 ',' 命令（翻转方向）
 * @param count   重复次数
 * @param ctx     执行上下文
 */
function executeRepeatFind(
  reverse: boolean,
  count: number,
  ctx: TransitionContext,
): void {
  const lastFind = ctx.getLastFind()
  if (!lastFind) return // 没有查找记录，无法重复

  // 根据 reverse 决定查找方向
  let findType = lastFind.type
  if (reverse) {
    // 翻转方向：f↔F, t↔T
    const flipMap: Record<FindType, FindType> = {
      f: 'F',
      F: 'f',
      t: 'T',
      T: 't',
    }
    findType = flipMap[findType]
  }

  const result = ctx.cursor.findCharacter(lastFind.char, findType, count) // 重新执行查找
  if (result !== null) {
    ctx.setOffset(result) // 应用查找结果
  }
}
