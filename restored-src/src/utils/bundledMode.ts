/**
 * Bun 运行时与打包模式检测模块。
 *
 * 在 Claude Code 系统中，该模块提供两个运行时环境检测函数：
 * - isRunningWithBun()：检测当前是否通过 Bun 运行（bun 命令或 Bun 编译的独立可执行文件）
 * - isInBundledMode()：检测当前是否运行于 Bun 编译的独立可执行文件模式
 *   （通过检测 Bun.embeddedFiles 是否有内嵌文件来判断）
 *
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * 检测当前是否以 Bun 编译的独立可执行文件模式运行。
 * 通过检测 Bun.embeddedFiles 数组是否非空来判断（打包后会有内嵌文件）。
 * Detects if running as a Bun-compiled standalone executable.
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}
