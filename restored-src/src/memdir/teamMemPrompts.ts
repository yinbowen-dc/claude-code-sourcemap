/**
 * 【文件定位】teamMemPrompts.ts — 记忆系统提示词构建层
 *
 * 在 Claude Code 系统流程中的位置：
 *   记忆子系统（memdir/）→ 提示词生成 → 注入 system prompt
 *
 * 主要职责：
 *   当用户同时启用「自动记忆（auto memory）」与「团队记忆（team memory）」时，
 *   本文件负责将两套存储目录的使用规范、保存规则、访问时机等内容拼装成
 *   一段完整的 Markdown 提示文本，最终插入到模型的系统提示中，
 *   指导模型正确地读写私人记忆与团队共享记忆。
 */

import {
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from './memdir.js'
import {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
} from './memoryTypes.js'
import { getAutoMemPath } from './paths.js'
import { getTeamMemPath } from './teamMemPaths.js'

/**
 * 构建同时启用自动记忆与团队记忆时所需的完整提示词字符串。
 *
 * 整体流程：
 *   1. 获取私人记忆目录（autoDir）与团队记忆目录（teamDir）的路径
 *   2. 根据 skipIndex 参数决定是否包含「两步保存」的索引文件操作说明
 *   3. 将记忆作用域、类型分类、禁止保存规则、访问时机、与其他持久化机制的关系等内容
 *      拼装成一个字符串数组 lines
 *   4. 以换行符连接后返回最终的提示词文本
 *
 * @param extraGuidelines - 调用方可追加的额外指导规则（可选）
 * @param skipIndex       - 为 true 时省略索引文件（MEMORY.md）更新说明，
 *                          适用于不支持/不需要索引的场景
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  // 获取运行时两个记忆目录的绝对路径
  const autoDir = getAutoMemPath()   // 私人记忆目录（当前用户独享）
  const teamDir = getTeamMemPath()   // 团队共享记忆目录

  // 根据是否需要维护索引文件来决定「如何保存记忆」章节的内容
  // skipIndex=true：单步写文件即可（无需更新 MEMORY.md 索引）
  // skipIndex=false：两步操作——先写记忆文件，再将指针追加到对应目录的 MEMORY.md 索引
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        "Write each memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,  // 注入 frontmatter 格式示例
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        "**Step 1** — write the memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,  // 注入 frontmatter 格式示例
        '',
        // 第二步：更新对应目录的索引文件（MEMORY.md），添加指向新记忆文件的指针
        `**Step 2** — add a pointer to that file in the same directory's \`${ENTRYPOINT_NAME}\`. Each directory (private and team) has its own \`${ENTRYPOINT_NAME}\` index — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. They have no frontmatter. Never write memory content directly into a \`${ENTRYPOINT_NAME}\`.`,
        '',
        // 提醒模型：索引文件会被截断，超出行数的内容不会进入上下文
        `- Both \`${ENTRYPOINT_NAME}\` indexes are loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep them concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  // 按章节顺序构建完整提示词行数组
  const lines = [
    '# Memory',
    '',
    // 说明私人目录与团队目录的路径，以及目录已存在的引导说明
    `You have a persistent, file-based memory system with two directories: a private directory at \`${autoDir}\` and a shared team directory at \`${teamDir}\`. ${DIRS_EXIST_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Memory scope',
    '',
    'There are two scope levels:',
    '',
    // 明确 private 与 team 两种作用域的存储路径和可见范围
    `- private: memories that are private between you and the current user. They persist across conversations with only this specific user and are stored at the root \`${autoDir}\`.`,
    `- team: memories that are shared with and contributed by all of the users who work within this project directory. Team memories are synced at the beginning of every session and they are stored at \`${teamDir}\`.`,
    '',
    ...TYPES_SECTION_COMBINED,           // 注入记忆类型（user/feedback/project/reference）分类说明
    ...WHAT_NOT_TO_SAVE_SECTION,         // 注入不应保存的内容说明
    '- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.',
    '',
    ...howToSave,                        // 注入根据 skipIndex 生成的保存操作说明
    '',
    '## When to access memories',
    '- When memories (personal or team) seem relevant, or the user references prior work with them or others in their organization.',
    '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
    '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
    MEMORY_DRIFT_CAVEAT,  // 记忆漂移警告：文件可能被外部修改，不要盲目信任
    '',
    ...TRUSTING_RECALL_SECTION,          // 注入记忆可信度说明
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    ...(extraGuidelines ?? []),          // 追加调用方传入的额外规则（若有）
    '',
    ...buildSearchingPastContextSection(autoDir),  // 注入「如何检索历史上下文」指引
  ]

  // 将所有行以换行符连接，返回最终完整提示文本
  return lines.join('\n')
}
