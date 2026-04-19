/**
 * GitHub Actions 配置核心逻辑模块
 *
 * 本文件是 `/install-github-app` 命令的后端执行层，负责通过 GitHub CLI（gh）
 * 将 Claude GitHub Actions 工作流实际部署到指定仓库。整体执行流程：
 *
 *   1. 验证目标仓库存在性及访问权限
 *   2. 获取默认分支名称与最新 commit SHA
 *   3. 创建一个新的特性分支（add-claude-github-actions-<时间戳>）
 *   4. 将 WORKFLOW_CONTENT / CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT 写入对应工作流文件
 *      - 根据 secretName 决定 workflow YAML 中引用的 secret 键名
 *      - 若使用 OAuth Token，替换为 claude_code_oauth_token 参数
 *   5. 将 API Key 或 OAuth Token 存储为仓库 Secret
 *   6. 构造 GitHub 比较 URL（比较视图 + PR 模板）并在浏览器中打开，
 *      让用户在 GitHub 网页上完成 Pull Request 的最终提交
 *
 * 全程通过埋点事件追踪安装进度（tengu_setup_github_actions_started/completed/failed）。
 */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { saveGlobalConfig } from 'src/utils/config.js'
import {
  CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
  PR_BODY,
  PR_TITLE,
  WORKFLOW_CONTENT,
} from '../../constants/github-app.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import type { Workflow } from './types.js'

/**
 * 创建或更新工作流文件
 *
 * 通过 GitHub API（gh api PUT repos/{owner}/{repo}/contents/{path}）
 * 在指定分支上创建（或更新）一个工作流 YAML 文件：
 *   1. 先查询文件当前的 SHA（用于更新时的版本标识，避免 422 冲突）
 *   2. 根据 secretName 动态替换 YAML 中的 secret 引用方式：
 *      - CLAUDE_CODE_OAUTH_TOKEN → 使用 claude_code_oauth_token 参数
 *      - 自定义名称 → 保留 anthropic_api_key 参数但替换 secret 名
 *      - 默认 ANTHROPIC_API_KEY → 保持原样
 *   3. 将 YAML 内容 Base64 编码后通过 PUT 请求写入仓库
 *
 * @param repoName      目标仓库全名（owner/repo）
 * @param branchName    要写入文件的目标分支名
 * @param workflowPath  工作流文件的仓库相对路径（如 .github/workflows/claude.yml）
 * @param workflowContent 原始工作流 YAML 内容
 * @param secretName    实际使用的 GitHub Secret 名称
 * @param message       Git commit 消息
 * @param context       用于埋点的上下文信息（是否复用当前仓库、文件是否已存在等）
 */
async function createWorkflowFile(
  repoName: string,
  branchName: string,
  workflowPath: string,
  workflowContent: string,
  secretName: string,
  message: string,
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
): Promise<void> {
  // 查询工作流文件是否已存在于仓库中，获取其 SHA（用于后续 PUT 更新请求）
  const checkFileResult = await execFileNoThrow('gh', [
    'api',
    `repos/${repoName}/contents/${workflowPath}`,
    '--jq',
    '.sha',
  ])

  // 若文件已存在，记录 SHA 以便更新时传递版本标识
  let fileSha: string | null = null
  if (checkFileResult.code === 0) {
    fileSha = checkFileResult.stdout.trim()
  }

  let content = workflowContent
  if (secretName === 'CLAUDE_CODE_OAUTH_TOKEN') {
    // OAuth Token 模式：将 anthropic_api_key 参数替换为 claude_code_oauth_token
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    )
  } else if (secretName !== 'ANTHROPIC_API_KEY') {
    // 自定义 secret 名称：保留 anthropic_api_key 参数但更新 secret 引用
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `anthropic_api_key: \${{ secrets.${secretName} }}`,
    )
  }
  // 将文件内容 Base64 编码，满足 GitHub API 的 content 字段要求
  const base64Content = Buffer.from(content).toString('base64')

  // 构造 PUT API 请求参数
  const apiParams = [
    'api',
    '--method',
    'PUT',
    `repos/${repoName}/contents/${workflowPath}`,
    '-f',
    `message=${fileSha ? `"Update ${message}"` : `"${message}"`}`,
    '-f',
    `content=${base64Content}`,
    '-f',
    `branch=${branchName}`,
  ]

  // 文件已存在时需附带 SHA，否则 GitHub API 会返回 409 冲突错误
  if (fileSha) {
    apiParams.push('-f', `sha=${fileSha}`)
  }

  const createFileResult = await execFileNoThrow('gh', apiParams)
  if (createFileResult.code !== 0) {
    if (
      createFileResult.stderr.includes('422') &&
      createFileResult.stderr.includes('sha')
    ) {
      // 422 + sha 错误：工作流文件已存在但 SHA 不匹配，提示用户手动处理
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: createFileResult.code,
        ...context,
      })
      throw new Error(
        `Failed to create workflow file ${workflowPath}: A Claude workflow file already exists in this repository. Please remove it first or update it manually.`,
      )
    }

    logEvent('tengu_setup_github_actions_failed', {
      reason:
        'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      exit_code: createFileResult.code,
      ...context,
    })

    // 附上常见问题诊断提示，帮助用户排查权限不足等问题
    const helpText =
      '\n\nNeed help? Common issues:\n' +
      '· Permission denied → Run: gh auth refresh -h github.com -s repo,workflow\n' +
      '· Not authorized → Ensure you have admin access to the repository\n' +
      '· For manual setup → Visit: https://github.com/anthropics/claude-code-action'

    throw new Error(
      `Failed to create workflow file ${workflowPath}: ${createFileResult.stderr}${helpText}`,
    )
  }
}

/**
 * setupGitHubActions — GitHub Actions 完整安装流程
 *
 * 按顺序执行以下步骤，完成 Claude GitHub Actions 的端到端配置：
 *   1. 验证仓库存在性（gh api repos/{repoName}）
 *   2. 获取默认分支（.default_branch）
 *   3. 获取默认分支的最新 commit SHA
 *   4. 创建新分支（add-claude-github-actions-<时间戳>）
 *   5. 根据 selectedWorkflows 写入对应工作流文件
 *   6. 将 API Key/OAuth Token 设为仓库 Secret（gh secret set）
 *   7. 构造 PR 比较 URL 并在浏览器中打开，让用户完成 PR 提交
 *
 * 全程记录分析埋点，失败时抛出带上下文信息的 Error。
 *
 * @param repoName            目标仓库全名（owner/repo 格式）
 * @param apiKeyOrOAuthToken  Anthropic API Key 或 OAuth Token，为 null 时跳过 Secret 设置
 * @param secretName          存储认证信息的 GitHub Secret 名称
 * @param updateProgress      进度回调，每完成一个关键步骤时调用，用于更新 UI 进度条
 * @param skipWorkflow        为 true 时跳过分支创建和工作流文件写入（仅更新 Secret）
 * @param selectedWorkflows   要安装的工作流类型列表（'claude' | 'claude-review'）
 * @param authType            认证方式：'api_key' 或 'oauth_token'
 * @param context             埋点上下文（是否使用当前仓库、文件/Secret 是否已存在）
 */
export async function setupGitHubActions(
  repoName: string,
  apiKeyOrOAuthToken: string | null,
  secretName: string,
  updateProgress: () => void,
  skipWorkflow = false,
  selectedWorkflows: Workflow[],
  authType: 'api_key' | 'oauth_token',
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
) {
  try {
    logEvent('tengu_setup_github_actions_started', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })

    // 步骤 1：验证仓库是否可访问（通过 .id 字段判断是否存在）
    const repoCheckResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.id',
    ])
    if (repoCheckResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'repo_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: repoCheckResult.code,
        ...context,
      })
      throw new Error(
        `Failed to access repository ${repoName}: ${repoCheckResult.stderr}`,
      )
    }

    // 步骤 2：获取默认分支名（后续新建分支和 PR 的 base 分支）
    const defaultBranchResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.default_branch',
    ])
    if (defaultBranchResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_default_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: defaultBranchResult.code,
        ...context,
      })
      throw new Error(
        `Failed to get default branch: ${defaultBranchResult.stderr}`,
      )
    }
    const defaultBranch = defaultBranchResult.stdout.trim()

    // 步骤 3：获取默认分支最新 commit 的 SHA（用作新建分支的起点）
    const shaResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}/git/ref/heads/${defaultBranch}`,
      '--jq',
      '.object.sha',
    ])
    if (shaResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_branch_sha' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: shaResult.code,
        ...context,
      })
      throw new Error(`Failed to get branch SHA: ${shaResult.stderr}`)
    }
    const sha = shaResult.stdout.trim()

    let branchName: string | null = null

    if (!skipWorkflow) {
      updateProgress()
      // 步骤 4：创建新分支，以时间戳命名确保唯一性
      branchName = `add-claude-github-actions-${Date.now()}`
      const createBranchResult = await execFileNoThrow('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repoName}/git/refs`,
        '-f',
        `ref=refs/heads/${branchName}`,
        '-f',
        `sha=${sha}`,
      ])
      if (createBranchResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_create_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: createBranchResult.code,
          ...context,
        })
        throw new Error(`Failed to create branch: ${createBranchResult.stderr}`)
      }

      updateProgress()
      // 步骤 5：根据用户选择确定需要写入的工作流文件列表
      const workflows = []

      if (selectedWorkflows.includes('claude')) {
        // claude.yml：PR Assistant 工作流，在 PR 创建/评论时触发 Claude 协助
        workflows.push({
          path: '.github/workflows/claude.yml',
          content: WORKFLOW_CONTENT,
          message: 'Claude PR Assistant workflow',
        })
      }

      if (selectedWorkflows.includes('claude-review')) {
        // claude-code-review.yml：代码审查工作流，自动对 PR 进行代码 review
        workflows.push({
          path: '.github/workflows/claude-code-review.yml',
          content: CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
          message: 'Claude Code Review workflow',
        })
      }

      // 逐一写入工作流文件到仓库的新分支
      for (const workflow of workflows) {
        await createWorkflowFile(
          repoName,
          branchName,
          workflow.path,
          workflow.content,
          secretName,
          workflow.message,
          context,
        )
      }
    }

    updateProgress()
    // 步骤 6：将 API Key 或 OAuth Token 存储为仓库 Secret
    if (apiKeyOrOAuthToken) {
      const setSecretResult = await execFileNoThrow('gh', [
        'secret',
        'set',
        secretName,
        '--body',
        apiKeyOrOAuthToken,
        '--repo',
        repoName,
      ])
      if (setSecretResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_set_api_key_secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: setSecretResult.code,
          ...context,
        })

        const helpText =
          '\n\nNeed help? Common issues:\n' +
          '· Permission denied → Run: gh auth refresh -h github.com -s repo\n' +
          '· Not authorized → Ensure you have admin access to the repository\n' +
          '· For manual setup → Visit: https://github.com/anthropics/claude-code-action'

        throw new Error(
          `Failed to set API key secret: ${setSecretResult.stderr || 'Unknown error'}${helpText}`,
        )
      }
    }

    if (!skipWorkflow && branchName) {
      updateProgress()
      // 步骤 7：构造 GitHub 比较视图 URL（含预填充的 PR 标题和描述模板），并在浏览器中打开
      // 用户点击"Create pull request"按钮即可完成 PR 提交，无需手动填写标题和描述
      const compareUrl = `https://github.com/${repoName}/compare/${defaultBranch}...${branchName}?quick_pull=1&title=${encodeURIComponent(PR_TITLE)}&body=${encodeURIComponent(PR_BODY)}`

      await openBrowser(compareUrl)
    }

    logEvent('tengu_setup_github_actions_completed', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      auth_type:
        authType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })
    // 记录 GitHub Actions 成功安装次数，用于后续引导和统计
    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
  } catch (error) {
    if (
      !error ||
      !(error instanceof Error) ||
      !error.message.includes('Failed to')
    ) {
      // 非预期错误（即 message 中不含 'Failed to'）单独上报，避免重复打点
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...context,
      })
    }
    if (error instanceof Error) {
      logError(error)
    }
    throw error
  }
}
  repoName: string,
  branchName: string,
  workflowPath: string,
  workflowContent: string,
  secretName: string,
  message: string,
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
): Promise<void> {
  // Check if workflow file already exists
  const checkFileResult = await execFileNoThrow('gh', [
    'api',
    `repos/${repoName}/contents/${workflowPath}`,
    '--jq',
    '.sha',
  ])

  let fileSha: string | null = null
  if (checkFileResult.code === 0) {
    fileSha = checkFileResult.stdout.trim()
  }

  let content = workflowContent
  if (secretName === 'CLAUDE_CODE_OAUTH_TOKEN') {
    // For OAuth tokens, use the claude_code_oauth_token parameter
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    )
  } else if (secretName !== 'ANTHROPIC_API_KEY') {
    // For other custom secret names, keep using anthropic_api_key parameter
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `anthropic_api_key: \${{ secrets.${secretName} }}`,
    )
  }
  const base64Content = Buffer.from(content).toString('base64')

  const apiParams = [
    'api',
    '--method',
    'PUT',
    `repos/${repoName}/contents/${workflowPath}`,
    '-f',
    `message=${fileSha ? `"Update ${message}"` : `"${message}"`}`,
    '-f',
    `content=${base64Content}`,
    '-f',
    `branch=${branchName}`,
  ]

  if (fileSha) {
    apiParams.push('-f', `sha=${fileSha}`)
  }

  const createFileResult = await execFileNoThrow('gh', apiParams)
  if (createFileResult.code !== 0) {
    if (
      createFileResult.stderr.includes('422') &&
      createFileResult.stderr.includes('sha')
    ) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: createFileResult.code,
        ...context,
      })
      throw new Error(
        `Failed to create workflow file ${workflowPath}: A Claude workflow file already exists in this repository. Please remove it first or update it manually.`,
      )
    }

    logEvent('tengu_setup_github_actions_failed', {
      reason:
        'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      exit_code: createFileResult.code,
      ...context,
    })

    const helpText =
      '\n\nNeed help? Common issues:\n' +
      '· Permission denied → Run: gh auth refresh -h github.com -s repo,workflow\n' +
      '· Not authorized → Ensure you have admin access to the repository\n' +
      '· For manual setup → Visit: https://github.com/anthropics/claude-code-action'

    throw new Error(
      `Failed to create workflow file ${workflowPath}: ${createFileResult.stderr}${helpText}`,
    )
  }
}

export async function setupGitHubActions(
  repoName: string,
  apiKeyOrOAuthToken: string | null,
  secretName: string,
  updateProgress: () => void,
  skipWorkflow = false,
  selectedWorkflows: Workflow[],
  authType: 'api_key' | 'oauth_token',
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
) {
  try {
    logEvent('tengu_setup_github_actions_started', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })

    // Check if repository exists
    const repoCheckResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.id',
    ])
    if (repoCheckResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'repo_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: repoCheckResult.code,
        ...context,
      })
      throw new Error(
        `Failed to access repository ${repoName}: ${repoCheckResult.stderr}`,
      )
    }

    // Get default branch
    const defaultBranchResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.default_branch',
    ])
    if (defaultBranchResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_default_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: defaultBranchResult.code,
        ...context,
      })
      throw new Error(
        `Failed to get default branch: ${defaultBranchResult.stderr}`,
      )
    }
    const defaultBranch = defaultBranchResult.stdout.trim()

    // Get SHA of default branch
    const shaResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}/git/ref/heads/${defaultBranch}`,
      '--jq',
      '.object.sha',
    ])
    if (shaResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_branch_sha' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: shaResult.code,
        ...context,
      })
      throw new Error(`Failed to get branch SHA: ${shaResult.stderr}`)
    }
    const sha = shaResult.stdout.trim()

    let branchName: string | null = null

    if (!skipWorkflow) {
      updateProgress()
      // Create new branch
      branchName = `add-claude-github-actions-${Date.now()}`
      const createBranchResult = await execFileNoThrow('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repoName}/git/refs`,
        '-f',
        `ref=refs/heads/${branchName}`,
        '-f',
        `sha=${sha}`,
      ])
      if (createBranchResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_create_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: createBranchResult.code,
          ...context,
        })
        throw new Error(`Failed to create branch: ${createBranchResult.stderr}`)
      }

      updateProgress()
      // Create selected workflow files
      const workflows = []

      if (selectedWorkflows.includes('claude')) {
        workflows.push({
          path: '.github/workflows/claude.yml',
          content: WORKFLOW_CONTENT,
          message: 'Claude PR Assistant workflow',
        })
      }

      if (selectedWorkflows.includes('claude-review')) {
        workflows.push({
          path: '.github/workflows/claude-code-review.yml',
          content: CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
          message: 'Claude Code Review workflow',
        })
      }

      for (const workflow of workflows) {
        await createWorkflowFile(
          repoName,
          branchName,
          workflow.path,
          workflow.content,
          secretName,
          workflow.message,
          context,
        )
      }
    }

    updateProgress()
    // Set the API key as a secret if provided
    if (apiKeyOrOAuthToken) {
      const setSecretResult = await execFileNoThrow('gh', [
        'secret',
        'set',
        secretName,
        '--body',
        apiKeyOrOAuthToken,
        '--repo',
        repoName,
      ])
      if (setSecretResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_set_api_key_secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: setSecretResult.code,
          ...context,
        })

        const helpText =
          '\n\nNeed help? Common issues:\n' +
          '· Permission denied → Run: gh auth refresh -h github.com -s repo\n' +
          '· Not authorized → Ensure you have admin access to the repository\n' +
          '· For manual setup → Visit: https://github.com/anthropics/claude-code-action'

        throw new Error(
          `Failed to set API key secret: ${setSecretResult.stderr || 'Unknown error'}${helpText}`,
        )
      }
    }

    if (!skipWorkflow && branchName) {
      updateProgress()
      // Create PR template URL instead of creating PR directly
      const compareUrl = `https://github.com/${repoName}/compare/${defaultBranch}...${branchName}?quick_pull=1&title=${encodeURIComponent(PR_TITLE)}&body=${encodeURIComponent(PR_BODY)}`

      await openBrowser(compareUrl)
    }

    logEvent('tengu_setup_github_actions_completed', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      auth_type:
        authType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })
    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
  } catch (error) {
    if (
      !error ||
      !(error instanceof Error) ||
      !error.message.includes('Failed to')
    ) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...context,
      })
    }
    if (error instanceof Error) {
      logError(error)
    }
    throw error
  }
}
