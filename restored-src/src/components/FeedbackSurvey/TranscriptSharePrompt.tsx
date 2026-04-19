/**
 * TranscriptSharePrompt.tsx — 会话转录共享询问提示组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   反馈调查 → thanks 状态之后 → transcript_prompt 状态 → TranscriptSharePrompt
 *
 * 主要功能：
 *   TranscriptSharePrompt：向用户询问是否允许 Anthropic 查看当前会话转录，
 *   展示三个选项（1=Yes / 2=No / 3=Don't ask again），
 *   通过 useDebouncedDigitInput 处理防抖数字键输入，
 *   将数字映射为 TranscriptShareResponse 后回调 onSelect。
 *
 * 选项映射：
 *   '1' → 'yes'（同意共享）
 *   '2' → 'no'（本次拒绝）
 *   '3' → 'dont_ask_again'（永久关闭询问）
 *
 * 整体设计：
 *   所有渲染内容为静态，因此全部使用 sentinel 缓存，只有 onSelect/inputValue/setInputValue
 *   变化时才重新构造回调，避免不必要的重渲染。
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
export type TranscriptShareResponse = 'yes' | 'no' | 'dont_ask_again';
type Props = {
  onSelect: (option: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};
const RESPONSE_INPUTS = ['1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];
const inputToResponse: Record<ResponseInput, TranscriptShareResponse> = {
  '1': 'yes',
  '2': 'no',
  '3': 'dont_ask_again'
} as const;
const isValidResponseInput = (input: string): input is ResponseInput => (RESPONSE_INPUTS as readonly string[]).includes(input);
/**
 * TranscriptSharePrompt
 *
 * 整体流程：
 *   1. 解构 Props：onSelect（回调）、inputValue（当前输入字符串）、setInputValue（更新输入）
 *   2. 构造 onDigit 回调（$[0] 缓存 onSelect 引用）：
 *      digit => onSelect(inputToResponse[digit])
 *      将防抖后的数字字符映射为 TranscriptShareResponse 枚举值后触发回调
 *   3. 组装 useDebouncedDigitInput 配置对象（$[2]~$[5] 联合缓存）：
 *      inputValue、setInputValue、isValidDigit=isValidResponseInput、onDigit=t1
 *   4. 调用 useDebouncedDigitInput，监听键盘输入并在 400ms 防抖后调用 onDigit
 *   5. 渲染静态 JSX（$[6]~$[10] 均使用 sentinel 缓存，首次初始化后永不更新）：
 *      $[6]  — 问题行：BLACK_CIRCLE 图标 + 加粗提问文本
 *      $[7]  — 说明行：dimColor 展示文档 URL
 *      $[8]  — 选项 1（Yes）行，宽度 10 对齐
 *      $[9]  — 选项 2（No）行，宽度 10 对齐
 *      $[10] — 整体 column 容器，含问题、说明、选项三行
 *   6. 返回顶层 Box（t7）
 *
 * 在系统中的角色：
 *   是 FeedbackSurvey 中 transcript_prompt 状态的唯一渲染组件，
 *   负责将用户意图（数字键）转换为 TranscriptShareResponse 并向上传递。
 */
export function TranscriptSharePrompt(t0) {
  const $ = _c(11); // 11 个缓存槽：1 个 onSelect、4 个 useDebouncedDigitInput 配置、6 个静态 JSX
  const {
    onSelect,
    inputValue,
    setInputValue
  } = t0;
  let t1;
  // $[0] 缓存 onSelect 引用，仅在 onSelect 变化时重建 onDigit 回调
  if ($[0] !== onSelect) {
    t1 = digit => onSelect(inputToResponse[digit]); // 将数字字符映射为 TranscriptShareResponse
    $[0] = onSelect;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  // $[2]~$[5] 联合缓存：inputValue/setInputValue/onDigit 三者任一变化则重建配置对象
  if ($[2] !== inputValue || $[3] !== setInputValue || $[4] !== t1) {
    t2 = {
      inputValue,
      setInputValue,
      isValidDigit: isValidResponseInput, // 只允许 '1'/'2'/'3' 通过
      onDigit: t1
    };
    $[2] = inputValue;
    $[3] = setInputValue;
    $[4] = t1;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  // 注册防抖数字输入 hook，400ms 内重复按键只触发一次 onDigit
  useDebouncedDigitInput(t2);
  let t3;
  // $[6]：问题行，sentinel 保护，首次渲染后永远复用
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box><Text color="ansi:cyan">{BLACK_CIRCLE} </Text><Text bold={true}>Can Anthropic look at your session transcript to help us improve Claude Code?</Text></Box>;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  let t4;
  // $[7]：数据使用文档说明行，dimColor 降低视觉优先级
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box marginLeft={2}><Text dimColor={true}>Learn more: https://code.claude.com/docs/en/data-usage#session-quality-surveys</Text></Box>;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  // $[8]：选项 1（Yes），宽度 10 以对齐其他选项
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Box width={10}><Text><Text color="ansi:cyan">1</Text>: Yes</Text></Box>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  // $[9]：选项 2（No），宽度 10 以对齐其他选项
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box width={10}><Text><Text color="ansi:cyan">2</Text>: No</Text></Box>;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  // $[10]：顶层容器，column 布局，含问题行、说明行、三个选项行（包含内联的"3: Don't ask again"）
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Box flexDirection="column" marginTop={1}>{t3}{t4}<Box marginLeft={2}>{t5}{t6}<Box><Text><Text color="ansi:cyan">3</Text>: Don't ask again</Text></Box></Box></Box>;
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJMQUNLX0NJUkNMRSIsIkJveCIsIlRleHQiLCJ1c2VEZWJvdW5jZWREaWdpdElucHV0IiwiVHJhbnNjcmlwdFNoYXJlUmVzcG9uc2UiLCJQcm9wcyIsIm9uU2VsZWN0Iiwib3B0aW9uIiwiaW5wdXRWYWx1ZSIsInNldElucHV0VmFsdWUiLCJ2YWx1ZSIsIlJFU1BPTlNFX0lOUFVUUyIsImNvbnN0IiwiUmVzcG9uc2VJbnB1dCIsImlucHV0VG9SZXNwb25zZSIsIlJlY29yZCIsImlzVmFsaWRSZXNwb25zZUlucHV0IiwiaW5wdXQiLCJpbmNsdWRlcyIsIlRyYW5zY3JpcHRTaGFyZVByb21wdCIsInQwIiwiJCIsIl9jIiwidDEiLCJkaWdpdCIsInQyIiwiaXNWYWxpZERpZ2l0Iiwib25EaWdpdCIsInQzIiwiU3ltYm9sIiwiZm9yIiwidDQiLCJ0NSIsInQ2IiwidDciXSwic291cmNlcyI6WyJUcmFuc2NyaXB0U2hhcmVQcm9tcHQudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJMQUNLX0NJUkNMRSB9IGZyb20gJy4uLy4uL2NvbnN0YW50cy9maWd1cmVzLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdXNlRGVib3VuY2VkRGlnaXRJbnB1dCB9IGZyb20gJy4vdXNlRGVib3VuY2VkRGlnaXRJbnB1dC5qcydcblxuZXhwb3J0IHR5cGUgVHJhbnNjcmlwdFNoYXJlUmVzcG9uc2UgPSAneWVzJyB8ICdubycgfCAnZG9udF9hc2tfYWdhaW4nXG5cbnR5cGUgUHJvcHMgPSB7XG4gIG9uU2VsZWN0OiAob3B0aW9uOiBUcmFuc2NyaXB0U2hhcmVSZXNwb25zZSkgPT4gdm9pZFxuICBpbnB1dFZhbHVlOiBzdHJpbmdcbiAgc2V0SW5wdXRWYWx1ZTogKHZhbHVlOiBzdHJpbmcpID0+IHZvaWRcbn1cblxuY29uc3QgUkVTUE9OU0VfSU5QVVRTID0gWycxJywgJzInLCAnMyddIGFzIGNvbnN0XG50eXBlIFJlc3BvbnNlSW5wdXQgPSAodHlwZW9mIFJFU1BPTlNFX0lOUFVUUylbbnVtYmVyXVxuXG5jb25zdCBpbnB1dFRvUmVzcG9uc2U6IFJlY29yZDxSZXNwb25zZUlucHV0LCBUcmFuc2NyaXB0U2hhcmVSZXNwb25zZT4gPSB7XG4gICcxJzogJ3llcycsXG4gICcyJzogJ25vJyxcbiAgJzMnOiAnZG9udF9hc2tfYWdhaW4nLFxufSBhcyBjb25zdFxuXG5jb25zdCBpc1ZhbGlkUmVzcG9uc2VJbnB1dCA9IChpbnB1dDogc3RyaW5nKTogaW5wdXQgaXMgUmVzcG9uc2VJbnB1dCA9PlxuICAoUkVTUE9OU0VfSU5QVVRTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyhpbnB1dClcblxuZXhwb3J0IGZ1bmN0aW9uIFRyYW5zY3JpcHRTaGFyZVByb21wdCh7XG4gIG9uU2VsZWN0LFxuICBpbnB1dFZhbHVlLFxuICBzZXRJbnB1dFZhbHVlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICB1c2VEZWJvdW5jZWREaWdpdElucHV0KHtcbiAgICBpbnB1dFZhbHVlLFxuICAgIHNldElucHV0VmFsdWUsXG4gICAgaXNWYWxpZERpZ2l0OiBpc1ZhbGlkUmVzcG9uc2VJbnB1dCxcbiAgICBvbkRpZ2l0OiBkaWdpdCA9PiBvblNlbGVjdChpbnB1dFRvUmVzcG9uc2VbZGlnaXRdKSxcbiAgfSlcblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17MX0+XG4gICAgICA8Qm94PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImFuc2k6Y3lhblwiPntCTEFDS19DSVJDTEV9IDwvVGV4dD5cbiAgICAgICAgPFRleHQgYm9sZD5cbiAgICAgICAgICBDYW4gQW50aHJvcGljIGxvb2sgYXQgeW91ciBzZXNzaW9uIHRyYW5zY3JpcHQgdG8gaGVscCB1cyBpbXByb3ZlXG4gICAgICAgICAgQ2xhdWRlIENvZGU/XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuXG4gICAgICA8Qm94IG1hcmdpbkxlZnQ9ezJ9PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICBMZWFybiBtb3JlOlxuICAgICAgICAgIGh0dHBzOi8vY29kZS5jbGF1ZGUuY29tL2RvY3MvZW4vZGF0YS11c2FnZSNzZXNzaW9uLXF1YWxpdHktc3VydmV5c1xuICAgICAgICA8L1RleHQ+XG4gICAgICA8L0JveD5cblxuICAgICAgPEJveCBtYXJnaW5MZWZ0PXsyfT5cbiAgICAgICAgPEJveCB3aWR0aD17MTB9PlxuICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgPFRleHQgY29sb3I9XCJhbnNpOmN5YW5cIj4xPC9UZXh0PjogWWVzXG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgICAgPEJveCB3aWR0aD17MTB9PlxuICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgPFRleHQgY29sb3I9XCJhbnNpOmN5YW5cIj4yPC9UZXh0PjogTm9cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgICA8Qm94PlxuICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgPFRleHQgY29sb3I9XCJhbnNpOmN5YW5cIj4zPC9UZXh0PjogRG9uJmFwb3M7dCBhc2sgYWdhaW5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgPC9Cb3g+XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssTUFBTSxPQUFPO0FBQ3pCLFNBQVNDLFlBQVksUUFBUSw0QkFBNEI7QUFDekQsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxzQkFBc0IsUUFBUSw2QkFBNkI7QUFFcEUsT0FBTyxLQUFLQyx1QkFBdUIsR0FBRyxLQUFLLEdBQUcsSUFBSSxHQUFHLGdCQUFnQjtBQUVyRSxLQUFLQyxLQUFL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