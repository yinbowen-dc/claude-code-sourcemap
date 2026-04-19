/**
 * UserLocalCommandOutputMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层，由 UserTextMessage 路由分发。
 * 当系统检测到 <local-command-stdout> 或 <local-command-stderr> XML 标签时，
 * 调用本组件渲染本地 Shell 命令的执行输出。
 *
 * 【主要功能】
 * 1. UserLocalCommandOutputMessage：顶层入口，提取 stdout/stderr 标签内容，
 *    分别渲染为 IndentedContent 子组件；若两者均为空则显示 NO_CONTENT_MESSAGE。
 * 2. IndentedContent：内容渲染中间层，检测是否为以菱形符号开头的 Cloud Launch 事件；
 *    若是则转发给 CloudLaunchContent，否则用 Markdown 渲染并添加 "⎿" 缩进前缀。
 * 3. CloudLaunchContent：专门渲染 Cloud Launch 事件行，解析标题/后缀/剩余内容，
 *    以菱形图标 + 粗体标题 + 暗色后缀 + 可选正文的布局呈现。
 *
 * 【依赖】
 * - react/compiler-runtime: React 编译器运行时，提供 _c(N) 缓存数组
 * - constants/figures: DIAMOND_FILLED（◆）、DIAMOND_OPEN（◇）菱形常量
 * - constants/messages: NO_CONTENT_MESSAGE 空内容占位文本
 * - ink: 终端 UI 框架，Box/Text 组件
 * - utils/messages: extractTag() 从 XML 字符串提取特定标签内容
 * - components/Markdown: Markdown 渲染组件
 * - components/MessageResponse: 提供与上方消息紧邻的样式容器
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';
import { Markdown } from '../Markdown.js';
import { MessageResponse } from '../MessageResponse.js';

// 组件 Props 类型：接收完整的 XML 包裹文本内容
type Props = {
  content: string;
};

/**
 * UserLocalCommandOutputMessage — 本地命令输出顶层组件
 *
 * 流程：
 * 1. 通过 extractTag 从 content 中提取 <local-command-stdout> 和 <local-command-stderr>
 * 2. 若两者均为空，返回 MessageResponse 包裹的 NO_CONTENT_MESSAGE（暗色占位提示）
 * 3. 分别将 stdout 和 stderr 内容（trim 后）推入 lines 数组，渲染为 IndentedContent 列表
 *
 * React 编译器优化：_c(4) 缓存数组，缓存 lines 列表和早期返回节点
 */
export function UserLocalCommandOutputMessage(t0) {
  // React 编译器注入的缓存数组，共 4 个槽位
  const $ = _c(4);
  const {
    content
  } = t0;
  let lines;
  let t1;
  // 当 content 变化时重新解析标签内容
  if ($[0] !== content) {
    // 初始化为早期返回哨兵值（React 编译器约定）
    t1 = Symbol.for("react.early_return_sentinel");
    bb0: {
      // 提取 stdout 和 stderr 标签内容
      const stdout = extractTag(content, "local-command-stdout");
      const stderr = extractTag(content, "local-command-stderr");
      // 若两者均为空，显示无内容占位消息并提前返回
      if (!stdout && !stderr) {
        let t2;
        // 无内容消息节点为静态，用永久缓存槽 $[3] 缓存（memo_cache_sentinel 表示从未初始化）
        if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse><Text dimColor={true}>{NO_CONTENT_MESSAGE}</Text></MessageResponse>;
          $[3] = t2;
        } else {
          t2 = $[3];
        }
        // 将静态节点赋给 t1 并通过 break 跳出代码块
        t1 = t2;
        break bb0;
      }
      // 构建内容行数组
      lines = [];
      // 若 stdout 有内容则添加标准输出行（trim 去除首尾空白）
      if (stdout?.trim()) {
        lines.push(<IndentedContent key="stdout">{stdout.trim()}</IndentedContent>);
      }
      // 若 stderr 有内容则添加标准错误行
      if (stderr?.trim()) {
        lines.push(<IndentedContent key="stderr">{stderr.trim()}</IndentedContent>);
      }
    }
    // 写入缓存
    $[0] = content;
    $[1] = lines;
    $[2] = t1;
  } else {
    // content 未变，从缓存中恢复 lines 和 t1
    lines = $[1];
    t1 = $[2];
  }
  // 若 t1 不是哨兵值，说明触发了早期返回（无内容情形）
  if (t1 !== Symbol.for("react.early_return_sentinel")) {
    return t1;
  }
  // 返回 lines 数组（React 可渲染节点数组）
  return lines;
}

/**
 * IndentedContent — 内容缩进中间层
 *
 * 流程：
 * 1. 检测 children 是否以菱形符号（◇ 或 ◆）开头
 * 2. 若是 → 转发给 CloudLaunchContent 处理 Cloud Launch 事件格式
 * 3. 否则 → 渲染标准缩进内容：左侧显示 "  ⎿  " 前缀，右侧用 Markdown 渲染文本
 *
 * React 编译器优化：_c(5)，缓存静态前缀节点（$[2]）和完整行节点（$[3]/$[4]）
 */
function IndentedContent(t0) {
  // React 编译器注入的缓存数组，共 5 个槽位
  const $ = _c(5);
  const {
    children
  } = t0;
  // 检测内容是否为 Cloud Launch 事件（以 ◇/◆ + 空格开头）
  if (children.startsWith(`${DIAMOND_OPEN} `) || children.startsWith(`${DIAMOND_FILLED} `)) {
    let t1;
    // 将内容交给 CloudLaunchContent 渲染；缓存依赖 children
    if ($[0] !== children) {
      t1 = <CloudLaunchContent>{children}</CloudLaunchContent>;
      $[0] = children;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    return t1;
  }
  // 静态的 "  ⎿  " 缩进前缀（\u23BF 为 ⎿ 字符），用 memo_cache_sentinel 做一次性初始化
  let t1;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text dimColor={true}>{"  \u23BF  "}</Text>;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  // 构建横向布局：左侧缩进前缀 + 右侧 Markdown 内容
  let t2;
  if ($[3] !== children) {
    t2 = <Box flexDirection="row">{t1}<Box flexDirection="column" flexGrow={1}><Markdown>{children}</Markdown></Box></Box>;
    $[3] = children;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
}

/**
 * CloudLaunchContent — Cloud Launch 事件渲染组件
 *
 * 流程：
 * 1. 提取首字符作为菱形图标（◇ 或 ◆）
 * 2. 从位置 2 开始取第一行作为 header（跳过菱形和空格）
 * 3. 在 header 中查找 " · " 分隔符：分隔符前为 label，分隔符起始处至末尾为 suffix
 * 4. 剩余行（换行符之后的部分）作为 rest（可选正文）
 * 5. 渲染：菱形图标（背景色）+ 粗体标题 + 暗色后缀，以及可选的缩进正文行
 *
 * React 编译器优化：_c(19)，缓存菱形节点、标题节点、后缀节点、标题行节点和正文行节点
 */
function CloudLaunchContent(t0) {
  // React 编译器注入的缓存数组，共 19 个槽位
  const $ = _c(19);
  const {
    children
  } = t0;
  // 菱形图标为文本首字符（◇ 或 ◆）
  const diamond = children[0];
  let label;
  let rest;
  let t1;
  // 当 children 变化时重新解析各部分
  if ($[0] !== children) {
    // 查找第一个换行符的位置
    const nl = children.indexOf("\n");
    // 取第一行（跳过首字符菱形和其后的空格，即从索引 2 开始）
    const header = nl === -1 ? children.slice(2) : children.slice(2, nl);
    // 剩余行：换行符之后的内容（trim 去除首尾空白），无换行则为空字符串
    rest = nl === -1 ? "" : children.slice(nl + 1).trim();
    // 在 header 中查找 " · "（中点分隔符，\xB7 为 ·）
    const sep = header.indexOf(" \xB7 ");
    // 分隔符前为主标签，分隔符不存在则整个 header 为 label
    label = sep === -1 ? header : header.slice(0, sep);
    // 分隔符及之后为后缀，分隔符不存在则为空字符串
    t1 = sep === -1 ? "" : header.slice(sep);
    // 写入缓存
    $[0] = children;
    $[1] = label;
    $[2] = rest;
    $[3] = t1;
  } else {
    // 命中缓存，恢复解析结果
    label = $[1];
    rest = $[2];
    t1 = $[3];
  }
  const suffix = t1;

  // 渲染菱形图标（背景色文本）；依赖 diamond
  let t2;
  if ($[4] !== diamond) {
    t2 = <Text color="background">{diamond} </Text>;
    $[4] = diamond;
    $[5] = t2;
  } else {
    t2 = $[5];
  }

  // 渲染粗体标题；依赖 label
  let t3;
  if ($[6] !== label) {
    t3 = <Text bold={true}>{label}</Text>;
    $[6] = label;
    $[7] = t3;
  } else {
    t3 = $[7];
  }

  // 渲染暗色后缀（若 suffix 为空字符串则返回 false，不渲染）；依赖 suffix
  let t4;
  if ($[8] !== suffix) {
    t4 = suffix && <Text dimColor={true}>{suffix}</Text>;
    $[8] = suffix;
    $[9] = t4;
  } else {
    t4 = $[9];
  }

  // 标题行：菱形 + 粗体标题 + 可选后缀组合为一行 Text；依赖三个子节点
  let t5;
  if ($[10] !== t2 || $[11] !== t3 || $[12] !== t4) {
    t5 = <Text>{t2}{t3}{t4}</Text>;
    $[10] = t2;
    $[11] = t3;
    $[12] = t4;
    $[13] = t5;
  } else {
    t5 = $[13];
  }

  // 正文行：若 rest 存在则渲染带缩进的暗色文本行；依赖 rest
  let t6;
  if ($[14] !== rest) {
    t6 = rest && <Box flexDirection="row"><Text dimColor={true}>{"  \u23BF  "}</Text><Text dimColor={true}>{rest}</Text></Box>;
    $[14] = rest;
    $[15] = t6;
  } else {
    t6 = $[15];
  }

  // 最终列布局：标题行 + 可选正文行；依赖 t5 和 t6
  let t7;
  if ($[16] !== t5 || $[17] !== t6) {
    t7 = <Box flexDirection="column">{t5}{t6}</Box>;
    $[16] = t5;
    $[17] = t6;
    $[18] = t7;
  } else {
    t7 = $[18];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkRJQU1PTkRfRklMTEVEIiwiRElBTU9ORF9PUEVOIiwiTk9fQ09OVEVOVF9NRVNTQUdFIiwiQm94IiwiVGV4dCIsImV4dHJhY3RUYWciLCJNYXJrZG93biIsIk1lc3NhZ2VSZXNwb25zZSIsIlByb3BzIiwiY29udGVudCIsIlVzZXJMb2NhbENvbW1hbmRPdXRwdXRNZXNzYWdlIiwidDAiLCIkIiwiX2MiLCJsaW5lcyIsInQxIiwiU3ltYm9sIiwiZm9yIiwiYmIwIiwic3Rkb3V0Iiwic3RkZXJyIiwidDIiLCJ0cmltIiwicHVzaCIsIkluZGVudGVkQ29udGVudCIsImNoaWxkcmVuIiwic3RhcnRzV2l0aCIsIkNsb3VkTGF1bmNoQ29udGVudCIsImRpYW1vbmQiLCJsYWJlbCIsInJlc3QiLCJubCIsImluZGV4T2YiLCJoZWFkZXIiLCJzbGljZSIsInNlcCIsInN1ZmZpeCIsInQzIiwidDQiLCJ0NSIsInQ2IiwidDciXSwic291cmNlcyI6WyJVc2VyTG9jYWxDb21tYW5kT3V0cHV0TWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBESUFNT05EX0ZJTExFRCwgRElBTU9ORF9PUEVOIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL2ZpZ3VyZXMuanMnXG5pbXBvcnQgeyBOT19DT05URU5UX01FU1NBR0UgfSBmcm9tICcuLi8uLi9jb25zdGFudHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBleHRyYWN0VGFnIH0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBNYXJrZG93biB9IGZyb20gJy4uL01hcmtkb3duLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi4vTWVzc2FnZVJlc3BvbnNlLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBjb250ZW50OiBzdHJpbmdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIFVzZXJMb2NhbENvbW1hbmRPdXRwdXRNZXNzYWdlKHtcbiAgY29udGVudCxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3Qgc3Rkb3V0ID0gZXh0cmFjdFRhZyhjb250ZW50LCAnbG9jYWwtY29tbWFuZC1zdGRvdXQnKVxuICBjb25zdCBzdGRlcnIgPSBleHRyYWN0VGFnKGNvbnRlbnQsICdsb2NhbC1jb21tYW5kLXN0ZGVycicpXG4gIGlmICghc3Rkb3V0ICYmICFzdGRlcnIpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+e05PX0NPTlRFTlRfTUVTU0FHRX08L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICBjb25zdCBsaW5lczogUmVhY3QuUmVhY3ROb2RlW10gPSBbXVxuICBpZiAoc3Rkb3V0Py50cmltKCkpIHtcbiAgICBsaW5lcy5wdXNoKDxJbmRlbnRlZENvbnRlbnQga2V5PVwic3Rkb3V0XCI+e3N0ZG91dC50cmltKCl9PC9JbmRlbnRlZENvbnRlbnQ+KVxuICB9XG4gIGlmIChzdGRlcnI/LnRyaW0oKSkge1xuICAgIGxpbmVzLnB1c2goPEluZGVudGVkQ29udGVudCBrZXk9XCJzdGRlcnJcIj57c3RkZXJyLnRyaW0oKX08L0luZGVudGVkQ29udGVudD4pXG4gIH1cbiAgcmV0dXJuIGxpbmVzXG59XG5cbmZ1bmN0aW9uIEluZGVudGVkQ29udGVudCh7IGNoaWxkcmVuIH06IHsgY2hpbGRyZW46IHN0cmluZyB9KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKFxuICAgIGNoaWxkcmVuLnN0YXJ0c1dpdGgoYCR7RElBTU9ORF9PUEVOfSBgKSB8fFxuICAgIGNoaWxkcmVuLnN0YXJ0c1dpdGgoYCR7RElBTU9ORF9GSUxMRUR9IGApXG4gICkge1xuICAgIHJldHVybiA8Q2xvdWRMYXVuY2hDb250ZW50PntjaGlsZHJlbn08L0Nsb3VkTGF1bmNoQ29udGVudD5cbiAgfVxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgPFRleHQgZGltQ29sb3I+eycgIOKOvyAgJ308L1RleHQ+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBmbGV4R3Jvdz17MX0+XG4gICAgICAgIDxNYXJrZG93bj57Y2hpbGRyZW59PC9NYXJrZG93bj5cbiAgICAgIDwvQm94PlxuICAgIDwvQm94PlxuICApXG59XG5cbmZ1bmN0aW9uIENsb3VkTGF1bmNoQ29udGVudCh7XG4gIGNoaWxkcmVuLFxufToge1xuICBjaGlsZHJlbjogc3RyaW5nXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgZGlhbW9uZCA9IGNoaWxkcmVuWzBdIVxuICBjb25zdCBubCA9IGNoaWxkcmVuLmluZGV4T2YoJ1xcbicpXG4gIGNvbnN0IGhlYWRlciA9IG5sID09PSAtMSA/IGNoaWxkcmVuLnNsaWNlKDIpIDogY2hpbGRyZW4uc2xpY2UoMiwgbmwpXG4gIGNvbnN0IHJlc3QgPSBubCA9PT0gLTEgPyAnJyA6IGNoaWxkcmVuLnNsaWNlKG5sICsgMSkudHJpbSgpXG4gIGNvbnN0IHNlcCA9IGhlYWRlci5pbmRleE9mKCcgwrcgJylcbiAgY29uc3QgbGFiZWwgPSBzZXAgPT09IC0xID8gaGVhZGVyIDogaGVhZGVyLnNsaWNlKDAsIHNlcClcbiAgY29uc3Qgc3VmZml4ID0gc2VwID09PSAtMSA/ICcnIDogaGVhZGVyLnNsaWNlKHNlcClcbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgIDxUZXh0PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImJhY2tncm91bmRcIj57ZGlhbW9uZH0gPC9UZXh0PlxuICAgICAgICA8VGV4dCBib2xkPntsYWJlbH08L1RleHQ+XG4gICAgICAgIHtzdWZmaXggJiYgPFRleHQgZGltQ29sb3I+e3N1ZmZpeH08L1RleHQ+fVxuICAgICAgPC9UZXh0PlxuICAgICAge3Jlc3QgJiYgKFxuICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJyb3dcIj5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57JyAg4o6/ICAnfTwvVGV4dD5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57cmVzdH08L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKX1cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxjQUFjLEVBQUVDLFlBQVksUUFBUSw0QkFBNEI7QUFDekUsU0FBU0Msa0JBQWtCLFFBQVEsNkJBQTZCO0FBQ2hFLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsVUFBVSxRQUFRLHlCQUF5QjtBQUNwRCxTQUFTQyxRQUFRLFFBQVEsZ0JBQWdCO0FBQ3pDLFNBQVNDLGVBQWUsUUFBUSx1QkFBdUI7QUFFdkQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLE9BQU8sRUFBRSxNQUFNO0FBQ2pCLENBQUM7QUFFRCxPQUFPLFNBQUFDLDhCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQXVDO0lBQUFKO0VBQUEsSUFBQUUsRUFFdEM7RUFBQSxJQUFBRyxLQUFBO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFILENBQUEsUUFBQUgsT0FBQTtJQUtGTSxFQUFBLEdBQUFDLE1BRWtCLENBQUFDLEdBQUEsQ0FGbEIsNkJBRWlCLENBQUM7SUFBQUMsR0FBQTtNQU50QixNQUFBQyxNQUFBLEdBQWVkLFVBQVUsQ0FBQ0ksT0FBTyxFQUFFLHNCQUFzQixDQUFDO01BQzFELE1BQUFXLE1BQUEsR0FBZWYsVUFBVSxDQUFDSSxPQUFPLEVBQUUsc0JBQXNCLENBQUM7TUFDMUQsSUFBSSxDQUFDVSxNQUFpQixJQUFsQixDQUFZQyxNQUFNO1FBQUEsSUFBQUMsRUFBQTtRQUFBLElBQUFULENBQUEsUUFBQUksTUFBQSxD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
