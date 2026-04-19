/**
 * prompt.ts — LSPTool 的工具名称与描述常量
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 LSPTool 提供工具名称常量和描述字符串。
 * LSPTool.ts 在注册工具时使用 LSP_TOOL_NAME，
 * 并在 description() 和 prompt() 方法中使用 DESCRIPTION。
 *
 * 【主要功能】
 * - 导出 LSP_TOOL_NAME（工具名称 "LSP"）
 * - 导出 DESCRIPTION：完整的工具使用说明，包含：
 *   - 所有支持的 9 种 LSP 操作的名称及用途说明
 *   - 所有操作共同必填参数说明（filePath, line, character）
 *   - LSP 服务器配置说明
 */

/** 工具名称常量，供全局引用 */
export const LSP_TOOL_NAME = 'LSP' as const

/**
 * LSPTool 的完整描述（同时用于 description() 和 prompt() 方法）。
 *
 * 描述内容：
 * - 工具定位：与 LSP 服务器交互，提供代码智能功能
 * - 9 种支持的操作：
 *   - goToDefinition：跳转到符号定义位置
 *   - findReferences：查找所有引用
 *   - hover：获取悬浮提示（文档、类型信息）
 *   - documentSymbol：列出文档中的所有符号
 *   - workspaceSymbol：在整个工作区中搜索符号
 *   - goToImplementation：查找接口或抽象方法的实现
 *   - prepareCallHierarchy：获取位置处的调用层次结构条目
 *   - incomingCalls：查找所有调用该函数的调用者
 *   - outgoingCalls：查找该函数调用的所有被调用者
 * - 所有操作必填参数：filePath、line（1-based）、character（1-based）
 * - 注意事项：LSP 服务器需针对文件类型进行配置
 */
export const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`
