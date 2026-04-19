/**
 * 对话记录全文搜索文本提取模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块处于 UI 搜索层与消息渲染层之间。当用户在对话界面使用"/"搜索时，
 * 前端会对所有 RenderableMessage 调用 renderableSearchText() 获取可搜索文本，
 * 再与搜索关键词进行不区分大小写的匹配。
 *
 * 主要功能：
 * - 将 RenderableMessage 扁平化为可搜索的小写字符串，按消息对象引用缓存（WeakMap）
 * - 剥离 <system-reminder> 块（仅供模型上下文，不对用户展示）
 * - 屏蔽不在 UI 中展示的中断哨兵文本，避免产生幽灵匹配
 * - 针对工具调用输入（toolUseSearchText）和工具调用结果（toolResultSearchText）
 *   采用"鸭子类型"提取可见字段，以"漏报优于误报"为原则
 */

import type { RenderableMessage } from '../types/message.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages.js'

// system-reminder 闭合标签，用于精确剥离整段提醒内容
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

// UserTextMessage.tsx (~84) 会将这两个哨兵文本替换为 <InterruptedByUser /> 组件
// 展示为"Interrupted · /issue..."，原始文本永远不会出现在屏幕上。
// 若对其建立索引，"/terr" 会错误匹配到 "in[terr]upted"——产生幽灵匹配。
const RENDERED_AS_SENTINEL = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
])

// 按消息对象引用缓存已计算的可搜索文本（WeakMap 保证消息被 GC 时缓存自动释放）。
// 消息列表只增不减且不可变，缓存命中永远有效。
// 在缓存时直接转小写：原先调用方每次都会 .toLowerCase()，导致每次按键时重复转换约 1.5MB 文本。
const searchTextCache = new WeakMap<RenderableMessage, string>()

/**
 * 将 RenderableMessage 扁平化为小写可搜索文本（WeakMap 缓存）。
 *
 * 流程：
 * 1. 先在 WeakMap 缓存中按对象引用查找
 * 2. 缓存命中 → 直接返回，零重新计算
 * 3. 缓存未命中 → 调用 computeSearchText() 计算，转小写后写入缓存
 * 4. 对非可搜索消息类型返回空字符串
 *
 * @param msg 要处理的可渲染消息对象
 * @returns 小写可搜索文本字符串
 */
export function renderableSearchText(msg: RenderableMessage): string {
  // 先查缓存，命中直接返回
  const cached = searchTextCache.get(msg)
  if (cached !== undefined) return cached
  // 计算后转小写写入缓存
  const result = computeSearchText(msg).toLowerCase()
  searchTextCache.set(msg, result)
  return result
}

/**
 * 根据消息类型提取原始可搜索文本（未转小写），并剥离 system-reminder 块。
 *
 * 各消息类型处理策略：
 * - 'user'：提取文本内容；工具结果通过 toolResultSearchText() 鸭子类型提取
 * - 'assistant'：提取文本块 + 工具调用输入（跳过 thinking 块）
 * - 'attachment'：relevant_memories 提取记忆内容；queued_command 提取提示文本
 * - 'collapsed_read_search'：提取被折叠进分组的 relevantMemories 内容
 * - 其他（grouped_tool_use, system）：无文本内容，返回空字符串
 *
 * 最后统一剥离所有 <system-reminder>...</system-reminder> 块。
 *
 * @param msg 要处理的可渲染消息对象
 * @returns 原始可搜索文本（含大小写）
 */
function computeSearchText(msg: RenderableMessage): string {
  let raw = ''
  switch (msg.type) {
    case 'user': {
      const c = msg.message.content
      if (typeof c === 'string') {
        // 字符串内容：若为中断哨兵则屏蔽，否则直接使用
        raw = RENDERED_AS_SENTINEL.has(c) ? '' : c
      } else {
        const parts: string[] = []
        for (const b of c) {
          if (b.type === 'text') {
            // 文本块：跳过中断哨兵
            if (!RENDERED_AS_SENTINEL.has(b.text)) parts.push(b.text)
          } else if (b.type === 'tool_result') {
            // tool_result 块：
            // b.content 是面向模型的序列化（含 system-reminder、<persisted-output>
            // 包装器、backgroundInfo 字符串、CYBER_RISK_MITIGATION_REMINDER 等），
            // UI 通过 renderToolResultMessage 渲染 msg.toolUseResult（工具原生输出），
            // 是不同的文本。直接索引 b.content 会产生幽灵匹配：
            //   /malware → 匹配提醒内容，/background → 匹配模型专用 ID 字符串。
            // 改为鸭子类型提取工具原生输出中的可见字段。
            // 未知形状索引为空——漏报优于幽灵。
            parts.push(toolResultSearchText(msg.toolUseResult))
          }
        }
        raw = parts.join('\n')
      }
      break
    }
    case 'assistant': {
      const c = msg.message.content
      if (Array.isArray(c)) {
        // 提取文本块和工具调用输入（命令/路径/提示词等均可见于 UI）
        // 跳过 thinking 块（hidePastThinking 在对话挂载时隐藏它们）
        raw = c
          .flatMap(b => {
            if (b.type === 'text') return [b.text]
            if (b.type === 'tool_use') return [toolUseSearchText(b.input)]
            return []
          })
          .join('\n')
      }
      break
    }
    case 'attachment': {
      if (msg.attachment.type === 'relevant_memories') {
        // relevant_memories 在对话模式下通过 <Ansi>{m.content}</Ansi> 完整渲染，
        // 没有此分支时 "[" 搜索可以找到但 "/" 搜索找不到
        raw = msg.attachment.memories.map(m => m.content).join('\n')
      } else if (
        // mid-turn 提示词（代理运行时排队的命令）
        // 通过 UserTextMessage 渲染（AttachmentMessage.tsx ~348）
        // stickyPromptText（VirtualMessageList.tsx ~103）有相同守卫条件——此处镜像
        msg.attachment.type === 'queued_command' &&
        msg.attachment.commandMode !== 'task-notification' &&
        !msg.attachment.isMeta
      ) {
        const p = msg.attachment.prompt
        // 提示词可能是字符串或文本块数组
        raw =
          typeof p === 'string'
            ? p
            : p.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
      }
      break
    }
    case 'collapsed_read_search': {
      // relevant_memories 附件被折叠进分组（collapseReadSearch.ts）
      // 内容通过 CollapsedReadSearchContent 在对话模式中可见，此处镜像以支持 "/" 搜索
      if (msg.relevantMemories) {
        raw = msg.relevantMemories.map(m => m.content).join('\n')
      }
      break
    }
    default:
      // grouped_tool_use、system 等类型无可搜索文本内容
      break
  }

  // 剥离所有 <system-reminder> 块（仅用于 Claude 上下文，不对用户展示）
  // mid-message 提醒会出现在 cc -c 恢复时（记忆提醒嵌入提示行之间）
  let t = raw
  let open = t.indexOf('<system-reminder>')
  while (open >= 0) {
    const close = t.indexOf(SYSTEM_REMINDER_CLOSE, open)
    if (close < 0) break // 未找到闭合标签，停止剥离
    // 移除从 <system-reminder> 到 </system-reminder> 的整段内容
    t = t.slice(0, open) + t.slice(close + SYSTEM_REMINDER_CLOSE.length)
    // 继续查找下一个 <system-reminder>
    open = t.indexOf('<system-reminder>')
  }
  return t
}

/**
 * 提取工具调用输入的可搜索文本（鸭子类型，仅提取 UI 可见字段）。
 *
 * renderToolUseMessage 通常展示：
 *   command（Bash）、pattern（Grep）、file_path（Read/Edit）、prompt（Agent）等。
 * 同样采用"已知字段白名单"策略——漏报优于幽灵匹配。
 *
 * @param input 工具调用的输入对象（任意类型）
 * @returns 拼接后的可搜索字符串
 */
export function toolUseSearchText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const parts: string[] = []
  // renderToolUseMessage 通常将这些字段作为主要参数展示
  // tool_name 本身出现在 "⏺ Bash(...)" 的外框中，未索引（漏报）
  for (const k of [
    'command',   // Bash
    'pattern',   // Grep
    'file_path', // Read/Edit
    'path',      // 通用路径
    'prompt',    // Agent
    'description',
    'query',
    'url',
    'skill', // SkillTool
  ]) {
    const v = o[k]
    if (typeof v === 'string') parts.push(v)
  }
  // args[]（Tmux/TungstenTool）、files[]（SendUserFile）——
  // 工具调用展示时以 join 形式显示数组。漏报优于跳过。
  for (const k of ['args', 'files']) {
    const v = o[k]
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      parts.push((v as string[]).join(' '))
    }
  }
  return parts.join('\n')
}

/**
 * 从工具调用的原生输出（Out）中提取可搜索文本（鸭子类型）。
 *
 * 已知输出形状：
 *   {stdout, stderr}（Bash/Shell）
 *   {content}（Grep）
 *   {file: {content}}（Read）
 *   {filenames: []}（Grep/Glob）
 *   {output}（通用）
 * 回退策略：提取白名单字段的字符串值，数组字段换行连接。
 * 未知形状索引为空——漏报优于幽灵匹配。
 *
 * @param r 工具调用的原生输出（任意类型）
 * @returns 拼接后的可搜索字符串
 */
export function toolResultSearchText(r: unknown): string {
  // 非对象：若为字符串直接返回，否则返回空字符串
  if (!r || typeof r !== 'object') return typeof r === 'string' ? r : ''
  const o = r as Record<string, unknown>

  // 优先匹配已知高频工具形状
  if (typeof o.stdout === 'string') {
    // Bash/Shell：stdout 加可选的 stderr
    const err = typeof o.stderr === 'string' ? o.stderr : ''
    return o.stdout + (err ? '\n' + err : '')
  }
  if (
    o.file &&
    typeof o.file === 'object' &&
    typeof (o.file as { content?: unknown }).content === 'string'
  ) {
    // Read 工具：file.content 为文件内容
    return (o.file as { content: string }).content
  }

  // 已知输出字段白名单（仅索引 UI 实际渲染的字段）
  // 盲目遍历所有字段会索引元数据（rawOutputPath、backgroundTaskId、durationMs 等），
  // 这些字段 UI 并不展示，会产生幽灵匹配。
  const parts: string[] = []
  for (const k of ['content', 'output', 'result', 'text', 'message']) {
    const v = o[k]
    if (typeof v === 'string') parts.push(v)
  }
  // 数组字段：换行连接
  for (const k of ['filenames', 'lines', 'results']) {
    const v = o[k]
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      parts.push((v as string[]).join('\n'))
    }
  }
  return parts.join('\n')
}
