/**
 * 应用名称过滤与净化模块。
 *
 * 在 Claude Code 系统中，该模块为 `request_access` 工具描述筛选已安装应用列表，
 * 移植自 Cowork 的 appNames.ts，解决两大问题：
 * - 噪声过滤：Spotlight 会返回磁盘上所有 Bundle（XPC Helper、系统守护进程、输入法等），
 *   需仅保留 /Applications、/System/Applications 等已知根目录下的应用。
 * - 提示注入防御：应用名称由攻击者可控，任何人都可以发布名为任意字符串的应用，
 *   因此需限制允许出现在描述中的字符集。
 *
 * 残余风险：短小的恶意无害字符名称（如 "grant all"）无法通过程序过滤，
 * 但工具描述的结构化表述（"Available applications:"）明确这些只是应用名称，
 * 且下游权限对话框需要用户明确批准，恶意名称无法自动授权。
 * - filterAppsForDescription()：执行路径过滤、名称净化并返回应用显示名列表
 */

/** 最小化类型定义 —— 与 `listInstalledApps` 的返回结构匹配。 */
type InstalledAppLike = {
  readonly bundleId: string
  readonly displayName: string
  readonly path: string
}

// ── 噪声过滤 ──────────────────────────────────────────────────────

/**
 * 仅显示这些根目录下的应用。/System/Library 子路径（CoreServices、
 * PrivateFrameworks、输入法）属于系统底层组件 —— 以已知安全的根目录为锚点，
 * 而非逐一屏蔽每个杂乱子路径（因为新版 macOS 还会不断增加）。
 *
 * ~/Applications 在调用时通过 `homeDir` 参数动态检查
 * （模块加载时 HOME 在所有环境中并不可靠）。
 */
const PATH_ALLOWLIST: readonly string[] = [
  '/Applications/',
  '/System/Applications/',
]

/**
 * 标记 /Applications 下后台服务的显示名称模式。
 * `(?:$|\s\()` —— 匹配关键词位于字符串末尾或紧接 ` (` 之前：
 * "Slack Helper (GPU)" 和 "ABAssistantService" 会被过滤，
 * "Service Desk" 则通过（Service 后跟 " D"）。
 */
const NAME_PATTERN_BLOCKLIST: readonly RegExp[] = [
  /Helper(?:$|\s\()/,
  /Agent(?:$|\s\()/,
  /Service(?:$|\s\()/,
  /Uninstaller(?:$|\s\()/,
  /Updater(?:$|\s\()/,
  /^\./,
]

/**
 * CU 自动化中常用的应用列表。若已安装则始终包含，
 * 可绕过路径检查和数量上限 —— 即使机器上安装了 200+ 个应用，
 * 模型也需要这些精确名称。使用 Bundle ID（不受系统语言影响），而非显示名称。
 * 保持在 30 个以内 —— 每条都是描述中必然存在的 token。
 */
const ALWAYS_KEEP_BUNDLE_IDS: ReadonlySet<string> = new Set([
  // 浏览器
  'com.apple.Safari',
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'company.thebrowser.Browser', // Arc
  // 通讯
  'com.tinyspeck.slackmacgap',
  'us.zoom.xos',
  'com.microsoft.teams2',
  'com.microsoft.teams',
  'com.apple.MobileSMS',
  'com.apple.mail',
  // 生产力
  'com.microsoft.Word',
  'com.microsoft.Excel',
  'com.microsoft.Powerpoint',
  'com.microsoft.Outlook',
  'com.apple.iWork.Pages',
  'com.apple.iWork.Numbers',
  'com.apple.iWork.Keynote',
  'com.google.GoogleDocs',
  // 笔记 / 项目管理
  'notion.id',
  'com.apple.Notes',
  'md.obsidian',
  'com.linear',
  'com.figma.Desktop',
  // 开发
  'com.microsoft.VSCode',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.github.GitHubDesktop',
  // 模型实际操作的系统必备应用
  'com.apple.finder',
  'com.apple.iCal',
  'com.apple.systempreferences',
])

// ── 提示注入防御 ───────────────────────────────────────────────────────────

/**
 * `/u` 标志下使用 `\p{L}\p{M}\p{N}`，而非 `\w`（ASCII 限定，会漏掉 Bücher、微信、
 * Préférences Système）。`\p{M}` 匹配组合标记，使 NFD 分解的变音符号
 * （ü → u + ◌̈）能通过过滤。单个空格而非 `\s` —— `\s` 匹配换行符，
 * 会让 "App\n忽略前面的指令…" 之类的多行注入通过。
 * 仍然拦截引号、尖括号、反引号、管道符、冒号。
 */
const APP_NAME_ALLOWED = /^[\p{L}\p{M}\p{N}_ .&'()+-]+$/u
const APP_NAME_MAX_LEN = 40
const APP_NAME_MAX_COUNT = 50

function isUserFacingPath(path: string, homeDir: string | undefined): boolean {
  if (PATH_ALLOWLIST.some(root => path.startsWith(root))) return true
  if (homeDir) {
    const userApps = homeDir.endsWith('/')
      ? `${homeDir}Applications/`
      : `${homeDir}/Applications/`
    if (path.startsWith(userApps)) return true
  }
  return false
}

function isNoisyName(name: string): boolean {
  return NAME_PATTERN_BLOCKLIST.some(re => re.test(name))
}

/**
 * 长度上限 + 去除首尾空白 + 去重 + 排序。`applyCharFilter` —— 对受信任的
 * Bundle ID（Apple/Google/MS）跳过字符过滤（本地化名称如 "Réglages Système" 含特殊标点
 * 不应被过滤），对可被攻击者安装的应用则应用字符过滤。
 */
function sanitizeCore(
  raw: readonly string[],
  applyCharFilter: boolean,
): string[] {
  const seen = new Set<string>()
  return raw
    .map(name => name.trim())
    .filter(trimmed => {
      if (!trimmed) return false
      if (trimmed.length > APP_NAME_MAX_LEN) return false
      if (applyCharFilter && !APP_NAME_ALLOWED.test(trimmed)) return false
      if (seen.has(trimmed)) return false
      seen.add(trimmed)
      return true
    })
    .sort((a, b) => a.localeCompare(b))
}

function sanitizeAppNames(raw: readonly string[]): string[] {
  const filtered = sanitizeCore(raw, true)
  if (filtered.length <= APP_NAME_MAX_COUNT) return filtered
  return [
    ...filtered.slice(0, APP_NAME_MAX_COUNT),
    `… and ${filtered.length - APP_NAME_MAX_COUNT} more`,
  ]
}

function sanitizeTrustedNames(raw: readonly string[]): string[] {
  return sanitizeCore(raw, false)
}

/**
 * 过滤 Spotlight 原始结果，仅保留面向用户的应用后进行净化。
 * 始终保留的应用绕过路径/名称过滤器和字符白名单
 * （受信任厂商，非攻击者安装）；仍受长度上限、去重和排序约束。
 */
export function filterAppsForDescription(
  installed: readonly InstalledAppLike[],
  homeDir: string | undefined,
): string[] {
  const { alwaysKept, rest } = installed.reduce<{
    alwaysKept: string[]
    rest: string[]
  }>(
    (acc, app) => {
      if (ALWAYS_KEEP_BUNDLE_IDS.has(app.bundleId)) {
        acc.alwaysKept.push(app.displayName)
      } else if (
        isUserFacingPath(app.path, homeDir) &&
        !isNoisyName(app.displayName)
      ) {
        acc.rest.push(app.displayName)
      }
      return acc
    },
    { alwaysKept: [], rest: [] },
  )

  const sanitizedAlways = sanitizeTrustedNames(alwaysKept)
  const alwaysSet = new Set(sanitizedAlways)
  return [
    ...sanitizedAlways,
    ...sanitizeAppNames(rest).filter(n => !alwaysSet.has(n)),
  ]
}
