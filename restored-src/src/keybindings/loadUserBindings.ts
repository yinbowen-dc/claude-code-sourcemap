/**
 * @file loadUserBindings.ts
 * @description 用户键位绑定配置的加载器，支持热重载。
 *
 * 【在 Claude Code 系统中的位置与作用】
 * 本文件处于键位绑定流水线的"加载与合并"层：
 *   defaultBindings（内置默认值）→ loadUserBindings（本文件，加载用户覆盖并合并）
 *     → resolver（解析按键事件为 action）→ useKeybinding（React Hook 响应）
 *
 * 主要职责：
 * 1. 从 ~/.claude/keybindings.json 加载用户自定义绑定。
 * 2. 将用户绑定追加到默认绑定之后（后者优先原则实现覆盖）。
 * 3. 使用 chokidar 监听文件变化，实现无需重启的热重载。
 * 4. 对加载结果进行校验并收集警告信息。
 * 5. 向订阅者广播绑定变更事件。
 *
 * 注意：用户自定义键位绑定目前仅对 Anthropic 员工开放
 *（通过 GrowthBook 特性开关 `tengu_keybinding_customization_release` 控制）。
 * 外部用户始终使用默认绑定。
 *
 * Loads keybindings from ~/.claude/keybindings.json and watches
 * for changes to reload them automatically.
 *
 * NOTE: User keybinding customization is currently only available for
 * Anthropic employees (USER_TYPE === 'ant'). External users always
 * use the default bindings.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { readFileSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { createSignal } from '../utils/signal.js'
import { jsonParse } from '../utils/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import {
  checkDuplicateKeysInJson,
  type KeybindingWarning,
  validateBindings,
} from './validate.js'

/**
 * 检查键位绑定自定义功能是否已启用。
 *
 * 通过查询 GrowthBook 特性开关 `tengu_keybinding_customization_release` 来判断。
 * 返回 true 表示当前用户可以自定义键位绑定。
 *
 * 导出此函数的目的是让代码库其他部分（如 /doctor 命令）能以一致的方式检查同一条件。
 */
export function isKeybindingCustomizationEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_keybinding_customization_release',
    false,
  )
}

/**
 * 等待文件写入稳定的超时时间（毫秒）。
 * 防止在文件正在写入时就触发热重载。
 */
const FILE_STABILITY_THRESHOLD_MS = 500

/**
 * 文件稳定性检测的轮询间隔（毫秒）。
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 200

/**
 * 加载键位绑定的结果类型，包含解析后的绑定列表和校验警告。
 */
export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]    // 合并后的最终绑定列表（默认 + 用户）
  warnings: KeybindingWarning[] // 校验过程中产生的警告/错误
}

// 文件监听器实例（由 chokidar 创建）
let watcher: FSWatcher | null = null
// 是否已初始化文件监听器
let initialized = false
// 是否已销毁（用于防止重复初始化）
let disposed = false
// 缓存的已解析绑定列表（供同步读取使用）
let cachedBindings: ParsedBinding[] | null = null
// 缓存的校验警告列表
let cachedWarnings: KeybindingWarning[] = []
// 绑定变更信号，用于广播热重载事件给所有订阅者
const keybindingsChanged = createSignal<[result: KeybindingsLoadResult]>()

/**
 * 记录上次记录自定义绑定加载事件的日期（YYYY-MM-DD 格式）。
 * 用于确保每天最多触发一次分析事件，避免重复上报。
 */
let lastCustomBindingsLogDate: string | null = null

/**
 * 每日最多记录一次自定义键位绑定加载的遥测事件。
 * 用于统计有多少用户自定义了键位绑定，作为功能使用率的参考。
 *
 * @param userBindingCount - 用户配置文件中的绑定数量
 */
function logCustomBindingsLoadedOncePerDay(userBindingCount: number): void {
  const today = new Date().toISOString().slice(0, 10) // 取 YYYY-MM-DD 部分
  if (lastCustomBindingsLogDate === today) return // 今日已记录，跳过
  lastCustomBindingsLogDate = today
  logEvent('tengu_custom_keybindings_loaded', {
    user_binding_count: userBindingCount,
  })
}

/**
 * 类型守卫：检查一个对象是否为合法的 KeybindingBlock。
 * 要求对象具有字符串类型的 context 字段和对象类型的 bindings 字段。
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  return (
    typeof b.context === 'string' &&
    typeof b.bindings === 'object' &&
    b.bindings !== null
  )
}

/**
 * 类型守卫：检查一个数组是否只包含合法的 KeybindingBlock 对象。
 * 对数组中每个元素调用 isKeybindingBlock 进行逐一验证。
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * 获取用户键位绑定配置文件的路径。
 * 路径为 ~/.claude/keybindings.json（通过 getClaudeConfigHomeDir 确定根目录）。
 */
export function getKeybindingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'keybindings.json')
}

/**
 * 获取已解析的默认绑定列表（每次调用都重新解析，调用者可自行缓存）。
 * 将 DEFAULT_BINDINGS 的 KeybindingBlock[] 格式转换为扁平的 ParsedBinding[] 列表。
 */
function getDefaultParsedBindings(): ParsedBinding[] {
  return parseBindings(DEFAULT_BINDINGS)
}

/**
 * 异步加载并解析键位绑定配置（含用户自定义）。
 * 返回"默认绑定 + 用户绑定"合并结果，以及校验警告。
 *
 * 流程：
 * 1. 检查特性开关，若未开启则只返回默认绑定。
 * 2. 读取用户配置文件，验证 JSON 结构。
 * 3. 将用户绑定追加到默认绑定之后（后者优先覆盖前者）。
 * 4. 运行校验（重复键检测、保留快捷键检测等）。
 * 5. 返回合并结果和所有警告。
 *
 * 对外部用户：始终只返回默认绑定。
 */
export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  const defaultBindings = getDefaultParsedBindings()

  // 外部用户不加载自定义配置，直接返回默认绑定
  if (!isKeybindingCustomizationEnabled()) {
    return { bindings: defaultBindings, warnings: [] }
  }

  const userPath = getKeybindingsPath()

  try {
    const content = await readFile(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从包装格式 { "bindings": [...] } 中提取 bindings 数组
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效——缺少 bindings 属性
      const errorMessage = 'keybindings.json must have a "bindings" array'
      const suggestion = 'Use format: { "bindings": [ ... ] }'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    // 校验结构——bindings 必须是合法 KeybindingBlock 对象的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )

    // 用户绑定追加在默认绑定之后，实现覆盖（后者优先）
    const mergedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 对用户配置进行校验：
    // 首先检查原始 JSON 中的重复键（JSON.parse 会静默丢弃前面的值）
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    const warnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, mergedBindings), // 完整校验
    ]

    if (warnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${warnings.length} validation issue(s)`,
      )
    }

    return { bindings: mergedBindings, warnings }
  } catch (error) {
    // 文件不存在——使用默认绑定（用户可运行 /keybindings 创建）
    if (isENOENT(error)) {
      return { bindings: defaultBindings, warnings: [] }
    }

    // 其他错误——记录日志并返回默认绑定（附带警告）
    logForDebugging(
      `[keybindings] Error loading ${userPath}: ${errorMessage(error)}`,
    )
    return {
      bindings: defaultBindings,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `Failed to parse keybindings.json: ${errorMessage(error)}`,
        },
      ],
    }
  }
}

/**
 * 同步加载键位绑定（用于首次渲染时的同步初始化）。
 * 若缓存可用则直接返回缓存值，避免重复 I/O。
 *
 * 注意：只返回绑定列表，不含警告信息；如需警告请使用 loadKeybindingsSyncWithWarnings。
 */
export function loadKeybindingsSync(): ParsedBinding[] {
  if (cachedBindings) {
    return cachedBindings // 命中缓存，直接返回
  }

  const result = loadKeybindingsSyncWithWarnings()
  return result.bindings
}

/**
 * 同步加载键位绑定并返回校验警告。
 * 若缓存可用则直接返回缓存值（绑定 + 警告）。
 *
 * 流程与 loadKeybindings 相同，但使用同步 I/O（readFileSync），
 * 适用于 React useState 初始化器等同步上下文。
 *
 * 对外部用户：始终只返回默认绑定。
 */
export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  if (cachedBindings) {
    return { bindings: cachedBindings, warnings: cachedWarnings } // 命中缓存
  }

  const defaultBindings = getDefaultParsedBindings()

  // 外部用户不加载自定义配置
  if (!isKeybindingCustomizationEnabled()) {
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const userPath = getKeybindingsPath()

  try {
    // 同步 I/O：在同步上下文（如 React useState 初始化器）中调用
    const content = readFileSync(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从包装格式 { "bindings": [...] } 中提取 bindings 数组
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效——缓存默认绑定并返回错误警告
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: 'keybindings.json must have a "bindings" array',
          suggestion: 'Use format: { "bindings": [ ... ] }',
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    // 校验结构——bindings 必须是合法 KeybindingBlock 对象的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: errorMessage,
          suggestion,
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )
    // 合并：默认绑定在前，用户绑定在后（后者优先覆盖前者）
    cachedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 运行校验：先检查原始 JSON 中的重复键
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    cachedWarnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, cachedBindings),
    ]
    if (cachedWarnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${cachedWarnings.length} validation issue(s)`,
      )
    }

    return { bindings: cachedBindings, warnings: cachedWarnings }
  } catch {
    // 文件不存在或读取出错——使用默认绑定（用户可运行 /keybindings 创建文件）
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }
}

/**
 * 初始化 keybindings.json 的文件监听器（热重载）。
 * 应在应用启动时调用一次。
 *
 * 流程：
 * 1. 检查是否已初始化或已销毁（幂等保护）。
 * 2. 检查特性开关，外部用户跳过。
 * 3. 验证配置目录存在。
 * 4. 创建 chokidar 监听器，监听文件的新增、修改和删除事件。
 * 5. 注册清理回调（应用退出时自动关闭监听器）。
 *
 * 对外部用户：此函数为空操作（no-op），因为自定义功能已禁用。
 */
export async function initializeKeybindingWatcher(): Promise<void> {
  if (initialized || disposed) return // 幂等保护

  // 外部用户跳过文件监听
  if (!isKeybindingCustomizationEnabled()) {
    logForDebugging(
      '[keybindings] Skipping file watcher - user customization disabled',
    )
    return
  }

  const userPath = getKeybindingsPath()
  const watchDir = dirname(userPath) // 监听配置文件所在目录

  // 只有父目录存在时才启动监听
  try {
    const stats = await stat(watchDir)
    if (!stats.isDirectory()) {
      logForDebugging(
        `[keybindings] Not watching: ${watchDir} is not a directory`,
      )
      return
    }
  } catch {
    logForDebugging(`[keybindings] Not watching: ${watchDir} does not exist`)
    return
  }

  // 确认可以监听后再标记为已初始化
  initialized = true

  logForDebugging(`[keybindings] Watching for changes to ${userPath}`)

  watcher = chokidar.watch(userPath, {
    persistent: true,          // 保持进程存活，不因无其他任务而退出
    ignoreInitial: true,       // 启动时不触发已存在文件的 add 事件
    awaitWriteFinish: {
      // 等待文件写入稳定后再触发事件，防止读到写了一半的文件
      stabilityThreshold: FILE_STABILITY_THRESHOLD_MS,
      pollInterval: FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignorePermissionErrors: true, // 忽略权限错误，避免监听器崩溃
    usePolling: false,            // 优先使用原生 fs 事件，不使用轮询
    atomic: true,                 // 处理原子写入（如 vim 的 tmp 文件替换）
  })

  // 绑定文件事件处理器
  watcher.on('add', handleChange)    // 文件被新建时重新加载
  watcher.on('change', handleChange) // 文件被修改时重新加载
  watcher.on('unlink', handleDelete) // 文件被删除时重置为默认绑定

  // 注册清理回调，确保应用退出时正确关闭监听器
  registerCleanup(async () => disposeKeybindingWatcher())
}

/**
 * 销毁文件监听器并清理相关资源。
 * 关闭 chokidar 监听器，清除信号订阅列表。
 */
export function disposeKeybindingWatcher(): void {
  disposed = true
  if (watcher) {
    void watcher.close() // 异步关闭，不等待结果
    watcher = null
  }
  keybindingsChanged.clear() // 清除所有变更事件订阅
}

/**
 * 订阅键位绑定变更事件。
 * 每当 keybindings.json 文件发生变化并重新加载后，监听器会收到新的绑定结果。
 * 返回值为取消订阅的函数。
 */
export const subscribeToKeybindingChanges = keybindingsChanged.subscribe

/**
 * 文件新增/修改事件处理器。
 * 重新加载配置文件，更新缓存，并广播变更事件给所有订阅者。
 *
 * @param path - 发生变化的文件路径
 */
async function handleChange(path: string): Promise<void> {
  logForDebugging(`[keybindings] Detected change to ${path}`)

  try {
    const result = await loadKeybindings() // 重新加载（异步）
    cachedBindings = result.bindings        // 更新绑定缓存
    cachedWarnings = result.warnings        // 更新警告缓存

    // 通知所有订阅者（含完整的绑定和警告信息）
    keybindingsChanged.emit(result)
  } catch (error) {
    logForDebugging(`[keybindings] Error reloading: ${errorMessage(error)}`)
  }
}

/**
 * 文件删除事件处理器。
 * 将缓存重置为默认绑定，并广播变更事件。
 *
 * @param path - 被删除的文件路径
 */
function handleDelete(path: string): void {
  logForDebugging(`[keybindings] Detected deletion of ${path}`)

  // 文件删除后重置为默认绑定
  const defaultBindings = getDefaultParsedBindings()
  cachedBindings = defaultBindings
  cachedWarnings = []

  keybindingsChanged.emit({ bindings: defaultBindings, warnings: [] })
}

/**
 * 获取当前缓存的校验警告列表。
 * 若绑定尚未加载或没有警告，返回空数组。
 */
export function getCachedKeybindingWarnings(): KeybindingWarning[] {
  return cachedWarnings
}

/**
 * 重置内部状态（仅用于测试）。
 * 清除所有缓存、状态标志和监听器，使模块回到初始状态。
 */
export function resetKeybindingLoaderForTesting(): void {
  initialized = false
  disposed = false
  cachedBindings = null
  cachedWarnings = []
  lastCustomBindingsLogDate = null
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  keybindingsChanged.clear()
}
