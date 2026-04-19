/**
 * CLI 退出辅助工具 — 用于各子命令处理器的统一退出入口。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件位于 CLI 层，被 `claude mcp *`、`claude plugin *` 等约 60 处子命令处理器
 * 调用，用以取代原先散落各处的 "print + lint-suppress + exit" 四五行重复代码块。
 *
 * 设计要点：
 * - 返回类型声明为 `: never`，让 TypeScript 在调用处能正确收窄控制流，
 *   省去多余的 `return` 语句。
 * - 测试环境中 spy 了 `process.exit`，使其可以"返回"（而非真正退出），
 *   call site 写 `return cliError(...)` 是为了让 TypeScript 在 mock 下
 *   也能推断后续代码已不可达，避免对已被收窄变量的误引用。
 * - cliError 使用 console.error（测试 spy 点），cliOk 使用 process.stdout.write
 *   （Bun 的 console.log 不会经过 spied process.stdout.write，故不用 console.log）。
 */
/* eslint-disable custom-rules/no-process-exit -- centralized CLI exit point */

// `return undefined as never` (not a post-exit throw) — tests spy on
// process.exit and let it return. Call sites write `return cliError(...)`
// where subsequent code would dereference narrowed-away values under mock.
// cliError uses console.error (tests spy on console.error); cliOk uses
// process.stdout.write (tests spy on process.stdout.write — Bun's console.log
// doesn't route through a spied process.stdout.write).

/**
 * 将错误消息写入 stderr（若提供）并以退出码 1 终止进程。
 *
 * 流程：若 msg 非空则通过 console.error 输出到 stderr，
 * 然后调用 process.exit(1) 终止进程。
 * 返回 `undefined as never` 以满足 TypeScript 控制流分析。
 */
export function cliError(msg?: string): never {
  // biome-ignore lint/suspicious/noConsole: centralized CLI error output
  // 仅在有消息时才输出，避免在无参调用时打印空行
  if (msg) console.error(msg)
  process.exit(1)
  // 测试环境下 process.exit 被 spy 替换，此处 cast 防止编译器报"缺少返回值"
  return undefined as never
}

/**
 * 将消息写入 stdout（若提供）并以退出码 0 终止进程。
 *
 * 流程：若 msg 非空则通过 process.stdout.write 输出（附换行符），
 * 然后调用 process.exit(0) 正常退出。
 * 返回 `undefined as never` 以满足 TypeScript 控制流分析。
 */
export function cliOk(msg?: string): never {
  // 使用 process.stdout.write 而非 console.log，以便测试可 spy stdout
  if (msg) process.stdout.write(msg + '\n')
  process.exit(0)
  // 同 cliError，cast 是为 TypeScript 类型推断服务
  return undefined as never
}
