/**
 * 无异常子进程执行模块。
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块是整个系统执行外部命令（git、shell 工具等）的核心底层封装，
 * 被 git.ts、shell.ts、exampleCommands.ts 等大量工具模块直接调用。
 * 处于工具层（Tool Layer）之下的基础设施层，为上层提供统一、安全的子进程执行接口。
 *
 * 【设计原则】
 * - 永不抛出异常：所有执行结果都通过 Promise resolve 返回，包括错误情况
 * - 跨平台兼容：底层使用 execa，在 Windows 上自动处理 .bat/.cmd 文件与 shell 转义
 * - 结构化返回：统一返回 { stdout, stderr, code, error? } 四元组
 * - 超时保护：默认超时 10 分钟，防止子进程无限阻塞
 *
 * 【主要导出】
 * - execFileNoThrow()：使用 getCwd() 作为工作目录的便捷版本
 * - execFileNoThrowWithCwd()：允许调用方指定工作目录的完整版本
 */
// 本文件是对 node:child_process 的有用封装
// 这些封装简化了错误处理和跨平台兼容性
// 通过使用 execa，Windows 自动获得 shell 转义 + BAT/CMD 处理支持

import { type ExecaError, execa } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { logError } from './log.js'

// 从 execFileNoThrowPortable 中重新导出已废弃的同步执行函数，保持向后兼容
export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

/** 毫秒与秒的换算常量 */
const MS_IN_SECOND = 1000
/** 秒与分钟的换算常量 */
const SECONDS_IN_MINUTE = 60

/**
 * execFileNoThrow 的选项类型定义。
 *
 * useCwd 标志的设计用途：
 * 避免初始化阶段的循环依赖——getCwd() 依赖 PersistentShell，
 * PersistentShell 调用 logEvent()，logEvent() 又可能调用 execFileNoThrow，
 * 形成循环。在初始化路径上将 useCwd 设为 false 可打断此循环。
 */
type ExecFileOptions = {
  abortSignal?: AbortSignal          // 可选的取消信号，用于中止执行中的子进程
  timeout?: number                   // 超时毫秒数，默认 10 分钟
  preserveOutputOnError?: boolean    // 错误时是否保留 stdout/stderr 输出，默认 true
  // 设置 useCwd=false 可避免初始化阶段的循环依赖
  // getCwd() → PersistentShell → logEvent() → execFileNoThrow
  useCwd?: boolean                   // 是否使用 getCwd() 作为工作目录
  env?: NodeJS.ProcessEnv            // 自定义环境变量
  stdin?: 'ignore' | 'inherit' | 'pipe' // stdin 处理方式
  input?: string                     // 作为 stdin 传入子进程的字符串内容
}

/**
 * 执行外部命令的便捷封装，自动使用当前工作目录（getCwd()）。
 *
 * 【流程】
 * 将 useCwd 选项转换为具体的 cwd 路径后，委托给 execFileNoThrowWithCwd 执行。
 * 这是系统中最常用的子进程执行入口。
 *
 * @param file    - 可执行文件名或路径（如 'git'、'npm'）
 * @param args    - 命令行参数数组
 * @param options - 执行选项，默认超时 10 分钟、保留错误输出、使用当前目录
 * @returns       - { stdout, stderr, code, error? }，永远 resolve，不 reject
 */
export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  // 将 useCwd 布尔值转换为实际路径，或 undefined（不指定工作目录）
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

/**
 * execFileNoThrowWithCwd 的选项类型，允许调用方指定任意工作目录。
 */
type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal            // 可选的取消信号
  timeout?: number                     // 超时毫秒数
  preserveOutputOnError?: boolean      // 错误时是否保留输出
  maxBuffer?: number                   // 输出缓冲区上限（字节）
  cwd?: string                         // 工作目录，undefined 时继承父进程目录
  env?: NodeJS.ProcessEnv              // 自定义环境变量
  shell?: boolean | string | undefined // 是否通过 shell 执行
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string                       // 作为 stdin 传入的内容
}

/**
 * 从 execa 结果中提取可读错误信息的辅助类型。
 */
type ExecaResultWithError = {
  shortMessage?: string  // execa 生成的人类可读错误描述
  signal?: string        // 终止进程的信号名（如 "SIGTERM"）
}

/**
 * 从 execa 执行结果中提取最具信息量的错误描述字符串。
 *
 * 优先级：
 * 1. shortMessage（如 "Command failed with exit code 1: ..."）——已包含信号信息
 * 2. signal（如 "SIGTERM"）——进程被信号终止时
 * 3. errorCode 转字符串——兜底，仅返回退出码数字
 *
 * @param result    - execa 结果对象（含 shortMessage 和 signal 字段）
 * @param errorCode - 退出码，用于最后兜底
 * @returns 人类可读的错误描述字符串
 */
function getErrorMessage(
  result: ExecaResultWithError,
  errorCode: number,
): string {
  // 优先使用 execa 的 shortMessage，其中已包含信号描述
  if (result.shortMessage) {
    return result.shortMessage
  }
  // 其次使用信号名（进程被 kill 时）
  if (typeof result.signal === 'string') {
    return result.signal
  }
  // 最后兜底：返回退出码字符串
  return String(errorCode)
}

/**
 * 带指定工作目录的无异常子进程执行函数。
 *
 * 【核心设计】
 * 使用 Promise 包装 execa，确保任何情况（失败、超时、信号终止）都通过
 * resolve 而非 reject 返回，调用方无需 try/catch。
 *
 * 【流程】
 * 1. 以 reject:false 调用 execa，即使退出码非 0 也不抛出异常
 * 2. 若执行失败（result.failed === true）：
 *    - preserveOutputOnError=true：保留 stdout/stderr 并附带错误描述
 *    - preserveOutputOnError=false：返回空输出
 * 3. 若执行成功：返回 stdout、stderr 和退出码 0
 * 4. catch 块兜底：记录错误日志，返回空结果
 *
 * @param file    - 可执行文件名或路径
 * @param args    - 命令行参数数组
 * @param options - 详细执行选项（含工作目录、超时、缓冲区等）
 * @returns       - { stdout, stderr, code, error? }，永远 resolve
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer,
    shell,
    stdin: finalStdin,
    input: finalInput,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: 1_000_000, // 默认 1MB 输出缓冲区
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    // 使用 execa 以获得跨平台 .bat/.cmd 兼容性（Windows 自动处理）
    execa(file, args, {
      maxBuffer,
      signal: abortSignal,   // 传入取消信号，支持 AbortController 中止
      timeout: finalTimeout,
      cwd: finalCwd,
      env: finalEnv,
      shell,
      stdin: finalStdin,
      input: finalInput,
      reject: false, // 关键：禁止 execa 在非零退出码时抛出异常
    })
      .then(result => {
        if (result.failed) {
          // 执行失败分支
          if (finalPreserveOutput) {
            // 保留模式：返回实际的 stdout/stderr 和错误描述
            const errorCode = result.exitCode ?? 1
            void resolve({
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              code: errorCode,
              error: getErrorMessage(
                result as unknown as ExecaResultWithError,
                errorCode,
              ),
            })
          } else {
            // 不保留模式：返回空输出，减少内存占用
            void resolve({ stdout: '', stderr: '', code: result.exitCode ?? 1 })
          }
        } else {
          // 执行成功：返回完整输出和退出码 0
          void resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            code: 0,
          })
        }
      })
      .catch((error: ExecaError) => {
        // 极少数情况下 execa 本身抛出（如内部错误），记录日志后返回空结果
        logError(error)
        void resolve({ stdout: '', stderr: '', code: 1 })
      })
  })
}
