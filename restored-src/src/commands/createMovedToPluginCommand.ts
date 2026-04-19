/**
 * 工厂函数：将已迁移至插件的内置命令包装为兼容的 Command 对象。
 *
 * 背景：Claude Code 正在将部分内置斜杠命令迁移到插件市场（marketplace）。
 * 在插件市场仍处于私有阶段时，这些命令不能直接消失，需要保留一个过渡期入口，
 * 引导用户安装对应插件，同时对外部用户提供临时的回退实现。
 *
 * 本文件在命令体系中扮演"迁移适配层"的角色：
 *  - 对 Anthropic 内部用户（ant）：直接告知安装插件的具体步骤；
 *  - 对外部用户（市场私有期）：调用 getPromptWhileMarketplaceIsPrivate
 *    提供临时实现，待市场公开后可直接移除该回退路径。
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'

/** createMovedToPluginCommand 的配置选项 */
type Options = {
  /** 命令名称，与插件迁移前保持一致 */
  name: string
  /** 命令描述文本，显示在 /help 列表中 */
  description: string
  /** 命令执行期间显示给用户的进度提示文字 */
  progressMessage: string
  /** 目标插件的包名（在 claude-code-marketplace 上） */
  pluginName: string
  /** 插件中对应的子命令名称 */
  pluginCommand: string
  /**
   * The prompt to use while the marketplace is private.
   * External users will get this prompt. Once the marketplace is public,
   * this parameter and the fallback logic can be removed.
   */
  getPromptWhileMarketplaceIsPrivate: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

/**
 * 创建一个"已迁移到插件"的过渡命令对象。
 *
 * 流程：
 *  1. 使用传入的配置参数构造一个 type: 'prompt' 类型的 Command；
 *  2. 当命令被调用时（getPromptForCommand）：
 *     - 若为 Anthropic 内部用户（ant）：返回包含插件安装步骤的提示文本，
 *       告知用户通过 `claude plugin install` 安装插件后使用新命令；
 *     - 否则：调用 getPromptWhileMarketplaceIsPrivate 返回临时回退实现；
 *  3. contentLength 设为 0 表示内容长度为动态值，由实际 prompt 决定。
 */
export function createMovedToPluginCommand({
  name,
  description,
  progressMessage,
  pluginName,
  pluginCommand,
  getPromptWhileMarketplaceIsPrivate,
}: Options): Command {
  return {
    type: 'prompt',
    name,
    description,
    progressMessage,
    contentLength: 0, // Dynamic content
    userFacingName() {
      return name
    },
    source: 'builtin',
    async getPromptForCommand(
      args: string,
      context: ToolUseContext,
    ): Promise<ContentBlockParam[]> {
      // Anthropic 内部用户看到明确的插件安装指引，不执行旧逻辑
      if (process.env.USER_TYPE === 'ant') {
        return [
          {
            type: 'text',
            text: `This command has been moved to a plugin. Tell the user:

1. To install the plugin, run:
   claude plugin install ${pluginName}@claude-code-marketplace

2. After installation, use /${pluginName}:${pluginCommand} to run this command

3. For more information, see: https://github.com/anthropics/claude-code-marketplace/blob/main/${pluginName}/README.md

Do not attempt to run the command. Simply inform the user about the plugin installation.`,
          },
        ]
      }

      // 外部用户在插件市场私有期间使用回退实现
      return getPromptWhileMarketplaceIsPrivate(args, context)
    },
  }
}
