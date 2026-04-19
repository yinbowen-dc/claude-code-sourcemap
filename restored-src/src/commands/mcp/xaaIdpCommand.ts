/**
 * `claude mcp xaa` — XAA（SEP-990）IdP 连接管理模块
 *
 * 在 Claude Code 的 MCP 命令体系中，本文件注册 `claude mcp xaa` 子命令组，
 * 用于管理 XAA（跨应用认证，SEP-990 规范）所需的 IdP（身份提供商）连接配置。
 *
 * XAA IdP 连接为**用户级别**配置：只需配置一次，所有启用了 `--xaa` 标志的
 * MCP 服务器均可复用同一份 IdP 凭据，无需为每台服务器单独配置。
 *
 * 存储模型：
 * - 非密钥信息（issuer、clientId、callbackPort）保存在 `settings.xaaIdp`（明文配置文件）
 * - 密钥信息（client_secret、id_token 缓存）保存在系统密钥链（keychain），以发行者 URL 为 key
 * - 两者共同构成一个独立于各 MCP 服务器 AS（授权服务器）密钥的信任域
 *
 * 子命令生命周期：
 * 1. `xaa setup`  — 配置 IdP 连接参数（issuer、client_id、可选 client_secret 和回调端口）
 * 2. `xaa login`  — 执行 OIDC 浏览器登录流程，将 id_token 缓存到 keychain 供 MCP 服务器静默使用
 * 3. `xaa show`   — 展示当前 IdP 配置及 keychain 存储状态（是否已存储 secret / 是否已登录）
 * 4. `xaa clear`  — 清除全部 IdP 配置及 keychain 中的 secret 和 id_token 缓存
 */
import type { Command } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
} from '../../services/mcp/xaaIdpLogin.js'
import { errorMessage } from '../../utils/errors.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

/**
 * 注册 `claude mcp xaa` 子命令组
 *
 * 在传入的 `mcp` Commander 命令对象上挂载 `xaa` 子命令，并依次注册以下四个操作子命令：
 * - `setup`：验证参数合法性后写入 settings.xaaIdp，并可选将 client_secret 存入 keychain；
 *            同时清理因 issuer/clientId 变更而过期的旧 keychain slot，避免残留脏数据
 * - `login`：检查 IdP 配置是否存在 → 支持直接注入 id_token（测试路径）→
 *            检查缓存有效性 → 执行 OIDC 浏览器授权流程
 * - `show`：读取 settings.xaaIdp 并查询 keychain，以人类可读格式输出当前连接状态
 * - `clear`：先写 settings（xaaIdp → undefined），成功后再清除 keychain，
 *            保证两步操作原子性顺序，避免"settings 已删但 keychain 未清"的半删除状态
 *
 * @param mcp - 已注册的 `claude mcp` Commander 命令对象，`xaa` 子命令将挂载于此
 */
export function registerMcpXaaIdpCommand(mcp: Command): void {
  // 在 mcp 父命令下创建 xaa 子命令组
  const xaaIdp = mcp
    .command('xaa')
    .description('Manage the XAA (SEP-990) IdP connection')

  xaaIdp
    .command('setup')
    .description(
      'Configure the IdP connection (one-time setup for all XAA-enabled servers)',
    )
    .requiredOption('--issuer <url>', 'IdP issuer URL (OIDC discovery)')
    .requiredOption('--client-id <id>', "Claude Code's client_id at the IdP")
    .option(
      '--client-secret',
      'Read IdP client secret from MCP_XAA_IDP_CLIENT_SECRET env var',
    )
    .option(
      '--callback-port <port>',
      'Fixed loopback callback port (only if IdP does not honor RFC 8252 port-any matching)',
    )
    .action(options => {
      // 在任何写操作之前完成所有参数校验。若校验在写入后才失败，
      // 会造成 settings 已写但 keychain 未写的不一致状态，难以排查。
      // updateSettingsForSource 写入时不做 schema 校验；非 URL 格式的 issuer
      // 若写入磁盘，下次启动时 SettingsSchema 的 .url() 校验将失败，
      // 导致 parseSettingsFile 返回 { settings: null }，整个 userSettings 被丢弃。
      let issuerUrl: URL
      try {
        // 尝试将 --issuer 参数解析为合法 URL；非法格式立即退出并报错
        issuerUrl = new URL(options.issuer)
      } catch {
        return cliError(
          `Error: --issuer must be a valid URL (got "${options.issuer}")`,
        )
      }
      // OIDC 发现端点（.well-known/openid-configuration）和 token 交换运行于此 host。
      // 仅允许回环地址（localhost / 127.0.0.1 / ::1）使用 http://，用于本地合规测试环境；
      // 其他非 https 协议会导致 client_secret 和授权码在明文信道上泄露。
      if (
        issuerUrl.protocol !== 'https:' &&
        !(
          issuerUrl.protocol === 'http:' &&
          (issuerUrl.hostname === 'localhost' ||
            issuerUrl.hostname === '127.0.0.1' ||
            issuerUrl.hostname === '[::1]')
        )
      ) {
        return cliError(
          `Error: --issuer must use https:// (got "${issuerUrl.protocol}//${issuerUrl.host}")`,
        )
      }
      // 将 --callback-port 字符串解析为整数；未传入时为 undefined（使用 RFC 8252 随机端口）
      const callbackPort = options.callbackPort
        ? parseInt(options.callbackPort, 10)
        : undefined
      // callbackPort <= 0 会导致 Zod 的 .positive() 校验失败，触发与上述 issuer 相同的
      // settings 污染问题（parseSettingsFile 返回 null，丢弃整个配置）
      if (
        callbackPort !== undefined &&
        (!Number.isInteger(callbackPort) || callbackPort <= 0)
      ) {
        return cliError('Error: --callback-port must be a positive integer')
      }
      // 仅在传入 --client-secret 标志时读取环境变量；标志未传则 secret 为 undefined（PKCE-only 模式）
      const secret = options.clientSecret
        ? process.env.MCP_XAA_IDP_CLIENT_SECRET
        : undefined
      // 传了 --client-secret 但环境变量未设置时，报错提示用户
      if (options.clientSecret && !secret) {
        return cliError(
          'Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var',
        )
      }

      // 在 settings 覆写之前读取旧配置，以便在写入成功后清理过期的 keychain slot。
      // `clear` 命令无法在事后处理——它读取的是写入后的新 settings.xaaIdp。
      const old = getXaaIdpSettings()
      const oldIssuer = old?.issuer
      const oldClientId = old?.clientId

      // callbackPort 必须显式出现在对象中（即便值为 undefined），
      // 因为 mergeWith 使用深合并，仅 undefined 值会触发删除语义；
      // 若用条件展开（conditional spread）跳过 callbackPort，旧的固定端口会被保留到新配置中。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: {
          issuer: options.issuer,
          clientId: options.clientId,
          callbackPort,
        },
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }

      // 仅在 settings 写入成功后清理过期 keychain slot，
      // 否则写入失败时会出现"settings 指向旧 issuer 但其 secret 已被清除"的不一致状态。
      // 使用 issuerKey() 做规范化比较（尾部斜杠、大小写差异均归一为同一 slot）。
      if (oldIssuer) {
        if (issuerKey(oldIssuer) !== issuerKey(options.issuer)) {
          // issuer 已变更：旧 issuer 的 id_token 和 client_secret 均已失效，全部清除
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        } else if (oldClientId !== options.clientId) {
          // 同一 issuer slot 但 OAuth client 注册已变更：
          // 缓存的 id_token 的 aud claim 和存储的 secret 均属于旧 client，
          // 若不清除，`xaa login` 会用 {新 clientId, 旧 secret} 请求，收到 invalid_client 报错；
          // 下游 SEP-990 exchange 也会因 aud 校验失败而报错。
          // clientId 未变时保留两者：不带 --client-secret 的 re-setup 语义为"仅调整端口，保留 secret"。
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        }
      }

      // 若提供了 client_secret，将其存入系统 keychain（以 issuer 为索引）
      if (secret) {
        const { success, warning } = saveIdpClientSecret(options.issuer, secret)
        if (!success) {
          // keychain 写入失败：settings 已完成但 secret 未存入，提示用户待 keychain 可用后重试
          return cliError(
            `Error: settings written but keychain save failed${warning ? ` — ${warning}` : ''}. ` +
              `Re-run with --client-secret once keychain is available.`,
          )
        }
      }

      // 配置成功，输出确认信息
      cliOk(`XAA IdP connection configured for ${options.issuer}`)
    })

  xaaIdp
    .command('login')
    .description(
      'Cache an IdP id_token so XAA-enabled MCP servers authenticate ' +
        'silently. Default: run the OIDC browser login. With --id-token: ' +
        'write a pre-obtained JWT directly (used by conformance/e2e tests ' +
        'where the mock IdP does not serve /authorize).',
    )
    .option(
      '--force',
      'Ignore any cached id_token and re-login (useful after IdP-side revocation)',
    )
    // TODO(paulc): read the JWT from stdin instead of argv to keep it out of
    // shell history. Fine for conformance (docker exec uses argv directly,
    // no shell parser), but a real user would want `echo $TOKEN | ... --stdin`.
    .option(
      '--id-token <jwt>',
      'Write this pre-obtained id_token directly to cache, skipping the OIDC browser login',
    )
    .action(async options => {
      // 检查是否已配置 IdP 连接；未配置时提示用户先运行 `xaa setup`
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliError(
          "Error: no XAA IdP connection. Run 'claude mcp xaa setup' first.",
        )
      }

      // 直接注入路径（测试/合规场景）：跳过缓存检查和 OIDC 浏览器流程，直接写入 id_token。
      // issuer 从 settings 读取（唯一可信来源），而非单独的命令行参数，避免两者不同步。
      if (options.idToken) {
        const expiresAt = saveIdpIdTokenFromJwt(idp.issuer, options.idToken)
        return cliOk(
          `id_token cached for ${idp.issuer} (expires ${new Date(expiresAt).toISOString()})`,
        )
      }

      // --force 标志：强制清除已缓存的 id_token，重新执行浏览器登录（用于 IdP 端吊销后的刷新）
      if (options.force) {
        clearIdpIdToken(idp.issuer)
      }

      // 检查是否已有有效的缓存 id_token；若有则无需重新登录
      const wasCached = getCachedIdpIdToken(idp.issuer) !== undefined
      if (wasCached) {
        return cliOk(
          `Already logged in to ${idp.issuer} (cached id_token still valid). Use --force to re-login.`,
        )
      }

      // 缓存不存在或已被 --force 清除，执行 OIDC 浏览器授权流程
      process.stdout.write(`Opening browser for IdP login at ${idp.issuer}…\n`)
      try {
        await acquireIdpIdToken({
          idpIssuer: idp.issuer,
          idpClientId: idp.clientId,
          // 从 keychain 读取 client_secret（若未存储则为 undefined，使用 PKCE-only 流程）
          idpClientSecret: getIdpClientSecret(idp.issuer),
          callbackPort: idp.callbackPort,
          // 浏览器未能自动打开时，向 stdout 输出可手动访问的授权 URL
          onAuthorizationUrl: url => {
            process.stdout.write(
              `If the browser did not open, visit:\n  ${url}\n`,
            )
          },
        })
        // 登录成功：id_token 已缓存，后续所有 --xaa MCP 服务器将静默使用此令牌
        cliOk(
          `Logged in. MCP servers with --xaa will now authenticate silently.`,
        )
      } catch (e) {
        // 登录失败：输出错误信息并以非零状态码退出
        cliError(`IdP login failed: ${errorMessage(e)}`)
      }
    })

  xaaIdp
    .command('show')
    .description('Show the current IdP connection config')
    .action(() => {
      // 读取 settings 中保存的 IdP 配置（明文部分）
      const idp = getXaaIdpSettings()
      if (!idp) {
        // 未配置时友好提示，不以错误状态退出
        return cliOk('No XAA IdP connection configured.')
      }
      // 分别查询 keychain，判断 client_secret 和 id_token 是否已存储
      const hasSecret = getIdpClientSecret(idp.issuer) !== undefined
      const hasIdToken = getCachedIdpIdToken(idp.issuer) !== undefined
      // 逐行输出当前 IdP 配置信息
      process.stdout.write(`Issuer:        ${idp.issuer}\n`)
      process.stdout.write(`Client ID:     ${idp.clientId}\n`)
      // callbackPort 为可选项，仅在已设置时输出
      if (idp.callbackPort !== undefined) {
        process.stdout.write(`Callback port: ${idp.callbackPort}\n`)
      }
      // client_secret 不输出实际值，仅显示是否存在于 keychain，保护安全
      process.stdout.write(
        `Client secret: ${hasSecret ? '(stored in keychain)' : '(not set — PKCE-only)'}\n`,
      )
      // 显示当前登录状态（id_token 是否已缓存）
      process.stdout.write(
        `Logged in:     ${hasIdToken ? 'yes (id_token cached)' : "no — run 'claude mcp xaa login'"}\n`,
      )
      cliOk()
    })

  xaaIdp
    .command('clear')
    .description('Clear the IdP connection config and cached id_token')
    .action(() => {
      // 先读取当前 issuer，以便在 settings 覆写后仍能定位正确的 keychain slot
      const idp = getXaaIdpSettings()
      // updateSettingsForSource 使用 mergeWith 深合并：显式设置 undefined 才触发 key 删除语义，
      // 而非省略 key（省略会被忽略，旧值会被保留）
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: undefined,
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }
      // 仅在 settings 写入成功后才清除 keychain，与 `setup` 的旧 slot 清理保持相同的操作顺序；
      // 若 settings 写入失败而先清除 keychain，会导致"settings 指向该 IdP 但 secret 已丢失"的不一致状态
      if (idp) {
        // 清除 keychain 中的 id_token 缓存
        clearIdpIdToken(idp.issuer)
        // 清除 keychain 中的 client_secret
        clearIdpClientSecret(idp.issuer)
      }
      // 清除成功，输出确认信息
      cliOk('XAA IdP connection cleared')
    })
}
