# 技能、插件与 MCP 系统

## 概述

Claude Code 有三层扩展性系统：**技能**（上下文/指令）、
**插件**（技能 + hooks + MCP 的捆绑包）、**MCP**（工具服务器）。

**相关文件：** `skills/`、`plugins/`、`commands/mcp/`、`utils/suggestions/`

---

## 技能（Skills）系统

### 五种技能类型

| 类型 | 来源 | 激活方式 |
|------|------|---------|
| 内置（Bundled） | 编译进二进制文件 | 始终可用 |
| 文件型（File-based） | `.claude/skills/名称/SKILL.md` | 发现时激活 |
| MCP 型 | 远程 MCP 服务器 | MCP 连接时激活 |
| 动态（Dynamic） | 会话中通过目录遍历发现 | 文件变更时激活 |
| 条件型（Conditional） | 含 `paths:` 前置元数据 | 编辑匹配文件时激活 |

### 加载层级

```
1. 管理型技能  (~/.claude/skills/)
2. 用户技能    (~/.config/claude/skills/)
3. 项目技能    (.claude/skills/)
4. 旧版        .claude/commands/
```

每层通过 `realpath()` 规范化去重（处理符号链接）。
使用信号式失效（`skillsLoaded.emit()`）记忆化，支持会话中动态变更。

### 技能前置元数据字段

```yaml
name: string
description: string
aliases: string[]
whenToUse: string        # 技能建议排名依据
argumentHint: string
allowedTools: string[]   # 限制技能内可用工具
model: string            # 覆盖此技能使用的模型
disableModelInvocation: boolean
userInvocable: boolean   # 在 /help 中显示
version: string
effort: EffortValue
context: 'fork' | 'inline'
agent: string            # 子 Agent 配置
paths: string[]          # 条件激活路径模式（.gitignore 语法）
shell: string            # 运行的 shell 命令
hooks: object            # Hook 定义
```

### 条件激活（paths:）

含 `paths:` 的技能在编辑到匹配文件之前保持不活跃：

```typescript
// 使用 'ignore' 库（.gitignore 语法）
// 例：paths: ["**/*.py"] → 只在编辑 Python 文件时激活
// 条件型技能与无条件技能分开存储在 loadSkillsDir 中
```

### 内置技能文件提取

首次使用时将参考文件提取到临时目录。安全措施：
```typescript
// O_EXCL：防止覆盖（幂等性）
// O_NOFOLLOW：防止跟随符号链接
// 0o700：可执行权限（用于脚本）
// 路径遍历检查：不允许 '..' 段
```

---

## 插件系统

### 架构

```typescript
type Plugin = {
  name: string
  displayName?: string
  description?: string
  defaultEnabled?: boolean   // 默认：true
  skills?: BundledSkillDefinition[]
  hooks?: HookDefinitions
  mcpServers?: MCPServerConfig[]
}
```

插件在启动时通过 `registerBuiltinPlugin(definition)` 注册。

### 启用/禁用状态

```typescript
// 优先级：用户设置 > plugin.defaultEnabled > true
const isEnabled = userSetting !== undefined
  ? userSetting
  : (definition.defaultEnabled ?? true)
```

插件 ID：`{name}@builtin` 用于内置插件，与市场插件区分。

---

## MCP（模型上下文协议）

### 支持的传输层

| 传输层 | 使用场景 |
|--------|---------|
| stdio | 本地子进程 |
| SSE | 远程 HTTP 服务器 |
| HTTP | 无状态 HTTP |
| WebSocket | 双向流 |

### 配置作用域

```
local   → .claude/settings.json（项目级）
user    → ~/.config/claude/settings.json
project → 通过 /mcp 命令配置
```

支持 OAuth + XAA（跨账号访问）。

### 循环依赖规避

MCP 技能集成存在循环依赖风险：
- `loadSkillsDir.ts` 创建技能命令
- `mcpSkills.ts` 需要技能命令工厂

**解决方案：** 只导入类型的写一次注册叶模块（`mcpSkillBuilders.ts`）。
工厂在启动时注册：`registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })`。

### 延迟工具加载

当 MCP 工具超过 Token 预算阈值时：
- 工具不包含在每个请求中
- `ToolSearchTool` 让模型按关键字搜索工具
- 首次使用时加载工具；后续从缓存读取

阈值：上下文窗口的 10%（可通过 `ENABLE_TOOL_SEARCH=auto:N` 配置）。
非 Anthropic base URL 时禁用（代理网关通常不支持 `tool_reference` beta）。

---

## 技能建议系统（utils/suggestions/）

### 搜索架构

使用带权重字段的 **Fuse.js**：

```typescript
// 权重层级
commandName: 3.0    // 最高：精确名称匹配最重要
partKey: 2.0        // 部分名称匹配
aliasKey: 2.0       // 别名匹配
descriptionKey: 0.5 // 描述匹配（最低权重）
```

### 排名算法

**空查询（显示最近/热门）：**
1. 按使用分数排列的前 5 个最近使用技能
2. 分类显示：内置 → 用户 → 项目 → 策略 → 其他

**有搜索词时：**
1. 精确名称匹配
2. 精确别名匹配
3. 名称前缀匹配
4. 别名前缀匹配
5. 模糊匹配（Fuse.js 评分）

同分时按**使用分数**打破平局（7 天指数衰减）：
```typescript
score = usageCount × max(0.5^(daysSinceUse/7), 0.1)
// 半衰期：7 天
// 最低值：原始计数的 10%（防止完全遗忘）
```

### 使用追踪（skillUsageTracking.ts）

```typescript
// 磁盘写入 60 秒防抖（内存 Map 累积）
// 防止频繁调用技能时的文件 I/O 抖动
// 进程生命周期防抖：按技能名称，不按会话
```

### 行内斜杠命令检测

检测用户在文字中间输入的 `/命令`（如输入其他词之后）：
```typescript
// 模式：空白 + 斜杠 + 字母数字字符（在输入末尾）
/\s\/([a-zA-Z0-9_:-]*)$/
// 不使用 lookbehind（JSC JIT 优化）
```

### Slack 频道建议

通过 MCP 建议 Slack 频道时：
```typescript
// Slack 按连字符分词，部分词匹配会失败
// 查询转换："security-inc" → 去掉末尾段 → "security"
// 向 MCP 服务器发送简化查询
// 在本地过滤完整前缀的结果
```

---

## Advisor 命令（/advisor）

设置用于代码审查的辅助模型：

```typescript
/advisor <model>   → 设置顾问模型（验证支持情况）
/advisor unset     → 禁用
/advisor           → 显示当前状态
// 持久化到 userSettings
// 限制：只有支持顾问角色的模型才能设置
```

---

## Insights 命令（/insights，仅 ANT 内部）

分析来自远程 homespace 的 Claude Code 会话数据：
```typescript
// 仅 Ant 基础设施：
// 1. 查询运行中的远程 homespace（coder list -o json）
// 2. 通过 SSH 统计会话数量（find *.jsonl | wc -l）
// 3. 并行 SCP 远程项目（跳过已有的）
// 4. 使用 Opus 模型进行分析和摘要

// 非 Ant：函数返回空/零（优雅降级）
```

---

## 反常规设计

| 模式 | 原因 |
|------|------|
| 通过注册叶模块规避循环依赖 | `mcpSkillBuilders.ts` 只导入类型；防止 tree-shake 问题 |
| 条件型技能单独存储 | 避免每次请求都评估路径模式 |
| `realpath()` 去重 | 同一目录的符号链接会重复加载技能 |
| 60 秒使用防抖 | 频繁调用技能导致的文件 I/O 抖动 |
| 内置技能提取使用 O_NOFOLLOW | 防止提取时通过符号链接逃脱路径 |
| Fuse 中隐藏命令去重 | isHidden 在会话中翻转时（OAuth 过期），去重确保正确匹配 |
| Slack 段剥离 | Slack 的分词不支持词中间的部分匹配 |
| matchAll 每次创建新 /g 正则 | 共享实例会跨调用泄漏 `lastIndex` |
