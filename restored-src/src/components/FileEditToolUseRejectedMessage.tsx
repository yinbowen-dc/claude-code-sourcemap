/**
 * FileEditToolUseRejectedMessage.tsx — 文件编辑工具被用户拒绝时的消息展示组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具调用结果渲染 → FileEditToolUseRejectedMessage
 *   → 当用户拒绝 FileEditTool 的写入/更新操作时，展示操作被拒绝的摘要或内容预览
 *
 * 主要功能：
 *   FileEditToolUseRejectedMessage：React 函数组件，根据操作类型和显示模式，
 *   以四条渲染路径之一展示被拒绝的文件操作摘要：
 *     路径1：condensed 模式（非 verbose）→ 仅显示纯文本提示
 *     路径2：write 操作 + 有 content → 显示截断的代码高亮预览（最多 MAX_LINES_TO_RENDER 行）
 *     路径3：无 patch 或 patch 为空 → 仅显示纯文本提示
 *     路径4：update 操作 + 有效 patch → 显示完整的结构化 diff（dim 模式）
 *
 * React Compiler 优化：
 *   - 使用 _c(38) 分配 38 个记忆化缓存槽，对所有 JSX 节点和计算值进行细粒度缓存
 *   - 每个 JSX 片段在依赖 props 未变化时直接复用缓存，避免不必要的重渲染
 */
import { c as _c } from "react/compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import { relative } from 'path';
import * as React from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { getCwd } from 'src/utils/cwd.js';
import { Box, Text } from '../ink.js';
import { HighlightedCode } from './HighlightedCode.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';
// 内容预览模式下最多渲染的行数，超出部分用"… +N lines"折叠
const MAX_LINES_TO_RENDER = 10;
type Props = {
  file_path: string;
  operation: 'write' | 'update';
  // For updates - show diff
  patch?: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  // For new file creation - show content preview
  content?: string;
  style?: 'condensed';
  verbose: boolean;
};
/**
 * FileEditToolUseRejectedMessage
 *
 * 整体流程：
 *   1. 从 props 解构所有字段，获取终端列宽（columns）用于计算代码/diff 宽度
 *   2. 构建通用文本头部（text）：
 *      "User rejected {operation} to {filePath}"
 *      - verbose=true → 显示绝对路径；verbose=false → 显示相对于 cwd 的路径
 *   3. 按优先级依次检查四条渲染路径：
 *      路径1：style==='condensed' && !verbose → 仅返回文本提示（MessageResponse）
 *      路径2：operation==='write' && content !== undefined
 *             → 截断为 MAX_LINES_TO_RENDER 行，展示 HighlightedCode（dim）
 *               + 可选的"… +N lines"折叠提示
 *      路径3：!patch || patch.length===0 → 仅返回文本提示（MessageResponse）
 *      路径4：其他（update 操作有效 patch）
 *             → 展示 StructuredDiffList（dim），columns-12 宽度
 *
 * 在系统中的角色：
 *   是 FileEditTool 操作被用户拒绝时的唯一展示组件，
 *   与 FileEditToolUpdatedMessage（成功路径）相对应，
 *   为用户提供被拒绝操作的内容上下文。
 */
export function FileEditToolUseRejectedMessage(t0) {
  // React Compiler 分配 38 个缓存槽，对所有 JSX 和计算值进行细粒度记忆化
  const $ = _c(38);
  const {
    file_path,
    operation,
    patch,
    firstLine,
    fileContent,
    content,
    style,
    verbose
  } = t0;
  // 获取终端列宽，用于确定代码预览和 diff 的渲染宽度
  const {
    columns
  } = useTerminalSize();

  // ── 构建文本头部（t1）：含 operation 类型的操作描述 ──
  // 缓存槽 $[0]/$[1]：operation 变化时重新创建"User rejected {operation} to"文本节点
  let t1;
  if ($[0] !== operation) {
    t1 = <Text color="subtle">User rejected {operation} to </Text>;
    $[0] = operation;
    $[1] = t1;
  } else {
    t1 = $[1];
  }

  // 缓存槽 $[2]/$[3]/$[4]：file_path 或 verbose 变化时重新计算展示路径
  // verbose=true → 绝对路径；verbose=false → 相对于 getCwd() 的路径
  let t2;
  if ($[2] !== file_path || $[3] !== verbose) {
    t2 = verbose ? file_path : relative(getCwd(), file_path);
    $[2] = file_path;
    $[3] = verbose;
    $[4] = t2;
  } else {
    t2 = $[4];
  }

  // 缓存槽 $[5]/$[6]：路径字符串变化时重新创建加粗路径文本节点
  let t3;
  if ($[5] !== t2) {
    t3 = <Text bold={true} color="subtle">{t2}</Text>;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }

  // 缓存槽 $[7]/$[8]/$[9]：t1 或 t3 变化时重新创建文本头部行容器
  let t4;
  if ($[7] !== t1 || $[8] !== t3) {
    t4 = <Box flexDirection="row">{t1}{t3}</Box>;
    $[7] = t1;
    $[8] = t3;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  // text：最终的操作描述标题，供所有渲染路径复用
  const text = t4;

  // ── 渲染路径1：condensed 模式（非 verbose）→ 只显示简短文本 ──
  if (style === "condensed" && !verbose) {
    // 缓存槽 $[10]/$[11]：text 未变化则复用之前的 MessageResponse 节点
    let t5;
    if ($[10] !== text) {
      t5 = <MessageResponse>{text}</MessageResponse>;
      $[10] = text;
      $[11] = t5;
    } else {
      t5 = $[11];
    }
    return t5;
  }

  // ── 渲染路径2：write 操作 + 有 content → 显示截断的代码高亮预览 ──
  if (operation === "write" && content !== undefined) {
    let plusLines;
    let t5;
    // 缓存槽 $[12]-$[15]：content 或 verbose 变化时重新计算行数和截断内容
    if ($[12] !== content || $[13] !== verbose) {
      const lines = content.split("\n");
      const numLines = lines.length;
      // plusLines：超出 MAX_LINES_TO_RENDER 的行数，用于"… +N lines"提示
      plusLines = numLines - MAX_LINES_TO_RENDER;
      // verbose=true → 显示完整内容；verbose=false → 截断为前 MAX_LINES_TO_RENDER 行
      t5 = verbose ? content : lines.slice(0, MAX_LINES_TO_RENDER).join("\n");
      $[12] = content;
      $[13] = verbose;
      $[14] = plusLines;
      $[15] = t5;
    } else {
      plusLines = $[14];
      t5 = $[15];
    }
    // truncatedContent：最终传给 HighlightedCode 的代码字符串
    const truncatedContent = t5;
    // 若截断后内容为空，显示"(No content)"占位符
    const t6 = truncatedContent || "(No content)";
    // 代码预览宽度 = 终端列宽 - 12（留出边距）
    const t7 = columns - 12;
    // 缓存槽 $[16]-$[19]：file_path、代码内容或宽度变化时重新创建 HighlightedCode 节点
    let t8;
    if ($[16] !== file_path || $[17] !== t6 || $[18] !== t7) {
      t8 = <HighlightedCode code={t6} filePath={file_path} width={t7} dim={true} />;
      $[16] = file_path;
      $[17] = t6;
      $[18] = t7;
      $[19] = t8;
    } else {
      t8 = $[19];
    }
    // 缓存槽 $[20]-$[22]：plusLines 或 verbose 变化时重新计算"… +N lines"折叠提示
    // 仅在非 verbose 模式且有超出行数时显示
    let t9;
    if ($[20] !== plusLines || $[21] !== verbose) {
      t9 = !verbose && plusLines > 0 && <Text dimColor={true}>… +{plusLines} lines</Text>;
      $[20] = plusLines;
      $[21] = verbose;
      $[22] = t9;
    } else {
      t9 = $[22];
    }
    // 缓存槽 $[23]-$[26]：任意子节点变化时重新创建完整的 write 预览容器
    let t10;
    if ($[23] !== t8 || $[24] !== t9 || $[25] !== text) {
      t10 = <MessageResponse><Box flexDirection="column">{text}{t8}{t9}</Box></MessageResponse>;
      $[23] = t8;
      $[24] = t9;
      $[25] = text;
      $[26] = t10;
    } else {
      t10 = $[26];
    }
    return t10;
  }

  // ── 渲染路径3：无 patch 或 patch 为空 → 只显示文本提示 ──
  if (!patch || patch.length === 0) {
    // 缓存槽 $[27]/$[28]：text 未变化则复用之前的 MessageResponse 节点
    let t5;
    if ($[27] !== text) {
      t5 = <MessageResponse>{text}</MessageResponse>;
      $[27] = text;
      $[28] = t5;
    } else {
      t5 = $[28];
    }
    return t5;
  }

  // ── 渲染路径4：update 操作 + 有效 patch → 显示结构化 diff ──
  // diff 渲染宽度 = 终端列宽 - 12
  const t5 = columns - 12;
  // 缓存槽 $[29]-$[34]：任意 diff 相关 prop 变化时重新创建 StructuredDiffList 节点
  let t6;
  if ($[29] !== fileContent || $[30] !== file_path || $[31] !== firstLine || $[32] !== patch || $[33] !== t5) {
    // dim={true}：以灰显方式渲染 diff，表示这是被拒绝的变更
    t6 = <StructuredDiffList hunks={patch} dim={true} width={t5} filePath={file_path} firstLine={firstLine} fileContent={fileContent} />;
    $[29] = fileContent;
    $[30] = file_path;
    $[31] = firstLine;
    $[32] = patch;
    $[33] = t5;
    $[34] = t6;
  } else {
    t6 = $[34];
  }
  // 缓存槽 $[35]-$[37]：t6 或 text 变化时重新创建完整的 update diff 容器
  let t7;
  if ($[35] !== t6 || $[36] !== text) {
    t7 = <MessageResponse><Box flexDirection="column">{text}{t6}</Box></MessageResponse>;
    $[35] = t6;
    $[36] = text;
    $[37] = t7;
  } else {
    t7 = $[37];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTdHJ1Y3R1cmVkUGF0Y2hIdW5rIiwicmVsYXRpdmUiLCJSZWFjdCIsInVzZVRlcm1pbmFsU2l6ZSIsImdldEN3ZCIsIkJveCIsIlRleHQiLCJIaWdobGlnaHRlZENvZGUiLCJNZXNzYWdlUmVzcG9uc2UiLCJTdHJ1Y3R1cmVkRGlmZkxpc3QiLCJNQVhfTElORVNfVE9fUkVOREVSIiwiUHJvcHMiLCJmaWxlX3BhdGgiLCJvcGVyYXRpb24iLCJwYXRjaCIsImZpcnN0TGluZSIsImZpbGVDb250ZW50IiwiY29udGVudCIsInN0eWxlIiwidmVyYm9zZSIsIkZpbGVFZGl0VG9vbFVzZVJlamVjdGVkTWVzc2FnZSIsInQwIiwiJCIsIl9jIiwiY29sdW1ucyIsInQxIiwidDIiLCJ0MyIsInQ0IiwidGV4dCIsInQ1IiwidW5kZWZpbmVkIiwicGx1c0xpbmVzIiwibGluZXMiLCJzcGxpdCIsIm51bUxpbmVzIiwibGVuZ3RoIiwic2xpY2UiLCJqb2luIiwidHJ1bmNhdGVkQ29udGVudCIsInQ2IiwidDciLCJ0OCIsInQ5IiwidDEwIl0sInNvdXJjZXMiOlsiRmlsZUVkaXRUb29sVXNlUmVqZWN0ZWRNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0IHsgcmVsYXRpdmUgfSBmcm9tICdwYXRoJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICdzcmMvaG9va3MvdXNlVGVybWluYWxTaXplLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnc3JjL3V0aWxzL2N3ZC5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7IEhpZ2hsaWdodGVkQ29kZSB9IGZyb20gJy4vSGlnaGxpZ2h0ZWRDb2RlLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBTdHJ1Y3R1cmVkRGlmZkxpc3QgfSBmcm9tICcuL1N0cnVjdHVyZWREaWZmTGlzdC5qcydcblxuY29uc3QgTUFYX0xJTkVTX1RPX1JFTkRFUiA9IDEwXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGZpbGVfcGF0aDogc3RyaW5nXG4gIG9wZXJhdGlvbjogJ3dyaXRlJyB8ICd1cGRhdGUnXG4gIC8vIEZvciB1cGRhdGVzIC0gc2hvdyBkaWZmXG4gIHBhdGNoPzogU3RydWN0dXJlZFBhdGNoSHVua1tdXG4gIGZpcnN0TGluZTogc3RyaW5nIHwgbnVsbFxuICBmaWxlQ29udGVudD86IHN0cmluZ1xuICAvLyBGb3IgbmV3IGZpbGUgY3JlYXRpb24gLSBzaG93IGNvbnRlbnQgcHJldmlld1xuICBjb250ZW50Pzogc3RyaW5nXG4gIHN0eWxlPzogJ2NvbmRlbnNlZCdcbiAgdmVyYm9zZTogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gRmlsZUVkaXRUb29sVXNlUmVqZWN0ZWRNZXNzYWdlKHtcbiAgZmlsZV9wYXRoLFxuICBvcGVyYXRpb24sXG4gIHBhdGNoLFxuICBmaXJzdExpbmUsXG4gIGZpbGVDb250ZW50LFxuICBjb250ZW50LFxuICBzdHlsZSxcbiAgdmVyYm9zZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBjb2x1bW5zIH0gPSB1c2VUZXJtaW5hbFNpemUoKVxuICBjb25zdCB0ZXh0ID0gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgPFRleHQgY29sb3I9XCJzdWJ0bGVcIj5Vc2VyIHJlamVjdGVkIHtvcGVyYXRpb259IHRvIDwvVGV4dD5cbiAgICAgIDxUZXh0IGJvbGQgY29sb3I9XCJzdWJ0bGVcIj5cbiAgICAgICAge3ZlcmJvc2UgPyBmaWxlX3BhdGggOiByZWxhdGl2ZShnZXRDd2QoKSwgZmlsZV9wYXRoKX1cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxuXG4gIC8vIEZvciBjb25kZW5zZWQgc3R5bGUsIGp1c3Qgc2hvdyB0aGUgdGV4dFxuICBpZiAoc3R5bGUgPT09ICdjb25kZW5zZWQnICYmICF2ZXJib3NlKSB7XG4gICAgcmV0dXJuIDxNZXNzYWdlUmVzcG9uc2U+e3RleHR9PC9NZXNzYWdlUmVzcG9uc2U+XG4gIH1cblxuICAvLyBGb3IgbmV3IGZpbGUgY3JlYXRpb24sIHNob3cgY29udGVudCBwcmV2aWV3IChkaW1tZWQpXG4gIGlmIChvcGVyYXRpb24gPT09ICd3cml0ZScgJiYgY29udGVudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KCdcXG4nKVxuICAgIGNvbnN0IG51bUxpbmVzID0gbGluZXMubGVuZ3RoXG4gICAgY29uc3QgcGx1c0xpbmVzID0gbnVtTGluZXMgLSBNQVhfTElORVNfVE9fUkVOREVSXG4gICAgY29uc3QgdHJ1bmNhdGVkQ29udGVudCA9IHZlcmJvc2VcbiAgICAgID8gY29udGVudFxuICAgICAgOiBsaW5lcy5zbGljZSgwLCBNQVhfTElORVNfVE9fUkVOREVSKS5qb2luKCdcXG4nKVxuXG4gICAgcmV0dXJuIChcbiAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgIHt0ZXh0fVxuICAgICAgICAgIDxIaWdobGlnaHRlZENvZGVcbiAgICAgICAgICAgIGNvZGU9e3RydW5jYXRlZENvbnRlbnQgfHwgJyhObyBjb250ZW50KSd9XG4gICAgICAgICAgICBmaWxlUGF0aD17ZmlsZV9wYXRofVxuICAgICAgICAgICAgd2lkdGg9e2NvbHVtbnMgLSAxMn1cbiAgICAgICAgICAgIGRpbVxuICAgICAgICAgIC8+XG4gICAgICAgICAgeyF2ZXJib3NlICYmIHBsdXNMaW5lcyA+IDAgJiYgKFxuICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+4oCmICt7cGx1c0xpbmVzfSBsaW5lczwvVGV4dD5cbiAgICAgICAgICApfVxuICAgICAgICA8L0JveD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuXG4gIC8vIEZvciB1cGRhdGVzLCBzaG93IGRpZmZcbiAgaWYgKCFwYXRjaCB8fCBwYXRjaC5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gPE1lc3NhZ2VSZXNwb25zZT57dGV4dH08L01lc3NhZ2VSZXNwb25zZT5cbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICB7dGV4dH1cbiAgICAgICAgPFN0cnVjdHVyZWREaWZmTGlzdFxuICAgICAgICAgIGh1bmtzPXtwYXRjaH1cbiAgICAgICAgICBkaW1cbiAgICAgICAgICB3aWR0aD17Y29sdW1ucyAtIDEyfVxuICAgICAgICAgIGZpbGVQYXRoPXtmaWxlX3BhdGh9XG4gICAgICAgICAgZmlyc3RMaW5lPXtmaXJzdExpbmV9XG4gICAgICAgICAgZmlsZUNvbnRlbnQ9e2ZpbGVDb250ZW50fVxuICAgICAgICAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLG1CQUFtQixRQUFRLE1BQU07QUFDL0MsU0FBU0MsUUFBUSxRQUFRLE1BQU07QUFDL0IsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxlQUFlLFFBQVEsOEJBQThCO0FBQzlELFNBQVNDLE1BQU0sUUFBUSxrQkFBa0I7QUFDekMsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsV0FBVztBQUNyQyxTQUFTQyxlQUFlLFFBQVEsc0JBQXNCO0FBQ3RELFNBQVNDLGVBQWUsUUFBUSxzQkFBc0I7QUFDdEQsU0FBU0Msa0JBQWtCLFFBQVEseUJBQXlCO0FBRTVELE1BQU1DLG1CQUFtQixHQUFHLEVBQUU7QUFFOUIsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLFNBQVMsRUFBRSxNQUFN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