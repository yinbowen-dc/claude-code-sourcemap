/**
 * HighlightedCode/Fallback.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件是语法高亮渲染链的"降级后备"环节，当主引擎 ColorFile（Rust/WASM）
 * 不可用时，由 HighlightedCode.tsx 调用 <HighlightedCodeFallback> 作为备选。
 * 亦可在 HighlightedCode 内直接使用（skipColoring=true 完全跳过着色）。
 *
 * 主要功能：
 * 1. 维护模块级 LRU 缓存（hlCache，上限 500 条），避免虚拟滚动反复卸载/挂载
 *    时重复调用 hl.highlight()（该操作是 CPU 热点）。缓存键为 hashPair(language, code)
 *    而非原始字符串，防止内存中保留大量源码（#24180 RSS 修复）。
 * 2. HighlightedCodeFallback：外层组件，负责参数默认值处理、skipColoring 快速路径、
 *    以及将 <Highlighted>（异步）包裹在 <Suspense> 内以实现流式加载。
 * 3. Highlighted（私有组件）：通过 React 18 use() 挂钩等待 CLI highlight 库加载完成，
 *    然后执行语言探测 → cachedHighlight → 错误兜底 → 返回 ANSI 字符串的完整流程。
 */

import { c as _c } from "react/compiler-runtime";
import { extname } from 'path';
import React, { Suspense, use, useMemo } from 'react';
import { Ansi, Text } from '../../ink.js';
import { getCliHighlightPromise } from '../../utils/cliHighlight.js';
import { logForDebugging } from '../../utils/debug.js';
import { convertLeadingTabsToSpaces } from '../../utils/file.js';
import { hashPair } from '../../utils/hash.js';
type Props = {
  code: string;
  filePath: string;
  dim?: boolean;
  skipColoring?: boolean;
};

// Module-level highlight cache — hl.highlight() is the hot cost on virtual-
// scroll remounts. useMemo doesn't survive unmount→remount. Keyed by hash
// of code+language to avoid retaining full source strings (#24180 RSS fix).
// 模块级高亮缓存：上限 500 条，以 LRU 策略（删除最旧条目）管理内存。
const HL_CACHE_MAX = 500;
// Map 的迭代顺序即插入顺序，利用此特性实现 LRU：命中时移至末尾，溢出时删除头部。
const hlCache = new Map<string, string>();

/**
 * cachedHighlight — 带 LRU 缓存的高亮函数
 *
 * 流程：
 * 1. 用 hashPair(language, code) 生成缓存键，避免保留完整源码字符串。
 * 2. 命中缓存：先删后插（移至 Map 末尾，保持 LRU 顺序），直接返回缓存结果。
 * 3. 未命中：调用 hl.highlight(code, {language}) 生成 ANSI 着色字符串。
 * 4. 若缓存已满（size >= 500），删除 Map 第一个条目（最久未使用）。
 * 5. 将新结果插入 Map 末尾并返回。
 */
function cachedHighlight(hl: NonNullable<Awaited<ReturnType<typeof getCliHighlightPromise>>>, code: string, language: string): string {
  // 计算缓存键：language + code 的哈希，避免存储原始字符串
  const key = hashPair(language, code);
  const hit = hlCache.get(key);
  if (hit !== undefined) {
    // LRU 命中：删除旧位置后重新插入末尾，保证最近使用的条目不被淘汰
    hlCache.delete(key);
    hlCache.set(key, hit);
    return hit;
  }
  // 缓存未命中：调用 highlight 引擎生成 ANSI 着色输出
  const out = hl.highlight(code, {
    language
  });
  // 缓存已满时，删除 Map 迭代器的第一个条目（最旧/最久未使用）
  if (hlCache.size >= HL_CACHE_MAX) {
    const first = hlCache.keys().next().value;
    if (first !== undefined) hlCache.delete(first);
  }
  // 插入新条目至末尾
  hlCache.set(key, out);
  return out;
}

/**
 * HighlightedCodeFallback — 降级高亮组件（对外导出）
 *
 * 整体流程：
 * 1. 解构 props，为 dim/skipColoring 提供默认值 false（编译器生成的三元赋值）。
 * 2. 缓存槽 $[0/$[1]：将 code 转换为 codeWithSpaces（制表符→空格），以 code 为依赖缓存。
 * 3. skipColoring 快速路径（$[2~$[6]）：
 *    - 直接渲染 <Text dimColor={dim}><Ansi>{codeWithSpaces}</Ansi></Text>，跳过所有着色逻辑。
 * 4. 语言检测（$[7/$[8]）：用 extname(filePath).slice(1) 提取文件扩展名作为语言标识。
 * 5. 降级 fallback（$[9/$[10]）：构建 <Ansi>{codeWithSpaces}</Ansi> 作为 Suspense 的 fallback。
 * 6. 高亮节点（$[11~$[13]）：构建 <Highlighted codeWithSpaces language />，包裹在 Suspense 内。
 * 7. Suspense 节点（$[14~$[16]）：<Suspense fallback={未着色ANSI}>{Highlighted}</Suspense>。
 * 8. 外层 Text（$[17~$[19]）：<Text dimColor={dim}>{Suspense}</Text>，20 个缓存槽。
 */
export function HighlightedCodeFallback(t0) {
  // React 编译器运行时：分配 20 个缓存槽位
  const $ = _c(20);
  const {
    code,
    filePath,
    dim: t1,       // dim 可选，默认 false
    skipColoring: t2  // skipColoring 可选，默认 false
  } = t0;
  // 为可选 props 赋予默认值（编译器将默认参数展开为三元表达式）
  const dim = t1 === undefined ? false : t1;
  const skipColoring = t2 === undefined ? false : t2;
  let t3;
  // 缓存 convertLeadingTabsToSpaces(code)：仅当 code 变化时重新计算
  if ($[0] !== code) {
    t3 = convertLeadingTabsToSpaces(code); // 将缩进 Tab 转换为等宽空格，避免终端对齐问题
    $[0] = code;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const codeWithSpaces = t3;
  // === skipColoring 快速路径：完全跳过着色，直接渲染纯文本 ===
  if (skipColoring) {
    let t4;
    // 缓存 <Ansi>{codeWithSpaces}</Ansi>，以 codeWithSpaces 为依赖
    if ($[2] !== codeWithSpaces) {
      t4 = <Ansi>{codeWithSpaces}</Ansi>; // Ansi 处理 ANSI 转义序列（即使无高亮也可能含颜色码）
      $[2] = codeWithSpaces;
      $[3] = t4;
    } else {
      t4 = $[3];
    }
    let t5;
    // 缓存外层 <Text dimColor>，以 dim 和 t4 为依赖
    if ($[4] !== dim || $[5] !== t4) {
      t5 = <Text dimColor={dim}>{t4}</Text>; // dimColor 控制终端灰显效果
      $[4] = dim;
      $[5] = t4;
      $[6] = t5;
    } else {
      t5 = $[6];
    }
    return t5; // 快速路径：直接返回，不进入后续 Suspense 逻辑
  }
  // === 正常路径：需要语法高亮 ===
  let t4;
  // 缓存语言标识：从文件路径提取扩展名（如 ".tsx" → "tsx"）
  if ($[7] !== filePath) {
    t4 = extname(filePath).slice(1); // slice(1) 去掉前导点号
    $[7] = filePath;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const language = t4;
  // 构建 Suspense fallback：在 hl 库尚未加载完成时显示未着色的原始代码
  let t5;
  if ($[9] !== codeWithSpaces) {
    t5 = <Ansi>{codeWithSpaces}</Ansi>; // 降级 fallback：无颜色的原始代码
    $[9] = codeWithSpaces;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  // 构建 <Highlighted> 节点（内部使用 use() 异步等待 hl 库）
  let t6;
  if ($[11] !== codeWithSpaces || $[12] !== language) {
    t6 = <Highlighted codeWithSpaces={codeWithSpaces} language={language} />;
    $[11] = codeWithSpaces;
    $[12] = language;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  // 构建 <Suspense fallback={未着色ANSI}>{Highlighted}</Suspense>
  // 当 Highlighted 内部 use() 挂起时，显示 fallback（未着色代码）
  let t7;
  if ($[14] !== t5 || $[15] !== t6) {
    t7 = <Suspense fallback={t5}>{t6}</Suspense>;
    $[14] = t5;
    $[15] = t6;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  // 构建最外层 <Text dimColor={dim}>，包裹 Suspense 节点
  let t8;
  if ($[17] !== dim || $[18] !== t7) {
    t8 = <Text dimColor={dim}>{t7}</Text>;
    $[17] = dim;
    $[18] = t7;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  return t8;
}

/**
 * Highlighted — 私有异步高亮组件
 *
 * 整体流程：
 * 1. 缓存槽 $[0]：用 Symbol.for 哨兵检测首次渲染，调用 getCliHighlightPromise() 获取
 *    Promise（仅在组件实例首次挂载时创建一次，后续渲染复用同一 Promise）。
 * 2. use(t1)：React 18 use() 挂钩，若 Promise 尚未 resolve，则挂起当前组件（触发
 *    上层 <Suspense> 显示 fallback）；resolve 后 hl 即为已加载的高亮库实例。
 * 3. bb0 标记块（$[1~$[4]）：编译自 useMemo([codeWithSpaces, language, hl])，
 *    仅当三者之一变化时重新执行：
 *    a. hl 为 null（库加载失败）→ 返回原始 codeWithSpaces，break bb0 提前退出。
 *    b. 确定 highlightLang：默认 "markdown"；若 language 非空且 hl.supportsLanguage
 *       返回 true，则使用原语言；否则记录 debug 日志并回退到 markdown。
 *    c. try/catch：调用 cachedHighlight(hl, codeWithSpaces, highlightLang)。
 *       - 若抛出 "Unknown language" 错误（$[5~$[7] 内嵌缓存）：
 *         记录 debug 日志，改用 "markdown" 重新高亮，break bb0。
 *       - 其他错误：返回原始 codeWithSpaces 作为最终兜底。
 * 4. 将高亮结果 out 渲染为 <Ansi>{out}</Ansi>（10 个缓存槽）。
 */
function Highlighted(t0) {
  // React 编译器运行时：分配 10 个缓存槽位
  const $ = _c(10);
  const {
    codeWithSpaces,
    language
  } = t0;
  let t1;
  // 缓存槽 $[0]：仅在首次渲染时调用 getCliHighlightPromise()
  // 该 Promise 在模块生命周期内只创建一次（单例模式），后续渲染复用
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getCliHighlightPromise(); // 懒加载 CLI highlight 库的 Promise
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  // use() 是 React 18 新 API：若 Promise pending，抛出 Promise 触发 Suspense；
  // resolve 后 hl 为高亮库实例（或 null 表示加载失败）
  const hl = use(t1);
  let t2;
  // bb0 标记块：编译自 useMemo(() => {...}, [codeWithSpaces, language, hl])
  // 仅当 codeWithSpaces、hl 或 language 任意一个变化时，才重新执行内部逻辑
  if ($[1] !== codeWithSpaces || $[2] !== hl || $[3] !== language) {
    bb0: {
      // hl 为 null：高亮库不可用，直接返回原始代码（无高亮）
      if (!hl) {
        t2 = codeWithSpaces;
        break bb0; // 提前退出 bb0 标记块
      }
      // 默认回退语言：markdown（支持通用代码块渲染）
      let highlightLang = "markdown";
      if (language) {
        if (hl.supportsLanguage(language)) {
          // 高亮库支持该语言，使用原始语言标识
          highlightLang = language;
        } else {
          // 不支持该语言，记录调试日志并回退到 markdown
          logForDebugging(`Language not supported while highlighting code, falling back to markdown: ${language}`);
        }
      }
      ;
      try {
        // 正常路径：带缓存的高亮调用
        t2 = cachedHighlight(hl, codeWithSpaces, highlightLang);
      } catch (t3) {
        const e = t3;
        // 捕获 "Unknown language" 错误：高亮库运行时不支持该语言
        if (e instanceof Error && e.message.includes("Unknown language")) {
          logForDebugging(`Language not supported while highlighting code, falling back to markdown: ${e}`);
          let t4;
          // 内嵌缓存（$[5/$[6/$[7]）：以 codeWithSpaces + hl 为依赖，
          // 缓存 markdown 回退高亮结果（避免同组件重渲染时重复 fallback 调用）
          if ($[5] !== codeWithSpaces || $[6] !== hl) {
            t4 = cachedHighlight(hl, codeWithSpaces, "markdown"); // 最终回退：用 markdown 高亮
            $[5] = codeWithSpaces;
            $[6] = hl;
            $[7] = t4;
          } else {
            t4 = $[7];
          }
          t2 = t4;
          break bb0; // 回退成功，退出 bb0 标记块
        }
        // 其他未知错误：返回原始代码（无高亮）作为最终兜底
        t2 = codeWithSpaces;
      }
    }
    // 更新 bb0 的三个依赖缓存槽
    $[1] = codeWithSpaces;
    $[2] = hl;
    $[3] = language;
    $[4] = t2; // 缓存高亮结果
  } else {
    t2 = $[4]; // 依赖未变化，复用缓存的高亮结果
  }
  const out = t2;
  let t3;
  // 缓存最终的 <Ansi>{out}</Ansi> 节点，以 out 为依赖
  if ($[8] !== out) {
    t3 = <Ansi>{out}</Ansi>; // Ansi 组件解析 ANSI 转义序列并渲染为终端颜色
    $[8] = out;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJleHRuYW1lIiwiUmVhY3QiLCJTdXNwZW5zZSIsInVzZSIsInVzZU1lbW8iLCJBbnNpIiwiVGV4dCIsImdldENsaUhpZ2hsaWdodFByb21pc2UiLCJsb2dGb3JEZWJ1Z2dpbmciLCJjb252ZXJ0TGVhZGluZ1RhYnNUb1NwYWNlcyIsImhhc2hQYWlyIiwiUHJvcHMiLCJjb2RlIiwiZmlsZVBhdGgiLCJkaW0iLCJza2lwQ29sb3JpbmciLCJITF9DQUNIRV9NQVgiLCJobENhY2hlIiwiTWFwIiwiY2FjaGVkSGlnaGxpZ2h0IiwiaGwiLCJOb25OdWxsYWJsZSIsIkF3YWl0ZWQiLCJSZXR1cm5UeXBlIiwibGFuZ3VhZ2UiLCJrZXkiLCJoaXQiLCJnZXQiLCJ1bmRlZmluZWQiLCJkZWxldGUiLCJzZXQiLCJvdXQiLCJoaWdobGlnaHQiLCJzaXplIiwiZmlyc3QiLCJrZXlzIiwibmV4dCIsInZhbHVlIiwiSGlnaGxpZ2h0ZWRDb2RlRmFsbGJhY2siLCJ0MCIsIiQiLCJfYyIsInQxIiwidDIiLCJ0MyIsImNvZGVXaXRoU3BhY2VzIiwidDQiLCJ0NSIsInNsaWNlIiwidDYiLCJ0NyIsInQ4IiwiSGlnaGxpZ2h0ZWQiLCJTeW1ib2wiLCJmb3IiLCJiYjAiLCJoaWdobGlnaHRMYW5nIiwic3VwcG9ydHNMYW5ndWFnZSIsImUiLCJFcnJvciIsIm1lc3NhZ2UiLCJpbmNsdWRlcyJdLCJzb3VyY2VzIjpbIkZhbGxiYWNrLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBleHRuYW1lIH0gZnJvbSAncGF0aCdcbmltcG9ydCBSZWFjdCwgeyBTdXNwZW5zZSwgdXNlLCB1c2VNZW1vIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBBbnNpLCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZ2V0Q2xpSGlnaGxpZ2h0UHJvbWlzZSB9IGZyb20gJy4uLy4uL3V0aWxzL2NsaUhpZ2hsaWdodC5qcydcbmltcG9ydCB7IGxvZ0ZvckRlYnVnZ2luZyB9IGZyb20gJy4uLy4uL3V0aWxzL2RlYnVnLmpzJ1xuaW1wb3J0IHsgY29udmVydExlYWRpbmdUYWJzVG9TcGFjZXMgfSBmcm9tICcuLi8uLi91dGlscy9maWxlLmpzJ1xuaW1wb3J0IHsgaGFzaFBhaXIgfSBmcm9tICcuLi8uLi91dGlscy9oYXNoLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBjb2RlOiBzdHJpbmdcbiAgZmlsZVBhdGg6IHN0cmluZ1xuICBkaW0/OiBib29sZWFuXG4gIHNraXBDb2xvcmluZz86IGJvb2xlYW5cbn1cblxuLy8gTW9kdWxlLWxldmVsIGhpZ2hsaWdodCBjYWNoZSDigJQgaGwuaGlnaGxpZ2h0KCkgaXMgdGhlIGhvdCBjb3N0IG9uIHZpcnR1YWwtXG4vLyBzY3JvbGwgcmVtb3VudHMuIHVzZU1lbW8gZG9lc24ndCBzdXJ2aXZlIHVubW91bnTihpJyZW1vdW50LiBLZXllZCBieSBoYXNoXG4vLyBvZiBjb2RlK2xhbmd1YWdlIHRvIGF2b2lkIHJldGFpbmluZyBmdWxsIHNvdXJjZSBzdHJpbmdzICgjMjQxODAgUlNTIGZpeCkuXG5jb25zdCBITF9DQUNIRV9NQVggPSA1MDBcbmNvbnN0IGhsQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpXG5mdW5jdGlvbiBjYWNoZWRIaWdobGlnaHQoXG4gIGhsOiBOb25OdWxsYWJsZTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGdldENsaUhpZ2hsaWdodFByb21pc2U+Pj4sXG4gIGNvZGU6IHN0cmluZyxcbiAgbGFuZ3VhZ2U6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGtleSA9IGhhc2hQYWlyKGxhbmd1YWdlLCBjb2RlKVxuICBjb25zdCBoaXQgPSBobENhY2hlLmdldChrZXkpXG4gIGlmIChoaXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGhsQ2FjaGUuZGVsZXRlKGtleSlcbiAgICBobENhY2hlLnNldChrZXksIGhpdClcbiAgICByZXR1cm4gaGl0XG4gIH1cbiAgY29uc3Qgb3V0ID0gaGwuaGlnaGxpZ2h0KGNvZGUsIHsgbGFuZ3VhZ2UgfSlcbiAgaWYgKGhsQ2FjaGUuc2l6ZSA+PSBITF9DQUNIRV9NQVgpIHtcbiAgICBjb25zdCBmaXJzdCA9IGhsQ2FjaGUua2V5cygpLm5leHQoKS52YWx1ZVxuICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkKSBobENhY2hlLmRlbGV0ZShmaXJzdClcbiAgfVxuICBobENhY2hlLnNldChrZXksIG91dClcbiAgcmV0dXJuIG91dFxufVxuXG5leHBvcnQgZnVuY3Rpb24gSGlnaGxpZ2h0ZWRDb2RlRmFsbGJhY2soe1xuICBjb2RlLFxuICBmaWxlUGF0aCxcbiAgZGltID0gZmFsc2UsXG4gIHNraXBDb2xvcmluZyA9IGZhbHNlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdEVsZW1lbnQge1xuICBjb25zdCBjb2RlV2l0aFNwYWNlcyA9IGNvbnZlcnRMZWFkaW5nVGFic1RvU3BhY2VzKGNvZGUpXG4gIGlmIChza2lwQ29sb3JpbmcpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPFRleHQgZGltQ29sb3I9e2RpbX0+XG4gICAgICAgIDxBbnNpPntjb2RlV2l0aFNwYWNlc308L0Fuc2k+XG4gICAgICA8L1RleHQ+XG4gICAgKVxuICB9XG4gIGNvbnN0IGxhbmd1YWdlID0gZXh0bmFtZShmaWxlUGF0aCkuc2xpY2UoMSlcbiAgcmV0dXJuIChcbiAgICA8VGV4dCBkaW1Db2xvcj17ZGltfT5cbiAgICAgIDxTdXNwZW5zZSBmYWxsYmFjaz17PEFuc2k+e2NvZGVXaXRoU3BhY2VzfTwvQW5zaT59PlxuICAgICAgICA8SGlnaGxpZ2h0ZWQgY29kZVdpdGhTcGFjZXM9e2NvZGVXaXRoU3BhY2VzfSBsYW5ndWFnZT17bGFuZ3VhZ2V9IC8+XG4gICAgICA8L1N1c3BlbnNlPlxuICAgIDwvVGV4dD5cbiAgKVxufVxuXG5mdW5jdGlvbiBIaWdobGlnaHRlZCh7XG4gIGNvZGVXaXRoU3BhY2VzLFxuICBsYW5ndWFnZSxcbn06IHtcbiAgY29kZVdpdGhTcGFjZXM6IHN0cmluZ1xuICBsYW5ndWFnZTogc3RyaW5nXG59KTogUmVhY3QuUmVhY3RFbGVtZW50IHtcbiAgY29uc3QgaGwgPSB1c2UoZ2V0Q2xpSGlnaGxpZ2h0UHJvbWlzZSgpKVxuICBjb25zdCBvdXQgPSB1c2VNZW1vKCgpID0+IHtcbiAgICBpZiAoIWhsKSByZXR1cm4gY29kZVdpdGhTcGFjZXNcbiAgICBsZXQgaGlnaGxpZ2h0TGFuZyA9ICdtYXJrZG93bidcbiAgICBpZiAobGFuZ3VhZ2UpIHtcbiAgICAgIGlmIChobC5zdXBwb3J0c0xhbmd1YWdlKGxhbmd1YWdlKSkge1xuICAgICAgICBoaWdobGlnaHRMYW5nID0gbGFuZ3VhZ2VcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICBgTGFuZ3VhZ2Ugbm90IHN1cHBvcnRlZCB3aGlsZSBoaWdobGlnaHRpbmcgY29kZSwgZmFsbGluZyBiYWNrIHRvIG1hcmtkb3duOiAke2xhbmd1YWdlfWAsXG4gICAgICAgIClcbiAgICAgIH1cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBjYWNoZWRIaWdobGlnaHQoaGwsIGNvZGVXaXRoU3BhY2VzLCBoaWdobGlnaHRMYW5nKVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlIGluc3RhbmNlb2YgRXJyb3IgJiYgZS5tZXNzYWdlLmluY2x1ZGVzKCdVbmtub3duIGxhbmd1YWdlJykpIHtcbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgIGBMYW5ndWFnZSBub3Qgc3VwcG9ydGVkIHdoaWxlIGhpZ2hsaWdodGluZyBjb2RlLCBmYWxsaW5nIGJhY2sgdG8gbWFya2Rvd246ICR7ZX1gLFxuICAgICAgICApXG4gICAgICAgIHJldHVybiBjYWNoZWRIaWdobGlnaHQoaGwsIGNvZGVXaXRoU3BhY2VzLCAnbWFya2Rvd24nKVxuICAgICAgfVxuICAgICAgcmV0dXJuIGNvZGVXaXRoU3BhY2VzXG4gICAgfVxuICB9LCBbY29kZVdpdGhTcGFjZXMsIGxhbmd1YWdlLCBobF0pXG4gIHJldHVy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Q0FBQSxRQUFBSyxjQUFBO01BR1ZDLEVBQUEsSUFBQyxJQUFJLENBQUVELGVBQWEsQ0FBRSxFQUFyQixJQUFJLENBQXdCO01BQUFMLENBQUEsTUFBQUssY0FBQTtNQUFBTCxDQUFBLE1BQUFJLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUFKLENBQUE7SUFBQTtJQUFBLElBQUFPLEVBQUE7SUFBQSxJQUFBUCxDQUFBLFFBQUExQixHQUFBLElBQUEwQixDQUFBLFFBQUFNLEVBQUE7TUFEN0JDLEVBQUEsSUFBQyxJQUFJLENBQVdqQyxRQUFHLENBQUhBLElBQUUsQ0FBQyxDQUNqQixDQUFBZ0MsRUFBNEIsQ0FDOUIsRUFGQyxJQUFJLENBRUU7TUFBQU4sQ0FBQSxNQUFBMUIsR0FBQTtNQUFBMEIsQ0FBQSxNQUFBTSxFQUFE7TUFBQUwsQ0FBRCxNQUFBTyxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBUCxDQUFBO0lBQUE7SUFBQSxPQUZQTyxFQUVPO0VBQUE7RUFFVixJQUFBRCxFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBM0IsUUFBQTtJQUNnQmlDLEVBQUEsR0FBQTFDLFFBQU8sQ0FBQ2EsUUFBUSxDQUFDLENBQUFtQyxLQUFNLENBQUMsQ0FBQyxDQUFDO0lBQUFSLENBQUEsTUFBQTNCLFFBQUE7SUFBQTJCLENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQTNDLElBQUFoQixRQUFBLEdBQWlCc0IsRUFBMEI7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQVAsQ0FBQSxRQUFBSyxjQUFBO0lBR25CRSxFQUFBLElBQUMsSUFBSSxDQUFFRixlQUFhLENBQUUsRUFBckIsSUFBSSxDQUF3QjtJQUFBTCxDQUFBLE1BQUFLLGNBQUk7SUFBQUwsQ0FBQSxPQUFBTyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUCxDQUFBO0VBQUE7RUFBQSxJQUFBUyxFQUFBO0VBQUEsSUFBQVQsQ0FBQSxTQUFBSyxjQUFBLElBQUFMLENBQUEsU0FBQWhCLFFBQUE7SUFDOUNDLEVBQUFJQUF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
