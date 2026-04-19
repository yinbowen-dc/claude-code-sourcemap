/**
 * FileEditToolDiff.tsx — 文件编辑工具差异预览组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   FileEditTool（文件编辑工具）→ FileEditToolDiff → 渲染文件变更的差异视图
 *
 * 主要功能：
 *   FileEditToolDiff：顶层导出组件，通过 React Suspense + useState 快照模式
 *   加载并展示文件编辑操作的结构化差异（diff）。
 *   内部包含三个辅助单元：
 *   - DiffBody：解包 Promise 数据并渲染 StructuredDiffList
 *   - DiffFrame：提供统一的边框容器（加载中显示省略号占位符）
 *   - loadDiffData：异步加载差异数据，支持单编辑/多编辑/空 old_string 三条路径
 *
 * 设计要点：
 *   - 挂载时快照：通过 useState 初始化函数确保 diff 数据在组件挂载时固定，
 *     防止文件在对话框打开期间发生变化导致 diff 重新渲染
 *   - 分块扫描：对单编辑且 old_string 较短的情况，仅扫描文件中的上下文窗口
 *     （scanForContext），避免读取整个大文件
 *   - 大 needle 保护：当 old_string.length >= CHUNK_SIZE 时，直接用工具输入
 *     进行差异计算（diffToolInputsOnly），避免 O(needle) 的重叠缓冲区分配
 *   - React Compiler 优化：使用 _c(N) 缓存数组避免 JSX 重复创建；
 *     Symbol.for("react.memo_cache_sentinel") 作为哨兵值检测缓存未命中
 */
import { c as _c } from "react/compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import type { FileEdit } from '../tools/FileEditTool/types.js';
import { findActualString, preserveQuoteStyle } from '../tools/FileEditTool/utils.js';
import { adjustHunkLineNumbers, CONTEXT_LINES, getPatchForDisplay } from '../utils/diff.js';
import { logError } from '../utils/log.js';
import { CHUNK_SIZE, openForScan, readCapped, scanForContext } from '../utils/readEditContext.js';
import { firstLineOf } from '../utils/stringUtils.js';
import { StructuredDiffList } from './StructuredDiffList.js';
type Props = {
  file_path: string;
  edits: FileEdit[];
};
// 差异数据结构：包含结构化 patch 块、文件首行（用于显示文件名）和文件内容（用于上下文）
type DiffData = {
  patch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent: string | undefined;
};

/**
 * FileEditToolDiff
 *
 * 整体流程：
 *   1. 通过 useState 初始化函数在挂载时固定 loadDiffData Promise（快照模式）
 *      - React Compiler：若 props.edits/file_path 未变化，复用缓存的 t0 工厂函数
 *   2. 通过 React Suspense 包裹 DiffBody，加载期间显示 DiffFrame 占位符（省略号）
 *      - React Compiler：DiffFrame placeholder 只创建一次（哨兵值检测缓存未命中）
 *   3. DiffBody resolve 后渲染真实 diff 内容
 *
 * 在系统中的角色：
 *   是文件编辑工具的 diff 预览入口，由上层工具组件在用户确认编辑时调用。
 */
export function FileEditToolDiff(props) {
  // React Compiler：_c(7) 分配 7 个插槽的记忆化缓存数组
  const $ = _c(7);
  let t0;
  // 缓存检查：若 edits 或 file_path 变化，则重建 loadDiffData 工厂函数
  if ($[0] !== props.edits || $[1] !== props.file_path) {
    t0 = () => loadDiffData(props.file_path, props.edits);
    $[0] = props.edits;
    $[1] = props.file_path;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  // 挂载时快照：useState 的初始化函数只在挂载时执行一次，保证 diff 数据稳定
  const [dataPromise] = useState(t0);
  let t1;
  // 哨兵值检测：DiffFrame 占位符（加载中显示的省略号）只创建一次
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <DiffFrame placeholder={true} />;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  let t2;
  // 缓存检查：dataPromise 或 file_path 变化时重新创建 Suspense 树
  if ($[4] !== dataPromise || $[5] !== props.file_path) {
    t2 = <Suspense fallback={t1}><DiffBody promise={dataPromise} file_path={props.file_path} /></Suspense>;
    $[4] = dataPromise;
    $[5] = props.file_path;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}
/**
 * DiffBody
 *
 * 整体流程：
 *   1. 通过 React 的 use(promise) Hook 解包 loadDiffData 返回的 Promise
 *      （若 Promise 未 resolve，Suspense 会捕获并展示 fallback）
 *   2. 读取终端宽度（useTerminalSize），传递给 StructuredDiffList 控制显示宽度
 *   3. 在 DiffFrame 容器内渲染 StructuredDiffList 展示结构化差异
 *
 * 在系统中的角色：
 *   是 Suspense 内部的数据消费者，负责将异步差异数据渲染为 diff 视图。
 */
function DiffBody(t0) {
  // React Compiler：_c(6) 分配 6 个插槽的记忆化缓存数组
  const $ = _c(6);
  const {
    promise,
    file_path
  } = t0;
  // 通过 use() 解包 Promise：若 Promise pending，Suspense fallback 被激活
  const {
    patch,
    firstLine,
    fileContent
  } = use(promise);
  // 读取终端当前列数，用于控制 diff 渲染宽度
  const {
    columns
  } = useTerminalSize();
  let t1;
  // 缓存检查：任意依赖变化时重新渲染 DiffFrame 及其子树
  if ($[0] !== columns || $[1] !== fileContent || $[2] !== file_path || $[3] !== firstLine || $[4] !== patch) {
    t1 = <DiffFrame><StructuredDiffList hunks={patch} dim={false} width={columns} filePath={file_path} firstLine={firstLine} fileContent={fileContent} /></DiffFrame>;
    $[0] = columns;
    $[1] = fileContent;
    $[2] = file_path;
    $[3] = firstLine;
    $[4] = patch;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  return t1;
}

/**
 * DiffFrame
 *
 * 整体流程：
 *   1. 若 placeholder=true，渲染一个灰色省略号（加载占位符）
 *   2. 否则渲染 children（实际 diff 内容）
 *   3. 外层 Box 提供虚线上下边框的统一容器样式
 *
 * 在系统中的角色：
 *   是 diff 视图的容器组件，统一控制边框样式，
 *   在 Suspense 加载期间和加载完成后提供一致的视觉框架。
 */
function DiffFrame(t0) {
  // React Compiler：_c(5) 分配 5 个插槽的记忆化缓存数组
  const $ = _c(5);
  const {
    children,
    placeholder
  } = t0;
  let t1;
  // 缓存检查：children 或 placeholder 变化时重新计算内容节点
  if ($[0] !== children || $[1] !== placeholder) {
    // placeholder 模式：显示灰色省略号；否则显示实际 diff 内容
    t1 = placeholder ? <Text dimColor={true}>…</Text> : children;
    $[0] = children;
    $[1] = placeholder;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  let t2;
  // 缓存检查：内容节点变化时重新创建外层容器
  if ($[3] !== t1) {
    // 外层 Box：column 方向布局，内层 Box 提供虚线上下边框（左右无边框）
    t2 = <Box flexDirection="column"><Box borderColor="subtle" borderStyle="dashed" flexDirection="column" borderLeft={false} borderRight={false}>{t1}</Box></Box>;
    $[3] = t1;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}
/**
 * loadDiffData
 *
 * 整体流程：
 *   0. 过滤出 old_string/new_string 均非 null 的有效编辑项
 *   1. 大 needle 保护：single 编辑且 old_string >= CHUNK_SIZE → diffToolInputsOnly（跳过文件读取）
 *   2. openForScan：以只读方式打开文件；若文件不存在 → diffToolInputsOnly
 *   3. 多编辑或空 old_string 路径：readCapped 读取整个文件（带大小上限保护）
 *      → normalizeEdit 归一化 → getPatchForDisplay 生成完整 patch
 *   4. 单编辑路径：scanForContext 仅扫描包含 old_string 的上下文窗口
 *      → 若扫描结果被截断或为空 → diffToolInputsOnly（降级）
 *      → 否则 normalizeEdit + getPatchForDisplay，再通过 adjustHunkLineNumbers 修正行号偏移
 *   5. 任何异常均记录日志并降级到 diffToolInputsOnly
 *
 * 在系统中的角色：
 *   是 diff 数据的异步数据源，通过多级策略在准确性（文件上下文）与性能
 *   （避免读取超大文件）之间取得平衡。
 */
async function loadDiffData(file_path: string, edits: FileEdit[]): Promise<DiffData> {
  // 过滤有效编辑项（old_string/new_string 均不为 null）
  const valid = edits.filter(e => e.old_string != null && e.new_string != null);
  // single：若只有一个有效编辑，直接引用；否则为 undefined（触发全文读取路径）
  const single = valid.length === 1 ? valid[0]! : undefined;

  // SedEditPermissionRequest passes the entire file as old_string. Scanning for
  // a needle ≥ CHUNK_SIZE allocates O(needle) for the overlap buffer — skip the
  // file read entirely and diff the inputs we already have.
  // 大 needle 保护：old_string 过长时跳过文件读取，直接对工具输入进行 diff
  if (single && single.old_string.length >= CHUNK_SIZE) {
    return diffToolInputsOnly(file_path, [single]);
  }
  try {
    // 打开文件句柄（只读扫描模式）；若文件不存在则降级
    const handle = await openForScan(file_path);
    if (handle === null) return diffToolInputsOnly(file_path, valid);
    try {
      // Multi-edit and empty old_string genuinely need full-file for sequential
      // replacements — structuredPatch needs before/after strings. replace_all
      // routes through the chunked path below (shows first-occurrence window;
      // matches within the slice still replace via edit.replace_all).
      // 多编辑或空 old_string：需要完整文件内容进行顺序替换
      if (!single || single.old_string === '') {
        // readCapped：带大小上限的全文读取，防止 OOM；返回 null 则降级
        const file = await readCapped(handle);
        if (file === null) return diffToolInputsOnly(file_path, valid);
        // 归一化所有编辑项（处理引号风格等差异）
        const normalized = valid.map(e => normalizeEdit(file, e));
        return {
          patch: getPatchForDisplay({
            filePath: file_path,
            fileContents: file,
            edits: normalized
          }),
          firstLine: firstLineOf(file), // 提取文件首行用于显示文件名
          fileContent: file
        };
      }
      // 单编辑路径：仅扫描包含 old_string 的上下文窗口，避免读取整个大文件
      const ctx = await scanForContext(handle, single.old_string, CONTEXT_LINES);
      if (ctx.truncated || ctx.content === '') {
        // 扫描被截断或未找到 → 降级到工具输入 diff
        return diffToolInputsOnly(file_path, [single]);
      }
      // 在上下文窗口内归一化并生成 patch
      const normalized = normalizeEdit(ctx.content, single);
      const hunks = getPatchForDisplay({
        filePath: file_path,
        fileContents: ctx.content,
        edits: [normalized]
      });
      return {
        // 修正行号偏移：ctx.lineOffset-1 使 hunk 行号对应原始文件中的实际行号
        patch: adjustHunkLineNumbers(hunks, ctx.lineOffset - 1),
        // 仅当上下文从文件第 1 行开始时才提供 firstLine（否则无法确定文件名）
        firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
        fileContent: ctx.content
      };
    } finally {
      // 确保文件句柄始终关闭，防止文件描述符泄漏
      await handle.close();
    }
  } catch (e) {
    // 任何异常（权限错误、I/O 错误等）→ 记录日志并降级
    logError(e as Error);
    return diffToolInputsOnly(file_path, valid);
  }
}

/**
 * diffToolInputsOnly
 *
 * 整体流程：
 *   直接对工具传入的 old_string 和 new_string 进行 diff，
 *   不读取磁盘上的实际文件内容。
 *
 * 在系统中的角色：
 *   是所有读取失败/降级路径的统一兜底，确保始终能返回一个有效的 DiffData。
 */
function diffToolInputsOnly(filePath: string, edits: FileEdit[]): DiffData {
  return {
    // 对每个编辑项分别生成 patch，并展平为一个 hunk 数组
    patch: edits.flatMap(e => getPatchForDisplay({
      filePath,
      fileContents: e.old_string, // 以工具输入的 old_string 作为"文件内容"
      edits: [e]
    })),
    firstLine: null,      // 无法从工具输入中提取真实文件名
    fileContent: undefined // 无实际文件内容
  };
}

/**
 * normalizeEdit
 *
 * 整体流程：
 *   1. findActualString：在实际文件内容中查找与 old_string 最匹配的真实字符串
 *      （处理引号风格等细微差异），若未找到则回退到原始 old_string
 *   2. preserveQuoteStyle：根据 actualOld 中的引号风格调整 new_string，
 *      保证替换后的代码风格与原文件一致
 *
 * 在系统中的角色：
 *   是 diff 数据归一化的核心辅助函数，确保 diff 视图与实际文件内容精确对应。
 */
function normalizeEdit(fileContent: string, edit: FileEdit): FileEdit {
  // 在文件内容中查找最匹配的旧字符串（处理引号/空白等细微差异）
  const actualOld = findActualString(fileContent, edit.old_string) || edit.old_string;
  // 根据 actualOld 的引号风格调整新字符串，保持代码一致性
  const actualNew = preserveQuoteStyle(edit.old_string, actualOld, edit.new_string);
  return {
    ...edit,
    old_string: actualOld,
    new_string: actualNew
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTdHJ1Y3R1cmVkUGF0Y2hIdW5rIiwiUmVhY3QiLCJTdXNwZW5zZSIsInVzZSIsInVzZVN0YXRlIiwidXNlVGVybWluYWxTaXplIiwiQm94IiwiVGV4dCIsIkZpbGVFZGl0IiwiZmluZEFjdHVhbFN0cmluZyIsInByZXNlcnZlUXVvdGVTdHlsZSIsImFkanVzdEh1bmtMaW5lTnVtYmVycyIsIkNPTlRFWFRfTElORVMiLCJnZXRQYXRjaEZvckRpc3BsYXkiLCJsb2dFcnJvciIsIkNIVU5LX1NJWkUiLCJvcGVuRm9yU2NhbiIsInJlYWRDYXBwZWQiLCJzY2FuRm9yQ29udGV4dCIsImZpcnN0TGluZU9mIiwiU3RydWN0dXJlZERpZmZMaXN0IiwiUHJvcHMiLCJmaWxlX3BhdGgiLCJlZGl0cyIsIkRpZmZEYXRhIiwicGF0Y2giLCJmaXJzdExpbmUiLCJmaWxlQ29udGVudCIsIkZpbGVFZGl0VG9vbERpZmYiLCJwcm9wcyIsIiQiLCJfYyIsInQwIiwibG9hZERpZmZEYXRhIiwiZGF0YVByb21pc2UiLCJ0MSIsIlN5bWJvbCIsImZvciIsInQyIiwiRGlmZkJvZHkiLCJwcm9taXNlIiwiY29sdW1ucyIsIkRpZmZGcmFtZSIsImNoaWxkcmVuIiwicGxhY2Vob2xkZXIiLCJQcm9taXNlIiwidmFsaWQiLCJmaWx0ZXIiLCJlIiwib2xkX3N0cmluZyIsIm5ld19zdHJpbmciLCJzaW5nbGUiLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJkaWZmVG9vbElucHV0c09ubHkiLCJoYW5kbGUiLCJmaWxlIiwibm9ybWFsaXplZCIsIm1hcCIsIm5vcm1hbGl6ZUVkaXQiLCJmaWxlUGF0aCIsImZpbGVDb250ZW50cyIsImN0eCIsInRydW5jYXRlZCIsImNvbnRlbnQiLCJodW5rcyIsImxpbmVPZmZzZXQiLCJjbG9zZSIsIkVycm9yIiwiZmxhdE1hcCIsImVkaXQiLCJhY3R1YWxPbGQiLCJhY3R1YWxOZXciXSwic291cmNlcyI6WyJGaWxlRWRpdFRvb2xEaWZmLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBTdXNwZW5zZSwgdXNlLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlVGVybWluYWxTaXplIH0gZnJvbSAnLi4vaG9va3MvdXNlVGVybWluYWxTaXplLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBGaWxlRWRpdCB9IGZyb20gJy4uL3Rvb2xzL0ZpbGVFZGl0VG9vbC90eXBlcy5qcydcbmltcG9ydCB7XG4gIGZpbmRBY3R1YWxTdHJpbmcsXG4gIHByZXNlcnZlUXVvdGVTdHlsZSxcbn0gZnJvbSAnLi4vdG9vbHMvRmlsZUVkaXRUb29sL3V0aWxzLmpzJ1xuaW1wb3J0IHtcbiAgYWRqdXN0SHVua0xpbmVOdW1iZXJzLFxuICBDT05URVhUX0xJTkVTLFxuICBnZXRQYXRjaEZvckRpc3BsYXksXG59IGZyb20gJy4uL3V0aWxzL2RpZmYuanMnXG5pbXBvcnQgeyBsb2dFcnJvciB9IGZyb20gJy4uL3V0aWxzL2xvZy5qcydcbmltcG9ydCB7XG4gIENIVU5LX1NJWkUsXG4gIG9wZW5Gb3JTY2FuLFxuICByZWFkQ2FwcGVkLFxuICBzY2FuRm9yQ29udGV4dCxcbn0gZnJvbSAnLi4vdXRpbHMvcmVhZEVkaXRDb250ZXh0LmpzJ1xuaW1wb3J0IHsgZmlyc3RMaW5lT2YgfSBmcm9tICcuLi91dGlscy9zdHJpbmdVdGlscy5qcydcbmltcG9ydCB7IFN0cnVjdHVyZWREaWZmTGlzdCB9IGZyb20gJy4vU3RydWN0dXJlZERpZmZMaXN0LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBmaWxlX3BhdGg6IHN0cmluZ1xuICBlZGl0czogRmlsZUVkaXRbXVxufVxuXG50eXBlIERpZmZEYXRhID0ge1xuICBwYXRjaDogU3RydWN0dXJlZFBhdGNoSHVua1tdXG4gIGZpcnN0TGluZTogc3RyaW5nIHwgbnVsbFxuICBmaWxlQ29udGVudDogc3RyaW5nIHwgdW5kZWZpbmVkXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBGaWxlRWRpdFRvb2xEaWZmKHByb3BzOiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIC8vIFNuYXBzaG90IG9uIG1vdW50IOKAlCB0aGUgZGlmZiBtdXN0IHN0YXkgY29uc2lzdGVudCBldmVuIGlmIHRoZSBmaWxlIGNoYW5nZXNcbiAgLy8gd2hpbGUgdGhlIGRpYWxvZyBpcyBvcGVuLiB1c2VNZW1vIG9uIHByb3BzLmVkaXRzIHdvdWxkIHJlLXJlYWQgdGhlIGZpbGUgb25cbiAgLy8gZXZlcnkgcmVuZGVyIGJlY2F1c2UgY2FsbGVycyBwYXNzIGZyZXNoIGFycmF5IGxpdGVyYWxzLlxuICBjb25zdCBbZGF0YVByb21pc2VdID0gdXNlU3RhdGUoKCkgPT5cbiAgICBsb2FkRGlmZkRhdGEocHJvcHMuZmlsZV9wYXRoLCBwcm9wcy5lZGl0cyksXG4gIClcbiAgcmV0dXJuIChcbiAgICA8U3VzcGVuc2UgZmFsbGJhY2s9ezxEaWZmRnJhbWUgcGxhY2Vob2xkZXIgLz59PlxuICAgICAgPERpZmZCb2R5IHByb21pc2U9e2RhdGFQcm9taXNlfSBmaWxlX3BhdGg9e3Byb3BzLmZpbGVfcGF0aH0gLz5cbiAgICA8L1N1c3BlbnNlPlxuICApXG59XG5cbmZ1bmN0aW9uIERpZmZCb2R5KHtcbiAgcHJvbWlzZSxcbiAgZmlsZV9wYXRoLFxufToge1xuICBwcm9taXNlOiBQcm9taXNlPERpZmZEYXRhPlxuICBmaWxlX3BhdGg6IHN0cmluZ1xufSk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgcGF0Y2gsIGZpcnN0TGluZSwgZmlsZUNvbnRlbnQgfSA9IHVzZShwcm9taXNlKVxuICBjb25zdCB7IGNvbHVtbnMgfSA9IHVzZVRlcm1pbmFsU2l6ZSgpXG4gIHJldHVybiAoXG4gICAgPERpZmZGcmFtZT5cbiAgICAgIDxTdHJ1Y3R1cmVkRGlmZkxpc3RcbiAgICAgICAgaHVua3M9e3BhdGNofVxuICAgICAgICBkaW09e2ZhbHNlfVxuICAgICAgICB3aWR0aD17Y29sdW1uc31cbiAgICAgICAgZmlsZVBhdGg9e2ZpbGVfcGF0aH1cbiAgICAgICAgZmlyc3RMaW5lPXtmaXJzdExpbmV9XG4gICAgICAgIGZpbGVDb250ZW50PXtmaWxlQ29udGVudH1cbiAgICAgIC8+XG4gICAgPC9EaWZmRnJhbWU+XG4gIClcbn1cblxuZnVuY3Rpb24gRGlmZkZyYW1lKHtcbiAgY2hpbGRyZW4sXG4gIHBsYWNlaG9sZGVyLFxufToge1xuICBjaGlsZHJlbj86IFJlYWN0LlJlYWN0Tm9kZVxuICBwbGFjZWhvbGRlcj86IGJvb2xlYW5cbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgPEJveFxuICAgICAgICBib3JkZXJDb2xvcj1cInN1YnRsZVwiXG4gICAgICAgIGJvcmRlclN0eWxlPVwiZGFzaGVkXCJcbiAgICAgICAgZmxleERpcmVjdGlvbj1cImNvbHVtblwiXG4gICAgICAgIGJvcmRlckxlZnQ9e2ZhbHNlfVxuICAgICAgICBib3JkZXJSaWdodD17ZmFsc2V9XG4gICAgICA+XG4gICAgICAgIHtwbGFjZWhvbGRlciA/IDxUZXh0IGRpbUNvbG9yPuKApjwvVGV4dD4gOiBjaGlsZHJlbn1cbiAgICAgIDwvQm94PlxuICAgIDwvQm94PlxuICApXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWREaWZmRGF0YShcbiAgZmlsZV9wYXRoOiBzdHJpbmcsXG4gIGVkaXRzOiBGaWxlRWRpdFtdLFxuKTogUHJvbWlzZTxEaWZmRGF0YT4ge1xuICBjb25zdCB2YWxpZCA9IGVkaXRzLmZpbHRlcihlID0+IGUub2xkX3N0cmluZyAhPSBudWxsICYmIGUubmV3X3N0cmluZyAhPSBudWxsKVxuICBjb25zdCBzaW5nbGUgPSB2YWxpZC5sZW5ndGggPT09IDEgPyB2YWxpZFswXSEgOiB1bmRlZmluZWRcblxuICAvLyBTZWRFZGl0UGVybWlzc2lvblJlcXVlc3QgcGFzc2VzIHRoZSBlbnRpcmUgZmlsZSBhcyBvbGRfc3RyaW5nLiBTY2FubmluZyBmb3JcbiAgLy8gYSBuZWVkbGUg4omlIENIVU5LX1NJWkUgYWxsb2NhdGVzIE8obmVlZGxlKSBmb3IgdGhlIG92ZXJsYXAgYnVmZmVyIOKAlCBza2lwIHRoZVxuICAvLyBmaWxlIHJlYWQgZW50aXJlbHkgYW5kIGRpZmYgdGhlIGlucHV0cyB3ZSBhbHJlYWR5IGhhdmUuXG4gIGlmIChzaW5nbGUgJiYgc2luZ2xlLm9sZF9zdHJpbmcubGVuZ3RoID49IENIVU5LX1NJWkUpIHtcbiAgICByZXR1cm4gZGlmZlRvb2xJbnB1dHNPbmx5KGZpbGVfcGF0aCwgW3NpbmdsZV0pXG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGhhbmRsZSA9IGF3YWl0IG9wZW5Gb3JTY2FuKGZpbGVfcGF0aClcbiAgICBpZiAoaGFuZGxlID09PSBudWxsKSByZXR1cm4gZGlmZlRvb2xJbnB1dHNPbmx5KGZpbGVfcGF0aCwgdmFsaWQpXG4gICAgdHJ5IHtcbiAgICAgIC8vIE11bHRpLWVkaXQgYW5kIGVtcHR5IG9sZF9zdHJpbmcgZ2VudWluZWx5IG5lZWQgZnVsbC1maWxlIGZvciBzZXF1ZW50aWFsXG4gICAgICAvLyByZXBsYWNlbWVudHMg4oCUIHN0cnVjdHVyZWRQYXRjaCBuZWVkcyBiZWZvcmUvYWZ0ZXIgc3RyaW5ncy4gcmVwbGFjZV9hbGxcbiAgICAgIC8vIHJvdXRlcyB0aHJvdWdoIHRoZSBjaHVua2VkIHBhdGggYmVsb3cgKHNob3dzIGZpcnN0LW9jY3VycmVuY2Ugd2luZG93O1xuICAgICAgLy8gbWF0Y2hlcyB3aXRoaW4gdGhlIHNsaWNlIHN0aWxsIHJlcGxhY2UgdmlhIGVkaXQucmVwbGFjZV9hbGwpLlxuICAgICAgaWYgKCFzaW5nbGUgfHwgc2luZ2xlLm9sZF9zdHJpbmcgPT09ICcnKSB7XG4gICAgICAgIGNvbnN0IGZpbGUgPSBhd2FpdCByZWFkQ2FwcGVkKGhhbmRsZSlcbiAgICAgICAgaWYgKGZpbGUgPT09IG51bGwpIHJldHVybiBkaWZmVG9vbElucHV0c09ubHkoZmlsZV9wYXRoLCB2YWxpZClcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHZhbGlkLm1hcChlID0+IG5vcm1hbGl6ZUVkaXQoZmlsZSwgZSkpXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcGF0Y2g6IGdldFBhdGNoRm9yRGlzcGxheSh7XG4gICAgICAgICAgICBmaWxlUGF0aDogZmlsZV9wYXRoLFxuICAgICAgICAgICAgZmlsZUNvbnRlbnRzOiBmaWxlLFxuICAgICAgICAgICAgZWRpdHM6IG5vcm1hbGl6ZWQsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgZmlyc3RMaW5lOiBmaXJzdExpbmVPZihmaWxlKSxcbiAgICAgICAgICBmaWxlQ29udGVudDogZmlsZSxcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBjdHggPSBhd2FpdCBzY2FuRm9yQ29udGV4dChoYW5kbGUsIHNpbmdsZS5vbGRfc3RyaW5nLCBDT05URVhUX0xJTkVTKVxuICAgICAgaWYgKGN0eC50cnVuY2F0ZWQgfHwgY3R4LmNvbnRlbnQgPT09ICcnKSB7XG4gICAgICAgIHJldHVybiBkaWZmVG9vbElucHV0c09ubHkoZmlsZV9wYXRoLCBbc2luZ2xlXSlcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVFZGl0KGN0eC5jb250ZW50LCBzaW5nbGUpXG4gICAgICBjb25zdCBodW5rcyA9IGdldFBhdGNoRm9yRGlzcGxheSh7XG4gICAgICAgIGZpbGVQYXRoOiBmaWxlX3BhdGgsXG4gICAgICAgIGZpbGVDb250ZW50czogY3R4LmNvbnRlbnQsXG4gICAgICAgIGVkaXRzOiBbbm9ybWFsaXplZF0sXG4gICAgICB9KVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGF0Y2g6IGFkanVzdEh1bmtMaW5lTnVtYmVycyhodW5rcywgY3R4LmxpbmVPZmZzZXQgLSAxKSxcbiAgICAgICAgZmlyc3RMaW5lOiBjdHgubGluZU9mZnNldCA9PT0gMSA/IGZpcnN0TGluZU9mKGN0eC5jb250ZW50KSA6IG51bGwsXG4gICAgICAgIGZpbGVDb250ZW50OiBjdHguY29udGVudCxcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgYXdhaXQgaGFuZGxlLmNsb3NlKClcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dFcnJvcihlIGFzIEVycm9yKVxuICAgIHJldHVybiBkaWZmVG9vbElucHV0c09ubHkoZmlsZV9wYXRoLCB2YWxpZClcbiAgfVxufVxuXG5mdW5jdGlvbiBkaWZmVG9vbElucHV0c09ubHkoZmlsZVBhdGg6IHN0cmluZywgZWRpdHM6IEZpbGVFZGl0W10pOiBEaWZmRGF0YSB7XG4gIHJldHVybiB7XG4gICAgcGF0Y2g6IGVkaXRzLmZsYXRNYXAoZSA9PlxuICAgICAgZ2V0UGF0Y2hGb3JEaXNwbGF5KHtcbiAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgIGZpbGVDb250ZW50czogZS5vbGRfc3RyaW5nLFxuICAgICAgICBlZGl0czogW2VdLFxuICAgICAgfSksXG4gICAgKSxcbiAgICBmaXJzdExpbmU6IG51bGwsXG4gICAgZmlsZUNvbnRlbnQ6IHVuZGVmaW5lZCxcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFZGl0KGZpbGVDb250ZW50OiBzdHJpbmcsIGVkaXQ6IEZpbGVFZGl0KTogRmlsZUVkaXQge1xuICBjb25zdCBhY3R1YWxPbGQgPVxuICAgIGZpbmRBY3R1YWxTdHJpbmcoZmlsZUNvbnRlbnQsIGVkaXQub2xkX3N0cmluZykgfHwgZWRpdC5vbGRfc3RyaW5nXG4gIGNvbnN0IGFjdHVhbE5ldyA9IHByZXNlcnZlUXVvdGVTdHlsZShcbiAgICBlZGl0Lm9sZF9zdHJpbmcsXG4gICAgYWN0dWFsT2xkLFxuICAgIGVkaXQubmV3X3N0cmluZyxcbiAgKVxuICByZXR1cm4geyAuLi5lZGl0LCBvbGRfc3RyaW5nOiBhY3R1YWxPbGQsIG5ld19zdHJpbmc6IGFjdHVhbE5l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