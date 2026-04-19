/**
 * HistorySearchDialog.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件实现历史记录模糊搜索对话框，当用户通过快捷键（如 Ctrl+R）触发历史搜索时
 * 由上层组件（通常是 Modal 或 App 路由层）挂载此组件。
 * 它通过 useRegisterOverlay('history-search') 向 overlayContext 注册自身，
 * 确保对话框获得焦点并在叠加层管理系统中正确定位。
 *
 * 主要功能：
 * 1. 异步流式加载历史记录（getTimestampedHistory 返回 AsyncGenerator），
 *    组件挂载后立即开始拉取，卸载时通过 cancelled 标志中断，防止内存泄漏。
 * 2. useMemo 实现两阶段搜索过滤：精确子串匹配（exact）优先，字符子序列匹配
 *    （fuzzy，isSubsequence）次之，合并后传递给 FuzzyPicker。
 * 3. 根据终端宽度（columns >= 100）自适应布局：宽终端将预览区放在右侧，
 *    窄终端放在底部，各区域宽度均做了最小值保护（Math.max(20, ...)）。
 * 4. 渲染 FuzzyPicker（通用模糊选择器）：提供 renderItem（显示年龄 + 第一行文本）
 *    和 renderPreview（ANSI 感知的换行预览，最多 PREVIEW_ROWS=6 行）。
 * 5. 选中时上报 analytics 事件（tengu_history_picker_select），
 *    然后异步调用 entry.resolve() 获取完整 HistoryEntry 后回调 onSelect。
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { getTimestampedHistory, type TimestampedHistoryEntry } from '../history.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { stringWidth } from '../ink/stringWidth.js';
import { wrapAnsi } from '../ink/wrapAnsi.js';
import { Box, Text } from '../ink.js';
import { logEvent } from '../services/analytics/index.js';
import type { HistoryEntry } from '../utils/config.js';
import { formatRelativeTimeAgo, truncateToWidth } from '../utils/format.js';
import { FuzzyPicker } from './design-system/FuzzyPicker.js';
type Props = {
  initialQuery?: string;
  onSelect: (entry: HistoryEntry) => void;
  onCancel: () => void;
};
// 预览区最多显示的行数（超出部分显示 "+N more lines" 提示）
const PREVIEW_ROWS = 6;
// 时间列（age）的固定宽度，用于补空格对齐（如 "2d ago  "）
const AGE_WIDTH = 8;
// Item 类型：将 TimestampedHistoryEntry 扩展为包含预计算展示字段的条目
type Item = {
  entry: TimestampedHistoryEntry;  // 原始历史条目（含 timestamp 和懒加载 resolve()）
  display: string;                  // 完整展示字符串
  lower: string;                    // display 的小写版本，用于大小写不敏感搜索
  firstLine: string;                // display 的第一行，用于列表行渲染
  age: string;                      // 格式化的相对时间，已右补空格至 AGE_WIDTH
};

/**
 * HistorySearchDialog — 历史记录模糊搜索对话框
 *
 * 整体流程：
 * 1. useRegisterOverlay('history-search')：将自身注册到叠加层上下文，获取焦点。
 * 2. useTerminalSize()：获取当前终端列数，用于自适应布局计算。
 * 3. useState(null)：items 初始为 null（加载中状态），加载完成后为 Item 数组。
 * 4. useState(initialQuery ?? '')：query 受控状态，由 FuzzyPicker 的 onQueryChange 更新。
 * 5. useEffect([])：组件挂载后启动异步流式加载（AsyncGenerator），
 *    - 逐条 push 到 loaded 数组，cancelled=true 时调用 reader.return() 中断迭代；
 *    - 全部加载完成后 setItems(loaded)；
 *    - 清理函数设置 cancelled=true，防止组件卸载后继续 setState。
 * 6. useMemo([items, query])：两阶段过滤：
 *    - 精确匹配（item.lower.includes(q)）→ exact 数组（优先）
 *    - 子序列匹配（isSubsequence(item.lower, q)）→ fuzzy 数组（次之）
 *    - 返回 exact.concat(fuzzy)
 * 7. 布局计算：previewOnRight（宽 >= 100）→ 右侧预览；否则底部预览。
 * 8. 渲染 <FuzzyPicker>，传入各回调和渲染函数。
 */
export function HistorySearchDialog({
  initialQuery,
  onSelect,
  onCancel
}: Props): React.ReactNode {
  // 向叠加层上下文注册，使该对话框获得键盘焦点优先级
  useRegisterOverlay('history-search');
  // 读取终端宽度，用于后续自适应布局
  const {
    columns
  } = useTerminalSize();
  // items: null 表示仍在加载，数组表示加载完成
  const [items, setItems] = useState<Item[] | null>(null);
  // query: 当前搜索词，由 FuzzyPicker 的输入框驱动
  const [query, setQuery] = useState(initialQuery ?? '');

  // 异步流式加载历史记录
  useEffect(() => {
    let cancelled = false; // 闭包标志，用于在组件卸载时中断异步迭代
    void (async () => {
      const reader = getTimestampedHistory(); // 获取 AsyncGenerator<TimestampedHistoryEntry>
      const loaded: Item[] = [];
      for await (const entry of reader) {
        // 检查是否已被取消（组件已卸载），若是则提前终止迭代
        if (cancelled) {
          void reader.return(undefined); // 显式关闭 AsyncGenerator，释放资源
          return;
        }
        const display = entry.display;
        const nl = display.indexOf('\n'); // 找到第一个换行符位置
        const age = formatRelativeTimeAgo(new Date(entry.timestamp)); // 计算相对时间（如 "2d ago"）
        loaded.push({
          entry,
          display,
          lower: display.toLowerCase(),   // 预计算小写版本，避免每次搜索时重复转换
          // 若无换行则取全文，否则仅取第一行
          firstLine: nl === -1 ? display : display.slice(0, nl),
          // 右补空格至 AGE_WIDTH，确保列表中时间列对齐
          age: age + ' '.repeat(Math.max(0, AGE_WIDTH - stringWidth(age)))
        });
      }
      // 全部加载完毕且未被取消时，更新 state
      if (!cancelled) setItems(loaded);
    })();
    // 清理函数：组件卸载时设置 cancelled=true，中断正在进行的异步迭代
    return () => {
      cancelled = true;
    };
  }, []); // 仅在挂载时执行一次

  // 两阶段模糊过滤：exact（精确子串）优先，fuzzy（子序列）次之
  const filtered = useMemo(() => {
    if (!items) return []; // 加载中时返回空数组
    const q = query.trim().toLowerCase(); // 标准化查询词
    if (!q) return items; // 空查询返回全部条目
    const exact: Item[] = [];
    const fuzzy: Item[] = [];
    for (const item of items) {
      if (item.lower.includes(q)) {
        // 第一阶段：精确子串匹配（优先级高）
        exact.push(item);
      } else if (isSubsequence(item.lower, q)) {
        // 第二阶段：字符子序列匹配（优先级低，但覆盖更广）
        fuzzy.push(item);
      }
    }
    // 精确匹配在前，模糊匹配在后
    return exact.concat(fuzzy);
  }, [items, query]);

  // 自适应布局：宽终端（>= 100 列）将预览放右侧，窄终端放底部
  const previewOnRight = columns >= 100;
  // 列表区宽度：右侧预览时占一半，否则占全宽（减去边框等 padding）
  const listWidth = previewOnRight ? Math.floor((columns - 6) * 0.5) : columns - 6;
  // 行文本宽度：列表宽度减去时间列宽度和分隔符
  const rowWidth = Math.max(20, listWidth - AGE_WIDTH - 1);
  // 预览区宽度：右侧预览时为剩余宽度，底部预览时为全宽（各有最小值保护）
  const previewWidth = previewOnRight ? Math.max(20, columns - listWidth - 12) : Math.max(20, columns - 10);

  // 渲染 FuzzyPicker，注入所有必要的 props 和回调
  return <FuzzyPicker title="Search prompts" placeholder="Filter history…" initialQuery={initialQuery} items={filtered} getKey={item_0 => String(item_0.entry.timestamp)} /* 以 timestamp 作为唯一 key */ onQueryChange={setQuery} onSelect={item_1 => {
    // 选中时上报分析事件（搜索结果数量 + 查询长度）
    logEvent('tengu_history_picker_select', {
      result_count: filtered.length,
      query_length: query.length
    });
    // 异步解析完整 HistoryEntry 后回调 onSelect（entry.resolve 是懒加载）
    void item_1.entry.resolve().then(onSelect);
  }} onCancel={onCancel} emptyMessage={q_0 => items === null ? 'Loading…' /* 加载中 */ : q_0 ? 'No matching prompts' /* 有查询但无结果 */ : 'No history yet' /* 无历史记录 */} selectAction="use" direction="up" /* 列表向上增长（从底部往顶部） */ previewPosition={previewOnRight ? 'right' : 'bottom'} renderItem={(item_2, isFocused) => <Text>
          {/* 灰显的时间列（固定宽度 AGE_WIDTH） */}
          <Text dimColor>{item_2.age}</Text>
          {/* 第一行文本，焦点时高亮为 suggestion 颜色 */}
          <Text color={isFocused ? 'suggestion' : undefined}>
            {' '}
            {truncateToWidth(item_2.firstLine, rowWidth)} {/* 截断至列表可用宽度 */}
          </Text>
        </Text>} renderPreview={item_3 => {
    // 将完整内容按预览宽度硬换行，过滤空行
    const wrapped = wrapAnsi(item_3.display, previewWidth, {
      hard: true  // 强制在 previewWidth 处截断（不保留单词完整性）
    }).split('\n').filter(l => l.trim() !== ''); // 过滤纯空白行
    // 判断是否超出最大预览行数
    const overflow = wrapped.length > PREVIEW_ROWS;
    // 超出时保留前 PREVIEW_ROWS-1 行，为 "+N more" 留一行
    const shown = wrapped.slice(0, overflow ? PREVIEW_ROWS - 1 : PREVIEW_ROWS);
    const more = wrapped.length - shown.length; // 未显示的行数
    return <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} height={PREVIEW_ROWS + 2} /* 固定高度=内容行+上下边框 */>
            {/* 渲染可见行，均灰显 */}
            {shown.map((row, i) => <Text key={i} dimColor>
                {row}
              </Text>)}
            {/* 超出部分显示 "+N more lines" 提示 */}
            {more > 0 && <Text dimColor>{`… +${more} more lines`}</Text>}
          </Box>;
  }} />;
}

/**
 * isSubsequence — 判断 query 是否为 text 的字符子序列
 *
 * 流程：
 * 1. j 指向 query 的当前待匹配字符。
 * 2. 逐字符遍历 text，若 text[i] === query[j] 则 j 前进。
 * 3. 遍历结束后若 j === query.length，说明 query 所有字符均在 text 中
 *    按顺序出现（不要求连续），即 query 是 text 的子序列。
 *
 * 用于 HistorySearchDialog 的第二阶段模糊匹配。
 */
function isSubsequence(text: string, query: string): boolean {
  let j = 0; // query 的当前匹配位置
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] === query[j]) j++; // 字符匹配，j 前进
  }
  return j === query.length; // 所有 query 字符均已匹配
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZU1lbW8iLCJ1c2VTdGF0ZSIsInVzZVJlZ2lzdGVyT3ZlcmxheSIsImdldFRpbWVzdGFtcGVkSGlzdG9yeSIsIlRpbWVzdGFtcGVkSGlzdG9yeUVudHJ5IiwidXNlVGVybWluYWxTaXplIiwic3RyaW5nV2lkdGgiLCJ3cmFwQW5zaSIsIkJveCIsIlRleHQiLCJsb2dFdmVudCIsIkhpc3RvcnlFbnRyeSIsImZvcm1hdFJlbGF0aXZlVGltZUFnbyIsInRydW5jYXRlVG9XaWR0aCIsIkZ1enp5UGlja2VyIiwiUHJvcHMiLCJpbml0aWFsUXVlcnkiLCJvblNlbGVjdCIsImVudHJ5Iiwib25DYW5jZWwiLCJQUkVWSUVXX1JPV1MiLCJBR0VfV0lEVEgiLCJJdGVtIiwiZGlzcGxheSIsImxvd2VyIiwiZmlyc3RMaW5lIiwiYWdlIiwiSGlzdG9yeVNlYXJjaERpYWxvZyIsIlJlYWN0Tm9kZSIsImNvbHVtbnMiLCJpdGVtcyIsInNldEl0ZW1zIiwicXVlcnkiLCJzZXRRdWVyeSIsImNhbmNlbGxlZCIsInJlYWRlciIsImxvYWRlZCIsInJldHVybiIsInVuZGVmaW5lZCIsIm5sIiwiaW5kZXhPZiIsIkRhdGUiLCJ0aW1lc3RhbXAiLCJwdXNoIiwidG9Mb3dlckNhc2UiLCJzbGljZSIsInJlcGVhdCIsIk1hdGgiLCJtYXgiLCJmaWx0ZXJlZCIsInEiLCJ0cmltIiwiZXhhY3QiLCJmdXp6eSIsIml0ZW0iLCJpbmNsdWRlcyIsImlzU3Vic2VxdWVuY2UiLCJjb25jYXQiLCJwcmV2aWV3T25SaWdodCIsImxpc3RXaWR0aCIsImZsb29yIiwicm93V2lkdGgiLCJwcmV2aWV3V2lkdGgiLCJTdHJpbmciLCJyZXN1bHRfY291bnQiLCJsZW5ndGgiLCJxdWVyeV9sZW5ndGgiLCJyZXNvbHZlIiwidGhlbiIsImlzRm9jdXNlZCIsIndyYXBwZWQiLCJoYXJkIiwic3BsaXQiLCJmaWx0ZXIiLCJsIiwib3ZlcmZsb3ciLCJzaG93biIsIm1vcmUiLCJtYXAiLCJyb3ciLCJpIiwidGV4dCIsImoiXSwic291cmNlcyI6WyJIaXN0b3J5U2VhcmNoRGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZUVmZmVjdCwgdXNlTWVtbywgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZVJlZ2lzdGVyT3ZlcmxheSB9IGZyb20gJy4uL2NvbnRleHQvb3ZlcmxheUNvbnRleHQuanMnXG5pbXBvcnQge1xuICBnZXRUaW1lc3RhbXBlZEhpc3RvcnksXG4gIHR5cGUgVGltZXN0YW1wZWRIaXN0b3J5RW50cnksXG59IGZyb20gJy4uL2hpc3RvcnkuanMnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICcuLi9ob29rcy91c2VUZXJtaW5hbFNpemUuanMnXG5pbXBvcnQgeyBzdHJpbmdXaWR0aCB9IGZyb20gJy4uL2luay9zdHJpbmdXaWR0aC5qcydcbmltcG9ydCB7IHdyYXBBbnNpIH0gZnJvbSAnLi4vaW5rL3dyYXBBbnNpLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgbG9nRXZlbnQgfSBmcm9tICcuLi9zZXJ2aWNlcy9hbmFseXRpY3MvaW5kZXguanMnXG5pbXBvcnQgdHlwZSB7IEhpc3RvcnlFbnRyeSB9IGZyb20gJy4uL3V0aWxzL2NvbmZpZy5qcydcbmltcG9ydCB7IGZvcm1hdFJlbGF0aXZlVGltZUFnbywgdHJ1bmNhdGVUb1dpZHRoIH0gZnJvbSAnLi4vdXRpbHMvZm9ybWF0LmpzJ1xuaW1wb3J0IHsgRnV6enlQaWNrZXIgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vRnV6enlQaWNrZXIuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGluaXRpYWxRdWVyeT86IHN0cmluZ1xuICBvblNlbGVjdDogKGVudHJ5OiBIaXN0b3J5RW50cnkpID0+IHZvaWRcbiAgb25DYW5jZWw6ICgpID0+IHZvaWRcbn1cblxuY29uc3QgUFJFVklFV19ST1dTID0gNlxuY29uc3QgQUdFX1dJRFRIID0gOFxuXG50eXBlIEl0ZW0gPSB7XG4gIGVudHJ5OiBUaW1lc3RhbXBlZEhpc3RvcnlFbnRyeVxuICBkaXNwbGF5OiBzdHJpbmdcbiAgbG93ZXI6IHN0cmluZ1xuICBmaXJzdExpbmU6IHN0cmluZ1xuICBhZ2U6IHN0cmluZ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gSGlzdG9yeVNlYXJjaERpYWxvZyh7XG4gIGluaXRpYWxRdWVyeSxcbiAgb25TZWxlY3QsXG4gIG9uQ2FuY2VsLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICB1c2VSZWdpc3Rlck92ZXJsYXkoJ2hpc3Rvcnktc2VhcmNoJylcbiAgY29uc3QgeyBjb2x1bW5zIH0gPSB1c2VUZXJtaW5hbFNpemUoKVxuXG4gIGNvbnN0IFtpdGVtcywgc2V0SXRlbXNdID0gdXNlU3RhdGU8SXRlbVtdIHwgbnVsbD4obnVsbClcbiAgY29uc3QgW3F1ZXJ5LCBzZXRRdWVyeV0gPSB1c2VTdGF0ZShpbml0aWFsUXVlcnkgPz8gJycpXG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBsZXQgY2FuY2VsbGVkID0gZmFsc2VcbiAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByZWFkZXIgPSBnZXRUaW1lc3RhbXBlZEhpc3RvcnkoKVxuICAgICAgY29uc3QgbG9hZGVkOiBJdGVtW10gPSBbXVxuICAgICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiByZWFkZXIpIHtcbiAgICAgICAgaWYgKGNhbmNlbGxlZCkge1xuICAgICAgICAgIHZvaWQgcmVhZGVyLnJldHVybih1bmRlZmluZWQpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZGlzcGxheSA9IGVudHJ5LmRpc3BsYXlcbiAgICAgICAgY29uc3QgbmwgPSBkaXNwbGF5LmluZGV4T2YoJ1xcbicpXG4gICAgICAgIGNvbnN0IGFnZSA9IGZvcm1hdFJlbGF0aXZlVGltZUFnbyhuZXcgRGF0ZShlbnRyeS50aW1lc3RhbXApKVxuICAgICAgICBsb2FkZWQucHVzaCh7XG4gICAgICAgICAgZW50cnksXG4gICAgICAgICAgZGlzcGxheSxcbiAgICAgICAgICBsb3dlcjogZGlzcGxheS50b0xvd2VyQ2FzZSgpLFxuICAgICAgICAgIGZpcnN0TGluZTogbmwgPT09IC0xID8gZGlzcGxheSA6IGRpc3BsYXkuc2xpY2UoMCwgbmwpLFxuICAgICAgICAgIGFnZTogYWdlICsgJyAnLnJlcGVhdChNYXRoLm1heCgwLCBBR0VfV0lEVEggLSBzdHJpbmdXaWR0aChhZ2UpKSksXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgICBpZiAoIWNhbmNlbGxlZCkgc2V0SXRlbXMobG9hZGVkKVxuICAgIH0pKClcbiAgICByZXR1cm4gKCkgPT4ge1xuICAgICAgY2FuY2VsbGVkID0gdHJ1ZVxuICAgIH1cbiAgfSwgW10pXG5cbiAgY29uc3QgZmlsdGVyZWQgPSB1c2VNZW1vKCgpID0+IHtcbiAgICBpZiAoIWl0ZW1zKSByZXR1cm4gW11cbiAgICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKClcbiAgICBpZiAoIXEpIHJldHVybiBpdGVtc1xuICAgIGNvbnN0IGV4YWN0OiBJdGVtW10gPSBbXVxuICAgIGNvbnN0IGZ1enp5OiBJdGVtW10gPSBbXVxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgaWYgKGl0ZW0ubG93ZXIuaW5jbHVkZXMocSkpIHtcbiAgICAgICAgZXhhY3QucHVzaChpdGVtKVxuICAgICAgfSBlbHNlIGlmIChpc1N1YnNlcXVlbmNlKGl0ZW0ubG93ZXIsIHEpKSB7XG4gICAgICAgIGZ1enp5LnB1c2goaXRlbSlcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGV4YWN0LmNvbmNhdChmdXp6eSlcbiAgfSwgW2l0ZW1zLCBxdWVyeV0pXG5cbiAgY29uc3QgcHJldmlld09uUmlnaHQgPSBjb2x1bW5zID49IDEwMFxuICBjb25zdCBsaXN0V2lkdGggPSBwcmV2aWV3T25SaWdodFxuICAgID8gTWF0aC5mbG9vcigoY29sdW1ucyAtIDYpICogMC41KVxuICAgIDogY29sdW1ucyAtIDZcbiAgY29uc3Qgcm93V2lkdGggPSBNYXRoLm1heCgyMCwgbGlzdFdpZHRoIC0gQUdFX1dJRFRIIC0gMSlcbiAgY29uc3QgcHJldmlld1dpZHRoID0gcHJldmlld09uUmlnaHRcbiAgICA/IE1hdGgubWF4KDIwLCBjb2x1bW5zIC0gbGlzdFdpZHRoIC0gMTIpXG4gICAgOiBNYXRoLm1heCgyMCwgY29sdW1ucyAtIDEwKVxuXG4gIHJldHVybiAoXG4gICAgPEZ1enp5UGlja2VyXG4gICAgICB0aXRsZT1cIlNlYXJjaCBwcm9tcHRzXCJcbiAgICAgIHBsYWNlaG9sZGVyPVwiRmlsdGVyIGhpc3RvcnnigKZcIlxuICAgICAgaW5pdGlhbFF1ZXJ5PXtpbml0aWFsUXVlcnl9XG4gICAgICBpdGVtcz17ZmlsdGVyZWR9XG4gICAgICBnZXRLZXk9e2l0ZW0gPT4gU3RyaW5nKGl0ZW0uZW50cnkudGltZXN0YW1wKX1cbiAgICAgIG9uUXVlcnlDaGFuZ2U9e3NldFF1ZXJ5fVxuICAgICAgb25TZWxlY3Q9e2l0ZW0gPT4ge1xuICAgICAgICBsb2dFdmVudCgndGVuZ3VfaGlzdG9yeV9waWNrZXJfc2VsZWN0Jywge1xuICAgICAgICAgIHJlc3VsdF9jb3VudDogZmlsdGVyZWQubGVuZ3RoLFxuICAgICAgICAgIHF1ZXJ5X2xlbmd0aDogcXVlcnkubGVuZ3RoLFxuICAgICAgICB9KVxuICAgICAgICB2b2lkIGl0ZW0uZW50cnkucmVzb2x2ZSgpLnRoZW4ob25TZWxlY3QpXG4gICAgICB9fVxuICAgICAgb25DYW5jZWw9e29uQ2FuY2VsfVxuICAgICAgZW1wdHlNZXNzYWdlPXtxID0+XG4gICAgICAgIGl0ZW1zID09PSBudWxsXG4gICAgICAgICAgPyAnTG9hZGluZ+KApidcbiAgICAgICAgICA6IHFcbiAgICAgICAgICAgID8gJ05vIG1hdGNoaW5nIHByb21wdHMnXG4gICAgICAgICAgICA6ICdObyBoaXN0b3J5IHlldCdcbiAgICAgIH1cbiAgICAgIHNlbGVjdEFjdGlvbj1cInVzZVwiXG4gICAgICBkaXJlY3Rpb249XCJ1cFwiXG4gICAgICBwcmV2aWV3UG9zaXRpb249e3ByZXZpZXdPblJpZ2h0ID8gJ3JpZ2h0JyA6ICdib3R0b20nfVxuICAgICAgcmVuZGVySXRlbT17KGl0ZW0sIGlzRm9jdXNlZCkgPT4gKFxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57aXRlbS5hZ2V9PC9UZXh0PlxuICAgICAgICAgIDxUZXh0IGNvbG9yPXtpc0ZvY3VzZWQgPyAnc3VnZ2VzdGlvbicgOiB1bmRlZmluZWR9PlxuICAgICAgICAgICAgeycgJ31cbiAgICAgICAgICAgIHt0cnVuY2F0ZVRvV2lkdGgoaXRlbS5maXJzdExpbmUsIHJvd1dpZHRoKX1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvVGV4dD5cbiAgICAgICl9XG4gICAgICByZW5kZXJQcmV2aWV3PXtpdGVtID0+IHtcbiAgICAgICAgY29uc3Qgd3JhcHBlZCA9IHdyYXBBbnNpKGl0ZW0uZGlzcGxheSwgcHJldmlld1dpZHRoLCB7IGhhcmQ6IHRydWUgfSlcbiAgICAgICAgICAuc3BsaXQoJ1xcbicpXG4gICAgICAgICAgLmZpbHRlcihsID0+IGwudHJpbSgpICE9PSAnJylcbiAgICAgICAgY29uc3Qgb3ZlcmZsb3cgPSB3cmFwcGVkLmxlbmd0aCA+IFBSRVZJRVdfUk9XU1xuICAgICAgICBjb25zdCBzaG93biA9IHdyYXBwZWQuc2xpY2UoXG4gICAgICAgICAgMCxcbiAgICAgICAgICBvdmVyZmxvdyA/IFBSRVZJRVdfUk9XUyAtIDEgOiBQUkVWSUVXX1JPV1MsXG4gICAgICAgIClcbiAgICAgICAgY29uc3QgbW9yZSA9IHdyYXBwZWQubGVuZ3RoIC0gc2hvd24ubGVuZ3RoXG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgPEJveFxuICAgICAgICAgICAgZmxleERpcmVjdGlvbj1cImNvbHVtblwiXG4gICAgICAgICAgICBib3JkZXJTdHlsZT1cInJvdW5kXCJcbiAgICAgICAgICAgIGJvcmRlckRpbUNvbG9yXG4gICAgICAgICAgICBwYWRkaW5nWD17MX1cbiAgICAgICAgICAgIGhlaWdodD17UFJFVklFV19ST1dTICsgMn1cbiAgICAgICAgICA+XG4gICAgICAgICAgICB7c2hvd24ubWFwKChyb3csIGkpID0+IChcbiAgICAgICAgICAgICAgPFRleHQga2V5PXtpfSBkaW1Db2xvcj5cbiAgICAgICAgICAgICAgICB7cm93fVxuICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICApKX1cbiAgICAgICAgICAgIHttb3JlID4gMCAmJiA8VGV4dCBkaW1Db2xvcj57YOKApiArJHttb3JlfSBtb3JlIGxpbmVzYH08L1RleHQ+fVxuICAgICAgICAgIDwvQm94PlxuICAgICAgICApXG4gICAgICB9fVxuICAgIC8+XG4gIClcbn1cblxuZnVuY3Rpb24gaXNTdWJzZXF1ZW5jZSh0ZXh0OiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgbGV0IGogPSAwXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdGV4dC5sZW5ndGggJiYgaiA8IHF1ZXJ5Lmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKHRleHRbaV0gPT09IHF1ZXJ5W2pdKSBqKytcbiAgfVxuICByZXR1cm4gaiA9PT0gcXVlcnkubGVuZ3RoXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsU0FBUyxFQUFFQyxPQUFPLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ3BELFNBQVNDLGtCQUFrQixRQUFRLDhCQUE4QjtBQUNqRSxTQUNFQyxxQkFBcUIsRUFDckIsS0FBS0MsdUJBQXVCLFFBQ3ZCLGVBQWU7QUFDdEIsU0FBU0MsZUFBZSxRQUFRLDZCQUE2QjtBQUM3RCxTQUFTQyxXQUFXLFFBQVEsdUJBQXVCO0FBQ25ELFNBQVNDLFFBQVEsUUFBUSxvQkFBb0I7QUFD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
