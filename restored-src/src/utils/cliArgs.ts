/**
 * CLI 参数早期解析工具模块。
 *
 * 在 Claude Code 系统中，该模块提供在 Commander.js 初始化之前提前解析 CLI 参数的能力：
 * - eagerParseCliFlag()：在 init() 运行前提前读取指定 flag 的值（如 --settings），
 *   同时支持 --flag=value 和 --flag value 两种语法
 * - extractArgsAfterDoubleDash()：修正 Commander.js passThroughOptions 模式下
 *   `--` 分隔符被作为位置参数传入时的解析偏差
 */

/**
 * 在 Commander.js 处理参数之前提前解析指定 CLI flag 的值。
 * 同时支持 `--flag=value`（等号连接）和 `--flag value`（空格分隔）两种语法。
 *
 * 该函数专为那些必须在 init() 运行前解析的 flag 而设计，
 * 例如 --settings 会影响配置文件加载路径。常规 flag 解析仍应交由 Commander.js 处理。
 *
 * @param flagName - 含前缀连字符的 flag 名称（如 '--settings'）
 * @param argv - 可选的参数数组，默认使用 process.argv
 * @returns flag 对应的值，未找到时返回 undefined
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // 处理 --flag=value 语法：截取等号后的部分
    if (arg?.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
    // 处理 --flag value 语法：取下一个参数作为值
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * 处理 CLI 参数中的标准 Unix `--` 分隔符约定。
 *
 * 当 Commander.js 使用 `.passThroughOptions()` 时，`--` 会作为位置参数透传，
 * 而非被消费掉。例如用户执行：
 *   `cmd --opt value name -- subcmd --flag arg`
 *
 * Commander 会将其解析为：
 *   positional1 = "name"，positional2 = "--"，rest = ["subcmd", "--flag", "arg"]
 *
 * 本函数在检测到位置参数为 `--` 时，从 rest 数组中提取真正的子命令，
 * 纠正上述解析偏差。
 *
 * @param commandOrValue - 可能为 "--" 的已解析位置参数
 * @param args - 剩余参数数组
 * @returns 包含修正后 command 和 args 的对象
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    // 将 rest 数组的第一个元素作为真正的命令，其余作为该命令的参数
    return {
      command: args[0]!,
      args: args.slice(1),
    }
  }
  return { command: commandOrValue, args }
}
