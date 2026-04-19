/**
 * /bridge-kick 命令实现模块（仅限 Anthropic 内部测试人员）。
 *
 * 在 Claude Code 的 Remote Control（Bridge）子系统中，此命令提供了一套手动注入
 * 故障状态的工具，专门用于测试 Bridge 连接的各类异常恢复路径。通过模拟 WebSocket
 * 关闭、轮询失败、注册失败、心跳超时等场景，帮助工程师验证 doReconnect 策略的
 * 正确性，而无需等待真实网络故障发生。
 *
 * 此命令通过 process.env.USER_TYPE === 'ant' 限制为仅对 Anthropic 员工可用。
 *
 * 对应命令：/bridge-kick <subcommand> [args]
 */
import { getBridgeDebugHandle } from '../bridge/bridgeDebug.js'
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'

/**
 * Ant-only: inject bridge failure states to manually test recovery paths.
 *
 *   /bridge-kick close 1002            — fire ws_closed with code 1002
 *   /bridge-kick close 1006            — fire ws_closed with code 1006
 *   /bridge-kick poll 404              — next poll throws 404/not_found_error
 *   /bridge-kick poll 404 <type>       — next poll throws 404 with error_type
 *   /bridge-kick poll 401              — next poll throws 401 (auth)
 *   /bridge-kick poll transient        — next poll throws axios-style rejection
 *   /bridge-kick register fail         — next register (inside doReconnect) transient-fails
 *   /bridge-kick register fail 3       — next 3 registers transient-fail
 *   /bridge-kick register fatal        — next register 403s (terminal)
 *   /bridge-kick reconnect-session fail — POST /bridge/reconnect fails (→ Strategy 2)
 *   /bridge-kick heartbeat 401         — next heartbeat 401s (JWT expired)
 *   /bridge-kick reconnect             — call doReconnect directly (= SIGUSR2)
 *   /bridge-kick status                — print current bridge state
 *
 * Workflow: connect Remote Control, run a subcommand, `tail -f debug.log`
 * and watch [bridge:repl] / [bridge:debug] lines for the recovery reaction.
 *
 * Composite sequences — the failure modes in the BQ data are chains, not
 * single events. Queue faults then fire the trigger:
 *
 *   # #22148 residual: ws_closed → register transient-blips → teardown?
 *   /bridge-kick register fail 2
 *   /bridge-kick close 1002
 *   → expect: doReconnect tries register, fails, returns false → teardown
 *     (demonstrates the retry gap that needs fixing)
 *
 *   # Dead gate: poll 404/not_found_error → does onEnvironmentLost fire?
 *   /bridge-kick poll 404
 *   → expect: tengu_bridge_repl_fatal_error (gate is dead — 147K/wk)
 *     after fix: tengu_bridge_repl_env_lost → doReconnect
 */

// 用户执行无效子命令时展示的帮助文本
const USAGE = `/bridge-kick <subcommand>
  close <code>              fire ws_closed with the given code (e.g. 1002)
  poll <status> [type]      next poll throws BridgeFatalError(status, type)
  poll transient            next poll throws axios-style rejection (5xx/net)
  register fail [N]         next N registers transient-fail (default 1)
  register fatal            next register 403s (terminal)
  reconnect-session fail    next POST /bridge/reconnect fails
  heartbeat <status>        next heartbeat throws BridgeFatalError(status)
  reconnect                 call reconnectEnvironmentWithSession directly
  status                    print bridge state`

/**
 * /bridge-kick 命令的核心执行函数。
 *
 * 流程：
 * 1. 获取 Bridge 调试句柄（仅在 Remote Control 已连接时存在）
 * 2. 解析子命令及参数
 * 3. 根据子命令类型注入对应的故障状态或直接触发操作
 *
 * 子命令覆盖范围：WebSocket 关闭（close）、轮询故障（poll）、
 * 环境注册失败（register）、会话重连失败（reconnect-session）、
 * 心跳失败（heartbeat）、强制重连（reconnect）、状态查询（status）。
 *
 * @param args 命令行参数字符串，以空格分隔
 */
const call: LocalCommandCall = async args => {
  // 获取 Bridge 调试句柄，若未注册则说明 Remote Control 未连接
  const h = getBridgeDebugHandle()
  if (!h) {
    return {
      type: 'text',
      value:
        'No bridge debug handle registered. Remote Control must be connected (USER_TYPE=ant).',
    }
  }

  // 解析子命令（sub）及最多两个参数（a、b）
  const [sub, a, b] = args.trim().split(/\s+/)

  switch (sub) {
    case 'close': {
      // 触发 WebSocket 关闭事件，模拟不同关闭码的断连场景
      const code = Number(a)
      if (!Number.isFinite(code)) {
        return { type: 'text', value: `close: need a numeric code\n${USAGE}` }
      }
      h.fireClose(code)
      return {
        type: 'text',
        value: `Fired transport close(${code}). Watch debug.log for [bridge:repl] recovery.`,
      }
    }

    case 'poll': {
      if (a === 'transient') {
        // 注入 axios 风格的瞬态拒绝（5xx/网络错误），并立即唤醒轮询循环以触发故障
        h.injectFault({
          method: 'pollForWork',
          kind: 'transient',
          status: 503,
          count: 1,
        })
        h.wakePollLoop()
        return {
          type: 'text',
          value:
            'Next poll will throw a transient (axios rejection). Poll loop woken.',
        }
      }
      const status = Number(a)
      if (!Number.isFinite(status)) {
        return {
          type: 'text',
          value: `poll: need 'transient' or a status code\n${USAGE}`,
        }
      }
      // Default to what the server ACTUALLY sends for 404 (BQ-verified),
      // so `/bridge-kick poll 404` reproduces the real 147K/week state.
      // 404 默认使用 not_found_error，与服务器实际返回保持一致（每周 147K 次真实错误）
      const errorType =
        b ?? (status === 404 ? 'not_found_error' : 'authentication_error')
      h.injectFault({
        method: 'pollForWork',
        kind: 'fatal',
        status,
        errorType,
        count: 1,
      })
      // 唤醒轮询循环，使注入的故障立即生效
      h.wakePollLoop()
      return {
        type: 'text',
        value: `Next poll will throw BridgeFatalError(${status}, ${errorType}). Poll loop woken.`,
      }
    }

    case 'register': {
      if (a === 'fatal') {
        // 注入 403 权限错误，模拟终端性注册失败（无法恢复）
        h.injectFault({
          method: 'registerBridgeEnvironment',
          kind: 'fatal',
          status: 403,
          errorType: 'permission_error',
          count: 1,
        })
        return {
          type: 'text',
          value:
            'Next registerBridgeEnvironment will 403. Trigger with close/reconnect.',
        }
      }
      // 注入瞬态注册失败，支持指定连续失败次数 N（默认 1 次）
      const n = Number(b) || 1
      h.injectFault({
        method: 'registerBridgeEnvironment',
        kind: 'transient',
        status: 503,
        count: n,
      })
      return {
        type: 'text',
        value: `Next ${n} registerBridgeEnvironment call(s) will transient-fail. Trigger with close/reconnect.`,
      }
    }

    case 'reconnect-session': {
      // 注入会话重连失败，触发 doReconnect 从 Strategy 1 回退到 Strategy 2
      // 注入 2 次是因为 doReconnect 内部会重试一次
      h.injectFault({
        method: 'reconnectSession',
        kind: 'fatal',
        status: 404,
        errorType: 'not_found_error',
        count: 2,
      })
      return {
        type: 'text',
        value:
          'Next 2 POST /bridge/reconnect calls will 404. doReconnect Strategy 1 falls through to Strategy 2.',
      }
    }

    case 'heartbeat': {
      // 注入心跳失败，测试 onHeartbeatFatal 回调是否正确触发工作状态清理
      const status = Number(a) || 401
      h.injectFault({
        method: 'heartbeatWork',
        kind: 'fatal',
        status,
        // 401 映射认证错误，其他状态码映射为未找到错误
        errorType: status === 401 ? 'authentication_error' : 'not_found_error',
        count: 1,
      })
      return {
        type: 'text',
        value: `Next heartbeat will ${status}. Watch for onHeartbeatFatal → work-state teardown.`,
      }
    }

    case 'reconnect': {
      // 直接调用 doReconnect，效果等同于发送 SIGUSR2 信号
      h.forceReconnect()
      return {
        type: 'text',
        value: 'Called reconnectEnvironmentWithSession(). Watch debug.log.',
      }
    }

    case 'status': {
      // 输出 Bridge 当前状态的描述性字符串，用于诊断
      return { type: 'text', value: h.describe() }
    }

    default:
      // 未知子命令，展示完整使用说明
      return { type: 'text', value: USAGE }
  }
}

/**
 * /bridge-kick 命令注册描述符。
 *
 * isEnabled 通过环境变量 USER_TYPE=ant 限制仅 Anthropic 内部员工可用，
 * supportsNonInteractive=false 确保此调试命令只能在交互式会话中运行。
 */
const bridgeKick = {
  type: 'local',
  name: 'bridge-kick',
  description: 'Inject bridge failure states for manual recovery testing',
  // 仅对 Anthropic 内部员工（ant 用户类型）启用
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default bridgeKick
