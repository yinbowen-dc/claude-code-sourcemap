/**
 * telemetryAttributes.ts — OpenTelemetry 公共属性构建器
 *
 * 在 Claude Code 的可观测性体系中，每个指标（Metric）、追踪（Trace）和
 * 日志（Log）都需要附带一组公共的上下文属性，用于在后端（如 Prometheus、
 * BigQuery）进行过滤和聚合。
 *
 * 本文件负责：
 *   1. 定义各属性的基数（Cardinality）控制默认值
 *   2. 读取环境变量（OTEL_METRICS_INCLUDE_*）覆盖默认值
 *   3. 构建并返回标准属性对象，供 MeterProvider / TracerProvider 使用
 *
 * 属性列表：
 *   - user.id           : 本地随机生成的匿名用户 ID（始终包含）
 *   - session.id        : 本次会话 ID（可通过环境变量关闭以降低基数）
 *   - app.version       : 应用版本号（默认关闭，开启会大幅增加基数）
 *   - organization.id   : OAuth 组织 UUID（仅 OAuth 用户）
 *   - user.email        : OAuth 账户邮箱（仅 OAuth 用户）
 *   - user.account_uuid : OAuth 账户 UUID（可通过环境变量关闭）
 *   - user.account_id   : 带标签格式的账户 ID
 *   - terminal.type     : 终端类型（如 iTerm2 / VS Code 等）
 */

import type { Attributes } from '@opentelemetry/api'
import { getSessionId } from 'src/bootstrap/state.js'
import { getOauthAccountInfo } from './auth.js'
import { getOrCreateUserID } from './config.js'
import { envDynamic } from './envDynamic.js'
import { isEnvTruthy } from './envUtils.js'
import { toTaggedId } from './taggedId.js'

/**
 * 各指标属性的基数控制默认配置。
 *
 * 基数（Cardinality）越高，后端存储和查询成本越高：
 *   - session.id   : 每次会话唯一，基数极高，但默认开启（用于调试）
 *   - app.version  : 版本迭代频繁，基数中等，默认关闭
 *   - account_uuid : 用户级别，基数较高，默认开启
 */
const METRICS_CARDINALITY_DEFAULTS = {
  OTEL_METRICS_INCLUDE_SESSION_ID: true,   // 默认包含 session ID
  OTEL_METRICS_INCLUDE_VERSION: false,     // 默认不包含版本号（避免高基数）
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: true, // 默认包含账户 UUID
}

/**
 * 判断某个属性是否应当包含在遥测数据中。
 *
 * 优先级：环境变量 > 代码默认值。
 * 使用 isEnvTruthy 解析环境变量，支持 '1' / 'true' / 'yes' 等格式。
 *
 * @param envVar - 对应的环境变量名（OTEL_METRICS_INCLUDE_* 系列）
 * @returns true 表示应包含该属性
 */
function shouldIncludeAttribute(
  envVar: keyof typeof METRICS_CARDINALITY_DEFAULTS,
): boolean {
  const defaultValue = METRICS_CARDINALITY_DEFAULTS[envVar]
  const envValue = process.env[envVar]

  // 环境变量未设置时使用代码中的默认值
  if (envValue === undefined) {
    return defaultValue
  }

  // 环境变量已设置时，解析其布尔含义
  return isEnvTruthy(envValue)
}

/**
 * 构建并返回用于 OTel 指标/追踪的公共属性对象。
 *
 * 执行流程：
 *   1. 获取匿名用户 ID 和会话 ID（始终包含）
 *   2. 根据基数配置决定是否包含 session.id 和 app.version
 *   3. 检查 OAuth 账户信息，若存在则附加组织、邮箱、账户 UUID 等字段
 *   4. 检查终端类型，若存在则附加 terminal.type
 *
 * @returns OTel Attributes 对象，可直接传入 meter.createCounter().add() 等方法
 */
export function getTelemetryAttributes(): Attributes {
  // 获取本地匿名用户 ID（若不存在则自动创建并持久化）
  const userId = getOrCreateUserID()
  // 获取当前会话 ID（由 bootstrap/state.ts 管理）
  const sessionId = getSessionId()

  // user.id 始终包含，是所有遥测数据的基础维度
  const attributes: Attributes = {
    'user.id': userId,
  }

  // 根据配置决定是否包含 session ID（高基数，但有助于调试）
  if (shouldIncludeAttribute('OTEL_METRICS_INCLUDE_SESSION_ID')) {
    attributes['session.id'] = sessionId
  }
  // 根据配置决定是否包含应用版本号（使用构建时宏注入）
  if (shouldIncludeAttribute('OTEL_METRICS_INCLUDE_VERSION')) {
    attributes['app.version'] = MACRO.VERSION
  }

  // 仅在使用 OAuth 认证时才包含 OAuth 账户相关数据
  const oauthAccount = getOauthAccountInfo()
  if (oauthAccount) {
    const orgId = oauthAccount.organizationUuid
    const email = oauthAccount.emailAddress
    const accountUuid = oauthAccount.accountUuid

    // 组织 ID 和邮箱不受基数控制，有则附加
    if (orgId) attributes['organization.id'] = orgId
    if (email) attributes['user.email'] = email

    // 账户 UUID 受基数控制（默认开启，可通过环境变量关闭）
    if (
      accountUuid &&
      shouldIncludeAttribute('OTEL_METRICS_INCLUDE_ACCOUNT_UUID')
    ) {
      attributes['user.account_uuid'] = accountUuid
      // 优先使用环境变量中预设的带标签 ID，否则动态生成
      attributes['user.account_id'] =
        process.env.CLAUDE_CODE_ACCOUNT_TAGGED_ID ||
        toTaggedId('user', accountUuid)
    }
  }

  // 若检测到终端类型，附加 terminal.type 属性
  if (envDynamic.terminal) {
    attributes['terminal.type'] = envDynamic.terminal
  }

  return attributes
}
