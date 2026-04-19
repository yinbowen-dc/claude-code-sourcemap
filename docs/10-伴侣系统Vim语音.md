# Buddy 伴侣系统、Vim 模式与语音功能

## Buddy / 伴侣系统（buddy/）

### 概述

一个功能完整的伴侣/宠物系统，包含程序化生成、稀有度分级、ASCII 动画，
以及季节性时间限定功能。这是整个代码库中最有趣、技术上也最精巧的部分之一。

**相关文件：** `buddy/companion.ts`、`buddy/CompanionSprite.tsx`、`buddy/prompt.ts`、
`buddy/sprites.ts`、`buddy/types.ts`、`buddy/useBuddyNotification.tsx`

### 物种目录

18 种独特物种，每种有 3 帧动画（12×5 字符的 ASCII 画）：

```
duck（鸭）、goose（鹅）、blob（粘团）、cat（猫）、dragon（龙）、
octopus（章鱼）、owl（猫头鹰）、penguin（企鹅）、turtle（龟）、
snail（蜗牛）、ghost（幽灵）、axolotl（六鳃鱼/美西螈）、
capybara（水豚）、cactus（仙人掌）、robot（机器人）、
rabbit（兔）、mushroom（蘑菇）、chonk（胖猫）
```

### 🔥 物种名称混淆（最令人惊讶的发现）

物种名称被**编码为字符码**，以防止与模型代号探测器碰撞：

```typescript
const duck  = c(0x64,0x75,0x63,0x6b) as 'duck'
const goose = c(0x67,0x6f,0x6f,0x73,0x65) as 'goose'
// 等等……
```

**原因：** 源码注释说明：*"一个物种名与 excluded-strings.txt 中的模型代号探测器碰撞。
该检查扫描构建输出（非源码），因此在运行时动态构建该值可以让字面量远离打包文件，
同时让真正的代号探测器仍然有效。"*

这是一个精巧的构建流水线规避方案：安全检查对真实模型代号仍然有效，
只有这个宠物名称在运行时才能"通过"。

### 稀有度系统

```typescript
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }
const RARITY_FLOOR  = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 }
```

属性分布：一个峰值属性（50+ 点），一个弱项，其余按稀有度随机分散。

### 确定性生成

```typescript
const SALT = 'friend-2026-401'  // "401" = 4月1日，编码在 salt 中

roll(userId: string): Roll {
  const key = userId + SALT
  if (rollCache?.key === key) return rollCache.value
  // 使用 FNV 哈希对 userId+SALT 的种子的 Mulberry32 PRNG
  return rollFrom(mulberry32(hashString(key)))
}
```

每个用户始终获得**相同的伴侣**（由 userId 确定性生成）。
"骨骼"（属性）每次读取都重新生成——从不持久化——所以用户不能通过编辑配置伪造稀有度。
只有"灵魂"（名字 + 个性）存储。

### 预告窗口

```typescript
export function isBuddyTeaserWindow(): boolean {
  if ("external" === 'ant') return true  // ANT 构建始终可见
  const d = new Date()
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7
}
// 仅限 2026 年 4 月 1 日至 7 日（使用本地时间，跨时区滚动激活）
```

使用本地时间而非 UTC 会在不同时区创造 24 小时的滚动激活波——
比 UTC 午夜同时激活对服务器更友好。

### CompanionSprite 组件

**待机动画：** 16 帧模式，偶尔扭动，极少数情况眨眼：
```typescript
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]
// -1 = 在第 0 帧眨眼
```

**响应式布局：**
```typescript
if (columns < MIN_COLS_FOR_FULL_SPRITE) {
  // 折叠为单行：表情 + 简短语录，无气泡
}
```

**抚摸动画：** 5 帧爱心喷出，持续 2.5 秒，爱心向上飘动。

**帽子位置：** 仅在帽子槽为空时动态插入，防止 Ink 布局中的行高抖动。

**全屏分割：** 全屏模式下，对话气泡通过 `CompanionFloatingBubble` 单独浮动显示。

### 精灵格式

每个物种：3 帧 × 5 行 × 12 字符。`{E}` 替换为选择的眼睛样式：

```
眼睛样式：·  ✦  ×  ◉  @  °
帽子样式：crown（皇冠）tophat（大礼帽）propeller（螺旋桨）
         halo（光环）wizard（巫师帽）beanie（毛线帽）tinyduck（小鸭帽）
```

---

## Vim 模式（vim/）

### 概述

一个正确的、精简的 Vim 快捷键实现（不是完整的 Vim）。基于状态机，
通过 TypeScript 可辨识联合类型实现完全类型安全。

**相关文件：** `vim/motions.ts`、`vim/operators.ts`、`vim/textObjects.ts`、
`vim/transitions.ts`、`vim/types.ts`

### 状态机

```typescript
type CommandState =
  | { type: 'idle' }                    // 空闲
  | { type: 'count'; digits: string }   // 输入数字前缀
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
```

TypeScript 的穷举检查确保 `transition()` 函数处理所有情况。

### 已实现的移动命令

```
hjkl         基本移动
gj/gk        可视行（显示行）vs 逻辑行
w/b/e        单词移动（Vim 单词字符）
W/B/E        WORD 移动（非空白字符）
0/^/$        行首/第一个非空字符/行尾
G/gg         文件末尾/开头
f/F/t/T      查找字符（; 和 , 重复）
```

### 操作符

```
d（删除）   支持：移动命令、文本对象、查找、dd/D
c（修改）   支持：移动命令、文本对象、查找、cc/C
y（复制）   支持：移动命令、文本对象、查找、yy/Y
```

特殊命令：`x`、`~`（切换大小写）、`J`（合并行）、`>/<`（缩进）、`.`（重复）

### 文本对象

```
iw/aw   内部/整个单词
i"/a"   双引号内/包含引号
i(/a(   圆括号内/包含括号
i[/a[   方括号内/包含方括号
i{/a{   花括号内/包含花括号
i</a<   尖括号内/包含尖括号
i'/a'   单引号内/包含引号
i`/a`   反引号内/包含反引号
```

括号匹配使用**深度追踪**处理嵌套结构。

### 特殊：`cw` 的非标准行为

```typescript
// cw 带数字前缀时：向前移动 (count-1) 个单词，然后找到该单词的末尾
// 这与标准 Vim 行为不同，但是有意为之，提供更好的用户体验
if (op === 'change' && (motion === 'w' || motion === 'W')) {
  // ...有意偏离 Vim 标准
}
```

### 按行/包含式移动分类

```typescript
isInclusiveMotion(key): 'eE$'.includes(key)  // 包含目标位置的字符
isLinewiseMotion(key): 'jkG'.includes(key) || key === 'gg'  // 整行操作
```

---

## 语音模式（voice/）

### 激活条件

双重开关：

```typescript
isVoiceModeEnabled():
  hasVoiceAuth() && isVoiceGrowthBookEnabled()

hasVoiceAuth():
  isAnthropicAuthEnabled()              // 必须使用 Anthropic OAuth
  && getClaudeAIOAuthTokens()?.accessToken  // 必须有有效 Token

isVoiceGrowthBookEnabled():
  feature('VOICE_MODE')
  && !getFeatureValue_CACHED('tengu_amber_quartz_disabled', false)
```

kill-switch 名称 `tengu_amber_quartz_disabled` — 紧急关闭用的 GrowthBook 标志。

---

## 反常规设计

| 模式 | 原因 |
|------|------|
| 物种名称用字符码编码 | 绕过构建流水线对模型代号的探测 |
| SALT 常量 `'friend-2026-401'` | 4月1日（愚人节）编码在 salt 中 |
| 骨骼不持久化（每次重新生成） | 防止通过编辑配置伪造稀有度 |
| 使用本地时间设定预告窗口 | 跨时区滚动激活波，比 UTC 同步激活对服务器更友好 |
| 帽子槽动态插入 | 防止 Ink 布局中的行高抖动 |
| `cw` 非标准行为 | 有意改善用户体验，偏离 Vim 标准 |
| 可辨识联合类型的状态机 | TypeScript 穷举检查捕获所有状态转换 |
| 语音 kill-switch 命名 `tengu_amber_quartz_disabled` | 整个代码库中基于代号命名的 GrowthBook 标志 |
