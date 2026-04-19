# 费用追踪与 Token 管理

## 概述

完整的会话费用追踪、用户控制的 Token 预算、思考/超级思考模式，
以及多种压缩策略。

**相关文件：** `cost-tracker.ts`、`costHook.ts`、`utils/tokenBudget.ts`、
`utils/tokens.ts`、`utils/thinking.ts`、`commands/cost/`、`commands/effort/`、
`commands/extra-usage/`、`commands/compact/`

---

## 费用追踪（cost-tracker.ts）

### 存储格式

```typescript
type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}
```

持久化到项目配置（`~/.claude/projects/{hash}/config.json`）。
**只有会话 ID 匹配时才恢复**——切换项目 = 费用重置。

### 累计流程

```typescript
addToTotalSessionCost(cost, usage, model):
  1. addToTotalModelUsage()  → 按模型累计 Token/费用
  2. addToTotalCostState()   → 会话总计
  3. getCostCounter().add()  → OTEL 指标
  4. getTokenCounter().add() → 按类型（input/output/cacheRead/cacheCreation）
  5. 递归：对每个顾问工具用量：
       advisorCost = calculateUSDCost(model, advisorUsage)
       totalCost += addToTotalSessionCost(advisorCost, ...)  ← 递归调用
```

顾问工具的费用**递归冒泡**到会话总计。

### 费用显示

```typescript
// 模型按规范短名称聚合：
// "claude-opus-4-7" + "claude-opus-4-5-20251101" → "claude-opus-4"

function formatCost(cost: number): string {
  return cost > 0.5
    ? `$${round(cost, 100).toFixed(2)}`   // $1.23
    : `$${cost.toFixed(4)}`               // $0.0001
}
```

### 退出时打印

```typescript
// costHook.ts
process.on('exit', () => {
  if (hasConsoleBillingAccess()) {
    process.stdout.write('\n' + formatTotalCost() + '\n')
  }
  saveCurrentSessionCosts(getFpsMetrics?.())
})
```

**对 Claude AI 订阅者隐藏**（他们看不到账单）。ant 用户始终可见。

---

## Token 预算（utils/tokenBudget.ts）

用户可以用自然语言指定在某个任务上花费多少 Token。

### 三种正则模式

```typescript
// 1. 开头的简写："+ 500k 修复认证 bug"
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i

// 2. 结尾的简写："修复认证 bug +500k。"
// 注意：故意避免用 lookbehind——会击败 JSC（JavaScriptCore）的 YARR JIT
// 改为捕获前导空格，调用方偏移 1 位
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i

// 3. 详细写法："use 2M tokens to refactor" / "spend 1.5m tokens"
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
```

倍数：`k=1,000`、`m=1,000,000`、`b=1,000,000,000`

### 续写提示消息

当接近预算时：
```typescript
`在 Token 目标的 ${pct}% 处停止（${fmt(turnTokens)} / ${fmt(budget)}）。
继续工作——不要总结。`
```

---

## 思考 / 超级思考（utils/thinking.ts）

### 双重开关

```typescript
isUltrathinkEnabled():
  1. 编译标志：feature('ULTRATHINK')
  2. GrowthBook：getFeatureValue_CACHED('tengu_turtle_carbon', true)
```

### 配置类型

```typescript
type ThinkingConfig =
  | { type: 'adaptive' }              // 模型自主决定预算
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }
```

### 模型支持矩阵

| 提供商 | 支持思考的模型 |
|--------|--------------|
| 1P / Foundry | 所有 Claude 4+（含 Haiku 4.5） |
| Bedrock / Vertex | 仅 Opus 4+ 和 Sonnet 4+ |
| ant 内部 | 通过 resolveAntModel() 的所有模型 |

### 自适应思考

仅适用于 Opus 4.6 / Sonnet 4.6+：
```typescript
// 代码注释："重要：不要在未通知模型发布 DRI 和研究团队的情况下更改自适应思考支持。
// 这会严重影响模型质量。"
```

### 关键词检测

```typescript
hasUltrathinkKeyword(text): /\bultrathink\b/i.test(text)

findThinkingTriggerPositions(text):
  // 每次调用都创建新的 /g 正则——共享实例会从 hasUltrathinkKeyword 的
  // .test() 调用中泄漏 lastIndex 状态到下一次渲染的 matchAll()
  const matches = text.matchAll(/\bultrathink\b/gi)
```

---

## Effort 命令（/effort）

设置推理/计算级别。

```typescript
type EffortValue = 'low' | 'medium' | 'high' | 'max' | undefined

// 级别说明：
// low:    快速、直接
// medium: 平衡，含标准测试
// high:   全面，含大量测试
// max:    最大能力（仅 Opus 4.6）
// auto:   模型默认
```

**环境变量覆盖：**
```typescript
// CLAUDE_CODE_EFFORT_LEVEL 环境变量优先于 /effort 命令
// 如果用户尝试用冲突的值覆盖，会打印警告
```

---

## Extra Usage 命令（/extra-usage）

管理 Claude AI 超额和扩展限制。

### 按订阅类型的流程

**Team/Enterprise（无账单访问权限）：**
1. 检查是否已有无限额外用量 → 完成
2. 检查管理员请求资格
3. 检查是否有待处理/已关闭的请求
4. 创建 `limit_increase` 管理员请求

**个人 / 有账单访问权限：**
```typescript
const url = isTeamOrEnterprise
  ? 'https://claude.ai/admin-settings/usage'
  : 'https://claude.ai/settings/usage'
await openBrowser(url)
```

---

## Compact 命令（/compact）

总结对话历史以释放上下文窗口空间。

### 三种策略（按顺序尝试）

**1. 会话记忆压缩**（最便宜）
- 如果有可用的存储摘要则使用
- 不需要 API 调用
- 完成后清除用户上下文缓存

**2. 响应式压缩**（如果是 `isReactiveOnlyMode()`）
- 并发运行压缩前 hooks 和缓存参数构建
- 将 hook 指令与用户自定义指令合并
- 特定失败处理：`too_few_groups`、`aborted`、`exhausted`、`media_unstrippable`

**3. 传统压缩**（备用）
- 先运行 microcompact（压缩前减少 Token）
- 然后 `compactConversation()` 生成完整摘要
- 重置 `lastSummarizedMessageId`（旧 UUID 在新消息数组中不再存在）

### 压缩后操作

```typescript
getUserContext.cache.clear?.()    // 清除记忆化的上下文
suppressCompactWarning()          // 隐藏"上下文即将耗尽"警告
notifyCompaction()                // 重置缓存读取基准（避免误报中断检测）
markPostCompaction()              // 为下游系统设置标志
```

### 压缩边界后的消息

```typescript
// REPL 保留截断的消息用于 UI 滚动回顾
// 在压缩前过滤掉这些（不要总结被故意移除的内容）
messages = getMessagesAfterCompactBoundary(messages)
```

---

## 反常规设计

| 模式 | 原因 |
|------|------|
| 顾问费用递归累计 | 工具调用本身会产生模型费用 |
| Token 预算正则避免 lookbehind | 会击败 JSC（JavaScriptCore）的 YARR JIT |
| matchAll 每次调用创建新正则实例 | 共享实例会泄漏 `lastIndex` 状态 |
| Claude AI 订阅者隐藏费用显示 | 订阅者看不到账单信息 |
| 费用恢复需要会话 ID 匹配 | 防止来自错误会话的过期费用 |
| 快速模式费用标记 `speed: 'fast'` | 分析时区分快速模式和普通模式的费用 |
| 自适应思考更改需通知 DRI | 更改会影响模型质量和基准测试 |
| 响应式压缩的 hook 与缓存参数并发运行 | 并行化：隐藏 hook 延迟 |
| 传统压缩前先 microcompact | 两步走：先减少 Token，再做摘要 |
