/**
 * HookProgressMessage.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件处于工具调用渲染管线的 hook 进度显示层，专门用于在工具执行过程中
 * 展示 PreToolUse / PostToolUse / 其他 hook 事件的运行进度信息。
 *
 * 主要功能：
 * - 根据 hookEvent 类型和当前运行/完成计数决定是否渲染进度文本
 * - 在 transcript（历史记录）模式下展示静态摘要（如 "2 PreToolUse hooks ran"）
 * - 在实时模式下展示动态进度（如 "Running PostToolUse hook…"）
 * - 若无进行中的 hook（inProgressHookCount === 0）则返回 null 不渲染
 * - 利用 React Compiler 生成的 22 个缓存槽避免不必要的 JSX 重建
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { buildMessageLookups } from 'src/utils/messages.js';
import { Box, Text } from '../../ink.js';
import { MessageResponse } from '../MessageResponse.js';

// Props 类型：hookEvent 为 hook 事件类型，lookups 提供进度/完成计数，
// toolUseID 用于在映射中定位当前工具调用，isTranscriptMode 控制显示模式
type Props = {
  hookEvent: HookEvent;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

/**
 * HookProgressMessage 组件
 *
 * 流程说明：
 * 1. 通过 lookups.inProgressHookCounts 获取当前 toolUseID + hookEvent 对应的进行中计数
 * 2. 若 inProgressHookCount === 0，直接返回 null（无需渲染任何内容）
 * 3. 对于 PreToolUse / PostToolUse 类型：
 *    - 在 transcript 模式下渲染静态摘要（"N PreToolUse hooks ran"），
 *      因为历史记录消息不会重渲，使用"Running..."会永久卡住
 *    - 非 transcript 模式返回 null（完成信息已由 async_hook_response 附件展示）
 * 4. 对于其他 hook 事件类型：
 *    - 若 resolvedHookCount === inProgressHookCount，表示所有 hook 已完成，返回 null
 *    - 否则渲染动态进度文本（"Running HookEvent hook…"）
 *
 * 在系统流程中的角色：
 * 由工具调用消息组件在每个工具调用旁边渲染，给用户实时反馈 hook 执行状态。
 */
export function HookProgressMessage(t0) {
  // React Compiler 生成的缓存槽，共 22 个槽位
  const $ = _c(22);
  const {
    hookEvent,
    lookups,
    toolUseID,
    isTranscriptMode
  } = t0;

  let t1;
  // 缓存槽 0-3：当 hookEvent、inProgressHookCounts 或 toolUseID 变化时重新计算进行中计数
  if ($[0] !== hookEvent || $[1] !== lookups.inProgressHookCounts || $[2] !== toolUseID) {
    // 通过双层 Map 查找：toolUseID → hookEvent → 进行中的 hook 数量，默认为 0
    t1 = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
    $[0] = hookEvent;
    $[1] = lookups.inProgressHookCounts;
    $[2] = toolUseID;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const inProgressHookCount = t1;

  // 获取已解析完成的 hook 数量（不缓存，因为不在依赖分支中）
  const resolvedHookCount = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;

  // 若无进行中的 hook，不渲染任何内容
  if (inProgressHookCount === 0) {
    return null;
  }

  // PreToolUse / PostToolUse 分支：只在 transcript 模式显示静态摘要
  if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") {
    if (isTranscriptMode) {
      // 缓存槽 4-5：inProgressHookCount 变化时重建计数文本节点
      let t2;
      if ($[4] !== inProgressHookCount) {
        t2 = <Text dimColor={true}>{inProgressHookCount} </Text>;
        $[4] = inProgressHookCount;
        $[5] = t2;
      } else {
        t2 = $[5];
      }
      // 缓存槽 6-7：hookEvent 变化时重建事件名称文本节点（加粗）
      let t3;
      if ($[6] !== hookEvent) {
        t3 = <Text dimColor={true} bold={true}>{hookEvent}</Text>;
        $[6] = hookEvent;
        $[7] = t3;
      } else {
        t3 = $[7];
      }
      // 根据计数决定单复数形式："hook" 或 "hooks"
      const t4 = inProgressHookCount === 1 ? " hook" : " hooks";
      // 缓存槽 8-9：单复数字符串变化时重建尾部文本节点
      let t5;
      if ($[8] !== t4) {
        t5 = <Text dimColor={true}>{t4} ran</Text>;
        $[8] = t4;
        $[9] = t5;
      } else {
        t5 = $[9];
      }
      // 缓存槽 10-13：三个子节点任一变化时重建整行摘要
      let t6;
      if ($[10] !== t2 || $[11] !== t3 || $[12] !== t5) {
        t6 = <MessageResponse><Box flexDirection="row">{t2}{t3}{t5}</Box></MessageResponse>;
        $[10] = t2;
        $[11] = t3;
        $[12] = t5;
        $[13] = t6;
      } else {
        t6 = $[13];
      }
      return t6;
    }
    // 非 transcript 模式：完成信息由 async_hook_response 附件展示，此处返回 null
    return null;
  }

  // 其他 hook 事件：若所有 hook 均已完成（resolved === inProgress），不再显示进度
  if (resolvedHookCount === inProgressHookCount) {
    return null;
  }

  // 缓存槽 14：静态"Running "文本节点，仅初始化一次（memo_cache_sentinel 检查）
  let t2;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text dimColor={true}>Running </Text>;
    $[14] = t2;
  } else {
    t2 = $[14];
  }
  // 缓存槽 15-16：hookEvent 变化时重建事件名称文本节点
  let t3;
  if ($[15] !== hookEvent) {
    t3 = <Text dimColor={true} bold={true}>{hookEvent}</Text>;
    $[15] = hookEvent;
    $[16] = t3;
  } else {
    t3 = $[16];
  }
  // 根据进行中数量决定省略号前缀：" hook…" 或 " hooks…"
  const t4 = inProgressHookCount === 1 ? " hook\u2026" : " hooks\u2026";
  // 缓存槽 17-18：单复数字符串变化时重建尾部文本节点
  let t5;
  if ($[17] !== t4) {
    t5 = <Text dimColor={true}>{t4}</Text>;
    $[17] = t4;
    $[18] = t5;
  } else {
    t5 = $[18];
  }
  // 缓存槽 19-21：两个可变子节点任一变化时重建整行进度提示
  let t6;
  if ($[19] !== t3 || $[20] !== t5) {
    t6 = <MessageResponse><Box flexDirection="row">{t2}{t3}{t5}</Box></MessageResponse>;
    $[19] = t3;
    $[20] = t5;
    $[21] = t6;
  } else {
    t6 = $[21];
  }
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkhvb2tFdmVudCIsImJ1aWxkTWVzc2FnZUxvb2t1cHMiLCJCb3giLCJUZXh0IiwiTWVzc2FnZVJlc3BvbnNlIiwiUHJvcHMiLCJob29rRXZlbnQiLCJsb29rdXBzIiwiUmV0dXJuVHlwZSIsInRvb2xVc2VJRCIsInZlcmJvc2UiLCJpc1RyYW5zY3JpcHRNb2RlIiwiSG9va1Byb2dyZXNzTWVzc2FnZSIsInQwIiwiJCIsIl9jIiwidDEiLCJpblByb2dyZXNzSG9va0NvdW50cyIsImdldCIsImluUHJvZ3Jlc3NIb29rQ291bnQiLCJyZXNvbHZlZEhvb2tDb3VudCIsInJlc29sdmVkSG9va0NvdW50cyIsInQyIiwidDMiLCJ0NCIsInQ1IiwidDYiLCJTeW1ib2wiLCJmb3IiXSwic291cmNlcyI6WyJIb29rUHJvZ3Jlc3NNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB0eXBlIHsgSG9va0V2ZW50IH0gZnJvbSAnc3JjL2VudHJ5cG9pbnRzL2FnZW50U2RrVHlwZXMuanMnXG5pbXBvcnQgdHlwZSB7IGJ1aWxkTWVzc2FnZUxvb2t1cHMgfSBmcm9tICdzcmMvdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGhvb2tFdmVudDogSG9va0V2ZW50XG4gIGxvb2t1cHM6IFJldHVyblR5cGU8dHlwZW9mIGJ1aWxkTWVzc2FnZUxvb2t1cHM+XG4gIHRvb2xVc2VJRDogc3RyaW5nXG4gIHZlcmJvc2U6IGJvb2xlYW5cbiAgaXNUcmFuc2NyaXB0TW9kZT86IGJvb2xlYW5cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIEhvb2tQcm9ncmVzc01lc3NhZ2Uoe1xuICBob29rRXZlbnQsXG4gIGxvb2t1cHMsXG4gIHRvb2xVc2VJRCxcbiAgaXNUcmFuc2NyaXB0TW9kZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgaW5Qcm9ncmVzc0hvb2tDb3VudCA9XG4gICAgbG9va3Vwcy5pblByb2dyZXNzSG9va0NvdW50cy5nZXQodG9vbFVzZUlEKT8uZ2V0KGhvb2tFdmVudCkgPz8gMFxuICBjb25zdCByZXNvbHZlZEhvb2tDb3VudCA9XG4gICAgbG9va3Vwcy5yZXNvbHZlZEhvb2tDb3VudHMuZ2V0KHRvb2xVc2VJRCk/LmdldChob29rRXZlbnQpID8/IDBcbiAgaWYgKGluUHJvZ3Jlc3NIb29rQ291bnQgPT09IDApIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgaWYgKGhvb2tFdmVudCA9PT0gJ1ByZVRvb2xVc2UnIHx8IGhvb2tFdmVudCA9PT0gJ1Bvc3RUb29sVXNlJykge1xuICAgIC8vIEluIHRyYW5zY3JpcHQgbW9kZSwgc2hvdyBhIHN0YXRpYyBzdW1tYXJ5IHNpbmNlIG1lc3NhZ2VzIG5ldmVyIHJlLXJlbmRlclxuICAgIC8vIChzbyBhIHRyYW5zaWVudCBcIlJ1bm5pbmcuLi5cIiB3b3VsZCBnZXQgc3R1Y2spLlxuICAgIGlmIChpc1RyYW5zY3JpcHRNb2RlKSB7XG4gICAgICByZXR1cm4gKFxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+e2luUHJvZ3Jlc3NIb29rQ291bnR9IDwvVGV4dD5cbiAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yIGJvbGQ+XG4gICAgICAgICAgICAgIHtob29rRXZlbnR9XG4gICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICAgICAge2luUHJvZ3Jlc3NIb29rQ291bnQgPT09IDEgPyAnIGhvb2snIDogJyBob29rcyd9IHJhblxuICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgIDwvQm94PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcbiAgICB9XG4gICAgLy8gT3V0c2lkZSB0cmFuc2NyaXB0IG1vZGUsIGhpZGUg4oCUIGNvbXBsZXRpb24gaW5mbyBpcyBzaG93biB2aWFcbiAgICAvLyBhc3luY19ob29rX3Jlc3BvbnNlIGF0dGFjaG1lbnRzIGluc3RlYWQuXG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGlmIChyZXNvbHZlZEhvb2tDb3VudCA9PT0gaW5Qcm9ncmVzc0hvb2tDb3VudCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJyb3dcIj5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+UnVubmluZyA8L1RleHQ+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yIGJvbGQ+XG4gICAgICAgICAge2hvb2tFdmVudH1cbiAgICAgICAgPC9UZXh0PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj57aW5Qcm9ncmVzc0hvb2tDb3VudCA9PT0gMSA/ICcgaG9va+KApicgOiAnIGhvb2tz4oCmJ308L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixjQUFjQyxTQUFTLFFBQVEsa0NBQWtDO0FBQ2pFLGNBQWNDLG1CQUFtQixRQUFRLHVCQUF1QjtBQUNoRSxTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLFNBQVNDLGVBQWUsUUFBUSx1QkFBdUI7QUFFdkQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLFNBQVMsRUFBRU4sU0FBUztFQUNwQk8sT0FBTyxFQUFFQyxVQUFVLENBQUMsT0FBT1AsbUJBQW1CLENBQUM7RUFDL0NRLFNBQVMsRUFBRSxNQUFNO0VBQ2pCQyxPQUFPLEVB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QTtNQUFBO01BQUEsT0FWbEJZLEVBVWtCO0lBQUE7SUFFckIsT0FHTSxJQUFJO0VBQUE7RUFHYixJQUFJTixpQkFBaUIsS0FBS0QsbUJBQW1CO0lBQUEsT0FDcEIsSUFBSTtFQUFBO0VBQ1osSUFBQUcsRUFBQTtFQUFBLElBQUFSLENBQUEsU0FBQWEsTUFBQSxDQUFBQyxHQUFBO0lBS0tOLEVBQUEsSUFBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFDLFFBQVEsRUFBdEIsSUFBSSxDQUF5QjtJQUFBUixDQUFBLE9BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUFBLElBQUFTLEVBQUE7RUFBQSxJQUFBVCxDQUFBLFNBQUFSLFNBQUE7SUFDOUJpQixFQUFBLElBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyxJQUFJLENBQUosS0FBRyxDQUFDLENBQ2hCakIsVUFBUSxDQUNYLEVBRkMsSUFBSSxDQUVFO0lBQUFRLENBQUEsT0FBQVIsU0FBQTtJQUFBUSxDQUFBLE9BQUFTLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFULENBQUE7RUFBQTtFQUNTLE1BQUFVLEVBQUEsR0FBQUwsbUJBQW1CLEtBQUssQ0FBd0IsR0FBaEQsYUFBZ0QsR0FBaEQsY0FBZ0Q7RUFBQSxJQUFBTSxFQUFBO0VBQUEsSUFBQVgsQ0FBQSxTQUFBVSxFQUFBO0lBQWhFQyxFQUFBLElBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBRSxDQUFBRCxFQUErQyxDQUFFLEVBQWhFLElBQUksQ0FBbUU7SUFBQVYsQ0FBQSxPQUFBVSxFQUFBO0lBQUFWLENBQUEsT0FBQVcsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVgsQ0FBQTtFQUFBO0VBQUEsSUFBQVksRUFBQTtFQUFBLElBQUFaLENBQUEsU0FBQVMsRUFBQSxJQUFBVCxDQUFBLFNBQUFXLEVBQUE7SUFONUVDLEVBQUEsSUFBQyxlQUFlLENBQ2QsQ0FBQyxHQUFHLENBQWUsYUFBSyxDQUFMLEtBQUssQ0FDdEIsQ0FBQUosRUFBNkIsQ0FDN0IsQ0FBQUMsRUFFTSxDQUNOLENBQUFFLEVBQXVFLENBQ3pFLEVBTkMsR0FBRyxDQU9OLEVBUkMsZUFBZSxDQVFFO0lBQUFYLENBQUEsT0FBQVMsRUFBQTtJQUFBVCxDQUFBLE9BQUFXLEVBQUE7SUFBQVgsQ0FBQSxPQUFBWSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBWixDQUFBO0VBQUE7RUFBQSxPQVJsQlksRUFRa0I7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
