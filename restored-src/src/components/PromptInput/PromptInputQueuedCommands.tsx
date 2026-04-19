/**
 * PromptInputQueuedCommands.tsx
 *
 * 【系统流程位置】
 * 本文件是 Claude Code TUI 命令队列的可视化层，位于输入框上方。
 * 整体流程：
 *   外部系统（MCP 服务器、Kairos 任务调度、通道消息）
 *     → useCommandQueue（队列状态）
 *     → PromptInputQueuedCommandsImpl（本文件，渲染队列预览）
 *     → Message 组件（复用聊天消息渲染）
 *
 * 【主要功能】
 * 1. 从命令队列读取待处理命令，在输入框上方预览显示
 * 2. 过滤掉空闲通知（idle_notification），过滤不可见命令
 * 3. 限制任务通知显示数量（最多 MAX_VISIBLE_NOTIFICATIONS 条），超出用摘要替代
 * 4. bash 模式命令包装在 <bash-input> 标签中以正确渲染
 * 5. useMemo 稳定 UUID，避免因 createUserMessage 每次生成新 UUID 导致的闪烁
 * 6. 查看 agent 会话时（viewingAgent=true）隐藏队列预览
 * 7. Kairos 特性下支持简报布局（useBriefLayout）
 */
import { feature } from 'bun:bundle';
import * as React from 'react';
import { useMemo } from 'react';
import { Box } from 'src/ink.js';
import { useAppState } from 'src/state/AppState.js';
import { STATUS_TAG, SUMMARY_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js';
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js';
import { useCommandQueue } from '../../hooks/useCommandQueue.js';
import type { QueuedCommand } from '../../types/textInputTypes.js';
import { isQueuedCommandVisible } from '../../utils/messageQueueManager.js';
import { createUserMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { Message } from '../Message.js';

// 用于 Message 组件 inProgressToolUseIDs prop 的空集合常量，避免每次渲染重新分配
const EMPTY_SET = new Set<string>();

/**
 * isIdleNotification
 *
 * 【功能】
 * 判断一条命令的 value 是否为空闲通知（idle_notification）。
 * 空闲通知是系统内部生成的心跳/状态同步消息，不应展示给用户。
 *
 * 【流程】
 * 1. 尝试用 jsonParse 解析 value 字符串
 * 2. 检查解析结果的 type 字段是否为 'idle_notification'
 * 3. 解析失败（非 JSON）时返回 false，视为正常命令
 *
 * @param value - 命令的文本内容
 * @returns true 表示是空闲通知（应被过滤），false 表示是正常命令
 */
function isIdleNotification(value: string): boolean {
  try {
    const parsed = jsonParse(value);
    return parsed?.type === 'idle_notification';
  } catch {
    // 解析失败说明不是 JSON，必然不是空闲通知
    return false;
  }
}

// 任务通知最多展示几条（超出部分合并为一条摘要）
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * createOverflowNotificationMessage
 *
 * 【功能】
 * 当任务通知超过 MAX_VISIBLE_NOTIFICATIONS 条时，
 * 生成一条合并摘要消息（XML 格式），显示 "+N more tasks completed"。
 *
 * 【设计意图】
 * 复用 Message 组件的 task-notification 渲染路径，
 * 用 TASK_NOTIFICATION_TAG / SUMMARY_TAG / STATUS_TAG 包装摘要内容，
 * 保持与真实任务通知相同的视觉样式。
 *
 * @param count - 溢出的任务通知数量
 * @returns XML 格式的合并摘要字符串
 */
function createOverflowNotificationMessage(count: number): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${SUMMARY_TAG}>+${count} more tasks completed</${SUMMARY_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * processQueuedCommands
 *
 * 【功能】
 * 对可见命令列表进行处理：
 *   1. 过滤掉空闲通知
 *   2. 将任务通知（task-notification）与其他命令分组
 *   3. 若任务通知数量 ≤ MAX_VISIBLE_NOTIFICATIONS，全部展示
 *   4. 否则展示前 (MAX_VISIBLE_NOTIFICATIONS-1) 条 + 一条溢出摘要
 *
 * 【输出顺序】
 * [其他命令...] + [可见的任务通知...] + [溢出摘要（如有）]
 *
 * @param queuedCommands - 经过可见性过滤后的命令列表
 * @returns 处理后的最终展示命令列表
 */
function processQueuedCommands(queuedCommands: QueuedCommand[]): QueuedCommand[] {
  // 过滤掉空闲通知 - 它们由系统静默处理，无需展示
  const filteredCommands = queuedCommands.filter(cmd => typeof cmd.value !== 'string' || !isIdleNotification(cmd.value));

  // 将任务通知与其他命令分离，便于分别控制显示数量
  const taskNotifications = filteredCommands.filter(cmd => cmd.mode === 'task-notification');
  const otherCommands = filteredCommands.filter(cmd => cmd.mode !== 'task-notification');

  // 任务通知数量在限制内，直接返回全部
  if (taskNotifications.length <= MAX_VISIBLE_NOTIFICATIONS) {
    return [...otherCommands, ...taskNotifications];
  }

  // 超出限制：显示前 MAX_VISIBLE_NOTIFICATIONS-1 条，最后一条替换为溢出摘要
  const visibleNotifications = taskNotifications.slice(0, MAX_VISIBLE_NOTIFICATIONS - 1);
  const overflowCount = taskNotifications.length - (MAX_VISIBLE_NOTIFICATIONS - 1);

  // 创建合并摘要命令（伪装为 task-notification 以复用渲染逻辑）
  const overflowCommand: QueuedCommand = {
    value: createOverflowNotificationMessage(overflowCount),
    mode: 'task-notification'
  };
  return [...otherCommands, ...visibleNotifications, overflowCommand];
}

/**
 * PromptInputQueuedCommandsImpl
 *
 * 【功能】
 * 核心渲染组件，将待处理命令队列渲染为 Message 预览列表，显示在输入框上方。
 *
 * 【渲染流程】
 * 1. useCommandQueue() 订阅命令队列状态
 * 2. useAppState 检查是否正在查看 agent 会话（viewingAgent）
 * 3. feature('KAIROS') 编译时判断是否需要简报布局
 * 4. useMemo 将命令转换为 Message 对象（稳定 UUID，避免闪烁）：
 *    a. 过滤不可见命令
 *    b. processQueuedCommands 限制任务通知数量
 *    c. bash 命令包装 <bash-input> 标签
 *    d. createUserMessage 生成消息对象 → normalizeMessages 规范化
 * 5. 查看 agent 或无消息时返回 null
 * 6. 渲染 Box > (QueuedMessageProvider > Message)[] 列表
 *
 * 【关键设计】
 * - useMemo([queuedCommands])：createUserMessage 每次调用会生成新 UUID，
 *   没有 memo 时每次 re-render 都会变化，导致 Message 的 areMessagePropsEqual 失效 → 闪烁
 * - feature('KAIROS') 是 bun:bundle 编译时常量，必须在 JSX 外调用（满足条件渲染时 hook 调用规则）
 * - isFirst prop 控制第一条消息的特殊渲染（如省略顶部间距）
 *
 * 【导出】
 * 以 React.memo 包裹导出，避免父组件无关更新触发整个队列重新渲染。
 */
function PromptInputQueuedCommandsImpl(): React.ReactNode {
  // 订阅命令队列，包含所有待处理的命令
  const queuedCommands = useCommandQueue();
  // 检查是否正在查看某个 agent 的任务会话（此时不显示领队的队列）
  const viewingAgent = useAppState(s => !!s.viewingAgentTaskId);
  // Brief layout: dim queue items + skip the paddingX (brief messages
  // already indent themselves). Gate mirrors the brief-spinner/message
  // check elsewhere — no teammate-view override needed since this
  // component early-returns when viewing a teammate.
  // feature() 是 bun:bundle 编译时常量，条件渲染下调用 Hook 符合 biome-ignore 注解要求
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.isBriefOnly) : false;

  // createUserMessage mints a fresh UUID per call; without memoization, streaming
  // re-renders defeat Message's areMessagePropsEqual (compares uuid) → flicker.
  // useMemo 仅在 queuedCommands 引用变化时重新计算，保持 UUID 稳定
  const messages = useMemo(() => {
    if (queuedCommands.length === 0) return null;
    // task-notification is shown via useInboxNotification; most isMeta commands
    // (scheduled tasks, proactive ticks) are system-generated and hidden.
    // Channel messages are the exception — isMeta but shown so the keyboard
    // user sees what arrived.
    // 过滤出可展示的命令（排除纯系统内部命令）
    const visibleCommands = queuedCommands.filter(isQueuedCommandVisible);
    if (visibleCommands.length === 0) return null;
    // 限制任务通知数量，防止队列过长占据大量屏幕空间
    const processedCommands = processQueuedCommands(visibleCommands);
    return normalizeMessages(processedCommands.map(cmd => {
      let content = cmd.value;
      // bash 命令用 <bash-input> 标签包裹，使 Message 组件以 bash 样式渲染
      if (cmd.mode === 'bash' && typeof content === 'string') {
        content = `<bash-input>${content}</bash-input>`;
      }
      // [Image #N] placeholders are inline in the text value (inserted at
      // paste time), so the queue preview shows them without stub blocks.
      return createUserMessage({
        content
      });
    }));
  }, [queuedCommands]);

  // 查看 agent 会话时，隐藏领队的命令队列预览；无消息时也不渲染
  if (viewingAgent || messages === null) {
    return null;
  }
  // 渲染命令队列预览列表，每条命令用 QueuedMessageProvider 包裹以提供上下文
  return <Box marginTop={1} flexDirection="column">
      {messages.map((message, i) => <QueuedMessageProvider key={i} isFirst={i === 0} useBriefLayout={useBriefLayout}>
          <Message message={message} lookups={EMPTY_LOOKUPS} addMargin={false} tools={[]} commands={[]} verbose={false} inProgressToolUseIDs={EMPTY_SET} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} />
        </QueuedMessageProvider>)}
    </Box>;
}

// 用 React.memo 包裹，减少父组件无关状态变化时的重渲染开销
export const PromptInputQueuedCommands = React.memo(PromptInputQueuedCommandsImpl);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiUmVhY3QiLCJ1c2VNZW1vIiwiQm94IiwidXNlQXBwU3RhdGUiLCJTVEFUVVNfVEFHIiwiU1VNTUFSWV9UQUciLCJUQVNLX05PVElGSUNBVElPTl9UQUciLCJRdWV1ZWRNZXNzYWdlUHJvdmlkZXIiLCJ1c2VDb21tYW5kUXVldWUiLCJRdWV1ZWRDb21tYW5kIiwiaXNRdWV1ZWRDb21tYW5kVmlzaWJsZSIsImNyZWF0ZVVzZXJNZXNzYWdlIiwiRU1QVFlfTE9PS1VQUyIsIm5vcm1hbGl6ZU1lc3NhZ2VzIiwianNvblBhcnNlIiwiTWVzc2FnZSIsIkVNUFRZX1NFVCIsIlNldCIsImlzSWRsZU5vdGlmaWNhdGlvbiIsInZhbHVlIiwicGFyc2VkIiwidHlwZSIsIk1BWF9WSVNJQkxFX05PVElGSUNBVElPTlMiLCJjcmVhdGVPdmVyZmxvd05vdGlmaWNhdGlvbk1lc3NhZ2UiLCJjb3VudCIsInByb2Nlc3NRdWV1ZWRDb21tYW5kcyIsInF1ZXVlZENvbW1hbmRzIiwiZmlsdGVyZWRDb21tYW5kcyIsImZpbHRlciIsImNtZCIsInRhc2tOb3RpZmljYXRpb25zIiwibW9kZSIsIm90aGVyQ29tbWFuZHMiLCJsZW5ndGgiLCJ2aXNpYmxlTm90aWZpY2F0aW9ucyIsInNsaWNlIiwib3ZlcmZsb3dDb3VudCIsIm92ZXJmbG93Q29tbWFuZCIsIlByb21wdElucHV0UXVldWVkQ29tbWFuZHNJbXBsIiwiUmVhY3ROb2RlIiwidmlld2luZ0FnZW50IiwicyIsInZpZXdpbmdBZ2VudFRhc2tJZCIsInVzZUJyaWVmTGF5b3V0IiwiaXNCcmllZk9ubHkiLCJtZXNzYWdlcyIsInZpc2libGVDb21tYW5kcyIsInByb2Nlc3NlZENvbW1hbmRzIiwibWFwIiwiY29udGVudCIsIm1lc3NhZ2UiLCJpIiwiUHJvbXB0SW5wdXRRdWV1ZWRDb21tYW5kcyIsIm1lbW8iXSwic291cmNlcyI6WyJQcm9tcHRJbnB1dFF1ZXVlZENvbW1hbmRzLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBmZWF0dXJlIH0gZnJvbSAnYnVuOmJ1bmRsZSdcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlTWVtbyB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94IH0gZnJvbSAnc3JjL2luay5qcydcbmltcG9ydCB7IHVzZUFwcFN0YXRlIH0gZnJvbSAnc3JjL3N0YXRlL0FwcFN0YXRlLmpzJ1xuaW1wb3J0IHtcbiAgU1RBVFVTX1RBRyxcbiAgU1VNTUFSWV9UQUcsXG4gIFRBU0tfTk9USUZJQ0FUSU9OX1RBRyxcbn0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL3htbC5qcydcbmltcG9ydCB7IFF1ZXVlZE1lc3NhZ2VQcm92aWRlciB9IGZyb20gJy4uLy4uL2NvbnRleHQvUXVldWVkTWVzc2FnZUNvbnRleHQuanMnXG5pbXBvcnQgeyB1c2VDb21tYW5kUXVldWUgfSBmcm9tICcuLi8uLi9ob29rcy91c2VDb21tYW5kUXVldWUuanMnXG5pbXBvcnQgdHlwZSB7IFF1ZXVlZENvbW1hbmQgfSBmcm9tICcuLi8uLi90eXBlcy90ZXh0SW5wdXRUeXBlcy5qcydcbmltcG9ydCB7IGlzUXVldWVkQ29tbWFuZFZpc2libGUgfSBmcm9tICcuLi8uLi91dGlscy9tZXNzYWdlUXVldWVNYW5hZ2VyLmpzJ1xuaW1wb3J0IHtcbiAgY3JlYXRlVXNlck1lc3NhZ2UsXG4gIEVNUFRZX0xPT0tVUFMsXG4gIG5vcm1hbGl6ZU1lc3NhZ2VzLFxufSBmcm9tICcuLi8uLi91dGlscy9tZXNzYWdlcy5qcydcbmltcG9ydCB7IGpzb25QYXJzZSB9IGZyb20gJy4uLy4uL3V0aWxzL3Nsb3dPcGVyYXRpb25zLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZSB9IGZyb20gJy4uL01lc3NhZ2UuanMnXG5cbmNvbnN0IEVNUFRZX1NFVCA9IG5ldyBTZXQ8c3RyaW5nPigpXG5cbi8qKlxuICogQ2hlY2sgaWYgYSBjb21tYW5kIHZhbHVlIGlzIGFuIGlkbGUgbm90aWZpY2F0aW9uIHRoYXQgc2hvdWxkIGJlIGhpZGRlbi5cbiAqIElkbGUgbm90aWZpY2F0aW9ucyBhcmUgcHJvY2Vzc2VkIHNpbGVudGx5IHdpdGhvdXQgc2hvd2luZyB0byB0aGUgdXNlci5cbiAqL1xuZnVuY3Rpb24gaXNJZGxlTm90aWZpY2F0aW9uKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBqc29uUGFyc2UodmFsdWUpXG4gICAgcmV0dXJuIHBhcnNlZD8udHlwZSA9PT0gJ2lkbGVfbm90aWZpY2F0aW9uJ1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2VcbiAgfVxufVxuXG4vLyBNYXhpbXVtIG51bWJlciBvZiB0YXNrIG5vdGlmaWNhdGlvbiBsaW5lcyB0byBzaG93XG5jb25zdCBNQVhfVklTSUJMRV9OT1RJRklDQVRJT05TID0gM1xuXG4vKipcbiAqIENyZWF0ZSBhIHN5bnRoZXRpYyBvdmVyZmxvdyBub3RpZmljYXRpb24gbWVzc2FnZSBmb3IgY2FwcGVkIHRhc2sgbm90aWZpY2F0aW9ucy5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlT3ZlcmZsb3dOb3RpZmljYXRpb25NZXNzYWdlKGNvdW50OiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYDwke1RBU0tfTk9USUZJQ0FUSU9OX1RBR30+XG48JHtTVU1NQVJZX1RBR30+KyR7Y291bnR9IG1vcmUgdGFza3MgY29tcGxldGVkPC8ke1NVTU1BUllfVEFHfT5cbjwke1NUQVRVU19UQUd9PmNvbXBsZXRlZDwvJHtTVEFUVVNfVEFHfT5cbjwvJHtUQVNLX05PVElGSUNBVElPTl9UQUd9PmBcbn1cblxuLyoqXG4gKiBQcm9jZXNzIHF1ZXVlZCBjb21tYW5kcyB0byBjYXAgdGFzayBub3RpZmljYXRpb25zIGF0IE1BWF9WSVNJQkxFX05PVElGSUNBVElPTlMgbGluZXMuXG4gKiBPdGhlciBjb21tYW5kIHR5cGVzIGFyZSBhbHdheXMgc2hvd24gaW4gZnVsbC5cbiAqIElkbGUgbm90aWZpY2F0aW9ucyBhcmUgZmlsdGVyZWQgb3V0IGVudGlyZWx5LlxuICovXG5mdW5jdGlvbiBwcm9jZXNzUXVldWVkQ29tbWFuZHMoXG4gIHF1ZXVlZENvbW1hbmRzOiBRdWV1ZWRDb21tYW5kW10sXG4pOiBRdWV1ZWRDb21tYW5kW10ge1xuICAvLyBGaWx0ZXIgb3V0IGlkbGUgbm90aWZpY2F0aW9ucyAtIHRoZXkgYXJlIHByb2Nlc3NlZCBzaWxlbnRseVxuICBjb25zdCBmaWx0ZXJlZENvbW1hbmRzID0gcXVldWVkQ29tbWFuZHMuZmlsdGVyKFxuICAgIGNtZCA9PiB0eXBlb2YgY21kLnZhbHVlICE9PSAnc3RyaW5nJyB8fCAhaXNJZGxlTm90aWZpY2F0aW9uKGNtZC52YWx1ZSksXG4gIClcblxuICAvLyBTZXBhcmF0ZSB0YXNrIG5vdGlmaWNhdGlvbnMgZnJvbSBvdGhlciBjb21tYW5kc1xuICBjb25zdCB0YXNrTm90aWZpY2F0aW9ucyA9IGZpbHRlcmVkQ29tbWFuZHMuZmlsdGVyKFxuICAgIGNtZCA9PiBjbWQubW9kZSA9PT0gJ3Rhc2stbm90aWZpY2F0aW9uJyxcbiAgKVxuICBjb25zdCBvdGhlckNvbW1hbmRzID0gZmlsdGVyZWRDb21tYW5kcy5maWx0ZXIoXG4gICAgY21kID0+IGNtZC5tb2RlICE9PSAndGFzay1ub3RpZmljYXRpb24nLFxuICApXG5cbiAgLy8gSWYgbm90aWZpY2F0aW9ucyBmaXQgd2l0aGluIGxpbWl0LCByZXR1cm4gYWxsIGNvbW1hbmRzIGFzLWlzXG4gIGlmICh0YXNrTm90aWZpY2F0aW9ucy5sZW5ndGggPD0gTUFYX1ZJU0lCTEVfTk9USUZJQ0FUSU9OUykge1xuICAgIHJldHVybiBbLi4ub3RoZXJDb21tYW5kcywgLi4udGFza05vdGlmaWNhdGlvbnNdXG4gIH1cblxuICAvLyBTaG93IGZpcnN0IChNQVhfVklTSUJMRV9OT1RJRklDQVRJT05TIC0gMSkgbm90aWZpY2F0aW9ucywgdGhlbiBhIHN1bW1hcnlcbiAgY29uc3QgdmlzaWJsZU5vdGlmaWNhdGlvbnMgPSB0YXNrTm90aWZpY2F0aW9ucy5zbGljZShcbiAgICAwLFxuICAgIE1BWF9WSVNJQkxFX05PVElGSUNBVElPTlMgLSAxLFxuICApXG4gIGNvbnN0IG92ZXJmbG93Q291bnQgPVxuICAgIHRhc2tOb3RpZmljYXRpb25zLmxlbmd0aCAtIChNQVhfVklTSUJMRV9OT1RJRklDQVRJT05TIC0gMSlcblxuICAvLyBDcmVhdGUgc3ludGhldGljIG92ZXJmbG93IG1lc3NhZ2VcbiAgY29uc3Qgb3ZlcmZsb3dDb21tYW5kOiBRdWV1ZWRDb21tYW5kID0ge1xuICAgIHZhbHVlOiBjcmVhdGVPdmVyZmxvd05vdGlmaWNhdGlvbk1lc3NhZ2Uob3ZlcmZsb3dDb3VudCksXG4gICAgbW9kZTogJ3Rhc2stbm90aWZpY2F0aW9uJyxcbiAgfVxuXG4gIHJldHVybiBbLi4ub3RoZXJDb21tYW5kcywgLi4udmlzaWJsZU5vdGlmaWNhdGlvbnMsIG92ZXJmbG93Q29tbWFuZF1cbn1cblxuZnVuY3Rpb24gUHJvbXB0SW5wdXRRdWV1ZWRDb21tYW5kc0ltcGwoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgcXVldWVkQ29tbWFuZHMgPSB1c2VDb21tYW5kUXVldWUoKVxuICBjb25zdCB2aWV3aW5nQWdlbnQgPSB1c2VBcHBTdGF0ZShzID0+ICEhcy52aWV3aW5nQWdlbnRUYXNrSWQpXG4gIC8vIEJyaWVmIGxheW91dDogZGltIHF1ZXVlIGl0ZW1zICsgc2tpcCB0aGUgcGFkZGluZ1ggKGJyaWVmIG1lc3NhZ2VzXG4gIC8vIGFscmVhZHkgaW5kZW50IHRoZW1zZWx2ZXMpLiBHYXRlIG1pcnJvcnMgdGhlIGJyaWVmLXNwaW5uZXIvbWVzc2FnZVxuICAvLyBjaGVjayBlbHNld2hlcmUg4oCUIG5vIHRlYW1tYXRlLXZpZXcgb3ZlcnJpZGUgbmVlZGVkIHNpbmNlIHRoaXNcbiAgLy8gY29tcG9uZW50IGVhcmx5LXJldHVybnMgd2hlbiB2aWV3aW5nIGEgdGVhbW1hdGUuXG4gIGNvbnN0IHVzZUJyaWVmTGF5b3V0ID1cbiAgICBmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKVxuICAgICAgPyAvLyBiaW9tZS1pZ25vcmUgbGludC9jb3JyZWN0bmVzcy91c2VIb29rQXRUb3BMZXZlbDogZmVhdHVyZSgpIGlzIGEgY29tcGlsZS10aW1lIGNvbnN0YW50XG4gICAgICAgIHVzZUFwcFN0YXRlKHMgPT4gcy5pc0JyaWVmT25seSlcbiAgICAgIDogZmFsc2VcblxuICAvLyBjcmVhdGVVc2VyTWVzc2FnZSBtaW50cyBhIGZyZXNoIFVVSUQgcGVyIGNhbGw7IHdpdGhvdXQgbWVtb2l6YXRpb24sIHN0cmVhbWluZ1xuICAvLyByZS1yZW5kZXJzIGRlZmVhdCBNZXNzYWdlJ3MgYXJlTWVzc2FnZVByb3BzRXF1YWwgKGNvbXBhcmVzIHV1aWQpIOKGkiBmbGlja2VyLlxuICBjb25zdCBtZXNzYWdlcyA9IHVzZU1lbW8oKCkgPT4ge1xuICAgIGlmIChxdWV1ZWRDb21tYW5kcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsXG4gICAgLy8gdGFzay1ub3RpZmljYXRpb24gaXMgc2hvd24gdmlhIHVzZUluYm94Tm90aWZpY2F0aW9uOyBtb3N0IGlzTWV0YSBjb21tYW5kc1xuICAgIC8vIChzY2hlZHVsZWQgdGFza3MsIHByb2FjdGl2ZSB0aWNrcykgYXJlIHN5c3RlbS1nZW5lcmF0ZWQgYW5kIGhpZGRlbi5cbiAgICAvLyBDaGFubmVsIG1lc3NhZ2VzIGFyZSB0aGUgZXhjZXB0aW9uIOKAlCBpc01ldGEgYnV0IHNob3duIHNvIHRoZSBrZXlib2FyZFxuICAgIC8vIHVzZXIgc2VlcyB3aGF0IGFycml2ZWQuXG4gICAgY29uc3QgdmlzaWJsZUNvbW1hbmRzID0gcXVldWVkQ29tbWFuZHMuZmlsdGVyKGlzUXVldWVkQ29tbWFuZFZpc2libGUpXG4gICAgaWYgKHZpc2libGVDb21tYW5kcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsXG4gICAgY29uc3QgcHJvY2Vzc2VkQ29tbWFuZHMgPSBwcm9jZXNzUXVldWVkQ29tbWFuZHModmlzaWJsZUNvbW1hbmRzKVxuICAgIHJldHVybiBub3JtYWxpemVNZXNzYWdlcyhcbiAgICAgIHByb2Nlc3NlZENvbW1hbmRzLm1hcChjbWQgPT4ge1xuICAgICAgICBsZXQgY29udGVudCA9IGNtZC52YWx1ZVxuICAgICAgICBpZiAoY21kLm1vZGUgPT09ICdiYXNoJyAmJiB0eXBlb2YgY29udGVudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBjb250ZW50ID0gYDxiYXNoLWlucHV0PiR7Y29udGVudH08L2Jhc2gtaW5wdXQ+YFxuICAgICAgICB9XG4gICAgICAgIC8vIFtJbWFnZSAjTl0gcGxhY2Vob2xkZXJzIGFyZSBpbmxpbmUgaW4gdGhlIHRleHQgdmFsdWUgKGluc2VydGVkIGF0XG4gICAgICAgIC8vIHBhc3RlIHRpbWUpLCBzbyB0aGUgcXVldWUgcHJldmlldyBzaG93cyB0aGVtIHdpdGhvdXQgc3R1YiBibG9ja3MuXG4gICAgICAgIHJldHVybiBjcmVhdGVVc2VyTWVzc2FnZSh7IGNvbnRlbnQgfSlcbiAgICAgIH0pLFxuICAgIClcbiAgfSwgW3F1ZXVlZENvbW1hbmRzXSlcblxuICAvLyBEb24ndCBzaG93IGxlYWRlcidzIHF1ZXVlZCBjb21tYW5kcyB3aGVuIHZpZXdpbmcgYW55IGFnZW50J3MgdHJhbnNjcmlwdFxuICBpZiAodmlld2luZ0FnZW50IHx8IG1lc3NhZ2VzID09PSBudWxsKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBtYXJnaW5Ub3A9ezF9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgIHttZXNzYWdlcy5tYXAoKG1lc3NhZ2UsIGkpID0+IChcbiAgICAgICAgPFF1ZXVlZE1lc3NhZ2VQcm92aWRlclxuICAgICAgICAgIGtleT17aX1cbiAgICAgICAgICBpc0ZpcnN0PXtpID09PSAwfVxuICAgICAgICAgIHVzZUJyaWVmTGF5b3V0PXt1c2VCcmllZkxheW91dH1cbiAgICAgICAgPlxuICAgICAgICAgIDxNZXNzYWdlXG4gICAgICAgICAgICBtZXNzYWdlPXttZXNzYWdlfVxuICAgICAgICAgICAgbG9va3Vwcz17RU1QVFlfTE9PS1VQU31cbiAgICAgICAgICAgIGFkZE1hcmdpbj17ZmFsc2V9XG4gICAgICAgICAgICB0b29scz17W119XG4gICAgICAgICAgICBjb21tYW5kcz17W119XG4gICAgICAgICAgICB2ZXJib3NlPXtmYWxzZX1cbiAgICAgICAgICAgIGluUHJvZ3Jlc3NUb29sVXNlSURzPXtFTVBUWV9TRVR9XG4gICAgICAgICAgICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZT17W119XG4gICAgICAgICAgICBzaG91bGRBbmltYXRlPXtmYWxzZX1cbiAgICAgICAgICAgIHNob3VsZFNob3dEb3Q9e2ZhbHNlfVxuICAgICAgICAgICAgaXNUcmFuc2NyaXB0TW9kZT17ZmFsc2V9XG4gICAgICAgICAgICBpc1N0YXRpYz17dHJ1ZX1cbiAgICAgICAgICAvPlxuICAgICAgICA8L1F1ZXVlZE1lc3NhZ2VQcm92aWRlcj5cbiAgICAgICkpfVxuICAgIDwvQm94PlxuICApXG59XG5cbmV4cG9ydCBjb25zdCBQcm9tcHRJbnB1dFF1ZXVlZENvbW1hbmRzID0gUmVhY3QubWVtbyhcbiAgUHJvbXB0SW5wdXRRdWV1ZWRDb21tYW5kc0ltcGwsXG4pXG4iXSwibWFwcGluZ3MiOiJBQUFBLFNBQVNBLE9BQU8sUUFBUSxZQUFZO0FBQ3BDLE9BQU8sS0FBS0MsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsT0FBTyxRQUFRLE9BQU87QUFDL0IsU0FBU0MsR0FBRyxRQUFRLFlBQVk7QUFDaEMsU0FBU0MsV0FBVyxRQUFRLHVCQUF1QjtBQUNuRCxTQUNFQyxVQUFVLEVBQ1ZDLFdBQVcsRUFDWEMscUJBQXFCLFFBQ2hCLHdCQUF3QjtBQUMvQixTQUFTQyxxQkFBcUIsUUFBUSx1Q0FBdUM7QUFDN0UsU0FBU0MsZUFBZSxRQUFRLGdDQUFnQztBQUNoRSxjQUFjQyxhQUFhLFFBQVEsK0JBQStCO0FBQ2xFLFNBQVNDLHNCQUFzQixRQUFRLG9DQUFvQztBQUMzRSxTQUNFQyxp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
