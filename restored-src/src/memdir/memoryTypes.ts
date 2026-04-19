/**
 * @file memoryTypes.ts
 * @description 记忆目录模块 — 记忆类型分类与系统提示文本定义
 *
 * 在 Claude Code 记忆系统中，该文件扮演两个核心角色：
 *
 * 1. 类型系统：定义记忆的四种分类（user/feedback/project/reference），
 *    以及从 frontmatter 原始值解析为强类型的工具函数。
 *
 * 2. 系统提示文本库：以只读数组常量的形式预先生成记忆行为指导文本块，
 *    包括类型说明（个人模式/团队模式两种变体）、不应保存的内容、
 *    访问时机、信任与验证指导、frontmatter 格式示例等。
 *    这些常量被 memdir.ts 和 teamMemPrompts.ts 组合拼接为最终系统提示。
 *
 * 设计决策：两套 TYPES_SECTION 故意保持扁平化重复，而非从共享规范动态生成，
 * 以便针对各模式进行独立编辑，无需推理生成器的条件逻辑。
 *
 * 被以下模块导入：memdir.ts、memoryScan.ts、teamMemPrompts.ts。
 */

/**
 * 所有合法的记忆类型值（常量元组，用于派生 MemoryType 联合类型）。
 * 记忆类型约束记忆内容为不可从当前项目状态直接推导的信息：
 * - user：用户角色、偏好、目标
 * - feedback：用户对工作方式的指导（纠正和确认）
 * - project：项目上下文（进行中的工作、目标、事故）
 * - reference：外部系统的资源指针
 *
 * 代码模式、架构、git 历史、文件结构等均可通过 grep/git/CLAUDE.md 推导，
 * 不应保存为记忆。
 */
export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

/** 记忆类型联合类型，从 MEMORY_TYPES 常量元组派生 */
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * 将 frontmatter 中的原始 type 值解析为强类型的 MemoryType。
 *
 * 容错设计：
 * - 非字符串值（undefined、数字等）返回 undefined
 * - 不在 MEMORY_TYPES 中的字符串（如拼写错误）返回 undefined
 * - 旧版无 type 字段的文件正常工作（undefined 降级）
 * - 未知类型的文件优雅降级，不影响扫描和筛选
 *
 * @param raw frontmatter 对象中 type 字段的原始值（类型未知）
 * @returns   合法的 MemoryType，或 undefined（无效/缺失时）
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined       // 非字符串直接返回 undefined
  return MEMORY_TYPES.find(t => t === raw)            // 精确匹配，避免子串误判
}

/**
 * 团队+私人组合模式（COMBINED）的 `## Types of memory` 文本节。
 * 包含 <scope> 标签和 team/private 限定词，适用于双目录场景。
 * 每种类型均说明应写入私人目录还是团队目录，以及判断依据。
 */
export const TYPES_SECTION_COMBINED: readonly string[] = [
  '## Types of memory',
  '',
  'There are several discrete types of memory that you can store in your memory system. Each type below declares a <scope> of `private`, `team`, or guidance for choosing between the two.',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  '    <scope>always private</scope>',
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  '    <examples>',
  "    user: I'm a data scientist investigating what logging we have in place",
  '    assistant: [saves private user memory: user is a data scientist, currently focused on observability/logging]',
  '',
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves private user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <scope>default to private. Save as team only when the guidance is clearly a project-wide convention that every contributor should follow (e.g., a testing policy, a build invariant), not a personal style preference.</scope>',
  "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious. Before saving a private feedback memory, check that it doesn't contradict a team feedback memory — if it does, either don't save it or note the override explicitly.</description>",
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  '    <how_to_use>Let these memories guide your behavior so that the user and other users in the project do not need to offer the same guidance twice.</how_to_use>',
  '    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>',
  '    <examples>',
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  '    assistant: [saves team feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration. Team scope: this is a project testing policy, not a personal preference]',
  '',
  '    user: stop summarizing what you just did at the end of every response, I can read the diff',
  "    assistant: [saves private feedback memory: this user wants terse responses with no trailing summaries. Private because it's a communication preference, not a project convention]",
  '',
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  '    assistant: [saves private feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <scope>private or team, but strongly bias toward team</scope>',
  '    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work users are working on within this working directory.</description>',
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request, anticipate coordination issues across users, make better informed suggestions.</how_to_use>",
  '    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>',
  '    <examples>',
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  '    assistant: [saves team project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]',
  '',
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  '    assistant: [saves team project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <scope>usually team</scope>',
  '    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>',
  '    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>',
  '    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>',
  '    <examples>',
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves team reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  '',
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
  '    assistant: [saves team reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]',
  '    </examples>',
  '</type>',
  '</types>',
  '',
]

/**
 * 个人模式（INDIVIDUAL）的 `## Types of memory` 文本节。
 * 无 <scope> 标签，示例使用无修饰的 `[saves X memory: …]` 格式。
 * 仅涉及个人/单目录场景的描述措辞，去除 team/private 分裂逻辑。
 */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  '## Types of memory',
  '',
  'There are several discrete types of memory that you can store in your memory system:',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  '    <examples>',
  "    user: I'm a data scientist investigating what logging we have in place",
  '    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]',
  '',
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>',
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  '    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>',
  '    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>',
  '    <examples>',
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  '    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]',
  '',
  '    user: stop summarizing what you just did at the end of every response, I can read the diff',
  '    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]',
  '',
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  '    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>',
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
  '    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>',
  '    <examples>',
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  '    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]',
  '',
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  '    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]',
  '    </examples>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>',
  '    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>',
  '    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>',
  '    <examples>',
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  '',
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
  '    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]',
  '    </examples>',
  '</type>',
  '</types>',
  '',
]

/**
 * `## What NOT to save in memory` 文本节（两种模式共用，内容完全相同）。
 *
 * 明确列出不应保存为记忆的内容类型，防止模型将可从代码/git 直接推导的信息
 * 存入记忆文件（这类信息会随代码更新而过时，产生陈旧记忆噪音）。
 *
 * 末尾特别说明：即使用户显式要求保存，这些排除规则仍然适用；
 * 若用户要求保存 PR 列表或活动摘要，应引导其聚焦"令人惊讶或非显而易见"的部分。
 * 此规则经过评测验证（memory-prompt-iteration case 3，0/2 → 3/3）。
 */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in CLAUDE.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  // H2: 显式保存门控。评测验证（memory-prompt-iteration case 3，0/2→3/3）：
  // 防止"保存本周 PR 列表"→活动日志噪音
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
]

/**
 * 记忆内容漂移免责声明：提醒模型在基于记忆回答前验证当前状态。
 * 作为 `## When to access memories` 节中的一个独立条目使用。
 */
export const MEMORY_DRIFT_CAVEAT =
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.'

/**
 * `## When to access memories` 文本节，包含 MEMORY_DRIFT_CAVEAT。
 *
 * H6 说明（分支污染评测 #22856，case 5，capy 上 1/3）：
 * 新增"ignore"条目是差异所在。失败模式：用户说"ignore memory about X"
 * → Claude 正确读取代码但追加"not Y as noted in memory"——
 * 将"ignore"视为"确认后覆盖"而非"完全不引用"。此条目明确命名该反模式。
 *
 * Token 预算（H6a）：合并旧条目 1+2，精简措辞。
 * 旧 4 行约 70 token；新 4 行约 73 token，净增约 +3。
 */
export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  // 显式处理"ignore memory"指令：应完全不引用，而非"确认后覆盖"
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
  MEMORY_DRIFT_CAVEAT, // 记忆漂移免责声明，提醒验证当前状态
]

/**
 * `## Before recommending from memory` 文本节（重量级记忆信任指导）。
 *
 * 与 WHEN_TO_ACCESS_SECTION 的区别：
 * - WHEN_TO_ACCESS：何时查看记忆（访问时机）
 * - TRUSTING_RECALL：如何对待已召回的记忆内容（使用方式）
 *
 * 评测验证（memory-prompt-iteration.eval.ts，2026-03-17）：
 * - H1（验证函数/文件声明）：0/2 → 3/3（通过 appendSystemPrompt）；
 *   作为"When to access"的条目时降至 0/3 ——
 *   位置很关键：H1 是关于"如何使用记忆"，需要独立的节级触发上下文
 * - H5（读取侧噪音拒绝）：0/2 → 3/3（appendSystemPrompt），2/3（原位条目）
 *
 * 已知缺口：H1 不覆盖 slash 命令声明（/fork case 上 0/3 ——
 * slash 命令在模型认知中不属于文件或函数）。
 *
 * 标题措辞说明：
 * "Before recommending"（行动提示，在决策点触发）比
 * "Trusting what you recall"（抽象描述）测试结果更好（3/3 vs 0/3）。
 * 相同正文，仅标题不同。
 */
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',        // 文件路径：验证文件是否仍存在
  '- If the memory names a function or flag: grep for it.',            // 函数/标志：grep 验证是否仍存在
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',    // 核心提醒：记忆≠当前事实
  '',
  // 摘要类记忆（架构快照、活动日志）是时间点冻结，不代表当前状态
  'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
]

/**
 * frontmatter 格式示例（包含 type 字段），供记忆保存指导中展示给模型参考。
 * 格式：代码块 → frontmatter 头 → 内容模板（含 Why/How to apply 结构提示）。
 */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`, // 动态列出所有合法类型，保持与 MEMORY_TYPES 同步
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
]
