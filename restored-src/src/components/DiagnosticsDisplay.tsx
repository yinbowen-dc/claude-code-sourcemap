/**
 * DiagnosticsDisplay.tsx — 诊断信息展示组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   消息响应层 → 附件渲染 → 诊断信息（LSP diagnostics）展示
 *
 * 主要功能：
 *   1. DiagnosticsDisplay：React 组件，根据 verbose 模式决定展示方式：
 *      - verbose=true → 展开所有文件的全量诊断信息（文件名 + 每条 issue 的位置和消息）
 *      - verbose=false → 仅显示汇总摘要（"Found N issues in M files" + Ctrl+O 提示）
 *   2. _temp3（React Compiler 提取）：渲染单个文件的诊断块，包含文件路径和协议类型。
 *   3. _temp2（React Compiler 提取）：渲染单条诊断记录，包含严重程度符号、行列号和消息。
 *   4. _temp（React Compiler 提取）：reduce 回调，累加所有文件的诊断条目总数。
 *
 * 协议前缀处理：
 *   - "file://" → 标准本地文件系统
 *   - "_claude_fs_right:" → Claude 右侧文件系统
 *   - 其他 → 提取 URI 协议前缀
 */
import { c as _c } from "react/compiler-runtime";
import { relative } from 'path';
import React from 'react';
import { Box, Text } from '../ink.js';
import { DiagnosticTrackingService } from '../services/diagnosticTracking.js';
import type { Attachment } from '../utils/attachments.js';
import { getCwd } from '../utils/cwd.js';
import { CtrlOToExpand } from './CtrlOToExpand.js';
import { MessageResponse } from './MessageResponse.js';

// DiagnosticsAttachment：从 Attachment 联合类型中提取 type='diagnostics' 的子类型
type DiagnosticsAttachment = Extract<Attachment, {
  type: 'diagnostics';
}>;

// DiagnosticsDisplayProps：组件接收诊断附件和详细模式标志
type DiagnosticsDisplayProps = {
  attachment: DiagnosticsAttachment;
  verbose: boolean;
};

/**
 * DiagnosticsDisplay 组件
 *
 * 整体流程：
 *   1. 解构 attachment（诊断附件）和 verbose（是否展开详情）Props
 *   2. 若 attachment.files 为空，直接返回 null（无内容可显示）
 *   3. 计算 totalIssues（所有文件诊断条目总数），依赖 attachment.files，
 *      缓存于 $[0]-$[1]
 *   4. verbose=true 分支：
 *      - 将每个文件映射为详细展示块（_temp3），缓存于 $[2]-$[3]
 *      - 构建 Column Box 包含所有详细块，缓存于 $[4]-$[5]
 *   5. verbose=false 分支：
 *      - 构建加粗的 totalIssues 文本，缓存于 $[6]-$[7]
 *      - 计算单复数形式 t3（issue/issues）、t4（file/files）
 *      - 静态 CtrlOToExpand 组件，缓存于 $[8]
 *      - 构建摘要 MessageResponse，缓存于 $[9]-$[13]
 *
 * 在系统中的角色：
 *   作为 LSP 诊断信息的终端渲染层，在 Claude 对话中展示代码问题汇总或详情。
 */
export function DiagnosticsDisplay(t0) {
  // _c(14)：初始化 14 个 React Compiler 记忆缓存槽
  const $ = _c(14);
  const {
    attachment,
    verbose
  } = t0;

  // 无诊断文件时不渲染任何内容
  if (attachment.files.length === 0) {
    return null;
  }

  let t1;
  // $[0]-$[1] 槽：以 attachment.files 为依赖缓存总问题数
  if ($[0] !== attachment.files) {
    // files 变化：重新 reduce 累加所有文件的诊断条目数
    t1 = attachment.files.reduce(_temp, 0);
    $[0] = attachment.files;  // 存储依赖
    $[1] = t1;                // 存储累加结果
  } else {
    // 未变：复用缓存的总数
    t1 = $[1];
  }
  const totalIssues = t1;

  // 获取文件总数
  const fileCount = attachment.files.length;

  if (verbose) {
    // verbose=true：展开所有文件的详细诊断信息
    let t2;
    // $[2]-$[3] 槽：以 attachment.files 为依赖缓存详细块数组
    if ($[2] !== attachment.files) {
      // files 变化：重新映射每个文件为详细展示块
      t2 = attachment.files.map(_temp3);
      $[2] = attachment.files;  // 存储依赖
      $[3] = t2;                // 存储映射结果
    } else {
      // 未变：复用缓存的块数组
      t2 = $[3];
    }
    let t3;
    // $[4]-$[5] 槽：以 t2 为依赖缓存包裹 Box
    if ($[4] !== t2) {
      // 详细块数组变化：重新构建 Column Box
      t3 = <Box flexDirection="column">{t2}</Box>;
      $[4] = t2;   // 存储依赖
      $[5] = t3;   // 存储 JSX 结果
    } else {
      // 未变：复用缓存的 Box
      t3 = $[5];
    }
    return t3;
  } else {
    // verbose=false：显示摘要
    let t2;
    // $[6]-$[7] 槽：以 totalIssues 为依赖缓存加粗数字文本
    if ($[6] !== totalIssues) {
      // totalIssues 变化：重新创建加粗文本节点
      t2 = <Text bold={true}>{totalIssues}</Text>;
      $[6] = totalIssues;  // 存储依赖
      $[7] = t2;           // 存储 JSX 结果
    } else {
      // 未变：复用缓存的文本节点
      t2 = $[7];
    }

    // 根据数量选择单复数形式
    const t3 = totalIssues === 1 ? "issue" : "issues";
    const t4 = fileCount === 1 ? "file" : "files";

    let t5;
    // $[8] 槽：静态 CtrlOToExpand 组件，sentinel 缓存只创建一次
    if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <CtrlOToExpand />;
      $[8] = t5;
    } else {
      t5 = $[8];
    }

    let t6;
    // $[9]-$[13] 槽：以 fileCount、t2、t3、t4 四个依赖缓存摘要 MessageResponse
    if ($[9] !== fileCount || $[10] !== t2 || $[11] !== t3 || $[12] !== t4) {
      // 任一依赖变化：重新构建摘要行
      t6 = <MessageResponse><Text dimColor={true} wrap="wrap">Found {t2} new diagnostic{" "}{t3} in {fileCount}{" "}{t4} {t5}</Text></MessageResponse>;
      $[9] = fileCount;   // 存储 fileCount 依赖
      $[10] = t2;         // 存储 t2 依赖
      $[11] = t3;         // 存储 t3 依赖
      $[12] = t4;         // 存储 t4 依赖
      $[13] = t6;         // 存储 JSX 结果
    } else {
      // 均未变：复用缓存的摘要
      t6 = $[13];
    }
    return t6;
  }
}

/**
 * _temp3（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 attachment.files.map((file, fileIndex) => ...) 的内联函数
 *   - 渲染单个文件的诊断展示块：
 *     1. 将 URI 去除协议前缀，计算相对于当前工作目录的路径
 *     2. 在路径后标注 URI 协议类型（file://、claude_fs_right 或自定义协议）
 *     3. 遍历该文件的所有诊断条目，通过 _temp2 渲染每条记录
 *
 * 在系统中的角色：
 *   为 verbose 模式提供单文件诊断展示单元。
 */
function _temp3(file_0, fileIndex) {
  return <React.Fragment key={fileIndex}><MessageResponse><Text dimColor={true} wrap="wrap"><Text bold={true}>{relative(getCwd(), file_0.uri.replace("file://", "").replace("_claude_fs_right:", ""))}</Text>{" "}<Text dimColor={true}>{file_0.uri.startsWith("file://") ? "(file://)" : file_0.uri.startsWith("_claude_fs_right:") ? "(claude_fs_right)" : `(${file_0.uri.split(":")[0]})`}</Text>:</Text></MessageResponse>{file_0.diagnostics.map(_temp2)}</React.Fragment>;
}

/**
 * _temp2（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 file.diagnostics.map((diagnostic, diagIndex) => ...) 的内联函数
 *   - 渲染单条诊断记录：
 *     1. 通过 DiagnosticTrackingService.getSeveritySymbol 获取严重程度符号（如 ✖、⚠）
 *     2. 显示行列号（1-based，来自 LSP 0-based + 1）
 *     3. 显示诊断消息文本
 *     4. 可选显示错误代码（code）和来源（source）
 *
 * 在系统中的角色：
 *   为单条 LSP 诊断记录提供格式化的终端展示。
 */
function _temp2(diagnostic, diagIndex) {
  return <MessageResponse key={diagIndex}><Text dimColor={true} wrap="wrap">{"  "}{DiagnosticTrackingService.getSeveritySymbol(diagnostic.severity)}{" [Line "}{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}{"] "}{diagnostic.message}{diagnostic.code ? ` [${diagnostic.code}]` : ""}{diagnostic.source ? ` (${diagnostic.source})` : ""}</Text></MessageResponse>;
}

/**
 * _temp（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 attachment.files.reduce((sum, file) => sum + file.diagnostics.length, 0)
 *     的内联 reduce 回调
 *   - 每次累加一个文件中的诊断条目数量
 *
 * 在系统中的角色：
 *   为摘要视图提供诊断总数计算。
 */
function _temp(sum, file) {
  // 累加当前文件的诊断条目数
  return sum + file.diagnostics.length;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJyZWxhdGl2ZSIsIlJlYWN0IiwiQm94IiwiVGV4dCIsIkRpYWdub3N0aWNUcmFja2luZ1NlcnZpY2UiLCJBdHRhY2htZW50IiwiZ2V0Q3dkIiwiQ3RybE9Ub0V4cGFuZCIsIk1lc3NhZ2VSZXNwb25zZSIsIkRpYWdub3N0aWNzQXR0YWNobWVudCIsIkV4dHJhY3QiLCJ0eXBlIiwiRGlhZ25vc3RpY3NEaXNwbGF5UHJvcHMiLCJhdHRhY2htZW50IiwidmVyYm9zZSIsIkRpYWdub3N0aWNzRGlzcGxheSIsInQwIiwiJCIsIl9jIiwiZmlsZXMiLCJsZW5ndGgiLCJ0MSIsInJlZHVjZSIsIl90ZW1wIiwidG90YWxJc3N1ZXMiLCJmaWxlQ291bnQiLCJ0MiIsIm1hcCIsIl90ZW1wMyIsInQzIiwidDQiLCJ0NSIsIlN5bWJvbCIsImZvciIsInQ2IiwiZmlsZV8wIiwiZmlsZUluZGV4IiwiZmlsZSIsInVyaSIsInJlcGxhY2UiLCJzdGFydHNXaXRoIiwic3BsaXQiLCJkaWFnbm9zdGljcyIsIl90ZW1wMiIsImRpYWdub3N0aWMiLCJkaWFnSW5kZXgiLCJnZXRTZXZlcml0eVN5bWJvbCIsInNldmVyaXR5IiwicmFuZ2UiLCJzdGFydCIsImxpbmUiLCJjaGFyYWN0ZXIiLCJtZXNzYWdlIiwiY29kZSIsInNvdXJjZSIsInN1bSJdLCJzb3VyY2VzIjpbIkRpYWdub3N0aWNzRGlzcGxheS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVsYXRpdmUgfSBmcm9tICdwYXRoJ1xuaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgRGlhZ25vc3RpY1RyYWNraW5nU2VydmljZSB9IGZyb20gJy4uL3NlcnZpY2VzL2RpYWdub3N0aWNUcmFja2luZy5qcydcbmltcG9ydCB0eXBlIHsgQXR0YWNobWVudCB9IGZyb20gJy4uL3V0aWxzL2F0dGFjaG1lbnRzLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnLi4vdXRpbHMvY3dkLmpzJ1xuaW1wb3J0IHsgQ3RybE9Ub0V4cGFuZCB9IGZyb20gJy4vQ3RybE9Ub0V4cGFuZC5qcydcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4vTWVzc2FnZVJlc3BvbnNlLmpzJ1xuXG50eXBlIERpYWdub3N0aWNzQXR0YWNobWVudCA9IEV4dHJhY3Q8QXR0YWNobWVudCwgeyB0eXBlOiAnZGlhZ25vc3RpY3MnIH0+XG5cbnR5cGUgRGlhZ25vc3RpY3NEaXNwbGF5UHJvcHMgPSB7XG4gIGF0dGFjaG1lbnQ6IERpYWdub3N0aWNzQXR0YWNobWVudFxuICB2ZXJib3NlOiBib29sZWFuXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEaWFnbm9zdGljc0Rpc3BsYXkoe1xuICBhdHRhY2htZW50LFxuICB2ZXJib3NlLFxufTogRGlhZ25vc3RpY3NEaXNwbGF5UHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBPbmx5IHNob3cgaWYgdGhlcmUgYXJlIGRpYWdub3N0aWNzIHRvIHJlcG9ydFxuICBpZiAoYXR0YWNobWVudC5maWxlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsXG5cbiAgLy8gQ291bnQgdG90YWwgaXNzdWVzXG4gIGNvbnN0IHRvdGFsSXNzdWVzID0gYXR0YWNobWVudC5maWxlcy5yZWR1Y2UoXG4gICAgKHN1bSwgZmlsZSkgPT4gc3VtICsgZmlsZS5kaWFnbm9zdGljcy5sZW5ndGgsXG4gICAgMCxcbiAgKVxuXG4gIGNvbnN0IGZpbGVDb3VudCA9IGF0dGFjaG1lbnQuZmlsZXMubGVuZ3RoXG5cbiAgaWYgKHZlcmJvc2UpIHtcbiAgICAvLyBTaG93IGFsbCBkaWFnbm9zdGljcyBpbiB2ZXJib3NlIG1vZGUgKGN0cmwrbylcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgIHthdHRhY2htZW50LmZpbGVzLm1hcCgoZmlsZSwgZmlsZUluZGV4KSA9PiAoXG4gICAgICAgICAgPFJlYWN0LkZyYWdtZW50IGtleT17ZmlsZUluZGV4fT5cbiAgICAgICAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yIHdyYXA9XCJ3cmFwXCI+XG4gICAgICAgICAgICAgICAgPFRleHQgYm9sZD5cbiAgICAgICAgICAgICAgICAgIHtyZWxhdGl2ZShcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q3dkKCksXG4gICAgICAgICAgICAgICAgICAgIGZpbGUudXJpXG4gICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoJ2ZpbGU6Ly8nLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgnX2NsYXVkZV9mc19yaWdodDonLCAnJyksXG4gICAgICAgICAgICAgICAgICApfVxuICAgICAgICAgICAgICAgIDwvVGV4dD57JyAnfVxuICAgICAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICAgICAgICAgICAge2ZpbGUudXJpLnN0YXJ0c1dpdGgoJ2ZpbGU6Ly8nKVxuICAgICAgICAgICAgICAgICAgICA/ICcoZmlsZTovLyknXG4gICAgICAgICAgICAgICAgICAgIDogZmlsZS51cmkuc3RhcnRzV2l0aCgnX2NsYXVkZV9mc19yaWdodDonKVxuICAgICAgICAgICAgICAgICAgICAgID8gJyhjbGF1ZGVfZnNfcmlnaHQpJ1xuICAgICAgICAgICAgICAgICAgICAgIDogYCgke2ZpbGUudXJpLnNwbGl0KCc6JylbMF19KWB9XG4gICAgICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICAgICAgIDpcbiAgICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgICB7ZmlsZS5kaWFnbm9zdGljcy5tYXAoKGRpYWdub3N0aWMsIGRpYWdJbmRleCkgPT4gKFxuICAgICAgICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGtleT17ZGlhZ0luZGV4fT5cbiAgICAgICAgICAgICAgICA8VGV4dCBkaW1Db2xvciB3cmFwPVwid3JhcFwiPlxuICAgICAgICAgICAgICAgICAgeycgICd9XG4gICAgICAgICAgICAgICAgICB7RGlhZ25vc3RpY1RyYWNraW5nU2VydmljZS5nZXRTZXZlcml0eVN5bWJvbChcbiAgICAgICAgICAgICAgICAgICAgZGlhZ25vc3RpYy5zZXZlcml0eSxcbiAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICB7JyBbTGluZSAnfVxuICAgICAgICAgICAgICAgICAge2RpYWdub3N0aWMucmFuZ2Uuc3RhcnQubGluZSArIDF9OlxuICAgICAgICAgICAgICAgICAge2RpYWdub3N0aWMucmFuZ2Uuc3RhcnQuY2hhcmFjdGVyICsgMX1cbiAgICAgICAgICAgICAgICAgIHsnXSAnfVxuICAgICAgICAgICAgICAgICAge2RpYWdub3N0aWMubWVzc2FnZX1cbiAgICAgICAgICAgICAgICAgIHtkaWFnbm9zdGljLmNvZGUgPyBgIFske2RpYWdub3N0aWMuY29kZX1dYCA6ICcnfVxuICAgICAgICAgICAgICAgICAge2RpYWdub3N0aWMuc291cmNlID8gYCAoJHtkaWFnbm9zdGljLnNvdXJjZX0pYCA6ICcnfVxuICAgICAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgICApKX1cbiAgICAgICAgICA8L1JlYWN0LkZyYWdtZW50PlxuICAgICAgICApKX1cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfSBlbHNlIHtcbiAgICAvLyBTaG93IHN1bW1hcnkgaW4gbm9ybWFsIG1vZGVcbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgZGltQ29sb3Igd3JhcD1cIndyYXBcIj5cbiAgICAgICAgICBGb3VuZCA8VGV4dCBib2xkPnt0b3RhbElzc3Vlc308L1RleHQ+IG5ldyBkaWFnbm9zdGljeycgJ31cbiAgICAgICAgICB7dG90YWxJc3N1ZXMgPT09IDEgPyAnaXNzdWUnIDogJ2lzc3Vlcyd9IGluIHtmaWxlQ291bnR9eycgJ31cbiAgICAgICAgICB7ZmlsZUNvdW50ID09PSAxID8gJ2ZpbGUnIDogJ2ZpbGVzJ30gPEN0cmxPVG9FeHBhbmQgLz5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgKVxuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTQSxRQUFRLFFBQVEsTUFBTTtBQUMvQixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxXQUFXO0FBQ3JDLFNBQVNDLHlCQUF5QixRQUFRLG1DQUFtQztBQUM3RSxjQUFjQyxVQUFVLFFBQVEseUJBQXlCO0FBQ3pELFNBQVNDLE1BQU0sUUFBUSxpQkFBaUI7QUFDeEMsU0FBU0MsYUFBYSxRQUFRLG9CQUFvQjtBQUNsRCxTQUFTQyxlQUFlLFFBQVEsc0JBQXNCO0FBRXRELEtBQUtDLHFCQUFxQixHQUFHQyxPQUFPLENBQUNMLFVBQVUsRUFBRTtFQUFFTSxJQUFJLEVBQUUsYUFBYTtBQUFDLENBQUMsQ0FBQztBQUV6RSxLQUFLQyx1QkFBdUIsR0FBRztFQUM3QkMsVUFBVSxFQUFFSixxQkFBcUI7RUFDakNLLE9BQU8sRUFBRSxPQUFPO0FBQ2xCLENBQUM7QUFFRCxPQUFPLFNBQUFDLG1CQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQTRCO0lBQUFMLFVBQUE7SUFBQUM7RUFBQSxJQUFBRSxFQUdUO0VBRXhCLElBQUlILFVBQVUsQ0FBQU0sS0FBTSxDQUFBQyxNQUFPLEtBQUssQ0FBQztJQUFBLE9BQVMsSUFBSTtFQUFBO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFKLENBQUEsUUFBQUosVUFBQSxDQUFBTSxLQUFBO0lBRzFCRSxFQUFBLEdBQUFSLFVBQVUsQ0FBQU0sS0FBTSxDQUFBRyxNQUFPLENBQ3pDQyxLQUE0QyxFQUM1QyxDQUNGLENBQUM7SUFBQU4sQ0FBQSxNQUFBSixVQUFBLENB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QUNSK0IsTUFBSSxDQUFBQyxHQUFJLENBQUFDLE9BQ0UsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLENBQUFBLE9BQ2YsQ0FBQyxtQkFBbUIsRUFBRSxFQUFFLENBQ3BDLEVBQ0YsRUFQQyxJQUFJLENBT0csSUFBRSxDQUNWLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FDWCxDQUFBRixNQUFJLENBQUFDLEdBQUksQ0FBQUUsVUFBVyxDQUFDLFNBSWEsQ0FBQyxHQUpsQyxXQUlrQyxHQUYvQkgsTUFBSSxDQUFBQyxHQUFJLENBQUFFLFVBQVcsQ0FBQyxtQkFFVSxDQUFDLEdBRi9CLG1CQUUrQixHQUYvQixJQUVNSCxNQUFJLENBQUFDLEdBQUksQ0FBQUcsS0FBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEdBQUUsQ0FDcEMsRUFOQyxJQUFJLENBTUUsQ0FFVCxFQWpCQyxJQUFJLENBa0JQLEVBbkJDLGVBQWUsQ0FvQmYsQ0FBQUosTUFBSSxDQUFBSyxXQUFZLENBQUFmLEdBQUksQ0FBQ2dCLE1BZ0JyQixFQUNILGlCQUFpQjtBQUFBO0FBMURwQixTQUFBQSxPQUFBQyxVQUFBLEVBQUFDLFNBQUE7RUFBQSxPQTBDTyxDQUFDLGVBQWUsQ0FBTUEsR0FBUyxDQUFUQSxVQUFRLENBQUMsQ0FDN0IsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFNLElBQU0sQ0FBTixNQUFNLENBQ3ZCLEtBQUcsQ0FDSCxDQUFBekMseUJBQXlCLENBQUEwQyxpQkFBa0IsQ0FDMUNGLFVBQVUsQ0FBQUcsUUFDWixFQUNDLFVBQVEsQ0FDUixDQUFBSCxVQUFVLENBQUFJLEtBQU0sQ0FBQUMsS0FBTSxDQUFBQyxJQUFLLEdBQUcsRUFBRSxDQUNoQyxDQUFBTixVQUFVLENBQUFJLEtBQU0sQ0FBQUMsS0FBTSxDQUFBRSxTQUFVLEdBQUcsRUFDbkMsS0FBRyxDQUNILENBQUFQLFVBQVUsQ0FBQVEsT0FBTyxDQUNqQixDQUFBUixVQUFVLENBQUFTLElBQW9DLEdBQTlDLEtBQXVCVCxVQUFVLENBQUFTLElBQUssR0FBUSxHQUE5QyxFQUE2QyxDQUM3QyxDQUFBVCxVQUFVLENBQUFVLE1BQXdDLEdBQWxELEtBQXlCVixVQUFVLENBQUFVLE1BQU8sR0FBUSxHQUFsRCxFQUFpRCxDQUNwRCxFQVpDLElBQUksQ0FhUCxFQWRDLGVBQWUsQ0FjRTtBQUFBO0FBeER6QixTQUFBL0IsTUFBQWdDLEdBQUEsRUFBQWxCLElBQUE7RUFBQSxPQVNZa0IsR0FBRyxHQUFHbEIsSUFBSSxDQUFBSyxXQUFZLENBQUF0QixNQUFPO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=