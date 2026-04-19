/**
 * Agent 内存快照模块
 *
 * 在 Claude Code 工具层中，该模块负责管理子 Agent 内存的快照同步机制。
 * 允许项目通过版本控制提供"种子内存"快照，Agent 在首次运行时
 * 或检测到快照更新时，自动将快照内容同步到本地内存目录。
 *
 * 快照目录结构（存放于项目 .claude/ 下）：
 * - <cwd>/.claude/agent-memory-snapshots/<agentType>/snapshot.json  ← 快照元数据（含时间戳）
 * - <cwd>/.claude/agent-memory-snapshots/<agentType>/*.md           ← 快照内存文件
 *
 * 同步状态文件（存放于 Agent 内存目录下）：
 * - <agentMemoryDir>/.snapshot-synced.json  ← 记录上次同步时的快照时间戳
 *
 * 同步生命周期：
 * 1. checkAgentMemorySnapshot  — 检测是否需要同步（无快照 / 首次初始化 / 有更新）
 * 2. initializeFromSnapshot    — 首次初始化：复制快照文件到本地内存目录
 * 3. replaceFromSnapshot       — 更新替换：先清理旧 .md 文件，再复制快照
 * 4. markSnapshotSynced        — 更新同步标记：仅更新 .snapshot-synced.json
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

// 快照目录基础名称，位于 <cwd>/.claude/ 下
const SNAPSHOT_BASE = 'agent-memory-snapshots'
// 快照元数据文件名，包含 updatedAt 时间戳
const SNAPSHOT_JSON = 'snapshot.json'
// 同步状态文件名，记录上次同步时的快照时间戳
const SYNCED_JSON = '.snapshot-synced.json'

// 快照元数据 schema：仅包含 updatedAt 时间戳字符串
const snapshotMetaSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().min(1), // ISO 时间戳，非空
  }),
)

// 同步状态 schema：记录上次同步来源的快照时间戳
const syncedMetaSchema = lazySchema(() =>
  z.object({
    syncedFrom: z.string().min(1), // 上次同步时的快照 updatedAt，非空
  }),
)
// 同步状态的 TypeScript 类型
type SyncedMeta = z.infer<ReturnType<typeof syncedMetaSchema>>

/**
 * 获取当前项目中指定 Agent 的快照目录路径。
 *
 * 快照目录由项目方维护，存放于版本控制中，作为 Agent 内存的"种子"数据。
 *
 * @param agentType Agent 类型名称
 * @returns 快照目录的绝对路径，格式：<cwd>/.claude/agent-memory-snapshots/<agentType>/
 */
export function getSnapshotDirForAgent(agentType: string): string {
  return join(getCwd(), '.claude', SNAPSHOT_BASE, agentType)
}

/**
 * 获取快照元数据文件（snapshot.json）的完整路径。
 *
 * @param agentType Agent 类型名称
 * @returns snapshot.json 的绝对路径
 */
function getSnapshotJsonPath(agentType: string): string {
  return join(getSnapshotDirForAgent(agentType), SNAPSHOT_JSON)
}

/**
 * 获取同步状态文件（.snapshot-synced.json）的完整路径。
 *
 * 同步状态文件存放于 Agent 的本地内存目录下，而非快照目录。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @returns .snapshot-synced.json 的绝对路径
 */
function getSyncedJsonPath(agentType: string, scope: AgentMemoryScope): string {
  return join(getAgentMemoryDir(agentType, scope), SYNCED_JSON)
}

/**
 * 读取并解析指定路径的 JSON 文件，使用提供的 Zod schema 校验内容。
 *
 * 若文件不存在、读取失败或校验不通过，均返回 null（宽松处理，不抛出异常）。
 *
 * @param path 文件的绝对路径
 * @param schema Zod 校验 schema
 * @returns 解析并校验通过的数据，或 null
 */
async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const content = await readFile(path, { encoding: 'utf-8' })
    // 使用 safeParse 避免抛出异常，校验失败返回 null
    const result = schema.safeParse(jsonParse(content))
    return result.success ? result.data : null
  } catch {
    // 文件不存在或读取失败，返回 null
    return null
  }
}

/**
 * 将快照目录中的内存文件复制到本地内存目录。
 *
 * 复制规则：
 * - 跳过 snapshot.json（元数据文件，不属于内存内容）
 * - 仅复制普通文件（跳过子目录）
 * - 如果目标目录不存在，会自动创建
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域，决定目标本地内存目录
 */
async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<void> {
  const snapshotMemDir = getSnapshotDirForAgent(agentType) // 快照来源目录
  const localMemDir = getAgentMemoryDir(agentType, scope)  // 本地目标目录

  // 确保本地内存目录存在（recursive 避免目录已存在时报错）
  await mkdir(localMemDir, { recursive: true })

  try {
    // 遍历快照目录中的所有文件
    const files = await readdir(snapshotMemDir, { withFileTypes: true })
    for (const dirent of files) {
      // 跳过非文件项（子目录等）以及快照元数据文件
      if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
      const content = await readFile(join(snapshotMemDir, dirent.name), {
        encoding: 'utf-8',
      })
      // 将文件写入本地内存目录
      await writeFile(join(localMemDir, dirent.name), content)
    }
  } catch (e) {
    // 快照目录不存在或读取失败时记录调试日志，不向上抛出
    logForDebugging(`Failed to copy snapshot to local agent memory: ${e}`)
  }
}

/**
 * 将快照的同步时间戳写入本地内存目录的 .snapshot-synced.json 文件。
 *
 * 通过记录上次同步的快照时间戳，后续检测时可以判断快照是否有更新。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @param snapshotTimestamp 快照的 updatedAt 时间戳
 */
async function saveSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  const syncedPath = getSyncedJsonPath(agentType, scope) // 同步状态文件路径
  const localMemDir = getAgentMemoryDir(agentType, scope)
  // 确保目录存在
  await mkdir(localMemDir, { recursive: true })
  // 构造同步状态对象
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  try {
    // 写入同步状态文件
    await writeFile(syncedPath, jsonStringify(meta))
  } catch (e) {
    // 写入失败时仅记录日志，不抛出（快照同步失败不应阻断 Agent 启动）
    logForDebugging(`Failed to save snapshot sync metadata: ${e}`)
  }
}

/**
 * 检测快照是否存在，以及是否比上次同步更新。
 *
 * 返回的 action 字段指示应执行的操作：
 * - 'none'         — 无快照，或快照未更新，无需操作
 * - 'initialize'   — 本地无 .md 文件，需从快照首次初始化
 * - 'prompt-update'— 本地有内存但快照更新，需提示用户并按需替换
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @returns 检测结果及可选的快照时间戳
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  // 读取快照元数据，若不存在则直接返回无需操作
  const snapshotMeta = await readJsonFile(
    getSnapshotJsonPath(agentType),
    snapshotMetaSchema(),
  )

  if (!snapshotMeta) {
    return { action: 'none' } // 无快照，跳过
  }

  const localMemDir = getAgentMemoryDir(agentType, scope)

  // 检测本地内存目录是否存在 .md 文件
  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    // 至少有一个 .md 文件视为已有本地内存
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // Directory doesn't exist
    // 目录不存在，视为无本地内存
  }

  if (!hasLocalMemory) {
    // 无本地内存：需从快照首次初始化
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  // 读取上次同步状态
  const syncedMeta = await readJsonFile(
    getSyncedJsonPath(agentType, scope),
    syncedMetaSchema(),
  )

  if (
    !syncedMeta || // 从未同步过
    new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom) // 快照比上次同步更新
  ) {
    // 快照有更新：提示用户进行更新替换
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }

  // 快照未更新：无需操作
  return { action: 'none' }
}

/**
 * 从快照首次初始化本地 Agent 内存（首次 setup）。
 *
 * 适用于本地内存目录为空时，将快照内容作为初始内存数据复制过来。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @param snapshotTimestamp 快照的 updatedAt 时间戳
 */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Initializing agent memory for ${agentType} from project snapshot`,
  )
  // 复制快照文件到本地内存目录
  await copySnapshotToLocal(agentType, scope)
  // 更新同步状态，记录本次同步的快照时间戳
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 用快照内容替换现有的本地 Agent 内存。
 *
 * 与 initializeFromSnapshot 的区别在于：
 * 替换前会先删除本地内存目录中的所有 .md 文件，以避免旧文件残留（孤儿文件）。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @param snapshotTimestamp 快照的 updatedAt 时间戳
 */
export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Replacing agent memory for ${agentType} with project snapshot`,
  )
  // 先删除本地内存目录中所有已有的 .md 文件，防止旧文件成为孤儿
  // Remove existing .md files before copying to avoid orphans
  const localMemDir = getAgentMemoryDir(agentType, scope)
  try {
    const existing = await readdir(localMemDir, { withFileTypes: true })
    for (const dirent of existing) {
      // 仅删除 .md 文件（保留 .json 元数据文件等）
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        await unlink(join(localMemDir, dirent.name))
      }
    }
  } catch {
    // Directory may not exist yet
    // 目录不存在时忽略（copySnapshotToLocal 会自动创建）
  }
  // 从快照复制内存文件
  await copySnapshotToLocal(agentType, scope)
  // 更新同步状态
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 将快照标记为已同步，而不修改本地内存内容。
 *
 * 适用于用户选择"跳过本次更新"的场景：仅更新同步时间戳，
 * 避免下次检测时重复提示，但不替换已有的本地内存数据。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @param snapshotTimestamp 快照的 updatedAt 时间戳
 */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  // 仅更新同步时间戳，不复制任何文件
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}
