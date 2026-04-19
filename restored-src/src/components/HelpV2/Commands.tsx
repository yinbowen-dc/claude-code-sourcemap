/**
 * HelpV2/Commands.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件是帮助对话框（HelpV2）的子组件，负责渲染斜杠命令列表（内置命令或自定义命令）。
 * 由 HelpV2.tsx 通过三个选项卡分别传入不同命令集来调用。
 *
 * 主要功能：
 * 1. 对传入的命令列表进行去重（相同名称只保留一个）、按名称字母排序、截断描述文字
 * 2. 将命令列表渲染为可滚动的 Select 组件（只读浏览，不允许选择执行）
 * 3. 支持"空命令列表"时展示可配置的空白提示消息
 * 4. 与 Tabs 组件配合，实现从列表首项上移时将焦点转回选项卡标题栏
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useMemo } from 'react';
import { type Command, formatDescriptionWithSource } from '../../commands.js';
import { Box, Text } from '../../ink.js';
import { truncate } from '../../utils/format.js';
import { Select } from '../CustomSelect/select.js';
import { useTabHeaderFocus } from '../design-system/Tabs.js';

// 组件属性类型定义
type Props = {
  commands: Command[];      // 要展示的命令数组
  maxHeight: number;        // 终端可用最大高度（行数），用于计算可见条数
  columns: number;          // 终端宽度（列数），用于截断描述文字
  title: string;            // 列表标题文字
  onCancel: () => void;     // 用户按下取消键时的回调（关闭帮助对话框）
  emptyMessage?: string;    // 当命令列表为空时展示的提示文字（可选）
};

/**
 * Commands 组件
 *
 * 整体流程：
 * 1. 从 Tabs 上下文中获取 headerFocused / focusHeader，以支持焦点在标题栏和列表之间切换。
 * 2. 根据终端列数计算描述文字的最大可显示宽度（maxWidth）。
 * 3. 根据终端行数计算 Select 的可见条目数（visibleCount），避免列表溢出屏幕。
 * 4. 使用 React 编译器缓存（$[n] 槽位数组）对 options 计算结果进行记忆化，
 *    只有当 commands 或 maxWidth 变化时才重新计算。
 * 5. 渲染：若命令列表为空且提供了 emptyMessage，则只显示提示文字；
 *    否则渲染标题 + Select 命令列表。
 */
export function Commands(t0) {
  // React 编译器运行时：分配 14 个缓存槽位用于记忆化
  const $ = _c(14);
  const {
    commands,
    maxHeight,
    columns,
    title,
    onCancel,
    emptyMessage
  } = t0;

  // 从 Tabs 上下文获取标题栏焦点状态及聚焦函数
  const {
    headerFocused,
    focusHeader
  } = useTabHeaderFocus();

  // 计算命令描述的最大显示宽度：终端宽度减去边距（10），至少为 1
  const maxWidth = Math.max(1, columns - 10);

  // 计算 Select 可见条目数：可用高度（maxHeight - 10）除以每条目占 2 行，至少显示 1 条
  const visibleCount = Math.max(1, Math.floor((maxHeight - 10) / 2));

  let t1;
  // 记忆化：commands 或 maxWidth 变化时重新计算 options
  if ($[0] !== commands || $[1] !== maxWidth) {
    const seen = new Set(); // 用于去重：记录已处理过的命令名称

    let t2;
    // 内层记忆化：仅当 maxWidth 变化时重新生成映射函数
    if ($[3] !== maxWidth) {
      // 将每个命令映射为 Select 选项格式：label（带斜杠前缀）、value（命令名）、description（截断的描述）
      t2 = cmd_0 => ({
        label: `/${cmd_0.name}`,
        value: cmd_0.name,
        description: truncate(formatDescriptionWithSource(cmd_0), maxWidth, true)
      });
      $[3] = maxWidth;
      $[4] = t2;
    } else {
      t2 = $[4];
    }

    // 去重（同名命令如用户级和项目级自定义命令）→ 按名称字母排序 → 映射为选项对象
    t1 = commands.filter(cmd => {
      if (seen.has(cmd.name)) {
        return false; // 已存在同名命令，跳过
      }
      seen.add(cmd.name);
      return true;
    }).sort(_temp).map(t2); // _temp 为按名称排序的比较函数

    $[0] = commands;
    $[1] = maxWidth;
    $[2] = t1;
  } else {
    t1 = $[2]; // 命中缓存，直接复用
  }
  const options = t1;

  let t2;
  // 记忆化：任何影响渲染的 prop/状态变化时重新生成 JSX
  if ($[5] !== commands.length || $[6] !== emptyMessage || $[7] !== focusHeader || $[8] !== headerFocused || $[9] !== onCancel || $[10] !== options || $[11] !== title || $[12] !== visibleCount) {
    t2 = (
      <Box flexDirection="column" paddingY={1}>
        {/* 命令列表为空且有提示文字时，显示灰色空状态提示 */}
        {commands.length === 0 && emptyMessage
          ? <Text dimColor={true}>{emptyMessage}</Text>
          : (
            <>
              {/* 列表标题 */}
              <Text>{title}</Text>
              <Box marginTop={1}>
                {/* Select 组件：只读浏览模式，禁用选中执行，支持从首项上移到标题栏 */}
                <Select
                  options={options}
                  visibleOptionCount={visibleCount}
                  onCancel={onCancel}
                  disableSelection={true}   // 禁止选择执行命令
                  hideIndexes={true}        // 隐藏序号
                  layout="compact-vertical"  // 紧凑垂直布局
                  onUpFromFirstItem={focusHeader}  // 从首项上移时聚焦标题栏
                  isDisabled={headerFocused}       // 标题栏聚焦时禁用列表键盘响应
                />
              </Box>
            </>
          )}
      </Box>
    );
    $[5] = commands.length;
    $[6] = emptyMessage;
    $[7] = focusHeader;
    $[8] = headerFocused;
    $[9] = onCancel;
    $[10] = options;
    $[11] = title;
    $[12] = visibleCount;
    $[13] = t2;
  } else {
    t2 = $[13]; // 命中缓存，复用上次渲染结果
  }
  return t2;
}

/**
 * _temp — 命令排序比较函数
 * 按命令名称进行本地化字母序排序（locale-aware），供 Array.sort() 使用。
 */
function _temp(a, b) {
  return a.name.localeCompare(b.name);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZU1lbW8iLCJDb21tYW5kIiwiZm9ybWF0RGVzY3JpcHRpb25XaXRoU291cmNlIiwiQm94IiwiVGV4dCIsInRydW5jYXRlIiwiU2VsZWN0IiwidXNlVGFiSGVhZGVyRm9jdXMiLCJQcm9wcyIsImNvbW1hbmRzIiwibWF4SGVpZ2h0IiwiY29sdW1ucyIsInRpdGxlIiwib25DYW5jZWwiLCJlbXB0eU1lc3NhZ2UiLCJDb21tYW5kcyIsInQwIiwiJCIsIl9jIiwiaGVhZGVyRm9jdXNlZCIsImZvY3VzSGVhZGVyIiwibWF4V2lkdGgiLCJNYXRoIiwibWF4IiwidmlzaWJsZUNvdW50IiwiZmxvb3IiLCJ0MSIsInNlZW4iLCJTZXQiLCJ0MiIsImNtZF8wIiwibGFiZWwiLCJjbWQiLCJuYW1lIiwidmFsdWUiLCJkZXNjcmlwdGlvbiIsImZpbHRlciIsImhhcyIsImFkZCIsInNvcnQiLCJfdGVtcCIsIm1hcCIsIm9wdGlvbnMiLCJsZW5ndGgiLCJhIiwiYiIsImxvY2FsZUNvbXBhcmUiXSwic291cmNlcyI6WyJDb21tYW5kcy50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VNZW1vIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB0eXBlIENvbW1hbmQsIGZvcm1hdERlc2NyaXB0aW9uV2l0aFNvdXJjZSB9IGZyb20gJy4uLy4uL2NvbW1hbmRzLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdHJ1bmNhdGUgfSBmcm9tICcuLi8uLi91dGlscy9mb3JtYXQuanMnXG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuLi9DdXN0b21TZWxlY3Qvc2VsZWN0LmpzJ1xuaW1wb3J0IHsgdXNlVGFiSGVhZGVyRm9jdXMgfSBmcm9tICcuLi9kZXNpZ24tc3lzdGVtL1RhYnMuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGNvbW1hbmRzOiBDb21tYW5kW11cbiAgbWF4SGVpZ2h0OiBudW1iZXJcbiAgY29sdW1uczogbnVtYmVyXG4gIHRpdGxlOiBzdHJpbmdcbiAgb25DYW5jZWw6ICgpID0+IHZvaWRcbiAgZW1wdHlNZXNzYWdlPzogc3RyaW5nXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBDb21tYW5kcyh7XG4gIGNvbW1hbmRzLFxuICBtYXhIZWlnaHQsXG4gIGNvbHVtbnMsXG4gIHRpdGxlLFxuICBvbkNhbmNlbCxcbiAgZW1wdHlNZXNzYWdlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCB7IGhlYWRlckZvY3VzZWQsIGZvY3VzSGVhZGVyIH0gPSB1c2VUYWJIZWFkZXJGb2N1cygpXG4gIGNvbnN0IG1heFdpZHRoID0gTWF0aC5tYXgoMSwgY29sdW1ucyAtIDEwKVxuICBjb25zdCB2aXNpYmxlQ291bnQgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKChtYXhIZWlnaHQgLSAxMCkgLyAyKSlcblxuICBjb25zdCBvcHRpb25zID0gdXNlTWVtbygoKSA9PiB7XG4gICAgLy8gQ3VzdG9tIGNvbW1hbmRzIGNhbiBhcHBlYXIgbW9yZSB0aGFuIG9uY2UgKGUuZy4gc2FtZSBuYW1lIGF0IHVzZXIgYW5kXG4gICAgLy8gcHJvamVjdCBzY29wZSkuIERlZHVwZSBieSBuYW1lIHRvIGF2b2lkIFJlYWN0IGtleSBjb2xsaXNpb25zIGluIFNlbGVjdC5cbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KClcbiAgICByZXR1cm4gY29tbWFuZHNcbiAgICAgIC5maWx0ZXIoY21kID0+IHtcbiAgICAgICAgaWYgKHNlZW4uaGFzKGNtZC5uYW1lKSkgcmV0dXJuIGZhbHNlXG4gICAgICAgIHNlZW4uYWRkKGNtZC5uYW1lKVxuICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgfSlcbiAgICAgIC5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKVxuICAgICAgLm1hcChjbWQgPT4gKHtcbiAgICAgICAgbGFiZWw6IGAvJHtjbWQubmFtZX1gLFxuICAgICAgICB2YWx1ZTogY21kLm5hbWUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiB0cnVuY2F0ZShmb3JtYXREZXNjcmlwdGlvbldpdGhTb3VyY2UoY21kKSwgbWF4V2lkdGgsIHRydWUpLFxuICAgICAgfSkpXG4gIH0sIFtjb21tYW5kcywgbWF4V2lkdGhdKVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgcGFkZGluZ1k9ezF9PlxuICAgICAge2NvbW1hbmRzLmxlbmd0aCA9PT0gMCAmJiBlbXB0eU1lc3NhZ2UgPyAoXG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPntlbXB0eU1lc3NhZ2V9PC9UZXh0PlxuICAgICAgKSA6IChcbiAgICAgICAgPD5cbiAgICAgICAgICA8VGV4dD57dGl0bGV9PC9UZXh0PlxuICAgICAgICAgIDxCb3ggbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICAgIDxTZWxlY3RcbiAgICAgICAgICAgICAgb3B0aW9ucz17b3B0aW9uc31cbiAgICAgICAgICAgICAgdmlzaWJsZU9wdGlvbkNvdW50PXt2aXNpYmxlQ291bnR9XG4gICAgICAgICAgICAgIG9uQ2FuY2VsPXtvbkNhbmNlbH1cbiAgICAgICAgICAgICAgZGlzYWJsZVNlbGVjdGlvblxuICAgICAgICAgICAgICBoaWRlSW5kZXhlc1xuICAgICAgICAgICAgICBsYXlvdXQ9XCJjb21wYWN0LXZlcnRpY2FsXCJcbiAgICAgICAgICAgICAgb25VcEZyb21GaXJzdEl0ZW09e2ZvY3VzSGVhZGVyfVxuICAgICAgICAgICAgICBpc0Rpc2FibGVkPXtoZWFkZXJGb2N1c2VkfVxuICAgICAgICAgICAgLz5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgPC8+XG4gICAgICApfVxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLE9BQU8sUUFBUSxPQUFPO0FBQy9C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
