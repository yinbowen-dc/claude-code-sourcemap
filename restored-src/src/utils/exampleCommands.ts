/**
 * 示例命令生成模块。
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块位于 REPL 启动阶段与用户交互层之间。当用户首次打开 Claude Code 或在空提示
 * 状态下停留时，REPL 会调用 getExampleCommandFromCache() 在输入框占位符处展示
 * 一条示例命令，引导用户了解功能。后台任务 refreshExampleCommands() 负责异步刷新
 * 候选文件列表（通过 git log 分析高频修改文件），并持久化到项目配置中。
 *
 * 【主要功能】
 * - 从当前 git 仓库历史中找出用户高频修改的核心源码文件
 * - 过滤掉自动生成文件、依赖文件、配置文件等非核心文件
 * - 从候选文件中按目录多样性抽取最具代表性的文件
 * - 将候选文件缓存到项目配置（每周刷新一次），并随机生成示例命令文本
 *
 * 【依赖关系】
 * config.ts（项目配置读写） → exampleCommands.ts → REPL 占位符渲染
 */
import memoize from 'lodash-es/memoize.js'
import sample from 'lodash-es/sample.js'
import { getCwd } from '../utils/cwd.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './config.js'
import { env } from './env.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { logError } from './log.js'
import { getGitEmail } from './user.js'

/**
 * 非核心文件的正则匹配模式列表。
 *
 * 用于在推荐示例命令时过滤掉与业务逻辑无关的文件，确保推荐文件
 * 是真正值得阅读、重构或测试的源代码文件。
 * 覆盖以下几类：
 *  - lock 文件 / 依赖清单（package-lock.json、poetry.lock 等）
 *  - 构建产物与自动生成文件（dist/、*.min.js、*.generated.* 等）
 *  - 数据 / 文档 / 配置扩展名（.json、.yaml、.md 等）
 *  - 编辑器、CI、框架配置文件（tsconfig、vite.config 等）
 *  - 文档 / 变更日志（CHANGELOG、README 等）
 */
// 非核心文件匹配模式——决定性地过滤，不依赖 AI（如 Haiku）判断
const NON_CORE_PATTERNS = [
  // lock 文件 / 依赖清单
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lock|bun\.lockb|pnpm-lock\.yaml|Pipfile\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/,
  // 自动生成 / 构建产物
  /\.generated\./,
  /(?:^|\/)(?:dist|build|out|target|node_modules|\.next|__pycache__)\//,
  /\.(?:min\.js|min\.css|map|pyc|pyo)$/,
  // 数据 / 文档 / 配置扩展名（不适合作为 "写测试" 的目标）
  /\.(?:json|ya?ml|toml|xml|ini|cfg|conf|env|lock|txt|md|mdx|rst|csv|log|svg)$/i,
  // 配置文件 / 元数据
  /(?:^|\/)\.?(?:eslintrc|prettierrc|babelrc|editorconfig|gitignore|gitattributes|dockerignore|npmrc)/,
  /(?:^|\/)(?:tsconfig|jsconfig|biome|vitest\.config|jest\.config|webpack\.config|vite\.config|rollup\.config)\.[a-z]+$/,
  /(?:^|\/)\.(?:github|vscode|idea|claude)\//,
  // 文档 / 变更日志（不适合 "X 是怎么工作的" 类问题）
  /(?:^|\/)(?:CHANGELOG|LICENSE|CONTRIBUTING|CODEOWNERS|README)(?:\.[a-z]+)?$/i,
]

/**
 * 判断给定路径是否为核心源码文件。
 *
 * 逻辑：只要不匹配任何非核心模式，即视为核心文件。
 *
 * @param path - 待判断的文件路径（相对路径）
 * @returns 若为核心文件则返回 true，否则返回 false
 */
function isCoreFile(path: string): boolean {
  // 遍历所有非核心模式，有任意一个匹配则返回 false
  return !NON_CORE_PATTERNS.some(p => p.test(path))
}

/**
 * 统计字符串数组中每个元素的出现次数，并以降序格式化输出前 N 名。
 *
 * 【用途】调试辅助：可将 git log 的文件列表传入，直观展示高频修改文件。
 *
 * @param items - 待统计的字符串数组（可有重复）
 * @param topN  - 返回出现次数最多的前 N 项，默认 20
 * @returns 格式化字符串，每行为 "  count  item"，按出现次数降序排列
 */
export function countAndSortItems(items: string[], topN: number = 20): string {
  // 使用 Map 对每个元素计数
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1)
  }
  // 按次数降序排序，取前 N 条，格式化输出
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([item, count]) => `${count.toString().padStart(6)} ${item}`)
    .join('\n')
}

/**
 * 从按频率降序排列的路径列表中，选取最多 want 个多样性核心文件（basename 去重 + 跨目录分散）。
 *
 * 【算法】贪心多轮扫描：
 *  - 每轮（cap = 1, 2, ...）允许同一目录最多贡献 cap 个文件
 *  - 优先选择频率高的文件，同时防止结果全部集中在同一热点目录
 *  - 若最终可选核心文件不足 want 个，则返回空数组（避免展示不完整列表）
 *
 * @param sortedPaths - 已按修改频率降序排序的文件路径列表
 * @param want        - 期望选取的文件数量
 * @returns 选取的 basename 列表，或空数组（核心文件不足时）
 */
export function pickDiverseCoreFiles(
  sortedPaths: string[],
  want: number,
): string[] {
  const picked: string[] = []          // 已选中的 basename
  const seenBasenames = new Set<string>() // 防止同名文件重复入选
  const dirTally = new Map<string, number>() // 每个目录已贡献的文件数

  // 贪心多轮：cap 逐轮 +1，允许热点目录在后续轮次贡献更多文件
  // 这样既能保证跨目录多样性，又不会在仓库目录结构极少时陷入死循环
  for (let cap = 1; picked.length < want && cap <= want; cap++) {
    for (const p of sortedPaths) {
      if (picked.length >= want) break    // 已达目标数量，提前退出
      if (!isCoreFile(p)) continue        // 过滤非核心文件
      // 从路径中提取 basename 和所在目录
      const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      const base = lastSep >= 0 ? p.slice(lastSep + 1) : p
      if (!base || seenBasenames.has(base)) continue // basename 去重
      const dir = lastSep >= 0 ? p.slice(0, lastSep) : '.'
      if ((dirTally.get(dir) ?? 0) >= cap) continue  // 当前轮次该目录已到上限
      // 纳入候选
      picked.push(base)
      seenBasenames.add(base)
      dirTally.set(dir, (dirTally.get(dir) ?? 0) + 1)
    }
  }

  // 若选取数量不足，说明仓库核心文件过少，返回空数组
  return picked.length >= want ? picked : []
}

/**
 * 异步获取当前 git 仓库中用户高频修改的核心文件列表。
 *
 * 【流程】
 * 1. 环境检查：测试环境、Windows、非 git 仓库直接返回空数组
 * 2. 优先查询当前用户的提交历史（--author=email），取最近 1000 条
 * 3. 若用户自身历史不足 10 个文件，则回退到全员历史补充
 * 4. 统计每个文件的修改次数，排序后调用 pickDiverseCoreFiles 选取 5 个
 *
 * @returns 最多 5 个多样性核心文件的 basename 列表，失败时返回空数组
 */
async function getFrequentlyModifiedFiles(): Promise<string[]> {
  // 测试环境直接跳过，避免污染 git 历史
  if (process.env.NODE_ENV === 'test') return []
  // Windows 暂不支持（execFileNoThrowWithCwd 在 win32 路径处理存在差异）
  if (env.platform === 'win32') return []
  // 非 git 仓库无法获取历史
  if (!(await getIsGit())) return []

  try {
    // 从 git log 中获取高频修改文件，优先使用当前用户的提交
    const userEmail = await getGitEmail()

    // git log 参数：最近 1000 条提交、只输出文件名、只统计修改（M）操作
    const logArgs = [
      'log',
      '-n',
      '1000',
      '--pretty=format:', // 不输出提交信息，只输出文件名
      '--name-only',
      '--diff-filter=M',  // 只统计已存在文件的修改，不含新增/删除
    ]

    // 用 Map 统计每个文件的修改次数
    const counts = new Map<string, number>()
    // 辅助函数：将 git log 输出的文件名列表累加到计数 Map
    const tallyInto = (stdout: string) => {
      for (const line of stdout.split('\n')) {
        const f = line.trim()
        if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
      }
    }

    // 首先尝试当前用户的提交历史
    if (userEmail) {
      const { stdout } = await execFileNoThrowWithCwd(
        'git',
        [...logArgs, `--author=${userEmail}`], // 限定作者为当前用户
        { cwd: getCwd() },
      )
      tallyInto(stdout)
    }

    // 若当前用户历史过少（< 10 个文件），回退到全员历史补充计数
    if (counts.size < 10) {
      const { stdout } = await execFileNoThrowWithCwd(gitExe(), logArgs, {
        cwd: getCwd(),
      })
      tallyInto(stdout)
    }

    // 按修改次数降序排序，提取路径列表
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p)

    // 从排序结果中选取 5 个多样性核心文件
    return pickDiverseCoreFiles(sorted, 5)
  } catch (err) {
    logError(err as Error)
    return []
  }
}

/** 一周的毫秒数，用于判断示例文件缓存是否过期 */
const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 从项目配置缓存中获取一条随机示例命令文本。
 *
 * 使用 lodash memoize 缓存结果，确保同一次启动内只随机一次，避免每次渲染结果不同。
 *
 * 【流程】
 * 1. 读取项目配置中缓存的示例文件列表（exampleFiles）
 * 2. 若列表非空，随机取一个文件名；否则使用占位符 '<filepath>'
 * 3. 从预设命令模板池中随机选取一条，填入文件名后返回
 *
 * @returns 格式为 `Try "..."` 的示例命令字符串
 */
export const getExampleCommandFromCache = memoize(() => {
  const projectConfig = getCurrentProjectConfig()
  // 若已有缓存文件列表，随机取一个；否则使用泛型占位符
  const frequentFile = projectConfig.exampleFiles?.length
    ? sample(projectConfig.exampleFiles)
    : '<filepath>'

  // 预设命令模板池，涵盖常见的 Claude Code 使用场景
  const commands = [
    'fix lint errors',
    'fix typecheck errors',
    `how does ${frequentFile} work?`,
    `refactor ${frequentFile}`,
    'how do I log an error?',
    `edit ${frequentFile} to...`,
    `write a test for ${frequentFile}`,
    'create a util logging.py that...',
  ]

  // 随机选取一条命令并包裹在 Try "..." 中
  return `Try "${sample(commands)}"`
})

/**
 * 后台异步刷新示例命令候选文件列表。
 *
 * 使用 lodash memoize 保证每次进程内只执行一次刷新流程，避免并发重复请求。
 *
 * 【触发条件】
 * - 项目配置中的 exampleFiles 缓存超过一周（过期清空，触发重新获取）
 * - exampleFiles 为空或未设置（首次运行）
 *
 * 【刷新策略】
 * - fire-and-forget：不 await 结果，避免阻塞 REPL 启动
 * - 获取成功后通过 saveCurrentProjectConfig 持久化文件列表与时间戳
 */
export const refreshExampleCommands = memoize(async (): Promise<void> => {
  const projectConfig = getCurrentProjectConfig()
  const now = Date.now()
  const lastGenerated = projectConfig.exampleFilesGeneratedAt ?? 0

  // 若缓存已超过一周，清空旧列表以触发重新获取
  if (now - lastGenerated > ONE_WEEK_IN_MS) {
    projectConfig.exampleFiles = []
  }

  // 若当前没有缓存文件，则在后台异步获取并持久化
  if (!projectConfig.exampleFiles?.length) {
    // 不 await，避免阻塞调用方；结果通过回调持久化到配置
    void getFrequentlyModifiedFiles().then(files => {
      if (files.length) {
        saveCurrentProjectConfig(current => ({
          ...current,
          exampleFiles: files,
          exampleFilesGeneratedAt: Date.now(), // 记录生成时间戳，用于下次过期判断
        }))
      }
    })
  }
})
