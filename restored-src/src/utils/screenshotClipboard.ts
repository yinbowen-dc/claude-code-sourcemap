/**
 * 截图剪贴板模块 (screenshotClipboard.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户截图请求 → 【本模块：ANSI → PNG → 剪贴板】→ 系统剪贴板
 *
 * 主要职责：
 *   1. 将 ANSI 转义序列文本渲染为 PNG 位图（纯 TypeScript，无 WASM/系统字体依赖）
 *   2. 将生成的 PNG 写入临时文件后复制到系统剪贴板
 *   3. 多平台派发：macOS（osascript）/ Linux（xclip→xsel）/ Windows（PowerShell）
 *   4. 操作完成后自动清理临时文件
 *
 * 与其他模块的关系：
 *   - 依赖 ansiToPng 模块执行 ANSI 渲染
 *   - 依赖 execFileNoThrow 安全地调用系统命令（不抛异常）
 */

import { mkdir, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { type AnsiToPngOptions, ansiToPng } from './ansiToPng.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

/**
 * 将 ANSI 文本转换为 PNG 并复制到系统剪贴板。
 *
 * 整体流程：
 *   1. 在系统临时目录创建专用子目录（claude-code-screenshots）
 *   2. 将 ANSI 文本通过 ansiToPng() 渲染为 PNG Buffer
 *   3. 将 Buffer 写入临时 PNG 文件（文件名含时间戳，避免并发冲突）
 *   4. 调用 copyPngToClipboard() 按平台派发复制操作
 *   5. 无论成功与否，都尝试删除临时文件（忽略清理失败）
 *
 * 纯 TypeScript 渲染管线：ANSI 文本 → 位图字体渲染 → PNG 编码，
 * 不依赖 WASM 或系统字体，在所有构建（native、JS）下均可用。
 *
 * @param ansiText ANSI 转义序列文本
 * @param options  PNG 渲染选项（字体大小、主题等）
 * @returns { success, message }
 */
export async function copyAnsiToClipboard(
  ansiText: string,
  options?: AnsiToPngOptions,
): Promise<{ success: boolean; message: string }> {
  try {
    // 确保截图临时目录存在
    const tempDir = join(tmpdir(), 'claude-code-screenshots')
    await mkdir(tempDir, { recursive: true })

    // 生成带时间戳的唯一临时文件名
    const pngPath = join(tempDir, `screenshot-${Date.now()}.png`)
    // 渲染 ANSI 文本为 PNG Buffer
    const pngBuffer = ansiToPng(ansiText, options)
    // 写入临时文件供系统命令读取
    await writeFile(pngPath, pngBuffer)

    // 按平台调用对应的剪贴板复制命令
    const result = await copyPngToClipboard(pngPath)

    // 清理临时文件（忽略 ENOENT 等清理错误，不影响主流程）
    try {
      await unlink(pngPath)
    } catch {
      // 忽略清理失败
    }

    return result
  } catch (error) {
    logError(error)
    return {
      success: false,
      message: `Failed to copy screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * 按操作系统平台将 PNG 文件复制到系统剪贴板。
 *
 * 平台派发策略：
 *   - macOS：osascript 执行 AppleScript（set clipboard to PNG 数据）
 *   - Linux：优先使用 xclip；失败则降级到 xsel；均失败时提示安装
 *   - Windows：PowerShell 调用 System.Windows.Forms.Clipboard::SetImage
 *   - 其他：返回不支持的错误
 *
 * 所有外部命令均设置 5 秒超时，防止系统命令挂起。
 *
 * @param pngPath 临时 PNG 文件的绝对路径
 * @returns { success, message }
 */
async function copyPngToClipboard(
  pngPath: string,
): Promise<{ success: boolean; message: string }> {
  const platform = getPlatform()

  if (platform === 'macos') {
    // macOS：使用 osascript 执行 AppleScript 读取 PNG 并设置剪贴板
    // 先对路径中的反斜杠和双引号做转义，确保 AppleScript 字符串安全
    const escapedPath = pngPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `set the clipboard to (read (POSIX file "${escapedPath}") as «class PNGf»)`
    const result = await execFileNoThrowWithCwd('osascript', ['-e', script], {
      timeout: 5000,
    })

    if (result.code === 0) {
      return { success: true, message: 'Screenshot copied to clipboard' }
    }
    return {
      success: false,
      message: `Failed to copy to clipboard: ${result.stderr}`,
    }
  }

  if (platform === 'linux') {
    // Linux：先尝试 xclip（通过 stdin 管道方式，直接指定文件）
    const xclipResult = await execFileNoThrowWithCwd(
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-i', pngPath],
      { timeout: 5000 },
    )

    if (xclipResult.code === 0) {
      return { success: true, message: 'Screenshot copied to clipboard' }
    }

    // xclip 失败：降级尝试 xsel
    const xselResult = await execFileNoThrowWithCwd(
      'xsel',
      ['--clipboard', '--input', '--type', 'image/png'],
      { timeout: 5000 },
    )

    if (xselResult.code === 0) {
      return { success: true, message: 'Screenshot copied to clipboard' }
    }

    // 两者均失败：提示用户安装 xclip
    return {
      success: false,
      message:
        'Failed to copy to clipboard. Please install xclip or xsel: sudo apt install xclip',
    }
  }

  if (platform === 'windows') {
    // Windows：使用 PowerShell 加载 System.Windows.Forms 后调用 Clipboard::SetImage
    // 对路径中的单引号做转义（PowerShell 单引号字符串规则：'' 表示单个 '）
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}'))`
    const result = await execFileNoThrowWithCwd(
      'powershell',
      ['-NoProfile', '-Command', psScript],
      { timeout: 5000 },
    )

    if (result.code === 0) {
      return { success: true, message: 'Screenshot copied to clipboard' }
    }
    return {
      success: false,
      message: `Failed to copy to clipboard: ${result.stderr}`,
    }
  }

  // 其他平台（FreeBSD 等）：暂不支持
  return {
    success: false,
    message: `Screenshot to clipboard is not supported on ${platform}`,
  }
}
