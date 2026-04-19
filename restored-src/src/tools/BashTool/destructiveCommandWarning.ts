/**
 * BashTool/destructiveCommandWarning.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，专门负责检测具有潜在破坏性的 bash 命令并生成警告文本。
 * 在 BashTool 权限对话框展示前，会调用 getDestructiveCommandWarning 获取警告字符串，
 * 并将其展示在界面上，提示用户命令可能造成不可逆的数据损失或基础设施变更。
 *
 * 【重要说明】
 * 本模块是纯粹的信息提示层，不影响权限逻辑或自动批准判断。
 * 即使命令匹配破坏性模式，权限系统仍按正常流程处理。
 *
 * 【主要功能】
 * - 定义 DestructivePattern 类型：pattern（正则）+ warning（警告文本）。
 * - 维护 DESTRUCTIVE_PATTERNS 数组：覆盖 git 危险操作、文件删除、数据库、基础设施等类别。
 * - 导出 getDestructiveCommandWarning：逐一匹配模式，返回首个命中的警告文本或 null。
 */

/**
 * Detects potentially destructive bash commands and returns a warning string
 * for display in the permission dialog. This is purely informational — it
 * doesn't affect permission logic or auto-approval.
 */

/**
 * DestructivePattern
 *
 * 【类型说明】
 * 单条破坏性命令检测规则：
 * - pattern：用于匹配命令文本的正则表达式
 * - warning：当命令匹配时展示给用户的警告文本
 */
type DestructivePattern = {
  pattern: RegExp
  warning: string
}

/**
 * DESTRUCTIVE_PATTERNS
 *
 * 【说明】
 * 破坏性命令模式注册表，按类别组织：
 *   1. Git 危险操作（数据丢失/难以恢复）：reset --hard、push --force、clean -f 等
 *   2. Git 安全绕过：--no-verify（跳过钩子）、--amend（改写历史）
 *   3. 文件删除：rm -rf、rm -r、rm -f 等递归/强制删除
 *   4. 数据库操作：DROP/TRUNCATE TABLE、DELETE FROM（无 WHERE 条件）
 *   5. 基础设施：kubectl delete、terraform destroy
 */
const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — data loss / hard to reverse
  // Git — 数据丢失/难以恢复的操作
  {
    // git reset --hard 会丢弃所有未提交的修改
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: 'Note: may discard uncommitted changes',
  },
  {
    // git push --force / -f 会覆盖远端历史，危险且难以恢复
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: 'Note: may overwrite remote history',
  },
  {
    // git clean -f（无 --dry-run）会永久删除未跟踪文件
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: 'Note: may permanently delete untracked files',
  },
  {
    // git checkout -- . 会丢弃工作区所有改动
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    // git restore -- . 与 checkout -- . 效果相同
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    // git stash drop/clear 会永久移除暂存的改动
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: 'Note: may permanently remove stashed changes',
  },
  {
    // git branch -D（强制删除分支）会丢失未合并的提交
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: 'Note: may force-delete a branch',
  },

  // Git — safety bypass
  // Git — 绕过安全保护的操作
  {
    // --no-verify 跳过 pre-commit/pre-push 等 git 钩子
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: 'Note: may skip safety hooks',
  },
  {
    // --amend 改写最后一次提交，影响共享分支时有风险
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    warning: 'Note: may rewrite the last commit',
  },

  // File deletion (dangerous paths already handled by checkDangerousRemovalPaths)
  // 文件删除（危险路径已由 checkDangerousRemovalPaths 处理，此处覆盖通用情形）
  {
    // rm -rf 或 rm -fr：递归强制删除，最危险
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively force-remove files',
  },
  {
    // rm -r / -R：递归删除（不含强制标志）
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively remove files',
  },
  {
    // rm -f：强制删除（忽略不存在的文件）
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    warning: 'Note: may force-remove files',
  },

  // Database
  // 数据库危险操作
  {
    // DROP/TRUNCATE TABLE/DATABASE/SCHEMA 会销毁整个表或数据库
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'Note: may drop or truncate database objects',
  },
  {
    // DELETE FROM <table>（无 WHERE 子句）会清空整张表
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: 'Note: may delete all rows from a database table',
  },

  // Infrastructure
  // 基础设施操作
  {
    // kubectl delete 删除 Kubernetes 资源，可能影响生产环境
    pattern: /\bkubectl\s+delete\b/,
    warning: 'Note: may delete Kubernetes resources',
  },
  {
    // terraform destroy 会销毁所有 Terraform 管理的基础设施
    pattern: /\bterraform\s+destroy\b/,
    warning: 'Note: may destroy Terraform infrastructure',
  },
]

/**
 * getDestructiveCommandWarning
 *
 * 【函数作用】
 * 检查 bash 命令是否匹配已知的破坏性操作模式。
 * 若匹配，返回对应的人类可读警告字符串；若无匹配，返回 null。
 *
 * 【注意】本函数仅用于 UI 提示，不影响权限判断和自动批准逻辑。
 *
 * Checks if a bash command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
export function getDestructiveCommandWarning(command: string): string | null {
  // 遍历所有破坏性模式，返回第一个匹配项的警告文本
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return warning
    }
  }
  // 无匹配，返回 null 表示命令无已知破坏性风险
  return null
}
