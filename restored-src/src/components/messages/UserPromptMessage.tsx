/**
 * UserPromptMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层的核心组件，由 UserTextMessage 路由到此（默认情形）。
 * 负责渲染用户输入的普通提示文本，是用户消息中最常见的渲染路径。
 *
 * 【主要功能】
 * 1. 支持 Kairos/Brief 紧凑布局模式（由 KAIROS / KAIROS_BRIEF 编译时特性标志控制）：
 *    - 读取 AppState 中的 isBriefOnly 和 viewingAgentTaskId
 *    - 结合环境变量 CLAUDE_CODE_BRIEF 和 GrowthBook 特性值判断是否启用紧凑模式
 * 2. 截断超长文本（> 10,000 字符）防止 Ink 全屏渲染卡顿：
 *    - 保留头部 2,500 字符 + 尾部 2,500 字符
 *    - 中间插入 "… +N lines …" 隐藏行数提示
 * 3. 读取 MessageActionsSelectedContext 判断当前消息是否被选中（影响背景色）
 * 4. 通过 HighlightedThinkingText 组件渲染最终文本内容（支持思维链高亮）
 * 5. 根据 addMargin / isSelected / useBriefLayout 动态调整背景色和内边距
 *
 * 【依赖】
 * - bun:bundle feature(): 编译时特性标志（KAIROS、KAIROS_BRIEF）
 * - @anthropic-ai/sdk: TextBlockParam 类型
 * - react: useContext、useMemo
 * - bootstrap/state: getKairosActive()、getUserMsgOptIn()
 * - ink: Box 组件
 * - services/analytics/growthbook: getFeatureValue_CACHED_MAY_BE_STALE()
 * - state/AppState: useAppState()
 * - utils/envUtils: isEnvTruthy()
 * - utils/log: logError()
 * - utils/stringUtils: countCharInString()
 * - components/messageActions: MessageActionsSelectedContext
 * - components/messages/HighlightedThinkingText: 文本渲染子组件
 */
import { feature } from 'bun:bundle';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useContext, useMemo } from 'react';
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js';
import { Box } from '../../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { useAppState } from '../../state/AppState.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { logError } from '../../utils/log.js';
import { countCharInString } from '../../utils/stringUtils.js';
import { MessageActionsSelectedContext } from '../messageActions.js';
import { HighlightedThinkingText } from './HighlightedThinkingText.js';

// 组件 Props 类型定义
type Props = {
  addMargin: boolean;          // 是否在顶部添加 marginTop=1 的间距
  param: TextBlockParam;       // Anthropic SDK 文本块参数，包含 text 字段
  isTranscriptMode?: boolean;  // 是否处于只读的历史转录模式（Brief 模式下不生效）
  timestamp?: string;          // 消息时间戳（仅在 Brief 模式下透传给子组件）
};

// 显示文本最大字符数：超过此限制将触发截断，防止全屏 Ink 渲染卡顿（500ms+ 延迟）
// 说明：通过管道将大文件输入给 claude（如 cat 11k行文件 | claude）会产生单条超长消息
const MAX_DISPLAY_CHARS = 10_000;

// 截断时保留的头部字符数（用户实际问题通常在文件内容之后的末尾）
const TRUNCATE_HEAD_CHARS = 2_500;

// 截断时保留的尾部字符数（包含用户真正的问题）
const TRUNCATE_TAIL_CHARS = 2_500;

/**
 * UserPromptMessage — 用户提示文本渲染组件
 *
 * 流程：
 * 1. 根据 KAIROS/KAIROS_BRIEF 编译时标志决定是否读取 isBriefOnly 和 viewingAgentTaskId
 *    （Hook 在特性标志内部调用，避免非 Kairos 构建订阅全局 store 带来的性能开销）
 * 2. 综合多个条件（Kairos 激活状态、用户选择加入、环境变量、GrowthBook 特性值）
 *    计算 useBriefLayout 布尔值
 * 3. 使用 useMemo 对文本截断进行缓存（依赖 text）：
 *    - 文本 ≤ MAX_DISPLAY_CHARS：直接返回原文
 *    - 文本 > MAX_DISPLAY_CHARS：保留头部 + 省略提示 + 尾部
 * 4. 从 MessageActionsSelectedContext 读取消息选中状态
 * 5. 文本为空时记录错误并返回 null
 * 6. 渲染外层 Box（背景色和内边距由选中状态和 Brief 模式决定），内含 HighlightedThinkingText
 */
export function UserPromptMessage({
  addMargin,
  param: {
    text
  },
  isTranscriptMode,
  timestamp
}: Props): React.ReactNode {
  // REPL.tsx 通过 prop 传递 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}，
  // 但该 prop 未深入传递到此层 —— 通过直接读取 viewingAgentTaskId 来复现覆盖逻辑。
  // 在父级 Box 处计算（而非子组件内），以便父级 Box 能正确清除背景色：
  // Brief 模式下子组件使用标签式布局，Box 背景色会无条件绘制在子元素之后（子元素无法取消）。
  //
  // Hook 保持在 feature() 三目运算符内部，避免非 Kairos 外部构建为每条 scrollback 消息
  // 订阅 store（useSyncExternalStore 会绕过 React.memo 的优化）。
  // 运行时判断与 isBriefEnabled() 一致，但内联以避免将 BriefTool.ts → prompt.ts 的
  // 工具名称字符串引入外部构建产物。

  // 读取全局 Brief 状态（仅在 KAIROS/KAIROS_BRIEF 特性存在时）
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) : false;

  // 读取当前正在查看的子代理任务 ID（存在时禁用 Brief 模式）
  const viewingAgentTaskId = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.viewingAgentTaskId) : null;

  // 提升到挂载时计算（每条消息组件，在每次滚动时重渲染）
  // 读取 CLAUDE_CODE_BRIEF 环境变量判断是否通过环境变量启用 Brief 模式
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), []) : false;

  // 综合判断是否启用紧凑 Brief 布局：
  // 条件：(Kairos 激活 OR (用户选择加入 AND (环境变量 OR GrowthBook 特性值)))
  //       AND isBriefOnly AND 非转录模式 AND 非子代理任务查看模式
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ? (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false))) && isBriefOnly && !isTranscriptMode && !viewingAgentTaskId : false;

  // 截断逻辑（在早期返回之前执行以保持 Hook 调用顺序稳定）
  // 依赖 text 变化时重新计算
  const displayText = useMemo(() => {
    // 文本未超过上限，直接使用原文
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    // 取头部 2,500 字符
    const head = text.slice(0, TRUNCATE_HEAD_CHARS);
    // 取尾部 2,500 字符
    const tail = text.slice(-TRUNCATE_TAIL_CHARS);
    // 计算被隐藏的行数：头部后的换行数 - 尾部内的换行数
    const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n');
    // 拼接头部 + 省略提示行 + 尾部
    return `${head}\n… +${hiddenLines} lines …\n${tail}`;
  }, [text]);

  // 读取消息操作选中状态 Context（影响背景色高亮）
  const isSelected = useContext(MessageActionsSelectedContext);

  // 文本为空时记录错误并返回 null（防御性处理）
  if (!text) {
    logError(new Error('No content found in user prompt message'));
    return null;
  }

  // 渲染外层 Box：
  // - marginTop 由 addMargin 决定（1 或 0）
  // - backgroundColor：选中时用 messageActionsBackground，Brief 模式时为 undefined（透明），否则用 userMessageBackground
  // - paddingRight：Brief 模式时为 0，否则为 1
  return <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={isSelected ? 'messageActionsBackground' : useBriefLayout ? undefined : 'userMessageBackground'} paddingRight={useBriefLayout ? 0 : 1}>
      {/* HighlightedThinkingText 渲染截断后的文本，支持思维链高亮和 Brief 标签式布局 */}
      <HighlightedThinkingText text={displayText} useBriefLayout={useBriefLayout} timestamp={useBriefLayout ? timestamp : undefined} />
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiVGV4dEJsb2NrUGFyYW0iLCJSZWFjdCIsInVzZUNvbnRleHQiLCJ1c2VNZW1vIiwiZ2V0S2Fpcm9zQWN0aXZlIiwiZ2V0VXNlck1zZ09wdEluIiwiQm94IiwiZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUiLCJ1c2VBcHBTdGF0ZSIsImlzRW52VHJ1dGh5IiwibG9nRXJyb3IiLCJjb3VudENoYXJJblN0cmluZyIsIk1lc3NhZ2VBY3Rpb25zU2VsZWN0ZWRDb250ZXh0IiwiSGlnaGxpZ2h0ZWRUaGlua2luZ1RleHQiLCJQcm9wcyIsImFkZE1hcmdpbiIsInBhcmFtIiwiaXNUcmFuc2NyaXB0TW9kZSIsInRpbWVzdGFtcCIsIk1BWF9ESVNQTEFZX0NIQVJTIiwiVFJVTkNBVEVfSEVBRF9DSEFSUyIsIlRSVU5DQVRFX1RBSUxfQ0hBUlMiLCJVc2VyUHJvbXB0TWVzc2FnZSIsInRleHQiLCJSZWFjdE5vZGUiLCJpc0JyaWVmT25seSIsInMiLCJ2aWV3aW5nQWdlbnRUYXNrSWQiLCJicmllZkVudkVuYWJsZWQiLCJwcm9jZXNzIiwiZW52IiwiQ0xBVURFX0NPREVfQlJJRUYiLCJ1c2VCcmllZkxheW91dCIsImRpc3BsYXlUZXh0IiwibGVuZ3RoIiwiaGVhZCIsInNsaWNlIiwidGFpbCIsImhpZGRlbkxpbmVzIiwiaXNTZWxlY3RlZCIsIkVycm9yIiwidW5kZWZpbmVkIl0sInNvdXJjZXMiOlsiVXNlclByb21wdE1lc3NhZ2UudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGZlYXR1cmUgfSBmcm9tICdidW46YnVuZGxlJ1xuaW1wb3J0IHR5cGUgeyBUZXh0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgUmVhY3QsIHsgdXNlQ29udGV4dCwgdXNlTWVtbyB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgZ2V0S2Fpcm9zQWN0aXZlLCBnZXRVc2VyTXNnT3B0SW4gfSBmcm9tICcuLi8uLi9ib290c3RyYXAvc3RhdGUuanMnXG5pbXBvcnQgeyBCb3ggfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBnZXRGZWF0dXJlVmFsdWVfQ0FDSEVEX01BWV9CRV9TVEFMRSB9IGZyb20gJy4uLy4uL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHsgdXNlQXBwU3RhdGUgfSBmcm9tICcuLi8uLi9zdGF0ZS9BcHBTdGF0ZS5qcydcbmltcG9ydCB7IGlzRW52VHJ1dGh5IH0gZnJvbSAnLi4vLi4vdXRpbHMvZW52VXRpbHMuanMnXG5pbXBvcnQgeyBsb2dFcnJvciB9IGZyb20gJy4uLy4uL3V0aWxzL2xvZy5qcydcbmltcG9ydCB7IGNvdW50Q2hhckluU3RyaW5nIH0gZnJvbSAnLi4vLi4vdXRpbHMvc3RyaW5nVXRpbHMuanMnXG5pbXBvcnQgeyBNZXNzYWdlQWN0aW9uc1NlbGVjdGVkQ29udGV4dCB9IGZyb20gJy4uL21lc3NhZ2VBY3Rpb25zLmpzJ1xuaW1wb3J0IHsgSGlnaGxpZ2h0ZWRUaGlua2luZ1RleHQgfSBmcm9tICcuL0hpZ2hsaWdodGVkVGhpbmtpbmdUZXh0LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBhZGRNYXJnaW46IGJvb2xlYW5cbiAgcGFyYW06IFRleHRCbG9ja1BhcmFtXG4gIGlzVHJhbnNjcmlwdE1vZGU/OiBib29sZWFuXG4gIHRpbWVzdGFtcD86IHN0cmluZ1xufVxuXG4vLyBIYXJkIGNhcCBvbiBkaXNwbGF5ZWQgcHJvbXB0IHRleHQuIFBpcGluZyBsYXJnZSBmaWxlcyB2aWEgc3RkaW5cbi8vIChlLmcuIGBjYXQgMTFrLWxpbmUtZmlsZSB8IGNsYXVkZWApIGNyZWF0ZXMgYSBzaW5nbGUgdXNlciBtZXNzYWdlIHdob3NlXG4vLyA8VGV4dD4gbm9kZSB0aGUgZnVsbHNjcmVlbiBJbmsgcmVuZGVyZXIgbXVzdCB3cmFwL291dHB1dCBvbiBldmVyeSBmcmFtZSxcbi8vIGNhdXNpbmcgNTAwbXMrIGtleXN0cm9rZSBsYXRlbmN5LiBSZWFjdC5tZW1vIHNraXBzIHRoZSBSZWFjdCByZW5kZXIgYnV0XG4vLyB0aGUgSW5rIG91dHB1dCBwYXNzIHN0aWxsIGl0ZXJhdGVzIHRoZSBmdWxsIG1vdW50ZWQgdGV4dC4gTm9uLWZ1bGxzY3JlZW5cbi8vIGF2b2lkcyB0aGlzIHZpYSA8U3RhdGljPiAocHJpbnQtYW5kLWZvcmdldCB0byB0ZXJtaW5hbCBzY3JvbGxiYWNrKS5cbi8vIEhlYWQrdGFpbCBiZWNhdXNlIGB7IGNhdCBmaWxlOyBlY2hvIHByb21wdDsgfSB8IGNsYXVkZWAgcHV0cyB0aGUgdXNlcidzXG4vLyBhY3R1YWwgcXVlc3Rpb24gYXQgdGhlIGVuZC5cbmNvbnN0IE1BWF9ESVNQTEFZX0NIQVJTID0gMTBfMDAwXG5jb25zdCBUUlVOQ0FURV9IRUFEX0NIQVJTID0gMl81MDBcbmNvbnN0IFRSVU5DQVRFX1RBSUxfQ0hBUlMgPSAyXzUwMFxuXG5leHBvcnQgZnVuY3Rpb24gVXNlclByb21wdE1lc3NhZ2Uoe1xuICBhZGRNYXJnaW4sXG4gIHBhcmFtOiB7IHRleHQgfSxcbiAgaXNUcmFuc2NyaXB0TW9kZSxcbiAgdGltZXN0YW1wLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBSRVBMLnRzeCBwYXNzZXMgaXNCcmllZk9ubHk9e3ZpZXdlZFRlYW1tYXRlVGFzayA/IGZhbHNlIDogaXNCcmllZk9ubHl9XG4gIC8vIGJ1dCB0aGF0IHByb3AgaXNuJ3QgdGhyZWFkZWQgdGhpcyBkZWVwIOKAlCByZXBsaWNhdGUgdGhlIG92ZXJyaWRlIGJ5XG4gIC8vIHJlYWRpbmcgdmlld2luZ0FnZW50VGFza0lkIGRpcmVjdGx5LiBDb21wdXRlZCBoZXJlIChub3QgaW4gdGhlIGNoaWxkKVxuICAvLyBzbyB0aGUgcGFyZW50IEJveCBjYW4gZHJvcCBpdHMgYmFja2dyb3VuZENvbG9yOiBpbiBicmllZiBtb2RlIHRoZVxuICAvLyBjaGlsZCByZW5kZXJzIGEgbGFiZWwtc3R5bGUgbGF5b3V0LCBhbmQgQm94IGJhY2tncm91bmRDb2xvciBwYWludHNcbiAgLy8gYmVoaW5kIGNoaWxkcmVuIHVuY29uZGl0aW9uYWxseSAodGhleSBjYW4ndCBvcHQgb3V0KS5cbiAgLy9cbiAgLy8gSG9va3Mgc3RheSBJTlNJREUgZmVhdHVyZSgpIHRlcm5hcmllcyBzbyBleHRlcm5hbCBidWlsZHMgZG9uJ3QgcGF5XG4gIC8vIHRoZSBwZXItc2Nyb2xsYmFjay1tZXNzYWdlIHN0b3JlIHN1YnNjcmlwdGlvbiAodXNlU3luY0V4dGVybmFsU3RvcmVcbiAgLy8gYnlwYXNzZXMgUmVhY3QubWVtbykuIFJ1bnRpbWUtZ2F0ZWQgbGlrZSBpc0JyaWVmRW5hYmxlZCgpIGJ1dCBpbmxpbmVkXG4gIC8vIHRvIGF2b2lkIHB1bGxpbmcgQnJpZWZUb29sLnRzIOKGkiBwcm9tcHQudHMgdG9vbC1uYW1lIHN0cmluZ3MgaW50b1xuICAvLyBleHRlcm5hbCBidWlsZHMuXG4gIGNvbnN0IGlzQnJpZWZPbmx5ID1cbiAgICBmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKVxuICAgICAgPyAvLyBiaW9tZS1pZ25vcmUgbGludC9jb3JyZWN0bmVzcy91c2VIb29rQXRUb3BMZXZlbDogZmVhdHVyZSgpIGlzIGEgY29tcGlsZS10aW1lIGNvbnN0YW50XG4gICAgICAgIHVzZUFwcFN0YXRlKHMgPT4gcy5pc0JyaWVmT25seSlcbiAgICAgIDogZmFsc2VcbiAgY29uc3Qgdmlld2luZ0FnZW50VGFza0lkID1cbiAgICBmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKVxuICAgICAgPyAvLyBiaW9tZS1pZ25vcmUgbGludC9jb3JyZWN0bmVzcy91c2VIb29rQXRUb3BMZXZlbDogZmVhdHVyZSgpIGlzIGEgY29tcGlsZS10aW1lIGNvbnN0YW50XG4gICAgICAgIHVzZUFwcFN0YXRlKHMgPT4gcy52aWV3aW5nQWdlbnRUYXNrSWQpXG4gICAgICA6IG51bGxcbiAgLy8gSG9pc3RlZCB0byBtb3VudC10aW1lIOKAlCBwZXItbWVzc2FnZSBjb21wb25lbnQsIHJlLXJlbmRlcnMgb24gZXZlcnkgc2Nyb2xsLlxuICBjb25zdCBicmllZkVudkVuYWJsZWQgPVxuICAgIGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19CUklFRicpXG4gICAgICA/IC8vIGJpb21lLWlnbm9yZSBsaW50L2NvcnJlY3RuZXNzL3VzZUhvb2tBdFRvcExldmVsOiBmZWF0dXJlKCkgaXMgYSBjb21waWxlLXRpbWUgY29uc3RhbnRcbiAgICAgICAgdXNlTWVtbygoKSA9PiBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9CUklFRiksIFtdKVxuICAgICAgOiBmYWxzZVxuICBjb25zdCB1c2VCcmllZkxheW91dCA9XG4gICAgZmVhdHVyZSgnS0FJUk9TJykgfHwgZmVhdHVyZSgnS0FJUk9TX0JSSUVGJylcbiAgICAgID8gKGdldEthaXJvc0FjdGl2ZSgpIHx8XG4gICAgICAgICAgKGdldFVzZXJNc2dPcHRJbigpICYmXG4gICAgICAgICAgICAoYnJpZWZFbnZFbmFibGVkIHx8XG4gICAgICAgICAgICAgIGdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFKFxuICAgICAgICAgICAgICAgICd0ZW5ndV9rYWlyb3NfYnJpZWYnLFxuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICApKSkpICYmXG4gICAgICAgIGlzQnJpZWZPbmx5ICYmXG4gICAgICAgICFpc1RyYW5zY3JpcHRNb2RlICYmXG4gICAgICAgICF2aWV3aW5nQWdlbnRUYXNrSWRcbiAgICAgIDogZmFsc2VcblxuICAvLyBUcnVuY2F0ZSBiZWZvcmUgdGhlIGVhcmx5IHJldHVybiBzbyB0aGUgaG9vayBvcmRlciBpcyBzdGFibGUuXG4gIGNvbnN0IGRpc3BsYXlUZXh0ID0gdXNlTWVtbygoKSA9PiB7XG4gICAgaWYgKHRleHQubGVuZ3RoIDw9IE1BWF9ESVNQTEFZX0NIQVJTKSByZXR1cm4gdGV4dFxuICAgIGNvbnN0IGhlYWQgPSB0ZXh0LnNsaWNlKDAsIFRSVU5DQVRFX0hFQURfQ0hBUlMpXG4gICAgY29uc3QgdGFpbCA9IHRleHQuc2xpY2UoLVRSVU5DQVRFX1RBSUxfQ0hBUlMpXG4gICAgY29uc3QgaGlkZGVuTGluZXMgPVxuICAgICAgY291bnRDaGFySW5TdHJpbmcodGV4dCwgJ1xcbicsIFRSVU5DQVRFX0hFQURfQ0hBUlMpIC1cbiAgICAgIGNvdW50Q2hhckluU3RyaW5nKHRhaWwsICdcXG4nKVxuICAgIHJldHVybiBgJHtoZWFkfVxcbuKApiArJHtoaWRkZW5MaW5lc30gbGluZXMg4oCmXFxuJHt0YWlsfWBcbiAgfSwgW3RleHRdKVxuXG4gIGNvbnN0IGlzU2VsZWN0ZWQgPSB1c2VDb250ZXh0KE1lc3NhZ2VBY3Rpb25zU2VsZWN0ZWRDb250ZXh0KVxuXG4gIGlmICghdGV4dCkge1xuICAgIGxvZ0Vycm9yKG5ldyBFcnJvcignTm8gY29udGVudCBmb3VuZCBpbiB1c2VyIHByb21wdCBtZXNzYWdlJykpXG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJveFxuICAgICAgZmxleERpcmVjdGlvbj1cImNvbHVtblwiXG4gICAgICBtYXJnaW5Ub3A9e2FkZE1hcmdpbiA/IDEgOiAwfVxuICAgICAgYmFja2dyb3VuZENvbG9yPXtcbiAgICAgICAgaXNTZWxlY3RlZFxuICAgICAgICAgID8gJ21lc3NhZ2VBY3Rpb25zQmFja2dyb3VuZCdcbiAgICAgICAgICA6IHVzZUJyaWVmTGF5b3V0XG4gICAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgICAgOiAndXNlck1lc3NhZ2VCYWNrZ3JvdW5kJ1xuICAgICAgfVxuICAgICAgcGFkZGluZ1JpZ2h0PXt1c2VCcmllZkxheW91dCA/IDAgOiAxfVxuICAgID5cbiAgICAgIDxIaWdobGlnaHRlZFRoaW5raW5nVGV4dFxuICAgICAgICB0ZXh0PXtkaXNwbGF5VGV4dH1cbiAgICAgICAgdXNlQnJpZWZMYXlvdXQ9e3VzZUJyaWVmTGF5b3V0fVxuICAgICAgICB0aW1lc3RhbXA9e3VzZUJyaWVmTGF5b3V0ID8gdGltZXN0YW1wIDogdW5kZWZpbmVkfVxuICAgICAgLz5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxTQUFTQSxPQUFPLFFBQVEsWUFBWTtBQUNwQyxjQUFjQyxjQUFjLFFBQVEsdUNBQXVDO0FBQzNFLE9BQU9DLEtBQUssSUFBSUMsVUFBVSxFQUFFQyxPQUFPLFFBQVEsT0FBTztBQUNsRCxTQUFTQyxlQUFlLEVBQUVDLGVBQWUsUUFBUSwyQkFBMkI7QUFDNUUsU0FBU0MsR0FBRyxRQUFRLGNBQWM7QUFDbEMsU0FBU0MsbUNBQW1DLFFBQVEsd0NBQXdDO0FBQzVGLFNBQVNDLFdBQVcsUUFBUSx5QkFBeUI7QUFDckQsU0FBU0MsV0FBVyxRQUFRLHlCQUF5QjtBQUNyRCxTQUFTQyxRQUFRLFFBQVEsb0JBQW9CO0FBQzdDLFNBQVNDLGlCQUFpQixRQUFRLDRCQUE0QjtBQUM5RCxTQUFTQyw2QkFBNkIsUUFBUSxzQkFBc0I7QUFDcEUsU0FBU0MsdUJBQXVCLFFBQVEsOEJBQThCO0FBRXRFLE1BQU1DLGlCQUFpQixHQUFHLE1BQU07QUFDaEMsTUFBTUMsbUJBQW1CLEdBQUcsS0FBSztBQUNqQyxNQUFNQyxtQkFBbUIsR0FBRyxLQUFLO0FBRWpDLE9BQU8sU0FBU0MsaUJBQWlCQSxDQUFDO0VBQ2hDUCxTQUFTO0VBQ1RDLEtBQUssRUFBRTtJQUFFTztFQUFLLENBQUM7RUFDZk4sZ0JBQWdCO0VBQ2hCQztBQUNLLENBQU4sRUFBaUQsQ0FBQztFQUNoRCxNQUFNQyxXQUFXLEdBQ2YxQixPQUFPLENBQUMsUUFBUSxDQUFDLElBQUlBLE9BQU8sQ0FBQyxjQUFjLENBQUM7RUFDeEM7RUFDQVNXQUFXLENBQUNRLENBQUNBLEVBQUVDLENBQUNBLENBQUNDLE9BQU8sSUFBSUIsV0FBVyxDQUFDUCxTQUFTLENBQUMsSUFBSSxLQUFLO0VBQ3BELE1BQU1LLGtCQUFrQixHQUN0QjVCLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSUEsT0FBTyxDQUFDLGNBQWMsQ0FBQztFQUN4QztFQUNBUyxXQUFXLENBQUNrQixHQUFDLElBQUlBLEdBQUMsQ0FBQ0Msa0JBQWtCLENBQUMsSUFBSSxJQUFJO0VBQ2pELE1BQU1DLGVBQWUsR0FDbkI3QixPQUFPLENBQUMsUUFBUSxDQUFDLElBQUlBLE9BQU8sQ0FBQyxjQUFjLENBQUM7RUFDeEM7RUFDQU0sT0FBTyxDQUFDLE1BQU1HLFdBQVcsQ0FBQ29CLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDQyxpQkFBaUIsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxJQUFJLEtBQUs7RUFDMUUsTUFBTUMsY0FBYyxHQUNsQmpDLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSUEsT0FBTyxDQUFDLGNBQWMsQ0FBQyxHQUN4QyxDQUFDSyxlQUFlLENBQUMsQ0FBQyxJQUNmQyxlQUFlLENBQUMsQ0FBQyxLQUNmdUIsZUFBZSxJQUNkckIsbUNBQW1DLENBQUMsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLENBQUUsS0FDbEVrQixXQUFXLElBQUksQ0FBQ1IsZ0JBQWdCLElBQUksQ0FBQ1Usa0JBQWtCLEdBQ3ZELEtBQUs7RUFDWCxNQUFNTSxXQUFXLEdBQUc5QixPQUFPLENBQUMsTUFBTTtJQUNoQyxJQUFJb0IsSUFBSSxDQUFDVyxNQUFNLElBQUlmLGlCQUFpQixFQUFFLE9BQU9JLElBQUk7SUFDakQsTUFBTVksSUFBSSxHQUFHWixJQUFJLENBQUNhLEtBQUssQ0FBQyxDQUFDLEVBQUVoQixtQkFBbUIsQ0FBQztJQUMvQyxNQUFNaUIsSUFBSSxHQUFHZCxJQUFJLENBQUNhLEtBQUssQ0FBQyxDQUFDZixtQkFBbUIsQ0FBQztJQUM3QyxNQUFNaUIsV0FBVyxHQUNmM0IsaUJBQWlCLENBQUNZLElBQUksRUFBRSxJQUFJLEVBQUVILG1CQUFtQixDQUFDLEdBQ2xEVCxpQkFBaUIsQ0FBQzBCLElBQUksRUFBRSxJQUFJLENBQUM7SUFDL0IsT0FBTyxHQUFHRixJQUFJLFFBQVFHLFdBQVcsYUFBYUQsSUFBSSxFQUFFO0VBQ3RELENBQUMsRUFBRSxDQUFDZCxJQUFJLENBQUMsQ0FBQztFQUNWLE1BQU1nQixVQUFVLEdBQUdyQyxVQUFVLENBQUNVLDZCQUE2QixDQUFDO0VBQzVELElBQUksQ0FBQ1csSUFBSSxFQUFFO0lBQ1RiLFFBQVEsQ0FBQyxJQUFJOEIsS0FBSyxDQUFDLHlDQUF5QyxDQUFDLENBQUM7SUFDOUQsT0FBTyxJQUFJO0VBQ2I7RUFDQSxPQUNFLENBQUMsR0FBRyxDQUNGLGFBQWEsQ0FBQyxRQUFRLENBQ3RCLFNBQVMsQ0FBQyxDQUFDekIsU0FBUyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FDN0IsZUFBZSxDQUFDLENBQ2R3QixVQUFVLEdBQ04sMEJBQTBCLEdBQzFCUCxjQUFjLEdBQ1pTLFNBQVMsR0FDVCx1QkFDUixDQUFDLENBQ0QsWUFBWSxDQUFDLENBQUNULGNBQWMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBRTNDLEtBQUssQ0FBQyx1QkFBdUIsQ0FDdEIsSUFBSSxDQUFDLENBQUNDLFdBQVcsQ0FBQyxDQUNsQixjQUFjLENBQUMsQ0FBQ0QsY0FBYyxDQUFDLENBQy9CLFNBQVMsQ0FBQyxDQUFDQSxjQUFjLEdBQUdkLFNBQVMsR0FBR3VCLFNBQVM7QUFFM0Qsa0JBQWtCLENBQUMsR0FBRyxDQUFDO0FBRXZCIiwiaWdub3JlTGlzdCI6W119
