/**
 * 安全存储降级回退模块 (fallbackStorage.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   认证层 → 【本模块：主存储 + 辅助存储 双层降级】→ 凭证读写
 *
 * 主要职责：
 *   1. 优先使用主存储（macOS：keychain），失败时自动降级至辅助存储（明文文件）
 *   2. 首次从辅助存储迁移到主存储时，删除辅助存储旧记录（防止 .claude 跨容器共享时凭证冗余）
 *   3. 主存储写入失败但辅助存储写入成功时，删除主存储中可能存在的旧数据（防止"幽灵影子"覆盖）
 *   4. delete() 同时清理两个存储，确保彻底登出
 *
 * 与其他模块的关系：
 *   - 由 secureStorage/index.ts 在 macOS 上通过 createFallbackStorage(keychain, plaintext) 构建
 *   - SecureStorage 接口的上层适配器，对调用方透明
 */

import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * 创建一个"主→辅"双层降级存储适配器。
 *
 * 读取策略：
 *   - 主存储返回非 null/undefined 值时直接返回
 *   - 否则从辅助存储读取，空值时返回空对象 {}（确保调用方不必处理 null）
 *
 * 写入策略：
 *   - 优先写入主存储
 *   - 若主存储首次成功写入（之前数据为 null），则删除辅助存储（完成迁移）
 *   - 若主存储写入失败，则写入辅助存储；若辅助成功且主存储曾有旧数据，删除主存储旧数据
 *     （防止旧主存储数据在 read() 时"影子覆盖"辅助存储的新数据）
 *
 * 删除策略：
 *   - 同时删除主、辅两个存储，任一成功即返回 true
 *
 * @param primary   主存储实现（macOS 上为 keychain）
 * @param secondary 辅助存储实现（plaintext 文件）
 * @returns 实现了 SecureStorage 接口的降级适配器
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    // 存储名称：便于日志和调试时识别当前使用的存储链
    name: `${primary.name}-with-${secondary.name}-fallback`,

    /**
     * 同步读取：主存储优先，降级辅助存储。
     */
    read(): SecureStorageData {
      const result = primary.read()
      // 主存储有数据：直接返回
      if (result !== null && result !== undefined) {
        return result
      }
      // 主存储为空：从辅助存储读取，空值返回空对象
      return secondary.read() || {}
    },

    /**
     * 异步读取：与同步版本逻辑相同，但使用 async 接口。
     */
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      return (await secondary.readAsync()) || {}
    },

    /**
     * 写入凭证数据，处理主→辅降级及迁移逻辑。
     *
     * 流程：
     *   1. 记录写入前主存储的状态（primaryDataBefore）
     *   2. 尝试写入主存储
     *   3. 主存储成功 + 之前为空 → 删除辅助存储（首次迁移，防止旧 plaintext 残留）
     *   4. 主存储失败 → 尝试辅助存储
     *   5. 辅助成功 + 主存储曾有旧数据 → 删除主存储旧数据
     *      （旧主存储数据会在 read() 时优先返回，遮蔽辅助存储的新数据，导致 /login 循环）
     *   6. 两者均失败 → 返回 { success: false }
     */
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // 记录更新前的主存储状态（用于判断是否需要迁移 / 删除旧数据）
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        // 主存储首次成功写入（之前为空）：删除辅助存储，完成迁移
        // 背景：.claude 目录可能在宿主机和容器间共享，删除避免凭证冗余
        // 参考：https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      // 主存储写入失败：降级至辅助存储
      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        // 辅助存储写入成功，但主存储可能仍保有旧条目。
        // read() 优先读主存储，旧数据会遮蔽新写入的辅助数据（stale shadow 问题），
        // 导致 refresh token 轮转后 /login 循环（参考 #30337）。
        // 尽力删除主存储旧数据；若删除也失败，则用户 keychain 状态已损坏，无法在此修复。
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      // 主、辅均失败：返回失败
      return { success: false }
    },

    /**
     * 删除凭证：同时清理主、辅两个存储，任一成功即返回 true。
     */
    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      // 任一删除成功即视为成功（彻底登出）
      return primarySuccess || secondarySuccess
    },
  }
}
