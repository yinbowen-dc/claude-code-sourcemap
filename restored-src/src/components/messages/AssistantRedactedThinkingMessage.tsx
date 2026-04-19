/**
 * AssistantRedactedThinkingMessage.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件渲染助手消息中被"脱敏（redacted）"处理的思考块（thinking block）。
 * 当 Anthropic 出于安全或隐私原因对模型的思考内容进行脱敏时，
 * 此组件取代 AssistantThinkingMessage，仅显示占位符而不展示实际内容。
 * 位于：消息列表 → 助手消息行 → 【脱敏思考块占位符】
 *
 * 【主要功能】
 * 接收 addMargin 属性控制顶部边距，渲染一行淡色斜体的"✻ Thinking…"占位文本，
 * 告知用户此处曾有思考内容但已被脱敏，不提供 Ctrl+O 展开功能。
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Box, Text } from '../../ink.js';
type Props = {
  addMargin: boolean;
};

/**
 * AssistantRedactedThinkingMessage 组件
 *
 * 【整体流程】
 * 1. 接收 addMargin 属性（默认值 false），控制顶部外边距
 * 2. 使用 _c(3) 创建 3 槽缓存数组
 * 3. t1 将 undefined 情况归一化为 false
 * 4. t2 = addMargin ? 1 : 0（边距值）
 * 5. 槽 0：静态的淡色斜体"✻ Thinking…"文本节点，只创建一次
 * 6. 槽 1/2：依据 t2（边距值）变化缓存 Box 节点
 *
 * 【设计意图】
 * 与 AssistantThinkingMessage 的行为保持视觉一致（同样显示"✻ Thinking"），
 * 但不提供展开选项，因为内容已被脱敏，无法显示完整思考过程。
 */
export function AssistantRedactedThinkingMessage(t0) {
  // React Compiler 生成的 3 槽缓存数组
  const $ = _c(3);
  // 解构 addMargin，处理 undefined 默认值
  const {
    addMargin: t1
  } = t0;
  // 将 undefined 归一化为 false（默认不添加顶部外边距）
  const addMargin = t1 === undefined ? false : t1;
  // 计算顶部边距值：true → 1，false → 0
  const t2 = addMargin ? 1 : 0;
  let t3;
  // 槽 0：静态"✻ Thinking…"占位文本，整个组件生命周期只创建一次
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // dimColor 淡色 + italic 斜体，表示这是一个被脱敏的思考块
    t3 = <Text dimColor={true} italic={true}>✻ Thinking…</Text>;
    $[0] = t3; // 存入缓存，后续直接复用
  } else {
    t3 = $[0];
  }
  let t4;
  // 依据边距值变化，重建 Box 容器并缓存到槽 1/2
  if ($[1] !== t2) {
    t4 = <Box marginTop={t2}>{t3}</Box>;
    $[1] = t2; // 缓存边距值
    $[2] = t4; // 缓存 Box 节点
  } else {
    // 边距值未变，直接取缓存
    t4 = $[2];
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJQcm9wcyIsImFkZE1hcmdpbiIsIkFzc2lzdGFudFJlZGFjdGVkVGhpbmtpbmdNZXNzYWdlIiwidDAiLCIkIiwiX2MiLCJ0MSIsInVuZGVmaW5lZCIsInQyIiwidDMiLCJTeW1ib2wiLCJmb3IiLCJ0NCJdLCJzb3VyY2VzIjpbIkFzc2lzdGFudFJlZGFjdGVkVGhpbmtpbmdNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGFkZE1hcmdpbjogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gQXNzaXN0YW50UmVkYWN0ZWRUaGlua2luZ01lc3NhZ2Uoe1xuICBhZGRNYXJnaW4gPSBmYWxzZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8Qm94IG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9PlxuICAgICAgPFRleHQgZGltQ29sb3IgaXRhbGljPlxuICAgICAgICDinLsgVGhpbmtpbmfigKZcbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUV4QyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE9BQU87QUFDcEIsQ0FBQztBQUVELE9BQU8sU0FBQUMsaUNBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBMEM7SUFBQUosU0FBQSxFQUFBSztFQUFBLElBQUFILEVBRXpDO0VBRE4sTUFBQUYsU0FBQSxHQUFBSyxFQUFpQixLQUFqQkMsU0FBaUIsR0FBakIsS0FBaUIsR0FBakJELEVBQWlCO0VBR0MsTUFBQUUsRUFBQSxHQUFBUCxTQUFTLEdBQVQsQ0FBaUIsR0FBakIsQ0FBaUI7RUFBQSxJQUFBUSxFQUFBO0VBQUEsSUFBQUwsQ0FBQSxRQUFBTSxNQUFBLENBQUFDLEdBQUE7SUFDL0JGLEVBQUEsSUFBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFDLE1BQU0sQ0FBTixLQUFLLENBQUMsQ0FBQyxXQUV0QixFQUZDLElBQUksQ0FFRTtJQUFBTCxDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFMLENBQUE7RUFBQTtFQUFBLElBQUFRLEVBQUE7RUFBQSxJQUFBUixDQUFBLFFBQUFJLEVBQUE7SUFIVEksRUFBQSxJQUFDLEdBQUcsQ0FBWSxTQUFpQixDQUFqQixDQUFBSixFQUFnQixDQUFDLENBQy9CLENBQUFDLEVBRU0sQ0FDUixFQUpDLEdBQUcsQ0FJRTtJQUFBTCxDQUFBLE1BQUFJLEVBQUE7SUFBQUosQ0FBQSxNQUFBUSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUixDQUFBO0VBQUE7RUFBQSxPQUpOUSxFQUlNO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=
