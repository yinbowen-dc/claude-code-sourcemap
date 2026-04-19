/**
 * TaskGetTool/prompt.ts — 任务查询工具的提示词定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ TaskGetTool 子模块 → 提示词层
 *
 * 主要功能：
 *   - 导出工具功能简介（DESCRIPTION）
 *   - 导出完整的系统提示词（PROMPT），指导模型何时及如何使用 TaskGet 工具
 *
 * 设计说明：
 *   - PROMPT 为静态常量，无需运行时动态构建
 *   - 包含使用场景、输出字段说明和使用技巧三个章节
 */

// 工具功能的静态简介，供工具列表和自动分类器使用
export const DESCRIPTION = 'Get a task by ID from the task list'

/**
 * TaskGet 工具的完整系统提示词
 *
 * 包含以下核心章节：
 *   - 使用场景（When to Use This Tool）：开始工作前获取完整需求、理解依赖关系、接收任务分配后查看详情
 *   - 输出字段说明（Output）：subject、description、status、blocks、blockedBy
 *   - 使用技巧（Tips）：开始前先检查 blockedBy 是否为空；使用 TaskList 查看所有任务摘要
 */
export const PROMPT = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.
`
