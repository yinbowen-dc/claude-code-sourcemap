/**
 * DiffDialog.tsx — 差异查看对话框组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具响应层 → 差异展示 → 顶层对话框（管理数据源切换与文件列表/详情双级导航）
 *
 * 主要功能：
 *   1. turnDiffToDiffData：将 TurnDiff（历史轮次差异）转换为统一的 DiffData 格式，
 *      包括文件列表（按路径排序）和 hunks Map。
 *   2. DiffDialog：主对话框组件，支持在"当前 git diff"与各历史轮次之间切换数据源，
 *      并在文件列表视图（list）和单文件详情视图（detail）之间双级导航。
 *   3. _temp3：React Compiler 提取的辅助函数，计算上一个文件索引（Math.max(0, prev-1)）。
 *   4. _temp2：React Compiler 提取的辅助函数，计算上一个数据源索引（Math.max(0, prev-1)）。
 *   5. _temp：React Compiler 提取的辅助函数，将 TurnDiff 包装为 DiffSource 对象。
 *
 * 视图状态机：
 *   - ViewMode = 'list' | 'detail'：文件列表 ↔ 单文件详情
 *   - DiffSource = {type:'current'} | {type:'turn', turn:TurnDiff}：当前差异 or 历史轮次
 *   - sources 数组 = [{type:'current'}, ...turnDiffs.map(_temp)]
 *
 * 6 个按键绑定（context "DiffDialog"）：
 *   - diff:previousSource：列表模式左切源 / 详情模式返回列表
 *   - diff:nextSource：列表模式右切源
 *   - diff:back：详情模式返回列表
 *   - diff:viewDetails：列表模式进入详情
 *   - diff:previousFile：列表模式上移文件光标
 *   - diff:nextFile：列表模式下移文件光标
 *
 * React Compiler 缓存槽分配（_c(73)）：
 *   $[0]：静态 {type:"current"} 对象（sentinel 缓存，只创建一次）
 *   $[1]-$[2]：turnDiffs → sources 数组
 *   $[3]-$[5]：currentTurn + gitDiffData → diffData
 *   $[6]-$[8]：diffData.hunks + selectedFile → selectedHunks
 *   $[9]-$[12]：sourceIndex + sources.length → useEffect1 回调 + 依赖数组
 *   $[13]-$[15]：sourceIndex → useEffect2 回调 + 依赖数组
 *   $[16]-$[19]：sources.length + viewMode → previousSource/nextSource 回调
 *   $[20]-$[21]：viewMode → back 回调
 *   $[22]-$[24]：selectedFile + viewMode → viewDetails 回调
 *   $[25]-$[26]：viewMode → previousFile 回调
 *   $[27]-$[29]：diffData.files.length + viewMode → nextFile 回调
 *   $[30]-$[36]：6 个回调 → keybindings 对象
 *   $[37]：静态 {context:"DiffDialog"} 选项（sentinel 缓存）
 *   $[38]-$[39]：diffData.stats → subtitle JSX
 *   $[40]-$[42]：sourceIndex + sources → sourceSelector JSX
 *   $[43]-$[44]：headerSubtitle → headerSubtitle Text JSX
 *   $[45]-$[47]：headerTitle + t20 → title JSX
 *   $[48]-$[50]：onDone + viewMode → handleCancel 函数
 *   $[51]-$[54]：dismissShortcut + sources.length + viewMode → inputGuide 函数
 *   $[55]-$[65]：10 个差异数据字段 → 内容区 JSX（空列表/文件列表/文件详情）
 *   $[66]-$[72]：handleCancel + sourceSelector + subtitle + inputGuide + 内容区 + title → Dialog JSX
 */
import { c as _c } from "react/compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js';
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { Message } from '../../types/message.js';
import { plural } from '../../utils/stringUtils.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { DiffDetailView } from './DiffDetailView.js';
import { DiffFileList } from './DiffFileList.js';

// Props 类型：messages 用于提取历史轮次差异；onDone 在对话框关闭时回调
type Props = {
  messages: Message[];
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};

// ViewMode：list = 文件列表视图；detail = 单文件差异详情视图
type ViewMode = 'list' | 'detail';

// DiffSource：current = 当前 git 工作区差异；turn = 指定历史轮次的差异
type DiffSource = {
  type: 'current';
} | {
  type: 'turn';
  turn: TurnDiff;
};

/**
 * turnDiffToDiffData
 *
 * 整体流程：
 *   1. 将 turn.files（Map<string, TurnFileDiff>）展开为数组，
 *      映射为标准化的文件元数据对象（固定 isBinary=false 等字段）
 *   2. 按 filePath 字典序排序（localeCompare），确保文件列表稳定有序
 *   3. 构建 hunks Map：filePath → StructuredPatchHunk[]
 *   4. 组装并返回 DiffData 对象，loading 固定为 false（数据已同步就绪）
 *
 * 在系统中的角色：
 *   将历史轮次的 TurnDiff 格式统一转换为 DiffDialog 可直接渲染的 DiffData 格式，
 *   使 DiffDetailView 和 DiffFileList 无需感知数据来源差异。
 */
function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values()).map(f => ({
    path: f.filePath,
    linesAdded: f.linesAdded,
    linesRemoved: f.linesRemoved,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
    isNewFile: f.isNewFile
  })).sort((a, b) => a.path.localeCompare(b.path));
  const hunks = new Map<string, StructuredPatchHunk[]>();
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks);
  }
  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved
    },
    files,
    hunks,
    loading: false
  };
}
/**
 * DiffDialog 组件
 *
 * 整体流程：
 *   1. 初始化状态：viewMode("list")、selectedIndex(0)、sourceIndex(0)
 *   2. 构建 sources 数组：[{type:'current'}, ...turnDiffs.map(_temp)]，依赖 turnDiffs 缓存
 *   3. 根据 sourceIndex 决定 currentTurn（null = 当前 git diff），计算 diffData
 *   4. 从 diffData.files[selectedIndex] 取 selectedFile，再取对应 selectedHunks
 *   5. useEffect1：sources 数组缩小时，将 sourceIndex 收缩到合法范围（clamp）
 *   6. useEffect2：sourceIndex 变化时，重置 selectedIndex=0（切源后从第一个文件开始）
 *   7. 注册 diff-dialog overlay，禁用 Chat 层键盘绑定（避免穿透）
 *   8. 注册 6 个键盘绑定（DiffDialog context），管理导航逻辑
 *   9. 计算 subtitle、headerTitle、headerSubtitle、sourceSelector、dismissShortcut
 *  10. bb0 标记块：计算 emptyMessage（4 种情况：loading/currentTurn无文件/文件过多/干净工作树）
 *  11. 计算 title、handleCancel、inputGuide、内容区（空/列表/详情）、Dialog JSX
 *
 * 在系统中的角色：
 *   作为 diff 查看功能的顶层容器，整合数据源切换与双级导航，
 *   通过 Dialog 组件提供统一的模态框视觉框架。
 */
export function DiffDialog(t0) {
  // _c(73)：初始化 73 个 React Compiler 记忆缓存槽
  const $ = _c(73);
  const {
    messages,
    onDone
  } = t0;

  // 获取当前 git 工作区差异数据（异步加载）
  const gitDiffData = useDiffData();
  // 从消息历史中提取各轮次差异
  const turnDiffs = useTurnDiffs(messages);

  // 视图状态：list（文件列表）/ detail（单文件详情）
  const [viewMode, setViewMode] = useState("list");
  // 当前选中的文件索引
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 当前选中的数据源索引（0 = 当前 git diff，1+ = 历史轮次）
  const [sourceIndex, setSourceIndex] = useState(0);

  let t1;
  // $[0] 槽：缓存静态 {type:"current"} 对象，只创建一次
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      type: "current"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  // $[1]-$[2] 槽：turnDiffs 变化时重建 sources 数组
  if ($[1] !== turnDiffs) {
    // sources = [{type:'current'}, ...turnDiffs 映射为 {type:'turn', turn}]
    t2 = [t1, ...turnDiffs.map(_temp)];
    $[1] = turnDiffs;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const sources = t2;

  // 当前选中的数据源对象
  const currentSource = sources[sourceIndex];
  // 若当前源为历史轮次则取 turn，否则为 null（表示使用 git diff）
  const currentTurn = currentSource?.type === "turn" ? currentSource.turn : null;

  let t3;
  // $[3]-$[5] 槽：currentTurn 或 gitDiffData 变化时重新计算 diffData
  if ($[3] !== currentTurn || $[4] !== gitDiffData) {
    // 历史轮次：转换格式；当前源：直接使用 gitDiffData
    t3 = currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData;
    $[3] = currentTurn;
    $[4] = gitDiffData;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const diffData = t3;

  // 当前选中的文件元数据对象
  const selectedFile = diffData.files[selectedIndex];

  let t4;
  // $[6]-$[8] 槽：diffData.hunks 或 selectedFile 变化时重新取 hunks
  if ($[6] !== diffData.hunks || $[7] !== selectedFile) {
    // 取选中文件的 hunks 数组；无选中文件时返回空数组
    t4 = selectedFile ? diffData.hunks.get(selectedFile.path) || [] : [];
    $[6] = diffData.hunks;
    $[7] = selectedFile;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const selectedHunks = t4;

  let t5;
  let t6;
  // $[9]-$[12] 槽：sourceIndex 或 sources.length 变化时重建 useEffect1 回调和依赖数组
  if ($[9] !== sourceIndex || $[10] !== sources.length) {
    // useEffect1：sources 缩小时将 sourceIndex 收缩到合法范围
    t5 = () => {
      if (sourceIndex >= sources.length) {
        setSourceIndex(Math.max(0, sources.length - 1));
      }
    };
    t6 = [sources.length, sourceIndex]; // 依赖数组
    $[9] = sourceIndex;
    $[10] = sources.length;
    $[11] = t5;
    $[12] = t6;
  } else {
    t5 = $[11];
    t6 = $[12];
  }
  useEffect(t5, t6);

  // prevSourceIndex ref：跟踪上一次的 sourceIndex，用于切源检测
  const prevSourceIndex = useRef(sourceIndex);
  let t7;
  let t8;
  // $[13]-$[15] 槽：sourceIndex 变化时重建 useEffect2 回调
  if ($[13] !== sourceIndex) {
    // useEffect2：sourceIndex 实际变化时（通过 ref 比较）重置文件选中状态
    t7 = () => {
      if (prevSourceIndex.current !== sourceIndex) {
        setSelectedIndex(0); // 切换数据源后重置到第一个文件
        prevSourceIndex.current = sourceIndex; // 同步 ref
      }
    };
    t8 = [sourceIndex]; // 依赖数组
    $[13] = sourceIndex;
    $[14] = t7;
    $[15] = t8;
  } else {
    t7 = $[14];
    t8 = $[15];
  }
  useEffect(t7, t8);

  // 注册为模态 overlay，阻止 Chat 层键盘绑定和取消请求处理器穿透
  useRegisterOverlay("diff-dialog");

  let t10;
  let t9;
  // $[16]-$[19] 槽：sources.length 或 viewMode 变化时重建 previousSource/nextSource 回调
  if ($[16] !== sources.length || $[17] !== viewMode) {
    // diff:previousSource（左箭头）：详情模式 → 返回列表；列表模式 → 切换到上一个数据源
    t9 = () => {
      if (viewMode === "detail") {
        setViewMode("list");
      } else {
        if (viewMode === "list" && sources.length > 1) {
          setSourceIndex(_temp2); // _temp2: prev => Math.max(0, prev - 1)
        }
      }
    };
    // diff:nextSource（右箭头）：列表模式且有多个源时，切换到下一个数据源
    t10 = () => {
      if (viewMode === "list" && sources.length > 1) {
        setSourceIndex(prev_0 => Math.min(sources.length - 1, prev_0 + 1));
      }
    };
    $[16] = sources.length;
    $[17] = viewMode;
    $[18] = t10;
    $[19] = t9;
  } else {
    t10 = $[18];
    t9 = $[19];
  }

  let t11;
  // $[20]-$[21] 槽：viewMode 变化时重建 back 回调
  if ($[20] !== viewMode) {
    // diff:back：详情模式时返回列表视图
    t11 = () => {
      if (viewMode === "detail") {
        setViewMode("list");
      }
    };
    $[20] = viewMode;
    $[21] = t11;
  } else {
    t11 = $[21];
  }

  let t12;
  // $[22]-$[24] 槽：selectedFile 或 viewMode 变化时重建 viewDetails 回调
  if ($[22] !== selectedFile || $[23] !== viewMode) {
    // diff:viewDetails（Enter）：列表模式且有选中文件时进入详情视图
    t12 = () => {
      if (viewMode === "list" && selectedFile) {
        setViewMode("detail");
      }
    };
    $[22] = selectedFile;
    $[23] = viewMode;
    $[24] = t12;
  } else {
    t12 = $[24];
  }

  let t13;
  // $[25]-$[26] 槽：viewMode 变化时重建 previousFile 回调
  if ($[25] !== viewMode) {
    // diff:previousFile（上箭头）：列表模式时向上移动文件光标，最小值 0
    t13 = () => {
      if (viewMode === "list") {
        setSelectedIndex(_temp3); // _temp3: prev => Math.max(0, prev - 1)
      }
    };
    $[25] = viewMode;
    $[26] = t13;
  } else {
    t13 = $[26];
  }

  let t14;
  // $[27]-$[29] 槽：diffData.files.length 或 viewMode 变化时重建 nextFile 回调
  if ($[27] !== diffData.files.length || $[28] !== viewMode) {
    // diff:nextFile（下箭头）：列表模式时向下移动文件光标，最大值为文件总数-1
    t14 = () => {
      if (viewMode === "list") {
        setSelectedIndex(prev_2 => Math.min(diffData.files.length - 1, prev_2 + 1));
      }
    };
    $[27] = diffData.files.length;
    $[28] = viewMode;
    $[29] = t14;
  } else {
    t14 = $[29];
  }

  let t15;
  // $[30]-$[36] 槽：任意一个回调变化时重建 keybindings 映射对象
  if ($[30] !== t10 || $[31] !== t11 || $[32] !== t12 || $[33] !== t13 || $[34] !== t14 || $[35] !== t9) {
    t15 = {
      "diff:previousSource": t9,
      "diff:nextSource": t10,
      "diff:back": t11,
      "diff:viewDetails": t12,
      "diff:previousFile": t13,
      "diff:nextFile": t14
    };
    $[30] = t10;
    $[31] = t11;
    $[32] = t12;
    $[33] = t13;
    $[34] = t14;
    $[35] = t9;
    $[36] = t15;
  } else {
    t15 = $[36];
  }

  let t16;
  // $[37] 槽：静态 keybindings 选项对象，只创建一次（sentinel 缓存）
  if ($[37] === Symbol.for("react.memo_cache_sentinel")) {
    t16 = {
      context: "DiffDialog" // 绑定到 DiffDialog 上下文，避免与全局绑定冲突
    };
    $[37] = t16;
  } else {
    t16 = $[37];
  }
  // 注册所有 6 个 DiffDialog 键盘绑定
  useKeybindings(t15, t16);

  let t17;
  // $[38]-$[39] 槽：diffData.stats 变化时重建 subtitle JSX
  if ($[38] !== diffData.stats) {
    // subtitle：展示 "N files changed +X -Y"（stats 存在时）
    t17 = diffData.stats ? <Text dimColor={true}>{diffData.stats.filesCount} {plural(diffData.stats.filesCount, "file")}{" "}changed{diffData.stats.linesAdded > 0 && <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>}{diffData.stats.linesRemoved > 0 && <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>}</Text> : null;
    $[38] = diffData.stats;
    $[39] = t17;
  } else {
    t17 = $[39];
  }
  const subtitle = t17;

  // headerTitle：历史轮次显示 "Turn N"，当前源显示 "Uncommitted changes"
  const headerTitle = currentTurn ? `Turn ${currentTurn.turnIndex}` : "Uncommitted changes";
  // headerSubtitle：历史轮次显示用户提示预览（带引号），当前源显示 "(git diff HEAD)"
  const headerSubtitle = currentTurn ? currentTurn.userPromptPreview ? `"${currentTurn.userPromptPreview}"` : "" : "(git diff HEAD)";

  let t18;
  // $[40]-$[42] 槽：sourceIndex 或 sources 变化时重建 sourceSelector JSX
  if ($[40] !== sourceIndex || $[41] !== sources) {
    // sourceSelector：多个数据源时渲染带左右箭头的标签页（◀ Current · T1 · T2 ▶）
    t18 = sources.length > 1 ? <Box>{sourceIndex > 0 && <Text dimColor={true}>◀ </Text>}{sources.map((source, i) => {
        const isSelected = i === sourceIndex;
        const label = source.type === "current" ? "Current" : `T${source.turn.turnIndex}`;
        return <Text key={i} dimColor={!isSelected} bold={isSelected}>{i > 0 ? " \xB7 " : ""}{label}</Text>;
      })}{sourceIndex < sources.length - 1 && <Text dimColor={true}> ▶</Text>}</Box> : null;
    $[40] = sourceIndex;
    $[41] = sources;
    $[42] = t18;
  } else {
    t18 = $[42];
  }
  const sourceSelector = t18;

  // 获取 dismiss（关闭）快捷键的显示文本（如 "esc"），用于 inputGuide 提示
  const dismissShortcut = useShortcutDisplay("diff:dismiss", "DiffDialog", "esc");

  let t19;
  // bb0 标记块：React Compiler 将 IIFE 转换为带标签的 break 块，计算 emptyMessage
  bb0: {
    // 情况1：数据加载中
    if (diffData.loading) {
      t19 = "Loading diff\u2026"; // "Loading diff…"
      break bb0;
    }
    // 情况2：历史轮次但没有文件变更
    if (currentTurn) {
      t19 = "No file changes in this turn";
      break bb0;
    }
    // 情况3：有 stats 但文件列表为空（文件数过多，超出展示限制）
    if (diffData.stats && diffData.stats.filesCount > 0 && diffData.files.length === 0) {
      t19 = "Too many files to display details";
      break bb0;
    }
    // 情况4：工作区干净，无任何变更
    t19 = "Working tree is clean";
  }
  const emptyMessage = t19;

  let t20;
  // $[43]-$[44] 槽：headerSubtitle 变化时重建副标题 Text JSX
  if ($[43] !== headerSubtitle) {
    // 有副标题时渲染暗色文本（空字符串时渲染 null）
    t20 = headerSubtitle && <Text dimColor={true}> {headerSubtitle}</Text>;
    $[43] = headerSubtitle;
    $[44] = t20;
  } else {
    t20 = $[44];
  }

  let t21;
  // $[45]-$[47] 槽：headerTitle 或 t20 变化时重建 title JSX
  if ($[45] !== headerTitle || $[46] !== t20) {
    // title = "Uncommitted changes (git diff HEAD)" 或 "Turn N "用户提示预览""
    t21 = <Text>{headerTitle}{t20}</Text>;
    $[45] = headerTitle;
    $[46] = t20;
    $[47] = t21;
  } else {
    t21 = $[47];
  }
  const title = t21;

  let t22;
  // $[48]-$[50] 槽：onDone 或 viewMode 变化时重建 handleCancel 函数
  if ($[48] !== onDone || $[49] !== viewMode) {
    // handleCancel：详情模式 → 返回列表；列表模式 → 关闭对话框（调用 onDone）
    t22 = function handleCancel() {
      if (viewMode === "detail") {
        setViewMode("list");
      } else {
        onDone("Diff dialog dismissed", {
          display: "system" // 以系统消息形式通知关闭
        });
      }
    };
    $[48] = onDone;
    $[49] = viewMode;
    $[50] = t22;
  } else {
    t22 = $[50];
  }
  const handleCancel = t22;

  let t23;
  // $[51]-$[54] 槽：dismissShortcut/sources.length/viewMode 变化时重建 inputGuide 函数
  if ($[51] !== dismissShortcut || $[52] !== sources.length || $[53] !== viewMode) {
    // inputGuide 函数：根据 exitState.pending 和 viewMode 动态渲染底部操作提示
    // - pending=true：显示"再按一次退出"提示
    // - list 模式：显示 ←/→ source（多源时）、↑/↓ select、Enter view、esc close
    // - detail 模式：显示 ← back、esc close
    t23 = exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : viewMode === "list" ? <Byline>{sources.length > 1 && <Text>←/→ source</Text>}<Text>↑/↓ select</Text><Text>Enter view</Text><Text>{dismissShortcut} close</Text></Byline> : <Byline><Text>← back</Text><Text>{dismissShortcut} close</Text></Byline>;
    $[51] = dismissShortcut;
    $[52] = sources.length;
    $[53] = viewMode;
    $[54] = t23;
  } else {
    t23 = $[54];
  }

  let t24;
  // $[55]-$[65] 槽：10 个差异数据字段任一变化时重建内容区 JSX
  if ($[55] !== diffData.files || $[56] !== emptyMessage || $[57] !== selectedFile?.isBinary || $[58] !== selectedFile?.isLargeFile || $[59] !== selectedFile?.isTruncated || $[60] !== selectedFile?.isUntracked || $[61] !== selectedFile?.path || $[62] !== selectedHunks || $[63] !== selectedIndex || $[64] !== viewMode) {
    // 三路分支：空文件列表 → 显示 emptyMessage；list 视图 → DiffFileList；detail 视图 → DiffDetailView
    t24 = diffData.files.length === 0 ? <Box marginTop={1}><Text dimColor={true}>{emptyMessage}</Text></Box> : viewMode === "list" ? <Box flexDirection="column" marginTop={1}><DiffFileList files={diffData.files} selectedIndex={selectedIndex} /></Box> : <Box flexDirection="column" marginTop={1}><DiffDetailView filePath={selectedFile?.path || ""} hunks={selectedHunks} isLargeFile={selectedFile?.isLargeFile} isBinary={selectedFile?.isBinary} isTruncated={selectedFile?.isTruncated} isUntracked={selectedFile?.isUntracked} /></Box>;
    $[55] = diffData.files;
    $[56] = emptyMessage;
    $[57] = selectedFile?.isBinary;
    $[58] = selectedFile?.isLargeFile;
    $[59] = selectedFile?.isTruncated;
    $[60] = selectedFile?.isUntracked;
    $[61] = selectedFile?.path;
    $[62] = selectedHunks;
    $[63] = selectedIndex;
    $[64] = viewMode;
    $[65] = t24;
  } else {
    t24 = $[65];
  }

  let t25;
  // $[66]-$[72] 槽：任意显示依赖变化时重建最终 Dialog JSX
  if ($[66] !== handleCancel || $[67] !== sourceSelector || $[68] !== subtitle || $[69] !== t23 || $[70] !== t24 || $[71] !== title) {
    // 渲染 Dialog，包含：sourceSelector（数据源选择器）、subtitle（统计信息）、内容区（文件列表/详情/空提示）
    t25 = <Dialog title={title} onCancel={handleCancel} color="background" inputGuide={t23}>{sourceSelector}{subtitle}{t24}</Dialog>;
    $[66] = handleCancel;
    $[67] = sourceSelector;
    $[68] = subtitle;
    $[69] = t23;
    $[70] = t24;
    $[71] = title;
    $[72] = t25;
  } else {
    t25 = $[72];
  }
  return t25;
}

/**
 * _temp3（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码：setSelectedIndex(prev => Math.max(0, prev - 1))
 *   - React Compiler 提取为模块作用域函数，避免每次渲染创建新的函数引用
 *   - 用于 diff:previousFile 按键绑定，向上移动文件光标（不低于 0）
 */
function _temp3(prev_1) {
  return Math.max(0, prev_1 - 1);
}

/**
 * _temp2（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码：setSourceIndex(prev => Math.max(0, prev - 1))
 *   - React Compiler 提取为模块作用域函数，避免闭包重建
 *   - 用于 diff:previousSource 按键绑定，向左切换数据源（不低于 0）
 */
function _temp2(prev) {
  return Math.max(0, prev - 1);
}

/**
 * _temp（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码：turnDiffs.map(turn => ({type: 'turn', turn}))
 *   - React Compiler 提取为模块作用域函数，提供稳定的 map 回调引用
 *   - 将 TurnDiff 包装为 DiffSource 对象，加入 sources 数组
 */
function _temp(turn) {
  return {
    type: "turn",
    turn
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTdHJ1Y3R1cmVkUGF0Y2hIdW5rIiwiUmVhY3QiLCJ1c2VFZmZlY3QiLCJ1c2VNZW1vIiwidXNlUmVmIiwidXNlU3RhdGUiLCJDb21tYW5kUmVzdWx0RGlzcGxheSIsInVzZVJlZ2lzdGVyT3ZlcmxheSIsIkRpZmZEYXRhIiwidXNlRGlmZkRhdGEiLCJUdXJuRGlmZiIsInVzZVR1cm5EaWZmcyIsIkJveCIsIlRleHQiLCJ1c2VLZXliaW5kaW5ncyIsInVzZVNob3J0Y3V0RGlzcGxheSIsIk1lc3NhZ2UiLCJwbHVyYWwiLCJCeWxpbmUiLCJEaWFsb2ciLCJEaWZmRGV0YWlsVmlldyIsIkRpZmZGaWxlTGlzdCIsIlByb3BzIiwibWVzc2FnZXMiLCJvbkRvbmUiLCJyZXN1bHQiLCJvcHRpb25zIiwiZGlzcGxheSIsIlZpZXdNb2RlIiwiRGlmZlNvdXJjZSIsInR5cGUiLCJ0dXJuIiwidHVybkRpZmZUb0RpZmZEYXRhIiwiZmlsZXMiLCJBcnJheSIsImZyb20iLCJ2YWx1ZXMiLCJtYXAiLCJmIiwicGF0aCIsImZpbGVQYXRoIiwibGluZXNBZGRlZCIsImxpbmVzUmVtb3ZlZCIsImlzQmluYXJ5IiwiaXNMYXJnZUZpbGUiLCJpc1RydW5jYXRlZCIsImlzTmV3RmlsZSIsInNvcnQiLCJhIiwiYiIsImxvY2FsZUNvbXBhcmUiLCJodW5rcyIsIk1hcCIsInNldCIsInN0YXRzIiwiZmlsZXNDb3VudCIsImZpbGVzQ2hhbmdlZCIsImxvYWRpbmciLCJEaWZmRGlhbG9nIiwidDAiLCIkIiwiX2MiLCJnaXREaWZmRGF0YSIsInR1cm5EaWZmcyIsInZpZXdNb2RlIiwic2V0Vmlld01vZGUiLCJzZWxlY3RlZEluZGV4Iiwic2V0U2VsZWN0ZWRJbmRleCIsInNvdXJjZUluZGV4Iiwic2V0U291cmNlSW5kZXgiLCJ0MSIsIlN5bWJvbCIsImZvciIsInQyIiwiX3RlbXAiLCJzb3VyY2VzIiwiY3VycmVudFNvdXJjZSIsImN1cnJlbnRUdXJuIiwidDMiLCJkaWZmRGF0YSIsInNlbGVjdGVkRmlsZSIsInQ0IiwiZ2V0Iiwic2VsZWN0ZWRIdW5rcyIsInQ1IiwidDYiLCJsZW5ndGgiLCJNYXRoIiwibWF4IiwicHJldlNvdXJjZUluZGV4IiwidDciLCJ0OCIsImN1cnJlbnQiLCJ0MTAiLCJ0OSIsIl90ZW1wMiIsInByZXZfMCIsIm1pbiIsInByZXYiLCJ0MTEiLCJ0MTIiLCJ0MTMiLCJfdGVtcDMiLCJ0MTQiLCJwcmV2XzIiLCJ0MTUiLCJ0MTYiLCJjb250ZXh0IiwidDE3Iiwic3VidGl0bGUiLCJoZWFkZXJUaXRsZSIsInR1cm5JbmRleCIsImhlYWRlclN1YnRpdGxlIiwidXNlclByb21wdFByZXZpZXciLCJ0MTgiLCJzb3VyY2UiLCJpIiwiaXNTZWxlY3RlZCIsImxhYmVsIiwic291cmNlU2VsZWN0b3IiLCJkaXNtaXNzU2hvcnRjdXQiLCJ0MTkiLCJiYjAiLCJlbXB0eU1lc3NhZ2UiLCJ0MjAiLCJ0MjEiLCJ0aXRsZSIsInQyMiIsImhhbmRsZUNhbmNlbCIsInQyMyIsImV4aXRTdGF0ZSIsInBlbmRpbmciLCJrZXlOYW1lIiwidDI0IiwiaXNVbnRyYWNrZWQiLCJ0MjUiLCJwcmV2XzEiXSwic291cmNlcyI6WyJEaWZmRGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0IFJlYWN0LCB7IHVzZUVmZmVjdCwgdXNlTWVtbywgdXNlUmVmLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHR5cGUgeyBDb21tYW5kUmVzdWx0RGlzcGxheSB9IGZyb20gJy4uLy4uL2NvbW1hbmRzLmpzJ1xuaW1wb3J0IHsgdXNlUmVnaXN0ZXJPdmVybGF5IH0gZnJvbSAnLi4vLi4vY29udGV4dC9vdmVybGF5Q29udGV4dC5qcydcbmltcG9ydCB7IHR5cGUgRGlmZkRhdGEsIHVzZURpZmZEYXRhIH0gZnJvbSAnLi4vLi4vaG9va3MvdXNlRGlmZkRhdGEuanMnXG5pbXBvcnQgeyB0eXBlIFR1cm5EaWZmLCB1c2VUdXJuRGlmZnMgfSBmcm9tICcuLi8uLi9ob29rcy91c2VUdXJuRGlmZnMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB1c2VLZXliaW5kaW5ncyB9IGZyb20gJy4uLy4uL2tleWJpbmRpbmdzL3VzZUtleWJpbmRpbmcuanMnXG5pbXBvcnQgeyB1c2VTaG9ydGN1dERpc3BsYXkgfSBmcm9tICcuLi8uLi9rZXliaW5kaW5ncy91c2VTaG9ydGN1dERpc3BsYXkuanMnXG5pbXBvcnQgdHlwZSB7IE1lc3NhZ2UgfSBmcm9tICcuLi8uLi90eXBlcy9tZXNzYWdlLmpzJ1xuaW1wb3J0IHsgcGx1cmFsIH0gZnJvbSAnLi4vLi4vdXRpbHMvc3RyaW5nVXRpbHMuanMnXG5pbXBvcnQgeyBCeWxpbmUgfSBmcm9tICcuLi9kZXNpZ24tc3lzdGVtL0J5bGluZS5qcydcbmltcG9ydCB7IERpYWxvZyB9IGZyb20gJy4uL2Rlc2lnbi1zeXN0ZW0vRGlhbG9nLmpzJ1xuaW1wb3J0IHsgRGlmZkRldGFpbFZpZXcgfSBmcm9tICcuL0RpZmZEZXRhaWxWaWV3LmpzJ1xuaW1wb3J0IHsgRGlmZkZpbGVMaXN0IH0gZnJvbSAnLi9EaWZmRmlsZUxpc3QuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIG1lc3NhZ2VzOiBNZXNzYWdlW11cbiAgb25Eb25lOiAoXG4gICAgcmVzdWx0Pzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiB7IGRpc3BsYXk/OiBDb21tYW5kUmVzdWx0RGlzcGxheSB9LFxuICApID0+IHZvaWRcbn1cblxudHlwZSBWaWV3TW9kZSA9ICdsaXN0JyB8ICdkZXRhaWwnXG5cbnR5cGUgRGlmZlNvdXJjZSA9IHsgdHlwZTogJ2N1cnJlbnQnIH0gfCB7IHR5cGU6ICd0dXJuJzsgdHVybjogVHVybkRpZmYgfVxuXG5mdW5jdGlvbiB0dXJuRGlmZlRvRGlmZkRhdGEodHVybjogVHVybkRpZmYpOiBEaWZmRGF0YSB7XG4gIGNvbnN0IGZpbGVzID0gQXJyYXkuZnJvbSh0dXJuLmZpbGVzLnZhbHVlcygpKVxuICAgIC5tYXAoZiA9PiAoe1xuICAgICAgcGF0aDogZi5maWxlUGF0aCxcbiAgICAgIGxpbmVzQWRkZWQ6IGYubGluZXNBZGRlZCxcbiAgICAgIGxpbmVzUmVtb3ZlZDogZi5saW5lc1JlbW92ZWQsXG4gICAgICBpc0JpbmFyeTogZmFsc2UsXG4gICAgICBpc0xhcmdlRmlsZTogZmFsc2UsXG4gICAgICBpc1RydW5jYXRlZDogZmFsc2UsXG4gICAgICBpc05ld0ZpbGU6IGYuaXNOZXdGaWxlLFxuICAgIH0pKVxuICAgIC5zb3J0KChhLCBiKSA9PiBhLnBhdGgubG9jYWxlQ29tcGFyZShiLnBhdGgpKVxuXG4gIGNvbnN0IGh1bmtzID0gbmV3IE1hcDxzdHJpbmcsIFN0cnVjdHVyZWRQYXRjaEh1bmtbXT4oKVxuICBmb3IgKGNvbnN0IGYgb2YgdHVybi5maWxlcy52YWx1ZXMoKSkge1xuICAgIGh1bmtzLnNldChmLmZpbGVQYXRoLCBmLmh1bmtzKVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0czoge1xuICAgICAgZmlsZXNDb3VudDogdHVybi5zdGF0cy5maWxlc0NoYW5nZWQsXG4gICAgICBsaW5lc0FkZGVkOiB0dXJuLnN0YXRzLmxpbmVzQWRkZWQsXG4gICAgICBsaW5lc1JlbW92ZWQ6IHR1cm4uc3RhdHMubGluZXNSZW1vdmVkLFxuICAgIH0sXG4gICAgZmlsZXMsXG4gICAgaHVua3MsXG4gICAgbG9hZGluZzogZmFsc2UsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERpZmZEaWFsb2coeyBtZXNzYWdlcywgb25Eb25lIH06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgZ2l0RGlmZkRhdGEgPSB1c2VEaWZmRGF0YSgpXG4gIGNvbnN0IHR1cm5EaWZmcyA9IHVzZVR1cm5EaWZmcyhtZXNzYWdlcylcblxuICBjb25zdCBbdmlld01vZGUsIHNldFZpZXdNb2RlXSA9IHVzZVN0YXRlPFZpZXdNb2RlPignbGlzdCcpXG4gIGNvbnN0IFtzZWxlY3RlZEluZGV4LCBzZXRTZWxlY3RlZEluZGV4XSA9IHVzZVN0YXRlPG51bWJlcj4oMClcbiAgY29uc3QgW3NvdXJjZUluZGV4LCBzZXRTb3VyY2VJbmRleF0gPSB1c2VTdGF0ZTxudW1iZXI+KDApXG5cbiAgY29uc3Qgc291cmNlczogRGlmZlNvdXJjZVtdID0gdXNlTWVtbyhcbiAgICAoKSA9PiBbXG4gICAgICB7IHR5cGU6ICdjdXJyZW50JyB9LFxuICAgICAgLi4udHVybkRpZmZzLm1hcCgodHVybik6IERpZmZTb3VyY2UgPT4gKHsgdHlwZTogJ3R1cm4nLCB0dXJuIH0pKSxcbiAgICBdLFxuICAgIFt0dXJuRGlmZnNdLFxuICApXG5cbiAgY29uc3QgY3VycmVudFNvdXJjZSA9IHNvdXJjZXNbc291cmNlSW5kZXhdXG4gIGNvbnN0IGN1cnJlbnRUdXJuID0gY3VycmVudFNvdXJjZT8udHlwZSA9PT0gJ3R1cm4nID8gY3VycmVudFNvdXJjZS50dXJuIDogbnVsbFxuXG4gIGNvbnN0IGRpZmZEYXRhID0gdXNlTWVtbygoKTogRGlmZkRhdGEgPT4ge1xuICAgIHJldHVybiBjdXJyZW50VHVybiA/IHR1cm5EaWZmVG9EaWZmRGF0YShjdXJyZW50VHVybikgOiBnaXREaWZmRGF0YVxuICB9LCBbY3VycmVudFR1cm4sIGdpdERpZmZEYXRhXSlcblxuICBjb25zdCBzZWxlY3RlZEZpbGUgPSBkaWZmRGF0YS5maWxlc1tzZWxlY3RlZEluZGV4XVxuICBjb25zdCBzZWxlY3RlZEh1bmtzID0gdXNlTWVtbygoKSA9PiB7XG4gICAgcmV0dXJuIHNlbGVjdGVkRmlsZSA/IGRpZmZEYXRhLmh1bmtzLmdldChzZWxlY3RlZEZpbGUucGF0aCkgfHwgW10gOiBbXVxuICB9LCBbc2VsZWN0ZWRGaWxlLCBkaWZmRGF0YS5odW5rc10pXG5cbiAgLy8gQ2xhbXAgc291cmNlSW5kZXggd2hlbiBzb3VyY2VzIHNocmluayAoZS5nLiwgY29udmVyc2F0aW9uIHJld2luZClcbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAoc291cmNlSW5kZXggPj0gc291cmNlcy5sZW5ndGgpIHtcbiAgICAgIHNldFNvdXJjZUluZGV4KE1hdGgubWF4KDAsIHNvdXJjZXMubGVuZ3RoIC0gMSkpXG4gICAgfVxuICB9LCBbc291cmNlcy5sZW5ndGgsIHNvdXJjZUluZGV4XSlcblxuICAvLyBSZXNldCBmaWxlIHNlbGVjdGlvbiB3aGVuIHNvdXJjZSBjaGFuZ2VzXG4gIGNvbnN0IHByZXZTb3VyY2VJbmRleCA9IHVzZVJlZihzb3VyY2VJbmRleClcbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAocHJldlNvdXJjZUluZGV4LmN1cnJlbnQgIT09IHNvdXJjZUluZGV4KSB7XG4gICAgICBzZXRTZWxlY3RlZEluZGV4KDApXG4gICAgICBwcmV2U291cmNlSW5kZXguY3VycmVudCA9IHNvdXJjZUluZGV4XG4gICAgfVxuICB9LCBbc291cmNlSW5kZXhdKVxuXG4gIC8vIFJlZ2lzdGVyIGFzIG1vZGFsIG92ZXJsYXkgc28gQ2hhdCBrZXliaW5kaW5ncyBhbmQgQ2FuY2VsUmVxdWVzdEhhbmRsZXJcbiAgLy8gYXJlIGRpc2FibGVkIHdoaWxlIERpZmZEaWFsb2cgaXMgc2hvd2luZ1xuICB1c2VSZWdpc3Rlck92ZXJsYXkoJ2RpZmYtZGlhbG9nJylcblxuICAvLyBEaWZmIGRpYWxvZyBuYXZpZ2F0aW9uIGtleWJpbmRpbmdzXG4gIC8vIFZpZXctbW9kZSBkZXBlbmRlbnQ6IGxlZnQvcmlnaHQgYXJyb3dzIGhhdmUgZGlmZmVyZW50IGJlaGF2aW9yIGJhc2VkIG9uIG1vZGVcbiAgLy8gKHNvdXJjZSB0YWIgc3dpdGNoaW5nIHZzIGJhY2sgbmF2aWdhdGlvbiksIGFuZCB1cC9kb3duL2VudGVyIGFyZVxuICAvLyBjb250ZXh0LXNlbnNpdGl2ZSB0byB2aWV3TW9kZVxuICAvL1xuICAvLyBOb3RlOiBFc2NhcGUgaGFuZGxpbmcgKGRpZmY6ZGlzbWlzcykgaXMgTk9UIHJlZ2lzdGVyZWQgaGVyZSBiZWNhdXNlIERpYWxvZydzXG4gIC8vIGJ1aWx0LWluIHVzZUtleWJpbmRpbmcoJ2NvbmZpcm06bm8nLCBoYW5kbGVDYW5jZWwpIGFscmVhZHkgaGFuZGxlcyBpdC5cbiAgLy8gSGF2aW5nIGJvdGggd291bGQgYmUgZGVhZCBjb2RlIHNpbmNlIERpYWxvZydzIGNoaWxkIGVmZmVjdCByZWdpc3RlcnMgZmlyc3RcbiAgLy8gYW5kIGNhbGxzIHN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpLiBUaGUgZGlmZjpkaXNtaXNzIGJpbmRpbmcgaW5cbiAgLy8gZGVmYXVsdEJpbmRpbmdzLnRzIGlzIGtlcHQgZm9yIHVzZVNob3J0Y3V0RGlzcGxheSB0byBzaG93IHRoZSBcImVzYyBjbG9zZVwiIGhpbnQuXG4gIHVzZUtleWJpbmRpbmdzKFxuICAgIHtcbiAgICAgIC8vIExlZnQgYXJyb3c6IGluIGRldGFpbCBtb2RlIGdvZXMgYmFjaywgaW4gbGlzdCBtb2RlIHN3aXRjaGVzIHNvdXJjZVxuICAgICAgJ2RpZmY6cHJldmlvdXNTb3VyY2UnOiAoKSA9PiB7XG4gICAgICAgIGlmICh2aWV3TW9kZSA9PT0gJ2RldGFpbCcpIHtcbiAgICAgICAgICBzZXRWaWV3TW9kZSgnbGlzdCcpXG4gICAgICAgIH0gZWxzZSBpZiAodmlld01vZGUgPT09ICdsaXN0JyAmJiBzb3VyY2VzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICBzZXRTb3VyY2VJbmRleChwcmV2ID0+IE1hdGgubWF4KDAsIHByZXYgLSAxKSlcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgICdkaWZmOm5leHRTb3VyY2UnOiAoKSA9PiB7XG4gICAgICAgIGlmICh2aWV3TW9kZSA9PT0gJ2xpc3QnICYmIHNvdXJjZXMubGVuZ3RoID4gMSkge1xuICAgICAgICAgIHNldFNvdXJjZUluZGV4KHByZXYgPT4gTWF0aC5taW4oc291cmNlcy5sZW5ndGggLSAxLCBwcmV2ICsgMSkpXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICAnZGlmZjpiYWNrJzogKCkgPT4ge1xuICAgICAgICBpZiAodmlld01vZGUgPT09ICdkZXRhaWwnKSB7XG4gICAgICAgICAgc2V0Vmlld01vZGUoJ2xpc3QnKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgJ2RpZmY6dmlld0RldGFpbHMnOiAoKSA9PiB7XG4gICAgICAgIGlmICh2aWV3TW9kZSA9PT0gJ2xpc3QnICYmIHNlbGVjdGVkRmlsZSkge1xuICAgICAgICAgIHNldFZpZXdNb2RlKCdkZXRhaWwnKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgJ2RpZmY6cHJldmlvdXNGaWxlJzogKCkgPT4ge1xuICAgICAgICBpZiAodmlld01vZGUgPT09ICdsaXN0Jykge1xuICAgICAgICAgIHNldFNlbGVjdGVkSW5kZXgocHJldiA9PiBNYXRoLm1heCgwLCBwcmV2IC0gMSkpXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICAnZGlmZjpuZXh0RmlsZSc6ICgpID0+IHtcbiAgICAgICAgaWYgKHZpZXdNb2RlID09PSAnbGlzdCcpIHtcbiAgICAgICAgICBzZXRTZWxlY3RlZEluZGV4KHByZXYgPT5cbiAgICAgICAgICAgIE1hdGgubWluKGRpZmZEYXRhLmZpbGVzLmxlbmd0aCAtIDEsIHByZXYgKyAxKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfSxcbiAgICB7IGNvbnRleHQ6ICdEaWZmRGlhbG9nJyB9LFxuICApXG5cbiAgY29uc3Qgc3VidGl0bGUgPSBkaWZmRGF0YS5zdGF0cyA/IChcbiAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgIHtkaWZmRGF0YS5zdGF0cy5maWxlc0NvdW50fSB7cGx1cmFsKGRpZmZEYXRhLnN0YXRzLmZpbGVzQ291bnQsICdmaWxlJyl9eycgJ31cbiAgICAgIGNoYW5nZWRcbiAgICAgIHtkaWZmRGF0YS5zdGF0cy5saW5lc0FkZGVkID4gMCAmJiAoXG4gICAgICAgIDxUZXh0IGNvbG9yPVwiZGlmZkFkZGVkV29yZFwiPiAre2RpZmZEYXRhLnN0YXRzLmxpbmVzQWRkZWR9PC9UZXh0PlxuICAgICAgKX1cbiAgICAgIHtkaWZmRGF0YS5zdGF0cy5saW5lc1JlbW92ZWQgPiAwICYmIChcbiAgICAgICAgPFRleHQgY29sb3I9XCJkaWZmUmVtb3ZlZFdvcmRcIj4gLXtkaWZmRGF0YS5zdGF0cy5saW5lc1JlbW92ZWR9PC9UZXh0PlxuICAgICAgKX1cbiAgICA8L1RleHQ+XG4gICkgOiBudWxsXG5cbiAgLy8gQnVpbGQgaGVhZGVyIGJhc2VkIG9uIGN1cnJlbnQgc291cmNlXG4gIGNvbnN0IGhlYWRlclRpdGxlID0gY3VycmVudFR1cm5cbiAgICA/IGBUdXJuICR7Y3VycmVudFR1cm4udHVybkluZGV4fWBcbiAgICA6ICdVbmNvbW1pdHRlZCBjaGFuZ2VzJ1xuICBjb25zdCBoZWFkZXJTdWJ0aXRsZSA9IGN1cnJlbnRUdXJuXG4gICAgPyBjdXJyZW50VHVybi51c2VyUHJvbXB0UHJldmlld1xuICAgICAgPyBgXCIke2N1cnJlbnRUdXJuLnVzZXJQcm9tcHRQcmV2aWV3fVwiYFxuICAgICAgOiAnJ1xuICAgIDogJyhnaXQgZGlmZiBIRUFEKSdcblxuICAvLyBTb3VyY2Ugc2VsZWN0b3IgcGlsbHNcbiAgY29uc3Qgc291cmNlU2VsZWN0b3IgPVxuICAgIHNvdXJjZXMubGVuZ3RoID4gMSA/IChcbiAgICAgIDxCb3g+XG4gICAgICAgIHtzb3VyY2VJbmRleCA+IDAgJiYgPFRleHQgZGltQ29sb3I+4peAIDwvVGV4dD59XG4gICAgICAgIHtzb3VyY2VzLm1hcCgoc291cmNlLCBpKSA9PiB7XG4gICAgICAgICAgY29uc3QgaXNTZWxlY3RlZCA9IGkgPT09IHNvdXJjZUluZGV4XG4gICAgICAgICAgY29uc3QgbGFiZWwgPVxuICAgICAgICAgICAgc291cmNlLnR5cGUgPT09ICdjdXJyZW50JyA/ICdDdXJyZW50JyA6IGBUJHtzb3VyY2UudHVybi50dXJuSW5kZXh9YFxuICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICA8VGV4dCBrZXk9e2l9IGRpbUNvbG9yPXshaXNTZWxlY3RlZH0gYm9sZD17aXNTZWxlY3RlZH0+XG4gICAgICAgICAgICAgIHtpID4gMCA/ICcgwrcgJyA6ICcnfVxuICAgICAgICAgICAgICB7bGFiZWx9XG4gICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgKVxuICAgICAgICB9KX1cbiAgICAgICAge3NvdXJjZUluZGV4IDwgc291cmNlcy5sZW5ndGggLSAxICYmIDxUZXh0IGRpbUNvbG9yPiDilrY8L1RleHQ+fVxuICAgICAgPC9Cb3g+XG4gICAgKSA6IG51bGxcblxuICBjb25zdCBkaXNtaXNzU2hvcnRjdXQgPSB1c2VTaG9ydGN1dERpc3BsYXkoXG4gICAgJ2RpZmY6ZGlzbWlzcycsXG4gICAgJ0RpZmZEaWFsb2cnLFxuICAgICdlc2MnLFxuICApXG4gIC8vIERldGVybWluZSB0aGUgYXBwcm9wcmlhdGUgbWVzc2FnZSB3aGVuIG5vIGZpbGVzIGFyZSBzaG93blxuICBjb25zdCBlbXB0eU1lc3NhZ2UgPSAoKCkgPT4ge1xuICAgIGlmIChkaWZmRGF0YS5sb2FkaW5nKSB7XG4gICAgICByZXR1cm4gJ0xvYWRpbmcgZGlmZuKApidcbiAgICB9XG4gICAgaWYgKGN1cnJlbnRUdXJuKSB7XG4gICAgICByZXR1cm4gJ05vIGZpbGUgY2hhbmdlcyBpbiB0aGlzIHR1cm4nXG4gICAgfVxuICAgIC8vIENoZWNrIGlmIHdlIGhhdmUgc3RhdHMgYnV0IG5vIGZpbGVzICh0b28gbWFueSBmaWxlcyBjYXNlKVxuICAgIGlmIChcbiAgICAgIGRpZmZEYXRhLnN0YXRzICYmXG4gICAgICBkaWZmRGF0YS5zdGF0cy5maWxlc0NvdW50ID4gMCAmJlxuICAgICAgZGlmZkRhdGEuZmlsZXMubGVuZ3RoID09PSAwXG4gICAgKSB7XG4gICAgICByZXR1cm4gJ1RvbyBtYW55IGZpbGVzIHRvIGRpc3BsYXkgZGV0YWlscydcbiAgICB9XG4gICAgcmV0dXJuICdXb3JraW5nIHRyZWUgaXMgY2xlYW4nXG4gIH0pKClcblxuICAvLyBCdWlsZCB0aXRsZSB3aXRoIGhlYWRlciBzdWJ0aXRsZSBpbmxpbmVcbiAgY29uc3QgdGl0bGUgPSAoXG4gICAgPFRleHQ+XG4gICAgICB7aGVhZGVyVGl0bGV9XG4gICAgICB7aGVhZGVyU3VidGl0bGUgJiYgPFRleHQgZGltQ29sb3I+IHtoZWFkZXJTdWJ0aXRsZX08L1RleHQ+fVxuICAgIDwvVGV4dD5cbiAgKVxuXG4gIC8vIEhhbmRsZSBjYW5jZWwvZGlzbWlzcyAtIGluIGRldGFpbCBtb2RlIGdvZXMgYmFjaywgaW4gbGlzdCBtb2RlIGRpc21pc3Nlc1xuICBmdW5jdGlvbiBoYW5kbGVDYW5jZWwoKTogdm9pZCB7XG4gICAgaWYgKHZpZXdNb2RlID09PSAnZGV0YWlsJykge1xuICAgICAgc2V0Vmlld01vZGUoJ2xpc3QnKVxuICAgIH0gZWxzZSB7XG4gICAgICBvbkRvbmUoJ0RpZmYgZGlhbG9nIGRpc21pc3NlZCcsIHsgZGlzcGxheTogJ3N5c3RlbScgfSlcbiAgICB9XG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxEaWFsb2dcbiAgICAgIHRpdGxlPXt0aXRsZX1cbiAgICAgIG9uQ2FuY2VsPXtoYW5kbGVDYW5jZWx9XG4gICAgICBjb2xvcj1cImJhY2tncm91bmRcIlxuICAgICAgaW5wdXRHdWlkZT17ZXhpdFN0YXRlID0+XG4gICAgICAgIGV4aXRTdGF0ZS5wZW5kaW5nID8gKFxuICAgICAgICAgIDxUZXh0PlByZXNzIHtleGl0U3RhdGUua2V5TmFtZX0gYWdhaW4gdG8gZXhpdDwvVGV4dD5cbiAgICAgICAgKSA6IHZpZXdNb2RlID09PSAnbGlzdCcgPyAoXG4gICAgICAgICAgPEJ5bGluZT5cbiAgICAgICAgICAgIHtzb3VyY2VzLmxlbmd0aCA+IDEgJiYgPFRleHQ+4oaQL+KGkiBzb3VyY2U8L1RleHQ+fVxuICAgICAgICAgICAgPFRleHQ+4oaRL+KGkyBzZWxlY3Q8L1RleHQ+XG4gICAgICAgICAgICA8VGV4dD5FbnRlciB2aWV3PC9UZXh0PlxuICAgICAgICAgICAgPFRleHQ+e2Rpc21pc3NTaG9ydGN1dH0gY2xvc2U8L1RleHQ+XG4gICAgICAgICAgPC9CeWxpbmU+XG4gICAgICAgICkgOiAoXG4gICAgICAgICAgPEJ5bGluZT5cbiAgICAgICAgICAgIDxUZXh0PuKGkCBiYWNrPC9UZXh0PlxuICAgICAgICAgICAgPFRleHQ+e2Rpc21pc3NTaG9ydGN1dH0gY2xvc2U8L1RleHQ+XG4gICAgICAgICAgPC9CeWxpbmU+XG4gICAgICAgIClcbiAgICAgIH1cbiAgICA+XG4gICAgICB7c291cmNlU2VsZWN0b3J9XG4gICAgICB7c3VidGl0bGV9XG4gICAgICB7ZGlmZkRhdGEuZmlsZXMubGVuZ3RoID09PSAwID8gKFxuICAgICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+e2VtcHR5TWVzc2FnZX08L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKSA6IHZpZXdNb2RlID09PSAnbGlzdCcgPyAoXG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgPERpZmZGaWxlTGlzdCBmaWxlcz17ZGlmZkRhdGEuZmlsZXN9IHNlbGVjdGVkSW5kZXg9e3NlbGVjdGVkSW5kZXh9IC8+XG4gICAgICAgIDwvQm94PlxuICAgICAgKSA6IChcbiAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICA8RGlmZkRldGFpbFZpZXdcbiAgICAgICAgICAgIGZpbGVQYXRoPXtzZWxlY3RlZEZpbGU/LnBhdGggfHwgJyd9XG4gICAgICAgICAgICBodW5rcz17c2VsZWN0ZWRIdW5rc31cbiAgICAgICAgICAgIGlzTGFyZ2VGaWxlPXtzZWxlY3RlZEZpbGU/LmlzTGFyZ2VGaWxlfVxuICAgICAgICAgICAgaXNCaW5hcnk9e3NlbGVjdGVkRmlsZT8uaXNCaW5hcnl9XG4gICAgICAgICAgICBpc1RydW5jYXRlZD17c2VsZWN0ZWRGaWxlPy5pc1RydW5jYXRlZH1cbiAgICAgICAgICAgIGlzVW50cmFja2VkPXtzZWxlY3RlZEZpbGU/LmlzVW50cmFja2VkfVxuICAgICAgICAgIC8+XG4gICAgICAgIDwvQm94PlxuICAgICAgKX1cbiAgICA8L0RpYWxvZz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsY0FBY0EsbUJBQW1CLFFBQVEsTUFBTTtBQUMvQyxPQUFPQyxLQUFLLElBQUlDLFNBQVMsRUFBRUMsT0FBTyxFQUFFQyxNQUFNLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ25FLGNBQWNDLG9CQUFvQixRQUFRLG1CQUFtQjtBQUM3RCxTQUFTQyxrQkFBa0IsUUFBUSxpQ0FBaUM7QUFDcEUsU0FBUyxLQUFLQyxRQUFRLEVBQUVDLFdBQVcsUUFBUSw0QkFBNEI7QUFDdkUsU0FBUyxLQUFLQyxRQUFRLEVBQUVDLFlBQVksUUFBUSw2QkFBNkI7QUFDekUsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxjQUFjLFFBQVEsb0NBQW9DO0FBQ25FLFNBQVNDLGtCQUFrQixRQUFRLHlDQUF5QztBQUM1RSxjQUFjQyxPQUFPLFFBQVEsd0JBQXdCO0FBQ3JELFNBQVNDLE1BQU0sUUFBUSw0QkFBNEI7QUFDbkQsU0FBU0MsTUFBTSxRQUFRLDRCQUE0QjtBQUNuRCxTQUFTQyxNQUFNLFFBQVEsNEJBQTRCO0FBQ25ELFNBQVNDLGNBQWMsUUFBUSxxQkFBcUI7QUFDcEQsU0FBU0MsWUFBWSxRQUFRLG1CQUFtQjtBQUVoRCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsUUFBUSxFQUFFUCxPQUFPLEVBQUU7RUFDbkJRLE1BQU0sRUFBRSxDQUNOQyxNQUFlLENBQVIsRUFBRSxNQUFNLEVBQ2ZDLE9BQTRDLENBQXBDLEVBQUU7SUFBRUMsT0FBTyxDQUFDLEVBQUVyQixvQkFBb0I7RUFBQyxDQUFDLEVBQzVDLEdBQUcsSUFBSTtBQUNYLENBQUM7QUFFRCxLQUFLc0IsUUFBUSxHQUFHLE1BQU0sR0FBRyxRQUFRO0FBRWpDLEtBQUtDLFVBQVUsR0FBRztFQUFFQyxJQUFJLEVBQUUsU0FBUztBQUFDLENBQUMsR0FBRztFQUFFQSxJQUFJLEVBQUUsTUFBTTtFQUFFQyxJQUFJLEVBQUVyQixRQUFRO0FBQUMsQ0FBQztBQUV4RSxTQUFTc0Isa0JBQWtCQSxDQUFDRCxJQUFJLEVBQUVyQixRQUFRLENBQUMsRUFBRUYsUUFBUSxDQUFDO0VBQ3BELE1BQU15QixLQUFLLEdBQUdDLEtBQUssQ0FBQ0MsSUFBSSxDQUFDSixJQUFJLENBQUNFLEtBQUssQ0FBQ0csTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUMxQ0MsR0FBRyxDQUFDQyxDQUFDLEtBQUs7SUFDVEMsSUFBSSxFQUFFRCxDQUFDLENBQUNFLFFBQVE7SUFDaEJDLFVBQVUsRUFBRUgsQ0FBQyxDQUFDRyxVQUFVO0lBQ3hCQyxZQUFZLEVBQUVKLENBQUMsQ0FBQ0ksWUFBWTtJQUM1QkMsUUFBUSxFQUFFLEtBQUs7SUFDZkMsV0FBVyxFQUFFLEtBQUs7SUFDbEJDLFdBQVcsRUFBRSxLQUFLO0lBQ2xCQyxTQUFTLEVBQUVSLENBQUMsQ0FBQ1E7RUFDZixDQUFDLENBQUMsQ0FBQyxDQUNGQyxJQUFJLENBQUMsQ0FBQ0MsQ0FBQyxFQUFFQyxDQUFDLEtBQUtELENBQUMsQ0FBQ1QsSUFBSSxDQUFDVyxhQUFhLENBQUNELENBQUMsQ0FBQ1YsSUFBSSxDQUFDLENBQUM7RUFFL0MsTUFBTVksS0FBSyxHQUFHLElBQUlDLEdBQUcsQ0FBQyxNQUFNLEVBQUVwRCxtQkFBbUIsRUFBRSxDQUFDLENBQUMsQ0FBQztFQUN0RCxLQUFLLE1BQU1zQyxDQUFDLElBQUlQLElBQUksQ0FBQ0UsS0FBSyxDQUFDRyxNQUFNLENBQUMsQ0FBQyxFQUFFO0lBQ25DZSxLQUFLLENBQUNFLEdBQUcsQ0FBQ2YsQ0FBQyxDQUFDRSxRQUFRLEVBQUVGLENBQUMsQ0FBQ2EsS0FBSyxDQUFDO0VBQ2hDO0VBRUEsT0FBTztJQUNMRyxLQUFLLEVBQUU7TUFDTEMsVUFBVSxFQUFFeEIsSUFBSSxDQUFDdUIsS0FBSyxDQUFDRSxZQUFZO01BQ25DZixVQUFVLEVBQUVWLElBQUksQ0FBQ3VCLEtBQUssQ0FBQ2IsVUFBVTtNQUNqQ0MsWUFBWSxFQUFFWCxJQUFJLENBQUN1QixLQUFLLENBQUNaO0lBQzNCLENBQUM7SUFDRFQsS0FBSztJQUNMa0IsS0FBSztJQUNMTSxPQUFPLEVBQUU7RUFDWCxDQUFDO0FBQ0g7QUFFQSxPQUFPLFNBQUFDLFdBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBb0I7SUFBQXRDLFFBQUE7SUFBQUM7RUFBQSxJQUFBbUMsRUFBMkI7RUFDcEQsTUFBQUcsV0FBQSxHQUFvQnJELFdBQVcsQ0FBQyxDQUFDO0VBQ2pDLE1BQUFzRCxTQUFBLEdBQWtCcEQsWUFBWSxDQUFDWSxRQUFRLENBQUM7RUFFeEMsT0FBQXlDLFFBQUEsRUFBQUMsV0FBQSxJQUFnQzVELFFBQVEsQ0FBVyxNQUFNLENBQUM7RUFDMUQsT0FBQTZELGFBQUEsRUFBQUMsZ0JBQUEsSUFBMEM5RCxRQUFRLENBQVMsQ0FBQyxDQUFDO0VBQzdELE9BQUErRCxXQUFBLEVBQUFDLGNBQUEsSUFBc0NoRSxRQUFRLENBQVMsQ0FBQyxDQUFDO0VBQUEsSUFBQWlFLEVBQUE7RUFBQSxJQUFBVixDQUFBLFFBQUFXLE1BQUEsQ0FBQUMsR0FBQTtJQUlyREYsRUFBQTtNQUFBeEMsSUFBQSxFQUFRO0lBQVUsQ0FBQztJQUFBOEIsQ0FBQSxNQUFBVSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBVixDQUFBO0VBQUE7RUFBQSxJQUFBYSxFQUFBO0VBQUEsSUFBQWIsQ0FBQSxRQUFBRyxTQUFBO0lBRGZVLEVBQUEsSUFDSkgsRUFBbUIsS0FDaEJQLFNBQVMsQ0FBQTFCLEdBQUksQ0FBQ3FDLEtBQThDLENBQUMsQ0FDakU7SUFBQWQsQ0FBQSxNQUFBRyxTQUFBO0lBQUFILENBQUEsTUFBQWEsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWIsQ0FBQTtFQUFBO0VBSkgsTUFBQWUsT0FBQSxHQUNRRixFQUdMO0VBSUgsTUFBQUcsYUFBQSxHQUFzQkQsT0FBTyxDQUFDUCxXQUFXLENBQUM7RUFDMUMsTUFBQVMsV0FBQSxHQUFvQkQsYUFBYSxFQUFBOUMsSUFBTSxLQUFLLE1BQWtDLEdBQXpCOEMsYUFBYSxDQUFBN0MsSUFBWSxHQUExRCxJQUEwRDtFQUFBLElBQUErQyxFQUFBO0VBQUEsSUFBQWxCLENBQUEsUUFBQWlCLFdBQUEsSUFBQWpCLENBQUEsUUFBQUUsV0FBQTtJQUdyRWdCLEVBQUEsR0FBQUQsV0FBVyxHQUFHN0Msa0JBQWtCLENBQUM2QyxXQUF5QixDQUFDLEdBQTNEZixXQUEyRDtJQUFBRixDQUFBLE1BQUFpQixXQUFBO0lBQUFqQixDQUFBLE1BQUFFLFdBQUE7SUFBQUYsQ0FBQSxNQUFBa0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWxCLENBQUE7RUFBQTtFQURwRSxNQUFBbUIsUUFBQSxHQUNFRCxFQUFrRTtFQUdwRSxNQUFBRSxZQUFBLEdBQXFCRCxRQUFRLENBQUE5QyxLQUFNLENBQUNpQyxhQUFhLENBQUM7RUFBQSxJQUFBZSxFQUFBO0VBQUEsSUFBQXJCLENBQUEsUUFBQW1CLFFBQUEsQ0FBQTVCLEtBQUEsSUFBQVMsQ0FBQSxRQUFBb0IsWUFBQTtJQUV6Q0MsRUFBQSxHQUFBRCxZQUFZLEdBQUdELFFBQVEsQ0FBQTVCLEtBQU0sQ0FBQStCLEdBQUksQ0FBQ0YsWUFBWSxDQUFBekMsSUFBVyxDQUFDLElBQTNDLEVBQWdELEdBQS9ELEVBQStEO0lBQUFxQixDQUFBLE1BQUFtQixRQUFBLENBQUE1QixLQUFBO0lBQUFTLENBQUEsTUFBQW9CLFlBQUE7SUFBQXBCLENBQUEsTUFBQXFCLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFyQixDQUFBO0VBQUE7RUFEeEUsTUFBQXVCLGFBQUEsR0FDRUYsRUFBc0U7RUFDdEMsSUFBQUcsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBekIsQ0FBQSxRQUFBUSxXQUFBLElBQUFSLENBQUEsU0FBQWUsT0FBQSxDQUFBVyxNQUFBO0lBR3hCRixFQUFBLEdBQUFBLENBQUE7TUFDUixJQUFJaEIsV0FBVyxJQUFJTyxPQUFPLENBQUFXLE1BQU87UUFDL0JqQixjQUFjLENBQUNrQixJQUFJLENBQUFDLEdBQUksQ0FBQyxDQUFDLEVBQUViLE9BQU8sQ0FBQVcsTUFBTyxHQUFHLENBQUMsQ0FBQyxDQUFDO01BQUE7SUFDaEQsQ0FDRjtJQUFFRCxFQUFBLElBQUNWLE9BQU8sQ0FBQVcsTUFBTyxFQUFFbEIsV0FBVyxDQUFDO0lBQUFSLENBQUEsTUFBQVEsV0FBQTtJQUFBUixDQUFBLE9BQUFlLE9BQUEsQ0FBQVcsTUFBQTtJQUFBMUIsQ0FBQSxPQUFBd0IsRUFBQTtJQUFBeEIsQ0FBQSxPQUFBeUIsRUFBQTtFQUFBO0lBQUFELEVBQUEsR0FBQXhCLENBQUE7SUFBQXlCLEVBQUEsR0FBQXpCLENBQUE7RUFBQTtFQUpoQzFELFNBQVMsQ0FBQ2tGLEVBSVQsRUFBRUMsRUFBNkIsQ0FBQztFQUdqQyxNQUFBSSxlQUFBLEdBQXdCckYsTUFBTSxDQUFDZ0UsV0FBVyxDQUFDO0VBQUEsSUFBQXNCLEVBQUE7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQS9CLENBQUEsU0FBQVEsV0FBQTtJQUNqQ3NCLEVBQUEsR0FBQUEsQ0FBQTtNQUNSLElBQUlELGVBQWUsQ0FBQUcsT0FBUSxLQUFLeEIsV0FBVztRQUN6Q0QsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDO1FBQ25Cc0IsZUFBZSxDQUFBRyxPQUFBLEdBQVd4QixXQUFIO01BQUE7SUFDeEIsQ0FDRjtJQUFFdUIsRUFBQSxJQUFDdkIsV0FBVyxDQUFDO0lBQUFSLENBQUEsT0FBQVEsV0FBQTtJQUFBUixDQUFBLE9BQUE4QixFQUFBO0lBQUE5QixDQUFBLE9BQUErQixFQUFBO0VBQUE7SUFBQUQsRUFBQSxHQUFBOUIsQ0FBQTtJQUFBK0IsRUFBQSxHQUFBL0IsQ0FBQTtFQUFBO0VBTGhCMUQsU0FBUyxDQUFDd0YsRUFLVCxFQUFFQyxFQUFhLENBQUM7RUFJakJwRixrQkFBa0IsQ0FBQyxhQUFhLENBQUM7RUFBQSxJQUFBc0YsR0FBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBbEMsQ0FBQSxTQUFBZSxPQUFBLENBQUFXLE1BQUEsSUFBQTFCLENBQUEsU0FBQUksUUFBQTtJQWVOOEIsRUFBQSxHQUFBQSxDQUFBO01BQ3JCLElBQUk5QixRQUFRLEtBQUssUUFBUTtRQUN2QkMsV0FBVyxDQUFDLE1BQU0sQ0FBQztNQUFBO1FBQ2QsSUFBSUQsUUFBUSxLQUFLLE1BQTRCLElBQWxCVyxPQUFPLENBQUFXLE1BQU8sR0FBRyxDQUFDO1VBQ2xEakIsY0FBYyxDQUFDMEIsTUFBNkIsQ0FBQztRQUFBO01BQzlDO0lBQUEsQ0FDRjtJQUNrQkYsR0FBQSxHQUFBQSxDQUFBO01BQ2pCLElBQUk3QixRQUFRLEtBQUssTUFBNEIsSUFBbEJXLE9BQU8sQ0FBQVcsTUFBTyxHQUFHLENBQUM7UUFDM0NqQixjQUFjLENBQUMyQixNQUFBLElBQVFULElBQUksQ0FBQVUsR0FBSSxDQUFDdEIsT0FBTyxDQUFBVyxNQUFPLEdBQUcsQ0FBQyxFQUFFWSxNQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUM7TUFBQTtJQUMvRCxDQUNGO0lBQUF0QyxDQUFBLE9BQUFlLE9BQUEsQ0FBQVcsTUFBQTtJQUFBMUIsQ0FBQSxPQUFBSSxRQUFBO0lBQUFKLENBQUEsT0FBQWlDLEdBQUE7SUFBQWpDLENBQUEsT0FBQWtDLEVBQUE7RUFBQTtJQUFBRCxHQUFBLEdBQUFqQyxDQUFBO0lBQUFrQyxFQUFBLEdBQUFsQyxDQUFBO0VBQUE7RUFBQSxJQUFBdUMsR0FBQTtFQUFBLElBQUF2QyxDQUFBLFNBQUFJLFFBQUE7SUFDWW1DLEdBQUEsR0FBQUEsQ0FBQTtNQUNYLElBQUluQyxRQUFRLEtBQUssUUFBUTtRQUN2QkMsV0FBVyxDQUFDLE1BQU0sQ0FBQztNQUFBO0lBQ3BCLENBQ0Y7SUFBQUwsQ0FBQSxPQUFBSSxRQUFBO0lBQUFKLENBQUEsT0FBQXVDLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUF2QyxDQUFBO0VBQUE7RUFBQSxJQUFBd0MsR0FBQTtFQUFBLElBQUF4QyxDQUFBLFNBQUFvQixZQUFBLElBQUFwQixDQUFBLFNBQUFJLFFBQUE7SUFDbUJvQyxHQUFBLEdBQUFBLENBQUE7TUFDbEIsSUFBSXBDLFFBQVEsS0FBSyxNQUFzQixJQUFuQ2dCLFlBQW1DO1FBQ3JDZixXQUFXLENBQUMsUUFBUSxDQUFDO01BQUE7SUFDdEIsQ0FDRjtJQUFBTCxDQUFBLE9BQUFvQixZQUFBO0lBQUFwQixDQUFBLE9BQUFJLFFBQUE7SUFBQUosQ0FBQSxPQUFBd0MsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQXhDLENBQUE7RUFBQTtFQUFBLElBQUF5QyxHQUFBO0VBQUEsSUFBQXpDLENBQUEsU0FBQUksUUFBQTtJQUNvQnFDLEdBQUEsR0FBQUEsQ0FBQTtNQUNuQixJQUFJckMsUUFBUSxLQUFLLE1BQU07UUFDckJHLGdCQUFnQixDQUFDbUMsTUFBNkIsQ0FBQztNQUFBO0lBQ2hELENBQ0Y7SUFBQTFDLENBQUEsT0FBQUksUUFBQTtJQUFBSixDQUFBLE9BQUF5QyxHQUFBO0VBQUE7SUFBQUEsR0FBQSxHQUFBekMsQ0FBQTtFQUFBO0VBQUEsSUFBQTJDLEdBQUE7RUFBQSxJQUFBM0MsQ0FBQSxTQUFBbUIsUUFBQSxDQUFBOUMsS0FBQSxDQUFBcUQsTUFBQSxJQUFBMUIsQ0FBQSxTQUFBSSxRQUFBO0lBQ2dCdUMsR0FBQSxHQUFBQSxDQUFBO01BQ2YsSUFBSXZDLFFBQVEsS0FBSyxNQUFNO1FBQ3JCRyxnQkFBZ0IsQ0FBQ3FDLE1BQUEsSUFDZmpCLElBQUksQ0FBQVUsR0FBSSxDQUFDbEIsUUFBUSxDQUFBOUMsS0FBTSxDQUFBcUQsTUFBTyxHQUFHLENBQUMsRUFBRVksTUFBSSxHQUFHLENBQUMsQ0FDOUMsQ0FBQztNQUFBO0lBQ0YsQ0FDRjtJQUFBdEMsQ0FBQSxPQUFBbUIsUUFBQSxDQUFBOUMsS0FBQSxDQUFBcUQsTUFBQTtJQUFBMUIsQ0FBQSxPQUFBSSxRQUFBO0lBQUFKLENBQUEsT0FBQTJDLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUEzQyxDQUFBO0VBQUE7RUFBQSxJQUFBNkMsR0FBQTtFQUFBLElBQUE3QyxDQUFBLFNBQUFpQyxHQUFBLElBQUFqQyxDQUFBLFNBQUF1QyxHQUFBLElBQUF2QyxDQUFBLFNBQUF3QyxHQUFBLElBQUF4QyxDQUFBLFNBQUF5QyxHQUFBLElBQUF6QyxDQUFBLFNBQUEyQyxHQUFBLElBQUEzQyxDQUFBLFNBQUFrQyxFQUFBO0lBbkNIVyxHQUFBO01BQUEsdUJBRXlCWCxFQU10QjtNQUFBLG1CQUNrQkQsR0FJbEI7TUFBQSxhQUNZTSxHQUlaO01BQUEsb0JBQ21CQyxHQUluQjtNQUFBLHFCQUNvQkMsR0FJcEI7TUFBQSxpQkFDZ0JFO0lBT25CLENBQUM7SUFBQTNDLENBQUEsT0FBQWlDLEdBQUE7SUFBQWpDLENBQUEsT0FBQXVDLEdBQUE7SUFBQXZDLENBQUEsT0FBQXdDLEdBQUE7SUFBQXhDLENBQUEsT0FBQXlDLEdBQUE7SUFBQXpDLENBQUEsT0FBQTJDLEdBQUE7SUFBQTNDLENBQUEsT0FBQWtDLEVBQUE7SUFBQWxDLENBQUEsT0FBQTZDLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUE3QyxDQUFBO0VBQUE7RUFBQSxJQUFBOEMsR0FBQTtFQUFBLElBQUE5QyxDQUFBLFNBQUFXLE1BQUEsQ0FBQUMsR0FBQTtJQUNEa0MsR0FBQTtNQUFBQyxPQUFBLEVBQVc7SUFBYSxDQUFDO0lBQUEvQyxDQUFBLE9BQUE4QyxHQUFBO0VBQUE7SUFBQUEsR0FBQSxHQUFBOUMsQ0FBQTtFQUFBO0VBdEMzQjlDLGNBQWMsQ0FDWjJGLEdBb0NDLEVBQ0RDLEdBQ0YsQ0FBQztFQUFBLElBQUFFLEdBQUE7RUFBQSxJQUFBaEQsQ0FBQSxTQUFBbUIsUUFBQSxDQUFBekIsS0FBQTtJQUVnQnNELEdBQUEsR0FBQTdCLFFBQVEsQ0FBQXpCLEtBV2pCLEdBVk4sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUNYLENBQUF5QixRQUFRLENBQUF6QixLQUFNLENBQUFDLFVBQVUsQ0FBRSxDQUFFLENBQUF0QyxNQUFNLENBQUM4RCxRQUFRLENBQUF6QixLQUFNLENBQUFDLFVBQVcsRUFBRSxNQUFNLEVBQUcsSUFBRSxDQUFFLE9BRTNFLENBQUF3QixRQUFRLENBQUF6QixLQUFNLENBQUFiLFVBQVcsR0FBRyxDQUU1QixJQURDLENBQUMsSUFBSSxDQUFPLEtBQWUsQ0FBZixlQUFlLENBQUMsRUFBRyxDQUFBc0MsUUFBUSxDQUFBekIsS0FBTSxDQUFBYixVQUFVLENBQUUsRUFBeEQsSUFBSSxDQUNQLENBQ0MsQ0FBQXNDLFFBQVEsQ0FBQXpCLEtBQU0sQ0FBQVosWUFBYSxHQUFHLENBRTlCLElBREMsQ0FBQyxJQUFJLENBQU8sS0FBaUIsQ0FBakIsaUJBQWlCLENBQUMsRUFBRyxDQUFBcUMsUUFBUSxDQUFBekIsS0FBTSxDQUFBWixZQUFZLENBQUUsRUFBNUQsSUFBSSxDQUNQLENBQ0YsRUFUQyxJQUFJLENBVUMsR0FYUyxJQVdUO0lBQUFrQixDQUFBLE9BQUFtQixRQUFBLENBQUF6QixLQUFBO0lBQUFNLENBQUEsT0FBQWdELEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUFoRCxDQUFBO0VBQUE7RUFYUixNQUFBaUQsUUFBQSxHQUFpQkQsR0FXVDtFQUdSLE1BQUFFLFdBQUEsR0FBb0JqQyxXQUFXLEdBQVgsUUFDUkEsV0FBVyxDQUFBa0MsU0FBVSxFQUNSLEdBRkwscUJBRUs7RUFDekIsTUFBQUMsY0FBQSxHQUF1Qm5DLFdBQVcsR0FDOUJBLFdBQVcsQ0FBQW9DLGlCQUVQLEdBRkosSUFDTXBDLFdBQVcsQ0FBQW9DLGlCQUFrQixHQUMvQixHQUZKLEVBR2lCLEdBSkUsaUJBSUY7RUFBQSxJQUFBQyxHQUFBO0VBQUEsSUFBQXRELENBQUEsU0FBQVEsV0FBQSxJQUFBUixDQUFBLFNBQUFlLE9BQUE7SUFJbkJ1QyxHQUFBLEdBQUF2QyxPQUFPLENBQUFXLE1BQU8sR0FBRyxDQWdCVCxHQWZOLENBQUMsR0FBRyxDQUNELENBQUFsQixXQUFXLEdBQUcsQ0FBNkIsSUFBeEIsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFDLEVBQUUsRUFBaEIsSUFBSSxDQUFrQixDQUMxQyxDQUFBTyxPQUFPLENBQUF0QyxHQUFJLENBQUMsQ0FBQThFLE1BQUEsRUFBQUMsQ0FBQTtRQUNYLE1BQUFDLFVBQUEsR0FBbUJELENBQUMsS0FBS2hELFdBQVc7UUFDcEMsTUFBQWtELEtBQUEsR0FDRUgsTUFBTSxDQUFBckYsSUFBSyxLQUFLLFNBQW1ELEdBQW5FLFNBQW1FLEdBQW5FLElBQTRDcUYsTUFBTSxDQUFBcEYsSUFBSyxDQUFBZ0YsU0FBVSxFQUFFO1FBQUEsT0FFbkUsQ0FBQyxJQUFJLENBQU1LLEdBQUMsQ0FBREEsRUFBQSxDQUFDLENBQVksUUFBVyxDQUFYLEVBQUNDLFVBQVMsQ0FBQyxDQUFRQSxJQUFVLENBQVZBLFdBQVMsQ0FBQyxDQUNsRCxDQUFBRCxDQUFDLEdBQUcsQ0FBYyxHQUFsQixRQUFrQixHQUFsQixFQUFpQixDQUNqQkUsTUFBSSxDQUNQLEVBSEMsSUFBSSxDQUdFO01BQUEsQ0FFVixFQUNBLENBQUFsRCxXQUFXLEdBQUdPLE9BQU8sQ0FBQVcsTUFBTyxHQUFHLENBQTZCLElBQXhCLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyxFQUFFLEVBQWhCLElBQUksQ0FBa0IsQ0FDOUQsRUFkQyxHQUFHLENBZUUsR0FoQlIsSUFnQlE7SUFBQTFCLENBQUEsT0FBQVEsV0FBQTtJQUFBUixDQUFBLE9BQUFlLE9BQUE7SUFBQWYsQ0FBQSxPQUFBc0QsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQXRELENBQUE7RUFBQTtFQWpCVixNQUFBMkQsY0FBQSxHQUNFTCxHQWdCUTtFQUVWLE1BQUFNLGVBQUEsR0FBd0J6RyxrQkFBa0IsQ0FDeEMsY0FBYyxFQUNkLFlBQVksRUFDWixLQUNGLENBQUM7RUFBQSxJQUFBMEcsR0FBQTtFQUFBQyxHQUFBO0lBR0MsSUFBSTNDLFFBQVEsQ0FBQXRCLE9BQVE7TUFDbEJnRSxHQUFBLEdBQU8sb0JBQWU7TUFBdEIsTUFBQUMsR0FBQTtJQUFzQjtJQUV4QixJQUFJN0MsV0FBVztNQUNiNEMsR0FBQSxHQUFPLDhCQUE4QjtNQUFyQyxNQUFBQyxHQUFBO0lBQXFDO0lBR3ZDLElBQ0UzQyxRQUFRLENBQUF6QixLQUNxQixJQUE3QnlCLFFBQVEsQ0FBQXpCLEtBQU0sQ0FBQUMsVUFBVyxHQUFHLENBQ0QsSUFBM0J3QixRQUFRLENBQUE5QyxLQUFNLENBQUFxRCxNQUFPLEtBQUssQ0FBQztNQUUzQm1DLEdBQUEsR0FBTyxtQ0FBbUM7TUFBMUMsTUFBQUMsR0FBQTtJQUEwQztJQUU1Q0QsR0FBQSxHQUFPLHVCQUF1QjtFQUFBO0VBZmhDLE1BQUFFLFlBQUEsR0FBcUJGLEdBZ0JqQjtFQUFBLElBQUFHLEdBQUE7RUFBQSxJQUFBaEUsQ0FBQSxTQUFBb0QsY0FBQTtJQU1DWSxHQUFBLEdBQUFaLGNBQXlELElBQXZDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyxDQUFFQSxlQUFhLENBQUUsRUFBL0IsSUFBSSxDQUFrQztJQUFBcEQsQ0FBQSxPQUFBb0QsY0FBQTtJQUFBcEQsQ0FBQSxPQUFBZ0UsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQWhFLENBQUE7RUFBQTtFQUFBLElBQUFpRSxHQUFBO0VBQUEsSUFBQWpFLENBQUEsU0FBQWtELFdBQUEsSUFBQWxELENBQUEsU0FBQWdFLEdBQUE7SUFGNURDLEdBQUEsSUFBQyxJQUFJLENBQ0ZmLFlBQVUsQ0FDVixDQUFBYyxHQUF3RCxDQUMzRCxFQUhDLElBQUksQ0FHRTtJQUFBaEUsQ0FBQSxPQUFBa0QsV0FBQTtJQUFBbEQsQ0FBQSxPQUFBZ0UsR0FBQTtJQUFBaEUsQ0FBQSxPQUFBaUUsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQWpFLENBQUE7RUFBQTtFQUpULE1BQUFrRSxLQUFBLEdBQ0VELEdBR087RUFDUixJQUFBRSxHQUFBO0VBQUEsSUFBQW5FLENBQUEsU0FBQXBDLE1BQUEsSUFBQW9DLENBQUEsU0FBQUksUUFBQTtJQUdEK0QsR0FBQSxZQUFBQyxhQUFBO01BQ0UsSUFBSWhFLFFBQVEsS0FBSyxRQUFRO1FBQ3ZCQyxXQUFXLENBQUMsTUFBTSxDQUFDO01BQUE7UUFFbkJ6QyxNQUFNLENBQUMsdUJBQXVCLEVBQUU7VUFBQUcsT0FBQSxFQUFXO1FBQVMsQ0FBQyxDQUFDO01BQUE7SUFDdkQsQ0FDRjtJQUFBaUMsQ0FBQSxPQUFBcEMsTUFBQTtJQUFBb0MsQ0FBQSxPQUFBSSxRQUFBO0lBQUFKLENBQUEsT0FBQW1FLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUFuRSxDQUFBO0VBQUE7RUFORCxNQUFBb0UsWUFBQSxHQUFBRCxHQU1DO0VBQUEsSUFBQUUsR0FBQTtFQUFBLElBQUFyRSxDQUFBLFNBQUE0RCxlQUFBLElBQUE1RCxDQUFBLFNBQUFlLE9BQUEsQ0FBQVcsTUFBQSxJQUFBMUIsQ0FBQSxTQUFBSSxRQUFBO0lBT2VpRSxHQUFBLEdBQUFDLFNBQUEsSUFDVkEsU0FBUyxDQUFBQyxPQWNSLEdBYkMsQ0FBQyxJQUFJLENBQUMsTUFBTyxDQUFBRCxTQUFTLENBQUFFLE9BQU8sQ0FBRSxjQUFjLEVBQTVDLElBQUksQ0FhTixHQVpHcEUsUUFBUSxLQUFLLE1BWWhCLEdBWEMsQ0FBQyxNQUFNLENBQ0osQ0FBQVcsT0FBTyxDQUFBVyxNQUFPLEdBQUcsQ0FBNEIsSUFBdkIsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFmLElBQUksQ0FBaUIsQ0FDN0MsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFmLElBQUksQ0FDTCxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQWYsSUFBSSxDQUNMLENBQUMsSUFBSSxDQUFFa0MsZ0JBQWMsQ0FBRSxNQUFNLEVBQTVCLElBQUksQ0FDUCxFQUxDLE1BQU0sQ0FXUixHQUpDLENBQUMsTUFBTSxDQUNMLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBWCxJQUFJLENBQ0wsQ0FBQyxJQUFJLENBQUVBLGdCQUFjLENBQUUsTUFBTSxFQUE1QixJQUFJLENBQ1AsRUFIQyxNQUFNLENBSVI7SUFBQTVELENBQUEsT0FBQTRELGVBQUE7SUFBQTVELENBQUEsT0FBQWUsT0FBQSxDQUFBVyxNQUFBO0lBQUExQixDQUFBLE9BQUFJLFFBQUE7SUFBQUosQ0FBQSxPQUFBcUUsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQXJFLENBQUE7RUFBQTtFQUFBLElBQUF5RSxHQUFBO0VBQUEsSUFBQXpFLENBQUEsU0FBQW1CLFFBQUEsQ0FBQTlDLEtBQUEsSUFBQTJCLENBQUEsU0FBQStELFlBQUEsSUFBQS9ELENBQUEsU0FBQW9CLFlBQUEsRUFBQXJDLFFBQUEsSUFBQWlCLENBQUEsU0FBQW9CLFlBQUEsRUFBQXBDLFdBQUEsSUFBQWdCLENBQUEsU0FBQW9CLFlBQUEsRUFBQW5DLFdBQUEsSUFBQWUsQ0FBQSxTQUFBb0IsWUFBQSxFQUFBc0QsV0FBQSxJQUFBMUUsQ0FBQSxTQUFBb0IsWUFBQSxFQUFBekMsSUFBQSxJQUFBcUIsQ0FBQSxTQUFBdUIsYUFBQSxJQUFBdkIsQ0FBQSxTQUFBTSxhQUFBLElBQUFOLENBQUEsU0FBQUksUUFBQTtJQUtGcUUsR0FBQSxHQUFBdEQsUUFBUSxDQUFBOUMsS0FBTSxDQUFBcUQsTUFBTyxLQUFLLENBbUIxQixHQWxCQyxDQUFDLEdBQUcsQ0FBWSxTQUFDLENBQUQsR0FBQyxDQUNmLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBRXFDLGFBQVcsQ0FBRSxFQUE1QixJQUFJLENBQ1AsRUFGQyxHQUFHLENBa0JMLEdBZkczRCxRQUFRLEtBQUssTUFlaEIsR0FkQyxDQUFDLEdBQUcsQ0FBZSxhQUFRLENBQVIsUUFBUSxDQUFZLFNBQUMsQ0FBRCxHQUFDLENBQ3RDLENBQUMsWUFBWSxDQUFRLEtBQWMsQ0FBZCxDQUFBZSxRQUFRLENBQUE5QyxLQUFLLENBQUMsQ0FBaUJpQyxhQUFhLENBQWJBLGNBQVksQ0FBQyxHQUNuRSxFQUZDLEdBQUcsQ0FjTCxHQVZDLENBQUMsR0FBRyxDQUFlLGFBQVEsQ0FBUixRQUFRLENBQVksU0FBQyxDQUFELEdBQUMsQ0FDdEMsQ0FBQyxjQUFjLENBQ0gsUUFBd0IsQ0FBeEIsQ0FBQWMsWUFBWSxFQUFBekMsSUFBWSxJQUF4QixFQUF1QixDQUFDLENBQzNCNEMsS0FBYSxDQUFiQSxjQUFZLENBQUMsQ0FDUCxXQUF5QixDQUF6QixDQUFBSCxZQUFZLEVBQUFwQyxXQUFZLENBQUMsQ0FDNUIsUUFBc0IsQ0FBdEIsQ0FBQW9DLFlBQVksRUFBQXJDLFFBQVMsQ0FBQyxDQUNuQixXQUF5QixDQUF6QixDQUFBcUMsWUFBWSxFQUFBbkMsV0FBWSxDQUFDLENBQ3pCLFdBQXlCLENBQXpCLENBQUFtQyxZQUFZLEVBQUFzRCxXQUFZLENBQUMsR0FFMUMsRUFUQyxHQUFHLENBVUw7SUFBQTFFLENBQUEsT0FBQW1CLFFBQUEsQ0FBQTlDLEtBQUE7SUFBQTJCLENBQUEsT0FBQStELFlBQUE7SUFBQS9ELENBQUEsT0FBQW9CLFlBQUEsRUFBQXJDLFFBQUE7SUFBQWlCLENBQUEsT0FBQW9CLFlBQUEsRUFBQXBDLFdBQUE7SUFBQWdCLENBQUEsT0FBQW9CLFlBQUEsRUFBQW5DLFdBQUE7SUFBQWUsQ0FBQSxPQUFBb0IsWUFBQSxFQUFBc0QsV0FBQTtJQUFBMUUsQ0FBQSxPQUFBb0IsWUFBQSxFQUFBekMsSUFBQTtJQUFBcUIsQ0FBQSxPQUFBdUIsYUFBQTtJQUFBdkIsQ0FBQSxPQUFBTSxhQUFBO0lBQUFOLENBQUEsT0FBQUksUUFBQTtJQUFBSixDQUFBLE9BQUF5RSxHQUFBO0VBQUE7SUFBQUEsR0FBQSxHQUFBekUsQ0FBQTtFQUFBO0VBQUEsSUFBQTJFLEdBQUE7RUFBQSxJQUFBM0UsQ0FBQSxTQUFBb0UsWUFBQSxJQUFBcEUsQ0FBQSxTQUFBMkQsY0FBQSxJQUFBM0QsQ0FBQSxTQUFBaUQsUUFBQSxJQUFBakQsQ0FBQSxTQUFBcUUsR0FBQSxJQUFBckUsQ0FBQSxTQUFBeUUsR0FBQSxJQUFBekUsQ0FBQSxTQUFBa0UsS0FBQTtJQTNDSFMsR0FBQSxJQUFDLE1BQU0sQ0FDRVQsS0FBSyxDQUFMQSxNQUFJLENBQUMsQ0FDRkUsUUFBWSxDQUFaQSxhQUFXLENBQUMsQ0FDaEIsS0FBWSxDQUFaLFlBQVksQ0FDTixVQWVULENBZlMsQ0FBQUMsR0FlVixDQUFDLENBR0ZWLGVBQWEsQ0FDYlYsU0FBTyxDQUNQLENBQUF3QixHQW1CRCxDQUNGLEVBNUNDLE1BQU0sQ0E0Q0U7SUFBQXpFLENBQUEsT0FBQW9FLFlBQUE7SUFBQXBFLENBQUEsT0FBQTJELGNBQUE7SUFBQTNELENBQUEsT0FBQWlELFFBQUE7SUFBQWpELENBQUEsT0FBQXFFLEdBQUE7SUFBQXJFLENBQUEsT0FBQXlFLEdBQUE7SUFBQXpFLENBQUEsT0FBQWtFLEtBQUE7SUFBQWxFLENBQUEsT0FBQTJFLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUEzRSxDQUFBO0VBQUE7RUFBQSxPQTVDVDJFLEdBNENTO0FBQUE7QUFwT04sU0FBQWpDLE9BQUFrQyxNQUFBO0VBQUEsT0FxRjRCakQsSUFBSSxDQUFBQyxHQUFJLENBQUMsQ0FBQyxFQUFFVSxNQUFJLEdBQUcsQ0FBQyxDQUFDO0FBQUE7QUFyRmpELFNBQUFILE9BQUFHLElBQUE7RUFBQSxPQWlFMEJYLElBQUksQ0FBQUMsR0FBSSxDQUFDLENBQUMsRUFBRVUsSUFBSSxHQUFHLENBQUMsQ0FBQztBQUFBO0FBakUvQyxTQUFBeEIsTUFBQTNDLElBQUE7RUFBQSxPQVd1QztJQUFBRCxJQUFBLEVBQVEsTUFBTTtJQUFBQztFQUFPLENBQUM7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==