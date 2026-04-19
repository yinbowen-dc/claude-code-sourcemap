/**
 * FileEditToolUpdatedMessage.tsx — 文件编辑完成提示组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   FileEditTool（文件编辑工具）→ 编辑完成 → FileEditToolUpdatedMessage → 展示编辑结果摘要
 *
 * 主要功能：
 *   FileEditToolUpdatedMessage：展示文件编辑完成后的摘要信息，
 *   包括新增/删除行数统计，以及（在完整模式下）内嵌的结构化 diff 视图。
 *
 * 渲染策略（根据 previewHint / style / verbose 三个维度组合）：
 *   1. 有 previewHint 且非 condensed 且非 verbose：仅显示预览提示文本（计划文件简洁模式）
 *   2. 无 previewHint 且 condensed 且非 verbose：仅显示行数统计文本（子代理视图）
 *   3. 其他情况：展示完整 diff（行数统计 + StructuredDiffList）
 *
 * 设计要点：
 *   - React Compiler 优化：使用 _c(22) 缓存数组避免 22 个 JSX 节点的重复创建
 *   - _temp/_temp2/_temp3/_temp4：React Compiler 将 reduce 回调提升为顶层函数，
 *     避免每次渲染创建新的内联函数对象
 *   - 宽度计算：diff 宽度为 columns-12，为左侧边距预留空间
 */
import { c as _c } from "react/compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';
type Props = {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];  // 结构化 diff patch 块数组
  firstLine: string | null;               // 文件首行（用于显示文件名）
  fileContent?: string;                   // 文件实际内容（用于 diff 上下文）
  style?: 'condensed';                    // condensed：子代理视图，显示更精简的信息
  verbose: boolean;                       // verbose：强制展示完整 diff（覆盖 condensed/previewHint）
  previewHint?: string;                   // 计划文件的预览提示文本（替代 diff 显示）
};

/**
 * FileEditToolUpdatedMessage
 *
 * 整体流程：
 *   1. 读取终端列数（useTerminalSize），用于计算 diff 宽度
 *   2. 统计新增行数（numAdditions）和删除行数（numRemovals）
 *      - React Compiler 将 reduce 回调提升为 _temp2/_temp4 顶层函数
 *   3. 构建行数统计 text 节点（"Added N lines, removed M lines"）
 *   4. 渲染策略分支（见文件头注释）：
 *      a. previewHint + 非 condensed + 非 verbose → 返回简洁预览提示
 *      b. 无 previewHint + condensed + 非 verbose → 返回纯文本行数统计
 *      c. 其他 → 返回完整 diff（行数统计 + StructuredDiffList）
 *
 * 在系统中的角色：
 *   是文件编辑完成后用户界面的最终呈现组件，根据显示模式提供从简洁到详细的多级展示。
 */
export function FileEditToolUpdatedMessage(t0) {
  // React Compiler：_c(22) 分配 22 个插槽的记忆化缓存数组
  const $ = _c(22);
  const {
    filePath,
    structuredPatch,
    firstLine,
    fileContent,
    style,
    verbose,
    previewHint
  } = t0;
  // 读取终端当前列数，用于控制 diff 渲染宽度
  const {
    columns
  } = useTerminalSize();
  // 统计所有 hunk 中以 '+' 开头的行数（新增行）
  const numAdditions = structuredPatch.reduce(_temp2, 0);
  // 统计所有 hunk 中以 '-' 开头的行数（删除行）
  const numRemovals = structuredPatch.reduce(_temp4, 0);
  let t1;
  // 缓存新增行数显示节点：仅在 numAdditions 变化时重新创建
  if ($[0] !== numAdditions) {
    // numAdditions > 0：显示 "Added N line(s)"；否则为 null（不显示）
    t1 = numAdditions > 0 ? <>Added <Text bold={true}>{numAdditions}</Text>{" "}{numAdditions > 1 ? "lines" : "line"}</> : null;
    $[0] = numAdditions;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  // 两者都有时才显示分隔逗号
  const t2 = numAdditions > 0 && numRemovals > 0 ? ", " : null;
  let t3;
  // 缓存删除行数显示节点：numAdditions 或 numRemovals 变化时重新创建
  if ($[2] !== numAdditions || $[3] !== numRemovals) {
    // numRemovals > 0：若 numAdditions=0 则首字母大写（"Removed"），否则小写（"removed"）
    t3 = numRemovals > 0 ? <>{numAdditions === 0 ? "R" : "r"}emoved <Text bold={true}>{numRemovals}</Text>{" "}{numRemovals > 1 ? "lines" : "line"}</> : null;
    $[2] = numAdditions;
    $[3] = numRemovals;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  // 缓存完整行数统计文本节点
  if ($[5] !== t1 || $[6] !== t2 || $[7] !== t3) {
    t4 = <Text>{t1}{t2}{t3}</Text>;
    $[5] = t1;
    $[6] = t2;
    $[7] = t3;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const text = t4;
  if (previewHint) {
    // 计划文件预览模式：非 condensed 且非 verbose 时仅显示提示文本
    if (style !== "condensed" && !verbose) {
      let t5;
      // 缓存预览提示节点：previewHint 变化时重新创建
      if ($[9] !== previewHint) {
        t5 = <MessageResponse><Text dimColor={true}>{previewHint}</Text></MessageResponse>;
        $[9] = previewHint;
        $[10] = t5;
      } else {
        t5 = $[10];
      }
      return t5;
    }
  } else {
    // 无预览提示：condensed + 非 verbose 模式仅显示行数统计文本
    if (style === "condensed" && !verbose) {
      return text;
    }
  }
  let t5;
  // 缓存行数统计文本包装节点
  if ($[11] !== text) {
    t5 = <Text>{text}</Text>;
    $[11] = text;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  // 计算 diff 渲染宽度：为左侧边距预留 12 列
  const t6 = columns - 12;
  let t7;
  // 缓存 StructuredDiffList 节点：任意依赖变化时重新创建
  if ($[13] !== fileContent || $[14] !== filePath || $[15] !== firstLine || $[16] !== structuredPatch || $[17] !== t6) {
    t7 = <StructuredDiffList hunks={structuredPatch} dim={false} width={t6} filePath={filePath} firstLine={firstLine} fileContent={fileContent} />;
    $[13] = fileContent;
    $[14] = filePath;
    $[15] = firstLine;
    $[16] = structuredPatch;
    $[17] = t6;
    $[18] = t7;
  } else {
    t7 = $[18];
  }
  let t8;
  // 缓存完整 diff 容器节点：行数统计或 diff 列表变化时重新创建
  if ($[19] !== t5 || $[20] !== t7) {
    // 完整模式：在 MessageResponse 容器内展示行数统计 + diff 视图
    t8 = <MessageResponse><Box flexDirection="column">{t5}{t7}</Box></MessageResponse>;
    $[19] = t5;
    $[20] = t7;
    $[21] = t8;
  } else {
    t8 = $[21];
  }
  return t8;
}

// React Compiler 提升的 reduce 回调：统计删除行数（以 '-' 开头的行）
function _temp4(acc_0, hunk_0) {
  return acc_0 + count(hunk_0.lines, _temp3);
}
// 删除行判断谓词
function _temp3(__0) {
  return __0.startsWith("-");
}
// React Compiler 提升的 reduce 回调：统计新增行数（以 '+' 开头的行）
function _temp2(acc, hunk) {
  return acc + count(hunk.lines, _temp);
}
// 新增行判断谓词
function _temp(_) {
  return _.startsWith("+");
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTdHJ1Y3R1cmVkUGF0Y2hIdW5rIiwiUmVhY3QiLCJ1c2VUZXJtaW5hbFNpemUiLCJCb3giLCJUZXh0IiwiY291bnQiLCJNZXNzYWdlUmVzcG9uc2UiLCJTdHJ1Y3R1cmVkRGlmZkxpc3QiLCJQcm9wcyIsImZpbGVQYXRoIiwic3RydWN0dXJlZFBhdGNoIiwiZmlyc3RMaW5lIiwiZmlsZUNvbnRlbnQiLCJzdHlsZSIsInZlcmJvc2UiLCJwcmV2aWV3SGludCIsIkZpbGVFZGl0VG9vbFVwZGF0ZWRNZXNzYWdlIiwidDAiLCIkIiwiX2MiLCJjb2x1bW5zIiwibnVtQWRkaXRpb25zIiwicmVkdWNlIiwiX3RlbXAyIiwibnVtUmVtb3ZhbHMiLCJfdGVtcDQiLCJ0MSIsInQyIiwidDMiLCJ0NCIsInRleHQiLCJ0NSIsInQ2IiwidDciLCJ0OCIsImFjY18wIiwiaHVua18wIiwiYWNjIiwiaHVuayIsImxpbmVzIiwiX3RlbXAzIiwiX18wIiwiXyIsInN0YXJ0c1dpdGgiLCJfdGVtcCJdLCJzb3VyY2VzIjpbIkZpbGVFZGl0VG9vbFVwZGF0ZWRNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICcuLi9ob29rcy91c2VUZXJtaW5hbFNpemUuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi9pbmsuanMnXG5pbXBvcnQgeyBjb3VudCB9IGZyb20gJy4uL3V0aWxzL2FycmF5LmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBTdHJ1Y3R1cmVkRGlmZkxpc3QgfSBmcm9tICcuL1N0cnVjdHVyZWREaWZmTGlzdC5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgZmlsZVBhdGg6IHN0cmluZ1xuICBzdHJ1Y3R1cmVkUGF0Y2g6IFN0cnVjdHVyZWRQYXRjaEh1bmtbXVxuICBmaXJzdExpbmU6IHN0cmluZyB8IG51bGxcbiAgZmlsZUNvbnRlbnQ/OiBzdHJpbmdcbiAgc3R5bGU/OiAnY29uZGVuc2VkJ1xuICB2ZXJib3NlOiBib29sZWFuXG4gIHByZXZpZXdIaW50Pzogc3RyaW5nXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBGaWxlRWRpdFRvb2xVcGRhdGVkTWVzc2FnZSh7XG4gIGZpbGVQYXRoLFxuICBzdHJ1Y3R1cmVkUGF0Y2gsXG4gIGZpcnN0TGluZSxcbiAgZmlsZUNvbnRlbnQsXG4gIHN0eWxlLFxuICB2ZXJib3NlLFxuICBwcmV2aWV3SGludCxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBjb2x1bW5zIH0gPSB1c2VUZXJtaW5hbFNpemUoKVxuICBjb25zdCBudW1BZGRpdGlvbnMgPSBzdHJ1Y3R1cmVkUGF0Y2gucmVkdWNlKFxuICAgIChhY2MsIGh1bmspID0+IGFjYyArIGNvdW50KGh1bmsubGluZXMsIF8gPT4gXy5zdGFydHNXaXRoKCcrJykpLFxuICAgIDAsXG4gIClcbiAgY29uc3QgbnVtUmVtb3ZhbHMgPSBzdHJ1Y3R1cmVkUGF0Y2gucmVkdWNlKFxuICAgIChhY2MsIGh1bmspID0+IGFjYyArIGNvdW50KGh1bmsubGluZXMsIF8gPT4gXy5zdGFydHNXaXRoKCctJykpLFxuICAgIDAsXG4gIClcblxuICBjb25zdCB0ZXh0ID0gKFxuICAgIDxUZXh0PlxuICAgICAge251bUFkZGl0aW9ucyA+IDAgPyAoXG4gICAgICAgIDw+XG4gICAgICAgICAgQWRkZWQgPFRleHQgYm9sZD57bnVtQWRkaXRpb25zfTwvVGV4dD57JyAnfVxuICAgICAgICAgIHtudW1BZGRpdGlvbnMgPiAxID8gJ2xpbmVzJyA6ICdsaW5lJ31cbiAgICAgICAgPC8+XG4gICAgICApIDogbnVsbH1cbiAgICAgIHtudW1BZGRpdGlvbnMgPiAwICYmIG51bVJlbW92YWxzID4gMCA/ICcsICcgOiBudWxsfVxuICAgICAge251bVJlbW92YWxzID4gMCA/IChcbiAgICAgICAgPD5cbiAgICAgICAgICB7bnVtQWRkaXRpb25zID09PSAwID8gJ1InIDogJ3InfWVtb3ZlZCA8VGV4dCBib2xkPntudW1SZW1vdmFsc308L1RleHQ+eycgJ31cbiAgICAgICAgICB7bnVtUmVtb3ZhbHMgPiAxID8gJ2xpbmVzJyA6ICdsaW5lJ31cbiAgICAgICAgPC8+XG4gICAgICApIDogbnVsbH1cbiAgICA8L1RleHQ+XG4gIClcblxuICAvLyBQbGFuIGZpbGVzOiBpbnZlcnQgY29uZGVuc2VkIGJlaGF2aW9yXG4gIC8vIC0gUmVndWxhciBtb2RlOiBqdXN0IHNob3cgdGhlIGhpbnQgKHVzZXIgY2FuIHR5cGUgL3BsYW4gdG8gc2VlIGZ1bGwgY29udGVudClcbiAgLy8gLSBDb25kZW5zZWQgbW9kZSAoc3ViYWdlbnQgdmlldyk6IHNob3cgdGhlIGRpZmZcbiAgaWYgKHByZXZpZXdIaW50KSB7XG4gICAgaWYgKHN0eWxlICE9PSAnY29uZGVuc2VkJyAmJiAhdmVyYm9zZSkge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57cHJldmlld0hpbnR9PC9UZXh0PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcbiAgICB9XG4gIH0gZWxzZSBpZiAoc3R5bGUgPT09ICdjb25kZW5zZWQnICYmICF2ZXJib3NlKSB7XG4gICAgcmV0dXJuIHRleHRcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8VGV4dD57dGV4dH08L1RleHQ+XG4gICAgICAgIDxTdHJ1Y3R1cmVkRGlmZkxpc3RcbiAgICAgICAgICBodW5rcz17c3RydWN0dXJlZFBhdGNofVxuICAgICAgICAgIGRpbT17ZmFsc2V9XG4gICAgICAgICAgd2lkdGg9e2NvbHVtbnMgLSAxMn1cbiAgICAgICAgICBmaWxlUGF0aD17ZmlsZVBhdGh9XG4gICAgICAgICAgZmlyc3RMaW5lPXtmaXJzdExpbmV9XG4gICAgICAgICAgZmlsZUNvbnRlbnQ9e2ZpbGVDb250ZW50fVxuICAgICAgICAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLG1CQUFtQixRQUFRLE1BQU07QUFDL0MsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxlQUFlLFFBQVEsNkJBQTZCO0FBQzdELFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLFdBQVc7QUFDckMsU0FBU0MsS0FBSyxRQUFRLG1CQUFtQjtBQUN6QyxTQUFTQyxlQUFlLFFBQVEsc0JBQXNCO0FBQ3RELFNBQVNDLGtCQUFrQixRQUFRLHlCQUF5QjtBQUU1RCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsUUFBUSxFQUFFLE1BQU07RUFDaEJDLGVBQWUsRUFBRVYsbUJBQW1CLEVBQUU7RUFDdENXLFNBQVMsRUFBRSxNQUFNLEdBQUcsSUFBSTtFQUN4QkMsV0FBVyxDQUFDLEVBQUUsTUFBTTtFQUNwQkMsS0FBSyxDQUFDLEVBQUUsV0FBVztFQUNuQkMsT0FBTyxFQUFFLE9BQU87RUFDaEJDLFdBQVcsQ0FBQyxFQUFFLE1BQU07QUFDdEIsQ0FBQztBQUVELE9BQU8sU0FBQUMsMkJBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBb0M7SUFBQVYsUUFBQTtJQUFBQyxlQUFBO0lBQUFDLFNBQUE7SUFBQUMsV0FBQTtJQUFBQyxLQUFBO0lBQUFDLE9BQUE7SUFBQUM7RUFBQSxJQUFBRSxFQVFuQztFQUNOO0lBQUFHO0VBQUEsSUFBb0JsQixlQUFlLENBQUMsQ0FBQztFQUNyQyxNQUFBbUIsWUFBQSxHQUFxQlgsZUFBZSxDQUFBWSxNQUFPLENBQ3pDQyxNQUE4RCxFQUM5RCxDQUNGLENBQUM7RUFDRCxNQUFBQyxX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QTtFQUFBLElBQUFmLENBQUEsU0FBQU4sV0FBQSxJQUFBTSxDQUFBLFNBQUFULFFBQUEsSUFBQVMsQ0FBQSxTQUFBUCxTQUFBLElBQUFPLENBQUEsU0FBQVIsZUFBQSxJQUFBUSxDQUFBLFNBQUFjLEVBQUE7SUFIckJDLEVBQUEsSUFBQyxrQkFBa0IsQ0FDVnZCLEtBQWUsQ0FBZkEsZ0JBQWMsQ0FBQyxDQUNqQixHQUFLLENBQUwsTUFBSSxDQUFDLENBQ0gsS0FBWSxDQUFaLENBQUFzQixFQUFXLENBQUMsQ0FDVHZCLFFBQVEsQ0FBUkEsU0FBTyxDQUFDLENBQ1BFLFNBQVMsQ0FBVEEsVUFBUSxDQUFDLENBQ1BDLFdBQVcsQ0FBWEEsWUFBVSxDQUFDLEdBQ3hCO0lBQUFNLENBQUEsT0FBQU4sV0FBQTtJQUFBTSxDQUFBLE9BQUFULFFBQUE7SUFBQVMsQ0FBQSxPQUFBUCxTQUFBO0lBQUFPLENBQUEsT0FBQVIsZUFBQTtJQUFBUSxDQUFBLE9BQUFjLEVBQUE7SUFBQWQsQ0FBQSxPQUFBZSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZixDQUFBO0VBQUE7RUFBQSxJQUFBZ0IsRUFBQTtFQUFBLElBQUFoQixDQUFBLFNBQUFhLEVBQUEsSUFBQWIsQ0FBQSxTQUFBZSxFQUFBO0lBVk5DLEVBQUEsSUFBQyxlQUFlLENBQ2QsQ0FBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FDekIsQ0FBQUgsRUFBa0IsQ0FDbEIsQ0FBQUUsRUFPQyxDQUNILEVBVkMsR0FBRyxDQVdOLEVBWkMsZUFBZSxDQVlFO0lBQUFmLENBQUEsT0FBQWEsRUFBQTtJQUFBYixDQUFBLE9BQUFlLEVBQUE7SUFBQWYsQ0FBQSxPQUFBZ0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWhCLENBQUE7RUFBQTtFQUFBLE9BWmxCZ0IsRUFZa0I7QUFBQTtBQWpFZixTQUFBVCxPQUFBVSxLQUFBLEVBQUFDLE1BQUE7RUFBQSxPQWVZQyxLQUFHLEdBQUdoQyxLQUFLLENBQUNpQyxNQUFJLENBQUFDLEtBQU0sRUFBRUMsTUFBc0IsQ0FBQztBQUFBO0FBZjNELFNBQUFBLE9BQUFDLEdBQUE7RUFBQSxPQWV5Q0MsR0FBQyxDQUFBQyxVQUFXLENBQUMsR0FBRyxDQUFDO0FBQUE7QUFmMUQsU0FBQXBCLE9BQUFjLEdBQUEsRUFBQUMsSUFBQTtFQUFBLE9BV1lELEdBQUcsR0FBR2hDLEtBQUssQ0FBQ2lDLElBQUksQ0FBQUMsS0FBTSxFQUFFSyxLQUFzQixDQUFDO0FBQUE7QUFYM0QsU0FBQUEsTUFBQUYsQ0FBQTtFQUFBLE9BV3lDQSxDQUFDLENBQUFDLFVBQVcsQ0FBQyxHQUFHLENBQUM7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==