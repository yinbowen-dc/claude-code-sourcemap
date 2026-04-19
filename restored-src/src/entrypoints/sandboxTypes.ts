/**
 * 沙盒配置类型定义（sandboxTypes.ts）
 *
 * 【在系统中的位置】
 * 本文件是 Claude Code 沙盒功能的"类型单一来源（single source of truth）"，
 * 位于 entrypoints/ 目录下，同时被两个消费方引用：
 *
 *   SDK 公共类型层      SDK 配置验证层
 *       ↑                    ↑
 *   sdk/coreTypes.ts    settings 验证器
 *       └─────────────────────┘
 *               ↑
 *         sandboxTypes.ts  ← 本文件
 *
 * 【主要职责】
 * 1. 通过 Zod Schema 定义沙盒的网络配置、文件系统配置和总设置的运行时验证规则
 * 2. 通过 TypeScript 类型推断（z.infer）自动导出对应的静态类型，避免类型手动维护
 * 3. 使用 lazySchema 包装所有 Schema，防止循环导入导致的初始化问题
 *
 * 【沙盒机制简述】
 * Claude Code 的沙盒功能通过系统调用过滤（macOS sandbox / Linux seccomp）限制
 * 工具执行时的网络访问和文件读写范围，防止工具在用户不知情的情况下进行越权操作。
 * 本文件定义的三个 Schema 对应沙盒配置的三个层级：
 * - SandboxNetworkConfigSchema：控制哪些域名/端口/Unix 套接字可访问
 * - SandboxFilesystemConfigSchema：控制哪些文件路径可读/可写
 * - SandboxSettingsSchema：总开关及高级配置（含两个子 Schema 的组合）
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * 沙盒网络配置 Schema
 *
 * 【Schema 作用】
 * 定义工具执行时允许或拒绝的网络访问范围。
 * 整个对象为可选（.optional()），未配置时使用平台默认的网络限制。
 *
 * 字段说明：
 * - allowedDomains：允许访问的域名白名单
 * - allowManagedDomainsOnly：仅托管设置中配置的域名生效（用于企业管控场景）
 * - allowUnixSockets：macOS 专属——允许访问的 Unix 套接字路径列表
 * - allowAllUnixSockets：全平台禁用 Unix 套接字过滤（降级安全策略）
 * - allowLocalBinding：允许绑定本地端口（本地服务器开发场景）
 * - httpProxyPort：沙盒内使用的 HTTP 代理端口
 * - socksProxyPort：沙盒内使用的 SOCKS 代理端口
 */
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      // 允许访问的域名列表；未列出的域名将被拒绝
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. ' +
            'User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources.',
        ),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe(
          'macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).',
        ),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe(
          'If true, allow all Unix sockets (disables blocking on both platforms).',
        ),
      // 允许沙盒内进程监听本地端口（例如启动本地开发服务器）
      allowLocalBinding: z.boolean().optional(),
      // HTTP 代理端口：沙盒内流量通过此端口转发（用于 MITM 拦截或流量监控）
      httpProxyPort: z.number().optional(),
      // SOCKS 代理端口：与 httpProxyPort 类似，供 SOCKS5 代理使用
      socksProxyPort: z.number().optional(),
    })
    .optional(), // 整个网络配置块为可选，未设置时使用平台默认策略
)

/**
 * 沙盒文件系统配置 Schema
 *
 * 【Schema 作用】
 * 定义工具执行时允许或拒绝的文件读写路径范围。
 * 整个对象为可选（.optional()），未配置时仅由工具权限规则（Edit/Read allow/deny）控制。
 *
 * 优先级规则（从高到低）：
 * 1. allowRead（在 denyRead 区域内的例外允许）
 * 2. denyRead / denyWrite（明确拒绝）
 * 3. allowWrite / allowRead（明确允许，与工具权限规则合并）
 *
 * 字段说明：
 * - allowWrite：除工具权限规则外，额外允许写入的路径列表
 * - denyWrite：额外拒绝写入的路径列表
 * - denyRead：额外拒绝读取的路径列表
 * - allowRead：在 denyRead 范围内的例外允许路径
 * - allowManagedReadPathsOnly：企业托管场景——仅 policySettings 中的 allowRead 生效
 */
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to allow writing within the sandbox. ' +
            'Merged with paths from Edit(...) allow permission rules.',
        ),
      denyWrite: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny writing within the sandbox. ' +
            'Merged with paths from Edit(...) deny permission rules.',
        ),
      denyRead: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny reading within the sandbox. ' +
            'Merged with paths from Read(...) deny permission rules.',
        ),
      allowRead: z
        .array(z.string())
        .optional()
        .describe(
          'Paths to re-allow reading within denyRead regions. ' +
            'Takes precedence over denyRead for matching paths.',
        ),
      // 企业托管专用：强制只使用策略级别的 allowRead，忽略用户/项目级配置
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (set in managed settings), only allowRead paths from policySettings are used.',
        ),
    })
    .optional(), // 整个文件系统配置块为可选，未设置时由工具权限规则全权控制
)

/**
 * 沙盒总设置 Schema
 *
 * 【Schema 作用】
 * 沙盒功能的顶层配置对象，整合网络和文件系统子配置，
 * 并提供沙盒启用/禁用开关及各类行为控制选项。
 *
 * 注意：本 Schema 使用 .passthrough() 以允许未文档化的字段（如 enabledPlatforms）
 * 透明通过，避免在 Zod 解析时因未知字段报错，同时不破坏现有消费方的配置。
 *
 * 【enabledPlatforms 字段说明】
 * 这是一个刻意未在 Schema 中显式声明的字段，通过 .passthrough() 读取。
 * 设计背景：NVIDIA 等企业客户需要先在 macOS 启用沙盒/自动允许 Bash，
 * 而 Linux/WSL 沙盒支持较新，尚未完全测试。enabledPlatforms: ["macos"]
 * 允许他们在非 macOS 平台上禁用沙盒，待时机成熟再扩展。
 *
 * 字段说明：
 * - enabled：全局沙盒开关
 * - failIfUnavailable：沙盒不可用时是否报错退出（企业硬门控场景）
 * - autoAllowBashIfSandboxed：沙盒模式下自动允许 Bash 工具执行
 * - allowUnsandboxedCommands：是否允许通过 dangerouslyDisableSandbox 参数绕过沙盒
 * - network：嵌套的网络配置（SandboxNetworkConfigSchema）
 * - filesystem：嵌套的文件系统配置（SandboxFilesystemConfigSchema）
 * - ignoreViolations：按工具名称分类的违规忽略规则
 * - enableWeakerNestedSandbox：允许嵌套沙盒使用较弱的隔离策略
 * - enableWeakerNetworkIsolation：macOS 专属——允许访问 trustd 服务以支持 TLS 证书验证
 * - excludedCommands：不进入沙盒的命令列表
 * - ripgrep：自定义 ripgrep 二进制路径配置
 */
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      // 全局沙盒开关；false 或未设置时沙盒不激活
      enabled: z.boolean().optional(),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Exit with an error at startup if sandbox.enabled is true but the sandbox cannot start ' +
            '(missing dependencies, unsupported platform, or platform not in enabledPlatforms). ' +
            'When false (default), a warning is shown and commands run unsandboxed. ' +
            'Intended for managed-settings deployments that require sandboxing as a hard gate.',
        ),
      // Note: enabledPlatforms is an undocumented setting read via .passthrough()
      // It restricts sandboxing to specific platforms (e.g., ["macos"]).
      //
      // Added to unblock NVIDIA enterprise rollout: they want to enable
      // autoAllowBashIfSandboxed but only on macOS initially, since Linux/WSL
      // sandbox support is newer and less battle-tested. This allows them to
      // set enabledPlatforms: ["macos"] to disable sandbox (and auto-allow)
      // on other platforms until they're ready to expand.
      // 沙盒开启时自动批准 Bash 工具调用，无需用户逐次确认
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe(
          'Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. ' +
            'When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. ' +
            'Default: true.',
        ),
      // 嵌套的网络访问控制配置
      network: SandboxNetworkConfigSchema(),
      // 嵌套的文件系统读写控制配置
      filesystem: SandboxFilesystemConfigSchema(),
      // 按工具名称分类的违规忽略规则：{ "Bash": ["/tmp/allowed-path"] }
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      // 允许嵌套沙盒（子进程再运行沙盒命令）时使用较弱的隔离策略，以兼容特定工具链
      enableWeakerNestedSandbox: z.boolean().optional(),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe(
          'macOS only: Allow access to com.apple.trustd.agent in the sandbox. ' +
            'Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates ' +
            'when using httpProxyPort with a MITM proxy and custom CA. ' +
            '**Reduces security** — opens a potential data exfiltration vector through the trustd service. Default: false',
        ),
      // 不纳入沙盒隔离的命令名称列表（按需豁免特定命令）
      excludedCommands: z.array(z.string()).optional(),
      ripgrep: z
        .object({
          command: z.string(),     // 自定义 ripgrep 可执行文件路径
          args: z.array(z.string()).optional(), // 附加的命令行参数
        })
        .optional()
        .describe('Custom ripgrep configuration for bundled ripgrep support'),
    })
    // .passthrough()：允许未在 Schema 中声明的字段（如 enabledPlatforms）透明通过，
    // 防止 Zod 在解析时因未知字段抛出错误
    .passthrough(),
)

// ============================================================================
// 从 Schema 推断出的 TypeScript 静态类型
// 以下类型由 z.infer<> 自动生成，与 Schema 定义保持严格同步，无需手动维护
// ============================================================================

// 沙盒总设置类型（包含所有可选字段及 passthrough 允许的未知字段）
export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>

// 网络配置类型（去除 Optional 包装，确保使用方获得非 undefined 的对象类型）
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>

// 文件系统配置类型（去除 Optional 包装）
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>

// 违规忽略规则类型：从 SandboxSettings 中提取 ignoreViolations 字段类型
// 格式：{ [toolName: string]: string[] }
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>
