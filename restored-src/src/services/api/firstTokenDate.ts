/**
 * 首次 Token 日期查询与缓存模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户登录成功后 → 本模块向后端查询该账号第一次使用 Claude Code 的时间 → 写入全局配置缓存
 *
 * 主要功能：
 *   - fetchAndStoreClaudeCodeFirstTokenDate：查询并持久化"首次 Token 日期"字段
 *
 * 设计特点：
 *   - 幂等：若全局配置中已存在该字段则直接跳过，避免重复请求
 *   - 防护：对 API 返回的日期字符串做 isNaN 校验，非法值不写入
 *   - 静默失败：所有错误通过 logError 记录后直接返回，不影响主流程
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

/**
 * 向后端查询当前用户首次使用 Claude Code 的日期，并将结果缓存到全局配置。
 *
 * 流程：
 *  1. 读取全局配置，若 claudeCodeFirstTokenDate 已存在则直接返回（幂等保护）
 *  2. 获取认证请求头，失败则记录日志并返回
 *  3. 调用 /api/organization/claude_code_first_token_date 接口
 *  4. 对返回的日期字符串做合法性校验（isNaN 检测）
 *  5. 将有效结果写入全局配置持久化
 *
 * 该函数在登录流程完成后被调用（fire-and-forget 模式），不阻塞主流程。
 */
export async function fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    // 幂等检查：字段已存在则跳过，避免重复 API 调用
    if (config.claudeCodeFirstTokenDate !== undefined) {
      return
    }

    // 获取认证请求头（Bearer Token 或 API Key）
    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      // 无法获取认证头（未登录或令牌失效），记录错误后退出
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    // 构造查询端点 URL（使用环境感知的 BASE_API_URL）
    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/claude_code_first_token_date`

    // 发起 GET 请求，10 秒超时防止阻塞
    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getClaudeCodeUserAgent(), // 携带 Claude Code 版本信息
      },
      timeout: 10000,
    })

    // 从响应体中提取日期，若字段缺失则视为 null（用户从未使用过）
    const firstTokenDate = response.data?.first_token_date ?? null

    // 日期合法性校验：非 null 时确保可被 Date 解析
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        // 服务端返回了无法解析的日期字符串，记录错误并放弃写入
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
        // 不保存非法日期，直接返回
        return
      }
    }

    // 将有效日期持久化到全局配置文件（使用更新函数确保并发安全）
    saveGlobalConfig(current => ({
      ...current,
      claudeCodeFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    // 网络错误或其他异常：静默失败，不影响用户的正常使用流程
    logError(error)
  }
}
