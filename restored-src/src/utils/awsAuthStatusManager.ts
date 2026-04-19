/**
 * 云提供商认证状态单例管理器（AWS Bedrock / GCP Vertex）。
 *
 * 在 Claude Code 系统中，该模块在认证工具函数与 React 组件 / SDK 输出之间
 * 传递认证刷新状态。SDK 的 'auth_status' 消息格式与提供商无关，
 * 因此单一管理器即可服务所有云认证刷新流程。
 *
 * 注：历史命名为 AWS 专用，现已泛化为所有云认证刷新流程使用。
 *
 * Singleton manager for cloud-provider authentication status (AWS Bedrock,
 * GCP Vertex). Communicates auth refresh state between auth utilities and
 * React components / SDK output. The SDK 'auth_status' message shape is
 * provider-agnostic, so a single manager serves all providers.
 *
 * Legacy name: originally AWS-only; now used by all cloud auth refresh flows.
 */

import { createSignal } from './signal.js'

export type AwsAuthStatus = {
  isAuthenticating: boolean
  output: string[]
  error?: string
}

export class AwsAuthStatusManager {
  private static instance: AwsAuthStatusManager | null = null
  private status: AwsAuthStatus = {
    isAuthenticating: false,
    output: [],
  }
  private changed = createSignal<[status: AwsAuthStatus]>()

  /** 获取单例实例（懒初始化）。 */
  static getInstance(): AwsAuthStatusManager {
    if (!AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance = new AwsAuthStatusManager()
    }
    return AwsAuthStatusManager.instance
  }

  /** 返回当前认证状态快照（深拷贝 output 数组）。 */
  getStatus(): AwsAuthStatus {
    return {
      ...this.status,
      output: [...this.status.output],
    }
  }

  /** 开始认证流程：重置状态并发出变更信号。 */
  startAuthentication(): void {
    this.status = {
      isAuthenticating: true,
      output: [],
    }
    this.changed.emit(this.getStatus())
  }

  /** 追加一行认证输出并发出变更信号。 */
  addOutput(line: string): void {
    this.status.output.push(line)
    this.changed.emit(this.getStatus())
  }

  /** 设置认证错误信息并发出变更信号。 */
  setError(error: string): void {
    this.status.error = error
    this.changed.emit(this.getStatus())
  }

  /** 结束认证流程：成功时清空状态，失败时保留输出供展示。 */
  endAuthentication(success: boolean): void {
    if (success) {
      // Clear the status completely on success
      this.status = {
        isAuthenticating: false,
        output: [],
      }
    } else {
      // Keep the output visible on failure
      this.status.isAuthenticating = false
    }
    this.changed.emit(this.getStatus())
  }

  subscribe = this.changed.subscribe

  // Clean up for testing
  /** 重置单例（测试专用）。 */
  static reset(): void {
    if (AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance.changed.clear()
      AwsAuthStatusManager.instance = null
    }
  }
}
