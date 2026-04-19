/**
 * 基于 Fig spec 的命令前缀深度计算模块。
 *
 * 在 Claude Code 系统中，该模块处于以下位置：
 *   BashTool / PowerShellTool（前缀提取）→ buildPrefix()（本模块）
 *   → 权限系统（prefix:* 规则匹配）
 *
 * 核心职责：
 * - 给定命令名、参数数组和 @withfig/autocomplete CommandSpec，
 *   遍历规范以确定有意义前缀延伸到参数的深度。
 *   例如：`git -C /repo status --short` → `git status`
 *   （spec 指明 -C 接受参数值，跳过它，将 `status` 识别为已知子命令）
 * - 纯函数：输入为 (string, string[], CommandSpec)，无解析器依赖。
 *   从 bash/prefix.ts 中提取，以便 PowerShell 提取器复用；
 *   外部 CLI（git、npm、kubectl）与 Shell 无关。
 *
 * 主要导出：
 * - `DEPTH_RULES`：运行时无法获取 fig spec 的命令的深度覆盖表
 * - `buildPrefix()`：构建命令前缀字符串（async）
 */

import type { CommandSpec } from '../bash/registry.js'

/** 支持的 URL 协议前缀，用于在 shouldStopAtArg 中识别 URL 参数 */
const URL_PROTOCOLS = ['http://', 'https://', 'ftp://']

/**
 * 运行时无法获取 fig spec 的命令的深度覆盖规则表。
 *
 * 背景：动态 import 在原生/node 构建中不可用，无法加载 fig spec。
 * 若无这些规则，calculateDepth 会回退到 2，产生过宽的前缀（false negatives）。
 *
 * 条目格式：`命令名` 或 `命令名 子命令名` → 最大深度
 * 深度含义：前缀中最多包含的词元数（含命令本身）
 */
export const DEPTH_RULES: Record<string, number> = {
  rg: 2, // rg 的 pattern 参数是必填的，尽管后续路径是可变参数
  'pre-commit': 2,
  // 具有深层子命令树的 CLI 工具（如 gcloud scheduler jobs list）
  gcloud: 4,
  'gcloud compute': 6,
  'gcloud beta': 6,
  aws: 4,
  az: 4,
  kubectl: 3,
  docker: 3,
  dotnet: 3,
  'git push': 2,
}

/** 辅助函数：将单值或数组统一转换为数组 */
const toArray = <T>(val: T | T[]): T[] => (Array.isArray(val) ? val : [val])

/**
 * 判断参数是否匹配 spec 中已知的子命令（不区分大小写）。
 *
 * 不区分大小写的原因：PowerShell 调用方传入原始大小写的参数，
 * 而 fig spec 子命令名称为小写。
 *
 * @param arg 当前参数字符串
 * @param spec CommandSpec 或 null
 * @returns 是否为已知子命令
 */
function isKnownSubcommand(arg: string, spec: CommandSpec | null): boolean {
  if (!spec?.subcommands?.length) return false
  const argLower = arg.toLowerCase()
  return spec.subcommands.some(sub =>
    Array.isArray(sub.name)
      ? sub.name.some(n => n.toLowerCase() === argLower)
      : sub.name.toLowerCase() === argLower,
  )
}

/**
 * 判断一个标志（flag）是否需要接受参数值，基于 spec 或启发式规则。
 *
 * 检查优先级：
 * 1. 查找 spec.options 中的精确匹配
 * 2. 启发式：若下一个参数不是标志且不是已知子命令，推断为标志值
 *
 * @param flag 标志字符串（如 "--format"、"-C"）
 * @param nextArg 下一个参数（undefined 表示没有更多参数）
 * @param spec CommandSpec 或 null
 * @returns true 表示该标志接受参数值
 */
function flagTakesArg(
  flag: string,
  nextArg: string | undefined,
  spec: CommandSpec | null,
): boolean {
  // 在 spec.options 中查找精确匹配
  if (spec?.options) {
    const option = spec.options.find(opt =>
      Array.isArray(opt.name) ? opt.name.includes(flag) : opt.name === flag,
    )
    if (option) return !!option.args
  }
  // 启发式：若下一个参数不是标志且不是已知子命令，推断该参数是标志的值
  if (spec?.subcommands?.length && nextArg && !nextArg.startsWith('-')) {
    return !isKnownSubcommand(nextArg, spec)
  }
  return false
}

/**
 * 跳过标志及其参数值，找到第一个子命令。
 *
 * 遍历 args，跳过所有以 '-' 开头的标志（若标志接受参数值则同时跳过该值），
 * 返回第一个非标志参数（优先匹配已知子命令）。
 *
 * @param args 参数数组
 * @param spec CommandSpec 或 null
 * @returns 第一个子命令字符串，未找到则返回 undefined
 */
function findFirstSubcommand(
  args: string[],
  spec: CommandSpec | null,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg.startsWith('-')) {
      // 若该标志接受参数值，跳过下一个参数
      if (flagTakesArg(arg, args[i + 1], spec)) i++
      continue
    }
    // 若 spec 无子命令列表，直接返回当前非标志参数
    if (!spec?.subcommands?.length) return arg
    // 仅返回已知子命令
    if (isKnownSubcommand(arg, spec)) return arg
  }
  return undefined
}

/**
 * 构建命令前缀字符串。
 *
 * 流程：
 * 1. 计算最大前缀深度（calculateDepth）
 * 2. 从命令名开始，依次遍历参数：
 *    - 遇到标志：若为 python -c，停止；若有 isCommand/isModule 参数，纳入前缀；
 *      若在找到子命令前遇到全局标志，跳过以继续查找子命令；否则停止
 *    - 遇到非标志参数：调用 shouldStopAtArg 判断是否停止；将子命令纳入前缀
 * 3. 将收集的词元用空格连接，返回前缀字符串
 *
 * @param command 命令名（如 "git"、"docker"）
 * @param args 参数数组
 * @param spec CommandSpec 或 null
 * @returns 构建的前缀字符串（如 "git status"）
 */
export async function buildPrefix(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<string> {
  const maxDepth = await calculateDepth(command, args, spec)
  const parts = [command]
  const hasSubcommands = !!spec?.subcommands?.length
  let foundSubcommand = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    // 达到最大深度或参数为空，停止
    if (!arg || parts.length >= maxDepth) break

    if (arg.startsWith('-')) {
      // 特殊情况：python -c 应在 -c 后停止（后续为内联脚本字符串）
      if (arg === '-c' && ['python', 'python3'].includes(command.toLowerCase()))
        break

      // 检查 isCommand/isModule 类标志（如 python -m），需纳入前缀
      if (spec?.options) {
        const option = spec.options.find(opt =>
          Array.isArray(opt.name) ? opt.name.includes(arg) : opt.name === arg,
        )
        if (
          option?.args &&
          toArray(option.args).some(a => a?.isCommand || a?.isModule)
        ) {
          // 将此类标志纳入前缀（用于 `python -m module` 等情况）
          parts.push(arg)
          continue
        }
      }

      // 有子命令的命令：跳过全局标志以继续查找子命令
      if (hasSubcommands && !foundSubcommand) {
        if (flagTakesArg(arg, args[i + 1], spec)) i++ // 跳过标志的参数值
        continue
      }
      break // 在子命令已找到后遇到标志，停止（原始行为）
    }

    // 判断是否应在此参数停止（文件路径、URL 等）
    if (await shouldStopAtArg(arg, args.slice(0, i), spec)) break
    // 更新子命令已找到标志
    if (hasSubcommands && !foundSubcommand) {
      foundSubcommand = isKnownSubcommand(arg, spec)
    }
    parts.push(arg)
  }

  return parts.join(' ')
}

/**
 * 计算命令前缀的最大深度（词元数）。
 *
 * 决策优先级：
 * 1. DEPTH_RULES 精确匹配（命令 + 第一个子命令组合键）
 * 2. DEPTH_RULES 命令名匹配
 * 3. 无 spec → 回退到 2
 * 4. 检查是否有 isCommand/isModule 类标志选项 → 3
 * 5. 检查第一个子命令的 spec：
 *    - 子命令有 isCommand 参数 → 3
 *    - 子命令有 isVariadic 参数 → 2
 *    - 子命令有嵌套子命令 → 4
 *    - 子命令无参数声明（叶子子命令，如 git show）→ 2（第三词为过渡性参数）
 *    - 其他 → 3
 * 6. 顶层 spec.args 检查
 * 7. 若有 isDangerous 参数 → 3，否则 → 2
 *
 * @param command 命令名
 * @param args 参数数组
 * @param spec CommandSpec 或 null
 * @returns 前缀最大深度
 */
async function calculateDepth(
  command: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<number> {
  // 找到第一个子命令（跳过标志及其参数值）
  const firstSubcommand = findFirstSubcommand(args, spec)
  const commandLower = command.toLowerCase()
  // 尝试 "命令 子命令" 组合键（如 "gcloud compute"、"git push"）
  const key = firstSubcommand
    ? `${commandLower} ${firstSubcommand.toLowerCase()}`
    : commandLower
  if (DEPTH_RULES[key]) return DEPTH_RULES[key]
  if (DEPTH_RULES[commandLower]) return DEPTH_RULES[commandLower]
  // 无 spec，回退到深度 2（命令 + 第一个非标志参数）
  if (!spec) return 2

  // 检查是否有 isCommand/isModule 类标志选项（如 python -m、xargs -I）
  if (spec.options && args.some(arg => arg?.startsWith('-'))) {
    for (const arg of args) {
      if (!arg?.startsWith('-')) continue
      const option = spec.options.find(opt =>
        Array.isArray(opt.name) ? opt.name.includes(arg) : opt.name === arg,
      )
      if (
        option?.args &&
        toArray(option.args).some(arg => arg?.isCommand || arg?.isModule)
      )
        return 3
    }
  }

  // 使用已找到的 firstSubcommand 查找子命令 spec
  if (firstSubcommand && spec.subcommands?.length) {
    const firstSubLower = firstSubcommand.toLowerCase()
    const subcommand = spec.subcommands.find(sub =>
      Array.isArray(sub.name)
        ? sub.name.some(n => n.toLowerCase() === firstSubLower)
        : sub.name.toLowerCase() === firstSubLower,
    )
    if (subcommand) {
      if (subcommand.args) {
        const subArgs = toArray(subcommand.args)
        // 子命令的参数是命令时（如 xargs），需要深度 3
        if (subArgs.some(arg => arg?.isCommand)) return 3
        // 子命令的参数是可变参数时，第三词即为该可变参数，深度 2 即可
        if (subArgs.some(arg => arg?.isVariadic)) return 2
      }
      // 子命令有嵌套子命令时（如 gcloud compute instances），深度 4
      if (subcommand.subcommands?.length) return 4
      // 叶子子命令无参数声明（如 git show、git log、git tag）：
      // 第三词是临时性参数（SHA、ref、tag 名），不应纳入前缀
      // 注意：与 isOptional 不同——git fetch 声明了可选 remote/branch，
      // `git fetch origin` 是有意义的远程范围限定（见 bash/prefix.test.ts:912）
      if (!subcommand.args) return 2
      return 3
    }
  }

  // 检查顶层 spec.args
  if (spec.args) {
    const argsArray = toArray(spec.args)

    if (argsArray.some(arg => arg?.isCommand)) {
      // 单个 isCommand 参数：命令 + 命令参数本身 = 深度 2
      // 多个参数中有 isCommand：取 isCommand 位置 + 2，最多 3
      return !Array.isArray(spec.args) && spec.args.isCommand
        ? 2
        : Math.min(2 + argsArray.findIndex(arg => arg?.isCommand), 3)
    }

    if (!spec.subcommands?.length) {
      // 可变参数（如文件列表）：命令名即为前缀，深度 1
      if (argsArray.some(arg => arg?.isVariadic)) return 1
      // 第一个参数是必填的（非可选）：命令 + 第一个参数 = 深度 2
      if (argsArray[0] && !argsArray[0].isOptional) return 2
    }
  }

  // 有 isDangerous 参数时，增加深度以避免过宽前缀
  return spec.args && toArray(spec.args).some(arg => arg?.isDangerous) ? 3 : 2
}

/**
 * 判断是否应在某个参数处停止前缀构建。
 *
 * 停止条件：
 * - 参数以 '-' 开头（标志）
 * - 参数包含路径分隔符 '/' 或有文件扩展名（如 .py、.json）
 * - 参数是 URL（以 http://、https://、ftp:// 开头）
 *
 * 例外情况：
 * - python -m 后的模块名（带点的 module.submodule）不视为文件路径
 *
 * @param arg 当前参数
 * @param args 当前参数之前的所有参数（用于判断上下文）
 * @param spec CommandSpec 或 null
 * @returns true 表示应在此参数停止
 */
async function shouldStopAtArg(
  arg: string,
  args: string[],
  spec: CommandSpec | null,
): Promise<boolean> {
  // 标志（以 '-' 开头）始终停止
  if (arg.startsWith('-')) return true

  // 检测文件扩展名（点在非首位且非末位，且点后不含冒号，排除 Windows 驱动器路径）
  const dotIndex = arg.lastIndexOf('.')
  const hasExtension =
    dotIndex > 0 &&
    dotIndex < arg.length - 1 &&
    !arg.substring(dotIndex + 1).includes(':')

  // 有路径分隔符或文件扩展名，认为是文件路径
  const hasFile = arg.includes('/') || hasExtension
  // 检测 URL
  const hasUrl = URL_PROTOCOLS.some(proto => arg.startsWith(proto))

  // 既不是文件路径也不是 URL，继续构建前缀
  if (!hasFile && !hasUrl) return false

  // 特殊情况：python -m <module> 中的模块名（如 `pytest.ini`）不应停止
  // 检查前一个参数是否为 -m 标志
  if (spec?.options && args.length > 0 && args[args.length - 1] === '-m') {
    const option = spec.options.find(opt =>
      Array.isArray(opt.name) ? opt.name.includes('-m') : opt.name === '-m',
    )
    if (option?.args && toArray(option.args).some(arg => arg?.isModule)) {
      return false // 模块名不停止
    }
  }

  // 确认为文件路径或 URL，停止前缀构建
  return true
}
