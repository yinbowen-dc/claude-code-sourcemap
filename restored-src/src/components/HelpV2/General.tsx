/**
 * HelpV2/General.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件是帮助对话框（HelpV2）的"general"选项卡内容组件，
 * 由 HelpV2.tsx 在构建 tabs 数组时以固定的 <Tab key="general"> 形式嵌入。
 *
 * 主要功能：
 * 1. 展示一段 Claude Code 的简短功能描述文字
 * 2. 展示快捷键列表（通过 PromptInputHelpMenu 组件渲染）
 *
 * 该组件没有任何 props，内容完全静态，因此 React 编译器只需两个缓存槽位，
 * 初始化后永不重新渲染（哨兵值 Symbol.for("react.memo_cache_sentinel") 永不再被命中）。
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';

/**
 * General 组件
 *
 * 整体流程：
 * 1. React 编译器分配 2 个缓存槽位（$[0] 和 $[1]）。
 * 2. 首次渲染时，$[0] 为初始化哨兵值，因此进入 if 分支：
 *    - 构建描述文字 Box（t0），存入 $[0]
 *    - 构建外层 Box（t1，包含描述 + 快捷键标题 + PromptInputHelpMenu），存入 $[1]
 * 3. 后续渲染中，$[0] 和 $[1] 已被赋值，直接复用缓存，跳过重新构建。
 * 4. 返回 t1（外层 Box）。
 *
 * 完全静态组件：无 props、无 state、无 effect，仅渲染固定内容。
 */
export function General() {
  // React 编译器运行时：分配 2 个缓存槽位
  const $ = _c(2);

  let t0;
  // 检查缓存槽位 $[0] 是否为初始化哨兵值（首次渲染时为 true）
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：构建 Claude Code 功能描述文字块
    t0 = (
      <Box>
        <Text>Claude understands your codebase, makes edits with your permission, and executes commands — right from your terminal.</Text>
      </Box>
    );
    $[0] = t0; // 缓存描述文字块，后续渲染直接复用
  } else {
    t0 = $[0];
  }

  let t1;
  // 检查外层布局是否已缓存（$[1] 依赖 $[0]，只需一个槽位覆盖整体结构）
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：构建包含描述 + 快捷键的完整布局
    t1 = (
      <Box flexDirection="column" paddingY={1} gap={1}>
        {/* 功能描述文字 */}
        {t0}
        <Box flexDirection="column">
          {/* 快捷键标题 */}
          <Box>
            <Text bold={true}>Shortcuts</Text>
          </Box>
          {/* 快捷键列表：gap=2 列间距，fixedWidth 固定宽度对齐 */}
          <PromptInputHelpMenu gap={2} fixedWidth={true} />
        </Box>
      </Box>
    );
    $[1] = t1; // 缓存整体布局
  } else {
    t1 = $[1];
  }

  return t1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJQcm9tcHRJbnB1dEhlbHBNZW51IiwiR2VuZXJhbCIsIiQiLCJfYyIsInQwIiwiU3ltYm9sIiwiZm9yIiwidDEiXSwic291cmNlcyI6WyJHZW5lcmFsLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IFByb21wdElucHV0SGVscE1lbnUgfSBmcm9tICcuLi9Qcm9tcHRJbnB1dC9Qcm9tcHRJbnB1dEhlbHBNZW51LmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gR2VuZXJhbCgpOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIHBhZGRpbmdZPXsxfSBnYXA9ezF9PlxuICAgICAgPEJveD5cbiAgICAgICAgPFRleHQ+XG4gICAgICAgICAgQ2xhdWRlIHVuZGVyc3RhbmRzIHlvdXIgY29kZWJhc2UsIG1ha2VzIGVkaXRzIHdpdGggeW91ciBwZXJtaXNzaW9uLFxuICAgICAgICAgIGFuZCBleGVjdXRlcyBjb21tYW5kcyDigJQgcmlnaHQgZnJvbSB5b3VyIHRlcm1pbmFsLlxuICAgICAgICA8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8Qm94PlxuICAgICAgICAgIDxUZXh0IGJvbGQ+U2hvcnRjdXRzPC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgICAgPFByb21wdElucHV0SGVscE1lbnUgZ2FwPXsyfSBmaXhlZFdpZHRoPXt0cnVlfSAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxtQkFBbUIsUUFBUSx1Q0FBdUM7QUFFM0UsT0FBTyxTQUFBQyxRQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFGLENBQUEsUUFBQUcsTUFBQSxDQUFBQyxHQUFBO0lBR0RGLEVBQUEsSUFBQyxHQUFHLENBQ0YsQ0FBQyxJQUFJLENBQUMscUhBR04sRUFIQyxJQUFJLENBSVAsRUFMQyxHQUFHLENBS0U7SUFBQUYsQ0FBQSxNQUFBRSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBRixDQUFBO0VBQUE7RUFBQSxJQUFBSyxFQUFBO0VBQUEsSUFBQUwsQ0FBQSxRQUFBRyxNQUFBLENBQUFDLEdBQUE7SUFOUkMsRUFBQSxJQUFDLEdBQUcsQ0FBZSxhQUFRLENBQVIsUUFBUSxDQUFXLFFBQUMsQ0FBRCxHQUFDLENBQU8sR0FBQyxDQUFELEdBQUMsQ0FDN0MsQ0FBQUgsSUFLSyxDQUNMLENBQUMsR0FBRyxDQUFlLGFBQVEsQ0FBUixRQUFRLENBQ3pCLENBQUMsR0FBRyxDQUNGLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBSixLQUFHLENBQUMsQ0FBQyxTQUFTLEVBQW5CLElBQUksQ0FDUCxFQUZDLEdBQUcsQ0FHSixDQUFDLG1CQUFtQixDQUFNLEdBQUMsQ0FBRCxHQUFDLENBQWMsVUFBSSxDQUFKLEtBQUcsQ0FBQyxHQUMvQyxFQUxDLEdBQUcsQ0FNTixFQWJDLEdBQUcsQ0FhRTtJQUFBRixDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFMLENBQUE7RUFBQTtFQUFBLE9BYk5LLEVBYU07QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
