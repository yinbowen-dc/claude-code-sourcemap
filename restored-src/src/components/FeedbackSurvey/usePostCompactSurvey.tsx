/**
 * usePostCompactSurvey.tsx — 压缩后调查 Hook
 *
 * 在 Claude Code 系统流程中的位置：
 *   会话压缩（Compact）完成 → REPL 检测到压缩边界消息 → usePostCompactSurvey → 在下一条消息后弹出调查
 *
 * 主要功能：
 *   usePostCompactSurvey：自定义 React Hook，
 *   在会话上下文压缩后，以 20% 概率在下一条用户/助手消息到来时弹出满意度调查。
 *   采用"延迟显示"（deferred display）模式：先记录压缩边界 UUID，
 *   等到新消息到来后再决定是否弹出调查，避免在压缩瞬间打断用户。
 *
 * 辅助函数：
 *   hasMessageAfterBoundary：检查指定压缩边界 UUID 之后是否已有用户/助手消息。
 *
 * 事件追踪：
 *   - 事件名：'tengu_post_compact_survey_event'，上报至 Statsig + OTel
 *   - 额外携带 session_memory_compaction_enabled 字段，区分是否启用了会话记忆压缩
 *
 * React 编译器优化说明：
 *   - 通过 _c(23) 创建 23 个缓存槽位，对 options 对象、effect 回调、依赖数组、返回对象进行细粒度缓存
 *   - _temp/_temp2/_temp3/_temp4 为编译器提升的纯函数，避免在每次渲染时重新创建内联函数
 *   - $[2] 使用 sentinel 值保护 Set 初始化，确保 seenCompactBoundaries 的初始 Set 全局唯一
 *   - $[3] 使用 sentinel 值缓存 useSurveyState 的 options 对象（静态，永不变化）
 */
import { c as _c } from "react/compiler-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js';
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { shouldUseSessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js';
import type { Message } from '../../types/message.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isCompactBoundaryMessage } from '../../utils/messages.js';
import { logOTelEvent } from '../../utils/telemetry/events.js';
import { useSurveyState } from './useSurveyState.js';
import type { FeedbackSurveyResponse } from './utils.js';
// 感谢提示展示时长（毫秒）：3 秒后自动关闭
const HIDE_THANKS_AFTER_MS = 3000;
// Statsig 特性门控名称：压缩后调查功能开关
const POST_COMPACT_SURVEY_GATE = 'tengu_post_compact_survey';
// 调查弹出概率：20%，避免对用户造成过多打扰
const SURVEY_PROBABILITY = 0.2; // Show survey 20% of the time after compaction

/**
 * hasMessageAfterBoundary
 *
 * 整体流程：
 *   1. 在 messages 数组中定位压缩边界消息的下标（通过 uuid 匹配）
 *   2. 若找不到边界消息（返回 -1），说明边界已失效，直接返回 false
 *   3. 从边界消息的下一条开始向后遍历，找到第一条 user 或 assistant 消息则返回 true
 *   4. 遍历完毕未命中则返回 false
 *
 * 在系统中的角色：
 *   是"延迟显示"逻辑的核心判断条件：
 *   当 pendingCompactBoundaryUuid 不为空时，usePostCompactSurvey 调用此函数
 *   判断压缩后是否已有新消息到来，若是则决定是否（20% 概率）弹出调查。
 */
function hasMessageAfterBoundary(messages: Message[], boundaryUuid: string): boolean {
  // 找到压缩边界消息的位置
  const boundaryIndex = messages.findIndex(msg => msg.uuid === boundaryUuid);
  // 边界消息不存在（可能已被清理），直接视为无效
  if (boundaryIndex === -1) {
    return false;
  }

  // Check if there's a user or assistant message after the boundary
  // 从边界消息后一位开始遍历，寻找用户或助手消息
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    // 找到 user 或 assistant 类型的消息，说明压缩后已有新交互
    if (msg && (msg.type === 'user' || msg.type === 'assistant')) {
      return true;
    }
  }
  // 边界后没有任何用户/助手消息，调查还不应弹出
  return false;
}
/**
 * usePostCompactSurvey
 *
 * 整体流程：
 *   1. 解析参数：hasActivePrompt（是否有权限/询问弹窗活跃）、enabled（是否启用，默认 true）
 *   2. 初始化状态：
 *      - gateEnabled（Statsig 门控结果，null = 尚未查询）
 *      - seenCompactBoundaries（已处理过的压缩边界 UUID 集合，$[2] 使用 sentinel 值保护初始 Set 全局唯一）
 *      - pendingCompactBoundaryUuid（"延迟等待"的压缩边界 UUID，为 null 表示当前无待处理边界）
 *   3. 通过 _temp/_temp2（hoisted 函数）配置 onOpen/onSelect 回调，$[3] 使用 sentinel 值缓存 options 对象（永不变化）
 *   4. 调用 useSurveyState 获取调查状态机（state/open/handleSelect 等）
 *   5. useEffect #1（依赖 enabled）：查询 Statsig 门控，将结果存入 gateEnabled
 *   6. useMemo（依赖 messages）：从消息列表中提取所有压缩边界 UUID，构成 currentCompactBoundaries Set
 *   7. useEffect #2（主逻辑，依赖 8 个变量）：
 *      a. 各类前置条件检查（enabled/state/isLoading/hasActivePrompt/gateEnabled/env 变量）
 *      b. 若 pendingCompactBoundaryUuid 非空：检查该边界后是否已有新消息
 *         - 有新消息 → 清空 pending，以 20% 概率调用 open() 弹出调查
 *      c. 检测新出现的压缩边界（未在 seenCompactBoundaries 中）：
 *         - 更新 seenCompactBoundaries，将最新边界 UUID 存入 pendingCompactBoundaryUuid
 *   8. 缓存并返回 { state, lastResponse, handleSelect }（$[19-22] 缓存）
 *
 * 在系统中的角色：
 *   提供"压缩后满意度调查"的完整状态，供 FeedbackSurveyView 渲染调查 UI。
 *   采用"延迟显示"模式确保调查不在压缩瞬间打断用户，而是在下一条消息到来后才弹出。
 */
export function usePostCompactSurvey(messages, isLoading, t0, t1) {
  // React 编译器生成的 23 槽缓存，对 options/effect 回调/依赖数组/返回对象进行细粒度记忆化
  const $ = _c(23);
  // t0 为 hasActivePrompt 参数，默认 false（无活跃权限/询问弹窗）
  const hasActivePrompt = t0 === undefined ? false : t0;
  let t2;
  // $[0] 缓存 t1（options 对象引用），引用不变时跳过解构
  if ($[0] !== t1) {
    t2 = t1 === undefined ? {} : t1;
    $[0] = t1;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const {
    enabled: t3
  } = t2;
  // enabled 默认为 true，允许外部传入 false 完全禁用调查
  const enabled = t3 === undefined ? true : t3;
  // gateEnabled：null = 门控状态未知，true/false = Statsig 门控已查询
  const [gateEnabled, setGateEnabled] = useState(null);
  let t4;
  // $[2] 使用 sentinel 值保护 seenCompactBoundaries 的初始 Set，
  // 确保整个组件生命周期内只初始化一次（不会因每次渲染重建 Set）
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = new Set();
    $[2] = t4;
  } else {
    t4 = $[2];
  }
  // seenCompactBoundaries：记录已处理过的压缩边界 UUID，防止重复触发调查
  const seenCompactBoundaries = useRef(t4);
  // pendingCompactBoundaryUuid：记录"正在等待下一条消息"的压缩边界 UUID
  const pendingCompactBoundaryUuid = useRef(null);
  // onOpen/onSelect 直接引用 hoisted 函数（_temp/_temp2），引用稳定，无需 useCallback
  const onOpen = _temp;
  const onSelect = _temp2;
  let t5;
  // $[3] 使用 sentinel 值缓存 useSurveyState 的 options 对象：
  // hideThanksAfterMs/onOpen/onSelect 均为稳定值，options 对象永不重建
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      hideThanksAfterMs: HIDE_THANKS_AFTER_MS,
      onOpen,
      onSelect
    };
    $[3] = t5;
  } else {
    t5 = $[3];
  }
  // 获取调查状态机：state（当前状态）、open（触发弹出）、handleSelect（处理用户选择）
  const {
    state,
    lastResponse,
    open,
    handleSelect
  } = useSurveyState(t5);
  let t6;
  let t7;
  // useEffect #1：仅依赖 enabled，在挂载或 enabled 变化时查询 Statsig 门控
  if ($[4] !== enabled) {
    t6 = () => {
      // 若 hook 被禁用，跳过门控查询
      if (!enabled) {
        return;
      }
      // 查询 Statsig 缓存的门控结果并存入 gateEnabled state
      setGateEnabled(checkStatsigFeatureGate_CACHED_MAY_BE_STALE(POST_COMPACT_SURVEY_GATE));
    };
    t7 = [enabled];
    $[4] = enabled;
    $[5] = t6;
    $[6] = t7;
  } else {
    t6 = $[5];
    t7 = $[6];
  }
  useEffect(t6, t7);
  let t8;
  // useMemo：从消息列表提取所有压缩边界 UUID → Set（仅 messages 变化时重新计算）
  // _temp3 = msg => isCompactBoundaryMessage(msg)，_temp4 = msg => msg.uuid
  if ($[7] !== messages) {
    t8 = new Set(messages.filter(_temp3).map(_temp4));
    $[7] = messages;
    $[8] = t8;
  } else {
    t8 = $[8];
  }
  // currentCompactBoundaries：当前消息列表中所有压缩边界的 UUID 集合
  const currentCompactBoundaries = t8;
  let t10;
  let t9;
  // useEffect #2（主逻辑）：依赖 8 个变量，任一变化时重新评估是否弹出调查
  if ($[9] !== currentCompactBoundaries || $[10] !== enabled || $[11] !== gateEnabled || $[12] !== hasActivePrompt || $[13] !== isLoading || $[14] !== messages || $[15] !== open || $[16] !== state) {
    t9 = () => {
      // 前置条件 1：hook 被禁用时直接返回
      if (!enabled) {
        return;
      }
      // 前置条件 2：调查已在展示中，或正在加载（避免在 loading 期间弹出）
      if (state !== "closed" || isLoading) {
        return;
      }
      // 前置条件 3：有活跃的权限/询问弹窗，避免 UI 冲突
      if (hasActivePrompt) {
        return;
      }
      // 前置条件 4：Statsig 门控未开启
      if (gateEnabled !== true) {
        return;
      }
      // 前置条件 5：全局反馈调查被禁用（由策略或配置控制）
      if (isFeedbackSurveyDisabled()) {
        return;
      }
      // 前置条件 6：环境变量明确禁用反馈调查
      if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
        return;
      }
      // "延迟显示"逻辑：如果有待处理的压缩边界，检查其后是否已有新消息
      if (pendingCompactBoundaryUuid.current !== null) {
        if (hasMessageAfterBoundary(messages, pendingCompactBoundaryUuid.current)) {
          // 新消息已到达，清空 pending 标志
          pendingCompactBoundaryUuid.current = null;
          // 以 20% 概率弹出满意度调查
          if (Math.random() < SURVEY_PROBABILITY) {
            open();
          }
          return;
        }
      }
      // 检测新出现的压缩边界（未在 seenCompactBoundaries 中的 UUID）
      const newBoundaries = Array.from(currentCompactBoundaries).filter(uuid => !seenCompactBoundaries.current.has(uuid));
      if (newBoundaries.length > 0) {
        // 将所有当前边界标记为"已见"，防止下次重复处理
        seenCompactBoundaries.current = new Set(currentCompactBoundaries);
        // 记录最新的压缩边界 UUID，等待下一条消息到来后再决定是否弹出调查
        pendingCompactBoundaryUuid.current = newBoundaries[newBoundaries.length - 1];
      }
    };
    t10 = [enabled, currentCompactBoundaries, state, isLoading, hasActivePrompt, gateEnabled, messages, open];
    $[9] = currentCompactBoundaries;
    $[10] = enabled;
    $[11] = gateEnabled;
    $[12] = hasActivePrompt;
    $[13] = isLoading;
    $[14] = messages;
    $[15] = open;
    $[16] = state;
    $[17] = t10;
    $[18] = t9;
  } else {
    t10 = $[17];
    t9 = $[18];
  }
  useEffect(t9, t10);
  let t11;
  // 缓存返回对象：仅在 state/lastResponse/handleSelect 三者之一变化时重建对象
  if ($[19] !== handleSelect || $[20] !== lastResponse || $[21] !== state) {
    t11 = {
      state,
      lastResponse,
      handleSelect
    };
    $[19] = handleSelect;
    $[20] = lastResponse;
    $[21] = state;
    $[22] = t11;
  } else {
    t11 = $[22];
  }
  return t11;
}
/**
 * _temp4（编译器提升函数）
 *
 * 原始源码：msg => msg.uuid
 * 角色：useMemo 内 .map() 的迭代函数，从消息对象中提取 uuid 字符串，
 *       用于将压缩边界消息列表转换为 UUID 集合（currentCompactBoundaries）。
 */
function _temp4(msg_0) {
  // 提取消息的 uuid 字段，供 Set 构造函数去重
  return msg_0.uuid;
}
/**
 * _temp3（编译器提升函数）
 *
 * 原始源码：msg => isCompactBoundaryMessage(msg)
 * 角色：useMemo 内 .filter() 的谓词函数，筛选出压缩边界类型的消息，
 *       结果经 _temp4 映射为 UUID 后构成 currentCompactBoundaries Set。
 */
function _temp3(msg) {
  // 判断消息是否为压缩边界消息（特殊 type 标识）
  return isCompactBoundaryMessage(msg);
}
/**
 * _temp2（编译器提升函数）
 *
 * 原始源码：onSelect 回调（useCallback([], [...])）
 * 角色：用户在调查中选择满意度选项后的事件上报回调，
 *       同时向 Statsig（logEvent）和 OTel（logOTelEvent）上报 "responded" 事件，
 *       并携带 session_memory_compaction_enabled 字段区分是否启用了会话记忆压缩。
 */
function _temp2(appearanceId_0, selected) {
  // 查询当前是否启用了会话记忆压缩，作为额外维度上报
  const smCompactionEnabled_0 = shouldUseSessionMemoryCompaction();
  // 上报至 Statsig，携带完整的调查响应信息
  logEvent("tengu_post_compact_survey_event", {
    event_type: "responded" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id: appearanceId_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    session_memory_compaction_enabled: smCompactionEnabled_0 as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // 同步上报至 OTel，统一 survey_type 为 "post_compact"
  logOTelEvent("feedback_survey", {
    event_type: "responded",
    appearance_id: appearanceId_0,
    response: selected,
    survey_type: "post_compact"
  });
}
/**
 * _temp（编译器提升函数）
 *
 * 原始源码：onOpen 回调（useCallback([], [...])）
 * 角色：调查弹窗首次展示时的事件上报回调，
 *       同时向 Statsig 和 OTel 上报 "appeared" 事件，
 *       并携带 session_memory_compaction_enabled 字段。
 */
function _temp(appearanceId) {
  // 查询当前是否启用了会话记忆压缩，作为额外维度上报
  const smCompactionEnabled = shouldUseSessionMemoryCompaction();
  // 上报至 Statsig，记录调查展示事件
  logEvent("tengu_post_compact_survey_event", {
    event_type: "appeared" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    session_memory_compaction_enabled: smCompactionEnabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // 同步上报至 OTel，统一 survey_type 为 "post_compact"
  logOTelEvent("feedback_survey", {
    event_type: "appeared",
    appearance_id: appearanceId,
    survey_type: "post_compact"
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJ1c2VDYWxsYmFjayIsInVzZUVmZmVjdCIsInVzZU1lbW8iLCJ1c2VSZWYiLCJ1c2VTdGF0ZSIsImlzRmVlZGJhY2tTdXJ2ZXlEaXNhYmxlZCIsImNoZWNrU3RhdHNpZ0ZlYXR1cmVHYXRlX0NBQ0hFRF9NQVlfQkVfU1RBTEUiLCJBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTIiwibG9nRXZlbnQiLCJzaG91bGRVc2VTZXNzaW9uTWVtb3J5Q29tcGFjdGlvbiIsIk1lc3NhZ2UiLCJpc0VudlRydXRoeSIsImlzQ29tcGFjdEJvdW5kYXJ5TWVzc2FnZSIsImxvZ09UZWxFdmVudCIsInVzZVN1cnZleVN0YXRlIiwiRmVlZGJhY2tTdXJ2ZXlSZXNwb25zZSIsIkhJREVfVEhBTktTX0FGVEVSX01TIiwiUE9TVF9DT01QQUNUX1NVUlZFWV9HQVRFIiwiU1VSVkVZX1BST0JBQklMSVRZIiwiaGFzTWVzc2FnZUFmdGVyQm91bmRhcnkiLCJtZXNzYWdlcyIsImJvdW5kYXJ5VXVpZCIsImJvdW5kYXJ5SW5kZXgiLCJmaW5kSW5kZXgiLCJtc2ciLCJ1dWlkIiwiaSIsImxlbmd0aCIsInR5cGUiLCJ1c2VQb3N0Q29tcGFjdFN1cnZleSIsImlzTG9hZGluZyIsInQwIiwidDEiLCIkIiwiX2MiLCJoYXNBY3RpdmVQcm9tcHQiLCJ1bmRlZmluZWQiLCJ0MiIsImVuYWJsZWQiLCJ0MyIsImdhdGVFbmFibGVkIiwic2V0R2F0ZUVuYWJsZWQiLCJ0NCIsIlN5bWJvbCIsImZvciIsIlNldCIsInNlZW5Db21wYWN0Qm91bmRhcmllcyIsInBlbmRpbmdDb21wYWN0Qm91bmRhcnlVdWlkIiwib25PcGVuIiwiX3RlbXAiLCJvblNlbGVjdCIsIl90ZW1wMiIsInQ1IiwiaGlkZVRoYW5rc0FmdGVyTXMiLCJzdGF0ZSIsImxhc3RSZXNwb25zZSIsIm9wZW4iLCJoYW5kbGVTZWxlY3QiLCJ0NiIsInQ3IiwidDgiLCJmaWx0ZXIiLCJfdGVtcDMiLCJtYXAiLCJfdGVtcDQiLCJjdXJyZW50Q29tcGFjdEJvdW5kYXJpZXMiLCJ0MTAiLCJ0OSIsInByb2Nlc3MiLCJlbnYiLCJDTEFVREVfQ09ERV9ESVNBQkxFX0ZFRURCQUNLX1NVUlZFWSIsImN1cnJlbnQiLCJNYXRoIiwicmFuZG9tIiwibmV3Qm91bmRhcmllcyIsIkFycmF5IiwiZnJvbSIsImhhcyIsInQxMSIsIm1zZ18wIiwiYXBwZWFyYW5jZUlkXzAiLCJzZWxlY3RlZCIsInNtQ29tcGFjdGlvbkVuYWJsZWRfMCIsImV2ZW50X3R5cGUiLCJhcHBlYXJhbmNlX2lkIiwiYXBwZWFyYW5jZUlkIiwicmVzcG9uc2UiLCJzZXNzaW9uX21lbW9yeV9jb21wYWN0aW9uX2VuYWJsZWQiLCJzbUNvbXBhY3Rpb25FbmFibGVkIiwic3VydmV5X3R5cGUiXSwic291cmNlcyI6WyJ1c2VQb3N0Q29tcGFjdFN1cnZleS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgdXNlQ2FsbGJhY2ssIHVzZUVmZmVjdCwgdXNlTWVtbywgdXNlUmVmLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgaXNGZWVkYmFja1N1cnZleURpc2FibGVkIH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9jb25maWcuanMnXG5pbXBvcnQgeyBjaGVja1N0YXRzaWdGZWF0dXJlR2F0ZV9DQUNIRURfTUFZX0JFX1NUQUxFIH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHtcbiAgdHlwZSBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICBsb2dFdmVudCxcbn0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcydcbmltcG9ydCB7IHNob3VsZFVzZVNlc3Npb25NZW1vcnlDb21wYWN0aW9uIH0gZnJvbSAnLi4vLi4vc2VydmljZXMvY29tcGFjdC9zZXNzaW9uTWVtb3J5Q29tcGFjdC5qcydcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgeyBpc0VudlRydXRoeSB9IGZyb20gJy4uLy4uL3V0aWxzL2VudlV0aWxzLmpzJ1xuaW1wb3J0IHsgaXNDb21wYWN0Qm91bmRhcnlNZXNzYWdlIH0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBsb2dPVGVsRXZlbnQgfSBmcm9tICcuLi8uLi91dGlscy90ZWxlbWV0cnkvZXZlbnRzLmpzJ1xuaW1wb3J0IHsgdXNlU3VydmV5U3RhdGUgfSBmcm9tICcuL3VzZVN1cnZleVN0YXRlLmpzJ1xuaW1wb3J0IHR5cGUgeyBGZWVkYmFja1N1cnZleVJlc3BvbnNlIH0gZnJvbSAnLi91dGlscy5qcydcblxuY29uc3QgSElERV9USEFOS1NfQUZURVJfTVMgPSAzMDAwXG5jb25zdCBQT1NUX0NPTVBBQ1RfU1VSVkVZX0dBVEUgPSAndGVuZ3VfcG9zdF9jb21wYWN0X3N1cnZleSdcbmNvbnN0IFNVUlZFWV9QUk9CQUJJTElUWSA9IDAuMiAvLyBTaG93IHN1cnZleSAyMCUgb2YgdGhlIHRpbWUgYWZ0ZXIgY29tcGFjdGlvblxuXG5mdW5jdGlvbiBoYXNNZXNzYWdlQWZ0ZXJCb3VuZGFyeShcbiAgbWVzc2FnZXM6IE1lc3NhZ2VbXSxcbiAgYm91bmRhcnlVdWlkOiBzdHJpbmcsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgYm91bmRhcnlJbmRleCA9IG1lc3NhZ2VzLmZpbmRJbmRleChtc2cgPT4gbXNnLnV1aWQgPT09IGJvdW5kYXJ5VXVpZClcbiAgaWYgKGJvdW5kYXJ5SW5kZXggPT09IC0xKSB7XG4gICAgcmV0dXJuIGZhbHNlXG4gIH1cblxuICAvLyBDaGVjayBpZiB0aGVyZSdzIGEgdXNlciBvciBhc3Npc3RhbnQgbWVzc2FnZSBhZnRlciB0aGUgYm91bmRhcnlcbiAgZm9yIChsZXQgaSA9IGJvdW5kYXJ5SW5kZXggKyAxOyBpIDwgbWVzc2FnZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBtc2cgPSBtZXNzYWdlc1tpXVxuICAgIGlmIChtc2cgJiYgKG1zZy50eXBlID09PSAndXNlcicgfHwgbXNnLnR5cGUgPT09ICdhc3Npc3RhbnQnKSkge1xuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlXG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2VQb3N0Q29tcGFjdFN1cnZleShcbiAgbWVzc2FnZXM6IE1lc3NhZ2VbXSxcbiAgaXNMb2FkaW5nOiBib29sZWFuLFxuICBoYXNBY3RpdmVQcm9tcHQgPSBmYWxzZSxcbiAgeyBlbmFibGVkID0gdHJ1ZSB9OiB7IGVuYWJsZWQ/OiBib29sZWFuIH0gPSB7fSxcbik6IHtcbiAgc3RhdGU6XG4gICAgfCAnY2xvc2VkJ1xuICAgIHwgJ29wZW4nXG4gICAgfCAndGhhbmtzJ1xuICAgIHwgJ3RyYW5zY3JpcHRfcHJvbXB0J1xuICAgIHwgJ3N1Ym1pdHRpbmcnXG4gICAgfCAnc3VibWl0dGVkJ1xuICBsYXN0UmVzcG9uc2U6IEZlZWRiYWNrU3VydmV5UmVzcG9uc2UgfCBudWxsXG4gIGhhbmRsZVNlbGVjdDogKHNlbGVjdGVkOiBGZWVkYmFja1N1cnZleVJlc3BvbnNlKSA9PiB2b2lkXG59IHtcbiAgY29uc3QgW2dhdGVFbmFibGVkLCBzZXRHYXRlRW5hYmxlZF0gPSB1c2VTdGF0ZTxib29sZWFuIHwgbnVsbD4obnVsbClcbiAgY29uc3Qgc2VlbkNvbXBhY3RCb3VuZGFyaWVzID0gdXNlUmVmPFNldDxzdHJpbmc+PihuZXcgU2V0KCkpXG4gIC8vIFRyYWNrIHRoZSBjb21wYWN0IGJvdW5kYXJ5IHdlJ3JlIHdhaXRpbmcgb24gKHRvIHNob3cgc3VydmV5IGFmdGVyIG5leHQgbWVzc2FnZSlcbiAgY29uc3QgcGVuZGluZ0NvbXBhY3RCb3VuZGFyeVV1aWQgPSB1c2VSZWY8c3RyaW5nIHwgbnVsbD4obnVsbClcblxuICBjb25zdCBvbk9wZW4gPSB1c2VDYWxsYmFjaygoYXBwZWFyYW5jZUlkOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBzbUNvbXBhY3Rpb25FbmFibGVkID0gc2hvdWxkVXNlU2Vzc2lvbk1lbW9yeUNvbXBhY3Rpb24oKVxuICAgIGxvZ0V2ZW50KCd0ZW5ndV9wb3N0X2NvbXBhY3Rfc3VydmV5X2V2ZW50Jywge1xuICAgICAgZXZlbnRfdHlwZTpcbiAgICAgICAgJ2FwcGVhcmVkJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgYXBwZWFyYW5jZV9pZDpcbiAgICAgICAgYXBwZWFyYW5jZUlkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICBzZXNzaW9uX21lbW9yeV9jb21wYWN0aW9uX2VuYWJsZWQ6XG4gICAgICAgIHNtQ29tcGFjdGlvbkVuYWJsZWQgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICB9KVxuICAgIHZvaWQgbG9nT1RlbEV2ZW50KCdmZWVkYmFja19zdXJ2ZXknLCB7XG4gICAgICBldmVudF90eXBlOiAnYXBwZWFyZWQnLFxuICAgICAgYXBwZWFyYW5jZV9pZDogYXBwZWFyYW5jZUlkLFxuICAgICAgc3VydmV5X3R5cGU6ICdwb3N0X2NvbXBhY3QnLFxuICAgIH0pXG4gIH0sIFtdKVxuXG4gIGNvbnN0IG9uU2VsZWN0ID0gdXNlQ2FsbGJhY2soXG4gICAgKGFwcGVhcmFuY2VJZDogc3RyaW5nLCBzZWxlY3RlZDogRmVlZGJhY2tTdXJ2ZXlSZXNwb25zZSkgPT4ge1xuICAgICAgY29uc3Qgc21Db21wYWN0aW9uRW5hYmxlZCA9IHNob3VsZFVzZVNlc3Npb25NZW1vcnlDb21wYWN0aW9uKClcbiAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9wb3N0X2NvbXBhY3Rfc3VydmV5X2V2ZW50Jywge1xuICAgICAgICBldmVudF90eXBlOlxuICAgICAgICAgICdyZXNwb25kZWQnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgIGFwcGVhcmFuY2VfaWQ6XG4gICAgICAgICAgYXBwZWFyYW5jZUlkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgIHJlc3BvbnNlOlxuICAgICAgICAgIHNlbGVjdGVkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgIHNlc3Npb25fbWVtb3J5X2NvbXBhY3Rpb25fZW5hYmxlZDpcbiAgICAgICAgICBzbUNvbXBhY3Rpb25FbmFibGVkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KVxuICAgICAgdm9pZCBsb2dPVGVsRXZlbnQoJ2ZlZWRiYWNrX3N1cnZleScsIHtcbiAgICAgICAgZXZlbnRfdHlwZTogJ3Jlc3BvbmRlZCcsXG4gICAgICAgIGFwcGVhcmFuY2VfaWQ6IGFwcGVhcmFuY2VJZCxcbiAgICAgICAgcmVzcG9uc2U6IHNlbGVjdGVkLFxuICAgICAgICBzdXJ2ZXlfdHlwZTogJ3Bvc3RfY29tcGFjdCcsXG4gICAgICB9KVxuICAgIH0sXG4gICAgW10sXG4gIClcblxuICBjb25zdCB7IHN0YXRlLCBsYXN0UmVzcG9uc2UsIG9wZW4sIGhhbmRsZVNlbGVjdCB9ID0gdXNlU3VydmV5U3RhdGUoe1xuICAgIGhpZGVUaGFua3NBZnRlck1zOiBISURFX1RIQU5LU19BRlRFUl9NUyxcbiAgICBvbk9wZW4sXG4gICAgb25TZWxlY3QsXG4gIH0pXG5cbiAgLy8gQ2hlY2sgdGhlIGZlYXR1cmUgZ2F0ZSBvbiBtb3VudFxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmICghZW5hYmxlZCkgcmV0dXJuXG4gICAgc2V0R2F0ZUVuYWJsZWQoXG4gICAgICBjaGVja1N0YXRzaWdGZWF0dXJlR2F0ZV9DQUNIRURfTUFZX0JFX1NUQUxFKFBPU1RfQ09NUEFDVF9TVVJWRVlfR0FURSksXG4gICAgKVxuICB9LCBbZW5hYmxlZF0pXG5cbiAgLy8gRmluZCBjb21wYWN0IGJvdW5kYXJ5IG1lc3NhZ2VzXG4gIGNvbnN0IGN1cnJlbnRDb21wYWN0Qm91bmRhcmllcyA9IHVzZU1lbW8oXG4gICAgKCkgPT5cbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIG1lc3NhZ2VzXG4gICAgICAgICAgLmZpbHRlcihtc2cgPT4gaXNDb21wYWN0Qm91bmRhcnlNZXNzYWdlKG1zZykpXG4gICAgICAgICAgLm1hcChtc2cgPT4gbXNnLnV1aWQpLFxuICAgICAgKSxcbiAgICBbbWVzc2FnZXNdLFxuICApXG5cbiAgLy8gRGV0ZWN0IG5ldyBjb21wYWN0IGJvdW5kYXJpZXMgYW5kIGRlZmVyIHNob3dpbmcgc3VydmV5IHVudGlsIG5leHQgbWVzc2FnZVxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmICghZW5hYmxlZCkgcmV0dXJuXG5cbiAgICAvLyBEb24ndCBwcm9jZXNzIGlmIGFscmVhZHkgc2hvd2luZ1xuICAgIGlmIChzdGF0ZSAhPT0gJ2Nsb3NlZCcgfHwgaXNMb2FkaW5nKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBEb24ndCBzaG93IHN1cnZleSB3aGVuIHBlcm1pc3Npb24gb3IgYXNrIHF1ZXN0aW9uIHByb21wdHMgYXJlIHZpc2libGVcbiAgICBpZiAoaGFzQWN0aXZlUHJvbXB0KSB7XG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiB0aGUgZ2F0ZSBpcyBlbmFibGVkXG4gICAgaWYgKGdhdGVFbmFibGVkICE9PSB0cnVlKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoaXNGZWVkYmFja1N1cnZleURpc2FibGVkKCkpIHtcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIENoZWNrIGlmIHN1cnZleSBpcyBleHBsaWNpdGx5IGRpc2FibGVkXG4gICAgaWYgKGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0RJU0FCTEVfRkVFREJBQ0tfU1VSVkVZKSkge1xuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gRmlyc3QsIGNoZWNrIGlmIHdlIGhhdmUgYSBwZW5kaW5nIGNvbXBhY3QgYW5kIGEgbmV3IG1lc3NhZ2UgaGFzIGFycml2ZWRcbiAgICBpZiAocGVuZGluZ0NvbXBhY3RCb3VuZGFyeVV1aWQuY3VycmVudCAhPT0gbnVsbCkge1xuICAgICAgaWYgKFxuICAgICAgICBoYXNNZXNzYWdlQWZ0ZXJCb3VuZGFyeShtZXNzYWdlcywgcGVuZGluZ0NvbXBhY3RCb3VuZGFyeVV1aWQuY3VycmVudClcbiAgICAgICkge1xuICAgICAgICAvLyBBIG5ldyBtZXNzYWdlIGFycml2ZWQgYWZ0ZXIgdGhlIGNvbXBhY3QgLSBkZWNpZGUgd2hldGhlciB0byBzaG93IHN1cnZleVxuICAgICAgICBwZW5kaW5nQ29tcGFjdEJvdW5kYXJ5VXVpZC5jdXJyZW50ID0gbnVsbFxuXG4gICAgICAgIC8vIE9ubHkgc2hvdyBzdXJ2ZXkgMjAlIG9mIHRoZSB0aW1lXG4gICAgICAgIGlmIChNYXRoLnJhbmRvbSgpIDwgU1VSVkVZX1BST0JBQklMSVRZKSB7XG4gICAgICAgICAgb3BlbigpXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRmluZCBuZXcgY29tcGFjdCBib3VuZGFyaWVzIHRoYXQgd2UgaGF2ZW4ndCBzZWVuIHlldFxuICAgIGNvbnN0IG5ld0JvdW5kYXJpZXMgPSBBcnJheS5mcm9tKGN1cnJlbnRDb21wYWN0Qm91bmRhcmllcykuZmlsdGVyKFxuICAgICAgdXVpZCA9PiAhc2VlbkNvbXBhY3RCb3VuZGFyaWVzLmN1cnJlbnQuaGFzKHV1aWQpLFxuICAgIClcblxuICAgIGlmIChuZXdCb3VuZGFyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIE1hcmsgdGhlc2UgYm91bmRhcmllcyBhcyBzZWVuXG4gICAgICBzZWVuQ29tcGFjdEJvdW5kYXJpZXMuY3VycmVudCA9IG5ldyBTZXQoY3VycmVudENvbXBhY3RCb3VuZGFyaWVzKVxuXG4gICAgICAvLyBEb24ndCBzaG93IHN1cnZleSBpbW1lZGlhdGVseSAtIHdhaXQgZm9yIG5leHQgbWVzc2FnZVxuICAgICAgLy8gU3RvcmUgdGhlIG1vc3QgcmVjZW50IG5ldyBib3VuZGFyeSBVVUlEXG4gICAgICBwZW5kaW5nQ29tcGFjdEJvdW5kYXJ5VXVpZC5jdXJyZW50ID1cbiAgICAgICAgbmV3Qm91bmRhcmllc1tuZXdCb3VuZGFyaWVzLmxlbmd0aCAtIDFdIVxuICAgIH1cbiAgfSwgW1xuICAgIGVuYWJsZWQsXG4gICAgY3VycmVudENvbXBhY3RCb3VuZGFyaWVzLFxuICAgIHN0YXRlLFxuICAgIGlzTG9hZGluZyxcbiAgICBoYXNBY3RpdmVQcm9tcHQsXG4gICAgZ2F0ZUVuYWJsZWQsXG4gICAgbWVzc2FnZXMsXG4gICAgb3BlbixcbiAgXSlcblxuICByZXR1cm4geyBzdGF0ZSwgbGFzdFJlc3BvbnNlLCBoYW5kbGVTZWxlY3QgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBU0EsV0FBVyxFQUFFQyxTQUFTLEVBQUVDLE9BQU8sRUFBRUMsTUFBTSxFQUFFQyxRQUFRLFFBQVEsT0FBTztBQUN6RSxTQUFTQyx3QkFBd0IsUUFBUSxrQ0FBa0M7QUFDM0UsU0FBU0MsMkNBQTJDLFFBQVEsc0NBQXNDO0FBQ2xHLFNBQ0UsS0FBS0MsMERBQTBELEVBQy9EQyxRQUFRLFFBQ0gsaUNBQWlDO0FBQ3hDLFNBQVNDLGdDQUFnQyxRQUFRLGdEQUFnRDtBQUNqRyxjQUFjQyxPQUFPLFFBQVEsd0JBQXdCO0FBQ3JELFNBQVNDLFdBQVcsUUFBUSx5QkFBeUI7QUFDckQsU0FBU0Msd0JBQXdCLFFBQVEseUJBQXlCO0FBQ2xFLFNBQVNDLFlBQVksUUFBUSxpQ0FBaUM7QUFDOUQsU0FB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