/**
 * PromptInputFooterSuggestions.tsx
 *
 * 【在系统流程中的位置】
 * 位于 PromptInput 组件体系的底部建议栏层。当用户在输入框中输入 "/"、"@" 等触发符号时，
 * 该组件负责在输入框下方（或以浮层形式在上方）渲染自动补全候选项列表。
 * 是用户与 Claude Code 交互的关键辅助 UI，承接来自各建议源（命令、文件、MCP资源、Agent等）的数据。
 *
 * 【主要功能】
 * - 定义 SuggestionItem 数据类型和 SuggestionType 枚举
 * - 渲染单条建议项（SuggestionItemRow）：按类型区分"统一布局"和"传统布局"
 * - 渲染整个候选列表（PromptInputFooterSuggestions）：支持内联模式和浮层模式
 * - 根据终端宽度自适应截断路径和描述文字，防止换行导致布局混乱
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { memo, type ReactNode } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text } from '../../ink.js';
import { truncatePathMiddle, truncateToWidth } from '../../utils/format.js';
import type { Theme } from '../../utils/theme.js';

/** 单条建议项的数据结构 */
export type SuggestionItem = {
  id: string;           // 带类型前缀的唯一标识，如 "file-src/index.ts"、"agent-reviewer"
  displayText: string;  // 在列表中展示的主文本
  tag?: string;         // 可选标签，如命令来源插件名
  description?: string; // 可选描述，显示在主文本右侧
  metadata?: unknown;   // 附加元数据，由各建议源自行定义
  color?: keyof Theme;  // 可选自定义颜色键
};

/** 建议类型枚举，决定触发来源与展示样式 */
export type SuggestionType = 'command' | 'file' | 'directory' | 'agent' | 'shell' | 'custom-title' | 'slack-channel' | 'none';

/** 浮层模式下最多同时展示的建议条数（防止遮挡输入区） */
export const OVERLAY_MAX_ITEMS = 5;

/**
 * 根据建议条目 ID 的前缀，返回对应的行首图标字符。
 * - "file-" 前缀 → "+" 表示文件
 * - "mcp-resource-" 前缀 → "◇" 表示 MCP 资源（菱形）
 * - "agent-" 前缀 → "*" 表示 Agent
 * - 其他默认返回 "+"
 */
function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) return '+';
  if (itemId.startsWith('mcp-resource-')) return '◇';
  if (itemId.startsWith('agent-')) return '*';
  return '+';
}

/**
 * 判断是否为"统一建议"类型（文件、MCP资源或 Agent）。
 * 统一建议使用单行图标布局；非统一建议（命令等）使用带对齐列的传统布局。
 */
function isUnifiedSuggestion(itemId: string): boolean {
  return itemId.startsWith('file-') || itemId.startsWith('mcp-resource-') || itemId.startsWith('agent-');
}

/**
 * 单条建议项行组件（已 memo 化）。
 *
 * 【整体流程】
 * 1. 判断是否为"统一类型"（文件/MCP资源/Agent）
 *    - 是：使用图标前缀 + 智能截断路径/文本 + 可选描述的单行布局
 *    - 否：使用固定宽度主文本列 + 标签列 + 描述列的传统布局
 * 2. 被选中项使用 "suggestion" 主题色；未选中项使用 dimColor 灰显
 * 3. 所有文本均 wrap="truncate" 防止终端换行
 */
const SuggestionItemRow = memo(function SuggestionItemRow(t0) {
  const $ = _c(36);
  const {
    item,
    maxColumnWidth,
    isSelected
  } = t0;
  // 获取当前终端列数，用于动态计算截断宽度
  const columns = useTerminalSize().columns;
  // 判断当前项是否属于统一建议类型（文件/MCP资源/Agent）
  const isUnified = isUnifiedSuggestion(item.id);

  // ────────── 统一建议布局：图标 + 文本 + 可选描述 ──────────
  if (isUnified) {
    let t1;
    if ($[0] !== item.id) {
      // 根据 ID 前缀获取对应图标
      t1 = getIcon(item.id);
      $[0] = item.id;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    const icon = t1;
    // 被选中时高亮，未选中时灰显
    const textColor = isSelected ? "suggestion" : undefined;
    const dimColor = !isSelected;
    // 细分子类型，用于差异化截断策略
    const isFile = item.id.startsWith("file-");
    const isMcpResource = item.id.startsWith("mcp-resource-");
    // 如果有描述，为 " – " 分隔符预留 3 字符宽度
    const separatorWidth = item.description ? 3 : 0;

    let displayText;
    if (isFile) {
      let t2;
      if ($[2] !== item.description) {
        // 文件路径：为描述文字预留空间（最多 20 字符），超出则使用中间截断（保留头尾）
        t2 = item.description ? Math.min(20, stringWidth(item.description)) : 0;
        $[2] = item.description;
        $[3] = t2;
      } else {
        t2 = $[3];
      }
      const descReserve = t2;
      // 最大路径显示宽度 = 终端宽度 - 图标(2) - 内边距(4) - 分隔符 - 描述预留
      const maxPathLength = columns - 2 - 4 - separatorWidth - descReserve;
      let t3;
      if ($[4] !== item.displayText || $[5] !== maxPathLength) {
        // 路径中间截断：保留文件名和顶层目录，省略中间部分
        t3 = truncatePathMiddle(item.displayText, maxPathLength);
        $[4] = item.displayText;
        $[5] = maxPathLength;
        $[6] = t3;
      } else {
        t3 = $[6];
      }
      displayText = t3;
    } else {
      if (isMcpResource) {
        let t2;
        if ($[7] !== item.displayText) {
          // MCP 资源：限制显示文本最多 30 字符，从末尾截断
          t2 = truncateToWidth(item.displayText, 30);
          $[7] = item.displayText;
          $[8] = t2;
        } else {
          t2 = $[8];
        }
        displayText = t2;
      } else {
        // Agent：不做截断，直接使用原文本
        displayText = item.displayText;
      }
    }

    // 计算描述文字的可用宽度
    const availableWidth = columns - 2 - stringWidth(displayText) - separatorWidth - 4;

    // 构建最终单行内容字符串（避免 Text 子组件换行）
    let lineContent;
    if (item.description) {
      const maxDescLength = Math.max(0, availableWidth);
      let t2;
      if ($[9] !== item.description || $[10] !== maxDescLength) {
        // 将多行描述压缩为单行后截断（防止 overlay 高度膨胀）
        t2 = truncateToWidth(item.description.replace(/\s+/g, " "), maxDescLength);
        $[9] = item.description;
        $[10] = maxDescLength;
        $[11] = t2;
      } else {
        t2 = $[11];
      }
      const truncatedDesc = t2;
      // 格式：图标 + 空格 + 路径 + " – " + 描述
      lineContent = `${icon} ${displayText} – ${truncatedDesc}`;
    } else {
      lineContent = `${icon} ${displayText}`;
    }

    // 渲染单行文本，wrap="truncate" 防止越界换行
    let t2;
    if ($[12] !== dimColor || $[13] !== lineContent || $[14] !== textColor) {
      t2 = <Text color={textColor} dimColor={dimColor} wrap="truncate">{lineContent}</Text>;
      $[12] = dimColor;
      $[13] = lineContent;
      $[14] = textColor;
      $[15] = t2;
    } else {
      t2 = $[15];
    }
    return t2;
  }

  // ────────── 传统建议布局：对齐列（命令/Shell等）──────────
  // 将主文本列宽限制在终端宽度的 40%，确保描述列有足够空间
  const maxNameWidth = Math.floor(columns * 0.4);
  const displayTextWidth = Math.min(
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
    maxNameWidth,
  );

  // 颜色：优先使用条目自带颜色，其次按选中状态决定
  const textColor_0 = item.color || (isSelected ? "suggestion" : undefined);
  const shouldDim = !isSelected;

  // 截断并右侧填充空格，形成固定宽度的主文本列
  let displayText_0 = item.displayText;
  if (stringWidth(displayText_0) > displayTextWidth - 2) {
    const t1 = displayTextWidth - 2;
    let t2;
    if ($[16] !== displayText_0 || $[17] !== t1) {
      t2 = truncateToWidth(displayText_0, t1);
      $[16] = displayText_0;
      $[17] = t1;
      $[18] = t2;
    } else {
      t2 = $[18];
    }
    displayText_0 = t2;
  }
  // 右侧填充空格对齐
  const paddedDisplayText = displayText_0 + " ".repeat(Math.max(0, displayTextWidth - stringWidth(displayText_0)));

  // 标签文本（方括号格式），用于标注来源插件等
  const tagText = item.tag ? `[${item.tag}] ` : "";
  const tagWidth = stringWidth(tagText);
  // 描述列可用宽度 = 终端宽 - 主文本列宽 - 标签宽 - 边距
  const descriptionWidth = Math.max(0, columns - displayTextWidth - tagWidth - 4);

  let t1;
  if ($[19] !== descriptionWidth || $[20] !== item.description) {
    // 描述中可能含换行（如 /claude-api 的 TRIGGER 块），压平为单行后截断
    t1 = item.description ? truncateToWidth(item.description.replace(/\s+/g, " "), descriptionWidth) : "";
    $[19] = descriptionWidth;
    $[20] = item.description;
    $[21] = t1;
  } else {
    t1 = $[21];
  }
  const truncatedDescription = t1;

  // 渲染三列布局：主文本 | 标签 | 描述
  let t2;
  if ($[22] !== paddedDisplayText || $[23] !== shouldDim || $[24] !== textColor_0) {
    t2 = <Text color={textColor_0} dimColor={shouldDim}>{paddedDisplayText}</Text>;
    $[22] = paddedDisplayText;
    $[23] = shouldDim;
    $[24] = textColor_0;
    $[25] = t2;
  } else {
    t2 = $[25];
  }
  let t3;
  if ($[26] !== tagText) {
    t3 = tagText ? <Text dimColor={true}>{tagText}</Text> : null;
    $[26] = tagText;
    $[27] = t3;
  } else {
    t3 = $[27];
  }
  const t4 = isSelected ? "suggestion" : undefined;
  const t5 = !isSelected;
  let t6;
  if ($[28] !== t4 || $[29] !== t5 || $[30] !== truncatedDescription) {
    t6 = <Text color={t4} dimColor={t5}>{truncatedDescription}</Text>;
    $[28] = t4;
    $[29] = t5;
    $[30] = truncatedDescription;
    $[31] = t6;
  } else {
    t6 = $[31];
  }
  let t7;
  if ($[32] !== t2 || $[33] !== t3 || $[34] !== t6) {
    t7 = <Text wrap="truncate">{t2}{t3}{t6}</Text>;
    $[32] = t2;
    $[33] = t3;
    $[34] = t6;
    $[35] = t7;
  } else {
    t7 = $[35];
  }
  return t7;
});

/** PromptInputFooterSuggestions 组件的 Props 类型 */
type Props = {
  suggestions: SuggestionItem[];       // 完整建议列表
  selectedSuggestion: number;          // 当前高亮的建议索引
  maxColumnWidth?: number;             // 可选：外部传入的主文本列最大宽度（stable width）
  /**
   * 为 true 时建议列表渲染在 position=absolute 浮层中。
   * 省略 minHeight 和 flex-end，防止渲染器 y-clamp 将较少条目向下推入输入区。
   */
  overlay?: boolean;
};

/**
 * PromptInputFooterSuggestions —— 建议候选列表容器组件。
 *
 * 【整体流程】
 * 1. 根据终端行数和 overlay 模式计算最多可见条数（maxVisibleItems）
 * 2. 若建议列表为空，直接返回 null
 * 3. 计算所有条目中最宽主文本的宽度作为列宽基准（maxColumnWidth）
 * 4. 根据当前选中索引，计算滚动窗口的起止索引（startIndex / endIndex）
 * 5. 渲染可见条目：内联模式用 justifyContent="flex-end" 锚定到底部；浮层模式省略该属性
 */
export function PromptInputFooterSuggestions(t0) {
  const $ = _c(22);
  const {
    suggestions,
    selectedSuggestion,
    maxColumnWidth: maxColumnWidthProp,
    overlay
  } = t0;
  const {
    rows
  } = useTerminalSize();

  // 浮层模式：固定 5 条（浮层高度受限）；内联模式：不超过 6 条且至少 1 条
  const maxVisibleItems = overlay ? OVERLAY_MAX_ITEMS : Math.min(6, Math.max(1, rows - 3));

  // 空列表直接不渲染
  if (suggestions.length === 0) {
    return null;
  }

  // 优先使用外部传入的稳定列宽（来自完整命令列表），否则从当前可见项动态计算
  let t1;
  if ($[0] !== maxColumnWidthProp || $[1] !== suggestions) {
    t1 = maxColumnWidthProp ?? Math.max(...suggestions.map(_temp)) + 5;
    $[0] = maxColumnWidthProp;
    $[1] = suggestions;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const maxColumnWidth = t1;

  // 计算滚动窗口：让选中项尽量居中显示在可见范围内
  const startIndex = Math.max(0, Math.min(selectedSuggestion - Math.floor(maxVisibleItems / 2), suggestions.length - maxVisibleItems));
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length);

  let T0;
  let t2;
  let t3;
  let t4;
  if ($[3] !== endIndex || $[4] !== maxColumnWidth || $[5] !== overlay || $[6] !== selectedSuggestion || $[7] !== startIndex || $[8] !== suggestions) {
    const visibleItems = suggestions.slice(startIndex, endIndex);
    T0 = Box;
    t2 = "column";
    // 内联模式：flex-end 让条目锚定在底部（靠近输入框）；浮层模式省略
    t3 = overlay ? undefined : "flex-end";
    let t5;
    if ($[13] !== maxColumnWidth || $[14] !== selectedSuggestion || $[15] !== suggestions) {
      // 逐条渲染建议行，通过 id 对比判断是否为选中项
      t5 = item_0 => <SuggestionItemRow key={item_0.id} item={item_0} maxColumnWidth={maxColumnWidth} isSelected={item_0.id === suggestions[selectedSuggestion]?.id} />;
      $[13] = maxColumnWidth;
      $[14] = selectedSuggestion;
      $[15] = suggestions;
      $[16] = t5;
    } else {
      t5 = $[16];
    }
    t4 = visibleItems.map(t5);
    $[3] = endIndex;
    $[4] = maxColumnWidth;
    $[5] = overlay;
    $[6] = selectedSuggestion;
    $[7] = startIndex;
    $[8] = suggestions;
    $[9] = T0;
    $[10] = t2;
    $[11] = t3;
    $[12] = t4;
  } else {
    T0 = $[9];
    t2 = $[10];
    t3 = $[11];
    t4 = $[12];
  }
  let t5;
  if ($[17] !== T0 || $[18] !== t2 || $[19] !== t3 || $[20] !== t4) {
    t5 = <T0 flexDirection={t2} justifyContent={t3}>{t4}</T0>;
    $[17] = T0;
    $[18] = t2;
    $[19] = t3;
    $[20] = t4;
    $[21] = t5;
  } else {
    t5 = $[21];
  }
  return t5;
}

/** 用于 map 回调：提取条目显示文本的视觉宽度（供计算最大列宽） */
function _temp(item) {
  return stringWidth(item.displayText);
}

export default memo(PromptInputFooterSuggestions);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIm1lbW8iLCJSZWFjdE5vZGUiLCJ1c2VUZXJtaW5hbFNpemUiLCJzdHJpbmdXaWR0aCIsIkJveCIsIlRleHQiLCJ0cnVuY2F0ZVBhdGhNaWRkbGUiLCJ0cnVuY2F0ZVRvV2lkdGgiLCJUaGVtZSIsIlN1Z2dlc3Rpb25JdGVtIiwiaWQiLCJkaXNwbGF5VGV4dCIsInRhZyIsImRlc2NyaXB0aW9uIiwibWV0YWRhdGEiLCJjb2xvciIsIlN1Z2dlc3Rpb25UeXBlIiwiT1ZFUkxBWV9NQVhfSVRFTVMiLCJnZXRJY29uIiwiaXRlbUlkIiwic3RhcnRzV2l0aCIsImlzVW5pZmllZFN1Z2dlc3Rpb24iLCJTdWdnZXN0aW9uSXRlbVJvdyIsInQwIiwiJCIsIl9jIiwiaXRlbSIsIm1heENvbHVtbldpZHRoIiwiaXNTZWxlY3RlZCIsImNvbHVtbnMiLCJpc1VuaWZpZWQiLCJ0MSIsImljb24iLCJ0ZXh0Q29sb3IiLCJ1bmRlZmluZWQiLCJkaW1Db2xvciIsImlzRmlsZSIsImlzTWNwUmVzb3VyY2UiLCJzZXBhcmF0b3JXaWR0aCIsInQyIiwiTWF0aCIsIm1pbiIsImRlc2NSZXNlcnZlIiwibWF4UGF0aExlbmd0aCIsInQzIiwiYXZhaWxhYmxlV2lkdGgiLCJsaW5lQ29udGVudCIsIm1heERlc2NMZW5ndGgiLCJtYXgiLCJyZXBsYWNlIiwidHJ1bmNhdGVkRGVzYyIsIm1heE5hbWVXaWR0aCIsImZsb29yIiwiZGlzcGxheVRleHRXaWR0aCIsInRleHRDb2xvcl8wIiwic2hvdWxkRGltIiwiZGlzcGxheVRleHRfMCIsInBhZGRlZERpc3BsYXlUZXh0IiwicmVwZWF0IiwidGFnVGV4dCIsInRhZ1dpZHRoIiwiZGVzY3JpcHRpb25XaWR0aCIsInRydW5jYXRlZERlc2NyaXB0aW9uIiwidDQiLCJ0NSIsInQ2IiwidDciLCJQcm9wcyIsInN1Z2dlc3Rpb25zIiwic2VsZWN0ZWRTdWdnZXN0aW9uIiwib3ZlcmxheSIsIlByb21wdElucHV0Rm9vdGVyU3VnZ2VzdGlvbnMiLCJtYXhDb2x1bW5XaWR0aFByb3AiLCJyb3dzIiwibWF4VmlzaWJsZUl0ZW1zIiwibGVuZ3RoIiwibWFwIiwiX3RlbXAiLCJzdGFydEluZGV4IiwiZW5kSW5kZXgiLCJUMCIsInZpc2libGVJdGVtcyIsInNsaWNlIiwiaXRlbV8wIl0sInNvdXJjZXMiOlsiUHJvbXB0SW5wdXRGb290ZXJTdWdnZXN0aW9ucy50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBtZW1vLCB0eXBlIFJlYWN0Tm9kZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlVGVybWluYWxTaXplIH0gZnJvbSAnLi4vLi4vaG9va3MvdXNlVGVybWluYWxTaXplLmpzJ1xuaW1wb3J0IHsgc3RyaW5nV2lkdGggfSBmcm9tICcuLi8uLi9pbmsvc3RyaW5nV2lkdGguanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB0cnVuY2F0ZVBhdGhNaWRkbGUsIHRydW5jYXRlVG9XaWR0aCB9IGZyb20gJy4uLy4uL3V0aWxzL2Zvcm1hdC5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbiJdLCJtYXBwaW5ncyI6IiIsImlnbm9yZUxpc3QiOltdfQ==
