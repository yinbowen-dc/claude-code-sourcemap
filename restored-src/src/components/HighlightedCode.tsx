/**
 * HighlightedCode.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件提供终端代码高亮渲染能力，被多处使用（如工具调用结果展示、文件内容预览等）。
 * 优先使用 Rust 原生 ColorFile 引擎进行语法高亮；
 * 若 ColorFile 不可用或语法高亮被禁用，则降级到 HighlightedCodeFallback（JS 实现）。
 *
 * 主要功能：
 * 1. 自动测量容器宽度（若未传入 width prop），用于正确截断长行
 * 2. 在全屏模式下分离行号列（gutter）与代码列，并用 NoSelect 包裹行号以避免复制时包含行号
 * 3. 通过 memo() 包裹避免父组件重渲染时不必要的重计算
 * 4. CodeLine 子组件处理单行的行号/代码分离渲染
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, type DOMElement, measureElement, NoSelect, Text, useTheme } from '../ink.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import sliceAnsi from '../utils/sliceAnsi.js';
import { countCharInString } from '../utils/stringUtils.js';
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js';
import { expectColorFile } from './StructuredDiff/colorDiff.js';

// 组件属性类型定义
type Props = {
  code: string;         // 要高亮显示的代码文本
  filePath: string;     // 文件路径，用于推断语言类型
  width?: number;       // 可选：指定渲染宽度（字符数），未指定则自动测量
  dim?: boolean;        // 可选：是否以暗色显示（默认 false）
};

// 默认渲染宽度（字符数），在 DOM 测量结果可用前使用
const DEFAULT_WIDTH = 80;

/**
 * HighlightedCode 组件（memo 包裹）
 *
 * 整体流程：
 * 1. 读取用户设置中的 syntaxHighlightingDisabled 标志。
 * 2. 尝试获取 ColorFile（Rust 原生高亮引擎）：
 *    - 若语法高亮被禁用或 ColorFile 不可用，colorFile 为 null
 *    - 否则以 code + filePath 实例化 ColorFile，并记忆化
 * 3. 通过 useEffect 测量 DOM 容器实际宽度（仅在未传入 width 时执行），
 *    减去 2 作为内边距偏移，更新 measuredWidth。
 * 4. 通过 colorFile.render(theme, measuredWidth, dim) 生成带 ANSI 颜色码的行数组。
 * 5. 若启用了全屏模式，计算 gutter 宽度（行号位数 + 2 个空格）。
 * 6. 渲染：
 *    - colorFile 可用时：遍历 lines，全屏模式下用 CodeLine 分离行号，否则直接渲染 Ansi 文本
 *    - colorFile 不可用时：降级到 HighlightedCodeFallback
 */
export const HighlightedCode = memo(function HighlightedCode(t0) {
  // React 编译器运行时：分配 21 个缓存槽位
  const $ = _c(21);
  const {
    code,
    filePath,
    width,
    dim: t1   // dim 可能为 undefined
  } = t0;

  // dim 默认值为 false
  const dim = t1 === undefined ? false : t1;

  // DOM ref：用于在 useEffect 中测量容器宽度
  const ref = useRef(null);

  // 已测量宽度：有传入 width 则直接用，否则先用默认值等待测量结果
  const [measuredWidth, setMeasuredWidth] = useState(width || DEFAULT_WIDTH);

  // 当前主题（light/dark），传入 ColorFile.render() 影响颜色选取
  const [theme] = useTheme();

  // 用户设置
  const settings = useSettings();

  // 是否禁用语法高亮（来自用户设置，null coalescing 默认为 false）
  const syntaxHighlightingDisabled = settings.syntaxHighlightingDisabled ?? false;

  let t2;
  // bb0: 记忆化 colorFile 实例（相当于 useMemo，含条件提前退出）
  bb0: {
    if (syntaxHighlightingDisabled) {
      t2 = null; // 用户禁用了语法高亮，直接返回 null
      break bb0;
    }

    let t3;
    // ColorFile 构造函数只需获取一次（静态，永久缓存）
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = expectColorFile(); // 尝试获取 Rust 原生高亮引擎
      $[0] = t3;
    } else {
      t3 = $[0];
    }
    const ColorFile = t3;

    if (!ColorFile) {
      t2 = null; // Rust 引擎不可用，降级
      break bb0;
    }

    let t4;
    // 记忆化 ColorFile 实例：code 或 filePath 变化时重新创建
    if ($[1] !== code || $[2] !== filePath) {
      t4 = new ColorFile(code, filePath); // 以代码和文件路径实例化高亮引擎
      $[1] = code;
      $[2] = filePath;
      $[3] = t4;
    } else {
      t4 = $[3];
    }
    t2 = t4;
  }
  const colorFile = t2;

  let t3;
  let t4;
  // 记忆化 useEffect 依赖（width 变化时重新生成 effect 函数）
  if ($[4] !== width) {
    t3 = () => {
      // 未传入 width 时，测量 DOM 容器的实际宽度
      if (!width && ref.current) {
        const {
          width: elementWidth
        } = measureElement(ref.current);
        if (elementWidth > 0) {
          setMeasuredWidth(elementWidth - 2); // 减 2 作为内边距偏移
        }
      }
    };
    t4 = [width]; // 依赖数组：width 改变时重新执行
    $[4] = width;
    $[5] = t3;
    $[6] = t4;
  } else {
    t3 = $[5];
    t4 = $[6];
  }
  useEffect(t3, t4);

  let t5;
  // bb1: 记忆化渲染结果 lines（colorFile.render 调用）
  bb1: {
    if (colorFile === null) {
      t5 = null; // 无高亮引擎，跳过
      break bb1;
    }

    let t6;
    // colorFile、dim、measuredWidth、theme 任一变化时重新渲染
    if ($[7] !== colorFile || $[8] !== dim || $[9] !== measuredWidth || $[10] !== theme) {
      t6 = colorFile.render(theme, measuredWidth, dim); // 生成带颜色码的行字符串数组
      $[7] = colorFile;
      $[8] = dim;
      $[9] = measuredWidth;
      $[10] = theme;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    t5 = t6;
  }
  const lines = t5;

  let t6;
  // bb2: 记忆化 gutterWidth（行号列宽度，仅全屏模式有值）
  bb2: {
    if (!isFullscreenEnvEnabled()) {
      t6 = 0; // 非全屏模式不需要行号列
      break bb2;
    }

    // 行数 = 换行符数量 + 1
    const lineCount = countCharInString(code, "\n") + 1;
    let t7;
    // 记忆化行数字符串长度
    if ($[12] !== lineCount) {
      t7 = lineCount.toString(); // 转字符串以获取位数
      $[12] = lineCount;
      $[13] = t7;
    } else {
      t7 = $[13];
    }
    // 行号宽度 = 数字位数 + 2（左右各一个空格）
    t6 = t7.length + 2;
  }
  const gutterWidth = t6;

  let t7;
  // 最终 JSX 记忆化：任何影响渲染的参数变化时重新构建
  if ($[14] !== code || $[15] !== dim || $[16] !== filePath || $[17] !== gutterWidth || $[18] !== lines || $[19] !== syntaxHighlightingDisabled) {
    t7 = (
      <Box ref={ref}>
        {lines
          ? (
            // ColorFile 渲染成功：遍历行数组
            <Box flexDirection="column">
              {lines.map((line, i) =>
                gutterWidth > 0
                  ? (
                    // 全屏模式：用 CodeLine 分离行号与代码内容
                    <CodeLine key={i} line={line} gutterWidth={gutterWidth} />
                  )
                  : (
                    // 非全屏模式：直接渲染整行 ANSI 文本
                    <Text key={i}><Ansi>{line}</Ansi></Text>
                  )
              )}
            </Box>
          )
          : (
            // 降级：使用 JS 实现的 fallback 高亮器
            <HighlightedCodeFallback
              code={code}
              filePath={filePath}
              dim={dim}
              skipColoring={syntaxHighlightingDisabled} // 语法高亮被禁用时跳过着色
            />
          )}
      </Box>
    );
    $[14] = code;
    $[15] = dim;
    $[16] = filePath;
    $[17] = gutterWidth;
    $[18] = lines;
    $[19] = syntaxHighlightingDisabled;
    $[20] = t7;
  } else {
    t7 = $[20]; // 命中缓存，复用渲染结果
  }
  return t7;
});

/**
 * CodeLine 组件（内部使用）
 *
 * 整体流程：
 * 用于全屏模式下将单行代码拆分为行号（gutter）和代码内容（content）两部分：
 * - 行号部分用 NoSelect 包裹，防止全屏鼠标选择时包含行号
 * - 代码部分正常渲染 ANSI 文本
 *
 * 使用 sliceAnsi 按字符宽度切分（正确处理 ANSI 转义序列）：
 * - gutter = sliceAnsi(line, 0, gutterWidth)    前 gutterWidth 个字符（行号区）
 * - content = sliceAnsi(line, gutterWidth)       剩余字符（代码区）
 */
function CodeLine(t0) {
  // React 编译器运行时：分配 13 个缓存槽位
  const $ = _c(13);
  const {
    line,
    gutterWidth
  } = t0;

  let t1;
  // 记忆化行号部分
  if ($[0] !== gutterWidth || $[1] !== line) {
    t1 = sliceAnsi(line, 0, gutterWidth); // 切取行号区字符串
    $[0] = gutterWidth;
    $[1] = line;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const gutter = t1;

  let t2;
  // 记忆化代码内容部分
  if ($[3] !== gutterWidth || $[4] !== line) {
    t2 = sliceAnsi(line, gutterWidth); // 切取代码区字符串
    $[3] = gutterWidth;
    $[4] = line;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const content = t2;

  let t3;
  // 记忆化行号 JSX（包含 NoSelect 防止复制时包含行号）
  if ($[6] !== gutter) {
    t3 = (
      <NoSelect fromLeftEdge={true}>  {/* 从左边缘开始不可选中 */}
        <Text><Ansi>{gutter}</Ansi></Text>
      </NoSelect>
    );
    $[6] = gutter;
    $[7] = t3;
  } else {
    t3 = $[7];
  }

  let t4;
  // 记忆化代码内容 JSX
  if ($[8] !== content) {
    t4 = <Text><Ansi>{content}</Ansi></Text>;
    $[8] = content;
    $[9] = t4;
  } else {
    t4 = $[9];
  }

  let t5;
  // 记忆化行布局（横向排列：行号 + 代码）
  if ($[10] !== t3 || $[11] !== t4) {
    t5 = <Box flexDirection="row">{t3}{t4}</Box>;
    $[10] = t3;
    $[11] = t4;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  return t5;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIm1lbW8iLCJ1c2VFZmZlY3QiLCJ1c2VNZW1vIiwidXNlUmVmIiwidXNlU3RhdGUiLCJ1c2VTZXR0aW5ncyIsIkFuc2kiLCJCb3giLCJET01FbGVtZW50IiwibWVhc3VyZUVsZW1lbnQiLCJOb1NlbGVjdCIsIlRleHQiLCJ1c2VUaGVtZSIsImlzRnVsbHNjcmVlbkVudkVuYWJsZWQiLCJzbGljZUFuc2kiLCJjb3VudENoYXJJblN0cmluZyIsIkhpZ2hsaWdodGVkQ29kZUZhbGxiYWNrIiwiZXhwZWN0Q29sb3JGaWxlIiwiUHJvcHMiLCJjb2RlIiwiZmlsZVBhdGgiLCJ3aWR0aCIsImRpbSIsIkRFRkFVTFRfV0lEVEgiLCJIaWdobGlnaHRlZENvZGUiLCJ0MCIsIiQiLCJfYyIsInQxIiwidW5kZWZpbmVkIiwicmVmIiwibWVhc3VyZWRXaWR0aCIsInNldE1lYXN1cmVkV2lkdGgiLCJ0aGVtZSIsInNldHRpbmdzIiwic3ludGF4SGlnaGxpZ2h0aW5nRGlzYWJsZWQiLCJ0MiIsImJiMCIsInQzIiwiU3ltYm9sIiwiZm9yIiwiQ29sb3JGaWxlIiwidDQiLCJjb2xvckZpbGUiLCJjdXJyZW50IiwiZWxlbWVudFdpZHRoIiwidDUiLCJiYjEiLCJ0NiIsInJlbmRlciIsImxpbmVzIiwiYmIyIiwibGluZUNvdW50IiwidDciLCJ0b1N0cmluZyIsImxlbmd0aCIsImd1dHRlcldpZHRoIiwibWFwIiwibGluZSIsImkiLCJDb2RlTGluZSIsImd1dHRlciIsImNvbnRlbnQiXSwic291cmNlcyI6WyJIaWdobGlnaHRlZENvZGUudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgbWVtbywgdXNlRWZmZWN0LCB1c2VNZW1vLCB1c2VSZWYsIHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VTZXR0aW5ncyB9IGZyb20gJy4uL2hvb2tzL3VzZVNldHRpbmdzLmpzJ1xuaW1wb3J0IHtcbiAgQW5zaSxcbiAgQm94LFxuICB0eXBlIERPTUVsZW1lbnQsXG4gIG1lYXN1cmVFbGVtZW50LFxuICBOb1NlbGVjdCxcbiAgVGV4dCxcbiAgdXNlVGhlbWUsXG59IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7IGlzRnVsbHNjcmVlbkVudkVuYWJsZWQgfSBmcm9tICcuLi91dGlscy9mdWxsc2NyZWVuLmpzJ1xuaW1wb3J0IHNsaWNlQW5zaSBmcm9tICcuLi91dGlscy9zbGljZUFuc2kuanMnXG5pbXBvcnQgeyBjb3VudENoYXJJblN0cmluZyB9IGZyb20gJy4uL3V0aWxzL3N0cmluZ1V0aWxzLmpzJ1xuaW1wb3J0IHsgSGlnaGxpZ2h0ZWRDb2RlRmFsbGJhY2sgfSBmcm9tICcuL0hpZ2hsaWdodGVkQ29kZS9GYWxsYmFjay5qcydcbmltcG9ydCB7IGV4cGVjdENvbG9yRmlsZSB9IGZyb20gJy4vU3RydWN0dXJlZERpZmYvY29sb3JEaWZmLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBjb2RlOiBzdHJpbmdcbiAgZmlsZVBhdGg6IHN0cmluZ1xuICB3aWR0aD86IG51bWJlclxuICBkaW0/OiBib29sZWFuXG59XG5cbmNvbnN0IERFRkFVTFRfV0lEVEggPSA4MFxuXG5leHBvcnQgY29uc3QgSGlnaGxpZ2h0ZWRDb2RlID0gbWVtbyhmdW5jdGlvbiBIaWdobGlnaHRlZENvZGUoe1xuICBjb2RlLFxuICBmaWxlUGF0aCxcbiAgd2lkdGgsXG4gIGRpbSA9IGZhbHNlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdEVsZW1lbnQge1xuICBjb25zdCByZWYgPSB1c2VSZWY8RE9NRWxlbWVudD4obnVsbClcbiAgY29uc3QgW21lYXN1cmVkV2lkdGgsIHNldE1lYXN1cmVkV2lkdGhdID0gdXNlU3RhdGUod2lkdGggfHwgREVGQVVMVF9XSURUSClcbiAgY29uc3QgW3RoZW1lXSA9IHVzZVRoZW1lKClcbiAgY29uc3Qgc2V0dGluZ3MgPSB1c2VTZXR0aW5ncygpXG4gIGNvbnN0IHN5bnRheEhpZ2hsaWdodGluZ0Rpc2FibGVkID1cbiAgICBzZXR0aW5ncy5zeW50YXhIaWdobGlnaHRpbmdEaXNhYmxlZCA/PyBmYWxzZVxuXG4gIGNvbnN0IGNvbG9yRmlsZSA9IHVzZU1lbW8oKCkgPT4ge1xuICAgIGlmIChzeW50YXhIaWdobGlnaHRpbmdEaXNhYmxlZCkge1xuICAgICAgcmV0dXJuIG51bGxcbiAgICB9XG4gICAgY29uc3QgQ29sb3JGaWxlID0gZXhwZWN0Q29sb3JGaWxlKClcbiAgICBpZiAoIUNvbG9yRmlsZSkge1xuICAgICAgcmV0dXJuIG51bGxcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBDb2xvckZpbGUoY29kZSwgZmlsZVBhdGgpXG4gIH0sIFtjb2RlLCBmaWxlUGF0aCwgc3ludGF4SGlnaGxpZ2h0aW5nRGlzYWJsZWRdKVxuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCF3aWR0aCAmJiByZWYuY3VycmVudCkge1xuICAgICAgY29uc3QgeyB3aWR0aDogZWxlbWVudFdpZHRoIH0gPSBtZWFzdXJlRWxlbWVudChyZWYuY3VycmVudClcbiAgICAgIGlmIChlbGVtZW50V2lkdGggPiAwKSB7XG4gICAgICAgIHNldE1lYXN1cmVkV2lkdGgoZWxlbWVudFdpZHRoIC0gMilcbiAgICAgIH1cbiAgICB9XG4gIH0sIFt3aWR0aF0pXG5cbiAgY29uc3QgbGluZXMgPSB1c2VNZW1vKCgpID0+IHtcbiAgICBpZiAoY29sb3JGaWxlID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cbiAgICByZXR1cm4gY29sb3JGaWxlLnJlbmRlcih0aGVtZSwgbWVhc3VyZWRXaWR0aCwgZGltKVxuICB9LCBbY29sb3JGaWxlLCB0aGVtZSwgbWVhc3VyZWRXaWR0aCwgZGltXSlcblxuICAvLyBHdXR0ZXIgd2lkdGggbWF0Y2hlcyBDb2xvckZpbGUncyBsYXlvdXQgaW4gbGliLnJzOiBzcGFjZSArIHJpZ2h0LWFsaWduZWRcbiAgLy8gbGluZSBudW1iZXIgKG1heF9kaWdpdHMgPSBsaW5lQ291bnQudG9TdHJpbmcoKS5sZW5ndGgpICsgc3BhY2UuIE5vIG1hcmtlclxuICAvLyBjb2x1bW4gbGlrZSB0aGUgZGlmZiBwYXRoLiBXcmFwIGluIDxOb1NlbGVjdD4gc28gZnVsbHNjcmVlbiBzZWxlY3Rpb25cbiAgLy8geWllbGRzIGNsZWFuIGNvZGUgd2l0aG91dCBsaW5lIG51bWJlcnMuIE9ubHkgc3BsaXQgaW4gZnVsbHNjcmVlbiBtb2RlXG4gIC8vICh+NMOXIERPTSBub2RlcyArIHNsaWNlQW5zaSBjb3N0KTsgbm9uLWZ1bGxzY3JlZW4gdXNlcyB0ZXJtaW5hbC1uYXRpdmVcbiAgLy8gc2VsZWN0aW9uIHdoZXJlIG5vU2VsZWN0IGlzIG1lYW5pbmdsZXNzLlxuICBjb25zdCBndXR0ZXJXaWR0aCA9IHVzZU1lbW8oKCkgPT4ge1xuICAgIGlmICghaXNGdWxsc2NyZWVuRW52RW5hYmxlZCgpKSByZXR1cm4gMFxuICAgIGNvbnN0IGxpbmVDb3VudCA9IGNvdW50Q2hhckluU3RyaW5nKGNvZGUsICdcXG4nKSArIDFcbiAgICByZXR1cm4gbGluZUNvdW50LnRvU3RyaW5nKCkubGVuZ3RoICsgMlxuICB9LCBbY29kZV0pXG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IHJlZj17cmVmfT5cbiAgICAgIHtsaW5lcyA/IChcbiAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAge2xpbmVzLm1hcCgobGluZSwgaSkgPT5cbiAgICAgICAgICAgIGd1dHRlcldpZHRoID4gMCA/IChcbiAgICAgICAgICAgICAgPENvZGVMaW5lIGtleT17aX0gbGluZT17bGluZX0gZ3V0dGVyV2lkdGg9e2d1dHRlcldpZHRofSAvPlxuICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgPFRleHQga2V5PXtpfT5cbiAgICAgICAgICAgICAgICA8QW5zaT57bGluZX08L0Fuc2k+XG4gICAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgICksXG4gICAgICAgICAgKX1cbiAgICAgICAgPC9Cb3g+XG4gICAgICApIDogKFxuICAgICAgICA8SGlnaGxpZ2h0ZWRDb2RlRmFsbGJhY2tcbiAgICAgICAgICBjb2RlPXtjb2RlfVxuICAgICAgICAgIGZpbGVQYXRoPXtmaWxlUGF0aH1cbiAgICAgICAgICBkaW09e2RpbX1cbiAgICAgICAgICBza2lwQ29sb3Jpbmc9e3N5bnRheEhpZ2hsaWdodGluZ0Rpc2FibGVkfVxuICAgICAgICAvPlxuICAgICAgKX1cbiAgICA8L0JveD5cbiAgKVxufSlcblxuZnVuY3Rpb24gQ29kZUxpbmUoe1xuICBsaW5lLFxuICBndXR0ZXJXaWR0aCxcbn06IHtcbiAgbGluZTogc3RyaW5nXG4gIGd1dHRlcldpZHRoOiBudW1iZXJcbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBndXR0ZXIgPSBzbGljZUFuc2kobGluZSwgMCwgZ3V0dGVyV2lkdGgpXG4gIGNvbnN0IGNvbnRlbnQgPSBzbGljZUFuc2kobGluZSwgZ3V0dGVyV2lkdGgpXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCI+XG4gICAgICA8Tm9TZWxlY3QgZnJvbUxlZnRFZGdlPlxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8QW5zaT57Z3V0dGVyfTwvQW5zaT5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Ob1NlbGVjdD5cbiAgICAgIDxUZXh0PlxuICAgICAgICA8QW5zaT57Y29udGVudH08L0Fuc2k+XG4gICAgICA8L1RleHQ+XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsSUFBSSxFQUFFQyxTQUFTLEVBQUVDLE9BQU8sRUFBRUMsTUFBTSxFQUFFQyxRQUFRLFFBQVEsT0FBTztBQUNsRSxTQUFTQyxXQUFXLFFBQVEseUJBQXlCO0FBQ3JELFNBQ0VDLElBQUksRUFDSkMsR0FBRyxFQUNILEtBQUtDLFVBQVUsRUFDZkMsY0FBYyxFQUNkQyxRQUFRLEVBQ1JDLElBQUksRUFD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
