/**
 * GitHub CLI 认证状态检测模块（gh Auth Status）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于 GitHub 集成工具层，被遥测上报、PR 状态等需要感知 gh CLI
 * 可用性的模块调用，用于快速判断用户是否安装并登录了 gh CLI。
 *
 * 【主要功能】
 * - GhAuthStatus 类型：三态枚举（已认证 / 未认证 / 未安装）
 * - getGhAuthStatus()：先通过 which() 检测 gh 是否安装，再通过
 *   `gh auth token` 的退出码判断是否已登录；
 *   刻意使用 `auth token` 而非 `auth status`，后者会发起网络请求；
 *   以 stdout: 'ignore' 运行，确保令牌不会进入当前进程。
 */

import { execa } from 'execa'
import { which } from '../which.js'

/**
 * gh CLI 的安装与认证状态枚举类型。
 * - 'authenticated'：gh 已安装且已登录
 * - 'not_authenticated'：gh 已安装但未登录（或令牌失效）
 * - 'not_installed'：gh 未安装或不在 PATH 中
 */
export type GhAuthStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'not_installed'

/**
 * 检测 gh CLI 的安装与认证状态，用于遥测上报。
 *
 * 【流程】
 * 1. 通过 which('gh') 检测 gh 是否在 PATH 中（Bun.which，无子进程开销）；
 * 2. 若未找到，返回 'not_installed'；
 * 3. 执行 `gh auth token`（stdout: 'ignore'，令牌不进入进程），
 *    退出码 0 表示已认证，非 0 表示未认证；
 * 4. 返回对应状态字符串。
 *
 * 【注意】
 * 使用 `gh auth token` 而非 `gh auth status`，因为后者会向 GitHub API 发起
 * 网络请求，而前者仅读取本地配置/密钥环，速度更快且不依赖网络。
 *
 * @returns gh CLI 的认证状态
 */
export async function getGhAuthStatus(): Promise<GhAuthStatus> {
  const ghPath = await which('gh') // 检测 gh 是否安装（无子进程）
  if (!ghPath) {
    return 'not_installed' // gh 不在 PATH 中，未安装
  }
  const { exitCode } = await execa('gh', ['auth', 'token'], {
    stdout: 'ignore',  // 丢弃令牌输出，防止敏感信息进入进程
    stderr: 'ignore',  // 丢弃错误信息
    timeout: 5000,     // 5 秒超时，避免阻塞
    reject: false,     // 不抛出异常，通过 exitCode 判断结果
  })
  return exitCode === 0 ? 'authenticated' : 'not_authenticated'
}
