/**
 * 官方插件市场 GCS 镜像下载模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"官方市场安装"的快速路径层：
 *   - 后端（anthropic#317037）将官方市场以 SHA 键控的 ZIP 包形式发布到
 *     GCS（Google Cloud Storage）CDN 上，URL 前缀为 downloads.claude.ai；
 *   - 本模块先获取 `latest` 指针（~40 字节）得到最新 SHA，
 *     与本地 `.gcs-sha` 哨兵文件比对；若 SHA 匹配则幂等跳过；
 *   - SHA 变化时下载 ZIP 并原子性地替换安装目录（staging → rename）；
 *   - 相比 git clone，此方式无需 git 可用，不直接命中 GitHub，启动更快；
 *   - officialMarketplaceStartupCheck.ts 优先尝试本模块，失败时回退到 git。
 *
 * 主要导出：
 *   - fetchOfficialMarketplaceFromGcs(installLocation, marketplacesCacheDir)：
 *       从 GCS 获取最新官方市场内容并解压到指定目录
 *   - classifyGcsError(e)：将 GCS 下载错误分类为遥测可用的稳定标签
 */

import axios from 'axios'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { waitForScrollIdle } from '../../bootstrap/state.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage, getErrnoCode } from '../errors.js'

// 遥测字符串类型别名：标记该字符串已验证不含代码/文件路径/PII
type SafeString = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

// 公共 GCS 存储桶的 CDN 域名（与原生二进制的下载域名相同）。
// `{sha}.zip` 使用内容寻址，CDN 可无限期缓存；
// `latest` 文件设置 Cache-Control: max-age=300，CDN 最多缓存 5 分钟。
// 后端（anthropic#317037）负责将内容发布到此前缀下。
const GCS_BASE =
  'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official'

// ZIP 归档中路径以此前缀开头（与 titanium seed 目录结构兼容）。
// 在普通笔记本电脑安装时，提取时需去掉此前缀，
// 这样提取结果直接对应市场目录内容而非嵌套路径。
const ARC_PREFIX = 'marketplaces/claude-plugins-official/'

/**
 * 从 GCS 获取官方市场内容并解压到 installLocation。
 *
 * 幂等设计：通过 `.gcs-sha` 哨兵文件避免重复下载。
 *
 * 执行流程：
 *   1. 路径边界检查：确保 installLocation 在 marketplacesCacheDir 内，
 *      防止 known_marketplaces.json 损坏（如 Windows 路径写入 WSL、字面波浪号、
 *      手动编辑错误）导致 rm -rf 删除用户项目目录（深度防御）；
 *   2. 等待滚动空闲（waitForScrollIdle），避免网络 I/O 与 UI 渲染竞争；
 *   3. 获取 `latest` 指针，得到最新 SHA（~40 字节）；
 *   4. 读取本地 `.gcs-sha` 哨兵，若 SHA 已匹配则幂等返回（无需下载）；
 *   5. 下载 `{sha}.zip`，解压并解析权限位（保持 +x 位，与 git clone 行为一致）；
 *   6. 解压到 staging 临时目录，写入 `.gcs-sha` 哨兵；
 *   7. 原子替换：删除旧 installLocation，重命名 staging；
 *   8. 无论成功失败，均上报 `tengu_plugin_remote_fetch` 遥测事件；
 *   9. 任何失败返回 null，由调用方决定是否回退到 git。
 *
 * @param installLocation 解压目标目录（必须位于 marketplacesCacheDir 内）
 * @param marketplacesCacheDir 市场缓存根目录（用于路径边界检查）
 * @returns 成功时返回 SHA 字符串（含幂等跳过情况），失败时返回 null
 */
export async function fetchOfficialMarketplaceFromGcs(
  installLocation: string,
  marketplacesCacheDir: string,
): Promise<string | null> {
  // ── 路径边界检查（深度防御）──
  // 此函数执行 rm(installLocation, {recursive}) 进行原子替换，
  // 若 known_marketplaces.json 损坏导致路径指向用户项目，会造成数据丢失。
  // 此检查与 marketplaceManager.ts:~2392 的 refreshMarketplace() 相同，
  // 但放在函数内部确保所有调用路径都受保护。
  const cacheDir = resolve(marketplacesCacheDir) // 规范化缓存根目录路径
  const resolvedLoc = resolve(installLocation) // 规范化目标路径
  if (resolvedLoc !== cacheDir && !resolvedLoc.startsWith(cacheDir + sep)) {
    // 目标路径不在缓存目录内：拒绝执行并记录错误
    logForDebugging(
      `fetchOfficialMarketplaceFromGcs: refusing path outside cache dir: ${installLocation}`,
      { level: 'error' },
    )
    return null
  }

  // 等待滚动空闲：此函数是启动时的 fire-and-forget 调用，
  // 延迟数百毫秒等待滚动稳定对用户不可见，但可避免与 UI 渲染竞争事件循环。
  await waitForScrollIdle()

  // 遥测数据收集变量
  const start = performance.now()
  let outcome: 'noop' | 'updated' | 'failed' = 'failed' // 默认为失败
  let sha: string | undefined
  let bytes: number | undefined
  let errKind: string | undefined

  try {
    // ── 步骤 1：获取 latest 指针 ──
    // 约 40 字节，后端设置 Cache-Control: max-age=300，每次启动都获取（开销极低）。
    const latest = await axios.get(`${GCS_BASE}/latest`, {
      responseType: 'text',
      timeout: 10_000, // 10 秒超时
    })
    sha = String(latest.data).trim() // 去除末尾换行/空格
    if (!sha) {
      // latest 返回空内容：后端配置错误，抛出异常避免写入空哨兵
      // （空哨兵会导致后续所有启动都认为"已是最新"，永久阻断更新）
      throw new Error('latest pointer returned empty body')
    }

    // ── 步骤 2：哨兵文件检查 ──
    // `.gcs-sha` 存储上次成功提取的 SHA，匹配则内容未变，无需重新下载。
    const sentinelPath = join(installLocation, '.gcs-sha')
    const currentSha = await readFile(sentinelPath, 'utf8').then(
      s => s.trim(),
      () => null, // ENOENT：首次获取，继续下载流程
    )
    if (currentSha === sha) {
      // SHA 匹配：幂等跳过，直接返回
      outcome = 'noop'
      return sha
    }

    // ── 步骤 3：下载 ZIP 并原子替换安装目录 ──
    // 先下载到 staging 临时目录，完成后原子替换，
    // 崩溃时只留下 .staging 临时目录，不破坏现有安装。
    const zipResp = await axios.get(`${GCS_BASE}/${sha}.zip`, {
      responseType: 'arraybuffer',
      timeout: 60_000, // 60 秒超时（ZIP 约 3.5MB）
    })
    const zipBuf = Buffer.from(zipResp.data)
    bytes = zipBuf.length // 用于遥测

    // 解压 ZIP 内容（得到路径 → 内容的映射）
    const files = await unzipFile(zipBuf)
    // fflate 不暴露 external_attr，需自行解析中央目录以恢复执行位。
    // 若不处理，hooks/scripts 提取后为 0644，Unix 上 `sh -c "/path/script.sh"` 会报 EACCES。
    // git clone 原生保留 +x 位，此处需手动对齐行为。
    const modes = parseZipModes(zipBuf)

    // 清理并创建 staging 目录（确保上次崩溃的残留被清理）
    const staging = `${installLocation}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })

    // 提取 ZIP 内容到 staging 目录（仅处理以 ARC_PREFIX 开头的条目）
    for (const [arcPath, data] of Object.entries(files)) {
      // 跳过不属于官方市场前缀的条目
      if (!arcPath.startsWith(ARC_PREFIX)) continue
      // 去除前缀，得到相对于安装目录的路径
      const rel = arcPath.slice(ARC_PREFIX.length)
      // 跳过空路径和目录条目（路径以 '/' 结尾）
      if (!rel || rel.endsWith('/')) continue
      const dest = join(staging, rel)
      // 确保父目录存在
      await mkdir(dirname(dest), { recursive: true })
      // 写入文件内容
      await writeFile(dest, data)
      // 若有执行位，设置文件权限（跳过普通文件以减少 syscall）
      const mode = modes[arcPath]
      if (mode && mode & 0o111) {
        // 忽略 chmod 错误（NFS root_squash、部分 FUSE 挂载不支持 chmod）
        // 丢失 +x 是 PR 前的行为，比中途终止提取更安全
        await chmod(dest, mode & 0o777).catch(() => {})
      }
    }
    // 将 SHA 写入 staging 目录的哨兵文件
    await writeFile(join(staging, '.gcs-sha'), sha)

    // 原子替换：先删除旧 installLocation，再重命名 staging。
    // 存在短暂的 installLocation 不存在窗口，但此为后台刷新，
    // 崩溃后下次启动会重试（无损）。
    await rm(installLocation, { recursive: true, force: true })
    await rename(staging, installLocation)

    outcome = 'updated'
    return sha
  } catch (e) {
    // 分类错误并记录调试日志
    errKind = classifyGcsError(e)
    logForDebugging(
      `Official marketplace GCS fetch failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return null // 调用方决定是否回退到 git
  } finally {
    // 无论成功失败，均上报 tengu_plugin_remote_fetch 遥测事件。
    // 所有字符串值均为静态枚举或 git SHA，不含代码/文件路径/PII。
    logEvent('tengu_plugin_remote_fetch', {
      source: 'marketplace_gcs' as SafeString,
      host: 'downloads.claude.ai' as SafeString,
      is_official: true,
      outcome: outcome as SafeString,
      duration_ms: Math.round(performance.now() - start),
      ...(bytes !== undefined && { bytes }),
      ...(sha && { sha: sha as SafeString }),
      ...(errKind && { error_kind: errKind as SafeString }),
    })
  }
}

// 按名称报告的已知 errno 错误码集合（其他错误归类为 fs_other 以控制遥测基数）
const KNOWN_FS_CODES = new Set([
  'ENOSPC', // 磁盘空间不足
  'EACCES', // 权限拒绝
  'EPERM', // 操作不允许
  'EXDEV', // 跨设备链接（rename 跨文件系统时触发）
  'EBUSY', // 设备或资源忙
  'ENOENT', // 文件或目录不存在
  'ENOTDIR', // 不是目录
  'EROFS', // 只读文件系统
  'EMFILE', // 打开文件过多
  'ENAMETOOLONG', // 文件名过长
])

/**
 * 将 GCS 获取错误分类为遥测可用的稳定标签。
 *
 * 背景：v2.1.83+ 的遥测数据显示 50% 的失败落在 'other' 类别，
 * 其中 99.99% 的情况 sha+bytes 都已设置（意味着下载成功但提取/写文件失败）。
 * 细化此分类可判断失败是可修复的（临时目录问题、跨设备 rename）
 * 还是固有的（磁盘满、权限拒绝），从而决定是否翻转 git 回退开关。
 *
 * @param e 任意错误对象
 * @returns 稳定的遥测分类标签字符串
 */
export function classifyGcsError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    if (e.code === 'ECONNABORTED') return 'timeout' // 请求超时
    if (e.response) return `http_${e.response.status}` // HTTP 错误状态码（如 http_404）
    return 'network' // 无响应的网络错误
  }
  const code = getErrnoCode(e)
  // Node.js fs errno 代码格式为 E<大写字母>（如 ENOSPC、EACCES）。
  // Axios 也会设置 .code（ERR_NETWORK、ERR_BAD_OPTION、EPROTO），
  // 这些不是 fs 错误，需通过 ERR_ 前缀过滤掉。
  if (code && /^E[A-Z]+$/.test(code) && !code.startsWith('ERR_')) {
    // 已知 fs 错误码：使用 fs_ECODE 格式；未知 fs 错误：归类为 fs_other
    return KNOWN_FS_CODES.has(code) ? `fs_${code}` : 'fs_other'
  }
  // fflate 在 inflate/unzip 错误时设置数字类型的 .code（0-14），
  // 可捕获消息正则匹配遗漏的 deflate 级别损坏（如"unexpected EOF"、"invalid block type"）。
  if (typeof (e as { code?: unknown })?.code === 'number') return 'zip_parse'
  const msg = errorMessage(e)
  if (/unzip|invalid zip|central directory/i.test(msg)) return 'zip_parse' // ZIP 解析错误
  if (/empty body/.test(msg)) return 'empty_latest' // latest 指针返回空内容
  return 'other' // 其他未分类错误
}
