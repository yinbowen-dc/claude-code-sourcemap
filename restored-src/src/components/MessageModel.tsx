/**
 * MessageModel.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件负责在转录模式（transcript mode）下，于助手消息旁边显示所使用的模型名称。
 * 它是消息行渲染链的一个子组件，与 MessageRow 协同工作。
 * 位于：消息列表 → 助手消息行 → 【模型名称显示区】（仅转录模式可见）
 *
 * 【主要功能】
 * 1. 判断当前场景是否需要显示模型名称：
 *    - 必须处于转录模式（isTranscriptMode）
 *    - 消息类型必须是 "assistant"
 *    - 消息必须携带 model 字段
 *    - 消息内容中必须包含至少一个 "text" 类型的 content block
 * 2. 满足条件时，以淡色文本渲染模型名称，外层 Box 设置最小宽度（模型名宽度 + 8），
 *    保证对齐。
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { stringWidth } from '../ink/stringWidth.js';
import { Box, Text } from '../ink.js';
import type { NormalizedMessage } from '../types/message.js';
type Props = {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
};

/**
 * MessageModel 组件
 *
 * 【整体流程】
 * 1. 接收 message（标准化后的消息对象）和 isTranscriptMode（是否为转录模式）
 * 2. 使用 _c(5) 创建 5 槽缓存数组
 * 3. 计算 shouldShowModel：四个条件全部满足才显示
 * 4. 不满足条件时直接返回 null
 * 5. 计算 Box 的最小宽度 t1 = 模型名字符宽度 + 8
 * 6. 若 model 值变化，重建 <Text> 节点并缓存（槽 0/1）
 * 7. 若 t1 或 t2 变化，重建 <Box> 节点并缓存（槽 2/3/4）
 * 8. 返回包含淡色模型名文本的 Box 容器
 *
 * 【设计意图】
 * 转录模式用于回放历史对话，显示模型名称帮助用户了解每条响应由哪个模型生成。
 */
export function MessageModel(t0) {
  // React Compiler 生成的 5 槽缓存数组
  const $ = _c(5);
  // 解构 message 和 isTranscriptMode 属性
  const {
    message,
    isTranscriptMode
  } = t0;
  // shouldShowModel：所有条件均满足时才展示模型名称
  // 条件1: 处于转录模式
  // 条件2: 消息类型为 "assistant"
  // 条件3: 消息携带 model 字段
  // 条件4: content 数组中包含至少一个 "text" 类型 block（_temp 辅助函数完成过滤）
  const shouldShowModel = isTranscriptMode && message.type === "assistant" && message.message.model && message.message.content.some(_temp);
  // 不满足显示条件，直接返回空
  if (!shouldShowModel) {
    return null;
  }
  // 计算 Box 最小宽度：模型名的终端显示字符宽度 + 8（额外边距）
  const t1 = stringWidth(message.message.model) + 8;
  let t2;
  // 若模型名称变化，重建淡色文本节点并缓存到槽 0/1
  if ($[0] !== message.message.model) {
    t2 = <Text dimColor={true}>{message.message.model}</Text>;
    $[0] = message.message.model; // 缓存模型名
    $[1] = t2;                    // 缓存文本节点
  } else {
    // 模型名未变，直接取缓存
    t2 = $[1];
  }
  let t3;
  // 若最小宽度或文本节点变化，重建 Box 节点并缓存到槽 2/3/4
  if ($[2] !== t1 || $[3] !== t2) {
    t3 = <Box minWidth={t1}>{t2}</Box>;
    $[2] = t1; // 缓存最小宽度
    $[3] = t2; // 缓存文本节点引用
    $[4] = t3; // 缓存 Box 节点
  } else {
    // 均未变化，直接取缓存
    t3 = $[4];
  }
  return t3;
}

/**
 * _temp 辅助函数（编译器提取的内联箭头函数）
 *
 * 【作用】
 * 作为 Array.some() 的回调，判断 content block 是否为 "text" 类型。
 * 确保只有包含文本内容的助手消息才显示模型名称。
 */
function _temp(c) {
  return c.type === "text";
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInN0cmluZ1dpZHRoIiwiQm94IiwiVGV4dCIsIk5vcm1hbGl6ZWRNZXNzYWdlIiwiUHJvcHMiLCJtZXNzYWdlIiwiaXNUcmFuc2NyaXB0TW9kZSIsIk1lc3NhZ2VNb2RlbCIsInQwIiwiJCIsIl9jIiwic2hvdWxkU2hvd01vZGVsIiwidHlwZSIsIm1vZGVsIiwiY29udGVudCIsInNvbWUiLCJfdGVtcCIsInQxIiwidDIiLCJ0MyIsImMiXSwic291cmNlcyI6WyJNZXNzYWdlTW9kZWwudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHN0cmluZ1dpZHRoIH0gZnJvbSAnLi4vaW5rL3N0cmluZ1dpZHRoLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBOb3JtYWxpemVkTWVzc2FnZSB9IGZyb20gJy4uL3R5cGVzL21lc3NhZ2UuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIG1lc3NhZ2U6IE5vcm1hbGl6ZWRNZXNzYWdlXG4gIGlzVHJhbnNjcmlwdE1vZGU6IGJvb2xlYW5cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIE1lc3NhZ2VNb2RlbCh7XG4gIG1lc3NhZ2UsXG4gIGlzVHJhbnNjcmlwdE1vZGUsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHNob3VsZFNob3dNb2RlbCA9XG4gICAgaXNUcmFuc2NyaXB0TW9kZSAmJlxuICAgIG1lc3NhZ2UudHlwZSA9PT0gJ2Fzc2lzdGFudCcgJiZcbiAgICBtZXNzYWdlLm1lc3NhZ2UubW9kZWwgJiZcbiAgICBtZXNzYWdlLm1lc3NhZ2UuY29udGVudC5zb21lKGMgPT4gYy50eXBlID09PSAndGV4dCcpXG5cbiAgaWYgKCFzaG91bGRTaG93TW9kZWwpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IG1pbldpZHRoPXtzdHJpbmdXaWR0aChtZXNzYWdlLm1lc3NhZ2UubW9kZWwpICsgOH0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj57bWVzc2FnZS5tZXNzYWdlLm1vZGVsfTwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsV0FBVyxRQUFRLHVCQUF1QjtBQUNuRCxTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxXQUFXO0FBQ3JDLGNBQWNDLGlCQUFpQixRQUFRLHFCQUFxQjtBQUU1RCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsT0FBTyxFQUFFRixpQkFBaUI7RUFDMUJHLGdCQUFnQixFQUFFLE9BQU87QUFDM0IsQ0FBQztBQUVELE9BQU8sU0FBQUMsYUFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFzQjtJQUFBTCxPQUFBO0lBQUFDO0VBQUEsSUFBQUUsRUFHckI7RUFDTixNQUFBRyxlQUFBLEdBQ0VMLGdCQUM0QixJQUE1QkQsT0FBTyxDQUFBTyxJQUFLLEtBQUssV0FDSSxJQUFyQlAsT0FBTyxDQUFBQSxPQUFRLENBQUFRLEtBQ3FDLElBQXBEUixPQUFPLENBQUFBLE9BQVEsQ0FBQVMsT0FBUSxDQUFBQyxJQUFLLENBQUNDLEtBQXNCLENBQUM7RUFFdEQsSUFBSSxDQUFDTCxlQUFlO0lBQUEsT0FDWCxJQUFJO0VBQUE7RUFJSSxNQUFBTSxFQUFBLEdBQUFqQixXQUFXLENBQUNLLE9BQU8sQ0FBQUEsT0FBUSxDQUFBUSxLQUFNLENBQUMsR0FBRyxDQUFDO0VBQUEsSUFBQUssRUFBQTtFQUFBLElBQUFULENBQUEsUUFBQUosT0FBQSxDQUFBQSxPQUFBLENBQUFRLEtBQUE7SUFDbkRLLEVBQUEsSUFBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFFLENBQUFiLE9BQU8sQ0FBQUEsT0FBUSxDQUFBUSxLQUFLLENBQUUsRUFBckMsSUFBSSxDQUF3QztJQUFBSixDQUFBLE1BQUFJLE9BQUEsQ0FBQUEsT0FBQSxDQUFBUSxLQUFBO0lBQUFKLENBQUEsTUFBQVMsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVQsQ0FBQTtFQUFBO0VBQUEsSUFBQVUsRUFBQTtFQUFBLElBQUFWLENBQUEsUUFBQVEsRUFBQSxJQUFBUixDQUFBLFFBQUFTLEVBQUE7SUFEL0NDLEVBQUEsSUFBQyxHQUFHLENBQVcsUUFBc0MsQ0FBdEMsQ0FBQUYsRUFBcUMsQ0FBQyxDQUNuRCxDQUFBQyxFQUE0QyxDQUM5QyxFQUZDLEdBQUcsQ0FFRTtJQUFBVCxDQUFBLE1BQUFRLEVBQUE7SUFBQVIsQ0FBQSxNQUFBUyxFQUFBO0lBQUFULENBQUEsTUFBQVUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVYsQ0FBQTtFQUFBO0VBQUEsT0FGTlUsRUFFTTtBQUFBO0FBakJILFNBQUFILE1BQUFJLENBQUE7RUFBQSxPQVErQkEsQ0FBQyxDQUFBUixJQUFLLEtBQUssTUFBTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
