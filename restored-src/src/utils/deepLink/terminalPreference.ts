/**
 * Deep Link 终端偏好设置模块。
 *
 * 在 Claude Code 系统中，该模块独立于 terminalLauncher.ts 存在，
 * 供 interactiveHelpers.tsx 在不引入完整启动器模块（避免影响 LODESTONE tree-shaking）的情况下
 * 读写用户的终端偏好配置。
 */

import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'

/**
 * Map TERM_PROGRAM env var values (lowercased) to the `app` name used by
 * launchMacosTerminal's switch cases. TERM_PROGRAM values are what terminals
 * self-report; they don't always match the .app bundle name (e.g.,
 * "iTerm.app" → "iTerm", "Apple_Terminal" → "Terminal").
 */
const TERM_PROGRAM_TO_APP: Record<string, string> = {
  iterm: 'iTerm',
  'iterm.app': 'iTerm',
  ghostty: 'Ghostty',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  wezterm: 'WezTerm',
  apple_terminal: 'Terminal',
}

/**
 * Capture the current terminal from TERM_PROGRAM and store it for the deep
 * link handler to use later. The handler runs headless (LaunchServices/xdg)
 * where TERM_PROGRAM is unset, so without this it falls back to a static
 * priority list that picks whatever is installed first — often not the
 * terminal the user actually uses.
 *
 * Called fire-and-forget from interactive startup, same as
 * updateGithubRepoPathMapping.
 */
export function updateDeepLinkTerminalPreference(): void {
  // Only detectMacosTerminal reads the stored value — skip the write on
  // other platforms.
  if (process.platform !== 'darwin') return

  const termProgram = process.env.TERM_PROGRAM
  if (!termProgram) return

  const app = TERM_PROGRAM_TO_APP[termProgram.toLowerCase()]
  if (!app) return

  const config = getGlobalConfig()
  if (config.deepLinkTerminal === app) return

  saveGlobalConfig(current => ({ ...current, deepLinkTerminal: app }))
  logForDebugging(`Stored deep link terminal preference: ${app}`)
}
