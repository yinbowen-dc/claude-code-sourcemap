/**
 * pr_comments 命令入口 —— 已迁移至插件的命令存根
 *
 * 在整体流程中的位置：
 *   用户输入 `/pr-comments` → commands 注册表路由到本模块
 *   → createMovedToPluginCommand 包装器检测 pr-comments 插件是否已安装
 *     · 已安装：将请求转发给插件命令执行
 *     · 未安装且市场私有期：使用内嵌的 getPromptWhileMarketplaceIsPrivate
 *       构造提示词，直接驱动 AI 通过 gh CLI 获取 PR 评论并格式化输出
 *
 * 主要功能：
 *   在插件市场公开前提供 PR 评论查看能力的过渡性实现。内嵌提示词指导
 *   AI 分步调用 gh API，聚合 PR 级评论与代码审查评论，并以结构化
 *   Markdown 格式呈现评论线程（含 diff_hunk 上下文）。
 */
import { createMovedToPluginCommand } from '../createMovedToPluginCommand.js'

export default createMovedToPluginCommand({
  name: 'pr-comments',                           // 命令名称
  description: 'Get comments from a GitHub pull request',
  progressMessage: 'fetching PR comments',       // 执行期间显示的进度提示
  pluginName: 'pr-comments',                     // 对应插件的注册名
  pluginCommand: 'pr-comments',                  // 插件内部的子命令名
  /**
   * getPromptWhileMarketplaceIsPrivate —— 市场私有期的降级提示词构建器
   *
   * 在插件市场尚未公开时，通过返回一段详细的 system prompt 来指导 Claude
   * 自行通过 gh CLI 获取并格式化 PR 评论，实现与插件等效的功能。
   *
   * 提示词流程：
   *   1. 用 `gh pr view --json` 获取 PR 编号和仓库信息
   *   2. 调用 issues API 获取 PR 级别评论
   *   3. 调用 pulls API 获取代码审查评论（含 diff_hunk、path、line 等字段）
   *      必要时通过 contents API + base64 解码获取完整文件内容
   *   4. 将所有评论格式化为 Markdown，包含作者、文件位置、diff 上下文及嵌套回复
   *   5. 仅返回格式化评论，不附加任何额外解释文字
   *
   * @param args 用户在命令后追加的可选参数（如 PR 编号或附加指令）
   */
  async getPromptWhileMarketplaceIsPrivate(args) {
    return [
      {
        type: 'text',
        text: `You are an AI assistant integrated into a git-based version control system. Your task is to fetch and display comments from a GitHub pull request.

Follow these steps:

1. Use \`gh pr view --json number,headRepository\` to get the PR number and repository info
2. Use \`gh api /repos/{owner}/{repo}/issues/{number}/comments\` to get PR-level comments
3. Use \`gh api /repos/{owner}/{repo}/pulls/{number}/comments\` to get review comments. Pay particular attention to the following fields: \`body\`, \`diff_hunk\`, \`path\`, \`line\`, etc. If the comment references some code, consider fetching it using eg \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\`
4. Parse and format all comments in a readable way
5. Return ONLY the formatted comments, with no additional text

Format the comments as:

## Comments

[For each comment thread:]
- @author file.ts#line:
  \`\`\`diff
  [diff_hunk from the API response]
  \`\`\`
  > quoted comment text

  [any replies indented]

If there are no comments, return "No comments found."

Remember:
1. Only show the actual comments, no explanatory text
2. Include both PR-level and code review comments
3. Preserve the threading/nesting of comment replies
4. Show the file and line number context for code review comments
5. Use jq to parse the JSON responses from the GitHub API

${args ? 'Additional user input: ' + args : ''}
`,
      },
    ]
  },
})
