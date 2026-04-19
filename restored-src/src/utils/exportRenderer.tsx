/**
 * 对话导出渲染模块（exportRenderer.tsx）
 *
 * 【系统流程位置】
 * 本模块是 Claude Code 对话导出功能的核心渲染引擎，
 * 位于 UI 渲染层（Ink/React）与文件输出层之间。
 * 当用户执行 `[`（转储到滚动缓冲区）或 `v`（保存到文件）时由导出命令调用。
 *
 * 【主要功能】
 * 1. StaticKeybindingProvider：无头（headless）渲染用的静态键绑定提供者，
 *    避免 ChordInterceptor 因无 stdin 而挂起
 * 2. normalizedUpperBound()：估算单条消息展开后的最大 NormalizedMessage 数量
 * 3. streamRenderedMessages()：分块流式渲染消息列表，保留 ANSI 颜色码
 * 4. renderMessagesToPlainText()：将消息列表渲染为纯文本字符串（剥离 ANSI）
 *
 * 【性能设计】
 * - 分块渲染（默认每块 40 条）：避免将整个会话一次性加载进 yoga 布局树
 *   实测（2026 年 3 月，538 条消息会话）：相比单次全量渲染节省约 55% 内存峰值
 * - 工具调用分组在分块边界处保持正确：Messages.renderRange 在折叠后的数组上切片
 * - buildMessageLookups 在全量规范化数组上运行，确保 tool_use↔tool_result 跨块正确配对
 */
import React, { useRef } from 'react';
import stripAnsi from 'strip-ansi';
import { Messages } from '../components/Messages.js';
import { KeybindingProvider } from '../keybindings/KeybindingContext.js';
import { loadKeybindingsSyncWithWarnings } from '../keybindings/loadUserBindings.js';
import type { KeybindingContextName } from '../keybindings/types.js';
import { AppStateProvider } from '../state/AppState.js';
import type { Tools } from '../Tool.js';
import type { Message } from '../types/message.js';
import { renderToAnsiString } from './staticRender.js';

/**
 * 用于静态/无头渲染的最小键绑定提供者组件。
 *
 * 【设计原因】
 * 正常的 KeybindingProvider 内部包含 ChordInterceptor，
 * 后者调用 useInput 监听键盘输入。在无 stdin 的无头渲染环境中，
 * useInput 会无限等待输入而导致渲染挂起。
 *
 * 本组件提供与完整 KeybindingProvider 完全相同的 Context 接口，
 * 但跳过了 ChordInterceptor，使静态渲染可以正常完成。
 *
 * 【流程】
 * 1. 同步加载用户键绑定配置（带警告但不抛出）
 * 2. 创建各种空引用（pendingChordRef、handlerRegistryRef）
 * 3. 创建空的 activeContexts Set
 * 4. 将所有回调设为空操作（no-op），渲染期间不需要响应键盘事件
 */
function StaticKeybindingProvider({
  children
}: {
  children: React.ReactNode;
}): React.ReactNode {
  // 同步加载键绑定配置（静态渲染不需要动态更新）
  const {
    bindings
  } = loadKeybindingsSyncWithWarnings();
  // 创建空的 pending chord 引用（无头渲染中不会发生组合键）
  const pendingChordRef = useRef(null);
  // 创建空的 handler registry（无头渲染中不注册任何键处理器）
  const handlerRegistryRef = useRef(new Map());
  // 创建空的 active contexts Set（无头渲染中无需上下文管理）
  const activeContexts = useRef(new Set<KeybindingContextName>()).current;
  // 渲染 KeybindingProvider，但所有回调都设为空操作
  return <KeybindingProvider bindings={bindings} pendingChordRef={pendingChordRef} pendingChord={null} setPendingChord={() => {}} activeContexts={activeContexts} registerActiveContext={() => {}} unregisterActiveContext={() => {}} handlerRegistryRef={handlerRegistryRef}>
      {children}
    </KeybindingProvider>;
}

/**
 * 估算单条消息规范化展开后的最大 NormalizedMessage 数量。
 *
 * 【背景】
 * normalizeMessages() 会将一条含 N 个内容块的 Message 展开为 N 条 NormalizedMessage。
 * 本函数用于在不实际执行规范化的情况下，估算展开上限，
 * 从而为分块渲染的上界（ceiling）计算提供输入。
 *
 * 【规则】
 * - 无 .message 属性（如 AttachmentMessage）：规范化后 ≤1 条，返回 1
 * - content 是数组：最多展开为数组长度条
 * - content 是字符串：固定 1 条
 *
 * @param m - 待估算的消息对象
 * @returns  规范化后的最大条数估算值
 */
function normalizedUpperBound(m: Message): number {
  // 无 message 属性（如附件类消息）：规范化后至多 1 条
  if (!('message' in m)) return 1;
  const c = m.message.content;
  // 数组内容：条数等于内容块数量；字符串内容：固定 1 条
  return Array.isArray(c) ? c.length : 1;
}

/**
 * 分块流式渲染消息列表，ANSI 颜色码保留，通过 sink 回调逐块输出。
 *
 * 【核心设计】
 * 每块使用独立的 renderToAnsiString 调用，yoga 布局树和 Ink 屏幕缓冲区
 * 只需适配最高的那块，而不是整个会话高度。
 * 实测（2026 年 3 月，538 条消息）：比单次全量渲染节省约 55% 内存峰值。
 *
 * 【输出控制】
 * sink 回调拥有输出控制权：
 * - `[` 命令（转储到滚动缓冲区）→ 写入 stdout
 * - `v` 命令（保存到文件）→ appendFile
 *
 * 【分块边界的正确性保证】
 * - Messages.renderRange 在规范化→分组→折叠后的数组上切片，
 *   确保工具调用分组在分块边界处保持正确
 * - buildMessageLookups 在全量规范化数组上运行，
 *   确保 tool_use↔tool_result 配对无论落在哪块都能正确解析
 *
 * 【循环终止条件】
 * - ceiling = chunkSize + 所有消息的规范化上限之和
 * - 实际折叠后的数组只会更短，确保循环一定到达空切片后中止
 *
 * @param messages    - 完整消息列表
 * @param tools       - 工具定义列表（用于渲染工具调用结果）
 * @param sink        - 每块 ANSI 字符串的输出回调（可以是 stdout/文件）
 * @param columns     - 终端宽度（影响换行）
 * @param verbose     - 是否输出详细信息
 * @param chunkSize   - 每块渲染的 NormalizedMessage 数量，默认 40
 * @param onProgress  - 进度回调，参数为已渲染的消息数
 */
export async function streamRenderedMessages(messages: Message[], tools: Tools, sink: (ansiChunk: string) => void | Promise<void>, {
  columns,
  verbose = false,
  chunkSize = 40,    // 默认每块渲染 40 条规范化消息
  onProgress
}: {
  columns?: number;
  verbose?: boolean;
  chunkSize?: number;
  onProgress?: (rendered: number) => void;
} = {}): Promise<void> {
  // 定义单块渲染函数：将 [offset, offset+chunkSize) 范围内的消息渲染为 ANSI 字符串
  const renderChunk = (range: readonly [number, number]) => renderToAnsiString(<AppStateProvider>
        <StaticKeybindingProvider>
          <Messages messages={messages} tools={tools} commands={[]} verbose={verbose} toolJSX={null} toolUseConfirmQueue={[]} inProgressToolUseIDs={new Set()} isMessageSelectorVisible={false} conversationId="export" screen="prompt" streamingToolUses={[]} showAllInTranscript={true} isLoading={false} renderRange={range} />
        </StaticKeybindingProvider>
      </AppStateProvider>, columns);

  // 计算循环上界（ceiling）：
  // renderRange 索引到折叠后的数组，但我们不知道其确切长度。
  // normalize 将每条 Message 拆分为 1～N 条 NormalizedMessage（N 为内容块数），
  // collapse 再将部分合并回去（只会减少，不会增加）。
  // 以"所有消息规范化上限之和 + chunkSize"作为上界，
  // 确保循环一定能到达空切片（collapse 只缩小，不会超出此上界）。
  let ceiling = chunkSize
  for (const m of messages) ceiling += normalizedUpperBound(m)

  // 分块渲染主循环：以 chunkSize 为步长遍历所有可能的偏移量
  for (let offset = 0; offset < ceiling; offset += chunkSize) {
    // 渲染当前块
    const ansi = await renderChunk([offset, offset + chunkSize]);
    // 若当前块剥离 ANSI 后为空字符串，说明已到达消息末尾，退出循环
    if (stripAnsi(ansi).trim() === '') break;
    // 将当前块输出到 sink（stdout 或文件）
    await sink(ansi);
    // 通知调用方进度
    onProgress?.(offset + chunkSize);
  }
}

/**
 * 将消息列表渲染为适合导出的纯文本字符串（剥离所有 ANSI 颜色码）。
 *
 * 【流程】
 * 1. 创建字符串数组 parts 作为收集容器
 * 2. 调用 streamRenderedMessages，在 sink 中剥离 ANSI 并追加到 parts
 * 3. 将所有块拼接为完整字符串后返回
 *
 * 与交互式 UI 使用完全相同的 React 渲染逻辑，
 * 保证导出内容与屏幕显示的格式一致（去除颜色后）。
 *
 * @param messages - 完整消息列表
 * @param tools    - 工具定义列表
 * @param columns  - 终端宽度（影响换行宽度，进而影响导出文本格式）
 * @returns        纯文本字符串，适合写入文件或打印到无颜色终端
 */
export async function renderMessagesToPlainText(messages: Message[], tools: Tools = [], columns?: number): Promise<string> {
  // 收集各块剥离 ANSI 后的纯文本
  const parts: string[] = [];
  await streamRenderedMessages(messages, tools, chunk => void parts.push(stripAnsi(chunk)), {
    columns
  });
  // 将所有块拼接为完整的导出文本
  return parts.join('');
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZVJlZiIsInN0cmlwQW5zaSIsIk1lc3NhZ2VzIiwiS2V5YmluZGluZ1Byb3ZpZGVyIiwibG9hZEtleWJpbmRpbmdzU3luY1dpdGhXYXJuaW5ncyIsIktleWJpbmRpbmdDb250ZXh0TmFtZSIsIkFwcFN0YXRlUHJvdmlkZXIiLCJUb29scyIsIk1lc3NhZ2UiLCJyZW5kZXJUb0Fuc2lTdHJpbmciLCJTdGF0aWNLZXliaW5kaW5nUHJvdmlkZXIiLCJjaGlsZHJlbiIsIlJlYWN0Tm9kZSIsImJpbmRpbmdzIiwicGVuZGluZ0Nob3JkUmVmIiwiaGFuZGxlclJlZ2lzdHJ5UmVmIiwiTWFwIiwiYWN0aXZlQ29udGV4dHMiLCJTZXQiLCJjdXJyZW50Iiwibm9ybWFsaXplZFVwcGVyQm91bmQiLCJtIiwiYyIsIm1lc3NhZ2UiLCJjb250ZW50IiwiQXJyYXkiLCJpc0FycmF5IiwibGVuZ3RoIiwic3RyZWFtUmVuZGVyZWRNZXNzYWdlcyIsIm1lc3NhZ2VzIiwidG9vbHMiLCJzaW5rIiwiYW5zaUNodW5rIiwiUHJvbWlzZSIsImNvbHVtbnMiLCJ2ZXJib3NlIiwiY2h1bmtTaXplIiwib25Qcm9ncmVzcyIsInJlbmRlcmVkIiwicmVuZGVyQ2h1bmsiLCJyYW5nZSIsImNlaWxpbmciLCJvZmZzZXQiLCJhbnNpIiwidHJpbSIsInJlbmRlck1lc3NhZ2VzVG9QbGFpblRleHQiLCJwYXJ0cyIsImNodW5rIiwicHVzaCIsImpvaW4iXSwic291cmNlcyI6WyJleHBvcnRSZW5kZXJlci50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZVJlZiB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHN0cmlwQW5zaSBmcm9tICdzdHJpcC1hbnNpJ1xuaW1wb3J0IHsgTWVzc2FnZXMgfSBmcm9tICcuLi9jb21wb25lbnRzL01lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgS2V5YmluZGluZ1Byb3ZpZGVyIH0gZnJvbSAnLi4va2V5YmluZGluZ3MvS2V5YmluZGluZ0NvbnRleHQuanMnXG5pbXBvcnQgeyBsb2FkS2V5YmluZGluZ3NTeW5jV2l0aFdhcm5pbmdzIH0gZnJvbSAnLi4va2V5YmluZGluZ3MvbG9hZFVzZXJCaW5kaW5ncy5qcydcbmltcG9ydCB0eXBlIHsgS2V5YmluZGluZ0NvbnRleHROYW1lIH0gZnJvbSAnLi4va2V5YmluZGluZ3MvdHlwZXMuanMnXG5pbXBvcnQgeyBBcHBTdGF0ZVByb3ZpZGVyIH0gZnJvbSAnLi4vc3RhdGUvQXBwU3RhdGUuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xzIH0gZnJvbSAnLi4vVG9vbC5qcydcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSB9IGZyb20gJy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgeyByZW5kZXJUb0Fuc2lTdHJpbmcgfSBmcm9tICcuL3N0YXRpY1JlbmRlci5qcydcblxuLyoqXG4gKiBNaW5pbWFsIGtleWJpbmRpbmcgcHJvdmlkZXIgZm9yIHN0YXRpYy9oZWFkbGVzcyByZW5kZXJzLlxuICogUHJvdmlkZXMga2V5YmluZGluZyBjb250ZXh0IHdpdGhvdXQgdGhlIENob3JkSW50ZXJjZXB0b3IgKHdoaWNoIHVzZXMgdXNlSW5wdXRcbiAqIGFuZCB3b3VsZCBoYW5nIGluIGhlYWRsZXNzIHJlbmRlcnMgd2l0aCBubyBzdGRpbikuXG4gKi9cbmZ1bmN0aW9uIFN0YXRpY0tleWJpbmRpbmdQcm92aWRlcih7XG4gIGNoaWxkcmVuLFxufToge1xuICBjaGlsZHJlbjogUmVhY3QuUmVhY3ROb2RlXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBiaW5kaW5ncyB9ID0gbG9hZEtleWJpbmRpbmdzU3luY1dpdGhXYXJuaW5ncygpXG4gIGNvbnN0IHBlbmRpbmdDaG9yZFJlZiA9IHVzZVJlZihudWxsKVxuICBjb25zdCBoYW5kbGVyUmVnaXN0cnlSZWYgPSB1c2VSZWYobmV3IE1hcCgpKVxuICBjb25zdCBhY3RpdmVDb250ZXh0cyA9IHVzZVJlZihuZXcgU2V0PEtleWJpbmRpbmdDb250ZXh0TmFtZT4oKSkuY3VycmVudFxuXG4gIHJldHVybiAoXG4gICAgPEtleWJpbmRpbmdQcm92aWRlclxuICAgICAgYmluZGluZ3M9e2JpbmRpbmdzfVxuICAgICAgcGVuZGluZ0Nob3JkUmVmPXtwZW5kaW5nQ2hvcmRSZWZ9XG4gICAgICBwZW5kaW5nQ2hvcmQ9e251bGx9XG4gICAgICBzZXRQZW5kaW5nQ2hvcmQ9eygpID0+IHt9fVxuICAgICAgYWN0aXZlQ29udGV4dHM9e2FjdGl2ZUNvbnRleHRzfVxuICAgICAgcmVnaXN0ZXJBY3RpdmVDb250ZXh0PXsoKSA9PiB7fX1cbiAgICAgIHVucmVnaXN0ZXJBY3RpdmVDb250ZXh0PXsoKSA9PiB7fX1cbiAgICAgIGhhbmRsZXJSZWdpc3RyeVJlZj17aGFuZGxlclJlZ2lzdHJ5UmVmfVxuICAgID5cbiAgICAgIHtjaGlsZHJlbn1cbiAgICA8L0tleWJpbmRpbmdQcm92aWRlcj5cbiAgKVxufVxuXG4vLyBVcHBlci1ib3VuZCBob3cgbWFueSBOb3JtYWxpemVkTWVzc2FnZXMgYSBNZXNzYWdlIGNhbiBwcm9kdWNlLlxuLy8gbm9ybWFsaXplTWVzc2FnZXMgc3BsaXRzIG9uZSBNZXNzYWdlIHdpdGggTiBjb250ZW50IGJsb2NrcyBpbnRvIE5cbi8vIE5vcm1hbGl6ZWRNZXNzYWdlcyDigJQgMToxIHdpdGggYmxvY2sgY291bnQuIFN0cmluZyBjb250ZW50ID0gMSBibG9jay5cbi8vIEF0dGFjaG1lbnRNZXNzYWdlIGV0Yy4gaGF2ZSBubyAubWVzc2FnZSBhbmQgbm9ybWFsaXplIHRvIOKJpDEuXG5mdW5jdGlvbiBub3JtYWxpemVkVXBwZXJCb3VuZChtOiBNZXNzYWdlKTogbnVtYmVyIHtcbiAgaWYgKCEoJ21lc3NhZ2UnIGluIG0pKSByZXR1cm4gMVxuICBjb25zdCBjID0gbS5tZXNzYWdlLmNvbnRlbnRcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkoYykgPyBjLmxlbmd0aCA6IDFcbn1cblxuLyoqXG4gKiBTdHJlYW1zIHJlbmRlcmVkIG1lc3NhZ2VzIGluIGNodW5rcywgQU5TSSBjb2RlcyBwcmVzZXJ2ZWQuIEVhY2ggY2h1bmsgaXMgYVxuICogZnJlc2ggcmVuZGVyVG9BbnNpU3RyaW5nIOKAlCB5b2dhIGxheW91dCB0cmVlICsgSW5rJ3Mgc2NyZWVuIGJ1ZmZlciBhcmUgc2l6ZWRcbiAqIHRvIHRoZSB0YWxsZXN0IENIVU5LIGluc3RlYWQgb2YgdGhlIGZ1bGwgc2Vzc2lvbi4gTWVhc3VyZWQgKE1hciAyMDI2LFxuICogNTM4LW1zZyBzZXNzaW9uKTog4oiSNTUlIHBsYXRlYXUgUlNTIHZzIGEgc2luZ2xlIGZ1bGwgcmVuZGVyLiBUaGUgc2luayBvd25zXG4gKiB0aGUgb3V0cHV0IOKAlCB3cml0ZSB0byBzdGRvdXQgZm9yIGBbYCBkdW1wLXRvLXNjcm9sbGJhY2ssIGFwcGVuZEZpbGUgZm9yIGB2YC5cbiAqXG4gKiBNZXNzYWdlcy5yZW5kZXJSYW5nZSBzbGljZXMgQUZURVIgbm9ybWFsaXpl4oaSZ3JvdXDihpJjb2xsYXBzZSwgc28gdG9vbC1jYWxsXG4gKiBncm91cGluZyBzdGF5cyBjb3JyZWN0IGFjcm9zcyBjaHVuayBzZWFtczsgYnVpbGRNZXNzYWdlTG9va3VwcyBydW5zIG9uXG4gKiB0aGUgZnVsbCBub3JtYWxpemVkIGFycmF5IHNvIHRvb2xfdXNl4oaUdG9vbF9yZXN1bHQgcmVzb2x2ZXMgcmVnYXJkbGVzcyBvZlxuICogd2hpY2ggY2h1bmsgZWFjaCBsYW5kZWQgaW4uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdHJlYW1SZW5kZXJlZE1lc3NhZ2VzKFxuICBtZXNzYWdlczogTWVzc2FnZVtdLFxuICB0b29sczogVG9vbHMsXG4gIHNpbms6IChhbnNpQ2h1bms6IHN0cmluZykgPT4gdm9pZCB8IFByb21pc2U8dm9pZD4sXG4gIHtcbiAgICBjb2x1bW5zLFxuICAgIHZlcmJvc2UgPSBmYWxzZSxcbiAgICBjaHVua1NpemUgPSA0MCxcbiAgICBvblByb2dyZXNzLFxuICB9OiB7XG4gICAgY29sdW1ucz86IG51bWJlclxuICAgIHZlcmJvc2U/OiBib29sZWFuXG4gICAgY2h1bmtTaXplPzogbnVtYmVyXG4gICAgb25Qcm9ncmVzcz86IChyZW5kZXJlZDogbnVtYmVyKSA9PiB2b2lkXG4gIH0gPSB7fSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZW5kZXJDaHVuayA9IChyYW5nZTogcmVhZG9ubHkgW251bWJlciwgbnVtYmVyXSkgPT5cbiAgICByZW5kZXJUb0Fuc2lTdHJpbmcoXG4gICAgICA8QXBwU3RhdGVQcm92aWRlcj5cbiAgICAgICAgPFN0YXRpY0tleWJpbmRpbmdQcm92aWRlcj5cbiAgICAgICAgICA8TWVzc2FnZXNcbiAgICAgICAgICAgIG1lc3NhZ2VzPXttZXNzYWdlc31cbiAgICAgICAgICAgIHRvb2xzPXt0b29sc31cbiAgICAgICAgICAgIGNvbW1hbmRzPXtbXX1cbiAgICAgICAgICAgIHZlcmJvc2U9e3ZlcmJvc2V9XG4gICAgICAgICAgICB0b29sSlNYPXtudWxsfVxuICAgICAgICAgICAgdG9vbFVzZUNvbmZpcm1RdWV1ZT17W119XG4gICAgICAgICAgICBpblByb2dyZXNzVG9vbFVzZUlEcz17bmV3IFNldCgpfVxuICAgICAgICAgICAgaXNNZXNzYWdlU2VsZWN0b3JWaXNpYmxlPXtmYWxzZX1cbiAgICAgICAgICAgIGNvbnZlcnNhdGlvbklkPVwiZXhwb3J0XCJcbiAgICAgICAgICAgIHNjcmVlbj1cInByb21wdFwiXG4gICAgICAgICAgICBzdHJlYW1pbmdUb29sVXNlcz17W119XG4gICAgICAgICAgICBzaG93QWxsSW5UcmFuc2NyaXB0PXt0cnVlfVxuICAgICAgICAgICAgaXNMb2FkaW5nPXtmYWxzZX1cbiAgICAgICAgICAgIHJlbmRlclJhbmdlPXtyYW5nZX1cbiAgICAgICAgICAvPlxuICAgICAgICA8L1N0YXRpY0tleWJpbmRpbmdQcm92aWRlcj5cbiAgICAgIDwvQXBwU3RhdGVQcm92aWRlcj4sXG4gICAgICBjb2x1bW5zLFxuICAgIClcblxuICAvLyByZW5kZXJSYW5nZSBpbmRleGVzIGludG8gdGhlIHBvc3QtY29sbGFwc2UgYXJyYXkgd2hvc2UgbGVuZ3RoIHdlIGNhbid0XG4gIC8vIHNlZSBmcm9tIGhlcmUg4oCUIG5vcm1hbGl6ZSBzcGxpdHMgZWFjaCBNZXNzYWdlIGludG8gb25lIE5vcm1hbGl6ZWRNZXNzYWdlXG4gIC8vIHBlciBjb250ZW50IGJsb2NrICh1bmJvdW5kZWQgcGVyIG1lc3NhZ2UpLCBjb2xsYXBzZSBtZXJnZXMgc29tZSBiYWNrLlxuICAvLyBDZWlsaW5nIGlzIHRoZSBleGFjdCBub3JtYWxpemUgb3V0cHV0IGNvdW50ICsgY2h1bmtTaXplIHNvIHRoZSBsb29wXG4gIC8vIGFsd2F5cyByZWFjaGVzIHRoZSBlbXB0eSBzbGljZSB3aGVyZSBicmVhayBmaXJlcyAoY29sbGFwc2Ugb25seSBzaHJpbmtzKS5cbiAgbGV0IGNlaWxpbmcgPSBjaHVua1NpemVcbiAgZm9yIChjb25zdCBtIG9mIG1lc3NhZ2VzKSBjZWlsaW5nICs9IG5vcm1hbGl6ZWRVcHBlckJvdW5kKG0pXG4gIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGNlaWxpbmc7IG9mZnNldCArPSBjaHVua1NpemUpIHtcbiAgICBjb25zdCBhbnNpID0gYXdhaXQgcmVuZGVyQ2h1bmsoW29mZnNldCwgb2Zmc2V0ICsgY2h1bmtTaXplXSlcbiAgICBpZiAoc3RyaXBBbnNpKGFuc2kpLnRyaW0oKSA9PT0gJycpIGJyZWFrXG4gICAgYXdhaXQgc2luayhhbnNpKVxuICAgIG9uUHJvZ3Jlc3M/LihvZmZzZXQgKyBjaHVua1NpemUpXG4gIH1cbn1cblxuLyoqXG4gKiBSZW5kZXJzIG1lc3NhZ2VzIHRvIGEgcGxhaW4gdGV4dCBzdHJpbmcgc3VpdGFibGUgZm9yIGV4cG9ydC5cbiAqIFVzZXMgdGhlIHNhbWUgUmVhY3QgcmVuZGVyaW5nIGxvZ2ljIGFzIHRoZSBpbnRlcmFjdGl2ZSBVSS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlck1lc3NhZ2VzVG9QbGFpblRleHQoXG4gIG1lc3NhZ2VzOiBNZXNzYWdlW10sXG4gIHRvb2xzOiBUb29scyA9IFtdLFxuICBjb2x1bW5zPzogbnVtYmVyLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW11cbiAgYXdhaXQgc3RyZWFtUmVuZGVyZWRNZXNzYWdlcyhcbiAgICBtZXNzYWdlcyxcbiAgICB0b29scyxcbiAgICBjaHVuayA9PiB2b2lkIHBhcnRzLnB1c2goc3RyaXBBbnNpKGNodW5rKSksXG4gICAgeyBjb2x1bW5zIH0sXG4gIClcbiAgcmV0dXJuIHBhcnRzLmpvaW4oJycpXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLE9BQU9BLEtBQUssSUFBSUMsTUFBTSxRQUFRLE9BQU87QUFDckMsT0FBT0MsU0FBUyxNQUFNLFlBQVk7QUFDbEMsU0FBU0MsUUFBUSxRQUFRLDJCQUEyQjtBQUNwRCxTQUFTQyxrQkFBa0IsUUFBUSxxQ0FBcUM7QUFDeEUsU0FBU0MsK0JBQStCLFFBQVEsb0NBQW9DO0FBQ3BGLGNBQWNDLHFCQUFxQixRQUFRLHlCQUF5QjtBQUNwRSxTQUFTQyxnQkFBZ0IsUUFBUSxzQkFBc0I7QUFDdkQsY0FBY0MsS0FBSyxRQUFRLFlBQVk7QUFDdkMsY0FBY0MsT0FBTyxRQUFRLHFCQUFxQjtBQUNsRCxTQUFTQyxrQkFBa0IsUUFBUSxtQkFBbUI7O0FBRXREO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTQyx3QkFBd0JBLENBQUM7RUFDaENDO0FBR0YsQ0FGQyxFQUFFO0VBQ0RBLFFBQVEsRUFBRVosS0FBSyxDQUFDYSxTQUFTO0FBQzNCLENBQUMsQ0FBQyxFQUFFYixLQUFLLENBQUNhLFNBQVMsQ0FBQztFQUNsQixNQUFNO0lBQUVDO0VBQVMsQ0FBQyxHQUFHVCwrQkFBK0IsQ0FBQyxDQUFDO0VBQ3RELE1BQU1VLGVBQWUsR0FBR2QsTUFBTSxDQUFDLElBQUksQ0FBQztFQUNwQyxNQUFNZSxrQkFBa0IsR0FBR2YsTUFBTSxDQUFDLElBQUlnQixHQUFHLENBQUMsQ0FBQyxDQUFDO0VBQzVDLE1BQU1DLGNB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
