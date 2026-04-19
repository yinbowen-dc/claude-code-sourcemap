# Claude Code 源码分析

对 Claude Code（v2.1.88）源代码的深度分析。源码从 `claude-code-2.1.88.tgz` 中提取，
位于 `restored-src/src/`（1884 个 TypeScript/TSX 文件，53 个模块）。

## 文档目录

| 文件 | 内容 |
|------|------|
| [01-架构总览.md](01-架构总览.md) | 模块地图、入口点、核心架构模式 |
| [02-集群多智能体.md](02-集群多智能体.md) | Swarm 多 Agent 系统、后端（tmux/iTerm2/进程内）、权限同步 |
| [03-桥接远程通信.md](03-桥接远程通信.md) | Bridge 远程控制基础设施、传输层、JWT、workSecret |
| [04-工具与权限.md](04-工具与权限.md) | 工具目录、权限模式、绕过机制、工具池 |
| [05-查询引擎与上下文.md](05-查询引擎与上下文.md) | QueryEngine、查询循环、上下文组装、历史记录、截断 |
| [06-遥测与隐私.md](06-遥测与隐私.md) | 遥测层级、BigQuery、卧底模式、Perfetto 追踪 |
| [07-认证与安全.md](07-认证与安全.md) | OAuth、API 密钥、trustedDevice、xaaIdp、安全发现 |
| [08-费用与Token管理.md](08-费用与Token管理.md) | 费用追踪、Token 预算、思考模式、effort 命令、compact |
| [09-技能插件MCP.md](09-技能插件MCP.md) | 技能（5种类型）、插件、MCP 集成、建议排名算法 |
| [10-伴侣系统Vim语音.md](10-伴侣系统Vim语音.md) | Buddy 精灵伴侣系统、Vim 模式、语音功能开关 |
| [11-远程传送工作树协调器.md](11-远程传送工作树协调器.md) | Teleport 远程会话、gitBundle、worktree 隔离、Coordinator |
| [12-奇特发现.md](12-奇特发现.md) | 跨模块奇特模式、隐藏功能、反常规设计 |
| [13-记忆管理系统.md](13-记忆管理系统.md) | memdir 四层记忆、Sonnet 语义检索、teamMemorySync 密钥扫描 |
| [14-AI自动化服务.md](14-AI自动化服务.md) | autoDream 三重门控、MagicDocs 自动维护、推测性预填充 |
| [15-模型迁移历史与启动状态.md](15-模型迁移历史与启动状态.md) | 模型命名演化、257 字段启动状态、native-ts 三模块、moreright 存根 |
| [16-分析系统与远程设置.md](16-分析系统与远程设置.md) | Datadog/FirstParty 双汇聚、GrowthBook A/B、remoteManagedSettings |
| [17-BashTool安全分类器.md](17-BashTool安全分类器.md) | 七层防御、23 危险模式、非对称 ENV 过滤、推测性预审批 |
| [18-远程会话与工具编排.md](18-远程会话与工具编排.md) | RemoteSessionManager、4001 状态码、StreamingToolExecutor 分区执行 |
| [19-压缩系统深度解析.md](19-压缩系统深度解析.md) | 三层压缩、断路器（250K/天节省）、TTL 对齐、NO_TOOLS_PREAMBLE |
| [20-其他服务.md](20-其他服务.md) | Tips A/B 测试、WSL2 语音、VCR UUID 脱水、AgentSummary 悖论 |

## 研究进度

### ✅ 第一轮（已完成）
- Swarm 多 Agent 后端
- Bridge 传输层
- 工具与权限系统
- 查询引擎与上下文管道
- 遥测与隐私
- 认证与安全
- 费用/Token 管理
- 技能/插件/MCP
- Buddy 伴侣系统
- Vim 模式
- Teleport / Worktree / Coordinator

### ✅ 第二轮（已完成）
- `memdir/` — 记忆管理系统（四层记忆、Sonnet 检索、密钥扫描）
- `native-ts/` — 原生 TypeScript 模块（color-diff、file-index、yoga-layout）
- `outputStyles/` — 输出样式系统（explanatory/learning/TODO(human)）
- `moreright/` — 存根模块（公开版本）
- `bootstrap/state.ts` — 257 字段启动状态快照
- `screens/REPL.tsx` — 40+ useState 核心交互循环
- `remote/` — 远程会话管理与 WebSocket 协议
- `services/compact/` — 三层压缩 + 断路器 + TTL 对齐
- `migrations/` — 模型命名演化历史（Fennec→Sonnet46）
- `services/analytics/` — Datadog/GrowthBook/1P 双汇聚分析系统
- `services/remoteManagedSettings/` — 组织远程配置管理
- `tools/bash/` — 七层防御安全分类器
- `services/autoDream/` — 三重门控记忆整合
- `services/MagicDocs/` — 自动文档维护
- `services/PromptSuggestion/` — 推测性预填充（CoW 沙盒）
- `services/voice.ts` — WSL2 PulseAudio 桥接语音 STT
- `services/vcr.ts` — 确定性 UUID 脱水/水合录制回放
- `services/AgentSummary/` — 含工具但拒绝调用的摘要服务
- `services/preventSleep.ts` — caffeinate 5min+4min 自愈防休眠

### 📋 TODO（第三轮）
- [ ] 深挖：`cli/handlers/autoMode.ts` — 完整自动模式处理器
- [ ] 深挖：完整追踪 "ultraplan" 流程（从用户输入到模型调用）
- [ ] 深挖：`AgentTool` 子 Agent 生成全流程（spawn、IPC、结果收集）
- [ ] 深挖：`QueryEngine` 响应式压缩路径（reactive compaction 完整流程）
- [ ] 分析：`cli/` 入口点与命令行参数解析
- [ ] 分析：`hooks/` 系统（用户自定义 hooks 的执行机制）
- [ ] 分析：`config/` 配置系统（优先级、合并策略）
- [ ] 分析：`utils/` 工具函数库（有哪些非显而易见的工具）
- [ ] 整理：所有已发现的 GrowthBook 特性标志完整清单（补充 12-奇特发现.md）
- [ ] 专题：找出更多"今天（2026-04-01）"被激活的愚人节功能
