/**
 * 【文件定位】自动更新安装器公开 API 桶文件 — Claude Code 自更新系统的对外接口层
 *
 * 在 Claude Code 的系统架构中，本文件处于\"对外接口\"环节：
 *   外部模块（启动流程、命令行入口等）
 *     → [本文件：精选导出，隐藏内部实现细节]
 *     → installer.ts（核心安装逻辑）
 *
 * 主要职责：
 *   1. 作为 nativeInstaller 模块唯一的公开入口，防止外部模块直接耦合 installer.ts 内部实现
 *   2. 精选导出真正被外部使用的函数，过滤掉仅供内部测试或工具函数的符号
 *   3. 通过统一入口简化模块依赖关系，便于未来重构时只修改此文件
 *
 * 导出的符号：
 *   - checkInstall       检查并在需要时触发安装流程
 *   - cleanupNpmInstallations 清理遗留的 npm 安装目录
 *   - cleanupOldVersions 清理超出保留数量（2个）的旧版本目录
 *   - cleanupShellAliases 清理 shell 配置文件中的旧 alias 条目
 *   - installLatest      下载并安装最新版本的完整流程
 *   - lockCurrentVersion 将当前正在运行的版本锁定（防止被清理）
 *   - removeInstalledSymlink 移除版本软链接（用于卸载）
 *   - SetupMessage       安装过程进度/状态消息的 TypeScript 类型
 */

// 仅重新导出外部模块实际使用的函数和类型
// 外部模块应只从本文件导入，而非直接引用 installer.ts
export {
  checkInstall,
  cleanupNpmInstallations,
  cleanupOldVersions,
  cleanupShellAliases,
  installLatest,
  lockCurrentVersion,
  removeInstalledSymlink,
  type SetupMessage,
} from './installer.js'
