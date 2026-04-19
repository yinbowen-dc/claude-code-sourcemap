/**
 * security-review 命令实现（commands/security-review.ts）
 *
 * 本文件实现 /security-review 命令，为当前 git 分支上的代码变更提供专项安全审查。
 * 它通过内嵌一个详尽的 Markdown 格式 prompt（含 frontmatter 工具白名单配置）来驱动
 * Claude 扮演资深安全工程师角色，对 PR diff 进行三阶段深度安全分析。
 *
 * 在 Claude Code 整体流程中的位置：
 *   用户输入 /security-review → createMovedToPluginCommand 路由 →
 *   若 marketplace 未上线则调用 getPromptWhileMarketplaceIsPrivate() →
 *   解析 frontmatter（工具白名单）→ 执行 Shell 命令填充 git 信息 →
 *   将完整 prompt 注入对话 → Claude 分三步（识别漏洞 → 并行验证 → 过滤误报）输出报告。
 *
 * 安全审查的三个阶段（由 prompt 驱动）：
 *   Phase 1：仓库上下文调研（理解现有安全框架和编码规范）；
 *   Phase 2：对比分析（新代码 vs 已有安全模式，找出偏差）；
 *   Phase 3：漏洞评估（追踪数据流、识别注入点）。
 *
 * 分析策略：主任务发现漏洞 → 并行子任务过滤误报 → 置信度 < 8 的结果自动丢弃。
 */

import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { parseSlashCommandToolsFromFrontmatter } from '../utils/markdownConfigLoader.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { createMovedToPluginCommand } from './createMovedToPluginCommand.js'

/**
 * 内嵌的安全审查 prompt 模板（Markdown + frontmatter 格式）。
 *
 * frontmatter 中的 allowed-tools 定义了此命令可调用的工具白名单：
 *   仅允许只读的 git/文件系统命令，严禁写操作（防止审查过程中意外修改代码）。
 *
 * prompt 正文包含：
 *   - Shell 命令占位符（!`...`），在注入前由 executeShellCommandsInPrompt 填充实际输出；
 *   - 详细的安全分析指令，涵盖输入验证、认证授权、加密、代码注入、数据暴露等类别；
 *   - 严格的误报过滤规则（16 条硬性排除 + 12 条先例），确保报告质量；
 *   - 必须使用并行子任务架构进行双重验证，置信度阈值 >= 8 才输出。
 */
const SECURITY_REVIEW_MARKDOWN = `---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task
description: Complete a security review of the pending changes on the current branch
---

You are a senior security engineer conducting a focused security review of the changes on this branch.

GIT STATUS:

\`\`\`
!\`git status\`
\`\`\`

FILES MODIFIED:

\`\`\`
!\`git diff --name-only origin/HEAD...\`
\`\`\`

COMMITS:

\`\`\`
!\`git log --no-decorate origin/HEAD...\`
\`\`\`

DIFF CONTENT:

\`\`\`
!\`git diff origin/HEAD...\`
\`\`\`

Review the complete diff above. This contains all code changes in the PR.


OBJECTIVE:
Perform a security-focused code review to identify HIGH-CONFIDENCE security vulnerabilities that could have real exploitation potential. This is not a general code review - focus ONLY on security implications newly added by this PR. Do not comment on existing security concerns.

CRITICAL INSTRUCTIONS:
1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, or system compromise
4. EXCLUSIONS: Do NOT report the following issue types:
   - Denial of Service (DOS) vulnerabilities, even if they allow service disruption
   - Secrets or sensitive data stored on disk (these are handled by other processes)
   - Rate limiting or resource exhaustion issues

SECURITY CATEGORIES TO EXAMINE:

**Input Validation Vulnerabilities:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization Issues:**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto & Secrets Management:**
- Hardcoded API keys, passwords, or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection & Code Execution:**
- Remote code execution via deseralization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS vulnerabilities in web applications (reflected, stored, DOM-based)

**Data Exposure:**
- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

Additional notes:
- Even if something is only exploitable from the local network, it can still be a HIGH severity issue

ANALYSIS METHODOLOGY:

Phase 1 - Repository Context Research (Use file search tools):
- Identify existing security frameworks and libraries in use
- Look for established secure coding patterns in the codebase
- Examine existing sanitization and validation patterns
- Understand the project's security model and threat model

Phase 2 - Comparative Analysis:
- Compare new code changes against existing security patterns
- Identify deviations from established secure practices
- Look for inconsistent security implementations
- Flag code that introduces new attack surfaces

Phase 3 - Vulnerability Assessment:
- Examine each modified file for security implications
- Trace data flow from user inputs to sensitive operations
- Look for privilege boundaries being crossed unsafely
- Identify injection points and unsafe deserialization

REQUIRED OUTPUT FORMAT:

You MUST output your findings in markdown. The markdown output should contain the file, line number, severity, category (e.g. \`sql_injection\` or \`xss\`), description, exploit scenario, and fix recommendation.

For example:

# Vuln 1: XSS: \`foo.py:42\`

* Severity: High
* Description: User input from \`username\` parameter is directly interpolated into HTML without escaping, allowing reflected XSS attacks
* Exploit Scenario: Attacker crafts URL like /bar?q=<script>alert(document.cookie)</script> to execute JavaScript in victim's browser, enabling session hijacking or data theft
* Recommendation: Use Flask's escape() function or Jinja2 templates with auto-escaping enabled for all user inputs rendered in HTML

SEVERITY GUIDELINES:
- **HIGH**: Directly exploitable vulnerabilities leading to RCE, data breach, or authentication bypass
- **MEDIUM**: Vulnerabilities requiring specific conditions but with significant impact
- **LOW**: Defense-in-depth issues or lower-impact vulnerabilities

CONFIDENCE SCORING:
- 0.9-1.0: Certain exploit path identified, tested if possible
- 0.8-0.9: Clear vulnerability pattern with known exploitation methods
- 0.7-0.8: Suspicious pattern requiring specific conditions to exploit
- Below 0.7: Don't report (too speculative)

FINAL REMINDER:
Focus on HIGH and MEDIUM findings only. Better to miss some theoretical issues than flood the report with false positives. Each finding should be something a security engineer would confidently raise in a PR review.

FALSE POSITIVE FILTERING:

> You do not need to run commands to reproduce the vulnerability, just read the code to determine if it is a real vulnerability. Do not use the bash tool or write to any files.
>
> HARD EXCLUSIONS - Automatically exclude findings matching these patterns:
> 1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks.
> 2. Secrets or credentials stored on disk if they are otherwise secured.
> 3. Rate limiting concerns or service overload scenarios.
> 4. Memory consumption or CPU exhaustion issues.
> 5. Lack of input validation on non-security-critical fields without proven security impact.
> 6. Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via untrusted input.
> 7. A lack of hardening measures. Code is not expected to implement all security best practices, only flag concrete vulnerabilities.
> 8. Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is concretely problematic.
> 9. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
> 10. Memory safety issues such as buffer overflows or use-after-free-vulnerabilities are impossible in rust. Do not report memory safety issues in rust or any other memory safe languages.
> 11. Files that are only unit tests or only used as part of running tests.
> 12. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
> 13. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
> 14. Including user-controlled content in AI system prompts is not a vulnerability.
> 15. Regex injection. Injecting untrusted content into a regex is not a vulnerability.
> 16. Regex DOS concerns.
> 16. Insecure documentation. Do not report any findings in documentation files such as markdown files.
> 17. A lack of audit logs is not a vulnerability.
>
> PRECEDENTS -
> 1. Logging high value secrets in plaintext is a vulnerability. Logging URLs is assumed to be safe.
> 2. UUIDs can be assumed to be unguessable and do not need to be validated.
> 3. Environment variables and CLI flags are trusted values. Attackers are generally not able to modify them in a secure environment. Any attack that relies on controlling an environment variable is invalid.
> 4. Resource management issues such as memory or file descriptor leaks are not valid.
> 5. Subtle or low impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution, and open redirects should not be reported unless they are extremely high confidence.
> 6. React and Angular are generally secure against XSS. These frameworks do not need to sanitize or escape user input unless it is using dangerouslySetInnerHTML, bypassSecurityTrustHtml, or similar methods. Do not report XSS vulnerabilities in React or Angular components or tsx files unless they are using unsafe methods.
> 7. Most vulnerabilities in github action workflows are not exploitable in practice. Before validating a github action workflow vulnerability ensure it is concrete and has a very specific attack path.
> 8. A lack of permission checking or authentication in client-side JS/TS code is not a vulnerability. Client-side code is not trusted and does not need to implement these checks, they are handled on the server-side. The same applies to all flows that send untrusted data to the backend, the backend is responsible for validating and sanitizing all inputs.
> 9. Only include MEDIUM findings if they are obvious and concrete issues.
> 10. Most vulnerabilities in ipython notebooks (*.ipynb files) are not exploitable in practice. Before validating a notebook vulnerability ensure it is concrete and has a very specific attack path where untrusted input can trigger the vulnerability.
> 11. Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report logging vulnerabilities if they expose sensitive information such as secrets, passwords, or personally identifiable information (PII).
> 12. Command injection vulnerabilities in shell scripts are generally not exploitable in practice since shell scripts generally do not run with untrusted user input. Only report command injection vulnerabilities in shell scripts if they are concrete and have a very specific attack path for untrusted input.
>
> SIGNAL QUALITY CRITERIA - For remaining findings, assess:
> 1. Is there a concrete, exploitable vulnerability with a clear attack path?
> 2. Does this represent a real security risk vs theoretical best practice?
> 3. Are there specific code locations and reproduction steps?
> 4. Would this finding be actionable for a security team?
>
> For each finding, assign a confidence score from 1-10:
> - 1-3: Low confidence, likely false positive or noise
> - 4-6: Medium confidence, needs investigation
> - 7-10: High confidence, likely true vulnerability

START ANALYSIS:

Begin your analysis now. Do this in 3 steps:

1. Use a sub-task to identify vulnerabilities. Use the repository exploration tools to understand the codebase context, then analyze the PR changes for security implications. In the prompt for this sub-task, include all of the above.
2. Then for each vulnerability identified by the above sub-task, create a new sub-task to filter out false-positives. Launch these sub-tasks as parallel sub-tasks. In the prompt for these sub-tasks, include everything in the "FALSE POSITIVE FILTERING" instructions.
3. Filter out any vulnerabilities where the sub-task reported a confidence less than 8.

Your final reply must contain the markdown report and nothing else.`

/**
 * 导出 /security-review 命令对象。
 * 使用 createMovedToPluginCommand 工厂函数包装，支持未来迁移到插件 marketplace 后的无缝切换：
 *   - 当 marketplace 上线后，命令自动路由到同名插件（security-review）执行；
 *   - 当前阶段（marketplace 仍为私有）调用 getPromptWhileMarketplaceIsPrivate() 生成 prompt。
 *
 * getPromptWhileMarketplaceIsPrivate 执行步骤：
 *   1. parseFrontmatter：从 SECURITY_REVIEW_MARKDOWN 提取 YAML frontmatter 配置；
 *   2. parseSlashCommandToolsFromFrontmatter：将 allowed-tools 字符串解析为工具白名单数组；
 *   3. executeShellCommandsInPrompt：将 prompt 中的 !`cmd` 占位符替换为实际命令输出
 *      （git status、git diff 等），同时在执行上下文中注入工具白名单以限制可用工具；
 *   4. 返回标准内容块格式，供命令系统注入对话。
 */
export default createMovedToPluginCommand({
  name: 'security-review',
  description:
    'Complete a security review of the pending changes on the current branch',
  progressMessage: 'analyzing code changes for security risks',
  pluginName: 'security-review',
  pluginCommand: 'security-review',
  async getPromptWhileMarketplaceIsPrivate(_args, context) {
    // Parse frontmatter from the markdown
    // 从内嵌 Markdown 中提取 YAML frontmatter（工具白名单配置）和正文内容
    const parsed = parseFrontmatter(SECURITY_REVIEW_MARKDOWN)

    // Parse allowed tools from frontmatter
    // 将 frontmatter 中的 allowed-tools 字符串解析为结构化工具权限列表
    const allowedTools = parseSlashCommandToolsFromFrontmatter(
      parsed.frontmatter['allowed-tools'],
    )

    // Execute bash commands in the prompt
    // 将 prompt 中的 !`cmd` Shell 命令占位符展开为实际输出，并注入工具权限限制
    const processedContent = await executeShellCommandsInPrompt(
      parsed.content,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                // 将 frontmatter 工具白名单注入 alwaysAllowRules，覆盖默认权限控制
                command: allowedTools,
              },
            },
          }
        },
      },
      'security-review',
    )

    return [
      {
        type: 'text',
        text: processedContent,  // 返回已展开 Shell 输出的完整 prompt 文本
      },
    ]
  },
})
