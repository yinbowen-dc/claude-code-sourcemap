/**
 * telemetry/logger.ts — OpenTelemetry 诊断日志适配器
 *
 * 在 Claude Code 的可观测性体系中，OpenTelemetry SDK 内部会产生诊断日志
 * （如配置错误、导出失败等）。本文件提供一个自定义的 DiagLogger 实现，
 * 将 OTel 的诊断日志桥接到 Claude Code 自身的日志系统。
 *
 * 设计决策：
 *   - error / warn 级别 → 写入 logError 并通过 logForDebugging 记录
 *   - info / debug / verbose 级别 → 直接丢弃（no-op），避免日志噪音
 *
 * 使用方式：在 instrumentation.ts 中通过 diag.setLogger(new ClaudeCodeDiagLogger())
 * 注册为全局 OTel 诊断日志器。
 */

import type { DiagLogger } from '@opentelemetry/api'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'

/**
 * Claude Code 自定义 OTel 诊断日志器。
 *
 * 实现 OpenTelemetry 的 DiagLogger 接口，将 OTel SDK 内部的
 * 错误和警告消息路由到 Claude Code 的日志基础设施。
 * info/debug/verbose 级别的消息被静默处理以减少噪音。
 */
export class ClaudeCodeDiagLogger implements DiagLogger {
  /**
   * 处理 OTel 错误级别诊断消息。
   * 将消息包装为 Error 对象写入错误日志，并同时写入调试日志。
   */
  error(message: string, ..._: unknown[]) {
    // 将字符串错误消息包装为 Error 对象，便于统一处理
    logError(new Error(message))
    // 同时写入调试日志，带 [3P telemetry] 前缀用于过滤
    logForDebugging(`[3P telemetry] OTEL diag error: ${message}`, {
      level: 'error',
    })
  }

  /**
   * 处理 OTel 警告级别诊断消息。
   * 与 error 处理方式相同，确保警告不会被静默忽略。
   */
  warn(message: string, ..._: unknown[]) {
    // 警告也包装为 Error，确保调用栈可被追踪
    logError(new Error(message))
    logForDebugging(`[3P telemetry] OTEL diag warn: ${message}`, {
      level: 'warn',
    })
  }

  /**
   * info 级别消息 — 静默处理（no-op）。
   * OTel SDK 会产生大量 info 日志，此处丢弃以避免日志过载。
   */
  info(_message: string, ..._args: unknown[]) {
    return
  }

  /**
   * debug 级别消息 — 静默处理（no-op）。
   */
  debug(_message: string, ..._args: unknown[]) {
    return
  }

  /**
   * verbose 级别消息 — 静默处理（no-op）。
   */
  verbose(_message: string, ..._args: unknown[]) {
    return
  }
}
