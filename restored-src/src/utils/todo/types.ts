/**
 * 【文件定位】通用工具层 — Todo 列表数据类型定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   TodoTool（/todo）工具需要校验 LLM 生成的结构化 JSON 参数。
 *     → 本模块定义 Zod Schema（用于运行时验证）和对应的 TypeScript 类型
 *     → TodoTool 用 TodoItemSchema 校验输入，用 TodoList 类型注解内部状态
 *
 * 主要职责：
 *   1. TodoStatusSchema — 枚举三种状态：pending / in_progress / completed
 *   2. TodoItemSchema   — 单条 todo 的结构校验（content、status、activeForm 三字段）
 *   3. TodoListSchema   — todo 列表（TodoItem 的数组）
 *   4. 导出 TodoItem / TodoList TypeScript 类型（从 Zod Schema 推导）
 *
 * 为何用 lazySchema：
 *   lazySchema 包装器实现 Schema 的延迟实例化，避免模块加载时就执行大量 Zod 构建，
 *   提升启动性能。被导出的 Schema 是工厂函数（调用才创建实例），而非静态对象。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'

/**
 * Todo 项状态枚举：
 *   - pending     — 待处理（未开始）
 *   - in_progress — 进行中
 *   - completed   — 已完成
 *
 * 使用 lazySchema 延迟实例化，避免模块加载时立即构建 Zod 对象。
 */
const TodoStatusSchema = lazySchema(() =>
  z.enum(['pending', 'in_progress', 'completed']),
)

/**
 * 单条 Todo 项的 Zod 校验 Schema。
 *
 * 字段说明：
 *   - content    — Todo 正文（不可为空字符串）
 *   - status     — 当前状态（来自 TodoStatusSchema 枚举）
 *   - activeForm — 激活表单标识（不可为空字符串）
 */
export const TodoItemSchema = lazySchema(() =>
  z.object({
    content: z.string().min(1, 'Content cannot be empty'),
    status: TodoStatusSchema(),
    activeForm: z.string().min(1, 'Active form cannot be empty'),
  }),
)
// 从 Schema 推导出 TypeScript 类型，供其他模块类型注解使用
export type TodoItem = z.infer<ReturnType<typeof TodoItemSchema>>

/**
 * Todo 列表 Schema：TodoItem 的数组。
 * 同样使用 lazySchema 延迟实例化。
 */
export const TodoListSchema = lazySchema(() => z.array(TodoItemSchema()))
// 推导 TypeScript 类型
export type TodoList = z.infer<ReturnType<typeof TodoListSchema>>
