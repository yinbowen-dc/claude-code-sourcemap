/**
 * Anthropic 官方插件市场常量定义模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于最底层的"配置常量"层：
 *   - officialMarketplaceStartupCheck.ts 在启动时读取这里的常量，
 *     决定向 GitHub / GCS 自动安装哪个市场仓库；
 *   - marketplaceManager.ts 用 OFFICIAL_MARKETPLACE_NAME 识别官方市场，
 *     以便在策略执行、UI 显示等场合特殊处理。
 *
 * 主要导出：
 *   - OFFICIAL_MARKETPLACE_SOURCE：描述如何克隆官方市场（GitHub 来源 + 仓库路径）
 *   - OFFICIAL_MARKETPLACE_NAME：注册到 known_marketplaces.json 时使用的唯一名称
 */

import type { MarketplaceSource } from './schemas.js'

/**
 * 官方 Anthropic 插件市场的来源配置。
 *
 * 使用 'github' 来源类型，指向 Anthropic 在 GitHub 上的官方仓库。
 * officialMarketplaceStartupCheck.ts 在启动时调用 addMarketplaceSource()
 * 时会将此对象作为参数传入，从而触发 git clone 或 GCS 镜像下载。
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  // 来源类型：github（由 marketplaceManager 识别并调用 GitHub API 路径）
  source: 'github',
  // Anthropic 官方插件仓库的 owner/repo 形式路径
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

/**
 * 官方市场在 known_marketplaces.json 中注册时使用的唯一显示名称。
 *
 * 该名称同时作为：
 *   - 插件 ID 后缀（如 "my-plugin@claude-plugins-official"）
 *   - UI 中的市场标识符
 *   - GCS 镜像路径的一部分
 */
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
