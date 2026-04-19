/**
 * UserResourceUpdateMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层，由 UserTextMessage 路由分发。
 * 当用户消息中包含 MCP 资源更新或轮询更新通知时（即
 * <mcp-resource-update> 或 <mcp-polling-update> XML 标签），
 * 调用本组件在终端 UI 中显示更新摘要列表。
 *
 * 【主要功能】
 * 1. parseUpdates(text)：从 XML 文本中解析出所有资源/轮询更新条目
 * 2. formatUri(uri)：将 URI 格式化为简洁显示形式（截断或仅显示文件名）
 * 3. UserResourceUpdateMessage：渲染更新列表，每行含刷新箭头、服务器名、目标和可选原因
 * 4. _temp(update, i)：map 回调，渲染单条更新行
 *
 * 【依赖】
 * - react/compiler-runtime: React 编译器运行时，提供 _c(N) 缓存数组
 * - @anthropic-ai/sdk: TextBlockParam 类型（消息文本块）
 * - constants/figures: REFRESH_ARROW 刷新箭头符号常量
 * - ink: 终端 UI 框架，Box/Text 组件
 */
import { c as _c } from "react/compiler-runtime";
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { REFRESH_ARROW } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';

// 组件 Props 类型定义
type Props = {
  addMargin: boolean;     // 是否在顶部添加 marginTop=1 的间距
  param: TextBlockParam;  // 包含 XML 更新标签的文本块参数
};

// 解析后的更新条目类型
type ParsedUpdate = {
  kind: 'resource' | 'polling';  // 更新类型：资源更新或轮询更新
  server: string;                 // MCP 服务器名称
  /** resource 更新时为 URI，polling 更新时为工具名 */
  target: string;
  reason?: string;                // 可选：更新原因说明
};

/**
 * parseUpdates — 从 XML 文本解析 MCP 更新条目
 *
 * 流程：
 * 1. 用 resourceRegex 匹配所有 <mcp-resource-update server="..." uri="..."> 标签
 *    - 捕获组 1：server 名称
 *    - 捕获组 2：uri 路径
 *    - 捕获组 3（可选）：<reason>...</reason> 内的原因文本
 * 2. 用 pollingRegex 匹配所有 <mcp-polling-update type="..." server="..." tool="..."> 标签
 *    - 捕获组 1：type（如 "tool"）
 *    - 捕获组 2：server 名称
 *    - 捕获组 3：tool 名称（作为 target）
 *    - 捕获组 4（可选）：<reason>...</reason> 内的原因文本
 * 3. 将两类更新依次追加到 updates 数组并返回
 */
function parseUpdates(text: string): ParsedUpdate[] {
  // 初始化更新列表
  const updates: ParsedUpdate[] = [];

  // 匹配 <mcp-resource-update server="..." uri="..."> 标签，可选含 <reason> 子标签
  const resourceRegex = /<mcp-resource-update\s+server="([^"]+)"\s+uri="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  let match;
  // 循环提取所有资源更新条目
  while ((match = resourceRegex.exec(text)) !== null) {
    updates.push({
      kind: 'resource',
      server: match[1] ?? '',  // 服务器名，缺省为空字符串
      target: match[2] ?? '',  // URI 路径，缺省为空字符串
      reason: match[3]         // 可选更新原因（undefined 表示无）
    });
  }

  // 匹配 <mcp-polling-update type="tool" server="..." tool="..."> 标签，可选含 <reason> 子标签
  const pollingRegex = /<mcp-polling-update\s+type="([^"]+)"\s+server="([^"]+)"\s+tool="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  // 循环提取所有轮询更新条目（注意捕获组偏移：match[2]=server, match[3]=tool, match[4]=reason）
  while ((match = pollingRegex.exec(text)) !== null) {
    updates.push({
      kind: 'polling',
      server: match[2] ?? '',  // 捕获组 2 为服务器名
      target: match[3] ?? '',  // 捕获组 3 为工具名（作为 target）
      reason: match[4]         // 捕获组 4 为可选原因
    });
  }
  return updates;
}

/**
 * formatUri — 将 URI 格式化为简洁的终端显示形式
 *
 * 规则：
 * 1. file:// URI → 去掉协议前缀，取路径的最后一段（文件名）
 * 2. 其他 URI 且长度 > 40 → 截断到前 39 字符并追加省略号（\u2026）
 * 3. 其他 URI 且长度 ≤ 40 → 原样返回
 */
function formatUri(uri: string): string {
  // file:// URI：仅显示文件名部分，去掉目录路径
  if (uri.startsWith('file://')) {
    const path = uri.slice(7);          // 去掉 "file://" 前缀（7个字符）
    const parts = path.split('/');      // 按路径分隔符拆分
    return parts[parts.length - 1] || path;  // 取最后一段；若为空则回退到完整路径
  }
  // 非 file:// URI 且超过 40 字符时截断并添加省略号
  if (uri.length > 40) {
    return uri.slice(0, 39) + '\u2026';  // \u2026 = "…" 省略号
  }
  // 短 URI 原样返回
  return uri;
}

/**
 * UserResourceUpdateMessage — MCP 资源/轮询更新渲染组件
 *
 * 流程：
 * 1. 解构 addMargin 和 param.text
 * 2. 依赖 (addMargin, text) 变化时重新计算：
 *    a. parseUpdates(text) → updates 数组
 *    b. 若 updates 为空 → early_return_sentinel 置为 null（渲染空）
 *    c. 否则设置 T0=Box, t2="column", t3=marginTop, t4=updates.map(_temp)
 * 3. 检测 early_return_sentinel：若非哨兵值则提前返回（null 或其他短路值）
 * 4. 将 T0/t2/t3/t4 组合为 <Box flexDirection="column" marginTop={t3}>{t4}</Box>
 *    并缓存到 $[7..11]
 *
 * React 编译器优化：_c(12)，缓存依赖计算结果（$[0..6]）和最终 Box 节点（$[7..11]）
 * early_return_sentinel 用于在 updates 为空时提前返回 null，同时不违反 Hook 规则
 */
export function UserResourceUpdateMessage(t0) {
  // React 编译器注入的缓存数组，共 12 个槽位
  const $ = _c(12);
  const {
    addMargin,
    param: t1  // t1 = param（TextBlockParam 对象）
  } = t0;
  const {
    text  // 解构出 param.text（含 XML 更新标签的文本）
  } = t1;

  // 声明中间变量
  let T0;   // 容器组件（Box）
  let t2;   // flexDirection 值（"column"）
  let t3;   // marginTop 值（0 或 1）
  let t4;   // 更新列表节点（updates.map(_temp) 结果）
  let t5;   // early_return_sentinel 或 null（用于条件提前返回）

  // 当 addMargin 或 text 发生变化时重新计算所有依赖值
  if ($[0] !== addMargin || $[1] !== text) {
    // 初始化为 early_return_sentinel，进入 bb0 块可能将其改为 null（提前返回）
    t5 = Symbol.for("react.early_return_sentinel");
    bb0: {
      // 解析文本中的所有 MCP 更新条目
      const updates = parseUpdates(text);
      // 若无更新条目则置为 null 并跳出 bb0（触发提前返回）
      if (updates.length === 0) {
        t5 = null;
        break bb0;
      }
      // 设置容器组件和布局参数
      T0 = Box;            // 使用 Box 作为容器（动态赋值以便编译器追踪）
      t2 = "column";       // 纵向排列子项
      t3 = addMargin ? 1 : 0;          // 根据 addMargin 决定顶部间距
      t4 = updates.map(_temp);          // 渲染每条更新行
    }
    // 将计算结果写入缓存槽位 $[0..6]
    $[0] = addMargin;
    $[1] = text;
    $[2] = T0;
    $[3] = t2;
    $[4] = t3;
    $[5] = t4;
    $[6] = t5;
  } else {
    // 依赖未变，从缓存中读取所有中间变量
    T0 = $[2];
    t2 = $[3];
    t3 = $[4];
    t4 = $[5];
    t5 = $[6];
  }

  // 若 t5 不是哨兵值（即被赋为 null），则提前返回（不渲染任何内容）
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }

  // 构建最终外层容器节点；依赖 T0/t2/t3/t4 任一变化时重建
  let t6;
  if ($[7] !== T0 || $[8] !== t2 || $[9] !== t3 || $[10] !== t4) {
    // 动态组件 T0（=Box），纵向排列，顶部间距由 t3 决定，子节点为更新列表
    t6 = <T0 flexDirection={t2} marginTop={t3}>{t4}</T0>;
    $[7] = T0;
    $[8] = t2;
    $[9] = t3;
    $[10] = t4;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  return t6;
}

/**
 * _temp — updates.map() 的回调函数，渲染单条更新行
 *
 * 每行布局（从左到右）：
 * - REFRESH_ARROW（success 颜色）：刷新/更新箭头图标
 * - 空格
 * - update.server + ":"（dimColor）：MCP 服务器名（灰色显示）
 * - 空格
 * - target（suggestion 颜色）：resource 类型显示 formatUri(target)，polling 类型显示工具名
 * - update.reason（可选，dimColor）：若存在则以 " · reason" 形式追加（中点分隔）
 *
 * 注意：此函数被提升到模块级别（React 编译器优化），避免在每次渲染时创建新的函数引用。
 */
function _temp(update, i) {
  return <Box key={i}><Text><Text color="success">{REFRESH_ARROW}</Text>{" "}<Text dimColor={true}>{update.server}:</Text>{" "}<Text color="suggestion">{update.kind === "resource" ? formatUri(update.target) : update.target}</Text>{update.reason && <Text dimColor={true}> · {update.reason}</Text>}</Text></Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUZXh0QmxvY2tQYXJhbSIsIlJlYWN0IiwiUkVGUkVTSF9BUlJPVyIsIkJveCIsIlRleHQiLCJQcm9wcyIsImFkZE1hcmdpbiIsInBhcmFtIiwiUGFyc2VkVXBkYXRlIiwia2luZCIsInNlcnZlciIsInRhcmdldCIsInJlYXNvbiIsInBhcnNlVXBkYXRlcyIsInRleHQiLCJ1cGRhdGVzIiwicmVzb3VyY2VSZWdleCIsIm1hdGNoIiwiZXhlYyIsInB1c2giLCJwb2xsaW5nUmVnZXgiLCJmb3JtYXRVcmkiLCJ1cmkiLCJzdGFydHNXaXRoIiwicGF0aCIsInNsaWNlIiwicGFydHMiLCJzcGxpdCIsImxlbmd0aCIsIlVzZXJSZXNvdXJjZVVwZGF0ZU1lc3NhZ2UiLCJ0MCIsIiQiLCJfYyIsInQxIiwiVDAiLCJ0MiIsInQzIiwidDQiLCJ0NSIsIlN5bWJvbCIsImZvciIsImJiMCIsIm1hcCIsIl90ZW1wIiwidDYiLCJ1cGRhdGUiLCJpIl0sInNvdXJjZXMiOlsiVXNlclJlc291cmNlVXBkYXRlTWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUZXh0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFJFRlJFU0hfQVJST1cgfSBmcm9tICcuLi8uLi9jb25zdGFudHMvZmlndXJlcy5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgYWRkTWFyZ2luOiBib29sZWFuXG4gIHBhcmFtOiBUZXh0QmxvY2tQYXJhbVxufVxuXG50eXBlIFBhcnNlZFVwZGF0ZSA9IHtcbiAga2luZDogJ3Jlc291cmNlJyB8ICdwb2xsaW5nJ1xuICBzZXJ2ZXI6IHN0cmluZ1xuICAvKiogVVJJIGZvciByZXNvdXJjZSB1cGRhdGVzLCB0b29sIG5hbWUgZm9yIHBvbGxpbmcgdXBkYXRlcyAqL1xuICB0YXJnZXQ6IHN0cmluZ1xuICByZWFzb24/OiBzdHJpbmdcbn1cblxuLy8gUGFyc2UgcmVzb3VyY2UgYW5kIHBvbGxpbmcgdXBkYXRlcyBmcm9tIFhNTCBmb3JtYXRcbmZ1bmN0aW9uIHBhcnNlVXBkYXRlcyh0ZXh0OiBzdHJpbmcpOiBQYXJzZWRVcGRhdGVbXSB7XG4gIGNvbnN0IHVwZGF0ZXM6IFBhcnNlZFVwZGF0ZVtdID0gW11cblxuICAvLyBNYXRjaCA8bWNwLXJlc291cmNlLXVwZGF0ZSBzZXJ2ZXI9XCIuLi5cIiB1cmk9XCIuLi5cIj5cbiAgY29uc3QgcmVzb3VyY2VSZWdleCA9XG4gICAgLzxtY3AtcmVzb3VyY2UtdXBkYXRlXFxzK3NlcnZlcj1cIihbXlwiXSspXCJcXHMrdXJpPVwiKFteXCJdKylcIltePl0qPig/OltcXHNcXFNdKj88cmVhc29uPihbXjxdKyk8XFwvcmVhc29uPik/L2dcbiAgbGV0IG1hdGNoXG4gIHdoaWxlICgobWF0Y2ggPSByZXNvdXJjZVJlZ2V4LmV4ZWModGV4dCkpICE9PSBudWxsKSB7XG4gICAgdXBkYXRlcy5wdXNoKHtcbiAgICAgIGtpbmQ6ICdyZXNvdXJjZScsXG4gICAgICBzZXJ2ZXI6IG1hdGNoWzFdID8/ICcnLFxuICAgICAgdGFyZ2V0OiBtYXRjaFsyXSA/PyAnJyxcbiAgICAgIHJlYXNvbjogbWF0Y2hbM10sXG4gICAgfSlcbiAgfVxuXG4gIC8vIE1hdGNoIDxtY3AtcG9sbGluZy11cGRhdGUgdHlwZT1cInRvb2xcIiBzZXJ2ZXI9XCIuLi5cIiB0b29sPVwiLi4uXCI+XG4gIGNvbnN0IHBvbGxpbmdSZWdleCA9XG4gICAgLzxtY3AtcG9sbGluZy11cGRhdGVcXHMrdHlwZT1cIihbXlwiXSspXCJcXHMrc2VydmVyPVwiKFteXCJdKylcIlxccyt0b29sPVwiKFteXCJdKylcIltePl0qPig/OltcXHNcXFNdKj88cmVhc29uPihbXjxdKyk8XFwvcmVhc29uPik/L2dcbiAgd2hpbGUgKChtYXRjaCA9IHBvbGxpbmdSZWdleC5leGVjKHRleHQpKSAhPT0gbnVsbCkge1xuICAgIHVwZGF0ZXMucHVzaCh7XG4gICAgICBraW5kOiAncG9sbGluZycsXG4gICAgICBzZXJ2ZXI6IG1hdGNoWzJdID8/ICcnLFxuICAgICAgdGFyZ2V0OiBtYXRjaFszXSA/PyAnJyxcbiAgICAgIHJlYXNvbjogbWF0Y2hbNF0sXG4gICAgfSlcbiAgfVxuXG4gIHJldHVybiB1cGRhdGVzXG59XG5cbi8vIEZvcm1hdCBVUkkgZm9yIGRpc3BsYXkgLSBzaG93IGp1c3QgdGhlIG1lYW5pbmdmdWwgcGFydFxuZnVuY3Rpb24gZm9ybWF0VXJpKHVyaTogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8gRm9yIGZpbGU6Ly8gVVJJcywgc2hvdyBqdXN0IHRoZSBmaWxlbmFtZVxuICBpZiAodXJpLnN0YXJ0c1dpdGgoJ2ZpbGU6Ly8nKSkge1xuICAgIGNvbnN0IHBhdGggPSB1cmkuc2xpY2UoNylcbiAgICBjb25zdCBwYXJ0cyA9IHBhdGguc3BsaXQoJy8nKVxuICAgIHJldHVybiBwYXJ0c1twYXJ0cy5sZW5ndGggLSAxXSB8fCBwYXRoXG4gIH1cbiAgLy8gRm9yIG90aGVyIFVSSXMsIHNob3cgdGhlIHdob2xlIHRoaW5nIGJ1dCB0cnVuY2F0ZWRcbiAgaWYgKHVyaS5sZW5ndGggPiA0MCkge1xuICAgIHJldHVybiB1cmkuc2xpY2UoMCwgMzkpICsgJ1xcdTIwMjYnXG4gIH1cbiAgcmV0dXJuIHVyaVxufVxuXG5leHBvcnQgZnVuY3Rpb24gVXNlclJlc291cmNlVXBkYXRlTWVzc2FnZSh7XG4gIGFkZE1hcmdpbixcbiAgcGFyYW06IHsgdGV4dCB9LFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCB1cGRhdGVzID0gcGFyc2VVcGRhdGVzKHRleHQpXG4gIGlmICh1cGRhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGxcblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9PlxuICAgICAge3VwZGF0ZXMubWFwKCh1cGRhdGUsIGkpID0+IChcbiAgICAgICAgPEJveCBrZXk9e2l9PlxuICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgPFRleHQgY29sb3I9XCJzdWNjZXNzXCI+e1JFRlJFU0hfQVJST1d9PC9UZXh0PnsnICd9XG4gICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57dXBkYXRlLnNlcnZlcn06PC9UZXh0PnsnICd9XG4gICAgICAgICAgICA8VGV4dCBjb2xvcj1cInN1Z2dlc3Rpb25cIj5cbiAgICAgICAgICAgICAge3VwZGF0ZS5raW5kID09PSAncmVzb3VyY2UnXG4gICAgICAgICAgICAgICAgPyBmb3JtYXRVcmkodXBkYXRlLnRhcmdldClcbiAgICAgICAgICAgICAgICA6IHVwZGF0ZS50YXJnZXR9XG4gICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICB7dXBkYXRlLnJlYXNvbiAmJiA8VGV4dCBkaW1Db2xvcj4gwrcge3VwZGF0ZS5yZWFzb259PC9UZXh0Pn1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKSl9XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLGNBQWMsUUFBUSx1Q0FBdUM7QUFDM0UsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxhQUFhLFFBQVEsNEJBQTRCO0FBQzFELFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFFekMsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLFNBQVMsRUFBRSxPQUFPO0VBQ2xCQyxLQUFLLEVBQUVQLGNBQWM7QUFDdkIsQ0FBQztBQUVELEtBQUtRLFlBQVksR0FBRztFQUNsQkMsSUFBSSxFQUFFLFVBQVUsR0FBRyxTQUFTO0VBQzVCQyxNQUFNLEVBQUUsTUFBTTtFQUNkO0VBQ0FDLE1BQU0sRUFBRSxNQUFNO0VBQ2RDLE1BQU0sQ0FBQyxFQUFFLE1BQU07QUFDakIsQ0FBQzs7QUFFRDtB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
