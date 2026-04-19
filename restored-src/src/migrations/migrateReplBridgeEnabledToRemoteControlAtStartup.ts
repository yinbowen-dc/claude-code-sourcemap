/**
 * @file migrateReplBridgeEnabledToRemoteControlAtStartup.ts
 * @description 数据迁移模块 — replBridgeEnabled 配置键重命名迁移
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将全局配置文件（~/.claude.json）中旧的内部实现细节字段 replBridgeEnabled
 * 重命名为更具语义描述性的用户面向字段 remoteControlAtStartup，
 * 并删除旧字段，保持配置文件整洁。
 *
 * 幂等性保证：仅在旧字段存在且新字段不存在时执行迁移。
 * 调用时机：Claude Code 每次启动时执行，具有幂等性。
 */

import { saveGlobalConfig } from '../utils/config.js'

/**
 * 将全局配置中的 replBridgeEnabled 字段迁移至 remoteControlAtStartup。
 *
 * 迁移流程（全部在 saveGlobalConfig 的原子更新回调中完成）：
 * 1. 通过非类型化转型访问旧字段（旧字段已从 GlobalConfig 类型定义中移除）
 * 2. 若旧字段不存在，直接返回原配置（无需迁移）
 * 3. 若新字段已存在，直接返回原配置（避免覆盖已有值，保证幂等）
 * 4. 将旧字段值（转换为 boolean）赋给新字段，并删除旧字段
 */
export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfig(prev => {
    // 旧字段已从 GlobalConfig 类型中移除，通过非类型化转型读取
    // 仅在旧字段存在且新字段尚未设置时才执行迁移
    const oldValue = (prev as Record<string, unknown>)['replBridgeEnabled']
    if (oldValue === undefined) return prev       // 旧字段不存在，无需迁移
    if (prev.remoteControlAtStartup !== undefined) return prev  // 新字段已存在，跳过
    // 构建新配置：添加新字段，删除旧字段
    const next = { ...prev, remoteControlAtStartup: Boolean(oldValue) }
    delete (next as Record<string, unknown>)['replBridgeEnabled']
    return next
  })
}
