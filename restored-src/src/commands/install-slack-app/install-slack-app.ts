/**
 * install-slack-app 命令实现模块
 *
 * 本文件是 `/install-slack-app` 命令的核心执行逻辑，是 Claude Code 集成生态扩展的一部分。
 * 用户触发 `/install-slack-app` 后，由 index.ts 描述符懒加载本模块，
 * commands 框架调用 `call()` 函数完成以下操作：
 *   1. 记录用户点击安装行为（analytics 埋点）
 *   2. 更新全局配置中的安装次数计数器（用于统计和引导逻辑）
 *   3. 打开浏览器跳转至 Slack Marketplace 安装页面
 *   4. 根据浏览器是否成功打开，返回相应的文本提示
 */
import type { LocalCommandResult } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { saveGlobalConfig } from '../../utils/config.js'

// Claude Slack 应用在 Slack Marketplace 中的安装页面 URL（应用 ID：A08SF47R6P4）
const SLACK_APP_URL = 'https://slack.com/marketplace/A08SF47R6P4-claude'

/**
 * install-slack-app 命令的执行入口
 *
 * 记录埋点事件后尝试在浏览器中打开 Slack 应用安装页面，
 * 并返回操作结果的文本提示：
 * - 浏览器成功打开 → 提示"正在浏览器中打开..."
 * - 浏览器无法打开（如无头服务器环境）→ 提示用户手动访问 URL
 *
 * @returns 包含 type:'text' 的命令结果对象
 */
export async function call(): Promise<LocalCommandResult> {
  // 上报"用户点击安装 Slack App"埋点事件，用于功能使用统计
  logEvent('tengu_install_slack_app_clicked', {})

  // 累计记录用户点击安装的次数，持久化到全局配置文件
  saveGlobalConfig(current => ({
    ...current,
    slackAppInstallCount: (current.slackAppInstallCount ?? 0) + 1,
  }))

  // 尝试在系统默认浏览器中打开 Slack Marketplace 安装页面
  const success = await openBrowser(SLACK_APP_URL)

  if (success) {
    // 浏览器成功打开，提示用户继续在浏览器中完成安装
    return {
      type: 'text',
      value: 'Opening Slack app installation page in browser…',
    }
  } else {
    // 浏览器无法打开（如 SSH 无头服务器环境），提供备用的直达 URL
    return {
      type: 'text',
      value: `Couldn't open browser. Visit: ${SLACK_APP_URL}`,
    }
  }
}
