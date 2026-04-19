# BashTool 安全分类器深度解析

## 概述

BashTool 是 Claude Code 中最大的单个文件（约 2600 行），实现了七层纵深防御，
23 种危险命令模式，以及推测性预审批机制。

**相关文件：** `tools/bash/`（主要 `bashTool.ts`、`bashClassifier.ts`）

---

## 七层防御体系

```
第 1 层  输入解析与语法检查
第 2 层  命令白名单/黑名单匹配
第 3 层  危险模式正则分类
第 4 层  环境变量过滤
第 5 层  推测性预分类
第 6 层  权限模式检查
第 7 层  执行沙盒（进程隔离）
```

---

## 23 种危险命令模式

```typescript
const DANGER_PATTERNS = [
  // 文件系统破坏
  /\brm\s+-[a-z]*r[a-z]*f/,           // rm -rf
  /\brmdir\b/,                          // rmdir
  /:\s*>\s*\/(?!tmp)/,                  // 重定向到根目录（非 /tmp）

  // 权限提升
  /\bsudo\b/,
  /\bsu\s+-/,
  /\bchmod\s+[0-7]*7[0-7]{2}/,         // chmod 777 类

  // 网络攻击
  /\bnc\s+.*-[a-z]*e/,                  // netcat 执行模式
  /\bcurl\s+.*\|\s*(bash|sh|zsh)/,      // curl | bash（管道执行）
  /\bwget\s+.*-O-\s*\|/,               // wget pipe

  // 进程/系统
  /\bkill\s+-9\s+1\b/,                  // kill init 进程
  /\bshutdown\b/,
  /\breboot\b/,

  // Git 破坏
  /\bgit\s+.*--force\s+.*main\b/,       // force push to main
  /\bgit\s+reset\s+--hard/,

  // 数据库危险操作
  /DROP\s+(?:TABLE|DATABASE)/i,
  /TRUNCATE\s+TABLE/i,

  // 注入载体
  /`[^`]*`/,                            // 反引号命令替换（复杂表达式）
  /\$\([^)]*\)/,                        // $() 命令替换
  /\beval\b/,                           // eval 执行

  // 密钥外泄
  /\benv\b.*\|\s*(curl|wget|nc)/,       // 环境变量发送到网络
  /printenv.*\|\s*(curl|wget)/,

  // 磁盘操作
  /\bdd\s+.*of=\/dev\/[sh]d/,           // dd 写入磁盘设备
  /\bmkfs\b/,                           // 格式化文件系统
]
```

---

## 非对称环境变量过滤（3 层 vs 2 层）

```typescript
// 允许命令（Allow）：2 层过滤
// 第 1 层：移除所有敏感 ENV（AWS_*, ANTHROPIC_API_KEY, etc.）
// 第 2 层：重新注入允许的安全 ENV

// 拒绝命令（Deny）：3 层过滤
// 第 1 层：移除所有 ENV
// 第 2 层：重新注入最小安全集
// 第 3 层：再次验证最终 ENV 集合

// 为什么拒绝命令需要额外一层？
// 拒绝命令是"已知危险"——更严格的过滤是防止
// 攻击者通过环境变量传递额外的攻击载荷
```

### Ant-Only 安全变量

```typescript
// 只有 Anthropic 内部用户（ant）才在受限模式下保留：
const ANT_SAFE_ENV_VARS = [
  'KUBECONFIG',      // Kubernetes 配置（内部运维需要）
  'DOCKER_HOST',     // Docker 远程守护进程（内部 CI/CD）
]

// 外部用户在受限模式下这些变量会被清除
// 防止攻击者通过 KUBECONFIG 等控制基础设施
```

---

## 推测性预审批（Speculative Pre-Approval）

### 工作原理

```typescript
// 在 Claude 生成响应时，后台预测将要执行的命令
// 对这些命令提前运行分类器

// 如果预测准确：
// - 用户看到响应的同时，分类已完成
// - 零额外延迟

// 如果预测错误：
// - 丢弃预分类结果
// - 对实际命令重新分类

// 预测策略：
// - 从响应流中提取命令模式
// - 仅对 ALLOW_LIST 中的命令预审批
// - 危险命令永远不预审批
```

### 分类器结果缓存

```typescript
// 同一命令在同一会话中的分类结果缓存
// 缓存键：命令字符串（去除参数）
// 缓存有效期：整个会话

// 例外：不缓存包含变量展开的命令
// $VAR 可能在不同时间点有不同值
```

---

## 命令超时机制

```typescript
// 默认超时：2 分钟（120 秒）
// 可通过 timeout 参数覆盖（最大 10 分钟）

// 超时行为：
// 1. 发送 SIGTERM 给进程组（-pid，杀死子进程树）
// 2. 等待 5 秒优雅退出
// 3. 如果还在运行：发送 SIGKILL

// 重要：使用进程组信号（-pid）
// 确保子进程（如 npm install 启动的 node）也被杀死
// 防止僵尸进程泄漏
```

---

## bash-safe-write 专项处理

```typescript
// 检测到"大量文件写入"模式时降级到安全写入模式：
// 1. 先写到临时文件
// 2. 验证临时文件内容
// 3. 原子替换（rename）

// 触发条件：
// - 使用重定向（> 或 >>）写入超过特定大小
// - 或写入到已存在的重要文件

// 防止：写到一半崩溃导致文件损坏
```

---

## 反常规设计

| 模式 | 原因 |
|------|------|
| 7 层防御而非单一检查 | 没有单一层能捕获所有危险；层层递进降低漏检概率 |
| 3 层 vs 2 层非对称过滤 | 危险命令需要更严格的 ENV 隔离 |
| ANT 安全变量 | Anthropic 内部需要 KUBECONFIG/DOCKER_HOST 进行运维 |
| 推测预审批 | 隐藏分类延迟；大多数命令是安全的，提前分类无风险 |
| 进程组 SIGTERM | 杀死整个进程树，不留僵尸进程 |
| 分类结果缓存 | 同一命令在对话中反复出现（如 ls、git status） |
| 2600 行单文件 | 安全审查需要所有逻辑在一个地方可见，便于全面审计 |
