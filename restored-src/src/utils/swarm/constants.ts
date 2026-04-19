/**
 * Swarm 系统共享常量模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块为整个 Swarm 多智能体系统提供基础常量定义，
 * 被 TmuxBackend、ITermBackend、PaneBackendExecutor、registry 等多个模块引用。
 *
 * 主要内容：
 * 1. 会话和窗口名称常量（tmux 会话名、窗口名等）
 * 2. tmux 命令名称
 * 3. Socket 名称生成函数（含 PID 以隔离多个 Claude 实例）
 * 4. Teammate 相关环境变量名称常量
 *    - TEAMMATE_COMMAND_ENV_VAR：允许覆盖 teammate 启动命令（测试用）
 *    - TEAMMATE_COLOR_ENV_VAR：传递分配给 teammate 的颜色（彩色输出）
 *    - PLAN_MODE_REQUIRED_ENV_VAR：要求 teammate 在实现前先进入计划模式
 */

/** 领导者（leader）角色的名称，用于 tmux 窗格标识和日志 */
export const TEAM_LEAD_NAME = 'team-lead'

/** 外部 tmux swarm 会话的名称（用户不在 tmux 中时创建的专用会话）*/
export const SWARM_SESSION_NAME = 'claude-swarm'

/** Swarm 总览视图窗口的名称（展示所有 teammate 窗格的 tmux 窗口）*/
export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'

/** tmux 命令名称，通过 execFile 系列函数调用时使用 */
export const TMUX_COMMAND = 'tmux'

/** 隐藏窗格时使用的 tmux 会话名称（break-pane -d 的目标会话）*/
export const HIDDEN_SESSION_NAME = 'claude-hidden'

/**
 * 生成外部 Swarm 会话使用的 tmux socket 名称。
 *
 * 格式：`claude-swarm-{PID}`
 * 包含进程 PID 的原因：允许多个 Claude 实例同时运行而互不干扰，
 * 每个实例都使用独立的 tmux socket，避免会话名冲突。
 *
 * 用于：TmuxBackend 在"用户不在 tmux 中"模式下创建独立 tmux 服务器时。
 *
 * @returns 当前进程专属的 tmux socket 名称
 */
export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}

/**
 * 环境变量名：用于覆盖 teammate 实例的启动命令。
 * 若未设置，默认使用 process.execPath（当前 Claude 二进制文件路径）。
 * 主要用途：测试环境中替换为模拟命令，或在特殊部署中指定不同路径。
 */
export const TEAMMATE_COMMAND_ENV_VAR = 'CLAUDE_CODE_TEAMMATE_COMMAND'

/**
 * 环境变量名：传递给 teammate 进程的颜色分配值。
 * TmuxBackend/ITermBackend 在 spawn 时设置此变量，
 * teammate 进程读取后用于彩色输出和窗格标识。
 */
export const TEAMMATE_COLOR_ENV_VAR = 'CLAUDE_CODE_AGENT_COLOR'

/**
 * 环境变量名：要求 teammate 在编写代码前先进入计划模式。
 * 设置为 'true' 时，teammate 必须先提交计划、获得领导者批准后才能执行实现。
 * 用于需要严格审查的工作流场景。
 */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'CLAUDE_CODE_PLAN_MODE_REQUIRED'
