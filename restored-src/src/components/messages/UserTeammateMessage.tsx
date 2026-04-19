/**
 * UserTeammateMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层，由 UserTextMessage 路由分发。
 * 当用户消息中包含 <teammate-message> XML 标签时（即来自协作队友的消息），
 * 调用本组件在终端 UI 中渲染队友发送的各类消息（普通文本、计划审批、
 * 关机请求、任务分配、任务完成等）。
 *
 * 【主要功能】
 * 1. parseTeammateMessages(text)：从 XML 文本解析所有队友消息条目
 * 2. getDisplayName(teammateId)：将 teammate ID 转换为显示名称
 * 3. UserTeammateMessage：主渲染组件，根据消息类型分发到不同渲染路径
 *    - 过滤：移除已批准关机和 teammate_terminated 类型消息
 *    - 路由：计划审批 → 关机 → 任务分配 → JSON 结构化消息 → 默认文本
 * 4. TeammateMessageContent：普通文本消息渲染组件（React 编译器优化）
 *
 * 【依赖】
 * - react/compiler-runtime: React 编译器运行时，提供 _c(N) 缓存数组（仅 TeammateMessageContent 使用）
 * - @anthropic-ai/sdk: TextBlockParam 类型
 * - figures: 终端符号库，pointer（▶）用于队友名称后的箭头
 * - constants/xml: TEAMMATE_MESSAGE_TAG XML 标签名常量
 * - ink: Ansi/Box/Text 终端 UI 组件
 * - utils/ink: toInkColor() 将颜色字符串转换为 Ink 兼容颜色
 * - utils/slowOperations: jsonParse() 安全 JSON 解析
 * - utils/teammateMailbox: isShutdownApproved() 检测关机批准状态
 * - PlanApprovalMessage/ShutdownMessage/TaskAssignmentMessage: 特殊消息类型渲染器
 */
import { c as _c } from "react/compiler-runtime";
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import figures from 'figures';
import * as React from 'react';
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js';
import { Ansi, Box, Text, type TextProps } from '../../ink.js';
import { toInkColor } from '../../utils/ink.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { isShutdownApproved } from '../../utils/teammateMailbox.js';
import { MessageResponse } from '../MessageResponse.js';
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js';
import { tryRenderShutdownMessage } from './ShutdownMessage.js';
import { tryRenderTaskAssignmentMessage } from './TaskAssignmentMessage.js';

// 组件 Props 类型定义
type Props = {
  addMargin: boolean;           // 是否在顶部添加 marginTop=1 的间距
  param: TextBlockParam;        // 包含队友消息 XML 标签的文本块参数
  isTranscriptMode?: boolean;   // 是否处于完整转录模式（显示消息原文）
};

// 解析后的队友消息类型
type ParsedMessage = {
  teammateId: string;    // 发送消息的队友 ID
  content: string;       // 消息正文
  color?: string;        // 可选：队友标识颜色
  summary?: string;      // 可选：消息摘要（简短描述）
};

/**
 * TEAMMATE_MSG_REGEX — 队友消息 XML 标签的全局正则表达式
 *
 * 匹配格式：
 * <teammate-message teammate_id="alice" color="red" summary="Brief update">
 * message content
 * </teammate-message>
 *
 * 捕获组：
 * - match[1]: teammate_id 属性值（必须）
 * - match[2]: color 属性值（可选）
 * - match[3]: summary 属性值（可选）
 * - match[4]: 标签内的消息正文（必须，trim 后使用）
 */
const TEAMMATE_MSG_REGEX = new RegExp(`<${TEAMMATE_MESSAGE_TAG}\\s+teammate_id="([^"]+)"(?:\\s+color="([^"]+)")?(?:\\s+summary="([^"]+)")?>\\n?([\\s\\S]*?)\\n?<\\/${TEAMMATE_MESSAGE_TAG}>`, 'g');

/**
 * parseTeammateMessages — 从 XML 文本解析所有队友消息
 *
 * 流程：
 * 1. 使用 text.matchAll(TEAMMATE_MSG_REGEX) 迭代所有匹配结果
 * 2. 对每个匹配，检查 match[1]（teammate_id）和 match[4]（content）是否存在
 * 3. 满足条件则将解析结果 push 到 messages 数组
 * 4. 返回所有解析出的 ParsedMessage 对象列表
 *
 * 注：使用 matchAll 而非全局 exec 循环，语义更清晰。
 */
function parseTeammateMessages(text: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // 使用 matchAll 提取所有匹配（RegExp 方法，非 child_process）
  for (const match of text.matchAll(TEAMMATE_MSG_REGEX)) {
    if (match[1] && match[4]) {
      messages.push({
        teammateId: match[1],
        color: match[2],    // 颜色属性，可能为 undefined
        summary: match[3],  // 摘要属性，可能为 undefined
        content: match[4].trim()  // 消息正文，去除首尾空白
      });
    }
  }
  return messages;
}

/**
 * getDisplayName — 将 teammate ID 转换为可读显示名称
 *
 * 当前逻辑：仅对 "leader" 做特殊处理（返回 "leader"），
 * 其他 ID 直接原样返回。
 * 设计为函数以便未来扩展（如：缩短 UUID、添加前缀等）。
 */
function getDisplayName(teammateId: string): string {
  if (teammateId === 'leader') {
    return 'leader';
  }
  return teammateId;
}

/**
 * UserTeammateMessage — 队友消息路由渲染组件
 *
 * 流程：
 * 1. 解析 param.text 中的所有队友消息
 * 2. 过滤掉两类生命周期消息（避免产生空白行）：
 *    a. isShutdownApproved(content) 为 true 的消息（关机批准信号）
 *    b. content 解析为 JSON 且 type === "teammate_terminated" 的消息
 * 3. 若过滤后无消息则返回 null
 * 4. 对每条消息依次尝试以下渲染路径（短路求值）：
 *    a. tryRenderPlanApprovalMessage → 计划审批请求/响应
 *    b. tryRenderShutdownMessage → 关机请求/拒绝
 *    c. tryRenderTaskAssignmentMessage → 任务分配
 *    d. JSON 解析结构化消息：
 *       - type === "idle_notification" → 静默丢弃（return null）
 *       - type === "task_completed" → 显示任务完成通知
 *    e. 默认：渲染为 TeammateMessageContent（普通文本）
 *
 * 注意：本组件未经 React 编译器优化（无 _c() 调用）。
 */
export function UserTeammateMessage({
  addMargin,
  param: {
    text
  },
  isTranscriptMode
}: Props): React.ReactNode {
  // 解析消息并过滤生命周期消息
  const messages = parseTeammateMessages(text).filter(msg => {
    // 过滤已批准关机消息，避免空 Box 元素在模型轮次间产生空白行
    if (isShutdownApproved(msg.content)) {
      return false;
    }
    try {
      // 过滤 teammate_terminated 类型的 JSON 消息
      const parsed = jsonParse(msg.content);
      if (parsed?.type === 'teammate_terminated') return false;
    } catch {
      // 非 JSON 格式，保留该消息
    }
    return true;
  });

  // 无有效消息时不渲染
  if (messages.length === 0) {
    return null;
  }

  // 渲染消息列表：纵向排列，宽度 100%，顶部间距由 addMargin 决定
  return <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      {messages.map((msg_0, index) => {
      // 将颜色字符串转换为 Ink 兼容格式
      const inkColor = toInkColor(msg_0.color);
      // 获取队友的显示名称
      const displayName = getDisplayName(msg_0.teammateId);

      // 尝试渲染为计划审批消息（审批请求或审批响应）
      const planApprovalElement = tryRenderPlanApprovalMessage(msg_0.content, displayName);
      if (planApprovalElement) {
        return <React.Fragment key={index}>{planApprovalElement}</React.Fragment>;
      }

      // 尝试渲染为关机消息（关机请求或被拒绝的关机）
      const shutdownElement = tryRenderShutdownMessage(msg_0.content);
      if (shutdownElement) {
        return <React.Fragment key={index}>{shutdownElement}</React.Fragment>;
      }

      // 尝试渲染为任务分配消息
      const taskAssignmentElement = tryRenderTaskAssignmentMessage(msg_0.content);
      if (taskAssignmentElement) {
        return <React.Fragment key={index}>{taskAssignmentElement}</React.Fragment>;
      }

      // 尝试将消息内容解析为结构化 JSON
      let parsedIdleNotification: {
        type?: string;
      } | null = null;
      try {
        parsedIdleNotification = jsonParse(msg_0.content);
      } catch {
        // 非 JSON 格式
      }

      // 空闲通知：静默处理，不渲染任何 UI
      if (parsedIdleNotification?.type === 'idle_notification') {
        return null;
      }

      // 任务完成通知：显示完成的任务 ID 和可选的任务主题
      if (parsedIdleNotification?.type === 'task_completed') {
        const taskCompleted = parsedIdleNotification as {
          type: string;
          from: string;
          taskId: string;
          taskSubject?: string;
        };
        return <Box key={index} flexDirection="column" marginTop={1}>
              {/* 队友名称标题行：@displayName▶ */}
              <Text color={inkColor}>{`@${displayName}${figures.pointer}`}</Text>
              <MessageResponse>
                {/* 成功勾 + 任务完成描述 */}
                <Text color="success">✓</Text>
                <Text>
                  {' '}
                  Completed task #{taskCompleted.taskId}
                  {/* 若有任务主题则用括号附加（灰色显示） */}
                  {taskCompleted.taskSubject && <Text dimColor> ({taskCompleted.taskSubject})</Text>}
                </Text>
              </MessageResponse>
            </Box>;
      }

      // 默认路径：渲染为普通文本消息
      return <TeammateMessageContent key={index} displayName={displayName} inkColor={inkColor} content={msg_0.content} summary={msg_0.summary} isTranscriptMode={isTranscriptMode} />;
    })}
    </Box>;
}

// TeammateMessageContent 组件的 Props 类型定义
type TeammateMessageContentProps = {
  displayName: string;           // 队友显示名称
  inkColor: TextProps['color'];  // Ink 兼容颜色值
  content: string;               // 消息正文
  summary?: string;              // 可选摘要文本
  isTranscriptMode?: boolean;    // 是否以转录模式显示完整内容
};

/**
 * TeammateMessageContent — 队友普通文本消息渲染组件
 *
 * 布局结构：
 * ┌──────────────────────────────────┐
 * │ @displayName▶ [summary]          │  ← 标题行（inkColor 颜色）
 * │   content（转录模式下显示）       │  ← 内容行（paddingLeft=2，Ansi 渲染）
 * └──────────────────────────────────┘
 *
 * 流程：
 * 1. 构建标题文本 `@displayName▶`（含 figures.pointer）
 * 2. 用 inkColor 渲染标题 Text 节点（缓存：$[0]/$[1]→$[2]）
 * 3. 若 summary 存在则构建摘要节点（缓存：$[3]→$[4]）
 * 4. 组合标题 Box（依赖 t2/t3 缓存：$[5]/$[6]→$[7]）
 * 5. 若 isTranscriptMode 则渲染 Ansi 内容节点（依赖 content/isTranscriptMode 缓存：$[8]/$[9]→$[10]）
 * 6. 组合最终外层 Box（依赖 t4/t5 缓存：$[11]/$[12]→$[13]）
 *
 * React 编译器优化：_c(14)，14 个缓存槽位追踪各依赖层
 */
export function TeammateMessageContent(t0) {
  // React 编译器注入的缓存数组，共 14 个槽位
  const $ = _c(14);
  const {
    displayName,
    inkColor,
    content,
    summary,
    isTranscriptMode
  } = t0;

  // 构建标题文本：@displayName + figures.pointer（如 "▶"）
  const t1 = `@${displayName}${figures.pointer}`;

  // 标题 Text 节点；依赖 inkColor 和 t1 变化时重建（$[0]/$[1]→$[2]）
  let t2;
  if ($[0] !== inkColor || $[1] !== t1) {
    t2 = <Text color={inkColor}>{t1}</Text>;
    $[0] = inkColor;
    $[1] = t1;
    $[2] = t2;
  } else {
    t2 = $[2];
  }

  // 摘要节点：summary 存在时渲染为 " {summary}" 文本；依赖 summary（$[3]→$[4]）
  let t3;
  if ($[3] !== summary) {
    t3 = summary && <Text> {summary}</Text>;
    $[3] = summary;
    $[4] = t3;
  } else {
    t3 = $[4];
  }

  // 标题行 Box：包含 @displayName 和可选摘要；依赖 t2/t3（$[5]/$[6]→$[7]）
  let t4;
  if ($[5] !== t2 || $[6] !== t3) {
    t4 = <Box>{t2}{t3}</Box>;
    $[5] = t2;
    $[6] = t3;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // 转录模式内容节点：仅在 isTranscriptMode=true 时渲染 Ansi 内容
  // 依赖 content 和 isTranscriptMode（$[8]/$[9]→$[10]）
  let t5;
  if ($[8] !== content || $[9] !== isTranscriptMode) {
    // isTranscriptMode 为 true 时：缩进 2 格，用 Ansi 组件渲染原始 ANSI 转义序列
    t5 = isTranscriptMode && <Box paddingLeft={2}><Text><Ansi>{content}</Ansi></Text></Box>;
    $[8] = content;
    $[9] = isTranscriptMode;
    $[10] = t5;
  } else {
    t5 = $[10];
  }

  // 最终外层容器：纵向排列，顶部间距固定为 1；依赖 t4/t5（$[11]/$[12]→$[13]）
  let t6;
  if ($[11] !== t4 || $[12] !== t5) {
    t6 = <Box flexDirection="column" marginTop={1}>{t4}{t5}</Box>;
    $[11] = t4;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUZXh0QmxvY2tQYXJhbSIsImZpZ3VyZXMiLCJSZWFjdCIsIlRFQU1NQVRFX01FU1NBR0VfVEFHIiwiQW5zaSIsIkJveCIsIlRleHQiLCJUZXh0UHJvcHMiLCJ0b0lua0NvbG9yIiwianNvblBhcnNlIiwiaXNTaHV0ZG93bkFwcHJvdmVkIiwiTWVzc2FnZVJlc3BvbnNlIiwidHJ5UmVuZGVyUGxhbkFwcHJvdmFsTWVzc2FnZSIsInRyeVJlbmRlclNodXRkb3duTWVzc2FnZSIsInRyeVJlbmRlclRhc2tBc3NpZ25tZW50TWVzc2FnZSIsIlByb3BzIiwiYWRkTWFyZ2luIiwicGFyYW0iLCJpc1RyYW5zY3JpcHRNb2RlIiwiUGFyc2VkTWVzc2FnZSIsInRlYW1tYXRlSWQiLCJjb250ZW50IiwiY29sb3IiLCJzdW1tYXJ5IiwiVEVBTU1BVEVfTVNHX1JFR0VYIiwiUmVnRXhwIiwicGFyc2VUZWFtbWF0ZU1lc3NhZ2VzIiwidGV4dCIsIm1lc3NhZ2VzIiwibWF0Y2giLCJtYXRjaEFsbCIsInB1c2giLCJ0cmltIiwiZ2V0RGlzcGxheU5hbWUiLCJVc2VyVGVhbW1hdGVNZXNzYWdlIiwiUmVhY3ROb2RlIiwiZmlsdGVyIiwibXNnIiwicGFyc2VkIiwidHlwZSIsImxlbmd0aCIsIm1hcCIsImluZGV4IiwiaW5rQ29sb3IiLCJkaXNwbGF5TmFtZSIsInBsYW5BcHByb3ZhbEVsZW1lbnQiLCJzaHV0ZG93bkVsZW1lbnQiLCJ0YXNrQXNzaWdubWVudEVsZW1lbnQiLCJwYXJzZWRJZGxlTm90aWZpY2F0aW9uIiwidGFza0NvbXBsZXRlZCIsImZyb20iLCJ0YXNrSWQiLCJ0YXNrU3ViamVjdCIsInBvaW50ZXIiLCJUZWFtbWF0ZU1lc3NhZ2VDb250ZW50UHJvcHMiLCJUZWFtbWF0ZU1lc3NhZ2VDb250ZW50IiwidDAiLCIkIiwiX2MiLCJ0MSIsInQyIiwidDMiLCJ0NCIsInQ1IiwidDYiXSwic291cmNlcyI6WyJVc2VyVGVhbW1hdGVNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFRleHRCbG9ja1BhcmFtIH0gZnJvbSAnQGFudGhyb3BpYy1haS9zZGsvcmVzb3VyY2VzL2luZGV4Lm1qcydcbmltcG9ydCBmaWd1cmVzIGZyb20gJ2ZpZ3VyZXMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRFQU1NQVRFX01FU1NBR0VfVEFHIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL3htbC5qcydcbmltcG9ydCB7IEFuc2ksIEJveCwgVGV4dCwgdHlwZSBUZXh0UHJvcHMgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB0b0lua0NvbG9yIH0gZnJvbSAnLi4vLi4vdXRpbHMvaW5rLmpzJ1xuaW1wb3J0IHsganNvblBhcnNlIH0gZnJvbSAnLi4vLi4vdXRpbHMvc2xvd09wZXJhdGlvbnMuanMnXG5pbXBvcnQgeyBpc1NodXRkb3duQXBwcm92ZWQgfSBmcm9tICcuLi8uLi91dGlscy90ZWFtbWF0ZU1haWxib3guanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyB0cnlSZW5kZXJQbGFuQXBwcm92YWxNZXNzYWdlIH0gZnJvbSAnLi9QbGFuQXBwcm92YWxNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgdHJ5UmVuZGVyU2h1dGRvd25NZXNzYWdlIH0gZnJvbSAnLi9TaHV0ZG93bk1lc3NhZ2UuanMnXG5pbXBvcnQgeyB0cnlSZW5kZXJUYXNrQXNzaWdubWVudE1lc3NhZ2UgfSBmcm9tICcuL1Rhc2tBc3NpZ25tZW50TWVzc2FnZS5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgYWRkTWFyZ2luOiBib29sZWFuXG4gIHBhcmFtOiBUZXh0QmxvY2tQYXJhbVxuICBpc1RyYW5zY3JpcHRNb2RlPzogYm9vbGVhblxufVxuXG50eXBlIFBhcnNlZE1lc3NhZ2UgPSB7XG4gIHRlYW1tYXRlSWQ6IHN0cmluZ1xuICBjb250ZW50OiBzdHJpbmdcbiAgY29sb3I/OiBzdHJpbmdcbiAgc3VtbWFyeT86IHN0cmluZ1xufVxuXG5jb25zdCBURUFNTUFURV9NU0dfUkVHRVggPSBuZXcgUmVnRXhwKFxuICBgPCR7VEVBTU1BVEVfTUVTU0FHRV9UQUd9XFxcXHMrdGVhbW1hdGVfaWQ9XCIoW15cIl0rKVwiKD86XFxcXHMrY29sb3I9XCIoW15cIl0rKVwiKT8oPzpcXFxccytzdW1tYXJ5PVwiKFteXCJdKylcIik/PlxcXFxuPyhbXFxcXHNcXFxcU10qPylcXFxcbj88XFxcXC8ke1RFQU1NQVRFX01FU1NBR0VfVEFHfT5gLFxuICAnZycsXG4pXG5cbi8qKlxuICogUGFyc2UgYWxsIHRlYW1tYXRlIG1lc3NhZ2VzIGZyb20gWE1MIGZvcm1hdDpcbiAqIDx0ZWFtbWF0ZS1tZXNzYWdlIHRlYW1tYXRlX2lkPVwiYWxpY2VcIiBjb2xvcj1cInJlZFwiIHN1bW1hcnk9XCJCcmllZiB1cGRhdGVcIj5tZXNzYWdlIGNvbnRlbnQ8L3RlYW1tYXRlLW1lc3NhZ2U+XG4gKiBTdXBwb3J0cyBtdWx0aXBsZSBtZXNzYWdlcyBpbiBhIHNpbmdsZSB0ZXh0IGJsb2NrLlxuICovXG5mdW5jdGlvbiBwYXJzZVRlYW1tYXRlTWVzc2FnZXModGV4dDogc3RyaW5nKTogUGFyc2VkTWVzc2FnZVtdIHtcbiAgY29uc3QgbWVzc2FnZXM6IFBhcnNlZE1lc3NhZ2VbXSA9IFtdXG4gIC8vIFVzZSBtYXRjaEFsbCB0byBmaW5kIGFsbCBtYXRjaGVzICh0aGlzIGlzIGEgUmVnRXhwIG1ldGhvZCwgbm90IGNoaWxkX3Byb2Nlc3MpXG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgdGV4dC5tYXRjaEFsbChURUFNTUFURV9NU0dfUkVHRVgpKSB7XG4gICAgaWYgKG1hdGNoWzFdICYmIG1hdGNoWzRdKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHtcbiAgICAgICAgdGVhbW1hdGVJZDogbWF0Y2hbMV0sXG4gICAgICAgIGNvbG9yOiBtYXRjaFsyXSwgLy8gbWF5IGJlIHVuZGVmaW5lZFxuICAgICAgICBzdW1tYXJ5OiBtYXRjaFszXSwgLy8gbWF5IGJlIHVuZGVmaW5lZFxuICAgICAgICBjb250ZW50OiBtYXRjaFs0XS50cmltKCksXG4gICAgICB9KVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBtZXNzYWdlc1xufVxuXG5mdW5jdGlvbiBnZXREaXNwbGF5TmFtZSh0ZWFtbWF0ZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodGVhbW1hdGVJZCA9PT0gJ2xlYWRlcicpIHtcbiAgICByZXR1cm4gJ2xlYWRlcidcbiAgfVxuICByZXR1cm4gdGVhbW1hdGVJZFxufVxuXG5leHBvcnQgZnVuY3Rpb24gVXNlclRlYW1tYXRlTWVzc2FnZSh7XG4gIGFkZE1hcmdpbixcbiAgcGFyYW06IHsgdGV4dCB9LFxuICBpc1RyYW5zY3JpcHRNb2RlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBtZXNzYWdlcyA9IHBhcnNlVGVhbW1hdGVNZXNzYWdlcyh0ZXh0KS5maWx0ZXIobXNnID0+IHtcbiAgICAvLyBQcmUtZmlsdGVyIHNodXRkb3duIGxpZmVjeWNsZSBtZXNzYWdlcyB0byBhdm9pZCBlbXB0eSB3cmFwcGVyXG4gICAgLy8gQm94IGVsZW1lbnRzIGNyZWF0aW5nIGJsYW5rIGxpbmVzIGJldHdlZW4gbW9kZWwgdHVybnNcbiAgICBpZiAoaXNTaHV0ZG93bkFwcHJvdmVkKG1zZy5jb250ZW50KSkge1xuICAgICAgcmV0dXJuIGZhbHNlXG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBqc29uUGFyc2UobXNnLmNvbnRlbnQpXG4gICAgICBpZiAocGFyc2VkPy50eXBlID09PSAndGVhbW1hdGVfdGVybWluYXRlZCcpIHJldHVybiBmYWxzZVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTm90IEpTT04sIGtlZXAgdGhlIG1lc3NhZ2VcbiAgICB9XG4gICAgcmV0dXJuIHRydWVcbiAgfSlcbiAgaWYgKG1lc3NhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9IHdpZHRoPVwiMTAwJVwiPlxuICAgICAge21lc3NhZ2VzLm1hcCgobXNnLCBpbmRleCkgPT4ge1xuICAgICAgICBjb25zdCBpbmtDb2xvciA9IHRvSW5rQ29sb3IobXNnLmNvbG9yKVxuICAgICAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGdldERpc3BsYXlOYW1lKG1zZy50ZWFtbWF0ZUlkKVxuXG4gICAgICAgIC8vIFRyeSB0byByZW5kZXIgYXMgcGxhbiBhcHByb3ZhbCBtZXNzYWdlIChyZXF1ZXN0IG9yIHJlc3BvbnNlKVxuICAgICAgICBjb25zdCBwbGFuQXBwcm92YWxFbGVtZW50ID0gdHJ5UmVuZGVyUGxhbkFwcHJvdmFsTWVzc2FnZShcbiAgICAgICAgICBtc2cuY29udGVudCxcbiAgICAgICAgICBkaXNwbGF5TmFtZSxcbiAgICAgICAgKVxuICAgICAgICBpZiAocGxhbkFwcHJvdmFsRWxlbWVudCkge1xuICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICA8UmVhY3QuRnJhZ21lbnQga2V5PXtpbmRleH0+e3BsYW5BcHByb3ZhbEVsZW1lbnR9PC9SZWFjdC5GcmFnbWVudD5cbiAgICAgICAgICApXG4gICAgICAgIH1cblxuICAgICAgICAvLyBUcnkgdG8gcmVuZGVyIGFzIHNodXRkb3duIG1lc3NhZ2UgKHJlcXVlc3Qgb3IgcmVqZWN0ZWQpXG4gICAgICAgIGNvbnN0IHNodXRkb3duRWxlbWVudCA9IHRyeVJlbmRlclNodXRkb3duTWVzc2FnZShtc2cuY29udGVudClcbiAgICAgICAgaWYgKHNodXRkb3duRWxlbWVudCkge1xuICAgICAgICAgIHJldHVybiA8UmVhY3QuRnJhZ21lbnQga2V5PXtpbmRleH0+e3NodXRkb3duRWxlbWVudH08L1JlYWN0LkZyYWdtZW50PlxuICAgICAgICB9XG5cbiAgICAgICAgLy8gVHJ5IHRvIHJlbmRlciBhcyB0YXNrIGFzc2lnbm1lbnQgbWVzc2FnZVxuICAgICAgICBjb25zdCB0YXNrQXNzaWdubWVudEVsZW1lbnQgPSB0cnlSZW5kZXJUYXNrQXNzaWdubWVudE1lc3NhZ2UoXG4gICAgICAgICAgbXNnLmNvbnRlbnQsXG4gICAgICAgIClcbiAgICAgICAgaWYgKHRhc2tBc3NpZ25tZW50RWxlbWVudCkge1xuICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICA8UmVhY3QuRnJhZ21lbnQga2V5PXtpbmRleH0+e3Rhc2tBc3NpZ25tZW50RWxlbWVudH08L1JlYWN0LkZyYWdtZW50PlxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFRyeSB0byBwYXJzZSBhcyBzdHJ1Y3R1cmVkIEpTT04gbWVzc2FnZVxuICAgICAgICBsZXQgcGFyc2VkSWRsZU5vdGlmaWNhdGlvbjogeyB0eXBlPzogc3RyaW5nIH0gfCBudWxsID0gbnVsbFxuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZElkbGVOb3RpZmljYXRpb24gPSBqc29uUGFyc2UobXNnLmNvbnRlbnQpXG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIE5vdCBKU09OXG4gICAgICAgIH1cblxuICAgICAgICAvLyBIaWRlIGlkbGUgbm90aWZpY2F0aW9ucyAtIHRoZXkgYXJlIHByb2Nlc3NlZCBzaWxlbnRseVxuICAgICAgICBpZiAocGFyc2VkSWRsZU5vdGlmaWNhdGlvbj8udHlwZSA9PT0gJ2lkbGVfbm90aWZpY2F0aW9uJykge1xuICAgICAgICAgIHJldHVybiBudWxsXG4gICAgICAgIH1cblxuICAgICAgICAvLyBUYXNrIGNvbXBsZXRlZCBub3RpZmljYXRpb24gLSBzaG93IHdoaWNoIHRhc2sgd2FzIGNvbXBsZXRlZFxuICAgICAgICBpZiAocGFyc2VkSWRsZU5vdGlmaWNhdGlvbj8udHlwZSA9PT0gJ3Rhc2tfY29tcGxldGVkJykge1xuICAgICAgICAgIGNvbnN0IHRhc2tDb21wbGV0ZWQgPSBwYXJzZWRJZGxlTm90aWZpY2F0aW9uIGFzIHtcbiAgICAgICAgICAgIHR5cGU6IHN0cmluZ1xuICAgICAgICAgICAgZnJvbTogc3RyaW5nXG4gICAgICAgICAgICB0YXNrSWQ6IHN0cmluZ1xuICAgICAgICAgICAgdGFza1N1YmplY3Q/OiBzdHJpbmdcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICAgIDxCb3gga2V5PXtpbmRleH0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgICAgIDxUZXh0XG4gICAgICAgICAgICAgICAgY29sb3I9e2lua0NvbG9yfVxuICAgICAgICAgICAgICA+e2BAJHtkaXNwbGF5TmFtZX0ke2ZpZ3VyZXMucG9pbnRlcn1gfTwvVGV4dD5cbiAgICAgICAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICAgICAgICA8VGV4dCBjb2xvcj1cInN1Y2Nlc3NcIj7inJM8L1RleHQ+XG4gICAgICAgICAgICAgICAgPFRleHQ+XG4gICAgICAgICAgICAgICAgICB7JyAnfVxuICAgICAgICAgICAgICAgICAgQ29tcGxldGVkIHRhc2sgI3t0YXNrQ29tcGxldGVkLnRhc2tJZH1cbiAgICAgICAgICAgICAgICAgIHt0YXNrQ29tcGxldGVkLnRhc2tTdWJqZWN0ICYmIChcbiAgICAgICAgICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+ICh7dGFza0NvbXBsZXRlZC50YXNrU3ViamVjdH0pPC9UZXh0PlxuICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRGVmYXVsdDogcGxhaW4gdGV4dCBtZXNzYWdlICh0cnVuY2F0ZWQpXG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgPFRlYW1tYXRlTWVzc2FnZUNvbnRlbnRcbiAgICAgICAgICAgIGtleT17aW5kZXh9XG4gICAgICAgICAgICBkaXNwbGF5TmFtZT17ZGlzcGxheU5hbWV9XG4gICAgICAgICAgICBpbmtDb2xvcj17aW5rQ29sb3J9XG4gICAgICAgICAgICBjb250ZW50PXttc2cuY29udGVudH1cbiAgICAgICAgICAgIHN1bW1hcnk9e21zZy5zdW1tYXJ5fVxuICAgICAgICAgICAgaXNUcmFuc2NyaXB0TW9kZT17aXNUcmFuc2NyaXB0TW9kZX1cbiAgICAgICAgICAvPlxuICAgICAgICApXG4gICAgICB9KX1cbiAgICA8L0JveD5cbiAgKVxufVxuXG50eXBlIFRlYW1tYXRlTWVzc2FnZUNvbnRlbnRQcm9wcyA9IHtcbiAgZGlzcGxheU5hbWU6IHN0cmluZ1xuICBpbmtDb2xvcjogVGV4dFByb3BzWydjb2xvciddXG4gIGNvbnRlbnQ6IHN0cmluZ1xuICBzdW1tYXJ5Pzogc3RyaW5nXG4gIGlzVHJhbnNjcmlwdE1vZGU/OiBib29sZWFuXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBUZWFtbWF0ZU1lc3NhZ2VDb250ZW50KHtcbiAgZGlzcGxheU5hbWUsXG4gIGlua0NvbG9yLFxuICBjb250ZW50LFxuICBzdW1tYXJ5LFxuICBpc1RyYW5zY3JpcHRNb2RlLFxufTogVGVhbW1hdGVNZXNzYWdlQ29udGVudFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBtYXJnaW5Ub3A9ezF9PlxuICAgICAgPEJveD5cbiAgICAgICAgPFRleHQgY29sb3I9e2lua0NvbG9yfT57YEAke2Rpc3BsYXlOYW1lfSR7ZmlndXJlcy5wb2ludGVyfWB9PC9UZXh0PlxuICAgICAgICB7c3VtbWFyeSAmJiA8VGV4dD4ge3N1bW1hcnl9PC9UZXh0Pn1cbiAgICAgIDwvQm94PlxuICAgICAge2lzVHJhbnNjcmlwdE1vZGUgJiYgKFxuICAgICAgICA8Qm94IHBhZGRpbmdMZWZ0PXsyfT5cbiAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgIDxBbnNpPntjb250ZW50fTwvQW5zaT5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKX1cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsY0FBY0EsY0FBYyxRQUFRLHVDQUF1QztBQUMzRSxPQUFPQyxPQUFPLE1BQU0sU0FBUztBQUM3QixPQUFPLEtBQUtDLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLG9CQUFvQixRQUFRLHdCQUF3QjtBQUM3RCxTQUFTQyxJQUFJLEVBQUVDLEdBQUcsRUFBRUMsSUFBSSxFQUFFLEtBQUtDLFNBQVMsUUFBUSxjQUFjO0FBQzlELFNBQVNDLFVBQVUsUUFBUSxvQkFBb0I7QUFDL0MsU0FBU0MsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTQyxrQkFBa0IsUUFBUSxnQ0FBZ0M7QUFDbkUsU0FBU0MsZUFBZSxRQUFRLHVCQUF1QjtBQUN2RCxTQUFTQyw0QkFBNEIsUUFBUSwwQkFBMEI7QUFDdkUsU0FBU0Msd0JBQXdCLFFBQVEsc0JBQXNCO0FBQy9ELFNBQVNDLDhCQUE4QixRQUFRLDRCQUE0QjtBQUUzRSxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE9BQU87RUFDbEJDLEtBQUssRUFBRWpCLGNBQWM7RUFDckJrQixnQkFBZ0IsQ0FBQyxFQUFFLE9BQU87QUFDNUIsQ0FBQztBQUVELEtBQUtDLGFBQWEsR0FBRztFQUNuQkMsVUFBVSxFQUFFLE1BQU07RUFDbEJDLE9BQU8sRUFBRSxNQUFNO0VBQ2ZDLEtBQUssQ0FBQyxFQUFFLE1BQU07RUFDZEMsT0FBTyxDQUFDLEVBQUUsTUFBTTtBQUNsQixDQUFDO0FBRUQsTUFBTUMsa0JBQWtCLEdBQUcsSUFBSUMsTUFBTSxDQUNuQyxJQUFJdEIsb0JBQW9CLHVHQUF1R0Esb0JBQW9CLEdBQUcsRUFDdEosR0FDRixDQUFDOztBQUVEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTdUIscUJBQXFCQSxDQUFDQyxJQUFJLEVBQUUsTUFBTSxD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RUFBZ0M7SUFBQWQsV0FBQTtJQUFBRCxRQUFBO0lBQUF0QixPQUFBO0lBQUFFLE9BQUE7SUFBQUw7RUFBQSxJQUFBc0MsRUFNVDtFQUlFLE1BQUFHLEVBQUEsT0FBSWYsV0FBVyxHQUFHM0MsT0FBTyxDQUFBb0QsT0FBUSxFQUFFO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFILENBQUEsUUFBQWQsUUFBQSxJQUFBYyxDQUFBLFFBQUFFLEVBQUE7SUFBM0RDLEVBQUEsSUFBQyxJQUFJLENBQVFqQixLQUFRLENBQVJBLFNBQU8sQ0FBQyxDQUFHLENBQUFnQixFQUFrQyxDQUFFLEVBQTNELElBQUksQ0FBOEQ7SUFBQUYsQ0FBQSxNQUFBZCxRQUFBO0lBQUFjLENBQUEsTUFBQUUsRUFBQTtJQUFBRixDQUFBLE1BQUFHLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFILENBQUE7RUFBQTtFQUFBLElBQUFJLEVBQUE7RUFBQSxJQUFBSixDQUFBLFFBQUFsQyxPQUFBO0lBQ2xFc0MsRUFBQSxHQUFBdEMsT0FBa0MsSUFBdkIsQ0FBQyxJQUFJLENBQUMsQ0FBRUEsUUFBTSxDQUFFLEVBQWYsSUFBSSxDQUFrQjtJQUFBa0MsQ0FBQSxNQUFBbEMsT0FBQTtJQUFBa0MsQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFBQSxJQUFBSyxFQUFBO0VBQUEsSUFBQUwsQ0FBQSxRQUFBRyxFQUFELEdBQUFILENBQUEsUUFBQUksRUFBQTtJQUZyQ0MsRUFBQSxJQUFDLEdBQUcsQ0FDRixDQUFBRixFQUFrRSxDQUNqRSxDQUFBQyxFQUFpQyxDQUNwQyxFQUhDLEdBQUcsQ0FHRTtJQUFBSixDQUFBLE1BQUFHLEVBQUE7SUFBQUgsQ0FBQSxNQUFBSSxFQUFE7SUFBQ0osQ0FBQSxNQUFBSyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBTCxDQUFBO0VBQUE7RUFBQSxJQUFBTSxFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBcEMsT0FBQSxJQUFBb0MsQ0FBQSxRQUFBdkMsZ0JBQUE7SUFDTDZDLEVBQUEsR0FBQTdDLGdCQU1BLElBTEMsQ0FBQyxHQUFHLENBQWMsV0FBQyxDQUFELEdBQUMsQ0FDakIsQ0FBQyxJQUFJLENBQ0gsQ0FBQyxJQUFJLENBQUVHLFFBQU0sQ0FBRSxFQUFkLElBQUksQ0FDUCxFQUZDLElBQUksQ0FHUCxFQUpDLEdBQUcsQ0FLTDtJQUFBb0MsQ0FBQSxNQUFBcEMsT0FBQTtJQUFBb0MsQ0FBQSxNQUFBdkMsZ0JBQUE7SUFBQXVDLE9BQUFNLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFOLENBQUE7RUFBQTtFQUFBLElBQUFPLEVBQUE7RUFBQSxJQUFBUCxDQUFELFNBQUFLLEVBQUEsSUFBQUwsQ0FBQSxTQUFBTSxFQUFBO0lBWEhDLEVBQUEsSUFBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FBWSxTQUFDLENBQUQsR0FBQyxDQUN0QyxDQUFBRixFQUdLLENBQ0osQ0FBQUMsRUFNRCxDQUNGLEVBWkMsR0FBRyxDQVlFO0lBQUFOLENBQUEsT0FBQUssRUFBQTtJQUFBTCxDQUFBLE9BQUFNLEVBQUE7SUFBQU4sQ0FBQSxPQUFBTyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUCxDQUFBO0VBQUE7RUFBQSxPQVpOTyxFQVlNO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=
