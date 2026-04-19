/**
 * @file memdir.ts
 * @description 记忆目录模块 — 记忆系统核心协调层
 *
 * 在 Claude Code 系统中，该文件是记忆子系统的主入口，负责：
 * 1. 构建注入系统提示的记忆指导文本（buildMemoryLines / buildMemoryPrompt）
 * 2. 截断超限的 MEMORY.md 入口文件（truncateEntrypointContent）
 * 3. 确保记忆目录存在（ensureMemoryDirExists）
 * 4. 根据功能开关和用户订阅类型，派发正确的记忆提示变体（loadMemoryPrompt）：
 *    - KAIROS 日志模式：追加式日志文件，每日一文
 *    - TEAMMEM 团队模式：私人 + 团队双目录
 *    - 普通 auto 模式：单个自动记忆目录
 *
 * 该文件是记忆系统与主循环系统提示之间的桥梁，
 * 通过 loadMemoryPrompt() 将记忆指导文本插入系统提示，
 * 使模型具备持久化记忆的读写能力。
 */

import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
// TEAMMEM 特性门控：仅在功能启用时加载团队记忆路径模块，避免无谓依赖
const teamMemPaths = feature('TEAMMEM')
  ? (require('./teamMemPaths.js') as typeof import('./teamMemPaths.js'))
  : null

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memoryTypes.js'

/** MEMORY.md 入口文件名（记忆索引文件） */
export const ENTRYPOINT_NAME = 'MEMORY.md'
/** MEMORY.md 最大允许行数，超过此值则截断并附加警告 */
export const MAX_ENTRYPOINT_LINES = 200
// 约 125 字符/行 × 200 行。覆盖 p97 场景；捕获超长行导致的字节超限（p100 实测：197KB、行数<200）
export const MAX_ENTRYPOINT_BYTES = 25_000
/** 自动记忆的显示名称，用于系统提示标题 */
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

/** MEMORY.md 截断结果类型，含内容、行数、字节数及截断原因标志 */
export type EntrypointTruncation = {
  content: string           // 截断后的内容（含警告附注）
  lineCount: number         // 原始行数
  byteCount: number         // 原始字节数
  wasLineTruncated: boolean // 是否因行数超限被截断
  wasByteTruncated: boolean // 是否因字节数超限被截断
}

/**
 * 将 MEMORY.md 原始内容截断至行数上限和字节上限，并追加说明哪个上限触发的警告。
 *
 * 截断策略：
 * 1. 优先按行截断（取前 MAX_ENTRYPOINT_LINES 行），保持自然语义边界
 * 2. 再按字节截断（在 MAX_ENTRYPOINT_BYTES 处回退到最近换行符），避免行中断
 * 3. 截断原因文案根据触发的上限组合动态生成
 *
 * 由 buildMemoryPrompt（代理记忆）和 claudemd 的 getMemoryFiles（系统提示注入）共用，
 * 消除了两处之前重复的纯行截断逻辑。
 *
 * @param raw 原始 MEMORY.md 文件内容
 * @returns   截断结果对象，包含处理后内容和各截断标志
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // 基于原始字节数判断，而非行截断后的字节数：
  // 字节上限的目标是捕获超长行，行截断后字节数会低估警告的必要性
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  // 两个上限均未超过，直接返回原始内容
  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  // 先按行数截断（若需要）
  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  // 再按字节数截断：回退到最近换行符处，避免截断到行中间
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  // 根据触发的上限类型生成对应的警告文案
  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
// TEAMMEM 特性门控：仅在功能启用时加载团队记忆提示模块
const teamMemPrompts = feature('TEAMMEM')
  ? (require('./teamMemPrompts.js') as typeof import('./teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 追加到每个记忆目录提示行的共享指导文本（单目录版本）。
 * 引入原因：模型曾在写入前浪费工具调用轮次执行 `ls`/`mkdir -p`。
 * 由 ensureMemoryDirExists() 保证目录在 loadMemoryPrompt 时已存在。
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
/** 双目录（自动 + 团队）版本的目录已存在指导文本 */
export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/**
 * 确保记忆目录存在（幂等操作）。
 *
 * 由 loadMemoryPrompt 在每次会话首次调用时执行（通过 systemPromptSection 缓存保证每会话一次），
 * 确保模型可以直接写入记忆文件而无需先检查目录是否存在。
 * FsOperations.mkdir 默认递归创建，内部已处理 EEXIST，无需外层 try/catch 处理正常路径。
 *
 * @param memoryDir 记忆目录绝对路径
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir 内部已处理 EEXIST，能到达此处说明是真实错误（EACCES/EPERM/EROFS）
    // 记录日志供 --debug 模式排查，但不中断提示构建流程
    // FileWriteTool 会在实际写入时处理真正的权限错误
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * 异步上报记忆目录的文件数和子目录数遥测事件（fire-and-forget）。
 * 不阻塞系统提示构建流程，失败时仅上报基础元数据（无计数）。
 *
 * @param memoryDir    记忆目录路径
 * @param baseMetadata 基础元数据（如 memory_type），随计数一起上报
 */
function logMemoryDirCounts(
  memoryDir: string,
  baseMetadata: Record<
    string,
    | number
    | boolean
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  >,
): void {
  const fs = getFsImplementation()
  // void 确保 Promise 不被 await，实现 fire-and-forget 语义
  void fs.readdir(memoryDir).then(
    dirents => {
      let fileCount = 0
      let subdirCount = 0
      // 遍历目录条目，统计文件数和子目录数
      for (const d of dirents) {
        if (d.isFile()) {
          fileCount++
        } else if (d.isDirectory()) {
          subdirCount++
        }
      }
      logEvent('tengu_memdir_loaded', {
        ...baseMetadata,
        total_file_count: fileCount,
        total_subdir_count: subdirCount,
      })
    },
    () => {
      // 目录不可读时，仍上报基础元数据，但不含文件计数
      logEvent('tengu_memdir_loaded', baseMetadata)
    },
  )
}

/**
 * 构建记忆类型行为指导文本（不含 MEMORY.md 内容）。
 *
 * 该函数生成约束模型记忆行为的文本块，包含：
 * - 记忆类型分类说明（四类：user/feedback/project/reference）
 * - 不应保存的内容说明
 * - 保存记忆的操作步骤（两步：写文件 + 更新索引，或仅写文件）
 * - 访问记忆的时机说明
 * - 记忆信任与验证指导
 * - 搜索历史上下文的方法
 *
 * skipIndex=true 时跳过"更新 MEMORY.md 索引"步骤，适用于无需维护索引的场景。
 * 个人模式版本：无 `## Memory scope` 节，无 <scope> 标签，示例去除 team/private 修饰。
 *
 * 同时被 buildMemoryPrompt（代理记忆，含内容）和 loadMemoryPrompt（系统提示，内容另行注入）使用。
 *
 * @param displayName     显示在系统提示标题中的记忆名称
 * @param memoryDir       记忆目录绝对路径
 * @param extraGuidelines 额外的指导行（如 Cowork 注入的协作政策）
 * @param skipIndex       是否跳过 MEMORY.md 索引维护步骤
 * @returns               记忆指导文本行数组
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  // 根据 skipIndex 选择单步（仅写文件）或双步（写文件+更新索引）保存说明
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
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
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
        '',
        `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  // 组装完整的记忆指导文本行，顺序固定以优化提示缓存命中率
  const lines: string[] = [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...TYPES_SECTION_INDIVIDUAL,      // 记忆类型分类说明（个人模式）
    ...WHAT_NOT_TO_SAVE_SECTION,      // 不应保存的内容说明
    '',
    ...howToSave,                     // 保存记忆的操作步骤
    '',
    ...WHEN_TO_ACCESS_SECTION,        // 访问记忆的时机说明
    '',
    ...TRUSTING_RECALL_SECTION,       // 记忆信任与验证指导
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    ...(extraGuidelines ?? []),       // 可选的额外指导行（如 Cowork 协作政策）
    '',
  ]

  // 追加搜索历史上下文的方法说明（由功能开关控制是否包含）
  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * 构建包含 MEMORY.md 内容的完整记忆提示文本。
 * 适用于代理记忆场景（无 getClaudeMds() 等效机制，需直接嵌入内容）。
 *
 * 流程：
 * 1. 同步读取 MEMORY.md 入口文件（系统提示构建为同步流程）
 * 2. 调用 buildMemoryLines 获取记忆指导文本行
 * 3. 若 MEMORY.md 有内容，截断后附加到指导文本末尾，并上报遥测
 * 4. 若 MEMORY.md 为空，追加空索引提示文本
 *
 * @param params.displayName     显示在系统提示标题中的记忆名称
 * @param params.memoryDir       记忆目录绝对路径（含尾部分隔符）
 * @param params.extraGuidelines 额外的指导行
 * @returns 完整的记忆提示文本字符串
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // 目录创建由调用方负责（loadMemoryPrompt/loadAgentMemoryPrompt）
  // 构建函数只读取文件，不创建目录

  // 同步读取 MEMORY.md（系统提示构建为同步流程）
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // MEMORY.md 尚不存在时忽略错误，后续以空内容处理
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    // MEMORY.md 有内容：截断并上报遥测数据
    const t = truncateEntrypointContent(entrypointContent)
    const memoryType = displayName === AUTO_MEM_DISPLAY_NAME ? 'auto' : 'agent'
    logMemoryDirCounts(memoryDir, {
      content_length: t.byteCount,
      line_count: t.lineCount,
      was_truncated: t.wasLineTruncated,
      was_byte_truncated: t.wasByteTruncated,
      memory_type:
        memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content) // 将截断后的内容追加到提示末尾
  } else {
    // MEMORY.md 为空（首次使用）：提示模型尚无记忆，等待后续保存
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

/**
 * 构建助手模式（KAIROS）的每日日志记忆提示文本。
 * 仅在 feature('KAIROS') 启用时使用。
 *
 * 与普通记忆系统的区别：
 * - 助手会话是长期存活的（perpetual），不维护实时 MEMORY.md 索引
 * - 每次工作时追加写入按日期命名的日志文件（YYYY-MM-DD.md）
 * - 独立的夜间 /dream 技能将日志提炼为主题文件和 MEMORY.md 索引
 * - MEMORY.md 仍通过 claudemd.ts 加载到上下文，但本提示改变新记忆的写入位置
 *
 * 日志路径以模式字符串（YYYY/MM/YYYY-MM-DD.md）描述，而非内联今日实际路径：
 * 本提示由 systemPromptSection('memory', ...) 缓存，不随日期变化失效，
 * 模型从 date_change 附件（午夜滚动时追加到对话末尾）获取当前日期。
 *
 * @param skipIndex 是否跳过 MEMORY.md 索引说明节
 * @returns 日志模式记忆提示文本字符串
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  // 以模式描述路径，而非内联今日实际路径，保持提示缓存前缀稳定
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system found at: \`${memoryDir}\``,
    '',
    "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file:",
    '',
    `\`${logPathPattern}\``,
    '',
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    '',
    'Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.',
    '',
    '## What to log',
    '- User corrections and preferences ("use bun, not npm"; "stop summarizing diffs")',
    '- Facts about the user, their role, or their goals',
    '- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)',
    '- Pointers to external systems (dashboards, Linear projects, Slack channels)',
    '- Anything the user explicitly asks you to remember',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION, // 不应保存的内容说明（与普通模式共用）
    '',
    ...(skipIndex
      ? []
      : [
          // 说明 MEMORY.md 是夜间提炼的索引，日志模式下不直接编辑
          `## ${ENTRYPOINT_NAME}`,
          `\`${ENTRYPOINT_NAME}\` is the distilled index (maintained nightly from your logs) and is loaded into your context automatically. Read it for orientation, but do not edit it directly — record new information in today's log instead.`,
          '',
        ]),
    ...buildSearchingPastContextSection(memoryDir), // 搜索历史上下文的方法说明
  ]

  return lines.join('\n')
}

/**
 * 构建"搜索历史上下文"指导节（由功能开关 tengu_coral_fern 控制）。
 *
 * 根据运行环境选择合适的搜索命令形式：
 * - 原生内嵌工具或 REPL 模式：使用 grep shell 命令（写入 REPL 脚本）
 * - 普通模式：使用 Grep 工具调用格式
 *
 * @param autoMemDir 自动记忆目录路径，用于构建记忆文件搜索命令
 * @returns 指导文本行数组，功能开关未启用时返回空数组
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  // 功能开关未启用时不包含此节，保持提示简洁
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // 原生内嵌构建将 grep 别名为内嵌 ugrep 并移除专用 Grep 工具；
  // REPL 模式下 Grep 和 Bash 对模型不可见，模型在 REPL 脚本中调用 grep shell 命令
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  // 记忆文件搜索命令（仅限 .md 文件）
  const memSearch = embedded
    ? `grep -rn "<search term>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${autoMemDir}" glob="*.md"`
  // 会话记录搜索命令（.jsonl 格式，文件较大，仅作最后手段）
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your memory directory:',
    '```',
    memSearch,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}

/**
 * 加载统一的记忆提示文本，注入到系统提示中。
 *
 * 根据已启用的记忆子系统进行派发（优先级从高到低）：
 * 1. KAIROS + autoEnabled + kairosActive → 每日日志模式（助手长会话）
 * 2. TEAMMEM + isTeamMemoryEnabled → 团队+私人双目录组合提示
 * 3. autoEnabled → 单个自动记忆目录提示
 * 4. 均未启用 → 上报禁用遥测，返回 null
 *
 * 注意：KAIROS 优先于 TEAMMEM，因为追加式日志范式与团队同步（需要共享 MEMORY.md）不兼容。
 *
 * @returns 记忆提示文本字符串，或 null（自动记忆已禁用时）
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  // 读取功能开关：tengu_moth_copse 启用时跳过 MEMORY.md 索引维护步骤
  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )

  // KAIROS 日志模式优先于 TEAMMEM：
  // 追加式日志范式与团队同步不兼容（团队同步需要双方都能读写共享 MEMORY.md）
  // 此处对 autoEnabled 加门控：!autoEnabled 时落入下方 tengu_memdir_disabled 遥测分支，
  // 与非 KAIROS 路径行为一致
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    logMemoryDirCounts(getAutoMemPath(), {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // 读取 Cowork 注入的额外记忆政策文本（通过环境变量传入）
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  // TEAMMEM 团队记忆模式：自动目录 + 团队目录双写
  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths!.getTeamMemPath()
      // 确保团队目录存在（递归 mkdir，自动目录作为父目录同时被创建）
      // 若团队目录未来移出自动目录下级，需额外调用 ensureMemoryDirExists(autoDir)
      await ensureMemoryDirExists(teamDir)
      // 分别上报自动目录和团队目录的文件计数遥测
      logMemoryDirCounts(autoDir, {
        memory_type:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logMemoryDirCounts(teamDir, {
        memory_type:
          'team' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // 构建并返回团队+私人双目录组合提示
      return teamMemPrompts!.buildCombinedMemoryPrompt(
        extraGuidelines,
        skipIndex,
      )
    }
  }

  // 普通 auto 记忆模式：单个自动记忆目录
  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // 确保目录存在，使模型可直接写入无需检查
    await ensureMemoryDirExists(autoDir)
    logMemoryDirCounts(autoDir, {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    // 返回记忆指导文本（内容由 claudemd 注入，此处仅返回指导行）
    return buildMemoryLines(
      'auto memory',
      autoDir,
      extraGuidelines,
      skipIndex,
    ).join('\n')
  }

  // 自动记忆已禁用：上报禁用遥测，返回 null
  logEvent('tengu_memdir_disabled', {
    disabled_by_env_var: isEnvTruthy(
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ),
    // 仅当非环境变量禁用时，检查 settings 中的显式禁用配置
    disabled_by_setting:
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) &&
      getInitialSettings().autoMemoryEnabled === false,
  })
  // 直接检查 GB 功能开关，而非 isTeamMemoryEnabled()：
  // 该函数首先检查 isAutoMemoryEnabled()，而此分支定义上 autoEnabled 为 false
  // 目的是判断"用户是否在团队记忆队列中"，而非"是否实际启用"
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)) {
    logEvent('tengu_team_memdir_disabled', {})
  }
  return null
}
