/**
 * GroupedToolUseContent.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件处于工具调用渲染管线的聚合层，专门用于将多个同类型的工具调用
 * 合并成一个分组视图进行展示，例如将多个并行执行的文件读取操作聚合显示。
 *
 * 主要功能：
 * - 接收 GroupedToolUseMessage（分组工具调用消息）及相关上下文
 * - 通过 findToolByName 找到对应工具的 renderGroupedToolUse 渲染函数
 * - 构建 resultsByToolUseId 映射，将工具结果按 tool_use_id 索引
 * - 组装 toolUsesData 数组（含 isResolved/isError/isInProgress 等状态标志）
 * - 将组装好的数据交给工具自身的 renderGroupedToolUse 方法完成最终渲染
 */
import type { ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
import * as React from 'react';
import { filterToolProgressMessages, findToolByName, type Tools } from '../../Tool.js';
import type { GroupedToolUseMessage } from '../../types/message.js';
import type { buildMessageLookups } from '../../utils/messages.js';

// 组件 Props 类型定义：包含分组消息、工具列表、查询索引、进行中的工具 ID 集合以及动画标志
type Props = {
  message: GroupedToolUseMessage;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  inProgressToolUseIDs: Set<string>;
  shouldAnimate: boolean;
};

/**
 * GroupedToolUseContent 组件
 *
 * 流程说明：
 * 1. 通过 findToolByName 在工具注册表中查找与消息 toolName 对应的工具实现
 * 2. 若该工具未实现 renderGroupedToolUse 接口，则直接返回 null（不渲染）
 * 3. 遍历 message.results（所有工具结果消息），构建 resultsByToolUseId 映射，
 *    仅保留类型为 'tool_result' 的内容块，按 tool_use_id 快速索引
 * 4. 遍历 message.messages（所有工具调用消息），组装 toolUsesData 数组，
 *    为每个调用附加 isResolved/isError/isInProgress/progressMessages/result 字段
 * 5. 判断是否有任何调用处于进行中（anyInProgress）
 * 6. 调用 tool.renderGroupedToolUse(toolUsesData, options) 完成分组渲染
 *
 * 在系统流程中的角色：
 * 由上层消息列表在遇到 grouped_tool_use 类型消息时渲染此组件，
 * 实现工具调用的聚合展示而非逐条显示。
 */
export function GroupedToolUseContent({
  message,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate
}: Props): React.ReactNode {
  // 在工具注册表中查找与该消息 toolName 匹配的工具对象
  const tool = findToolByName(tools, message.toolName);
  // 若工具不存在或未实现分组渲染接口，则返回 null 跳过渲染
  if (!tool?.renderGroupedToolUse) {
    return null;
  }

  // Build a map from tool_use_id to result data
  // 构建 tool_use_id → 结果数据 的索引映射，便于后续 O(1) 查找
  const resultsByToolUseId = new Map<string, {
    param: ToolResultBlockParam;
    output: unknown;
  }>();
  // 遍历所有结果消息，提取 tool_result 类型的内容块并存入映射
  for (const resultMsg of message.results) {
    for (const content of resultMsg.message.content) {
      if (content.type === 'tool_result') {
        // 以 tool_use_id 为键，存储原始参数块和工具执行结果
        resultsByToolUseId.set(content.tool_use_id, {
          param: content,
          output: resultMsg.toolUseResult
        });
      }
    }
  }

  // 将每条工具调用消息转换为含完整状态信息的数据对象
  const toolUsesData = message.messages.map(msg => {
    // 取消息内容数组的第一个块作为工具调用参数
    const content = msg.message.content[0];
    // 从映射中查找对应的工具结果（可能为 undefined，表示尚未完成）
    const result = resultsByToolUseId.get(content.id);
    return {
      param: content as ToolUseBlockParam,
      // 是否已解析完成（存在于 resolvedToolUseIDs 集合中）
      isResolved: lookups.resolvedToolUseIDs.has(content.id),
      // 是否执行出错（存在于 erroredToolUseIDs 集合中）
      isError: lookups.erroredToolUseIDs.has(content.id),
      // 是否正在进行中（存在于 inProgressToolUseIDs 集合中）
      isInProgress: inProgressToolUseIDs.has(content.id),
      // 过滤后的进度消息列表（去除无关的系统消息）
      progressMessages: filterToolProgressMessages(lookups.progressMessagesByToolUseID.get(content.id) ?? []),
      result
    };
  });

  // 若有任意一个调用处于进行中，则启用动画（同时受外部 shouldAnimate 控制）
  const anyInProgress = toolUsesData.some(d => d.isInProgress);
  // 委托给工具自身的 renderGroupedToolUse 方法完成最终渲染
  return tool.renderGroupedToolUse(toolUsesData, {
    shouldAnimate: shouldAnimate && anyInProgress,
    tools
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlRvb2xVc2VCbG9ja1BhcmFtIiwiUmVhY3QiLCJmaWx0ZXJUb29sUHJvZ3Jlc3NNZXNzYWdlcyIsImZpbmRUb29sQnlOYW1lIiwiVG9vbHMiLCJHcm91cGVkVG9vbFVzZU1lc3NhZ2UiLCJidWlsZE1lc3NhZ2VMb29rdXBzIiwiUHJvcHMiLCJtZXNzYWdlIiwidG9vbHMiLCJsb29rdXBzIiwiUmV0dXJuVHlwZSIsImluUHJvZ3Jlc3NUb29sVXNlSURzIiwiU2V0Iiwic2hvdWxkQW5pbWF0ZSIsIkdyb3VwZWRUb29sVXNlQ29udGVudCIsIlJlYWN0Tm9kZSIsInRvb2wiLCJ0b29sTmFtZSIsInJlbmRlckdyb3VwZWRUb29sVXNlIiwicmVzdWx0c0J5VG9vbFVzZUlkIiwiTWFwIiwicGFyYW0iLCJvdXRwdXQiLCJyZXN1bHRNc2ciLCJyZXN1bHRzIiwiY29udGVudCIsInR5cGUiLCJzZXQiLCJ0b29sX3VzZV9pZCIsInRvb2xVc2VSZXN1bHQiLCJ0b29sVXNlc0RhdGEiLCJtZXNzYWdlcyIsIm1hcCIsIm1zZyIsInJlc3VsdCIsImdldCIsImlkIiwiaXNSZXNvbHZlZCIsInJlc29sdmVkVG9vbFVzZUlEcyIsImhhcyIsImlzRXJyb3IiLCJlcnJvcmVkVG9vbFVzZUlEcyIsImlzSW5Qcm9ncmVzcyIsInByb2dyZXNzTWVzc2FnZXMiLCJwcm9ncmVzc01lc3NhZ2VzQnlUb29sVXNlSUQiLCJhbnlJblByb2dyZXNzIiwic29tZSIsImQiXSwic291cmNlcyI6WyJHcm91cGVkVG9vbFVzZUNvbnRlbnQudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHtcbiAgVG9vbFJlc3VsdEJsb2NrUGFyYW0sXG4gIFRvb2xVc2VCbG9ja1BhcmFtLFxufSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvbWVzc2FnZXMvbWVzc2FnZXMubWpzJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQge1xuICBmaWx0ZXJUb29sUHJvZ3Jlc3NNZXNzYWdlcyxcbiAgZmluZFRvb2xCeU5hbWUsXG4gIHR5cGUgVG9vbHMsXG59IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IEdyb3VwZWRUb29sVXNlTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgdHlwZSB7IGJ1aWxkTWVzc2FnZUxvb2t1cHMgfSBmcm9tICcuLi8uLi91dGlscy9tZXNzYWdlcy5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgbWVzc2FnZTogR3JvdXBlZFRvb2xVc2VNZXNzYWdlXG4gIHRvb2xzOiBUb29sc1xuICBsb29rdXBzOiBSZXR1cm5UeXBlPHR5cGVvZiBidWlsZE1lc3NhZ2VMb29rdXBzPlxuICBpblByb2dyZXNzVG9vbFVzZUlEczogU2V0PHN0cmluZz5cbiAgc2hvdWxkQW5pbWF0ZTogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gR3JvdXBlZFRvb2xVc2VDb250ZW50KHtcbiAgbWVzc2FnZSxcbiAgdG9vbHMsXG4gIGxvb2t1cHMsXG4gIGluUHJvZ3Jlc3NUb29sVXNlSURzLFxuICBzaG91bGRBbmltYXRlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCB0b29sID0gZmluZFRvb2xCeU5hbWUodG9vbHMsIG1lc3NhZ2UudG9vbE5hbWUpXG4gIGlmICghdG9vbD8ucmVuZGVyR3JvdXBlZFRvb2xVc2UpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgLy8gQnVpbGQgYSBtYXAgZnJvbSB0b29sX3VzZV9pZCB0byByZXN1bHQgZGF0YVxuICBjb25zdCByZXN1bHRzQnlUb29sVXNlSWQgPSBuZXcgTWFwPFxuICAgIHN0cmluZyxcbiAgICB7IHBhcmFtOiBUb29sUmVzdWx0QmxvY2tQYXJhbTsgb3V0cHV0OiB1bmtub3duIH1cbiAgPigpXG4gIGZvciAoY29uc3QgcmVzdWx0TXNnIG9mIG1lc3NhZ2UucmVzdWx0cykge1xuICAgIGZvciAoY29uc3QgY29udGVudCBvZiByZXN1bHRNc2cubWVzc2FnZS5jb250ZW50KSB7XG4gICAgICBpZiAoY29udGVudC50eXBlID09PSAndG9vbF9yZXN1bHQnKSB7XG4gICAgICAgIHJlc3VsdHNCeVRvb2xVc2VJZC5zZXQoY29udGVudC50b29sX3VzZV9pZCwge1xuICAgICAgICAgIHBhcmFtOiBjb250ZW50LFxuICAgICAgICAgIG91dHB1dDogcmVzdWx0TXNnLnRvb2xVc2VSZXN1bHQsXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdG9vbFVzZXNEYXRhID0gbWVzc2FnZS5tZXNzYWdlcy5tYXAobXNnID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gbXNnLm1lc3NhZ2UuY29udGVudFswXVxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc3VsdHNCeVRvb2xVc2VJZC5nZXQoY29udGVudC5pZClcbiAgICByZXR1cm4ge1xuICAgICAgcGFyYW06IGNvbnRlbnQgYXMgVG9vbFVzZUJsb2NrUGFyYW0sXG4gICAgICBpc1Jlc29sdmVkOiBsb29rdXBzLnJlc29sdmVkVG9vbFVzZUlEcy5oYXMoY29udGVudC5pZCksXG4gICAgICBpc0Vycm9yOiBsb29rdXBzLmVycm9yZWRUb29sVXNlSURzLmhhcyhjb250ZW50LmlkKSxcbiAgICAgIGlzSW5Qcm9ncmVzczogaW5Qcm9ncmVzc1Rvb2xVc2VJRHMuaGFzKGNvbnRlbnQuaWQpLFxuICAgICAgcHJvZ3Jlc3NNZXNzYWdlczogZmlsdGVyVG9vbFByb2dyZXNzTWVzc2FnZXMoXG4gICAgICAgIGxvb2t1cHMucHJvZ3Jlc3NNZXNzYWdlc0J5VG9vbFVzZUlELmdldChjb250ZW50LmlkKSA/PyBbXSxcbiAgICAgICksXG4gICAgICByZXN1bHQsXG4gICAgfVxuICB9KVxuXG4gIGNvbnN0IGFueUluUHJvZ3Jlc3MgPSB0b29sVXNlc0RhdGEuc29tZShkID0+IGQuaXNJblByb2dyZXNzKVxuXG4gIHJldHVybiB0b29sLnJlbmRlckdyb3VwZWRUb29sVXNlKHRvb2xVc2VzRGF0YSwge1xuICAgIHNob3VsZEFuaW1hdGU6IHNob3VsZEFuaW1hdGUgJiYgYW55SW5Qcm9ncmVzcyxcbiAgICB0b29scyxcbiAgfSlcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsY0FDRUEsb0JBQW9CLEVBQ3BCQyxpQkFBaUIsUUFDWixtREFBbUQ7QUFDMUQsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUNFQywwQkFBMEIsRUFDMUJDLGNBQWMsRUFDZCxLQUFLQyxLQUFLLFFBQ0wsZUFBZTtBQUN0QixjQUFjQyxxQkFBcUIsUUFBUSx3QkFBd0I7QUFDbkUsY0FBY0MsbUJBQW1CLFFBQVEseUJBQXlCO0FBRWxFLEtBQUtDLEtBQUssR0FBRztFQUNYQyxPQUFPLEVBQUVILHFCQUFxQjtFQUM5QkksS0FBSyxFQUFFTCxLQUFLO0VBQ1pNLE9BQU8sRUFBRUMsVUFBVSxDQUFDLE9BQU9MLG1CQUFtQixDQUFDO0VBQy9DTSxvQkFBb0IsRUFBRUMsR0FBRyxDQUFDLE1BQU0sQ0FBQztFQUNqQ0MsYUFBYSxFQUFFLE9BQU87QUFDeEIsQ0FBQztBQUVELE9BQU8sU0FBU0MscUJBQXFCQSxDQUFDO0VBQ3BDUCxPQUFPO0VBQ1BDLEtBQUs7RUFDTEMsT0FBTztFQUNQRSxvQkFBb0I7RUFDcEJFO0FBQ0ssQ0FBTixFQUFFUCxLQUFLLENBQUMsRUFBRU4sS0FBSyxDQUFDZSxTQUFTLENBQUM7RUFDekIsTUFBTUMsSUFBSSxHQUFHZCxjQUFjLENBQUNNLEtBQUssRUFBRUQsT0FBTyxDQUFDVSxRQUFRLENBQUM7RUFDcEQsSUFBSSxDQUFDRCxJQUFJLEVBQUVFLG9CQUFvQixFQUFFO0lBQy9CLE9BQU8sSUFBSTtFQUNiOztFQUVBO0VBQ0EsTUFBTUMsa0JBQWtCLEdBQUcsSUFBSUMsR0FBRyxDQUNoQyxNQUFNLEVBQ047SUFBRUMsS0FBSyxFQUFFdkIsb0JBQW9CO0lBQUV3QixNQUFNLEVBQUUsT0FBTztFQUFDLENBQUMsQ0FDakQsQ0FBQyxDQUFDO0VBQ0gsS0FBSyxNQUFNQyxTQUFTLElBQUloQixPQUFPLENBQUNpQixPQUFPLEVBQUU7SUFDdkMsS0FBSyxNQUFNQyxPQUFPLElBQUlGLFNBQVMsQ0FBQ2hCLE9BQU8sQ0FBQ2tCLE9BQU8sRUFBRTtNQUMvQyxJQUFJQSxPQUFPLENBQUNDLElBQUksS0FBSyxhQUFhLEVBQUU7UUFDbENQLGtCQUFrQixDQUFDUSxHQUFHLENBQUNGLE9BQU8sQ0FBQ0csV0FBVyxFQUFFO1VBQzFDUCxLQUFLLEVBQUVJLE9BQU87VUFDZEgsTUFBTSxFQUFFQyxTQUFTLENBQUNNO1FBQ3BCLENBQUMsQ0FBQztNQUNKO0lBQ0Y7RUFDRjtFQUVBLE1BQU1DLFlBQVksR0FBR3ZCLE9BQU8sQ0FBQ3dCLFFBQVEsQ0FBQ0MsR0FBRyxDQUFDQyxHQUFHLElBQUk7SUFDL0MsTUFBTVIsT0FBTyxHQUFHUSxHQUFHLENBQUMxQixPQUFPLENBQUNrQixPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ3RDLE1BQU1TLE1BQU0sR0FBR2Ysa0JBQWtCLENBQUNnQixHQUFHLENBQUNWLE9BQU8sQ0FBQ1csRUFBRSxDQUFDO0lBQ2pELE9BQU87TUFDTGYsS0FBSyxFQUFFSSxPQUFPLElBQUkxQixpQkFBaUI7TUFDbkNzQyxVQUFVLEVBQUU1QixPQUFPLENBQUM2QixrQkFBa0IsQ0FBQ0MsR0FBRyxDQUFDZCxPQUFPLENBQUNXLEVBQUUsQ0FBQztNQUN0REksT0FBTyxFQUFFL0IsT0FBTyxDQUFDZ0MsaUJBQWlCLENBQUNGLEdBQUcsQ0FBQ2QsT0FBT8CUFW1vT0FBQ1csRUFBRSxDQUFDO01BQ2xETSxZQUFZLEVBQUUvQixvQkFBb0IsQ0FBQzRCLEdBQUcsQ0FBQ2QsT0FBTyxDQUFDVyxFQUFFLENBQUM7TUFDbERPLGdCQUFnQixFQUFFMUMsMEJBQTBCLENBQzFDUSxPQUFPLENBQUNtQywyQkFBMkIsQ0FBQ1QsR0FBRyxDQUFDVixPQUFPLENBQUNXLEVBQUUsQ0FBQyxJQUFJLEVBQ3pELENBQUM7TUFDREY7SUFDRixDQUFDO0VBQ0gsQ0FBQyxDQUFDO0VBRUYsTUFBTVcsYUFBYSxHQUFHZixZQUFZLENBQUNnQixJQUFJLENBQUNDLENBQUMsSUFBSUEsQ0FBQyxDQUFDTCxZQUFZLENBQUM7RUFFNUQsT0FBTzFCLElBQUksQ0FBQ0Usb0JBQW9CLENBQUNZLFlBQVksRUFBRTtJQUM3Q2pCLGFBQWEsRUFBRUEsYUFBYSxJQUFJZ0MsYUFBYTtJQUM3Q3JDO0VBQ0YsQ0FBQyxDQUFDO0FBQ0oiLCJpZ25vcmVMaXN0IjpbXX0=
