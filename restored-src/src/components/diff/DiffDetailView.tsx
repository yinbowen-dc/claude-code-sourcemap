/**
 * DiffDetailView.tsx — 单文件差异内容详情展示组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具响应层 → 差异展示 → 单文件详情视图（DiffDialog 的内容区）
 *
 * 主要功能：
 *   1. DiffDetailView：React 组件，渲染单个文件的完整差异内容。
 *      根据文件状态分 4 种渲染路径：
 *      - isUntracked：新未追踪文件，显示提示运行 git add 的说明
 *      - isBinary：二进制文件，显示"无法展示 diff"提示
 *      - isLargeFile：超大文件（>1MB），显示超限提示
 *      - 正常文件：使用 StructuredDiff 逐块（hunk）渲染，支持字级别 diff 和语法高亮
 *
 * 核心技术：
 *   - StructuredDiff：字级别差异渲染 + 语法高亮（需要 filePath 和 fileContent）
 *   - readFileSafe：同步读取文件内容，用于语法检测和多行结构处理
 *   - useTerminalSize：获取终端列宽，用于计算 diff 宽度（减去边框和内边距共 4 列）
 *   - 最多渲染 400 行（解析器限制），超出时显示截断提示
 *
 * React Compiler 缓存槽分配（_c(53)）：
 *   $[0]：filePath 为空时的静态返回值（sentinel 缓存）
 *   $[1]-$[6]：以 filePath 为依赖的文件内容读取结果（content、firstLine、fileContent）
 *   $[7]-$[52]：四条渲染路径及最终 JSX 的各层缓存
 */
import { c as _c } from "react/compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import { resolve } from 'path';
import React, { useMemo } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { getCwd } from '../../utils/cwd.js';
import { readFileSafe } from '../../utils/file.js';
import { Divider } from '../design-system/Divider.js';
import { StructuredDiff } from '../StructuredDiff.js';

// Props 类型：filePath 文件路径，hunks 差异块数组，及各文件状态标志
type Props = {
  filePath: string;
  hunks: StructuredPatchHunk[];
  isLargeFile?: boolean;
  isBinary?: boolean;
  isTruncated?: boolean;
  isUntracked?: boolean;
};

/**
 * DiffDetailView 组件
 *
 * 整体流程：
 *   1. 解构所有 Props（filePath、hunks 及状态标志）
 *   2. 获取终端列宽（columns），用于计算 diff 渲染宽度
 *   3. 通过 useMemo 读取文件内容（等效）：
 *      - filePath 为空 → 返回 { firstLine: null, fileContent: undefined }（sentinel 缓存）
 *      - filePath 有值 → resolve 绝对路径，readFileSafe 读取内容，提取首行和完整内容
 *      缓存于 $[0]-$[6]
 *   4. isUntracked 分支：渲染文件名 + "(untracked)" + git add 提示
 *   5. isBinary 分支：渲染文件名 + "Binary file - cannot display diff"
 *   6. isLargeFile 分支：渲染文件名 + "Large file - diff exceeds 1 MB limit"
 *   7. 正常分支：渲染文件名（可选 "(truncated)" 标记）+ Divider +
 *      hunks 的 StructuredDiff 组件列表（或"No diff content"）+
 *      可选截断提示文本
 *
 * 在系统中的角色：
 *   作为 DiffDialog 中的详情内容区，提供单文件的完整可读差异展示。
 */
export function DiffDetailView(t0) {
  // _c(53)：初始化 53 个 React Compiler 记忆缓存槽
  const $ = _c(53);
  const {
    filePath,
    hunks,
    isLargeFile,
    isBinary,
    isTruncated,
    isUntracked
  } = t0;

  // 获取终端宽度，用于计算 StructuredDiff 的可用列数
  const {
    columns
  } = useTerminalSize();

  let t1;
  // bb0 标签块：等效于 useMemo，以 filePath 为依赖读取文件内容
  bb0: {
    if (!filePath) {
      // filePath 为空：返回空值对象（sentinel 缓存，只创建一次）
      let t2;
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t2 = {
          firstLine: null,
          fileContent: undefined
        };
        $[0] = t2;
      } else {
        t2 = $[0];
      }
      t1 = t2;
      break bb0;
    }

    // filePath 有值：读取文件内容（以 filePath 为依赖缓存）
    let content;
    let t2;
    if ($[1] !== filePath) {
      // filePath 变化：重新解析绝对路径并读取文件
      const fullPath = resolve(getCwd(), filePath);
      content = readFileSafe(fullPath);
      // 提取首行（用于语法检测），文件不存在时返回 null
      t2 = content?.split("\n")[0] ?? null;
      $[1] = filePath;   // 存储依赖
      $[2] = content;    // 存储文件内容
      $[3] = t2;         // 存储首行
    } else {
      // filePath 未变：复用缓存的内容和首行
      content = $[2];
      t2 = $[3];
    }

    // 将 null content 转换为 undefined（类型兼容）
    const t3 = content ?? undefined;
    let t4;
    // 以 firstLine 和 fileContent 为双重依赖缓存返回对象
    if ($[4] !== t2 || $[5] !== t3) {
      t4 = {
        firstLine: t2,
        fileContent: t3
      };
      $[4] = t2;   // 存储 firstLine 依赖
      $[5] = t3;   // 存储 fileContent 依赖
      $[6] = t4;   // 存储结果对象
    } else {
      t4 = $[6];
    }
    t1 = t4;
  }

  // 解构文件内容相关值
  const {
    firstLine,
    fileContent
  } = t1;

  // 分支 1：未追踪文件（新文件尚未 git add）
  if (isUntracked) {
    let t2;
    // $[7]-$[8] 槽：以 filePath 为依赖缓存文件名标题
    if ($[7] !== filePath) {
      t2 = <Text bold={true}>{filePath}</Text>;
      $[7] = filePath;
      $[8] = t2;
    } else {
      t2 = $[8];
    }
    let t3;
    // $[9] 槽：静态 "(untracked)" 标签，sentinel 缓存
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Text dimColor={true}> (untracked)</Text>;
      $[9] = t3;
    } else {
      t3 = $[9];
    }
    let t4;
    // $[10]-$[11] 槽：以 t2（文件名）为依赖缓存标题行 Box
    if ($[10] !== t2) {
      t4 = <Box>{t2}{t3}</Box>;
      $[10] = t2;
      $[11] = t4;
    } else {
      t4 = $[11];
    }
    let t5;
    // $[12] 槽：静态 Divider，sentinel 缓存
    if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <Divider padding={4} />;
      $[12] = t5;
    } else {
      t5 = $[12];
    }
    let t6;
    // $[13] 槽：静态"New file not yet staged"文本，sentinel 缓存
    if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
      t6 = <Text dimColor={true} italic={true}>New file not yet staged.</Text>;
      $[13] = t6;
    } else {
      t6 = $[13];
    }
    let t7;
    // $[14]-$[15] 槽：以 filePath 为依赖缓存 git add 提示文本
    if ($[14] !== filePath) {
      t7 = <Box flexDirection="column">{t6}<Text dimColor={true} italic={true}>Run `git add {filePath}` to see line counts.</Text></Box>;
      $[14] = filePath;
      $[15] = t7;
    } else {
      t7 = $[15];
    }
    let t8;
    // $[16]-$[18] 槽：以 t4（标题行）和 t7（提示文本）为依赖缓存完整布局
    if ($[16] !== t4 || $[17] !== t7) {
      t8 = <Box flexDirection="column" width="100%">{t4}{t5}{t7}</Box>;
      $[16] = t4;
      $[17] = t7;
      $[18] = t8;
    } else {
      t8 = $[18];
    }
    return t8;
  }

  // 分支 2：二进制文件（无法展示文本 diff）
  if (isBinary) {
    let t2;
    // $[19]-$[20] 槽：以 filePath 为依赖缓存文件名标题行
    if ($[19] !== filePath) {
      t2 = <Box><Text bold={true}>{filePath}</Text></Box>;
      $[19] = filePath;
      $[20] = t2;
    } else {
      t2 = $[20];
    }
    let t3;
    // $[21] 槽：静态 Divider，sentinel 缓存
    if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Divider padding={4} />;
      $[21] = t3;
    } else {
      t3 = $[21];
    }
    let t4;
    // $[22] 槽：静态二进制文件提示，sentinel 缓存
    if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Box flexDirection="column"><Text dimColor={true} italic={true}>Binary file - cannot display diff</Text></Box>;
      $[22] = t4;
    } else {
      t4 = $[22];
    }
    let t5;
    // $[23]-$[24] 槽：以 t2（标题行）为依赖缓存完整布局
    if ($[23] !== t2) {
      t5 = <Box flexDirection="column" width="100%">{t2}{t3}{t4}</Box>;
      $[23] = t2;
      $[24] = t5;
    } else {
      t5 = $[24];
    }
    return t5;
  }

  // 分支 3：超大文件（diff 超过 1MB 限制）
  if (isLargeFile) {
    let t2;
    // $[25]-$[26] 槽：以 filePath 为依赖缓存文件名标题行
    if ($[25] !== filePath) {
      t2 = <Box><Text bold={true}>{filePath}</Text></Box>;
      $[25] = filePath;
      $[26] = t2;
    } else {
      t2 = $[26];
    }
    let t3;
    // $[27] 槽：静态 Divider，sentinel 缓存
    if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Divider padding={4} />;
      $[27] = t3;
    } else {
      t3 = $[27];
    }
    let t4;
    // $[28] 槽：静态大文件提示，sentinel 缓存
    if ($[28] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Box flexDirection="column"><Text dimColor={true} italic={true}>Large file - diff exceeds 1 MB limit</Text></Box>;
      $[28] = t4;
    } else {
      t4 = $[28];
    }
    let t5;
    // $[29]-$[30] 槽：以 t2（标题行）为依赖缓存完整布局
    if ($[29] !== t2) {
      t5 = <Box flexDirection="column" width="100%">{t2}{t3}{t4}</Box>;
      $[29] = t2;
      $[30] = t5;
    } else {
      t5 = $[30];
    }
    return t5;
  }

  // 分支 4：正常文件 diff 渲染
  let t2;
  // $[31]-$[32] 槽：以 filePath 为依赖缓存文件名加粗文本
  if ($[31] !== filePath) {
    t2 = <Text bold={true}>{filePath}</Text>;
    $[31] = filePath;
    $[32] = t2;
  } else {
    t2 = $[32];
  }
  let t3;
  // $[33]-$[34] 槽：以 isTruncated 为依赖缓存截断标记文本（条件渲染）
  if ($[33] !== isTruncated) {
    t3 = isTruncated && <Text dimColor={true}> (truncated)</Text>;
    $[33] = isTruncated;
    $[34] = t3;
  } else {
    t3 = $[34];
  }
  let t4;
  // $[35]-$[37] 槽：以 t2（文件名）和 t3（截断标记）为依赖缓存标题行 Box
  if ($[35] !== t2 || $[36] !== t3) {
    t4 = <Box>{t2}{t3}</Box>;
    $[35] = t2;
    $[36] = t3;
    $[37] = t4;
  } else {
    t4 = $[37];
  }
  let t5;
  // $[38] 槽：静态 Divider，sentinel 缓存
  if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Divider padding={4} />;
    $[38] = t5;
  } else {
    t5 = $[38];
  }
  let t6;
  // $[39]-$[44] 槽：以 columns、fileContent、filePath、firstLine、hunks 为五重依赖缓存 diff 块
  if ($[39] !== columns || $[40] !== fileContent || $[41] !== filePath || $[42] !== firstLine || $[43] !== hunks) {
    // 无 hunk 时显示"No diff content"；有 hunk 时逐块渲染 StructuredDiff
    // 宽度 = 终端列数 - 外边距 2 - 边框 2 = columns - 4
    t6 = hunks.length === 0 ? <Text dimColor={true}>No diff content</Text> : hunks.map((hunk, index) => <StructuredDiff key={index} patch={hunk} filePath={filePath} firstLine={firstLine} fileContent={fileContent} dim={false} width={columns - 2 - 2} />);
    $[39] = columns;       // 存储 columns 依赖
    $[40] = fileContent;   // 存储 fileContent 依赖
    $[41] = filePath;      // 存储 filePath 依赖
    $[42] = firstLine;     // 存储 firstLine 依赖
    $[43] = hunks;         // 存储 hunks 依赖
    $[44] = t6;            // 存储 diff 块结果
  } else {
    // 所有依赖均未变：复用缓存的 diff 块
    t6 = $[44];
  }
  let t7;
  // $[45]-$[46] 槽：以 t6（diff 块）为依赖缓存 diff 块容器
  if ($[45] !== t6) {
    t7 = <Box flexDirection="column">{t6}</Box>;
    $[45] = t6;
    $[46] = t7;
  } else {
    t7 = $[46];
  }
  let t8;
  // $[47]-$[48] 槽：以 isTruncated 为依赖缓存截断提示文本（条件渲染）
  if ($[47] !== isTruncated) {
    t8 = isTruncated && <Text dimColor={true} italic={true}>… diff truncated (exceeded 400 line limit)</Text>;
    $[47] = isTruncated;
    $[48] = t8;
  } else {
    t8 = $[48];
  }
  let t9;
  // $[49]-$[52] 槽：以 t4（标题行）、t7（diff 块）、t8（截断提示）为依赖缓存完整布局
  if ($[49] !== t4 || $[50] !== t7 || $[51] !== t8) {
    t9 = <Box flexDirection="column" width="100%">{t4}{t5}{t7}{t8}</Box>;
    $[49] = t4;   // 存储标题行依赖
    $[50] = t7;   // 存储 diff 块依赖
    $[51] = t8;   // 存储截断提示依赖
    $[52] = t9;   // 存储完整布局
  } else {
    // 均未变：复用缓存的完整布局
    t9 = $[52];
  }
  return t9;
}
  const $ = _c(53);
  const {
    filePath,
    hunks,
    isLargeFile,
    isBinary,
    isTruncated,
    isUntracked
  } = t0;
  const {
    columns
  } = useTerminalSize();
  let t1;
  bb0: {
    if (!filePath) {
      let t2;
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t2 = {
          firstLine: null,
          fileContent: undefined
        };
        $[0] = t2;
      } else {
        t2 = $[0];
      }
      t1 = t2;
      break bb0;
    }
    let content;
    let t2;
    if ($[1] !== filePath) {
      const fullPath = resolve(getCwd(), filePath);
      content = readFileSafe(fullPath);
      t2 = content?.split("\n")[0] ?? null;
      $[1] = filePath;
      $[2] = content;
      $[3] = t2;
    } else {
      content = $[2];
      t2 = $[3];
    }
    const t3 = content ?? undefined;
    let t4;
    if ($[4] !== t2 || $[5] !== t3) {
      t4 = {
        firstLine: t2,
        fileContent: t3
      };
      $[4] = t2;
      $[5] = t3;
      $[6] = t4;
    } else {
      t4 = $[6];
    }
    t1 = t4;
  }
  const {
    firstLine,
    fileContent
  } = t1;
  if (isUntracked) {
    let t2;
    if ($[7] !== filePath) {
      t2 = <Text bold={true}>{filePath}</Text>;
      $[7] = filePath;
      $[8] = t2;
    } else {
      t2 = $[8];
    }
    let t3;
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Text dimColor={true}> (untracked)</Text>;
      $[9] = t3;
    } else {
      t3 = $[9];
    }
    let t4;
    if ($[10] !== t2) {
      t4 = <Box>{t2}{t3}</Box>;
      $[10] = t2;
      $[11] = t4;
    } else {
      t4 = $[11];
    }
    let t5;
    if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <Divider padding={4} />;
      $[12] = t5;
    } else {
      t5 = $[12];
    }
    let t6;
    if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
      t6 = <Text dimColor={true} italic={true}>New file not yet staged.</Text>;
      $[13] = t6;
    } else {
      t6 = $[13];
    }
    let t7;
    if ($[14] !== filePath) {
      t7 = <Box flexDirection="column">{t6}<Text dimColor={true} italic={true}>Run `git add {filePath}` to see line counts.</Text></Box>;
      $[14] = filePath;
      $[15] = t7;
    } else {
      t7 = $[15];
    }
    let t8;
    if ($[16] !== t4 || $[17] !== t7) {
      t8 = <Box flexDirection="column" width="100%">{t4}{t5}{t7}</Box>;
      $[16] = t4;
      $[17] = t7;
      $[18] = t8;
    } else {
      t8 = $[18];
    }
    return t8;
  }
  if (isBinary) {
    let t2;
    if ($[19] !== filePath) {
      t2 = <Box><Text bold={true}>{filePath}</Text></Box>;
      $[19] = filePath;
      $[20] = t2;
    } else {
      t2 = $[20];
    }
    let t3;
    if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Divider padding={4} />;
      $[21] = t3;
    } else {
      t3 = $[21];
    }
    let t4;
    if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Box flexDirection="column"><Text dimColor={true} italic={true}>Binary file - cannot display diff</Text></Box>;
      $[22] = t4;
    } else {
      t4 = $[22];
    }
    let t5;
    if ($[23] !== t2) {
      t5 = <Box flexDirection="column" width="100%">{t2}{t3}{t4}</Box>;
      $[23] = t2;
      $[24] = t5;
    } else {
      t5 = $[24];
    }
    return t5;
  }
  if (isLargeFile) {
    let t2;
    if ($[25] !== filePath) {
      t2 = <Box><Text bold={true}>{filePath}</Text></Box>;
      $[25] = filePath;
      $[26] = t2;
    } else {
      t2 = $[26];
    }
    let t3;
    if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <Divider padding={4} />;
      $[27] = t3;
    } else {
      t3 = $[27];
    }
    let t4;
    if ($[28] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Box flexDirection="column"><Text dimColor={true} italic={true}>Large file - diff exceeds 1 MB limit</Text></Box>;
      $[28] = t4;
    } else {
      t4 = $[28];
    }
    let t5;
    if ($[29] !== t2) {
      t5 = <Box flexDirection="column" width="100%">{t2}{t3}{t4}</Box>;
      $[29] = t2;
      $[30] = t5;
    } else {
      t5 = $[30];
    }
    return t5;
  }
  let t2;
  if ($[31] !== filePath) {
    t2 = <Text bold={true}>{filePath}</Text>;
    $[31] = filePath;
    $[32] = t2;
  } else {
    t2 = $[32];
  }
  let t3;
  if ($[33] !== isTruncated) {
    t3 = isTruncated && <Text dimColor={true}> (truncated)</Text>;
    $[33] = isTruncated;
    $[34] = t3;
  } else {
    t3 = $[34];
  }
  let t4;
  if ($[35] !== t2 || $[36] !== t3) {
    t4 = <Box>{t2}{t3}</Box>;
    $[35] = t2;
    $[36] = t3;
    $[37] = t4;
  } else {
    t4 = $[37];
  }
  let t5;
  if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Divider padding={4} />;
    $[38] = t5;
  } else {
    t5 = $[38];
  }
  let t6;
  if ($[39] !== columns || $[40] !== fileContent || $[41] !== filePath || $[42] !== firstLine || $[43] !== hunks) {
    t6 = hunks.length === 0 ? <Text dimColor={true}>No diff content</Text> : hunks.map((hunk, index) => <StructuredDiff key={index} patch={hunk} filePath={filePath} firstLine={firstLine} fileContent={fileContent} dim={false} width={columns - 2 - 2} />);
    $[39] = columns;
    $[40] = fileContent;
    $[41] = filePath;
    $[42] = firstLine;
    $[43] = hunks;
    $[44] = t6;
  } else {
    t6 = $[44];
  }
  let t7;
  if ($[45] !== t6) {
    t7 = <Box flexDirection="column">{t6}</Box>;
    $[45] = t6;
    $[46] = t7;
  } else {
    t7 = $[46];
  }
  let t8;
  if ($[47] !== isTruncated) {
    t8 = isTruncated && <Text dimColor={true} italic={true}>… diff truncated (exceeded 400 line limit)</Text>;
    $[47] = isTruncated;
    $[48] = t8;
  } else {
    t8 = $[48];
  }
  let t9;
  if ($[49] !== t4 || $[50] !== t7 || $[51] !== t8) {
    t9 = <Box flexDirection="column" width="100%">{t4}{t5}{t7}{t8}</Box>;
    $[49] = t4;
    $[50] = t7;
    $[51] = t8;
    $[52] = t9;
  } else {
    t9 = $[52];
  }
  return t9;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTdHJ1Y3R1cmVkUGF0Y2hIdW5rIiwicmVzb2x2ZSIsIlJlYWN0IiwidXNlTWVtbyIsInVzZVRlcm1pbmFsU2l6ZSIsIkJveCIsIlRleHQiLCJnZXRDd2QiLCJyZWFkRmlsZVNhZmUiLCJEaXZpZGVyIiwiU3RydWN0dXJlZERpZmYiLCJQcm9wcyIsImZpbGVQYXRoIiwiaHVua3MiLCJpc0xhcmdlRmlsZSIsImlzQmluYXJ5IiwiaXNUcnVuY2F0ZWQiLCJpc1VudHJhY2tlZCIsIkRpZmZEZXRhaWxWaWV3IiwidDAiLCIkIiwiX2MiLCJjb2x1bW5zIiwidDEiLCJiYjAiLCJ0MiIsIlN5bWJvbCIsImZvciIsImZpcnN0TGluZSIsImZpbGVDb250ZW50IiwidW5kZWZpbmVkIiwiY29udGVudCIsImZ1bGxQYXRoIiwic3BsaXQiLCJ0MyIsInQ0IiwidDUiLCJ0NiIsInQ3IiwidDgiLCJsZW5ndGgiLCJtYXAiLCJodW5rIiwiaW5kZXgiLCJ0OSJdLCJzb3VyY2VzIjpbIkRpZmZEZXRhaWxWaWV3LnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnXG5pbXBvcnQgUmVhY3QsIHsgdXNlTWVtbyB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlVGVybWluYWxTaXplIH0gZnJvbSAnLi4vLi4vaG9va3MvdXNlVGVybWluYWxTaXplLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnLi4vLi4vdXRpbHMvY3dkLmpzJ1xuaW1wb3J0IHsgcmVhZEZpbGVTYWZlIH0gZnJvbSAnLi4vLi4vdXRpbHMvZmlsZS5qcydcbmltcG9ydCB7IERpdmlkZXIgfSBmcm9tICcuLi9kZXNpZ24tc3lzdGVtL0RpdmlkZXIuanMnXG5pbXBvcnQgeyBTdHJ1Y3R1cmVkRGlmZiB9IGZyb20gJy4uL1N0cnVjdHVyZWREaWZmLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBmaWxlUGF0aDogc3RyaW5nXG4gIGh1bmtzOiBTdHJ1Y3R1cmVkUGF0Y2hIdW5rW11cbiAgaXNMYXJnZUZpbGU/OiBib29sZWFuXG4gIGlzQmluYXJ5PzogYm9vbGVhblxuICBpc1RydW5jYXRlZD86IGJvb2xlYW5cbiAgaXNVbnRyYWNrZWQ/OiBib29sZWFuXG59XG5cbi8qKlxuICogRGlzcGxheXMgdGhlIGRpZmYgY29udGVudCBmb3IgYSBzaW5nbGUgZmlsZS5cbiAqIFVzZXMgU3RydWN0dXJlZERpZmYgZm9yIHdvcmQtbGV2ZWwgZGlmZmluZyBhbmQgc3ludGF4IGhpZ2hsaWdodGluZy5cbiAqIE5vIHNjcm9sbGluZyAtIHJlbmRlcnMgYWxsIGxpbmVzIChtYXggNDAwIGR1ZSB0byBwYXJzaW5nIGxpbWl0cykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBEaWZmRGV0YWlsVmlldyh7XG4gIGZpbGVQYXRoLFxuICBodW5rcyxcbiAgaXNMYXJnZUZpbGUsXG4gIGlzQmluYXJ5LFxuICBpc1RydW5jYXRlZCxcbiAgaXNVbnRyYWNrZWQsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgY29sdW1ucyB9ID0gdXNlVGVybWluYWxTaXplKClcblxuICAvLyBSZWFkIGZpbGUgY29udGVudCBmb3Igc3ludGF4IGRldGVjdGlvbiBhbmQgbXVsdGlsaW5lIGNvbnN0cnVjdCBoYW5kbGluZy5cbiAgLy8gT25seSBjb21wdXRlZCB3aGVuIHRoaXMgY29tcG9uZW50IGlzIHJlbmRlcmVkIChkZXRhaWwgdmlldyBtb2RlKS5cbiAgY29uc3QgeyBmaXJzdExpbmUsIGZpbGVDb250ZW50IH0gPSB1c2VNZW1vKCgpID0+IHtcbiAgICBpZiAoIWZpbGVQYXRoKSB7XG4gICAgICByZXR1cm4geyBmaXJzdExpbmU6IG51bGwsIGZpbGVDb250ZW50OiB1bmRlZmluZWQgfVxuICAgIH1cbiAgICBjb25zdCBmdWxsUGF0aCA9IHJlc29sdmUoZ2V0Q3dkKCksIGZpbGVQYXRoKVxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVNhZmUoZnVsbFBhdGgpXG4gICAgcmV0dXJuIHtcbiAgICAgIGZpcnN0TGluZTogY29udGVudD8uc3BsaXQoJ1xcbicpWzBdID8/IG51bGwsXG4gICAgICBmaWxlQ29udGVudDogY29udGVudCA/PyB1bmRlZmluZWQsXG4gICAgfVxuICB9LCBbZmlsZVBhdGhdKVxuXG4gIC8vIEhhbmRsZSB1bnRyYWNrZWQgZmlsZXNcbiAgaWYgKGlzVW50cmFja2VkKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIHdpZHRoPVwiMTAwJVwiPlxuICAgICAgICA8Qm94PlxuICAgICAgICAgIDxUZXh0IGJvbGQ+e2ZpbGVQYXRofTwvVGV4dD5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj4gKHVudHJhY2tlZCk8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgICA8RGl2aWRlciBwYWRkaW5nPXs0fSAvPlxuICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvciBpdGFsaWM+XG4gICAgICAgICAgICBOZXcgZmlsZSBub3QgeWV0IHN0YWdlZC5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3IgaXRhbGljPlxuICAgICAgICAgICAgUnVuIGBnaXQgYWRkIHtmaWxlUGF0aH1gIHRvIHNlZSBsaW5lIGNvdW50cy5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgPC9Cb3g+XG4gICAgKVxuICB9XG5cbiAgLy8gSGFuZGxlIGJpbmFyeSBmaWxlc1xuICBpZiAoaXNCaW5hcnkpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgd2lkdGg9XCIxMDAlXCI+XG4gICAgICAgIDxCb3g+XG4gICAgICAgICAgPFRleHQgYm9sZD57ZmlsZVBhdGh9PC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgICAgPERpdmlkZXIgcGFkZGluZz17NH0gLz5cbiAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3IgaXRhbGljPlxuICAgICAgICAgICAgQmluYXJ5IGZpbGUgLSBjYW5ub3QgZGlzcGxheSBkaWZmXG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIC8vIEhhbmRsZSBsYXJnZSBmaWxlc1xuICBpZiAoaXNMYXJnZUZpbGUpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgd2lkdGg9XCIxMDAlXCI+XG4gICAgICAgIDxCb3g+XG4gICAgICAgICAgPFRleHQgYm9sZD57ZmlsZVBhdGh9PC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgICAgPERpdmlkZXIgcGFkZGluZz17NH0gLz5cbiAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3IgaXRhbGljPlxuICAgICAgICAgICAgTGFyZ2UgZmlsZSAtIGRpZmYgZXhjZWVkcyAxIE1CIGxpbWl0XG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIGNvbnN0IG91dGVyUGFkZGluZ1ggPSAxXG4gIGNvbnN0IG91dGVyQm9yZGVyV2lkdGggPSAxXG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiB3aWR0aD1cIjEwMCVcIj5cbiAgICAgIDxCb3g+XG4gICAgICAgIDxUZXh0IGJvbGQ+e2ZpbGVQYXRofTwvVGV4dD5cbiAgICAgICAge2lzVHJ1bmNhdGVkICYmIDxUZXh0IGRpbUNvbG9yPiAodHJ1bmNhdGVkKTwvVGV4dD59XG4gICAgICA8L0JveD5cblxuICAgICAgPERpdmlkZXIgcGFkZGluZz17NH0gLz5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICB7aHVua3MubGVuZ3RoID09PSAwID8gKFxuICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPk5vIGRpZmYgY29udGVudDwvVGV4dD5cbiAgICAgICAgKSA6IChcbiAgICAgICAgICBodW5rcy5tYXAoKGh1bmssIGluZGV4KSA9PiAoXG4gICAgICAgICAgICA8U3RydWN0dXJlZERpZmZcbiAgICAgICAgICAgICAga2V5PXtpbmRleH1cbiAgICAgICAgICAgICAgcGF0Y2g9e2h1bmt9XG4gICAgICAgICAgICAgIGZpbGVQYXRoPXtmaWxlUGF0aH1cbiAgICAgICAgICAgICAgZmlyc3RMaW5lPXtmaXJzdExpbmV9XG4gICAgICAgICAgICAgIGZpbGVDb250ZW50PXtmaWxlQ29udGVudH1cbiAgICAgICAgICAgICAgZGltPXtmYWxzZX1cbiAgICAgICAgICAgICAgd2lkdGg9e2NvbHVtbnMgLSAyICogb3V0ZXJQYWRkaW5nWCAtIDIgKiBvdXRlckJvcmRlcldpZHRofVxuICAgICAgICAgICAgLz5cbiAgICAgICAgICApKVxuICAgICAgICApfVxuICAgICAgPC9Cb3g+XG5cbiAgICAgIHtpc1RydW5jYXRlZCAmJiAoXG4gICAgICAgIDxUZXh0IGRpbUNvbG9yIGl0YWxpYz5cbiAgICAgICAgICDigKYgZGlmZiB0cnVuY2F0ZWQgKGV4Y2VlZGVkIDQwMCBsaW5lIGxpbWl0KVxuICAgICAgICA8L1RleHQ+XG4gICAgICApfVxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxjQUFjQSxtQkFBbUIsUUFBUSxNQUFNO0FBQy9DLFNBQVNDLE9BQU8sUUFBUSxNQUFNO0FBQzlCLE9BQU9DLEtBQUssSUFBSUMsT0FBTyxRQUFRLE9BQU87QUFDdEMsU0FBU0MsZUFBZSxRQUFRLGdDQUFnQztBQUNoRSxTQUFTQyxHQUFHLEVB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