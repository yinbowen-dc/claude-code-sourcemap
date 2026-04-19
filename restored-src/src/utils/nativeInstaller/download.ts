/**
 * 【文件定位】原生安装器下载模块 — Claude Code 自动更新系统的网络获取层
 *
 * 在 Claude Code 的自动更新架构中，本文件处于"版本获取与下载"阶段：
 *   installLatest() → getLatestVersion() → [本模块] → 二进制文件落盘 → installer.ts 安装
 *
 * 主要职责：
 *   1. 版本号查询：从 Artifactory NPM 注册表（内部用户）或 GCS 存储桶（外部用户）
 *      获取最新版本号
 *   2. 二进制文件下载：从对应源下载平台专属的 Claude 原生二进制文件
 *   3. 完整性验证：SHA-256 校验和验证，确保下载文件未损坏
 *   4. 失速检测：60 秒无数据接收则中止下载并重试（最多 3 次）
 *   5. 渠道路由：根据 USER_TYPE 环境变量和 feature flag 选择正确的下载源
 *
 * 下载源路由规则：
 *   - USER_TYPE=ant → Artifactory NPM 包
 *   - 普通用户 → GCS 存储桶直接二进制下载
 *   - ALLOW_TEST_VERSIONS feature → CI 哨兵存储桶（仅 smoke test 使用，DCE 保护）
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { createHash } from 'crypto'
import { chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import type { ReleaseChannel } from '../config.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { jsonStringify, writeFileSync_DEPRECATED } from '../slowOperations.js'
import { getBinaryName, getPlatform } from './installer.js'

// 外部用户使用的 GCS（Google Cloud Storage）存储桶基础 URL
const GCS_BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'
// 内部（ant）用户使用的 Artifactory NPM 注册表 URL
export const ARTIFACTORY_REGISTRY_URL =
  'https://artifactory.infra.ant.dev/artifactory/api/npm/npm-all/'

/**
 * 从 Artifactory NPM 注册表查询指定 tag 对应的最新版本号（内部用户专用）。
 *
 * 流程：
 *   1. 使用 npm view 命令查询包的版本信息
 *   2. 记录请求延迟和成功/失败状态到 Analytics
 *   3. 返回版本字符串（已去除首尾空白）
 *
 * @param tag - NPM 发布 tag（默认 'latest'，stable 版本使用 'stable'）
 * @returns 版本号字符串（如 "1.2.3"）
 * @throws 若 npm view 命令失败则抛出错误
 */
export async function getLatestVersionFromArtifactory(
  tag: string = 'latest',
): Promise<string> {
  const startTime = Date.now()
  const { stdout, code, stderr } = await execFileNoThrowWithCwd(
    'npm',
    [
      'view',
      `${MACRO.NATIVE_PACKAGE_URL}@${tag}`,
      'version',
      '--prefer-online', // 强制从注册表获取最新元数据（而非本地缓存）
      '--registry',
      ARTIFACTORY_REGISTRY_URL,
    ],
    {
      timeout: 30000, // 30 秒超时
      preserveOutputOnError: true,
    },
  )

  const latencyMs = Date.now() - startTime

  if (code !== 0) {
    // 上报版本查询失败事件
    logEvent('tengu_version_check_failure', {
      latency_ms: latencyMs,
      source_npm: true,
      exit_code: code,
    })
    const error = new Error(`npm view failed with code ${code}: ${stderr}`)
    logError(error)
    throw error
  }

  // 上报版本查询成功事件
  logEvent('tengu_version_check_success', {
    latency_ms: latencyMs,
    source_npm: true,
  })
  logForDebugging(
    `npm view ${MACRO.NATIVE_PACKAGE_URL}@${tag} version: ${stdout}`,
  )
  // 去除换行符和空白，返回干净的版本字符串
  const latestVersion = stdout.trim()
  return latestVersion
}

/**
 * 从通用二进制存储库（HTTP 端点）查询最新版本号。
 *
 * 存储库约定：GET ${baseUrl}/${channel} 返回纯文本版本号。
 * GCS 存储桶和其他自定义存储库均遵循此格式。
 *
 * @param channel - 发布渠道（'latest' 或 'stable'）
 * @param baseUrl - 存储库基础 URL
 * @param authConfig - 可选的 HTTP Basic Auth 配置（内部私有存储库使用）
 * @returns 版本号字符串
 * @throws 网络请求失败或超时时抛出错误
 */
export async function getLatestVersionFromBinaryRepo(
  channel: ReleaseChannel = 'latest',
  baseUrl: string,
  authConfig?: { auth: { username: string; password: string } },
): Promise<string> {
  const startTime = Date.now()
  try {
    const response = await axios.get(`${baseUrl}/${channel}`, {
      timeout: 30000,
      responseType: 'text', // 期望纯文本版本号
      ...authConfig,
    })
    const latencyMs = Date.now() - startTime
    logEvent('tengu_version_check_success', {
      latency_ms: latencyMs,
    })
    // 去除版本号末尾的换行符
    return response.data.trim()
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    // 尝试提取 HTTP 状态码（用于 Analytics 诊断）
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    // 上报查询失败事件，包含延迟、HTTP 状态码和是否为超时错误
    logEvent('tengu_version_check_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    const fetchError = new Error(
      `Failed to fetch version from ${baseUrl}/${channel}: ${errorMessage}`,
    )
    logError(fetchError)
    throw fetchError
  }
}

/**
 * 统一版本解析入口：处理直接版本号和渠道名两种输入形式。
 *
 * 输入形式：
 *   - 直接版本号（如 "1.2.3" 或 "v1.2.3"）：验证格式后直接返回
 *   - 渠道名（'latest' 或 'stable'）：路由到对应数据源查询最新版本
 *
 * 特殊保护：99.99.x 版本号为 CI smoke test 专用，
 * 在正式构建中通过 DCE（死代码消除）完全移除相关逻辑。
 *
 * @param channelOrVersion - 版本号（"1.2.3"）或渠道名（"latest"/"stable"）
 * @returns 规范化的版本号字符串（无 "v" 前缀）
 */
export async function getLatestVersion(
  channelOrVersion: string,
): Promise<string> {
  // 匹配版本号格式（支持可选的 "v" 前缀和预发布标签）
  if (/^v?\d+\.\d+\.\d+(-\S+)?$/.test(channelOrVersion)) {
    // 规范化：去除 "v" 前缀（内部统一使用无 "v" 格式）
    const normalized = channelOrVersion.startsWith('v')
      ? channelOrVersion.slice(1)
      : channelOrVersion
    // 99.99.x 系列为 CI smoke test 专用版本，正式构建中通过 DCE 消除此分支
    // 只有使用 --feature=ALLOW_TEST_VERSIONS 的 bun 源码调用才能通过此检查
    if (/^99\.99\./.test(normalized) && !feature('ALLOW_TEST_VERSIONS')) {
      throw new Error(
        `Version ${normalized} is not available for installation. Use 'stable' or 'latest'.`,
      )
    }
    return normalized
  }

  // 验证渠道名合法性
  const channel = channelOrVersion as ReleaseChannel
  if (channel !== 'stable' && channel !== 'latest') {
    throw new Error(
      `Invalid channel: ${channelOrVersion}. Use 'stable' or 'latest'`,
    )
  }

  // 根据用户类型路由到不同的版本查询源
  if (process.env.USER_TYPE === 'ant') {
    // 内部用户：从 Artifactory NPM 注册表查询
    const npmTag = channel === 'stable' ? 'stable' : 'latest'
    return getLatestVersionFromArtifactory(npmTag)
  }

  // 外部用户：从 GCS 存储桶查询
  return getLatestVersionFromBinaryRepo(channel, GCS_BUCKET_URL)
}

/**
 * 从 Artifactory NPM 注册表下载指定版本（内部用户专用）。
 *
 * 与普通 npm install 不同，此函数创建一个隔离的临时 npm 项目并使用 npm ci，
 * 通过 package-lock.json 锁定完整性哈希（integrity hash），
 * 确保下载的包与注册表声明的内容完全一致。
 *
 * 流程：
 *   1. 清理已有的 staging 目录（防止上次中断的残留文件干扰）
 *   2. 通过 npm view 获取平台专属包的完整性哈希
 *   3. 在 staging 目录创建最小化 npm 项目（package.json + package-lock.json）
 *   4. 执行 npm ci --prefer-online 下载并验证完整性
 *
 * @param version - 要下载的版本号
 * @param stagingPath - 临时下载目录路径
 */
export async function downloadVersionFromArtifactory(
  version: string,
  stagingPath: string,
) {
  const fs = getFsImplementation()

  // 清理可能存在的上次失败的部分下载残留
  await fs.rm(stagingPath, { recursive: true, force: true })

  // 构造平台专属的 npm 包名（如 @anthropic-ai/claude-cli-native-macos-arm64）
  const platform = getPlatform()
  const platformPackageName = `${MACRO.NATIVE_PACKAGE_URL}-${platform}`

  // 第一步：获取平台包的完整性哈希（用于 package-lock.json 的 integrity 字段）
  logForDebugging(
    `Fetching integrity hash for ${platformPackageName}@${version}`,
  )
  const {
    stdout: integrityOutput,
    code,
    stderr,
  } = await execFileNoThrowWithCwd(
    'npm',
    [
      'view',
      `${platformPackageName}@${version}`,
      'dist.integrity', // 获取 SRI 格式的完整性哈希（如 sha512-xxx）
      '--registry',
      ARTIFACTORY_REGISTRY_URL,
    ],
    {
      timeout: 30000,
      preserveOutputOnError: true,
    },
  )

  if (code !== 0) {
    throw new Error(`npm view integrity failed with code ${code}: ${stderr}`)
  }

  const integrity = integrityOutput.trim()
  if (!integrity) {
    throw new Error(
      `Failed to fetch integrity hash for ${platformPackageName}@${version}`,
    )
  }

  logForDebugging(`Got integrity hash for ${platform}: ${integrity}`)

  // 第二步：在 staging 目录创建隔离的 npm 项目
  await fs.mkdir(stagingPath)

  // 最小化的 package.json，只声明主包依赖
  const packageJson = {
    name: 'claude-native-installer',
    version: '0.0.1',
    dependencies: {
      [MACRO.NATIVE_PACKAGE_URL!]: version,
    },
  }

  // 构造精确的 package-lock.json：
  // - 主包依赖平台包（可选依赖，用于跨平台兼容）
  // - 平台包锁定完整性哈希，npm ci 会对此进行校验
  const packageLock = {
    name: 'claude-native-installer',
    version: '0.0.1',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'claude-native-installer',
        version: '0.0.1',
        dependencies: {
          [MACRO.NATIVE_PACKAGE_URL!]: version,
        },
      },
      // 主包的条目：声明对平台包的可选依赖
      [`node_modules/${MACRO.NATIVE_PACKAGE_URL}`]: {
        version: version,
        optionalDependencies: {
          [platformPackageName]: version,
        },
      },
      // 平台包的条目：锁定完整性哈希，npm ci 会验证下载内容与此哈希一致
      [`node_modules/${platformPackageName}`]: {
        version: version,
        integrity: integrity,
      },
    },
  }

  // 写入 package.json 到 staging 目录
  writeFileSync_DEPRECATED(
    join(stagingPath, 'package.json'),
    jsonStringify(packageJson, null, 2),
    { encoding: 'utf8', flush: true },
  )

  // 写入 package-lock.json 到 staging 目录
  writeFileSync_DEPRECATED(
    join(stagingPath, 'package-lock.json'),
    jsonStringify(packageLock, null, 2),
    { encoding: 'utf8', flush: true },
  )

  // 第三步：执行 npm ci 下载并自动验证完整性
  // --prefer-online 强制从注册表获取最新元数据（避免 Artifactory 复制延迟导致的缓存问题）
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['ci', '--prefer-online', '--registry', ARTIFACTORY_REGISTRY_URL],
    {
      timeout: 60000, // 60 秒超时
      preserveOutputOnError: true,
      cwd: stagingPath, // 在 staging 目录中运行
    },
  )

  if (result.code !== 0) {
    throw new Error(`npm ci failed with code ${result.code}: ${result.stderr}`)
  }

  logForDebugging(
    `Successfully downloaded and verified ${MACRO.NATIVE_PACKAGE_URL}@${version}`,
  )
}

// 失速超时时间：连续此时长内无数据到达则中止下载
const DEFAULT_STALL_TIMEOUT_MS = 60000 // 60 秒
// 下载失败后的最大重试次数（仅针对失速超时，其他错误不重试）
const MAX_DOWNLOAD_RETRIES = 3

/**
 * 获取失速超时时间（支持测试环境通过环境变量缩短超时）。
 */
function getStallTimeoutMs(): number {
  return (
    // 测试环境可以通过此环境变量设置更短的超时时间
    Number(process.env.CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING) ||
    DEFAULT_STALL_TIMEOUT_MS
  )
}

/**
 * 下载失速错误类型（标识因 60 秒无数据导致的中止）。
 */
class StallTimeoutError extends Error {
  constructor() {
    super('Download stalled: no data received for 60 seconds')
    this.name = 'StallTimeoutError'
  }
}

/**
 * 通用二进制下载与验证函数（含失速检测和重试逻辑）。
 *
 * 核心特性：
 *   - 失速检测：每次收到数据块时重置计时器，若 60 秒内无数据则中止
 *   - 重试逻辑：仅对失速超时进行重试（最多 3 次），HTTP 错误和校验和不匹配不重试
 *   - SHA-256 校验：下载完成后与 manifest 中的期望哈希对比
 *   - 原子写入：验证通过后才写入磁盘并设置可执行权限
 *
 * @param binaryUrl - 二进制文件的下载 URL
 * @param expectedChecksum - 期望的 SHA-256 十六进制校验和
 * @param binaryPath - 下载完成后的写入路径
 * @param requestConfig - 额外的 axios 请求配置（如 Auth 头）
 */
async function downloadAndVerifyBinary(
  binaryUrl: string,
  expectedChecksum: string,
  binaryPath: string,
  requestConfig: Record<string, unknown> = {},
) {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    // 每次重试创建新的 AbortController（失速超时时通过 abort 信号中止 axios）
    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    // 清除当前的失速计时器
    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    // 重置失速计时器（每收到一个数据块都调用此函数）
    const resetStallTimer = () => {
      clearStallTimer()
      // 超时到期时通过 AbortController 中止 axios 请求
      stallTimer = setTimeout(c => c.abort(), getStallTimeoutMs(), controller)
    }

    try {
      // 在请求开始前立即启动失速计时器
      resetStallTimer()

      const response = await axios.get(binaryUrl, {
        timeout: 5 * 60000, // 5 分钟总超时（失速超时会更早触发）
        responseType: 'arraybuffer', // 以二进制数组缓冲区接收数据
        signal: controller.signal,  // 关联 AbortController 信号
        onDownloadProgress: () => {
          // 每收到一个数据块就重置失速计时器（证明数据仍在传输）
          resetStallTimer()
        },
        ...requestConfig,
      })

      // 下载完成，取消失速计时器
      clearStallTimer()

      // 计算下载内容的 SHA-256 哈希值
      const hash = createHash('sha256')
      hash.update(response.data)
      const actualChecksum = hash.digest('hex')

      // 与 manifest 中声明的期望哈希对比，任何不匹配都意味着文件损坏或篡改
      if (actualChecksum !== expectedChecksum) {
        throw new Error(
          `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        )
      }

      // 校验通过：写入磁盘并赋予可执行权限
      await writeFile(binaryPath, Buffer.from(response.data))
      await chmod(binaryPath, 0o755) // rwxr-xr-x

      // 成功，提前返回
      return
    } catch (error) {
      clearStallTimer()

      // axios 将 AbortSignal 触发的中止包装为 CanceledError，通过 isCancel 检测
      const isStallTimeout = axios.isCancel(error)

      if (isStallTimeout) {
        lastError = new StallTimeoutError()
      } else {
        lastError = toError(error)
      }

      // 仅对失速超时进行重试（网络恢复后重试可能成功）
      // 其他错误（HTTP 4xx/5xx、校验和不匹配）不重试
      if (isStallTimeout && attempt < MAX_DOWNLOAD_RETRIES) {
        logForDebugging(
          `Download stalled on attempt ${attempt}/${MAX_DOWNLOAD_RETRIES}, retrying...`,
        )
        // 短暂等待，给网络一点恢复时间
        await sleep(1000)
        continue
      }

      // 非重试错误或已达最大重试次数，直接抛出
      throw lastError
    }
  }

  // 理论上不会到达此处（循环内必然 return 或 throw），作为防御性措施
  throw lastError ?? new Error('Download failed after all retries')
}

/**
 * 从通用二进制存储库下载指定版本的 Claude 二进制文件（外部用户 GCS 版本）。
 *
 * 存储库目录结构约定：
 *   ${baseUrl}/${version}/manifest.json       - 包含各平台的 SHA-256 校验和
 *   ${baseUrl}/${version}/${platform}/${binaryName} - 平台专属二进制文件
 *
 * 流程：
 *   1. 清理 staging 目录
 *   2. 下载 manifest.json 获取当前平台的校验和
 *   3. 调用 downloadAndVerifyBinary 下载二进制并验证
 *   4. 通过 Analytics 上报下载结果
 *
 * @param version - 要下载的版本号
 * @param stagingPath - 临时下载目录
 * @param baseUrl - 存储库基础 URL
 * @param authConfig - 可选的认证配置（Basic Auth 或自定义 headers）
 */
export async function downloadVersionFromBinaryRepo(
  version: string,
  stagingPath: string,
  baseUrl: string,
  authConfig?: {
    auth?: { username: string; password: string }
    headers?: Record<string, string>
  },
) {
  const fs = getFsImplementation()

  // 清理可能存在的上次失败的部分下载残留
  await fs.rm(stagingPath, { recursive: true, force: true })

  // 确定当前运行平台（如 "macos-arm64"、"linux-x64"）
  const platform = getPlatform()
  const startTime = Date.now()

  // 上报下载开始事件
  logEvent('tengu_binary_download_attempt', {})

  // 第一步：获取版本 manifest 以取得当前平台的校验和
  let manifest
  try {
    const manifestResponse = await axios.get(
      `${baseUrl}/${version}/manifest.json`,
      {
        timeout: 10000, // manifest 文件较小，10 秒超时足够
        responseType: 'json',
        ...authConfig,
      },
    )
    manifest = manifestResponse.data
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    // 上报 manifest 获取失败事件
    logEvent('tengu_binary_manifest_fetch_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    logError(
      new Error(
        `Failed to fetch manifest from ${baseUrl}/${version}/manifest.json: ${errorMessage}`,
      ),
    )
    throw error
  }

  // 从 manifest 中提取当前平台的元数据（包含校验和）
  const platformInfo = manifest.platforms[platform]

  if (!platformInfo) {
    // manifest 中没有当前平台的条目，说明该版本不支持此平台
    logEvent('tengu_binary_platform_not_found', {})
    throw new Error(
      `Platform ${platform} not found in manifest for version ${version}`,
    )
  }

  const expectedChecksum = platformInfo.checksum

  // GCS 和通用存储库使用相同的目录布局：${baseUrl}/${version}/${platform}/${binaryName}
  const binaryName = getBinaryName(platform)
  const binaryUrl = `${baseUrl}/${version}/${platform}/${binaryName}`

  // 创建 staging 目录并构造目标路径
  await fs.mkdir(stagingPath)
  const binaryPath = join(stagingPath, binaryName)

  try {
    // 执行下载（含失速检测、重试、SHA-256 校验）
    await downloadAndVerifyBinary(
      binaryUrl,
      expectedChecksum,
      binaryPath,
      authConfig || {},
    )
    const latencyMs = Date.now() - startTime
    // 上报下载成功事件
    logEvent('tengu_binary_download_success', {
      latency_ms: latencyMs,
    })
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    // 上报下载失败事件（细分：超时、校验和不匹配、HTTP 错误等）
    logEvent('tengu_binary_download_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
      is_checksum_mismatch: errorMessage.includes('Checksum mismatch'),
    })
    logError(
      new Error(`Failed to download binary from ${binaryUrl}: ${errorMessage}`),
    )
    throw error
  }
}

/**
 * 统一下载入口：根据用户类型和 feature flag 选择正确的下载策略。
 *
 * 路由规则：
 *   1. ALLOW_TEST_VERSIONS + 99.99.x 版本 → CI 哨兵存储桶（仅 smoke test，DCE 保护）
 *   2. USER_TYPE=ant → Artifactory NPM 包下载
 *   3. 普通用户 → GCS 存储桶直接二进制下载
 *
 * @param version - 要下载的版本号
 * @param stagingPath - 临时下载目录
 * @returns 下载类型：'npm'（来自 Artifactory）或 'binary'（来自 GCS 或存储桶）
 */
export async function downloadVersion(
  version: string,
  stagingPath: string,
): Promise<'npm' | 'binary'> {
  // CI smoke test 分支：通过 gcloud auth token 访问私有 sentinel 存储桶
  // 此分支在所有正式构建中通过 DCE 完全消除（不存在于编译产物中）
  // 与 remoteSkillLoader.ts 中的 gcloud-token 模式相同
  if (feature('ALLOW_TEST_VERSIONS') && /^99\.99\./.test(version)) {
    const { stdout } = await execFileNoThrowWithCwd('gcloud', [
      'auth',
      'print-access-token', // 获取 Google Cloud 访问令牌
    ])
    await downloadVersionFromBinaryRepo(
      version,
      stagingPath,
      'https://storage.googleapis.com/claude-code-ci-sentinel',
      { headers: { Authorization: `Bearer ${stdout.trim()}` } },
    )
    return 'binary'
  }

  if (process.env.USER_TYPE === 'ant') {
    // 内部用户：通过 Artifactory NPM 包下载（含 npm 完整性验证）
    await downloadVersionFromArtifactory(version, stagingPath)
    return 'npm'
  }

  // 外部用户：从公共 GCS 存储桶直接下载二进制文件
  await downloadVersionFromBinaryRepo(version, stagingPath, GCS_BUCKET_URL)
  return 'binary'
}

// 以下导出供测试使用（单元测试需要访问内部实现）
export { StallTimeoutError, MAX_DOWNLOAD_RETRIES }
// 测试用：暴露默认失速超时常量
export const STALL_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_MS
// 测试用：暴露内部下载验证函数
export const _downloadAndVerifyBinaryForTesting = downloadAndVerifyBinary
