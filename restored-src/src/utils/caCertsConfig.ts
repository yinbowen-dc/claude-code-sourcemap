/**
 * 基于配置文件的 NODE_EXTRA_CA_CERTS 填充模块。
 *
 * 在 Claude Code 系统中，该模块在 CLI 启动时将 settings.json 中配置的
 * NODE_EXTRA_CA_CERTS 路径写入 process.env，供 caCerts.ts 在 TLS 握手前读取。
 *
 * 从 caCerts.ts 拆分的原因：config.ts → file.ts → permissions/filesystem.ts → commands.ts
 * 的传递依赖会引入约 5300 个模块（REPL、React、所有 slash 命令），
 * 使 proxy.ts/mtls.ts 的 Agent SDK bundle 从约 0.4 MB 膨胀到约 10.8 MB。
 * 该模块是唯一允许导入 config.ts 的地方，且仅由 init.ts 导入。
 *
 * - applyExtraCACertsFromConfig()：在 init 阶段尽早调用，将配置文件中的路径写入 process.env
 * - getExtraCertsPathFromConfig()（内部）：从 ~/.claude.json 和 ~/.claude/settings.json 读取路径，
 *   仅读取用户可控文件，避免恶意项目在信任弹窗前注入 CA 证书
 */

import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * Apply NODE_EXTRA_CA_CERTS from settings.json to process.env early in init,
 * BEFORE any TLS connections are made.
 *
 * Bun caches the TLS certificate store at process boot via BoringSSL.
 * If NODE_EXTRA_CA_CERTS isn't set in the environment at boot, Bun won't
 * include the custom CA cert. By setting it on process.env before any
 * TLS connections, we give Bun a chance to pick it up (if the cert store
 * is lazy-initialized) and ensure Node.js compatibility.
 *
 * This is safe to call before the trust dialog because we only read from
 * user-controlled files (~/.claude/settings.json and ~/.claude.json),
 * not from project-level settings.
 */
export function applyExtraCACertsFromConfig(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    return // Already set in environment, nothing to do
  }
  const configPath = getExtraCertsPathFromConfig()
  if (configPath) {
    process.env.NODE_EXTRA_CA_CERTS = configPath
    logForDebugging(
      `CA certs: Applied NODE_EXTRA_CA_CERTS from config to process.env: ${configPath}`,
    )
  }
}

/**
 * Read NODE_EXTRA_CA_CERTS from settings/config as a fallback.
 *
 * NODE_EXTRA_CA_CERTS is categorized as a non-safe env var (it allows
 * trusting attacker-controlled servers), so it's only applied to process.env
 * after the trust dialog. But we need the CA cert early to establish the TLS
 * connection to an HTTPS proxy during init().
 *
 * We read from global config (~/.claude.json) and user settings
 * (~/.claude/settings.json). These are user-controlled files that don't
 * require trust approval.
 */
function getExtraCertsPathFromConfig(): string | undefined {
  try {
    const globalConfig = getGlobalConfig()
    const globalEnv = globalConfig?.env
    // Only read from user-controlled settings (~/.claude/settings.json),
    // not project-level settings, to prevent malicious projects from
    // injecting CA certs before the trust dialog.
    const settings = getSettingsForSource('userSettings')
    const settingsEnv = settings?.env

    logForDebugging(
      `CA certs: Config fallback - globalEnv keys: ${globalEnv ? Object.keys(globalEnv).join(',') : 'none'}, settingsEnv keys: ${settingsEnv ? Object.keys(settingsEnv).join(',') : 'none'}`,
    )

    // Settings override global config (same precedence as applyConfigEnvironmentVariables)
    const path =
      settingsEnv?.NODE_EXTRA_CA_CERTS || globalEnv?.NODE_EXTRA_CA_CERTS
    if (path) {
      logForDebugging(
        `CA certs: Found NODE_EXTRA_CA_CERTS in config/settings: ${path}`,
      )
    }
    return path
  } catch (error) {
    logForDebugging(`CA certs: Config fallback failed: ${error}`, {
      level: 'error',
    })
    return undefined
  }
}
