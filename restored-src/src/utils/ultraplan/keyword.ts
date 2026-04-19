/**
 * Ultraplan / Ultrareview 触发关键词检测模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块处于用户输入处理层与 /ultraplan、/ultrareview 特性启动层之间。
 * 当用户在 PromptInput 中输入消息时，前端会调用 hasUltraplanKeyword() /
 * hasUltrareviewKeyword() 判断是否应高亮提示并触发对应特性。
 * processUserInput.ts 在提交输入后调用 replaceUltraplanKeyword() 将
 * "ultraplan" 替换为 "plan" 再转发给远端会话，保持语法通顺。
 *
 * 主要功能：
 * - findKeywordTriggerPositions()：核心检测逻辑，跳过引号范围、路径/标识符上下文、
 *   斜杠命令及问号修饰，精确定位可触发关键词的位置
 * - findUltraplanTriggerPositions() / findUltrareviewTriggerPositions()：具体关键词的位置查找
 * - hasUltraplanKeyword() / hasUltrareviewKeyword()：是否包含可触发关键词的布尔判断
 * - replaceUltraplanKeyword()：将首个可触发 "ultraplan" 替换为 "plan"（保留大小写）
 */

/**
 * 关键词触发位置描述类型。
 * word  : 原始匹配词（保留用户输入的大小写）
 * start : 在原始字符串中的起始索引（含）
 * end   : 在原始字符串中的结束索引（不含）
 */
type TriggerPosition = { word: string; start: number; end: number }

/**
 * 配对定界符的左→右映射表。
 * 用于在扫描时识别引号/括号范围，范围内的关键词不视为触发。
 */
const OPEN_TO_CLOSE: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

/**
 * 查找文本中指定关键词的可触发位置，跳过以下不属于启动指令的情况：
 *
 * 1. **引号/定界符范围内**：反引号、双引号、尖括号（仅标签形式，
 *    `n < 5 ultraplan n > 10` 不会产生幽灵范围）、花括号、方括号
 *    （最内层——preExpansionInput 含 `[Pasted text #N]` 占位符）、圆括号。
 *    单引号仅在非缩写形式时作为定界符：开头单引号须紧跟非单词字符（或行首），
 *    结尾单引号须紧跟非单词字符（或行末），因此 "let's ultraplan it's" 仍会触发。
 *
 * 2. **路径/标识符上下文**：紧邻 `/`、`\`、`-`，或后跟 `.` + 单词字符（文件扩展名）。
 *    `\b` 会在 `-` 处识别边界，因此 `ultraplan-s` 在没有此规则时会匹配。
 *    此规则阻止 `src/ultraplan/foo.ts`、`ultraplan.tsx`、`--ultraplan-mode` 触发，
 *    但 `ultraplan.` 在句末仍可触发。
 *
 * 3. **跟随 `?`**：询问该特性不应触发它。其他句末标点（`.`、`,`、`!`）仍触发。
 *
 * 4. **斜杠命令输入**：以 `/` 开头的文本是斜杠命令（processUserInput.ts 路由给
 *    processSlashCommand，不做关键词检测），因此 `/rename ultraplan foo` 不触发。
 *    若无此规则，PromptInput 会对关键词彩虹高亮并显示"将启动 ultraplan"通知，
 *    但实际提交后运行的是 /rename 而非 /ultraplan。
 *
 * 返回形状与 findThinkingTriggerPositions（thinking.ts）一致，
 * 使 PromptInput 能够统一处理两种触发类型。
 *
 * 流程：
 * 1. 快速预检：文本中不含关键词或以 "/" 开头则直接返回空数组
 * 2. 第一次遍历：扫描字符，构建所有配对定界符范围（quotedRanges）
 * 3. 第二次遍历：用 \b{keyword}\b 正则匹配所有词边界实例
 * 4. 对每个匹配：跳过在引号范围内、相邻 /\-?、后跟 .word、后跟 ? 的情况
 * 5. 收集合法触发位置并返回
 *
 * @param text    用户输入的完整文本
 * @param keyword 要检测的关键词（大小写不敏感）
 * @returns 合法触发位置数组
 */
function findKeywordTriggerPositions(
  text: string,
  keyword: string,
): TriggerPosition[] {
  // 快速预检：不含关键词直接退出
  const re = new RegExp(keyword, 'i')
  if (!re.test(text)) return []
  // 斜杠命令：以 "/" 开头的输入不做关键词检测
  if (text.startsWith('/')) return []

  // 第一步：构建配对定界符范围（quotedRanges）
  const quotedRanges: Array<{ start: number; end: number }> = []
  let openQuote: string | null = null
  let openAt = 0
  // 判断字符是否为单词字符（字母、数字、下划线）
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (openQuote) {
      // 方括号特殊处理：遇到新的 "[" 时更新开始位置（处理嵌套情况）
      if (openQuote === '[' && ch === '[') {
        openAt = i
        continue
      }
      // 未遇到对应闭合字符，继续
      if (ch !== OPEN_TO_CLOSE[openQuote]) continue
      // 单引号后跟单词字符 → 是缩写的一部分（如 it's），不作为闭合
      if (openQuote === "'" && isWord(text[i + 1])) continue
      // 记录引号范围
      quotedRanges.push({ start: openAt, end: i + 1 })
      openQuote = null
    } else if (
      // 尖括号：仅当后跟字母或 "/" 时（类 HTML 标签），才作为定界符开始
      (ch === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
      // 单引号：仅当前一个字符不是单词字符（或在行首）时才作为定界符开始
      (ch === "'" && !isWord(text[i - 1])) ||
      // 其他定界符（排除 < 和 '）
      (ch !== '<' && ch !== "'" && ch in OPEN_TO_CLOSE)
    ) {
      openQuote = ch
      openAt = i
    }
  }

  // 第二步：匹配所有词边界实例并过滤
  const positions: TriggerPosition[] = []
  const wordRe = new RegExp(`\\b${keyword}\\b`, 'gi')
  const matches = text.matchAll(wordRe)

  for (const match of matches) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length

    // 过滤：在引号/定界符范围内
    if (quotedRanges.some(r => start >= r.start && start < r.end)) continue

    const before = text[start - 1]
    const after = text[end]

    // 过滤：紧邻 /、\、- 的路径/标识符上下文（前置）
    if (before === '/' || before === '\\' || before === '-') continue
    // 过滤：紧邻 /、\、-（后置）或后跟 ?（问句）
    if (after === '/' || after === '\\' || after === '-' || after === '?')
      continue
    // 过滤：后跟 "." + 单词字符（文件扩展名，如 ultraplan.tsx）
    if (after === '.' && isWord(text[end + 1])) continue

    // 合法触发位置
    positions.push({ word: match[0], start, end })
  }
  return positions
}

/**
 * 查找文本中所有合法的 "ultraplan" 触发位置。
 *
 * @param text 用户输入文本
 * @returns 触发位置数组
 */
export function findUltraplanTriggerPositions(text: string): TriggerPosition[] {
  return findKeywordTriggerPositions(text, 'ultraplan')
}

/**
 * 查找文本中所有合法的 "ultrareview" 触发位置。
 *
 * @param text 用户输入文本
 * @returns 触发位置数组
 */
export function findUltrareviewTriggerPositions(
  text: string,
): TriggerPosition[] {
  return findKeywordTriggerPositions(text, 'ultrareview')
}

/**
 * 判断文本中是否包含可触发 ultraplan 的关键词。
 *
 * @param text 用户输入文本
 * @returns 是否包含可触发关键词
 */
export function hasUltraplanKeyword(text: string): boolean {
  return findUltraplanTriggerPositions(text).length > 0
}

/**
 * 判断文本中是否包含可触发 ultrareview 的关键词。
 *
 * @param text 用户输入文本
 * @returns 是否包含可触发关键词
 */
export function hasUltrareviewKeyword(text: string): boolean {
  return findUltrareviewTriggerPositions(text).length > 0
}

/**
 * 将文本中首个可触发的 "ultraplan" 替换为 "plan"（保留用户输入的大小写）。
 * 用于将转发给远端会话的提示词语法化：
 *   "please ultraplan this" → "please plan this"
 *
 * 流程：
 * 1. 查找第一个合法触发位置
 * 2. 无触发位置时原样返回
 * 3. 分割触发词前后两段，拼接 "plan"（保留触发词中 "ultra" 后的大小写）
 * 4. 若替换后仅剩空白则返回空字符串
 *
 * @param text 原始用户输入文本
 * @returns 替换后的文本
 */
export function replaceUltraplanKeyword(text: string): string {
  const [trigger] = findUltraplanTriggerPositions(text)
  if (!trigger) return text
  const before = text.slice(0, trigger.start)
  const after = text.slice(trigger.end)
  // 若替换后整段文本仅为空白，返回空字符串
  if (!(before + after).trim()) return ''
  // 保留触发词中 "ultra" 后的大小写（如 "Ultraplan" → "Plan"）
  return before + trigger.word.slice('ultra'.length) + after
}
