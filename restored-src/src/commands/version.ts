/**
 * version（/version）命令：输出当前运行会话的版本信息
 *
 * 本文件在 Claude Code 命令系统中承担"版本诊断"职责，
 * 仅面向 Anthropic 内部员工（USER_TYPE=ant）开放。
 *
 * 背景：Claude Code 支持自动更新（autoupdate）机制，即后台下载新版本后，
 * 下次启动时才真正切换。因此存在"当前运行版本"与"已下载最新版本"不一致的情况。
 * 本命令输出的是**当前会话实际运行的版本**（而非 autoupdate 下载到的版本），
 * 便于内部人员在调试时确认会话的真实构建来源。
 *
 * MACRO.VERSION 和 MACRO.BUILD_TIME 是构建时由打包工具注入的宏替换值，
 * 运行时为静态字符串，不依赖任何配置文件或网络请求。
 */
import type { Command, LocalCommandCall } from '../types/command.js'

/**
 * 版本命令的执行函数，同步读取构建时注入的版本宏并格式化返回。
 *
 * 若构建时记录了 BUILD_TIME，则附加在版本号后（如 `1.2.3 (built 2025-01-01T00:00:00Z)`），
 * 便于区分不同构建批次的同一版本号；否则仅返回版本号字符串。
 */
const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    // BUILD_TIME 存在时附加构建时间，便于区分同版本的不同构建批次
    value: MACRO.BUILD_TIME
      ? `${MACRO.VERSION} (built ${MACRO.BUILD_TIME})`
      : MACRO.VERSION,
  }
}

const version = {
  // 纯本地命令，不需要与 Claude API 通信
  type: 'local',
  // 命令名称
  name: 'version',
  // 说明此命令输出的是当前运行版本，而非 autoupdate 下载到的最新版本
  description:
    'Print the version this session is running (not what autoupdate downloaded)',
  // 仅对 Anthropic 内部员工开放（USER_TYPE=ant），外部用户不可见
  isEnabled: () => process.env.USER_TYPE === 'ant',
  // 支持非交互模式：可在管道或脚本中调用，适合自动化诊断场景
  supportsNonInteractive: true,
  // 直接以 Promise.resolve 包装已定义的 call，无需懒加载
  load: () => Promise.resolve({ call }),
} satisfies Command

export default version
