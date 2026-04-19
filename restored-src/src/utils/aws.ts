/**
 * AWS 凭据工具函数模块。
 *
 * 在 Claude Code 系统中，该模块提供 AWS Bedrock 集成所需的凭据验证与缓存管理功能：
 * - AwsCredentials / AwsStsOutput 类型定义
 * - isValidAwsStsOutput()：校验 AWS STS assume-role 输出格式
 * - isAwsCredentialsProviderError()：判断是否为凭据提供者错误
 * - checkStsCallerIdentity()：验证 STS caller identity（连通性检测）
 * - clearAwsIniCache()：强制刷新 ~/.aws/credentials INI 文件缓存
 */
import { logForDebugging } from './debug.js'

/** AWS short-term credentials format. */
export type AwsCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  Expiration?: string
}

/** Output from `aws sts get-session-token` or `aws sts assume-role`. */
export type AwsStsOutput = {
  Credentials: AwsCredentials
}

type AwsError = {
  name: string
}

/** 判断给定错误是否为 AWS SDK 凭据提供者错误（CredentialsProviderError）。 */
export function isAwsCredentialsProviderError(err: unknown) {
  return (err as AwsError | undefined)?.name === 'CredentialsProviderError'
}

/**
 * AWS STS assume-role 输出格式的类型守卫（type guard）。
 * 用于验证从外部来源（如 JSON 文件或 STS API 响应）获得的对象是否符合 AwsStsOutput 格式。
 */
export function isValidAwsStsOutput(obj: unknown): obj is AwsStsOutput {
  if (!obj || typeof obj !== 'object') {
    return false
  }

  const output = obj as Record<string, unknown>

  // 检查 Credentials 字段是否存在且为对象
  if (!output.Credentials || typeof output.Credentials !== 'object') {
    return false
  }

  const credentials = output.Credentials as Record<string, unknown>

  // 验证三个必填凭据字段均为非空字符串
  return (
    typeof credentials.AccessKeyId === 'string' &&
    typeof credentials.SecretAccessKey === 'string' &&
    typeof credentials.SessionToken === 'string' &&
    credentials.AccessKeyId.length > 0 &&
    credentials.SecretAccessKey.length > 0 &&
    credentials.SessionToken.length > 0
  )
}

/**
 * 通过 STS GetCallerIdentity 接口验证当前 AWS 凭据是否有效。
 * 调用成功表示凭据可用；抛出错误表示认证失败或网络不通。
 * 用于 Bedrock 认证流程中的连通性检测。
 */
export async function checkStsCallerIdentity(): Promise<void> {
  const { STSClient, GetCallerIdentityCommand } = await import(
    '@aws-sdk/client-sts'
  )
  // 使用默认凭据提供者链发送 GetCallerIdentity 请求；成功则静默返回
  await new STSClient().send(new GetCallerIdentityCommand({}))
}

/**
 * 强制刷新 ~/.aws/credentials INI 文件缓存。
 * AWS SDK 会缓存从 INI 文件读取的凭据；调用此函数可确保外部更新（如 aws configure）
 * 被立即感知，无需重启进程。
 * 若没有配置任何凭据，刷新操作会失败，但此为预期行为，静默忽略。
 */
export async function clearAwsIniCache(): Promise<void> {
  try {
    logForDebugging('Clearing AWS credential provider cache')
    const { fromIni } = await import('@aws-sdk/credential-providers')
    // ignoreCache: true 跳过内存缓存，重新读取文件并更新全局缓存
    const iniProvider = fromIni({ ignoreCache: true })
    await iniProvider() // 触发文件重新读取，更新全局文件缓存
    logForDebugging('AWS credential provider cache refreshed')
  } catch (_error) {
    // 静默忽略错误——若未配置凭据，刷新操作必然失败，这是正常情况
    logForDebugging(
      'Failed to clear AWS credential cache (this is expected if no credentials are configured)',
    )
  }
}
