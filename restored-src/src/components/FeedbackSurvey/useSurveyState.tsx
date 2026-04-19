/**
 * useSurveyState.tsx — 调查状态机 Hook
 *
 * 在 Claude Code 系统流程中的位置：
 *   useFeedbackSurvey / useMemorySurvey / usePostCompactSurvey
 *   → useSurveyState → 管理调查 UI 状态机及生命周期回调
 *
 * 主要功能：
 *   useSurveyState：所有调查类型（反馈调查、记忆调查、后压缩调查）共用的状态机 Hook，
 *   管理从 closed → open → thanks/transcript_prompt → submitting/submitted → closed
 *   的完整状态流转，并在各关键节点触发上层传入的生命周期回调。
 *
 * 设计要点：
 *   - appearanceId：每次 open() 时生成新的 randomUUID，作为本次展示的唯一关联键
 *   - lastResponseRef：保存最新用户选择，供异步转录提交时使用（避免 closure 捕获旧值）
 *   - showThanksThenClose / showSubmittedThenClose：带 setTimeout 的自动关闭序列
 *   - handleSelect 返回 boolean，指示是否已切换至转录提示状态
 */
import { randomUUID } from 'crypto';
import { useCallback, useRef, useState } from 'react';
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js';
import type { FeedbackSurveyResponse } from './utils.js';

// 调查 UI 的所有可能状态：
//   closed          → 调查不可见（初始态 / 最终态）
//   open            → 正在展示调查问卷
//   thanks          → 展示感谢提示（过渡态，hideThanksAfterMs 后自动关闭）
//   transcript_prompt → 正在询问用户是否共享转录
//   submitting      → 正在异步提交转录（加载中）
//   submitted       → 转录提交成功（过渡态，hideThanksAfterMs 后自动关闭）
type SurveyState = 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';

type UseSurveyStateOptions = {
  // 感谢/提交成功提示的展示时长（毫秒），超时后自动回到 closed
  hideThanksAfterMs: number;
  // 调查打开时触发，传入本次 appearanceId
  onOpen: (appearanceId: string) => void | Promise<void>;
  // 用户选择调查选项时触发，传入 appearanceId 和选择内容
  onSelect: (appearanceId: string, selected: FeedbackSurveyResponse) => void | Promise<void>;
  // 可选：根据用户选择决定是否展示转录共享提示
  shouldShowTranscriptPrompt?: (selected: FeedbackSurveyResponse) => boolean;
  // 可选：转录共享提示展示后触发（用于日志记录）
  onTranscriptPromptShown?: (appearanceId: string, surveyResponse: FeedbackSurveyResponse) => void;
  // 可选：用户做出转录共享选择后触发，返回 true 表示提交成功
  onTranscriptSelect?: (appearanceId: string, selected: TranscriptShareResponse, surveyResponse: FeedbackSurveyResponse | null) => boolean | Promise<boolean>;
};

/**
 * useSurveyState
 *
 * 整体流程：
 *   1. 使用 useState 维护当前调查 UI 状态（SurveyState）和上一次用户选择（lastResponse）
 *   2. appearanceId ref 在每次 open() 时更新为新 UUID，贯穿整次调查会话
 *   3. lastResponseRef 同步保存用户最新选择，供异步回调安全读取
 *   4. 对外暴露 open / handleSelect / handleTranscriptSelect 三个操作函数
 *
 * 在系统中的角色：
 *   是所有调查类型的底层状态机，上层 Hook（useFeedbackSurvey 等）只需
 *   注入生命周期回调，无需关心状态流转细节。
 */
export function useSurveyState({
  hideThanksAfterMs,
  onOpen,
  onSelect,
  shouldShowTranscriptPrompt,
  onTranscriptPromptShown,
  onTranscriptSelect
}: UseSurveyStateOptions): {
  state: SurveyState;
  lastResponse: FeedbackSurveyResponse | null;
  open: () => void;
  handleSelect: (selected: FeedbackSurveyResponse) => boolean;
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void;
} {
  // 当前调查 UI 状态，驱动上层组件的渲染分支
  const [state, setState] = useState<SurveyState>('closed');
  // 最近一次用户选择（React state，用于 UI 渲染）
  const [lastResponse, setLastResponse] = useState<FeedbackSurveyResponse | null>(null);
  // 本次展示的唯一标识，每次 open() 时重新生成
  const appearanceId = useRef(randomUUID());
  // lastResponse 的 ref 副本，供异步转录提交回调安全读取最新值（避免 stale closure）
  const lastResponseRef = useRef<FeedbackSurveyResponse | null>(null);

  /**
   * showThanksThenClose
   *
   * 整体流程：
   *   1. 立即将状态切换至 'thanks'（展示感谢提示）
   *   2. hideThanksAfterMs 后通过 setTimeout 将状态切回 'closed' 并清空 lastResponse
   *      （将 setState/setLastResponse 作为参数传入，避免 closure 捕获旧引用）
   *
   * 在系统中的角色：
   *   用于"用户选择非转录共享路径"或"转录提交失败"时的统一关闭序列。
   */
  const showThanksThenClose = useCallback(() => {
    // 立即展示感谢提示
    setState('thanks');
    // 延迟后自动关闭，同时清空上次选择
    setTimeout((setState_0, setLastResponse_0) => {
      setState_0('closed');
      setLastResponse_0(null);
    }, hideThanksAfterMs, setState, setLastResponse);
  }, [hideThanksAfterMs]);

  /**
   * showSubmittedThenClose
   *
   * 整体流程：
   *   1. 立即将状态切换至 'submitted'（展示提交成功提示）
   *   2. hideThanksAfterMs 后将状态切回 'closed'
   *
   * 在系统中的角色：
   *   用于"转录提交成功"时的专用关闭序列，与 showThanksThenClose 的区别
   *   在于不清空 lastResponse（'submitted' 态无需再读取它）。
   */
  const showSubmittedThenClose = useCallback(() => {
    // 立即展示提交成功提示
    setState('submitted');
    // 延迟后自动关闭
    setTimeout(setState, hideThanksAfterMs, 'closed');
  }, [hideThanksAfterMs]);

  /**
   * open
   *
   * 整体流程：
   *   1. 幂等检查：若当前状态非 'closed'，直接返回（防止重复打开）
   *   2. 切换状态至 'open'
   *   3. 生成新的 appearanceId（UUID），作为本次展示的唯一关联键
   *   4. 调用 onOpen 回调（通常用于记录曝光事件）
   *
   * 在系统中的角色：
   *   由上层 Hook 在满足展示条件后调用，启动本次调查会话。
   */
  const open = useCallback(() => {
    // 幂等保护：只有在 closed 状态下才允许打开
    if (state !== 'closed') {
      return;
    }
    // 切换至打开状态
    setState('open');
    // 为本次展示生成新的唯一标识
    appearanceId.current = randomUUID();
    // 触发打开回调（如记录展示事件）
    void onOpen(appearanceId.current);
  }, [state, onOpen]);

  /**
   * handleSelect
   *
   * 整体流程：
   *   1. 同步更新 lastResponse state 和 lastResponseRef（双写保证 UI 和异步回调都能读到最新值）
   *   2. 立即触发 onSelect 回调（不等待状态流转）
   *   3. 根据选择内容进行状态路由：
   *      a. 'dismissed' → 直接关闭，清空 lastResponse
   *      b. shouldShowTranscriptPrompt(selected) 为 true → 切换至转录提示，触发 onTranscriptPromptShown，返回 true
   *      c. 其他选择 → 调用 showThanksThenClose，返回 false
   *
   * 在系统中的角色：
   *   是调查问卷的核心响应入口，返回值 boolean 告知上层是否已显示转录提示。
   */
  const handleSelect = useCallback((selected: FeedbackSurveyResponse): boolean => {
    // 双写：React state（驱动 UI）和 ref（供异步回调安全读取）
    setLastResponse(selected);
    lastResponseRef.current = selected;
    // 优先触发调查响应事件（在状态流转前）
    void onSelect(appearanceId.current, selected);
    if (selected === 'dismissed') {
      // 用户主动关闭：直接回到 closed 并清空响应
      setState('closed');
      setLastResponse(null);
    } else if (shouldShowTranscriptPrompt?.(selected)) {
      // 符合转录共享条件：切换至转录提示状态
      setState('transcript_prompt');
      // 触发转录提示曝光回调（用于日志记录）
      onTranscriptPromptShown?.(appearanceId.current, selected);
      return true; // 告知上层已显示转录提示
    } else {
      // 普通选择：展示感谢提示后关闭
      showThanksThenClose();
    }
    return false; // 未显示转录提示
  }, [showThanksThenClose, onSelect, shouldShowTranscriptPrompt, onTranscriptPromptShown]);

  /**
   * handleTranscriptSelect
   *
   * 整体流程：
   *   switch (selected)：
   *   case 'yes'：
   *     1. 立即切换至 'submitting' 状态（展示加载态）
   *     2. 启动异步 IIFE：
   *        a. 调用 onTranscriptSelect（实际执行转录上传）
   *        b. 成功（success=true）→ showSubmittedThenClose
   *        c. 失败（success=false 或抛异常）→ showThanksThenClose（降级）
   *   case 'no' / 'dont_ask_again'：
   *     1. 触发 onTranscriptSelect 回调（记录拒绝事件，不等待）
   *     2. 调用 showThanksThenClose（直接展示感谢提示）
   *
   * 在系统中的角色：
   *   是转录共享提示的响应处理器，封装了提交、成功、失败、拒绝四种路径的状态管理。
   */
  const handleTranscriptSelect = useCallback((selected_0: TranscriptShareResponse) => {
    switch (selected_0) {
      case 'yes':
        // 切换至提交中状态，防止用户重复操作
        setState('submitting');
        // 异步执行转录上传，不阻塞 UI
        void (async () => {
          try {
            const success = await onTranscriptSelect?.(appearanceId.current, selected_0, lastResponseRef.current);
            if (success) {
              // 提交成功：展示成功提示后关闭
              showSubmittedThenClose();
            } else {
              // 提交失败（服务端返回非成功）：降级展示感谢提示
              showThanksThenClose();
            }
          } catch {
            // 提交异常：降级展示感谢提示，避免状态卡在 'submitting'
            showThanksThenClose();
          }
        })();
        break;
      case 'no':
      case 'dont_ask_again':
        // 用户拒绝共享：触发回调记录事件（fire-and-forget）
        void onTranscriptSelect?.(appearanceId.current, selected_0, lastResponseRef.current);
        // 直接展示感谢提示后关闭
        showThanksThenClose();
        break;
    }
  }, [showThanksThenClose, showSubmittedThenClose, onTranscriptSelect]);

  return {
    state,
    lastResponse,
    open,
    handleSelect,
    handleTranscriptSelect
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJyYW5kb21VVUlEIiwidXNlQ2FsbGJhY2siLCJ1c2VSZWYiLCJ1c2VTdGF0ZSIsIlRyYW5zY3JpcHRTaGFyZVJlc3BvbnNlIiwiRmVlZGJhY2tTdXJ2ZXlSZXNwb25zZSIsIlN1cnZleVN0YXRlIiwiVXNlU3VydmV5U3RhdGVPcHRpb25zIiwiaGlkZVRoYW5rc0FmdGVyTXMiLCJvbk9wZW4iLCJhcHBlYXJhbmNlSWQiLCJQcm9taXNlIiwib25TZWxlY3QiLCJzZWxlY3RlZCIsInNob3VsZFNob3dUcmFuc2NyaXB0UHJvbXB0Iiwib25UcmFuc2NyaXB0UHJvbXB0U2hvd24iLCJzdXJ2ZXlSZXNwb25zZSIsIm9uVHJhbnNjcmlwdFNlbGVjdCIsInVzZVN1cnZleVN0YXRlIiwic3RhdGUiLCJsYXN0UmVzcG9uc2UiLCJvcGVuIiwiaGFuZGxlU2VsZWN0IiwiaGFuZGxlVHJhbnNjcmlwdFNlbGVjdCIsInNldFN0YXRlIiwic2V0TGFzdFJlc3BvbnNlIiwibGFzdFJlc3BvbnNlUmVmIiwic2hvd1RoYW5rc1RoZW5DbG9zZSIsInNldFRpbWVvdXQiLCJzaG93U3VibWl0dGVkVGhlbkNsb3NlIiwiY3VycmVudCIsInN1Y2Nlc3MiXSwic291cmNlcyI6WyJ1c2VTdXJ2ZXlTdGF0ZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ2NyeXB0bydcbmltcG9ydCB7IHVzZUNhbGxiYWNrLCB1c2VSZWYsIHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgdHlwZSB7IFRyYW5zY3JpcHRTaGFyZVJlc3BvbnNlIH0gZnJvbSAnLi9UcmFuc2NyaXB0U2hhcmVQcm9tcHQuanMnXG5pbXBvcnQgdHlwZSB7IEZlZWRiYWNrU3VydmV5UmVzcG9uc2UgfSBmcm9tICcuL3V0aWxzLmpzJ1xuXG50eXBlIFN1cnZleVN0YXRlID1cbiAgfCAnY2xvc2VkJ1xuICB8ICdvcGVuJ1xuICB8ICd0aGFua3MnXG4gIHwgJ3RyYW5zY3JpcHRfcHJvbXB0J1xuICB8ICdzdWJtaXR0aW5nJ1xuICB8ICdzdWJtaXR0ZWQnXG5cbnR5cGUgVXNlU3VydmV5U3RhdGVPcHRpb25zID0ge1xuICBoaWRlVGhhbmtzQWZ0ZXJNczogbnVtYmVyXG4gIG9uT3BlbjogKGFwcGVhcmFuY2VJZDogc3RyaW5nKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPlxuICBvblNlbGVjdDogKFxuICAgIGFwcGVhcmFuY2VJZDogc3RyaW5nLFxuICAgIHNlbGVjdGVkOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlLFxuICApID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+XG4gIHNob3VsZFNob3dUcmFuc2NyaXB0UHJvbXB0PzogKHNlbGVjdGVkOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlKSA9PiBib29sZWFuXG4gIG9uVHJhbnNjcmlwdFByb21wdFNob3duPzogKFxuICAgIGFwcGVhcmFuY2VJZDogc3RyaW5nLFxuICAgIHN1cnZleVJlc3BvbnNlOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlLFxuICApID0+IHZvaWRcbiAgb25UcmFuc2NyaXB0U2VsZWN0PzogKFxuICAgIGFwcGVhcmFuY2VJZDogc3RyaW5nLFxuICAgIHNlbGVjdGVkOiBUcmFuc2NyaXB0U2hhcmVSZXNwb25zZSxcbiAgICBzdXJ2ZXlSZXNwb25zZTogRmVlZGJhY2tTdXJ2ZXlSZXNwb25zZSB8IG51bGwsXG4gICkgPT4gYm9vbGVhbiB8IFByb21pc2U8Ym9vbGVhbj5cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVzZVN1cnZleVN0YXRlKHtcbiAgaGlkZVRoYW5rc0FmdGVyTXMsXG4gIG9uT3BlbixcbiAgb25TZWxlY3QsXG4gIHNob3VsZFNob3dUcmFuc2NyaXB0UHJvbXB0LFxuICBvblRyYW5zY3JpcHRQcm9tcHRTaG93bixcbiAgb25UcmFuc2NyaXB0U2VsZWN0LFxufTogVXNlU3VydmV5U3RhdGVPcHRpb25zKToge1xuICBzdGF0ZTogU3VydmV5U3RhdGVcbiAgbGFzdFJlc3BvbnNlOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlIHwgbnVsbFxuICBvcGVuOiAoKSA9PiB2b2lkXG4gIGhhbmRsZVNlbGVjdDogKHNlbGVjdGVkOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlKSA9PiBib29sZWFuXG4gIGhhbmRsZVRyYW5zY3JpcHRTZWxlY3Q6IChzZWxlY3RlZDogVHJhbnNjcmlwdFNoYXJlUmVzcG9uc2UpID0+IHZvaWRcbn0ge1xuICBjb25zdCBbc3RhdGUsIHNldFN0YXRlXSA9IHVzZVN0YXRlPFN1cnZleVN0YXRlPignY2xvc2VkJylcbiAgY29uc3QgW2xhc3RSZXNwb25zZSwgc2V0TGFzdFJlc3BvbnNlXSA9XG4gICAgdXNlU3RhdGU8RmVlZGJhY2tTdXJ2ZXlSZXNwb25zZSB8IG51bGw+KG51bGwpXG4gIGNvbnN0IGFwcGVhcmFuY2VJZCA9IHVzZVJlZihyYW5kb21VVUlEKCkpXG4gIGNvbnN0IGxhc3RSZXNwb25zZVJlZiA9IHVzZVJlZjxGZWVkYmFja1N1cnZleVJlc3BvbnNlIHwgbnVsbD4obnVsbClcblxuICBjb25zdCBzaG93VGhhbmtzVGhlbkNsb3NlID0gdXNlQ2FsbGJhY2soKCkgPT4ge1xuICAgIHNldFN0YXRlKCd0aGFua3MnKVxuICAgIHNldFRpbWVvdXQoXG4gICAgICAoc2V0U3RhdGUsIHNldExhc3RSZXNwb25zZSkgPT4ge1xuICAgICAgICBzZXRTdGF0ZSgnY2xvc2VkJylcbiAgICAgICAgc2V0TGFzdFJlc3BvbnNlKG51bGwpXG4gICAgICB9LFxuICAgICAgaGlkZVRoYW5rc0FmdGVyTXMsXG4gICAgICBzZXRTdGF0ZSxcbiAgICAgIHNldExhc3RSZXNwb25zZSxcbiAgICApXG4gIH0sIFtoaWRlVGhhbmtzQWZ0ZXJNc10pXG5cbiAgY29uc3Qgc2hvd1N1Ym1pdHRlZFRoZW5DbG9zZSA9IHVzZUNhbGxiYWNrKCgpID0+IHtcbiAgICBzZXRTdGF0ZSgnc3VibWl0dGVkJylcbiAgICBzZXRUaW1lb3V0KHNldFN0YXRlLCBoaWRlVGhhbmtzQWZ0ZXJNcywgJ2Nsb3NlZCcpXG4gIH0sIFtoaWRlVGhhbmtzQWZ0ZXJNc10pXG5cbiAgY29uc3Qgb3BlbiA9IHVzZUNhbGxiYWNrKCgpID0+IHtcbiAgICBpZiAoc3RhdGUgIT09ICdjbG9zZWQnKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgc2V0U3RhdGUoJ29wZW4nKVxuICAgIGFwcGVhcmFuY2VJZC5jdXJyZW50ID0gcmFuZG9tVVVJRCgpXG4gICAgdm9pZCBvbk9wZW4oYXBwZWFyYW5jZUlkLmN1cnJlbnQpXG4gIH0sIFtzdGF0ZSwgb25PcGVuXSlcblxuICBjb25zdCBoYW5kbGVTZWxlY3QgPSB1c2VDYWxsYmFjayhcbiAgICAoc2VsZWN0ZWQ6IEZlZWRiYWNrU3VydmV5UmVzcG9uc2UpOiBib29sZWFuID0+IHtcbiAgICAgIHNldExhc3RSZXNwb25zZShzZWxlY3RlZClcbiAgICAgIGxhc3RSZXNwb25zZVJlZi5jdXJyZW50ID0gc2VsZWN0ZWRcbiAgICAgIC8vIEFsd2F5cyBmaXJlIHRoZSBzdXJ2ZXkgcmVzcG9uc2UgZXZlbnQgZmlyc3RcbiAgICAgIHZvaWQgb25TZWxlY3QoYXBwZWFyYW5jZUlkLmN1cnJlbnQsIHNlbGVjdGVkKVxuXG4gICAgICBpZiAoc2VsZWN0ZWQgPT09ICdkaXNtaXNzZWQnKSB7XG4gICAgICAgIHNldFN0YXRlKCdjbG9zZWQnKVxuICAgICAgICBzZXRMYXN0UmVzcG9uc2UobnVsbClcbiAgICAgIH0gZWxzZSBpZiAoc2hvdWxkU2hvd1RyYW5zY3JpcHRQcm9tcHQ/LihzZWxlY3RlZCkpIHtcbiAgICAgICAgc2V0U3RhdGUoJ3RyYW5zY3JpcHRfcHJvbXB0JylcbiAgICAgICAgb25UcmFuc2NyaXB0UHJvbXB0U2hvd24/LihhcHBlYXJhbmNlSWQuY3VycmVudCwgc2VsZWN0ZWQpXG4gICAgICAgIHJldHVybiB0cnVlXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzaG93VGhhbmtzVGhlbkNsb3NlKClcbiAgICAgIH1cbiAgICAgIHJldHVybiBmYWxzZVxuICAgIH0sXG4gICAgW1xuICAgICAgc2hvd1RoYW5rc1RoZW5DbG9zZSxcbiAgICAgIG9uU2VsZWN0LFxuICAgICAgc2hvdWxkU2hvd1RyYW5zY3JpcHRQcm9tcHQsXG4gICAgICBvblRyYW5zY3JpcHRQcm9tcHRTaG93bixcbiAgICBdLFxuICApXG5cbiAgY29uc3QgaGFuZGxlVHJhbnNjcmlwdFNlbGVjdCA9IHVzZUNhbGxiYWNrKFxuICAgIChzZWxlY3RlZDogVHJhbnNjcmlwdFNoYXJlUmVzcG9uc2UpID0+IHtcbiAgICAgIHN3aXRjaCAoc2VsZWN0ZWQpIHtcbiAgICAgICAgY2FzZSAneWVzJzpcbiAgICAgICAgICBzZXRTdGF0ZSgnc3VibWl0dGluZycpXG4gICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3Qgc3VjY2VzcyA9IGF3YWl0IG9uVHJhbnNjcmlwdFNlbGVjdD8uKFxuICAgICAgICAgICAgICAgIGFwcGVhcmFuY2VJZC5jdXJyZW50LFxuICAgICAgICAgICAgICAgIHNlbGVjdGVkLFxuICAgICAgICAgICAgICAgIGxhc3RSZXNwb25zZVJlZi5jdXJyZW50LFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICAgICAgc2hvd1N1Ym1pdHRlZFRoZW5DbG9zZSgpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2hvd1RoYW5rc1RoZW5DbG9zZSgpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICBzaG93VGhhbmtzVGhlbkNsb3NlKClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KSgpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgY2FzZSAnbm8nOlxuICAgICAgICBjYXNlICdkb250X2Fza19hZ2Fpbic6XG4gICAgICAgICAgdm9pZCBvblRyYW5zY3JpcHRTZWxlY3Q/LihcbiAgICAgICAgICAgIGFwcGVhcmFuY2VJZC5jdXJyZW50LFxuICAgICAgICAgICAgc2VsZWN0ZWQsXG4gICAgICAgICAgICBsYXN0UmVzcG9uc2VSZWYuY3VycmVudCxcbiAgICAgICAgICApXG4gICAgICAgICAgc2hvd1RoYW5rc1RoZW5DbG9zZSgpXG4gICAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICB9LFxuICAgIFtzaG93VGhhbmtzVGhlbkNsb3NlLCBzaG93U3VibWl0dGVkVGhlbkNsb3NlLCBvblRyYW5zY3JpcHRTZWxlY3RdLFxuICApXG5cbiAgcmV0dXJuIHsgc3RhdGUsIGxhc3RSZXNwb25zZSwgb3BlbiwgaGFuZGxlU2VsZWN0LCBoYW5kbGVUcmFuc2NyaXB0U2VsZWN0IH1cbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsU0FBU0EsVUFBVSxRQUFRLFFBQVE7QUFDbkMsU0FBU0MsV0FBVyxFQUFFQyxNQUFNLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ3JELGNBQWNDLHVCQUF1QixRQUFRLDRCQUE0QjtBQUN6RSxjQUFjQyxzQkFBc0IsUUFBUSxZQUFZO0FBRXhELEtBQUtDLFdBQVcsR0FDWixRQUFRLEdBQ1IsTUFBTSxHQUNOLFFBQVEsR0FDUixtQkFBbUIsR0FDbkIsWUFBWSxHQUNaLFdBQVc7QUFFZixLQUFLQyxxQkFBcUIsR0FBRztFQUMzQkMsaUJBQWlCLEVBQUUsTUFBTTtFQUN6QkMsTUFBTSxFQUFFLENBQUNDLFlBQVksRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxJQUFJLENBQUM7RUFDdERDLFFBQVEsRUFBRSxDQUNSRixZQUFZLEVBQUUsTUFBTSxFQUNwQkcsUUFBUSxFQUFFUixzQkFBc0IsRUFDaEMsR0FBRyxJQUFJLEdBQUdNLE9BQU8sQ0FBQyxJQUFJLENBQUM7RUFDekJHLDBCQUEwQixDQUFDLEVBQUUsQ0FBQ0QsUUFBUSxFQUFFUixzQkFBc0IsRUFBRSxHQUFHLE9BQU87RUFDMUVVLHVCQUF1QixDQUFDLEVBQUUsQ0FDeEJMLFlBQVksRUFBRSxNQUFNLEVBQ3BCTSxjQUFjLEVBQUVYLHNCQUFzQixFQUN0QyxHQUFHLElBQUk7RUFDVFksa0JBQWtCLENBQUMsRUFBRSxDQUNuQlAsWUFBWSxFQUFFLE1BQU0sRUFDcEJHLFFBQVEsRUFBRVQsdUJBQXVCLEVBQ2pDWSxjQUFjLEVBQUVYLHNCQUFzQixHQUFHLElBQUksRUFDN0MsR0FBRyxPQUFPLEdBQUdNLE9BQU8sQ0FBQyxPQUFPLENBQUM7QUFDakMsQ0FBQztBQUVELE9BQU8sU0FBU08sY0FBY0EsQ0FBQztFQUM3QlYsaUJBQWlCO0VBQ2pCQyxNQUFNO0VBQ05HLFFBQVE7RUFDUkUsMEJBQTBCO0VBQzFCQyx1QkFBdUI7RUFDdkJFO0FBQ3FCLENBQXRCLEVBQUVWLHFCQUFxQixDQUFDLEVBQUU7RUFDekJZLEtBQUssRUFBRWIsV0FBVztFQUNsQmMsWUFBWSxFQUFFZixzQkFBc0IsR0FBRyxJQUFJO0VBQzNDZ0IsSUFBSSxFQUFFLEdBQUcsR0FBRyxJQUFJO0VBQ2hCQyxZQUFZLEVBQUUsQ0FBQ1QsUUFBUSxFQUFFUixzQkFBc0IsRUFBRSxHQUFHLE9BQU87RUFDM0RrQixzQkFBc0IsRUFBRSxDQUFDVixRQUFRLEVBQUVULHVCQUF1QixFQUFFLEdBQUcsSUFBSTtBQUNyRSxDQUFDLENBQUM7RUFDQSxNQUFNLENBQUNlLEtBQUssRUFBRUssUUFBUSxDQUFDLEdBQUdyQixRQUFRLENBQUNHLFdBQVcsQ0FBQyxDQUFDLFFBQVEsQ0FBQztFQUN6RCxNQUFNLENBQUNjLFlBQVksRUFBRUssZUFBZSxDQUFDLEdBQ25DdEIsUUFBUSxDQUFDRSxzQkFBc0IsR0FBRyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7RUFDL0MsTUFBTUssWUFBWSxHQUFHUixNQUFNLENBQUNGLFVBQVUsQ0FBQyxDQUFDLENBQUM7RUFDekMsTUFBTTBCLGVBQWUsR0FBR3hCLE1BQU0sQ0FBQ0csc0JBQXNCLEdBQUcsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDO0VBRW5FLE1BQU1zQixtQkFBbUIsR0FBRzFCLFdBQVcsQ0FBQyxNQUFNO0lBQzVDdUIsUUFBUSxDQUFDLFFBQVEsQ0FBQztJQUNsQkksVUFBVSxDQUNSLENBQUNKLFVBQVEsRUFBRUMsaUJBQWUsS0FBSztNQUM3QkQsVUFBUSxDQUFDLFFBQVEsQ0FBQztNQUNsQkMsaUJBQWUsQ0FBQyxJQUFJLENBQUM7SUFDdkIsQ0FBQyxFQUNEakIsaUJBQWlCLEVBQ2pCZ0IsUUFBUSxFQUNSQyxlQUNGLENBQUM7RUFDSCxDQUFDLEVBQUUsQ0FBQ2pCLGlCQUFpQixDQUFDLENBQUM7RUFFdkIsTUFBTXFCLHNCQUFzQixHQUFHNUIsV0FBVyxDQUFDLE1BQU07SUFDL0N1QixRQUFRLENBQUMsV0FBVyxDQUFDO0lBQ3JCSSxVQUFVLENBQUNKLFFBQVEsRUFBRWhCLGlCQUFpQixFQUFFLFFBQVEsQ0FBQztFQUNuRCxDQUFDLEVBQUUsQ0FBQ0EsaUJBQWlCLENBQUMsQ0FBQztFQUV2QixNQUFNYSxJQUFJLEdBQUdwQixXQUFXLENBQUMsTUFBTTtJQUM3QixJQUFJa0IsS0FBSyxLQUFLLFFBQVEsRUFBRTtNQUN0QjtJQUNGO0lBQ0FLLFFBQVEsQ0FBQyxNQUFNLENBQUM7SUFDaEJkLFlBQVksQ0FBQ29CLE9BQU8sR0FBRzlCLFVBQVUsQ0FBQyxDQUFDO0lBQ25DLEtBQUtTLE1BQU0sQ0FBQ0MsWUFBWSxDQUFDb0IsT0FBTyxDQUFDO0VBQ25DLENBQUMsRUFBRSxDQUFDWCxLQUFLLEVBQUVWLE1BQU0sQ0FBQyxDQUFDO0VBRW5CLE1BQU1hLFlBQVksR0FBR3JCLFdBQVcsQ0FDOUIsQ0FBQ1ksUUFBUSxFQUFFUixzQkFBc0IsQ0FBQyxFQUFFLE9BQU8sSUFBSTtJQUM3Q29CLGVBQWUsQ0FBQ1osUUFBUSxDQUFDO0lBQ3pCYSxlQUFlLENBQUNJLE9BQU8sR0FBR2pCLFFBQVE7SUFDbEM7SUFDQSxLQUFLRCxRQUFRLENBQUNGLFlBQVksQ0FBQ29CLE9BQU8sRUFBRWpCLFFBQVEsQ0FBQztJQUU3QyxJQUFJQSxRQUFRLEtBQUssV0FBVyxFQUFFO01BQzVCVyxRQUFRLENBQUMsUUFBUSxDQUFDO01BQ2xCQyxlQUFlLENBQUMsSUFBSSxDQUFDO0lBQ3ZCLENBQUMsTUFBTSxJQUFJWCwwQkFBMEIsR0FBR0QsUUFBUSxDQUFDLEVBQUU7TUFDakRXLFFBQVEsQ0FBQyxtQkFBbUIsQ0FBQztNQUM3QlQsdUJBQXVCLEdBQUdMLFlBQVksQ0FBQ29CLE9BQU8sRUFBRWpCLFFBQVEsQ0FBQztNQUN6RCxPQUFPLElBQUk7SUFDYixDQUFDLE1BQU07TUFDTGMsbUJBQW1CLENBQUMsQ0FBQztJQUN2QjtJQUNBLE9BQU8sS0FBSztFQUNkLENBQUMsRUFDRCxDQUNFQSxtQkFBbUIsRUFDbkJmLFFBQVEsRUFDUkUsMEJBQTBCLEVBQzFCQyx1QkFBdUIsQ0FFM0IsQ0FBQztFQUVELE1BQU1RLHNCQUFzQixHQUFHdEIsV0FBVyxDQUN4QyxDQUFDWSxVQUFRLEVBQUVULHVCQUF1QixLQUFLO0lBQ3JDLFFBQVFTLFVBQVE7TUFDZCxLQUFLLEtBQUs7UUFDUlcsUUFBUSxDQUFDLFlBQVksQ0FBQztRQUN0QixLQUFLLENBQUMsWUFBWTtVQUNoQixJQUFJO1lBQ0YsTUFBTU8sT0FBTyxHQUFHLE1BQU1kLGtCQUFrQixHQUN0Q1AsWUFBWSxDQUFDb0IsT0FBTyxFQUNwQmpCLFVBQVEsRUFDUmEsZUFBZSxDQUFDSSxPQUNsQixDQUFDO1lBQ0QsSUFBSUMsT0FBTyxFQUFFO2NBQ1hGLHNCQUFzQixDQUFDLENBQUM7WUFDMUIsQ0FBQyxNQUFNO2NBQ0xGLG1CQUFtQixDQUFDLENBQUM7WUFDdkI7VUFDRixDQUFDLENBQUMsTUFBTTtZQUNOQSxtQkFBbUIsQ0FBQyxDQUFDO1VBQ3ZCO1FBQ0YsQ0FBQyxFQUFFLENBQUM7UUFDSjtNQUNGLEtBQUssSUFBSTtNQUNULEtBQUssZ0JBQWdCO1FBQ25CLEtBQUtWLGtCQUFrQixHQUNyQlAsWUFBWSxDQUFDb0IsT0FBTyxFQUNwQmpCLFVBQVEsRUFDUmEsZUFBZSxDQUFDSSxPQUNsQixDQUFDO1FBQ0RILG1CQUFtQixDQUFDLENBQUM7UUFDckI7SUFDSjtFQUNGLENBQUMsRUFDRCxDQUFDQSxtQkFBbUIsRUFBRUUsc0JBQXNCLEVBQUVaLGtCQUFrQixDQUNsRSxDQUFDO0VBRUQsT0FBTztJQUFFRSxLQUFLO0lBQUVDLFlBQVk7SUFBRUMsSUFBSTtJQUFFQyxZQUFZO0lBQUVDO0VBQXVCLENBQUM7QUFDNUUiLCJpZ25vcmVMaXN0IjpbXX0=
