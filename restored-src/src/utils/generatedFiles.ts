/**
 * 生成文件检测工具模块（Generated Files Detector）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于 Claude Code 的代码分析辅助层，被代码统计、差异分析、
 * 文件归因等模块调用，用于在分析前过滤掉自动生成文件、第三方依赖文件
 * 和构建产物，避免将其计入人工编写代码的统计范围。
 * 规则参考 GitHub Linguist 的 vendor/generated 模式以及常见的构建产物命名惯例。
 *
 * 【主要功能】
 * - EXCLUDED_FILENAMES：精确文件名匹配集合（锁文件等）
 * - EXCLUDED_EXTENSIONS：扩展名匹配集合（.min.js、.d.ts 等）
 * - EXCLUDED_DIRECTORIES：目录路径模式列表（dist、node_modules 等）
 * - EXCLUDED_FILENAME_PATTERNS：复杂文件名 regex 模式（protobuf 生成文件等）
 * - isGeneratedFile(filePath)：综合以上四类规则判断单个文件是否为生成文件
 * - filterGeneratedFiles(files)：批量过滤生成文件
 */

import { basename, extname, posix, sep } from 'path'

/**
 * 精确文件名匹配集合（大小写不敏感）。
 * 涵盖主流包管理器的锁文件，这些文件由工具自动生成，不应计入人工代码统计。
 */
// 精确文件名匹配（大小写不敏感）
const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',   // npm 锁文件
  'yarn.lock',           // Yarn 锁文件
  'pnpm-lock.yaml',      // pnpm 锁文件
  'bun.lockb',           // Bun 二进制锁文件
  'bun.lock',            // Bun 文本锁文件
  'composer.lock',       // PHP Composer 锁文件
  'gemfile.lock',        // Ruby Bundler 锁文件
  'cargo.lock',          // Rust Cargo 锁文件
  'poetry.lock',         // Python Poetry 锁文件
  'pipfile.lock',        // Python Pipenv 锁文件
  'shrinkwrap.json',     // npm shrinkwrap 文件
  'npm-shrinkwrap.json', // npm shrinkwrap 文件（带前缀）
])

/**
 * 文件扩展名匹配集合（大小写不敏感）。
 * 涵盖压缩包、打包文件、类型声明文件等自动生成内容。
 */
// 文件扩展名匹配（大小写不敏感）
const EXCLUDED_EXTENSIONS = new Set([
  '.lock',            // 通用锁文件
  '.min.js',          // 压缩 JavaScript
  '.min.css',         // 压缩 CSS
  '.min.html',        // 压缩 HTML
  '.bundle.js',       // 打包 JavaScript
  '.bundle.css',      // 打包 CSS
  '.generated.ts',    // 显式标记为生成的 TypeScript
  '.generated.js',    // 显式标记为生成的 JavaScript
  '.d.ts',            // TypeScript 类型声明文件
])

/**
 * 目录路径模式列表，路径中包含这些片段的文件视为生成/第三方内容。
 * 覆盖主流构建输出目录、包管理器目录、框架缓存目录等。
 */
// 指示生成/第三方内容的目录模式
const EXCLUDED_DIRECTORIES = [
  '/dist/',         // 构建输出目录
  '/build/',        // 构建目录
  '/out/',          // 输出目录
  '/output/',       // 输出目录（变体）
  '/node_modules/', // Node.js 依赖
  '/vendor/',       // 第三方代码
  '/vendored/',     // 第三方代码（变体）
  '/third_party/',  // 第三方代码（下划线）
  '/third-party/',  // 第三方代码（连字符）
  '/external/',     // 外部依赖
  '/.next/',        // Next.js 构建缓存
  '/.nuxt/',        // Nuxt.js 构建缓存
  '/.svelte-kit/',  // SvelteKit 构建缓存
  '/coverage/',     // 测试覆盖率报告
  '/__pycache__/',  // Python 字节码缓存
  '/.tox/',         // Python tox 测试环境
  '/venv/',         // Python 虚拟环境
  '/.venv/',        // Python 虚拟环境（点前缀）
  '/target/release/', // Rust 发布构建
  '/target/debug/', // Rust 调试构建
]

/**
 * 复杂文件名 regex 模式列表，用于匹配无法通过简单扩展名识别的生成文件。
 * 涵盖压缩文件命名惯例、代码生成器约定（protobuf、gRPC、Swagger 等）。
 */
// 文件名正则模式（用于复杂匹配）
const EXCLUDED_FILENAME_PATTERNS = [
  /^.*\.min\.[a-z]+$/i,         // *.min.*（压缩文件）
  /^.*-min\.[a-z]+$/i,          // *-min.*（压缩文件变体）
  /^.*\.bundle\.[a-z]+$/i,      // *.bundle.*（打包文件）
  /^.*\.generated\.[a-z]+$/i,   // *.generated.*（显式生成标记）
  /^.*\.gen\.[a-z]+$/i,         // *.gen.*（生成文件简写）
  /^.*\.auto\.[a-z]+$/i,        // *.auto.*（自动生成文件）
  /^.*_generated\.[a-z]+$/i,    // *_generated.*（下划线风格生成标记）
  /^.*_gen\.[a-z]+$/i,          // *_gen.*（下划线风格简写）
  /^.*\.pb\.(go|js|ts|py|rb)$/i, // Protocol Buffer 生成文件（多语言）
  /^.*_pb2?\.py$/i,             // Python protobuf 生成文件
  /^.*\.pb\.h$/i,               // C++ protobuf 头文件
  /^.*\.grpc\.[a-z]+$/i,        // gRPC 生成文件
  /^.*\.swagger\.[a-z]+$/i,     // Swagger 生成文件
  /^.*\.openapi\.[a-z]+$/i,     // OpenAPI 生成文件
]

/**
 * 判断给定文件是否为自动生成文件（应从归因统计中排除）。
 *
 * 【检测顺序】
 * 1. 路径规范化：将平台路径分隔符统一为 posix 风格，添加前导斜杠；
 * 2. 精确文件名匹配（EXCLUDED_FILENAMES）；
 * 3. 单一扩展名匹配（EXCLUDED_EXTENSIONS）；
 * 4. 复合扩展名匹配（如 `.min.js`，取最后两段拼合为扩展名）；
 * 5. 目录路径片段匹配（EXCLUDED_DIRECTORIES）；
 * 6. 文件名正则模式匹配（EXCLUDED_FILENAME_PATTERNS）。
 *
 * @param filePath - 相对于仓库根目录的文件路径
 * @returns 若文件为生成/第三方文件则返回 true
 */
export function isGeneratedFile(filePath: string): boolean {
  // 将平台路径分隔符统一为 posix 风格的 /，并添加前导 / 以匹配目录模式
  const normalizedPath =
    posix.sep + filePath.split(sep).join(posix.sep).replace(/^\/+/, '')
  const fileName = basename(filePath).toLowerCase() // 文件名（小写，用于大小写不敏感匹配）
  const ext = extname(filePath).toLowerCase()        // 最后一段扩展名

  // 第一步：精确文件名匹配（如 package-lock.json）
  if (EXCLUDED_FILENAMES.has(fileName)) {
    return true
  }

  // 第二步：单一扩展名匹配（如 .d.ts）
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return true
  }

  // 第三步：复合扩展名匹配（如 foo.min.js → .min.js）
  const parts = fileName.split('.')
  if (parts.length > 2) {
    const compoundExt = '.' + parts.slice(-2).join('.') // 取最后两段组合
    if (EXCLUDED_EXTENSIONS.has(compoundExt)) {
      return true
    }
  }

  // 第四步：目录路径片段匹配（如路径包含 /node_modules/）
  for (const dir of EXCLUDED_DIRECTORIES) {
    if (normalizedPath.includes(dir)) {
      return true
    }
  }

  // 第五步：文件名 regex 模式匹配（如 foo.pb.go、bar_generated.ts）
  for (const pattern of EXCLUDED_FILENAME_PATTERNS) {
    if (pattern.test(fileName)) {
      return true
    }
  }

  return false // 不符合任何排除规则，视为人工编写文件
}

/**
 * 从文件路径数组中过滤掉所有生成文件，返回仅包含人工编写文件的数组。
 *
 * @param files - 文件路径数组
 * @returns 过滤后的文件路径数组（不含生成/第三方文件）
 */
export function filterGeneratedFiles(files: string[]): string[] {
  return files.filter(file => !isGeneratedFile(file)) // 保留非生成文件
}
