/**
 * shared/spawnMultiAgent.ts — 多智能体 Teammate 创建模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（shared 工具）→ Teammate 生命周期管理
 *     ├── handleSpawnSplitPane：tmux/iTerm2 分屏创建（默认路径）
 *     ├── handleSpawnSeparateWindow：tmux 独立窗口创建（遗留路径）
 *     └── handleSpawnInProcess：同进程内嵌创建（via AsyncLocalStorage）
 *
 * 主要功能：
 *   - spawnTeammate：创建 teammate 的统一入口，供 TeammateTool 和 AgentTool 共用
 *   - 自动检测可用后端（tmux / iTerm2 / in-process），并在无可用后端时回退到 in-process
 *   - 为每个 teammate 分配唯一颜色、生成确定性 agentId、写入团队文件
 *   - 向 teammate 信箱发送初始 prompt（tmux 路径）或直接启动执行循环（in-process 路径）
 *
 * 设计说明：
 *   - resolveTeammateModel：处理 'inherit' 别名（继承 leader 模型）
 *   - generateUniqueTeammateName：防止同名冲突（追加 -2, -3 ... 后缀）
 *   - buildInheritedCliFlags：将 leader 的权限模式/模型/插件等设置传递给 teammate
 *   - registerOutOfProcessTeammateTask：使 tmux/iTerm2 teammate 在任务列表中可见
 */

import React from 'react'
import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getSessionId,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'
import {
  readTeamFileAsync,
  sanitizeAgentName,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'

/**
 * getDefaultTeammateModel — 获取 teammate 的默认模型
 *
 * 优先级：
 *   1. 用户在 /config 中配置了具体型号 → 使用该配置
 *   2. 用户选择了 "Default"（configured === null）→ 继承 leader 模型
 *   3. 未配置（configured === undefined）→ 使用硬编码的 fallback 模型
 *
 * @param leaderModel leader 当前使用的模型（可能为 null）
 * @returns 解析后的模型名称
 */
function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // User picked "Default" in the /config picker — follow the leader.
    // 用户选择了"Default"：跟随 leader 的模型，leader 无模型时使用 fallback
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    // 用户配置了具体模型名称，解析后使用
    return parseUserSpecifiedModel(configured)
  }
  // 未配置时使用硬编码 fallback
  return getHardcodedTeammateModelFallback()
}

/**
 * Resolve a teammate model value. Handles the 'inherit' alias (from agent
 * frontmatter) by substituting the leader's model. gh-31069: 'inherit' was
 * passed literally to --model, producing "It may not exist or you may not
 * have access". If leader model is null (not yet set), falls through to the
 * default.
 *
 * Exported for testing.
 *
 * resolveTeammateModel — 解析 teammate 模型设置
 *   - 'inherit'：替换为 leader 的当前模型（解决字面量传给 --model 的问题）
 *   - undefined：使用默认模型逻辑
 *   - 其他字符串：直接使用
 *
 * @param inputModel 输入的模型名称或 'inherit' 或 undefined
 * @param leaderModel leader 当前模型（可能为 null）
 * @returns 实际使用的模型名称
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    // 'inherit' 替换为 leader 模型，leader 未设置时使用默认模型
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

// ============================================================================
// Types
// ============================================================================

// 创建 teammate 的输出结果（包含 ID、颜色、tmux 坐标等）
export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

// 创建 teammate 的输入配置（对外暴露的公共接口）
export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  /** request_id of the API call whose response contained the tool_use that
   *  spawned this teammate. Threaded through to TeammateAgentContext for
   *  lineage tracing on tengu_api_* events. */
  invokingRequestId?: string
}

// Internal input type matching TeammateTool's spawn parameters
// 内部使用的 spawn 输入类型（与 SpawnTeammateConfig 相同，用于各 handler 函数）
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * hasSession — 检查指定 tmux session 是否存在
 *
 * @param sessionName tmux session 名称
 * @returns true 表示 session 存在
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * ensureSession — 确保指定 tmux session 存在，不存在时创建
 *
 * @param sessionName tmux session 名称
 * @throws 创建失败时抛出错误
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    // session 不存在：创建新的后台 session（-d 表示不附加到终端）
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * getTeammateCommand — 获取用于启动 teammate 的命令路径
 *
 * 优先级：
 *   1. TEAMMATE_COMMAND_ENV_VAR 环境变量（测试/自定义覆盖）
 *   2. 打包模式（native binary）：process.execPath（可执行文件路径）
 *   3. 非打包模式（node/bun 脚本）：process.argv[1]（入口脚本路径）
 *
 * @returns 启动命令的绝对路径
 */
function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  // 打包为原生二进制时使用 execPath，否则使用脚本路径
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * buildInheritedCliFlags — 构建从 leader 继承到 teammate 的 CLI 标志
 *
 * 目的：确保 teammate 从父会话继承关键设置（权限模式、模型选择、插件配置等）
 *
 * 整体流程：
 *   1. 权限模式传播：
 *      - plan_mode_required=true：不继承 bypass 权限（plan 模式优先，安全第一）
 *      - bypassPermissions：传递 --dangerously-skip-permissions
 *      - acceptEdits：传递 --permission-mode acceptEdits
 *      - auto：传递 --permission-mode auto（子代理的自动分类器也启用）
 *   2. 模型传播：若通过 --model 显式指定，传递给 teammate
 *   3. 设置文件传播：若通过 --settings 指定，传递给 teammate
 *   4. 插件目录传播：每个 inline plugin 都追加一个 --plugin-dir 标志
 *   5. Chrome 标志传播：若显式设置 --chrome/--no-chrome，传递给 teammate
 *
 * @param options.planModeRequired plan 模式开关（阻止继承 bypass 权限）
 * @param options.permissionMode 当前会话的权限模式
 * @returns 组合后的 CLI 标志字符串
 */
function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
    // plan 模式开启时，不继承 bypass 权限（安全性优先）
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    // 会话级 bypass 权限：传递给 teammate
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup (permissionSetup.ts) handles
    // GrowthBook gate checks and setAutoModeActive(true) independently.
    // auto 模式传递：teammate 的自动分类器也会启用
    flags.push('--permission-mode auto')
  }

  // 若通过 CLI 显式指定了模型，传递给 teammate
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // 若通过 CLI 指定了 --settings，传递给 teammate
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // 每个 inline plugin 目录追加一个 --plugin-dir 标志
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // 若显式设置了 Chrome 标志，传递给 teammate
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * generateUniqueTeammateName — 生成唯一的 teammate 名称
 *
 * 若团队中已存在同名成员，追加数字后缀（-2, -3, ...）直到找到唯一名称
 * 导出供测试使用
 *
 * @param baseName 原始名称
 * @param teamName 团队名称（若为 undefined，直接返回 baseName）
 * @returns 唯一化后的名称
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  // 将所有现有成员名称转为小写集合（名称比较不区分大小写）
  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // If the base name doesn't exist, use it as-is
  // baseName 不冲突时直接使用
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // 从 -2 开始递增后缀，直到找到不冲突的名称
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Spawn Handlers
// ============================================================================

/**
 * handleSpawnSplitPane — 使用分屏视图创建 teammate（默认路径）
 *
 * 整体流程：
 *   1. 解析模型、获取团队名称、生成唯一名称和 agentId
 *   2. 检测可用后端（tmux / iTerm2）；若 iTerm2 未配置，展示安装引导 UI
 *   3. 在分屏视图中创建新 pane，发送启动命令（含 teammate 身份标志和继承标志）
 *   4. 更新 AppState 的 teamContext（记录新 teammate）
 *   5. 注册后台任务（使 teammate 出现在任务列表中）
 *   6. 写入团队文件（持久化成员信息）
 *   7. 通过信箱发送初始 prompt
 *
 * 分屏行为：
 *   - 在 tmux 内：leader 在左侧，teammate 分布在右侧
 *   - 在 iTerm2（it2 已配置）：使用原生分屏 pane
 *   - 在两者之外：创建 claude-swarm session，所有 teammate 平铺显示
 *
 * @param input 创建配置
 * @param context 工具调用上下文
 */
async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  // 解析模型：'inherit' 替换为 leader 模型
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  // 从输入或 leader 的团队上下文中获取团队名称
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // 防止重名：若已有同名成员，追加数字后缀
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  // 净化名称：移除 @ 字符（否则会破坏 agentName@teamName 的 ID 格式）
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 从名称和团队生成确定性 agentId（格式：sanitizedName@teamName）
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = cwd || getCwd()

  // 检测可用后端（tmux / iTerm2），首次调用会缓存结果
  let detectionResult = await detectAndGetBackend()

  // 若在 iTerm2 中但 it2 CLI 未配置，展示安装引导 UI 并等待用户决定
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // 渲染安装引导 UI，阻塞等待用户选择
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // 清除 JSX 覆盖层
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('Teammate spawn cancelled - iTerm2 setup required')
    }

    // If they installed it2 or chose tmux, clear cached detection and re-fetch
    // so the local detectionResult matches the backend that will actually
    // spawn the pane.
    // - 'installed': re-detect to pick up the ITermBackend (it2 is now available)
    // - 'use-tmux': re-detect so needsIt2Setup is false (preferTmux is now saved)
    //   and subsequent spawns skip this prompt
    // 安装完成或选择 tmux 后，清除后端检测缓存并重新检测
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // 检查是否在 tmux 内（影响 session/window 命名）
  const insideTmux = await isInsideTmux()

  // 为该 teammate 分配唯一颜色（基于 agentId 的确定性哈希）
  const teammateColor = assignTeammateColor(teammateId)

  // Create a pane in the swarm view
  // - Inside tmux: splits current window (leader on left, teammates on right)
  // - In iTerm2 with it2: uses native iTerm2 split panes
  // - Outside both: creates claude-swarm session with tiled teammates
  // 在分屏视图中创建 pane（返回 paneId 和是否为第一个 teammate 的标志）
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // Enable pane border status on first teammate when inside tmux
  // (outside tmux, this is handled in createTeammatePaneInSwarmView)
  // 首个 teammate 在 tmux 内时，启用 pane border 状态显示
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  // 构建 Claude Code 启动命令（不含 prompt，初始指令通过信箱发送）
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  // 构建 teammate 身份标志（替换旧的 CLAUDE_CODE_* 环境变量方式）
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  // 构建继承标志（传递权限模式等设置给 teammate）
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // If teammate has a custom model, add --model flag (or replace inherited one)
  if (model) {
    // Remove any inherited --model flag first
    // 先移除可能已继承的 --model 标志，避免重复
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  // 构建需要传递给 teammate 但 tmux shell 可能不会自动继承的环境变量
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new pane
  // Use swarm socket when running outside tmux (external swarm session)
  // 向新 pane 发送启动命令（外部 swarm session 时使用 socket）
  await sendCommandToPane(paneId, spawnCommand, !insideTmux)

  // 根据是否在 tmux 内决定 session/window 名称
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // Track the teammate in AppState's teamContext with color
  // If spawning without spawnTeam, set up the leader as team lead
  // 更新 AppState 的 teamContext，记录新 teammate 信息
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so teammates appear in the tasks pill/dialog
  // 注册后台任务条目（使 teammate 出现在任务列表面板中）
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file
  // 将 teammate 信息写入团队文件（持久化）
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: detectionResult.backend.type,
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  // 通过信箱发送初始 prompt（teammate 的信箱轮询器会在下次检查时消费）
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      plan_mode_required,
    },
  }
}

/**
 * handleSpawnSeparateWindow — 使用独立 tmux 窗口创建 teammate（遗留路径）
 *
 * 整体流程：
 *   1. 解析模型、团队名称、生成唯一名称和 agentId
 *   2. 确保 SWARM_SESSION_NAME tmux session 存在
 *   3. 在该 session 中创建新窗口（格式：teammate-<name>）
 *   4. 构建并发送启动命令
 *   5. 更新 AppState、注册后台任务、写入团队文件、发送初始 prompt
 *
 * 与 handleSpawnSplitPane 的区别：
 *   - 每个 teammate 独占一个 tmux 窗口（而非分屏 pane）
 *   - 始终在 SWARM_SESSION_NAME 会话中创建（与当前终端分离）
 *
 * @param input 创建配置
 * @param context 工具调用上下文
 */
async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // 防止重名：生成唯一名称
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 生成确定性 agentId 和 tmux 窗口名
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = cwd || getCwd()

  // 确保 SWARM_SESSION_NAME tmux session 存在（不存在时自动创建）
  await ensureSession(SWARM_SESSION_NAME)

  // 为该 teammate 分配唯一颜色
  const teammateColor = assignTeammateColor(teammateId)

  // 在 swarm session 中创建新窗口，-P -F '#{pane_id}' 返回新建的 pane ID
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `Failed to create tmux window: ${createWindowResult.stderr}`,
    )
  }

  // 提取新创建的 pane ID（trimmed stdout）
  const paneId = createWindowResult.stdout.trim()

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // If teammate has a custom model, add --model flag (or replace inherited one)
  if (model) {
    // Remove any inherited --model flag first
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // 向新建窗口发送启动命令（模拟键盘输入 + Enter）
  const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    spawnCommand,
    'Enter',
  ])

  if (sendKeysResult.code !== 0) {
    throw new Error(
      `Failed to send command to tmux window: ${sendKeysResult.stderr}`,
    )
  }

  // 更新 AppState 的 teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so tmux teammates appear in the tasks pill/dialog
  // Separate window spawns are always outside tmux (external swarm session)
  // 注册后台任务（独立窗口模式始终在 tmux 外部 session 中）
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
  })

  // 将 teammate 信息写入团队文件
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux', // This handler always uses tmux directly
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * registerOutOfProcessTeammateTask — 为进程外（tmux/iTerm2）teammate 注册后台任务条目
 *
 * 目的：使 tmux/iTerm2 teammate 在任务列表面板（tasks pill/dialog）中可见，
 *       与 in-process teammate 的跟踪方式保持一致
 *
 * 整体流程：
 *   1. 创建 InProcessTeammateTaskState（type='in_process_teammate'）
 *   2. 通过 registerTask 写入 AppState
 *   3. 监听 abort 信号：触发时通过后端 killPane 方法关闭对应 pane
 *
 * 注意：函数名称虽然包含 "InProcess"，但实际上也用于 tmux 外部 teammate，
 *       是统一的任务跟踪机制
 */
function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
  },
): void {
  const taskId = generateTaskId('in_process_teammate')
  // 截取 prompt 前 50 字符作为任务描述
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  // 构建任务状态对象（包含 teammate 身份信息）
  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  // 将任务写入 AppState
  registerTask(taskState, setAppState)

  // When abort is signaled, kill the pane using the backend that created it
  // (tmux kill-pane for tmux panes, it2 session close for iTerm2 native panes).
  // SDK task_notification bookend is emitted by killInProcessTeammate (the
  // sole abort trigger for this controller).
  // 监听 abort 信号：触发时通过对应后端关闭 pane（tmux kill-pane 或 iTerm2 session close）
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        // insideTmux=false 时使用 swarm socket 发送命令（外部 session）
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      }
    },
    { once: true },
  )
}

/**
 * handleSpawnInProcess — 使用同进程模式创建 teammate
 *
 * 整体流程：
 *   1. 解析模型、团队名称、生成唯一名称和 agentId
 *   2. 若有 agent_type，查找对应的 CustomAgentDefinition（含系统提示等）
 *   3. 调用 spawnInProcessTeammate 创建 AsyncLocalStorage 上下文和任务状态
 *   4. 调用 startInProcessTeammate 启动代理执行循环（fire-and-forget）
 *   5. 更新 AppState（含 leader 自动注册）、写入团队文件
 *   6. 注意：in-process teammate 通过 startInProcessTeammate 直接接收 prompt，
 *            不通过信箱，避免重复消息
 *
 * 与 tmux 路径的关键区别：
 *   - 在同一 Node.js 进程内运行，通过 AsyncLocalStorage 隔离上下文
 *   - 不需要 tmux session，pane_id 为 "in-process" 占位符
 *   - parent 的 messages 被清空传递（避免 teammate 继承 leader 的完整对话历史）
 *
 * @param input 创建配置
 * @param context 工具调用上下文
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // 防止重名，生成唯一名称
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 生成确定性 agentId
  const teammateId = formatAgentId(sanitizedName, teamName)

  // 分配唯一颜色
  const teammateColor = assignTeammateColor(teammateId)

  // 若指定了 agent_type，从已加载的 agent 列表中查找对应的 CustomAgentDefinition
  let agentDefinition: CustomAgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    const foundAgent = allAgents.find(a => a.agentType === agent_type)
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn in-process teammate
  // 创建 in-process teammate（建立 AsyncLocalStorage 上下文和任务状态）
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
  }

  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to spawn in-process teammate')
  }

  // Debug: log what spawn returned
  logForDebugging(
    `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
  )

  // Start the agent execution loop (fire-and-forget)
  // 启动代理执行循环（fire-and-forget，不等待完成）
  if (result.taskId && result.teammateContext && result.abortController) {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: sanitizedName,
        teamName,
        color: teammateColor,
        planModeRequired: plan_mode_required ?? false,
        parentSessionId: result.teammateContext.parentSessionId,
      },
      taskId: result.taskId,
      prompt,
      description: input.description,
      model,
      agentDefinition,
      teammateContext: result.teammateContext,
      // Strip messages: the teammate never reads toolUseContext.messages
      // (it builds its own history via allMessages in inProcessRunner).
      // Passing the parent's full conversation here would pin it for the
      // teammate's lifetime, surviving /clear and auto-compact.
      // 清空 messages：teammate 自己构建对话历史，不继承 leader 的完整历史
      toolUseContext: { ...context, messages: [] },
      abortController: result.abortController,
      invokingRequestId: input.invokingRequestId,
    })
    logForDebugging(
      `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
    )
  }

  // Track the teammate in AppState's teamContext
  // Auto-register leader if spawning without prior spawnTeam call
  // 更新 AppState，若未调用过 spawnTeam 则自动注册 leader
  setAppState(prev => {
    const needsLeaderSetup = !prev.teamContext?.leadAgentId
    const leadAgentId = needsLeaderSetup
      ? formatAgentId(TEAM_LEAD_NAME, teamName)
      : prev.teamContext!.leadAgentId

    // Build teammates map, including leader if needed for inbox polling
    // 构建 teammates 映射，需要时包含 leader（信箱轮询需要）
    const existingTeammates = prev.teamContext?.teammates || {}
    const leadEntry = needsLeaderSetup
      ? {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: TEAM_LEAD_NAME,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'leader',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        }
      : {}

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...leadEntry,
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })

  // 将 teammate 信息写入团队文件（持久化）
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Note: Do NOT send the prompt via mailbox for in-process teammates.
  // In-process teammates receive the prompt directly via startInProcessTeammate().
  // The mailbox is only needed for tmux-based teammates which poll for their initial message.
  // Sending via both paths would cause duplicate welcome messages.
  // 注意：in-process teammate 不通过信箱发送 prompt（避免重复消息）
  // 它们通过 startInProcessTeammate() 直接接收 prompt
  // 只有 tmux 路径的 teammate 需要轮询信箱获取初始消息

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * handleSpawn — 创建新 Claude Code 实例的内部路由函数
 *
 * 路由逻辑（优先级）：
 *   1. in-process 模式已启用（isInProcessEnabled()）→ handleSpawnInProcess
 *   2. 检测后端失败（auto 模式下）→ 标记 in-process fallback，回退到 in-process
 *   3. 用户显式配置 tmux 但不可用 → 透传错误（含安装说明）
 *   4. use_splitpane !== false → handleSpawnSplitPane（默认）
 *   5. use_splitpane === false → handleSpawnSeparateWindow（遗留）
 *
 * @param input 创建配置
 * @param context 工具调用上下文
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  // 检查是否通过功能标志启用了 in-process 模式
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

  // Pre-flight: ensure a pane backend is available before attempting pane-based spawn.
  // This handles auto-mode cases like iTerm2 without it2 or tmux installed, where
  // isInProcessEnabled() returns false but detectAndGetBackend() has no viable backend.
  // Narrowly scoped so user cancellation and other spawn errors propagate normally.
  // 预检测：确保可用的 pane 后端存在（处理 auto 模式下无可用后端的边缘情况）
  try {
    await detectAndGetBackend()
  } catch (error) {
    // Only fall back silently in auto mode. If the user explicitly configured
    // teammateMode: 'tmux', let the error propagate so they see the actionable
    // install instructions from getTmuxInstallInstructions().
    // 只在 auto 模式下静默回退；用户显式配置 tmux 时透传错误
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    logForDebugging(
      `[handleSpawn] No pane backend available, falling back to in-process: ${errorMessage(error)}`,
    )
    // Record the fallback so isInProcessEnabled() reflects the actual mode
    // (fixes banner and other UI that would otherwise show tmux attach commands).
    // 记录 fallback 以更新 isInProcessEnabled 的返回值（修复 banner 和 UI 显示 tmux 附加命令的问题）
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  // Backend is available (and now cached) - proceed with pane spawning.
  // Any errors here (user cancellation, validation, etc.) propagate to the caller.
  // 后端可用（已缓存）：继续 pane 创建流程
  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * spawnTeammate — 创建 teammate 的统一入口
 *
 * 供 TeammateTool 和 AgentTool 共用，内部路由到具体的 spawn 实现：
 *   - in-process（同进程）
 *   - 分屏 pane（tmux/iTerm2）
 *   - 独立窗口（遗留 tmux 路径）
 *
 * @param config 创建配置（名称、prompt、团队、模型等）
 * @param context 工具调用上下文
 * @returns 包含 teammate_id、名称、颜色、tmux 坐标等信息的创建结果
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  return handleSpawn(config, context)
}
