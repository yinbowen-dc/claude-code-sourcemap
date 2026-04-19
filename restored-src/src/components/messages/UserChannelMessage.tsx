/**
 * UserChannelMessage.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件属于"用户消息渲染层"，负责将 MCP（Model Context Protocol）频道推送
 * 消息（<channel>…</channel> XML 格式）转化为终端可见的 Ink UI 元素。
 * 由 UserTextMessage → UserChannelMessage 调用链驱动，仅在启用
 * KAIROS 或 KAIROS_CHANNELS 特性标志时才会被渲染。
 *
 * 主要功能：
 * 1. 使用正则表达式解析 <channel source="…" user="…"> 格式的 XML 文本块
 * 2. 提取来源服务器名、可选用户名以及消息正文
 * 3. 对插件前缀服务器名（如 plugin:slack-channel:slack）仅展示叶节点部分
 * 4. 截断过长的消息正文，防止终端布局溢出
 * 5. 使用 React Compiler 的记忆缓存（_c）进行细粒度性能优化
 */

import { c as _c } from "react/compiler-runtime";
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { CHANNEL_ARROW } from '../../constants/figures.js';
import { CHANNEL_TAG } from '../../constants/xml.js';
import { Box, Text } from '../../ink.js';
import { truncateToWidth } from '../../utils/format.js';

// Props 类型定义：addMargin 控制顶部外边距，param 为 Anthropic SDK 文本块参数
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

// <channel source="..." user="..." chat_id="...">content</channel>
// source 字段始终排在最前（由 wrapChannelMessage 写入），user 字段可选。
// 正则表达式从整个文本块中提取：来源服务器、附加属性（含 user）、消息正文
const CHANNEL_RE = new RegExp(`<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`);

// 用于从附加属性字符串中单独提取 user 属性值
const USER_ATTR_RE = /\buser="([^"]+)"/;

/**
 * displayServerName — 服务器名显示处理函数
 *
 * 流程说明：
 * 插件提供的服务器名格式为 "plugin:slack-channel:slack"（由 addPluginScopeToServers 添加前缀），
 * 此处只展示冒号分隔的最后一段（叶节点），与 isServerInChannels 中的后缀匹配逻辑保持一致。
 *
 * @param name - 原始服务器名称字符串
 * @returns 处理后只含叶节点的显示名称
 */
function displayServerName(name: string): string {
  // 找到最后一个冒号的位置，若不存在则直接返回原字符串
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

// 消息正文在终端中的最大显示宽度（字符数），超出则截断
const TRUNCATE_AT = 60;

/**
 * UserChannelMessage — 频道消息渲染组件
 *
 * 完整渲染流程：
 * 1. 使用 React Compiler 缓存（_c(29)）检测 addMargin / text 是否变更
 * 2. 通过 CHANNEL_RE 对 text 执行正则匹配，提取 source、attrs、content
 * 3. 若匹配失败则提前返回 null（不渲染任何内容）
 * 4. 从 attrs 中提取可选的 user 属性
 * 5. 对 content 进行清理（trim + 压缩空白）后截断至 TRUNCATE_AT 字符
 * 6. 渲染为带频道箭头图标 + "服务器名·用户名：消息" 格式的 Ink 文本行
 */
export function UserChannelMessage(t0) {
  // React Compiler 自动记忆缓存，共 29 个插槽
  const $ = _c(29);
  const {
    addMargin,
    param: t1
  } = t0;
  const {
    text
  } = t1;

  // 声明将在缓存块内赋值的变量
  let T0;
  let T1;
  let T2;
  let t2;
  let t3;
  let t4;
  let t5;
  let t6;
  let t7;
  let truncated;
  let user;

  // 仅当 addMargin 或 text 发生变化时重新计算，否则使用缓存值
  if ($[0] !== addMargin || $[1] !== text) {
    // 设置提前返回哨兵值，默认表示"提前返回"
    t7 = Symbol.for("react.early_return_sentinel");
    bb0: {
      // 执行正则匹配，提取频道消息结构
      const m = CHANNEL_RE.exec(text);
      if (!m) {
        // 文本中没有 <channel> 标签，返回 null
        t7 = null;
        break bb0;
      }
      // 解构正则匹配结果：来源服务器、附加属性字符串、消息正文
      const [, source, attrs, content] = m;
      // 从附加属性中提取可选的 user 字段
      user = USER_ATTR_RE.exec(attrs ?? "")?.[1];
      // 清理正文：去首尾空白并将连续空白压缩为单个空格
      const body = (content ?? "").trim().replace(/\s+/g, " ");
      // 截断正文到指定终端宽度
      truncated = truncateToWidth(body, TRUNCATE_AT);
      T2 = Box;
      // 根据 addMargin 决定顶部外边距
      t6 = addMargin ? 1 : 0;
      T1 = Text;
      // 频道箭头图标文本节点（静态，缓存到插槽 13）
      if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
        t4 = <Text color="suggestion">{CHANNEL_ARROW}</Text>;
        $[13] = t4;
      } else {
        t4 = $[13];
      }
      t5 = " ";  // 箭头与服务器名之间的空格分隔符
      T0 = Text;
      t2 = true;  // 服务器名使用 dimColor 样式
      // 对服务器名进行叶节点截取处理
      t3 = displayServerName(source ?? "");
    }
    // 将所有计算结果写入缓存插槽
    $[0] = addMargin;
    $[1] = text;
    $[2] = T0;
    $[3] = T1;
    $[4] = T2;
    $[5] = t2;
    $[6] = t3;
    $[7] = t4;
    $[8] = t5;
    $[9] = t6;
    $[10] = t7;
    $[11] = truncated;
    $[12] = user;
  } else {
    // 使用缓存值
    T0 = $[2];
    T1 = $[3];
    T2 = $[4];
    t2 = $[5];
    t3 = $[6];
    t4 = $[7];
    t5 = $[8];
    t6 = $[9];
    t7 = $[10];
    truncated = $[11];
    user = $[12];
  }

  // 若满足提前返回条件（t7 不为哨兵值），直接返回（null 或其他值）
  if (t7 !== Symbol.for("react.early_return_sentinel")) {
    return t7;
  }

  // 构造用户名后缀字符串：" · 用户名" 或 空字符串
  const t8 = user ? ` \u00b7 ${user}` : "";

  // 构建服务器名+用户名的暗色文本节点（缓存）
  let t9;
  if ($[14] !== T0 || $[15] !== t2 || $[16] !== t3 || $[17] !== t8) {
    t9 = <T0 dimColor={t2}>{t3}{t8}:</T0>;
    $[14] = T0;
    $[15] = t2;
    $[16] = t3;
    $[17] = t8;
    $[18] = t9;
  } else {
    t9 = $[18];
  }

  // 构建完整的文本行：箭头 + 空格 + 服务器名:用户名 + 空格 + 截断后正文（缓存）
  let t10;
  if ($[19] !== T1 || $[20] !== t4 || $[21] !== t5 || $[22] !== t9 || $[23] !== truncated) {
    t10 = <T1>{t4}{t5}{t9}{" "}{truncated}</T1>;
    $[19] = T1;
    $[20] = t4;
    $[21] = t5;
    $[22] = t9;
    $[23] = truncated;
    $[24] = t10;
  } else {
    t10 = $[24];
  }

  // 最外层 Box 容器，控制顶部外边距（缓存）
  let t11;
  if ($[25] !== T2 || $[26] !== t10 || $[27] !== t6) {
    t11 = <T2 marginTop={t6}>{t10}</T2>;
    $[25] = T2;
    $[26] = t10;
    $[27] = t6;
    $[28] = t11;
  } else {
    t11 = $[28];
  }
  return t11;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUZXh0QmxvY2tQYXJhbSIsIlJlYWN0IiwiQ0hBTk5FTF9BUlJPVyIsIkNIQU5ORUxfVEFHIiwiQm94IiwiVGV4dCIsInRydW5jYXRlVG9XaWR0aCIsIlByb3BzIiwiYWRkTWFyZ2luIiwicGFyYW0iLCJDSEFOTkVMX1JFIiwiUmVnRXhwIiwiVVNFUl9BVFRSX1JFIiwiZGlzcGxheVNlcnZlck5hbWUiLCJuYW1lIiwiaSIsImxhc3RJbmRleE9mIiwic2xpY2UiLCJUUlVOQ0FURV9BVCIsIlVzZXJDaGFubmVsTWVzc2FnZSIsInQwIiwiJCIsIl9jIiwidDEiLCJ0ZXh0IiwiVDAiLCJUMSIsIlQyIiwidDIiLCJ0MyIsInQ0IiwidDUiLCJ0NiIsInQ3IiwidHJ1bmNhdGVkIiwidXNlciIsIlN5bWJvbCIsImZvciIsImJiMCIsIm0iLCJleGVjIiwic291cmNlIiwiYXR0cnMiLCJjb250ZW50IiwiYm9keSIsInRyaW0iLCJyZXBsYWNlIiwidDgiLCJ0OSIsInQxMCIsInQxMSJdLCJzb3VyY2VzIjpbIlVzZXJDaGFubmVsTWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUZXh0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IENIQU5ORUxfQVJST1cgfSBmcm9tICcuLi8uLi9jb25zdGFudHMvZmlndXJlcy5qcydcbmltcG9ydCB7IENIQU5ORUxfVEFHIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL3htbC5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHRydW5jYXRlVG9XaWR0aCB9IGZyb20gJy4uLy4uL3V0aWxzL2Zvcm1hdC5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgYWRkTWFyZ2luOiBib29sZWFuXG4gIHBhcmFtOiBUZXh0QmxvY2tQYXJhbVxufVxuXG4vLyA8Y2hhbm5lbCBzb3VyY2U9XCIuLi5cIiB1c2VyPVwiLi4uXCIgY2hhdF9pZD1cIi4uLlwiPmNvbnRlbnQ8L2NoYW5uZWw+XG4vLyBzb3VyY2UgaXMgYWx3YXlzIGZpcnN0ICh3cmFwQ2hhbm5lbE1lc3NhZ2Ugd3JpdGVzIGl0KSwgdXNlciBpcyBvcHRpb25hbC5cbmNvbnN0IENIQU5ORUxfUkUgPSBuZXcgUmVnRXhwKFxuICBgPCR7Q0hBTk5FTF9UQUd9XFxcXHMrc291cmNlPVwiKFteXCJdKylcIihbXj5dKik+XFxcXG4/KFtcXFxcc1xcXFxTXSo/KVxcXFxuPzwvJHtDSEFOTkVMX1RBR30+YCxcbilcbmNvbnN0IFVTRVJfQVRUUl9SRSA9IC9cXGJ1c2VyPVwiKFteXCJdKylcIi9cblxuLy8gUGx1Z2luLXByb3ZpZGVkIHNlcnZlcnMgZ2V0IG5hbWVzIGxpa2UgcGx1Z2luOnNsYWNrLWNoYW5uZWw6c2xhY2sgdmlhXG4vLyBhZGRQbHVnaW5TY29wZVRvU2VydmVycyDigJQgc2hvdyBqdXN0IHRoZSBsZWFmLiBNYXRjaGVzIHRoZSBzdWZmaXgtbWF0Y2hcbi8vIGxvZ2ljIGluIGlzU2VydmVySW5DaGFubmVscy5cbmZ1bmN0aW9uIGRpc3BsYXlTZXJ2ZXJOYW1lKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGkgPSBuYW1lLmxhc3RJbmRleE9mKCc6JylcbiAgcmV0dXJuIGkgPT09IC0xID8gbmFtZSA6IG5hbWUuc2xpY2UoaSArIDEpXG59XG5cbmNvbnN0IFRSVU5DQVRFX0FUID0gNjBcblxuZXhwb3J0IGZ1bmN0aW9uIFVzZXJDaGFubmVsTWVzc2FnZSh7XG4gIGFkZE1hcmdpbixcbiAgcGFyYW06IHsgdGV4dCB9LFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBtID0gQ0hBTk5FTF9SRS5leGVjKHRleHQpXG4gIGlmICghbSkgcmV0dXJuIG51bGxcbiAgY29uc3QgWywgc291cmNlLCBhdHRycywgY29udGVudF0gPSBtXG4gIGNvbnN0IHVzZXIgPSBVU0VSX0FUVFJfUkUuZXhlYyhhdHRycyA/PyAnJyk/LlsxXVxuICBjb25zdCBib2R5ID0gKGNvbnRlbnQgPz8gJycpLnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgY29uc3QgdHJ1bmNhdGVkID0gdHJ1bmNhdGVUb1dpZHRoKGJvZHksIFRSVU5DQVRFX0FUKVxuICByZXR1cm4gKFxuICAgIDxCb3ggbWFyZ2luVG9wPXthZGRNYXJnaW4gPyAxIDogMH0+XG4gICAgICA8VGV4dD5cbiAgICAgICAgPFRleHQgY29sb3I9XCJzdWdnZXN0aW9uXCI+e0NIQU5ORUxfQVJST1d9PC9UZXh0PnsnICd9XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICAgIHtkaXNwbGF5U2VydmVyTmFtZShzb3VyY2UgPz8gJycpfVxuICAgICAgICAgIHt1c2VyID8gYCBcXHUwMGI3ICR7dXNlcn1gIDogJyd9OlxuICAgICAgICA8L1RleHQ+eycgJ31cbiAgICAgICAge3RydW5jYXRlZH1cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsY0FBY0EsY0FBYyxRQUFRLHVDQUF1QztBQUMzRSxPQUFPLEtBQUtDLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLGFBQWEsUUFBUSw0QkFBNEI7QUFDMUQsU0FBU0MsV0FBVyxRQUFRLHdCQUF3QjtBQUNwRCxTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLFNBQVNDLGVBQWUsUUFBUSx1QkFBdUI7QUFFdkQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLFNBQVMsRUFBRSxPQUFPO0VBQ2xCQyxLQUFLLEVBQUVULGNBQWM7QUFDdkIsQ0FBQzs7QUFFRDtBQUNBO0FBQ0EsTUFBTVUsVUFBVSxHQUFHLElBQUlDLE1BQU0sQ0FDM0IsSUFBSVIsV0FBVyxxREFBcURBLFdBQVcsR0FDakYsQ0FBQztBQUNELE1BQU1TLFlBQVksR0FBRyxrQkFBa0I7O0FBRXZDO0FBQ0E7QUFDQTtBQUNBLFNBQVNDLGlCQUFpQkEsQ0FBQ0MsSUFBSSxFQUFFLE1BQU0sQ0FBQyxFQUFFLE1BQU0sQ0FBQztFQUMvQyxNQUFNQyxDQUFDLEdBQUdELElBQUksQ0FBQ0UsV0FBVyxDQUFDLEdBQUcsQ0FBQztFQUMvQixPQUFPRCxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUdELElBQUksR0FBR0EsSUFBSSxDQUFDRyxLQUFLLENBQUNGLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDNUM7QUFFQSxNQUFNRyxXQUFXLEdBQUcsRUFBRTtBQUV0QixPQUFPLFNBQUFDLG1CQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQTRCO0lBQUFkLFNBQUE7SUFBQUMsS0FBQSxFQUFBYztFQUFBLElBQUFILEVBRzNCO0VBREM7SUFBQUk7RUFBQSxJQUFBRCxFQUFRO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBQyxTQUFBO0VBQUEsSUFBQUMsSUFBQTtFQUFBLElBQUFkLENBQUEsUUFBQWIsU0FBQSxJQUFBYSxDQUFBLFFBQUFHLElBQUE7SUFHQVMsRUFBQSxHQUFBR01BQUksQ0FBQUMsR0FBQSxDQUFKLDZCQUFHLENBQUM7SUFBQUMsR0FBQTtNQUVuQixNQUFBQyxDQUFBLEdBQVU3QixVQUFVLENBQUM4QixJQUFLLENBQUNoQixJQUFJLENBQUM7TUFDaEMsSUFBSSxDQUFDZSxDQUFDO1FBQVNOLEVBQUEsT0FBSTtRQUFKLE1BQUFLLEdBQUE7TUFBSTtNQUNuQixTQUFBRyxNQUFBLEVBQUFDLEtBQUEsRUFBQUMsT0FBQSxJQUFtQ0osQ0FBQztNQUNwQ0osSUFBQSxHQUFhdkIsWUFBWSxDQUFBNEIsSUFBSyxDQUFDRSxLQUFXLElBQVgsRUFBZ0IsQ0FBQztNQUNoRCxNQUFBRSxJQUFBLEdBQWEsQ0FBQ0QsT0FBYSxJQUFiLEVBQWEsRUFBQUUsSUFBTSxDQUFDLENBQUMsQ0FBQUMsT0FBUSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUM7TUFDeERaLFNBQUEsR0FBa0I1QixlQUFlLENBQUNzQyxJQUFJLEVBQUUxQixXQUFXLENBQUM7TUFFakRTLEVBQUEsR0FBQXZCLE1BQVk7TUFBQTRCLEVBQUF4QixTQUFTLEdBQVQsQ0FBaUIsR0FBakIsQ0FBaUI7TUFDOUJrQixFQUFBLEdBQUFyQixNQUFJO01BQUEsSUFBQWdCLENBQUEsU0FBQWUsTUFBQSxDQUFBQyxHQUFBO1FBQ0hQLEVBQUEsSUFBQyxJQUFJLENBQU8sS0FBWSxDQUFaLFlBQVksQ0FBRTVCLGNBQVksQ0FBRSxFQUF2QyxJQUFJLENBQTBDO1FBQUFtQixDQUFBLE9BQUFTLEVBQUE7TUFBQTtRQUFBQSxFQUFBLEdBQUFULENBQUE7TUFBQTtNQUFDVSxFQUFBLE1BQUc7TUFDbERORixFQUFBLEdBQUFwQixNQUFJO01BQUNxQixFQUFBLE9BQVE7TUFDWEMsRUFBQSxHQUFBaEIsaUJBQWlCLENBQUM0QixNQUFZLElBQVosRUFBWSxDQUFDO0lBQUE7SUFBQXBCLENBQUEsTUFBQWIsU0FBQTtJQUFBYSxDQUFBLE1BQUFHLElBQUE7SUFBQUgsQ0FBQSxNQUFBSSxFQUFBO0lBQUFKLENBQUEsTUFBQUssRUFBQTtJQUFBTCxDQUFBLE1BQUBNLEVBQUE7SUFBQU4sQ0FBQSxNQUFBTyxFQUFBO0lBQUFQLENBQUEsTUFBQVEsRUFBQTtJQUFBUixDQUFBLE1BQUFTLEVBQUE7SUFBQVQsQ0FBQSxNQUFBVSxFQUFBO0lBQUFWLENBQUEsTUFBQVcsRUFBQTtJQUFBWCxDQUFBLE9BQUFTLEVBQUE7SUFBQVJDQ0FBQSxPQUFBYSxTQUFBO0lBQUFiLENBQUEsT0FBQWMsSUFBQTtFQUFBO0lBQUFWLEVBQUEsR0FBQUosQ0FBQTtJQUFBSyxFQUFBLEdBQUFMLENBQUE7SUFBQU0sRUFBQSxHQUFBTixDQUFBO0lBQUFPLEVBQUEsR0FBQVBDQ0FBO0lBQUFRLEVBQUEsR0FBQVIsQ0FBQTtJQUFBUyxFQUFBLEdBQUFULENBQUE7SUFBQVUsRUFBQSxHQUFBVixDQUFBO0lBQUFXLEVBQUEsR0FBQVgsQ0FBQTtJQUFBWSxFQUFBLEdBQUFaLENBQUE7SUFBQWEsU0FBQSxHQUFBYixDQUFBO0lBQUFjLElBQUEsR0FBQWQsQ0FBQTtFQUFBO0VBQUEsSUFBQVksRUFBQSxLQUFBRyxNQUFBLENBQUFDLEdBQUE7SUFBQSxPQUFBSixFQUFBO0VBQUE7RUFDaEMsTUFBQWMsRUFBQSxHQUFBWixJQUFJLEdBQUosV0FBa0JBLElBQUksRUFBTyxHQUE3QixFQUE2QjtFQUFBLElBQUFhLEVBQUE7RUFBQSxJQUFBM0IsQ0FBQSxTQUFBSSxFQUFBLElBQUFKLENBQUEsU0FBQU8sRUFBQSxJQUFBUCxDQUFBLFNBQUFRLEVBQUEsSUFBQVIsQ0FBQSxTQUFBMEIsRUFBQTtJQUZoQ0MsRUFBQSxJQUFDLEVBQUksQ0FBQyxRQUFRLENBQVIsQ0FBQXBCLEVBQU8sQ0FBQyxDQUNYLENBQUFDLEVBQThCLENBQzlCLENBQUFrQixFQUE0QixDQUFFLENBQ2pDLEVBSEMsRUFBSSxDQUdFO0lBQUExQixDQUFBLE9BQUFJLEVBQUE7SUFBQUosQ0FBQSxPQUFBTyxFQUFBO0lBQUFQLENBQUEsT0FBQVFFRVFBQUE7SUFBQVIJQ0FBQSxPQUFBMEIsRUFBQTtJQUFBMUIsQ0FBQSxPQUFBMkIsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQTNCLENBQUE7RUFBQTtFQUFBLElBQUE0QixHQUFBO0VBQUEsSUFBQTVCLENBQUEsU0FBQUssRUFBQSxJQUFBTCxDQUFBLFNBQUFTLEVBQUEsSUFBQVQsQ0FBQSxTQUFBVSxFQUFBLElBQUFWLENBQUEsU0FBQTJCLEVBQUEsSUFBQTNCLENBQUEsU0FBQWEsU0FBQTtJQUxUZSxHQUFBLElBQUMsRUFBSSxDQUNILENBQUFuQixFQUE4QyxDQUFFLENBQUFDLEVBQUUsQ0FDbEQsQ0FBQWlCLEVBR00sQ0FBRSxJQUFFLENBQ1RkLFVBQVEsQ0FDWCxFQVBDLEVBQUksQ0FPRTtJQUFBYixDQUFBLE9BQUFLLEVBQUE7SUFBQUwsQ0FBQSxPQUFBUyxFQUFBO0lBQUFULENBQUEsT0FBQVVFREVBQUE7SUFBQVZDQ0FBQSxPQUFBMkIsRUFBQTtJQUFBM0IsQ0FBQSxPQUFBYSxTQUFBO0lBQUFiLENBQUEsT0FBQTRCLEdBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUE1QixDQUFBO0VBQUE7RUFBQSxJQUFBNkIsR0FBQTtFQUFBLElBQUE3QixDQUFBLFNBQUFNLEVBQUEsSUFBQU4sQ0FBQSxTQUFBNEIsR0FBQSxJQUFBNUIsQ0FBQSxTQUFBVyxFQUFBO0lBUlRrQixHQUFBLElBQUMsRUFBRyxDQUFZLFNBQWlCLENBQWpCLENBQUFsQixFQUFnQixDQUFDLENBQy9CLENBQUFpQixHQU9NLENBQUUsRUFBRSxFQVRDLEVBQUcsQ0FTRTtJQUFBNUIsQ0FBQSxPQUFBTSxFQUFBO0lBQUFOLENBQUEsT0FBQTRCLEdBQUE7SUFBQTVCLENBQUEsT0FBQVcsRUFBQTtJQUFBWCxDQUFBLE9BQUE2QixHQUFBO0VBQUE7SUFBQUEsR0FBQSxHQUFBN0IsQ0FBQTtFQUFBO0VBQUEsT0FUTjZCLEdBU007QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
