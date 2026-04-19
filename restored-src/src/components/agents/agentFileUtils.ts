/**
 * agentFileUtils.ts — Agent 文件系统工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Agent 持久化层的核心工具模块，位于 src/components/agents/ 目录下。
 * 它被 AgentEditor（编辑）、CreateAgentWizard（创建）等组件调用，
 * 负责将内存中的 AgentDefinition 序列化为磁盘上的 Markdown 文件，
 * 以及对 Agent 文件进行增删改查操作。
 *
 * 【主要功能】
 * 1. formatAgentAsMarkdown — 将 Agent 属性序列化为带 YAML frontmatter 的 Markdown 格式
 * 2. 路径计算工具 — 根据 SettingSource 计算 Agent 文件的绝对/相对路径
 * 3. saveAgentToFile — 创建新 Agent 文件（使用 wx 标志防止覆盖已存在文件）
 * 4. updateAgentFile — 更新已有 Agent 文件（使用 w 标志覆盖写入）
 * 5. deleteAgentFromFile — 删除 Agent 文件（忽略 ENOENT 错误）
 * 6. writeFileAndFlush — 底层写入工具，调用 datasync 确保数据持久化到磁盘
 */
import { mkdir, open, unlink } from 'fs/promises'
import { join } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getManagedFilePath } from 'src/utils/settings/managedPath.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  isPluginAgent,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import type { EffortValue } from '../../utils/effort.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { AGENT_PATHS } from './types.js'

/**
 * formatAgentAsMarkdown — 将 Agent 定义序列化为 Markdown 文件内容
 *
 * 流程：
 * 1. 对 whenToUse 字符串进行 YAML 转义（依次转义反斜杠、双引号、换行符）
 * 2. 根据各可选字段是否有值，生成对应的 YAML 行（空值则为空字符串）
 * 3. 拼接为标准 YAML frontmatter 格式，并将 systemPrompt 作为正文追加
 *
 * 注意：tools 为 undefined 或 ['*']（所有工具）时，不写入 tools 行
 */
export function formatAgentAsMarkdown(
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): string {
  // YAML 双引号字符串转义：
  // 步骤1：先转义反斜杠（必须首先处理，否则后续替换会二次转义）
  // 步骤2：转义双引号
  // 步骤3：将换行符转为 \\n（YAML 中保留字面量 \n，而非实际换行）
  const escapedWhenToUse = whenToUse
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\n/g, '\\\\n') // Escape newlines as \\n so yaml preserves them as \n

  // 当 tools 为 undefined 或仅包含通配符 '*' 时，视为允许所有工具，不写入 tools 行
  const isAllTools =
    tools === undefined || (tools.length === 1 && tools[0] === '*')
  const toolsLine = isAllTools ? '' : `\ntools: ${tools.join(', ')}`
  // 可选字段：仅在有值时生成对应的 YAML 行
  const modelLine = model ? `\nmodel: ${model}` : ''
  const effortLine = effort !== undefined ? `\neffort: ${effort}` : ''
  const colorLine = color ? `\ncolor: ${color}` : ''
  const memoryLine = memory ? `\nmemory: ${memory}` : ''

  // 拼接最终的 Markdown 内容：YAML frontmatter（---包裹）+ 空行 + 正文
  return `---
name: ${agentType}
description: "${escapedWhenToUse}"${toolsLine}${modelLine}${effortLine}${colorLine}${memoryLine}
---

${systemPrompt}
`
}

/**
 * getAgentDirectoryPath — 根据 SettingSource 获取 Agent 文件目录的绝对路径
 *
 * 映射关系：
 * - flagSettings：不支持，抛出错误（CLI 参数 Agent 无目录概念）
 * - userSettings：~/.claude/agents/（用户个人目录）
 * - projectSettings：{cwd}/.claude/agents/（项目目录）
 * - policySettings：{managedFilePath}/.claude/agents/（策略管理目录）
 * - localSettings：{cwd}/.claude/agents/（与 projectSettings 相同）
 */
function getAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'flagSettings':
      // flagSettings 类型的 Agent 来自 CLI 参数，无对应目录
      throw new Error(`Cannot get directory path for ${location} agents`)
    case 'userSettings':
      // 用户级 Agent 存储在用户 Claude 配置目录下的 agents 子目录
      return join(getClaudeConfigHomeDir(), AGENT_PATHS.AGENTS_DIR)
    case 'projectSettings':
      // 项目级 Agent 存储在当前工作目录下的 .claude/agents/ 目录
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    case 'policySettings':
      // 策略管理级 Agent 存储在受管理文件路径下的 .claude/agents/ 目录
      return join(
        getManagedFilePath(),
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
    case 'localSettings':
      // 本地设置与项目设置共享相同目录
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
  }
}

/**
 * getRelativeAgentDirectoryPath — 获取 Agent 目录的相对路径（用于界面显示）
 *
 * projectSettings 使用相对路径（./.claude/agents/），其余来源使用绝对路径
 */
function getRelativeAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'projectSettings':
      // 项目路径显示为相对路径，方便用户理解位置
      return join('.', AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    default:
      // 其他来源直接使用绝对路径
      return getAgentDirectoryPath(location)
  }
}

/**
 * getNewAgentFilePath — 获取新 Agent 文件的绝对路径
 *
 * 根据 source 和 agentType 生成新文件路径，用于创建 Agent 时确定写入位置
 * 文件名格式：{agentType}.md
 */
export function getNewAgentFilePath(agent: {
  source: SettingSource
  agentType: string
}): string {
  const dirPath = getAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * getActualAgentFilePath — 获取已有 Agent 文件的实际绝对路径
 *
 * 与 getNewAgentFilePath 的区别：
 * 已有 Agent 可能存在文件名（filename）与 agentType 不一致的情况，
 * 本函数优先使用 agent.filename，确保能正确定位已存在的文件。
 *
 * 特殊处理：
 * - built-in Agent：返回字符串 'Built-in'（无实际文件路径）
 * - plugin Agent：抛出错误（插件 Agent 无可编辑的文件路径）
 */
export function getActualAgentFilePath(agent: AgentDefinition): string {
  if (agent.source === 'built-in') {
    // 内置 Agent 没有磁盘文件，返回占位字符串
    return 'Built-in'
  }
  if (agent.source === 'plugin') {
    throw new Error('Cannot get file path for plugin agents')
  }

  const dirPath = getAgentDirectoryPath(agent.source)
  // 优先使用 filename（实际磁盘文件名），其次使用 agentType
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * getNewRelativeAgentFilePath — 获取新 Agent 文件的相对路径（用于界面显示）
 *
 * 用于向用户展示新 Agent 将被创建在哪里，
 * 内置 Agent 显示 'Built-in'，其他来源显示相对路径。
 */
export function getNewRelativeAgentFilePath(agent: {
  source: SettingSource | 'built-in'
  agentType: string
}): string {
  if (agent.source === 'built-in') {
    return 'Built-in'
  }
  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * getActualRelativeAgentFilePath — 获取已有 Agent 文件的实际相对路径（用于界面显示）
 *
 * 处理所有特殊来源：
 * - built-in：返回 'Built-in'
 * - plugin：返回 'Plugin: {pluginName}' 或 'Plugin: Unknown'
 * - flagSettings（CLI 参数）：返回 'CLI argument'
 * - 其他：使用相对路径目录 + (filename || agentType).md
 */
export function getActualRelativeAgentFilePath(agent: AgentDefinition): string {
  if (isBuiltInAgent(agent)) {
    return 'Built-in'
  }
  if (isPluginAgent(agent)) {
    // 插件 Agent 显示插件名，未知插件名时显示 'Unknown'
    return `Plugin: ${agent.plugin || 'Unknown'}`
  }
  if (agent.source === 'flagSettings') {
    // CLI 参数传入的 Agent 显示来源标识
    return 'CLI argument'
  }

  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  // 优先使用 filename 以处理文件名/agentType 不一致的情况
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * ensureAgentDirectoryExists — 确保 Agent 目录存在
 *
 * 使用 mkdir recursive 选项，若目录已存在则不报错，
 * 若不存在则递归创建所有父目录。
 * 返回目录路径供后续使用。
 */
async function ensureAgentDirectoryExists(
  source: SettingSource,
): Promise<string> {
  const dirPath = getAgentDirectoryPath(source)
  // recursive: true 确保父目录不存在时一并创建，且已存在时不抛出 EEXIST 错误
  await mkdir(dirPath, { recursive: true })
  return dirPath
}

/**
 * saveAgentToFile — 将新 Agent 保存到文件系统
 *
 * 流程：
 * 1. 确保 Agent 目录存在（自动创建）
 * 2. 计算新文件路径
 * 3. 将 Agent 数据格式化为 Markdown 内容
 * 4. 使用 writeFileAndFlush 写入（默认使用 wx 标志防止覆盖已存在文件）
 * 5. 若文件已存在（EEXIST），抛出友好的错误信息
 *
 * @param checkExists - 为 true 时（默认），若文件已存在则抛错；为 false 时直接覆盖
 */
export async function saveAgentToFile(
  source: SettingSource | 'built-in',
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  checkExists = true,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): Promise<void> {
  if (source === 'built-in') {
    // 内置 Agent 不可被保存到文件
    throw new Error('Cannot save built-in agents')
  }

  // 确保目录存在
  await ensureAgentDirectoryExists(source)
  const filePath = getNewAgentFilePath({ source, agentType })

  // 序列化 Agent 数据为 Markdown 格式
  const content = formatAgentAsMarkdown(
    agentType,
    whenToUse,
    tools,
    systemPrompt,
    color,
    model,
    memory,
    effort,
  )
  try {
    // checkExists=true 时使用 'wx'（exclusive write），文件已存在则失败
    // checkExists=false 时使用 'w'（普通写），直接覆盖
    await writeFileAndFlush(filePath, content, checkExists ? 'wx' : 'w')
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      // 将底层 EEXIST 错误转换为用户友好的错误信息
      throw new Error(`Agent file already exists: ${filePath}`)
    }
    throw e
  }
}

/**
 * updateAgentFile — 更新已有 Agent 文件的内容
 *
 * 流程：
 * 1. 通过 getActualAgentFilePath 获取 Agent 的实际文件路径（处理 filename/agentType 差异）
 * 2. 将新属性格式化为 Markdown 内容
 * 3. 使用 writeFileAndFlush 覆盖写入（'w' 标志）
 *
 * 注意：保留原有的 whenToUse 和 systemPrompt，只更新传入的字段
 */
export async function updateAgentFile(
  agent: AgentDefinition,
  newWhenToUse: string,
  newTools: string[] | undefined,
  newSystemPrompt: string,
  newColor?: string,
  newModel?: string,
  newMemory?: AgentMemoryScope,
  newEffort?: EffortValue,
): Promise<void> {
  if (agent.source === 'built-in') {
    // 内置 Agent 不可被修改
    throw new Error('Cannot update built-in agents')
  }

  // 使用实际路径（而非基于 agentType 计算的路径）以处理文件名不一致问题
  const filePath = getActualAgentFilePath(agent)

  // 序列化更新后的内容
  const content = formatAgentAsMarkdown(
    agent.agentType,
    newWhenToUse,
    newTools,
    newSystemPrompt,
    newColor,
    newModel,
    newMemory,
    newEffort,
  )

  // 覆盖写入并同步到磁盘
  await writeFileAndFlush(filePath, content)
}

/**
 * deleteAgentFromFile — 删除 Agent 文件
 *
 * 流程：
 * 1. 通过 getActualAgentFilePath 获取文件路径
 * 2. 调用 unlink 删除文件
 * 3. 若文件不存在（ENOENT），静默忽略（幂等操作）；其他错误继续抛出
 */
export async function deleteAgentFromFile(
  agent: AgentDefinition,
): Promise<void> {
  if (agent.source === 'built-in') {
    // 内置 Agent 不可被删除
    throw new Error('Cannot delete built-in agents')
  }

  const filePath = getActualAgentFilePath(agent)

  try {
    await unlink(filePath)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      // 非"文件不存在"的错误（如权限错误）需要继续抛出
      throw e
    }
    // 文件不存在时静默处理，保持操作幂等性
  }
}

/**
 * writeFileAndFlush — 写入文件并调用 datasync 确保数据持久化
 *
 * 流程：
 * 1. 以指定 flag 打开文件（'w' 覆盖写入，'wx' 独占创建）
 * 2. 写入 UTF-8 编码内容
 * 3. 调用 datasync 将数据同步到磁盘（防止系统崩溃导致数据丢失）
 * 4. 在 finally 块中关闭文件句柄（确保不发生文件描述符泄漏）
 *
 * @param flag - 文件打开模式：'w'（覆盖）或 'wx'（独占创建，文件已存在时抛 EEXIST）
 */
async function writeFileAndFlush(
  filePath: string,
  content: string,
  flag: 'w' | 'wx' = 'w',
): Promise<void> {
  // 打开文件句柄，flag 决定是覆盖写入还是独占创建
  const handle = await open(filePath, flag)
  try {
    // 写入 UTF-8 编码内容
    await handle.writeFile(content, { encoding: 'utf-8' })
    // datasync 确保文件数据（但不一定是元数据）已写入磁盘
    await handle.datasync()
  } finally {
    // 无论成功或失败，都必须关闭文件句柄以释放系统资源
    await handle.close()
  }
}
