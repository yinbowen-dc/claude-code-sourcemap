/**
 * 外部编辑器调用模块（editor.ts）
 *
 * 【在系统流程中的位置】
 * 该模块属于 UI 交互层，被 REPL 命令处理器（如 /edit）和工具调用层调用。
 * 负责检测可用的外部编辑器、对 GUI 编辑器和终端编辑器分别进行跳转行号处理，
 * 并处理跨平台（Windows/POSIX）的进程启动差异。
 *
 * 【主要功能】
 * - classifyGuiEditor()：识别编辑器是否为 GUI 类型并返回家族名称
 * - openFileInExternalEditor()：打开文件到外部编辑器，支持跳转到指定行号
 * - getExternalEditor()：（记忆化）检测并返回可用的外部编辑器命令
 *
 * 【编辑器分类】
 * - GUI 编辑器（code/cursor/windsurf 等）：detached spawn，不阻塞 Claude Code
 * - 终端编辑器（vim/nvim/nano 等）：通过 Ink 的 alt-screen 机制阻塞等待退出
 */
import {
  type SpawnOptions,
  type SpawnSyncOptions,
  spawn,
  spawnSync,
} from 'child_process'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import instances from '../ink/instances.js'
import { logForDebugging } from './debug.js'
import { whichSync } from './which.js'

/**
 * 检测命令是否在 PATH 中可用。
 */
function isCommandAvailable(command: string): boolean {
  return !!whichSync(command)
}

// GUI 编辑器列表：在独立窗口中打开，可以 detached 方式启动，不与 TUI 争夺 stdin
// VS Code 家族（cursor、windsurf、codium）显式列出，因为它们的名称不含 'code' 子串
const GUI_EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'subl',
  'atom',
  'gedit',
  'notepad++',
  'notepad',
]

// 支持 +N 跳转行号参数的终端编辑器正则（Windows 默认的 notepad 不支持，+42 会被当作文件名）
const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/

// VS Code 家族使用 -g file:line；subl 使用裸 file:line（无 -g 标志）
const VSCODE_FAMILY = new Set(['code', 'cursor', 'windsurf', 'codium'])

/**
 * 识别编辑器是否为 GUI 类型，返回匹配的 GUI 家族名称。
 *
 * 【流程说明】
 * 1. 取编辑器命令的第一个 token 的 basename（忽略绝对路径目录部分）
 * 2. 在 GUI_EDITORS 列表中查找 basename 是否包含某个 GUI 名称
 * 3. 返回匹配的 GUI 家族名称（用于后续选择跳转行号 argv），未匹配返回 undefined
 *
 * 注意：只做分类，实际 spawn 时使用用户配置的原始命令（保留 code-insiders、绝对路径等）。
 * 使用 basename 确保 /home/alice/code/bin/nvim 不会因目录路径含 'code' 而误匹配。
 *
 * @param editor  编辑器命令字符串（可能含空格分隔的参数）
 * @returns       GUI 家族名称（如 'code'、'subl'），非 GUI 编辑器返回 undefined
 */
export function classifyGuiEditor(editor: string): string | undefined {
  // 取第一个 token 的 basename，避免路径中的目录名干扰匹配
  const base = basename(editor.split(' ')[0] ?? '')
  return GUI_EDITORS.find(g => base.includes(g))
}

/**
 * 为 GUI 编辑器构建跳转行号的 argv 参数。
 *
 * 【参数格式】
 * - VS Code 家族（code/cursor/windsurf/codium）：使用 -g file:line
 * - subl（Sublime Text）：使用裸 file:line（无 -g）
 * - 其他 GUI 编辑器：不支持跳转行号，只传文件路径
 *
 * @param guiFamily  classifyGuiEditor() 返回的 GUI 家族名称
 * @param filePath   要打开的文件路径
 * @param line       可选的跳转行号
 */
function guiGotoArgv(
  guiFamily: string,
  filePath: string,
  line: number | undefined,
): string[] {
  // 未提供行号时只传文件路径
  if (!line) return [filePath]
  // VS Code 家族使用 -g file:line 语法
  if (VSCODE_FAMILY.has(guiFamily)) return ['-g', `${filePath}:${line}`]
  // Sublime Text 使用裸 file:line 语法
  if (guiFamily === 'subl') return [`${filePath}:${line}`]
  // 其他 GUI 编辑器不支持跳转行号
  return [filePath]
}

/**
 * 在用户配置的外部编辑器中打开文件，可选跳转到指定行号。
 *
 * 【流程说明】
 * GUI 编辑器路径：
 * 1. 解析编辑器命令为二进制名 + 额外参数
 * 2. 调用 classifyGuiEditor() 确认为 GUI 并获取家族名
 * 3. 调用 guiGotoArgv() 构建跳转参数
 * 4. Windows：shell:true 方式 spawn（解析 .cmd/.bat 文件），手动拼接引号避免路径空格问题
 * 5. POSIX：无 shell 直接 spawn（argv 数组，防注入），detached 方式分离子进程
 * 6. child.unref() 让编辑器进程在后台运行，不阻塞 Claude Code 退出
 *
 * 终端编辑器路径：
 * 1. 通过 instances.get(process.stdout) 获取 Ink 实例
 * 2. 调用 inkInstance.enterAlternateScreen() 切换到 alt-screen 模式（Ink 让位给编辑器）
 * 3. spawnSync 阻塞等待编辑器进程退出
 * 4. Windows 和 POSIX 分别处理 shell 模式和 argv 数组模式
 * 5. finally 中调用 exitAlternateScreen() 恢复 Ink UI
 *
 * @param filePath  要在编辑器中打开的文件路径
 * @param line      可选的跳转行号
 * @returns         编辑器成功启动返回 true，无可用编辑器返回 false
 */
export function openFileInExternalEditor(
  filePath: string,
  line?: number,
): boolean {
  // 获取可用的外部编辑器（记忆化，只检测一次）
  const editor = getExternalEditor()
  if (!editor) return false

  // 将编辑器命令分解为二进制名 + 额外参数（处理 'start /wait notepad' 这类多词命令）
  const parts = editor.split(' ')
  const base = parts[0] ?? editor
  const editorArgs = parts.slice(1)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily) {
    // GUI 编辑器：以 detached 方式启动，不与 TUI 争夺 stdin
    const gotoArgv = guiGotoArgv(guiFamily, filePath, line)
    const detachedOpts: SpawnOptions = { detached: true, stdio: 'ignore' }
    let child
    if (process.platform === 'win32') {
      // Windows：shell:true 以解析 .cmd/.bat 文件（CreateProcess 不能直接执行批处理文件）
      // 手动对每个参数加双引号，防止路径中的空格破坏命令行解析
      const gotoStr = gotoArgv.map(a => `"${a}"`).join(' ')
      child = spawn(`${editor} ${gotoStr}`, { ...detachedOpts, shell: true })
    } else {
      // POSIX：直接 spawn（无 shell），使用 argv 数组防止路径中的特殊字符注入
      // shell:true 会展开 $() 和反引号，文件系统路径可能导致 RCE 漏洞
      child = spawn(base, [...editorArgs, ...gotoArgv], detachedOpts)
    }
    // spawn() 异步发送 ENOENT 错误；$VISUAL/$EDITOR 不存在是用户配置问题，不计入错误遥测
    child.on('error', e =>
      logForDebugging(`editor spawn failed: ${e}`, { level: 'error' }),
    )
    // unref() 使编辑器进程独立运行，不阻止 Claude Code 进程退出
    child.unref()
    return true
  }

  // 终端编辑器：需要 alt-screen 切换，阻塞等待编辑器退出
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) return false
  // 只对已知支持 +N 的编辑器添加跳转行号参数（notepad 等不支持，+42 会被视为文件名）
  // 使用 basename 防止路径目录部分干扰正则匹配
  const useGotoLine = line && PLUS_N_EDITORS.test(basename(base))
  // 进入 alt-screen 模式，Ink UI 暂停，终端编辑器接管
  inkInstance.enterAlternateScreen()
  try {
    const syncOpts: SpawnSyncOptions = { stdio: 'inherit' }
    let result
    if (process.platform === 'win32') {
      // Windows：shell:true 解析 cmd.exe 内置命令；手动拼接引号处理路径空格
      const lineArg = useGotoLine ? `+${line} ` : ''
      result = spawnSync(`${editor} ${lineArg}"${filePath}"`, {
        ...syncOpts,
        shell: true,
      })
    } else {
      // POSIX：无 shell，直接 argv 数组（引号安全）
      const args = [
        ...editorArgs,
        ...(useGotoLine ? [`+${line}`, filePath] : [filePath]),
      ]
      result = spawnSync(base, args, syncOpts)
    }
    if (result.error) {
      logForDebugging(`editor spawn failed: ${result.error}`, {
        level: 'error',
      })
      return false
    }
    return true
  } finally {
    // 无论编辑器是否成功，都需要退出 alt-screen，恢复 Ink UI
    inkInstance.exitAlternateScreen()
  }
}

/**
 * 检测并返回可用的外部编辑器命令字符串（记忆化，只检测一次）。
 *
 * 【流程说明】
 * 1. 优先使用 $VISUAL 环境变量（传统 Unix 约定：GUI 编辑器）
 * 2. 次优先使用 $EDITOR 环境变量（传统 Unix 约定：终端编辑器）
 * 3. Windows：直接返回 'start /wait notepad'，跳过命令可用性检测
 *    （isCommandAvailable 在 Windows 上会破坏进程的 stdin）
 * 4. 在默认列表 [code, vi, nano] 中按顺序查找第一个可用的编辑器
 *
 * 使用 lodash memoize 缓存结果，避免重复执行 which 命令。
 */
export const getExternalEditor = memoize((): string | undefined => {
  // 优先使用 $VISUAL（通常指向 GUI 编辑器）
  if (process.env.VISUAL?.trim()) {
    return process.env.VISUAL.trim()
  }

  // 次优先使用 $EDITOR（通常指向终端编辑器）
  if (process.env.EDITOR?.trim()) {
    return process.env.EDITOR.trim()
  }

  // Windows：isCommandAvailable 会破坏 stdin，跳过检测，直接使用 notepad
  if (process.platform === 'win32') {
    return 'start /wait notepad'
  }

  // 在默认编辑器列表中查找第一个 PATH 可用的编辑器
  const editors = ['code', 'vi', 'nano']
  return editors.find(command => isCommandAvailable(command))
})
