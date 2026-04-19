/**
 * 浏览器与文件路径打开工具模块。
 *
 * 在 Claude Code 系统中，该模块提供跨平台的系统默认程序调用能力：
 * - openPath()：使用系统默认程序打开文件或文件夹路径
 *   （macOS: open，Windows: explorer，Linux: xdg-open）
 * - openBrowser()：打开指定 URL（仅允许 http/https 协议，校验 URL 合法性）
 *   优先使用 BROWSER 环境变量指定的浏览器，否则使用系统默认浏览器
 */
import { execFileNoThrow } from './execFileNoThrow.js'

/** 校验 URL 格式与协议合法性（仅允许 http / https），不合法时抛出错误。 */
function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch (_error) {
    throw new Error(`Invalid URL format: ${url}`)
  }

  // Validate URL protocol for security
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Invalid URL protocol: must use http:// or https://, got ${parsedUrl.protocol}`,
    )
  }
}

/**
 * 使用系统默认程序打开文件或文件夹路径。
 * macOS 使用 open，Windows 使用 explorer，Linux 使用 xdg-open。
 * 成功返回 true，失败返回 false。
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      const { code } = await execFileNoThrow('explorer', [path])
      return code === 0
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [path])
    return code === 0
  } catch (_) {
    return false
  }
}

/**
 * 使用系统默认浏览器打开指定 URL。
 * 优先使用 BROWSER 环境变量指定的浏览器；Windows 使用 rundll32 url,OpenURL。
 * 校验 URL 合法性（仅允许 http / https 协议），成功返回 true，失败返回 false。
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    // Parse and validate the URL
    validateUrl(url)

    const browserEnv = process.env.BROWSER
    const platform = process.platform

    if (platform === 'win32') {
      if (browserEnv) {
        // browsers require shell, else they will treat this as a file:/// handle
        const { code } = await execFileNoThrow(browserEnv, [`"${url}"`])
        return code === 0
      }
      const { code } = await execFileNoThrow(
        'rundll32',
        ['url,OpenURL', url],
        {},
      )
      return code === 0
    } else {
      const command =
        browserEnv || (platform === 'darwin' ? 'open' : 'xdg-open')
      const { code } = await execFileNoThrow(command, [url])
      return code === 0
    }
  } catch (_) {
    return false
  }
}
