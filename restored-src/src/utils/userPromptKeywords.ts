/**
 * 用户提示词关键字匹配工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是用户输入分析层的底层工具，被对话循环和自动化控制逻辑
 * 调用，用于检测用户输入中的情绪信号和操作指令。
 *
 * 主要功能：
 * - matchesNegativeKeyword：检测用户输入中的负面情绪词（愤怒/沮丧表达）
 * - matchesKeepGoingKeyword：检测继续/维持执行的指令关键字
 *
 * 使用场景：
 * - 负面关键字：可用于触发额外的用户体验处理或监控
 * - 继续关键字：用于自动化场景中判断是否继续执行未完成的任务
 */

/**
 * 检测输入是否匹配负面情绪关键字模式。
 *
 * 流程：
 * 1. 将输入转为小写（大小写不敏感匹配）
 * 2. 用包含常见愤怒/沮丧词汇的正则进行全词匹配（\b 词界）
 * 3. 返回是否匹配
 *
 * 匹配的词汇类别：
 * - 缩略骂词（wtf、wth、ffs 等）
 * - 负面评价词（horrible、awful、dumbass 等）
 * - 挫败感短语（so frustrating、this sucks 等）
 * - 直接骂人短语（fuck you、screw this 等）
 *
 * @param input 用户输入的原始文本
 * @returns 若检测到负面情绪关键字则返回 true
 */
export function matchesNegativeKeyword(input: string): boolean {
  // 转为小写以实现大小写不敏感匹配
  const lowerInput = input.toLowerCase()

  // 负面词汇正则：使用词界 \b 避免误匹配（如 "shift" 中的 "shit"）
  const negativePattern =
    /\b(wtf|wth|ffs|omfg|shit(ty|tiest)?|dumbass|horrible|awful|piss(ed|ing)? off|piece of (shit|crap|junk)|what the (fuck|hell)|fucking? (broken|useless|terrible|awful|horrible)|fuck you|screw (this|you)|so frustrating|this sucks|damn it)\b/

  return negativePattern.test(lowerInput)
}

/**
 * 检测输入是否匹配继续执行的关键字模式。
 *
 * 流程：
 * 1. 将输入转为小写并去除首尾空白
 * 2. 若完整输入为 "continue"（唯一词），直接返回 true
 * 3. 检测输入中是否包含 "keep going" 或 "go on"（词界匹配）
 *
 * 设计考量：
 * - "continue" 仅在作为完整提示词时触发（避免误匹配含 "continue" 的正常句子）
 * - "keep going" 和 "go on" 可出现在输入的任意位置
 *
 * @param input 用户输入的原始文本
 * @returns 若检测到继续执行关键字则返回 true
 */
export function matchesKeepGoingKeyword(input: string): boolean {
  // 转为小写并去除首尾空白
  const lowerInput = input.toLowerCase().trim()

  // "continue" 仅在作为完整提示词（整个输入）时匹配
  if (lowerInput === 'continue') {
    return true
  }

  // "keep going" 或 "go on" 可出现在输入任意位置（词界保护）
  const keepGoingPattern = /\b(keep going|go on)\b/
  return keepGoingPattern.test(lowerInput)
}
