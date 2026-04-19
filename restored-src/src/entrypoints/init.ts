/**
 * 系统全局初始化模块（init.ts）
 *
 * 【在系统中的位置】
 * 本文件位于 Claude Code 启动链的核心位置，在 CLI 加载完整命令处理器之前
 * 被调用（通常由 main.tsx 在命令 action handler 开头触发）。
 * 调用链：cli.tsx → main.tsx → init() → 各子系统初始化
 *
 * 【主要职责】
 * 导出经 lodash memoize 包装的 `init()` 函数，确保全局初始化逻辑
 * 在整个进程生命周期中只执行一次，内容包括：
 *   - 配置系统激活与环境变量注入
 *   - 优雅关闭注册
 *   - 首方事件日志初始化（1P event logging）
 *   - OAuth 账户信息预填充
 *   - JetBrains IDE 检测
 *   - Git 仓库检测
 *   - 远程托管配置与策略限制加载
 *   - 全局 mTLS / HTTP 代理配置
 *   - Anthropic API 预连接（TCP/TLS 预热）
 *   - CCR 上游代理初始化
 *   - Windows Shell 路径设置
 *   - LSP 与团队清理注册
 *   - 草稿目录创建
 *
 * 另外导出 `initializeTelemetryAfterTrust()`，在用户接受信任对话框后
 * 异步初始化 OpenTelemetry 遥测，避免在启动关键路径上加载 ~400KB 的 OTLP 模块。
 */
import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remoteManagedSettings/index.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径下动态导入，避免在 init 阶段加载 React
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
// initializeTelemetry 通过 setMeterState() 中的 import() 懒加载，
// 延迟加载约 400KB 的 OpenTelemetry + protobuf 模块，直到遥测真正需要时。
// gRPC 导出器（~700KB，来自 @grpc/grpc-js）在 instrumentation.ts 内部进一步懒加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { isBetaTracingEnabled } from '../utils/telemetry/betaSessionTracing.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'

// initialize1PEventLogging 通过动态 import 延迟加载，避免在启动时加载 OpenTelemetry sdk-logs/resources

// 防止遥测双重初始化的标志位：一旦设为 true 则后续调用直接返回
let telemetryInitialized = false

/**
 * 全局初始化函数（memoized 单例）
 *
 * 【职责】
 * 按序执行所有启动时必须完成的全局初始化步骤。
 * 通过 lodash memoize 包装保证全进程只运行一次，即使被多处调用也不会重复执行。
 *
 * 【初始化顺序】
 * 1. enableConfigs() — 激活配置系统，验证 JSON 格式合法性
 * 2. applySafeConfigEnvironmentVariables() — 在信任对话框之前应用"安全"环境变量
 * 3. applyExtraCACertsFromConfig() — 提前注入额外的 CA 证书，确保在首次 TLS 握手前生效
 * 4. setupGracefulShutdown() — 注册 SIGINT/SIGTERM 处理器，确保进程退出前刷新缓冲区
 * 5. 1P 事件日志初始化（异步，不阻塞后续流程）
 * 6. OAuth 账户信息预填充（异步）
 * 7. JetBrains IDE 检测（异步）
 * 8. Git 仓库检测（异步）
 * 9. 远程托管配置 / 策略限制 loading promise 初始化
 * 10. recordFirstStartTime() — 记录首次启动时间
 * 11. configureGlobalMTLS() — 配置全局 mTLS 证书与密钥
 * 12. configureGlobalAgents() — 配置 HTTP 代理 / mTLS agent
 * 13. preconnectAnthropicApi() — 预热与 Anthropic API 的 TCP/TLS 连接
 * 14. CCR 上游代理初始化（仅 CLAUDE_CODE_REMOTE=true 时）
 * 15. setShellIfWindows() — Windows 环境下设置 git-bash 路径
 * 16. 注册 LSP server cleanup
 * 17. 注册 swarm team cleanup
 * 18. 草稿目录创建（可选，受 isScratchpadEnabled() 门控）
 *
 * 【错误处理】
 * 捕获 ConfigParseError 并展示可交互的错误对话框；
 * 其他错误直接向上抛出。
 */
export const init = memoize(async (): Promise<void> => {
  // 记录初始化开始时间，用于计算总耗时
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 用 try/catch 包裹全部初始化逻辑，以便统一处理配置解析错误
  try {
    const configsStart = Date.now()
    // 激活配置系统：读取并验证所有 settings.json 文件
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在信任对话框弹出之前，仅应用被认为"安全"的环境变量子集
    // 完整的环境变量（包含 managed settings）在信任建立后才应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 将 settings.json 中的 NODE_EXTRA_CA_CERTS 提前注入 process.env，
    // Bun 使用 BoringSSL 在启动时缓存 TLS 证书库，因此必须在首次 TLS 握手前完成
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 注册进程优雅关闭处理器（SIGINT、SIGTERM、process.exit 钩子）
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 异步初始化首方（1P）事件日志系统，不阻塞主流程：
    // - growthbook.js 此时已在模块缓存中，二次 import 无额外开销
    // - 监听 GrowthBook 刷新事件，按需重建日志 provider（配置变更时）
    void Promise.all([
      import('../services/analytics/firstPartyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ]).then(([fp, gb]) => {
      fp.initialize1PEventLogging()
      // 当 GrowthBook 配置刷新时，检查批量日志配置是否变更并按需重建
      gb.onGrowthBookRefresh(() => {
        void fp.reinitialize1PEventLoggingIfConfigChanged()
      })
    })
    profileCheckpoint('init_after_1p_event_logging')

    // 异步预填充 OAuth 账户信息：VSCode 扩展登录后账户信息可能尚未缓存
    void populateOAuthAccountInfoIfNeeded()
    profileCheckpoint('init_after_oauth_populate')

    // 异步检测 JetBrains IDE 环境（结果会缓存，供后续同步访问使用）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测当前 Git 仓库（缓存后用于 gitDiff PR 链接功能）
    void detectCurrentRepository()

    // 提前初始化远程配置的 loading promise，使插件钩子等系统可以 await 它
    // promise 内含超时机制，防止在 Agent SDK 测试场景下死锁
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    // 同样提前初始化策略限制的 loading promise
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间（仅第一次运行时写入，后续调用为 no-op）
    recordFirstStartTime()

    // 配置全局 mTLS 设置（证书路径、私钥等）
    const mtlsStart = Date.now()
    logForDebugging('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP agent（含代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接 Anthropic API：与 action handler 中的 ~100ms 初始化工作并行执行，
    // 将 TCP+TLS 握手时间（~100-200ms）隐藏在后台。
    // 必须在 CA 证书和代理 agent 配置完成之后调用，确保使用正确的传输层。
    // 对于使用代理/mTLS/unix socket/云提供商的场景，SDK 无法复用全局连接池，故跳过。
    preconnectAnthropicApi()

    // CCR 上游代理：启动本地 CONNECT 中继，使 agent 子进程可以访问
    // 企业配置的上游代理（含凭证注入）。
    // 条件：CLAUDE_CODE_REMOTE=true 且 GrowthBook 门控通过；任何错误均 fail-open（静默跳过）
    // 懒加载模块以避免非 CCR 启动时的模块加载开销
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        // 注册代理环境变量获取函数，供子进程 spawn 时注入使用
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        // 上游代理初始化失败时记录警告日志并继续，不影响主流程
        logForDebugging(
          `[init] upstreamproxy init failed: ${err instanceof Error ? err.message : String(err)}; continuing without proxy`,
          { level: 'warn' },
        )
      }
    }

    // Windows 平台特殊处理：将 Shell 设置为 git-bash
    setShellIfWindows()

    // 注册 LSP server 关闭清理（LSP server 的初始化在 main.tsx 中处理 --plugin-dir 后进行）
    registerCleanup(shutdownLspServerManager)

    // 注册 swarm team 清理：修复 gh-32730 中 subagent 创建的 team 不被清理的 bug
    // 使用懒加载因为 swarm 功能处于特性门控下，大多数会话不会创建 team
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 若启用了草稿本功能，确保草稿目录存在（不存在则创建）
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    // 初始化完成，记录总耗时
    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 非交互式会话（如 JSON 消费者、marketplace plugin manager）
      // 不能渲染 Ink 对话框，直接写入 stderr 并退出
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 交互式会话：动态加载并展示配置错误对话框（延迟加载 React 以避免启动开销）
      // 对话框自行处理 process.exit，此处无需额外清理
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
    } else {
      // 非配置错误：向上抛出，由调用方处理
      throw error
    }
  }
})

/**
 * 在用户信任建立后初始化遥测系统
 *
 * 【调用时机】
 * 在信任对话框被接受之后调用，确保遥测数据的收集符合用户意愿。
 *
 * 【两条路径】
 * 1. 远程托管配置路径（isEligibleForRemoteManagedSettings() = true）：
 *    等待远程配置加载完成后，重新应用环境变量（包含远程配置），再初始化遥测。
 *    若同时满足非交互式会话 + beta tracing 启用，则先做一次快速初始化
 *    确保 tracer 在第一次 query 之前就绪。
 * 2. 普通路径：直接异步初始化遥测。
 *
 * 两条路径均由 doInitializeTelemetry() 内的标志位防止双重初始化。
 */
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // SDK / 无头模式 + beta tracing 时，提前初始化一次以确保 tracer 就绪
    // doInitializeTelemetry 内部的标志位会阻止后续异步路径再次初始化
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(error => {
        logForDebugging(
          `[3P telemetry] Eager telemetry init failed (beta tracing): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    }
    logForDebugging(
      '[3P telemetry] Waiting for remote managed settings before telemetry init',
    )
    // 等待远程配置加载完成后，重新应用环境变量并初始化遥测
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        logForDebugging(
          '[3P telemetry] Remote managed settings loaded, initializing telemetry',
        )
        // 重新应用配置环境变量，确保包含远程 managed settings 中的遥测配置
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch(error => {
        logForDebugging(
          `[3P telemetry] Telemetry init failed (remote settings path): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
  } else {
    // 非远程托管配置用户：直接初始化遥测
    void doInitializeTelemetry().catch(error => {
      logForDebugging(
        `[3P telemetry] Telemetry init failed: ${errorMessage(error)}`,
        { level: 'error' },
      )
    })
  }
}

/**
 * 内部遥测初始化实现（带双重初始化防护）
 *
 * 利用模块级 `telemetryInitialized` 标志位防止重复初始化：
 * - 进入时若已初始化，直接返回
 * - 进入时先乐观地设为 true，防止并发调用
 * - 若 setMeterState() 失败，重置标志位，允许后续重试
 */
async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已完成初始化，无需重复执行
    return
  }

  // 在实际初始化之前设置标志，防止并发调用进入重复初始化流程
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 初始化失败时重置标志位，允许后续调用重试
    telemetryInitialized = false
    throw error
  }
}

/**
 * 初始化 OpenTelemetry Meter 状态
 *
 * 【设计要点】
 * 通过动态 import 懒加载 instrumentation.js（~400KB OpenTelemetry + protobuf），
 * 将这部分开销从进程启动关键路径上移除。
 *
 * 初始化成功后：
 * 1. 创建 `AttributedCounter` 工厂：每次调用 `add()` 时都重新获取最新的遥测属性，
 *    确保属性（如用户 ID、模型名称）始终是最新的
 * 2. 调用 setMeter() 将 meter 和工厂函数注入到全局状态（bootstrap/state.js）
 * 3. 为当前会话增加会话计数器
 */
async function setMeterState(): Promise<void> {
  // 懒加载约 400KB 的 OpenTelemetry + protobuf 模块
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  // 初始化 OTLP 遥测（指标、日志、链路追踪）
  const meter = await initializeTelemetry()
  if (meter) {
    // 创建 AttributedCounter 工厂函数：
    // 每次 add() 都重新获取当前遥测属性，与调用方传入的额外属性合并
    const createAttributedCounter = (
      name: string,
      options: MetricOptions,
    ): AttributedCounter => {
      // 使用 meter 创建底层 OpenTelemetry 计数器
      const counter = meter?.createCounter(name, options)

      return {
        add(value: number, additionalAttributes: Attributes = {}) {
          // 每次 add 调用都重新获取最新属性，确保遥测数据的时效性
          const currentAttributes = getTelemetryAttributes()
          // 合并全局属性和调用方传入的额外属性（后者优先级更高）
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    // 将 meter 和 counter 工厂注入全局状态，供整个系统使用
    setMeter(meter, createAttributedCounter)

    // 在此处递增会话计数器：
    // 启动遥测路径在此异步初始化完成前就已运行，
    // 彼时计数器为 null，因此需要在这里补充计数
    getSessionCounter()?.add(1)
  }
}
