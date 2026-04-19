/**
 * plugin/parseArgs.ts —— 插件子命令参数解析器
 *
 * 在整体流程中的位置：
 *   用户输入 `/plugin <subcommand> [args]` → plugin 命令的 JSX 组件
 *   调用 parsePluginArgs(args) → 获得结构化的 ParsedCommand 对象
 *   → 根据 type 字段分发到不同的 UI 面板或执行相应操作
 *
 * 主要功能：
 *   将原始字符串参数解析为带有判别字段（discriminated union）的命令对象，
 *   覆盖 install / uninstall / enable / disable / validate / marketplace / manage
 *   等全部子命令。无参数时默认返回菜单（menu）类型。
 */

// ParsedCommand：判别联合类型，每个 type 值对应一种子命令场景
export type ParsedCommand =
  | { type: 'menu' }                                                          // 无参数，显示交互式菜单
  | { type: 'help' }                                                          // 显示帮助信息
  | { type: 'install'; marketplace?: string; plugin?: string }                // 安装插件（可指定市场和插件名）
  | { type: 'manage' }                                                        // 进入插件管理界面
  | { type: 'uninstall'; plugin?: string }                                    // 卸载指定插件
  | { type: 'enable'; plugin?: string }                                       // 启用指定插件
  | { type: 'disable'; plugin?: string }                                      // 禁用指定插件
  | { type: 'validate'; path?: string }                                       // 校验指定路径的插件
  | {
      type: 'marketplace'
      action?: 'add' | 'remove' | 'update' | 'list'                          // 市场管理子操作
      target?: string
    }

/**
 * parsePluginArgs —— 将用户输入的原始参数字符串解析为结构化命令对象
 *
 * 流程：
 *   1. 无参数 → 返回 { type: 'menu' } 展示交互菜单
 *   2. 按空白分割参数，取首词作为子命令关键字
 *   3. switch-case 匹配关键字，针对 install 子命令额外处理
 *      `plugin@marketplace` 格式及 URL/路径的市场地址识别
 *   4. marketplace 子命令继续解析第二个词作为操作（add/remove/update/list）
 *   5. 未识别的关键字回退到 menu
 *
 * @param args 用户在 /plugin 后输入的原始参数字符串（可为空）
 * @returns     ParsedCommand 结构化命令对象
 */
export function parsePluginArgs(args?: string): ParsedCommand {
  // 无参数时直接展示菜单界面
  if (!args) {
    return { type: 'menu' }
  }

  // 按空白字符切割，提取子命令关键字（统一转为小写）
  const parts = args.trim().split(/\s+/)
  const command = parts[0]?.toLowerCase()

  switch (command) {
    // 帮助命令：支持三种常见写法
    case 'help':
    case '--help':
    case '-h':
      return { type: 'help' }

    // 安装命令：支持 install 和缩写 i
    case 'install':
    case 'i': {
      const target = parts[1] // 安装目标（插件名或市场地址）
      if (!target) {
        // 未指定目标，进入安装向导
        return { type: 'install' }
      }

      // Check if it's in format plugin@marketplace
      if (target.includes('@')) {
        // plugin@marketplace 格式：@ 前为插件名，@ 后为市场标识
        const [plugin, marketplace] = target.split('@')
        return { type: 'install', plugin, marketplace }
      }

      // Check if the target looks like a marketplace (URL or path)
      // 判断目标是否为市场地址（URL 或本地路径）
      const isMarketplace =
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('file://') ||
        target.includes('/') ||      // Unix 路径分隔符
        target.includes('\\')        // Windows 路径分隔符

      if (isMarketplace) {
        // This is a marketplace URL/path, no plugin specified
        // 目标是市场地址，尚未指定具体插件
        return { type: 'install', marketplace: target }
      }

      // Otherwise treat it as a plugin name
      // 纯字符串，视为插件名直接安装
      return { type: 'install', plugin: target }
    }

    case 'manage':
      return { type: 'manage' } // 进入插件管理界面

    case 'uninstall':
      // parts[1] 为可选的插件名，未提供时进入交互式选择
      return { type: 'uninstall', plugin: parts[1] }

    case 'enable':
      return { type: 'enable', plugin: parts[1] }

    case 'disable':
      return { type: 'disable', plugin: parts[1] }

    case 'validate': {
      // 将第一个词之后的所有内容拼回为路径（路径可能含空格）
      const target = parts.slice(1).join(' ').trim()
      return { type: 'validate', path: target || undefined }
    }

    // 市场管理命令：marketplace 和缩写 market 均可触发
    case 'marketplace':
    case 'market': {
      const action = parts[1]?.toLowerCase() // 第二个词为市场操作类型
      const target = parts.slice(2).join(' ') // 操作目标（如市场 URL）

      switch (action) {
        case 'add':
          return { type: 'marketplace', action: 'add', target }
        case 'remove':
        case 'rm': // rm 为 remove 的缩写
          return { type: 'marketplace', action: 'remove', target }
        case 'update':
          return { type: 'marketplace', action: 'update', target }
        case 'list':
          return { type: 'marketplace', action: 'list' }
        default:
          // No action specified, show marketplace menu
          // 未指定操作，显示市场管理菜单
          return { type: 'marketplace' }
      }
    }

    default:
      // Unknown command, show menu
      // 无法识别的子命令，回退到菜单，避免硬错误
      return { type: 'menu' }
  }
}
