/**
 * 【文件概述】KeybindingWarnings.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动阶段 → 配置加载 → 键位绑定解析 → 本组件（持久化显示键位配置警告）
 *
 * 主要职责：
 *   当用户自定义的键位绑定文件（keybindings.json）存在校验问题时，
 *   在 UI 顶部展示持久化的错误/警告列表，方便用户发现并修复配置问题。
 *
 * 与其他模块的关系：
 *   - isKeybindingCustomizationEnabled()：功能开关，仅对 ant 内部用户 + feature gate 开放
 *   - getCachedKeybindingWarnings()：读取已缓存的键位解析警告列表
 *   - getKeybindingsPath()：获取键位配置文件的完整路径，用于显示给用户
 *   - 类似 McpParsingWarnings，提供配置层面的可见性
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Box, Text } from '../ink.js';
import { getCachedKeybindingWarnings, getKeybindingsPath, isKeybindingCustomizationEnabled } from '../keybindings/loadUserBindings.js';

/**
 * KeybindingWarnings — 键位配置警告展示组件
 *
 * 整体流程：
 *   1. 检查功能开关，未启用则直接返回 null
 *   2. 读取缓存的警告列表；若为空则返回 null
 *   3. 将警告按 severity 分为 errors（error 级别）和 warns（warning 级别）
 *   4. 渲染包含标题、文件路径、错误列表、警告列表的 Box 布局
 *
 * React Compiler 优化说明：
 *   - 使用 _c(2) 分配 2 个缓存槽，整个组件输出在首次渲染后被缓存
 *   - bb0 标签用于模拟带 break 的块作用域（对应原始代码的 early return）
 *   - Symbol.for("react.early_return_sentinel") 表示提前返回路径已缓存
 */
export function KeybindingWarnings() {
  // React Compiler 注入的 memoization 缓存，共 2 个槽位
  const $ = _c(2);

  // 功能开关检查：键位自定义仅对 ant 内部用户开放
  if (!isKeybindingCustomizationEnabled()) {
    return null;
  }

  let t0; // 缓存正常渲染的 JSX 节点
  let t1; // 缓存提前返回的哨兵或 null

  // 由于整个输出依赖外部缓存（无响应式 props），使用 memo_cache_sentinel 做一次性初始化
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = Symbol.for("react.early_return_sentinel"); // 默认设为"继续执行"哨兵
    bb0: {
      // 读取键位配置解析阶段缓存的警告列表
      const warnings = getCachedKeybindingWarnings();

      // 无警告时提前返回 null，并通过 break 跳出块
      if (warnings.length === 0) {
        t1 = null;
        break bb0;
      }

      // 按严重程度拆分：error 级别 vs warning 级别
      const errors = warnings.filter(_temp);   // severity === 'error'
      const warns = warnings.filter(_temp2);   // severity === 'warning'

      // 构建完整的警告面板 JSX
      t0 = <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {/* 标题：有 error 则显示红色，否则显示橙色 */}
        <Text bold={true} color={errors.length > 0 ? "error" : "warning"}>Keybinding Configuration Issues</Text>
        {/* 显示键位配置文件路径 */}
        <Box><Text dimColor={true}>Location: </Text><Text dimColor={true}>{getKeybindingsPath()}</Text></Box>
        {/* 错误列表 + 警告列表 */}
        <Box marginLeft={1} flexDirection="column" marginTop={1}>
          {errors.map(_temp3)}
          {warns.map(_temp4)}
        </Box>
      </Box>;
    }
    // 将结果存入缓存
    $[0] = t0;
    $[1] = t1;
  } else {
    // 命中缓存，直接复用
    t0 = $[0];
    t1 = $[1];
  }

  // 若 t1 不是"继续执行"哨兵，说明命中了提前返回路径（warnings 为空）
  if (t1 !== Symbol.for("react.early_return_sentinel")) {
    return t1; // 返回 null
  }

  // 返回正常渲染的警告面板
  return t0;
}

/**
 * _temp4 — 渲染单条 warning 级别条目
 *
 * 格式：└ [Warning] <消息>
 *       → <建议>（如有）
 */
function _temp4(warning, i_0) {
  return <Box key={`warning-${i_0}`} flexDirection="column">
    <Box>
      <Text dimColor={true}>└ </Text>
      <Text color="warning">[Warning]</Text>
      <Text dimColor={true}> {warning.message}</Text>
    </Box>
    {/* 若有修复建议则缩进展示 */}
    {warning.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {warning.suggestion}</Text></Box>}
  </Box>;
}

/**
 * _temp3 — 渲染单条 error 级别条目
 *
 * 格式：└ [Error] <消息>
 *       → <建议>（如有）
 */
function _temp3(error, i) {
  return <Box key={`error-${i}`} flexDirection="column">
    <Box>
      <Text dimColor={true}>└ </Text>
      <Text color="error">[Error]</Text>
      <Text dimColor={true}> {error.message}</Text>
    </Box>
    {/* 若有修复建议则缩进展示 */}
    {error.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {error.suggestion}</Text></Box>}
  </Box>;
}

/** _temp2 — 过滤 warning 级别条目的谓词函数 */
function _temp2(w_0) {
  return w_0.severity === "warning";
}

/** _temp — 过滤 error 级别条目的谓词函数 */
function _temp(w) {
  return w.severity === "error";
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJnZXRDYWNoZWRLZXliaW5kaW5nV2FybmluZ3MiLCJnZXRLZXliaW5kaW5nc1BhdGgiLCJpc0tleWJpbmRpbmdDdXN0b21pemF0aW9uRW5hYmxlZCIsIktleWJpbmRpbmdXYXJuaW5ncyIsIiQiLCJfYyIsInQwIiwidDEiLCJTeW1ib2wiLCJmb3IiLCJiYjAiLCJ3YXJuaW5ncyIsImxlbmd0aCIsImVycm9ycyIsImZpbHRlciIsIl90ZW1wIiwid2FybnMiLCJfdGVtcDIiLCJtYXAiLCJfdGVtcDMiLCJfdGVtcDQiLCJ3YXJuaW5nIiwiaV8wIiwiaSIsIm1lc3NhZ2UiLCJzdWdnZXN0aW9uIiwiZXJyb3IiLCJ3XzAiLCJ3Iiwic2V2ZXJpdHkiXSwic291cmNlcyI6WyJLZXliaW5kaW5nV2FybmluZ3MudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7XG4gIGdldENhY2hlZEtleWJpbmRpbmdXYXJuaW5ncyxcbiAgZ2V0S2V5YmluZGluZ3NQYXRoLFxuICBpc0tleWJpbmRpbmdDdXN0b21pemF0aW9uRW5hYmxlZCxcbn0gZnJvbSAnLi4va2V5YmluZGluZ3MvbG9hZFVzZXJCaW5kaW5ncy5qcydcblxuLyoqXG4gKiBEaXNwbGF5cyBrZXliaW5kaW5nIHZhbGlkYXRpb24gd2FybmluZ3MgaW4gdGhlIFVJLlxuICogU2ltaWxhciB0byBNY3BQYXJzaW5nV2FybmluZ3MsIHRoaXMgcHJvdmlkZXMgcGVyc2lzdGVudCB2aXNpYmlsaXR5XG4gKiBvZiBjb25maWd1cmF0aW9uIGlzc3Vlcy5cbiAqXG4gKiBPbmx5IHNob3duIHdoZW4ga2V5YmluZGluZyBjdXN0b21pemF0aW9uIGlzIGVuYWJsZWQgKGFudCB1c2VycyArIGZlYXR1cmUgZ2F0ZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBLZXliaW5kaW5nV2FybmluZ3MoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgLy8gT25seSBzaG93IHdhcm5pbmdzIHdoZW4ga2V5YmluZGluZyBjdXN0b21pemF0aW9uIGlzIGVuYWJsZWRcbiAgaWYgKCFpc0tleWJpbmRpbmdDdXN0b21pemF0aW9uRW5hYmxlZCgpKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IHdhcm5pbmdzID0gZ2V0Q2FjaGVkS2V5YmluZGluZ1dhcm5pbmdzKClcblxuICBpZiAod2FybmluZ3MubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IGVycm9ycyA9IHdhcm5pbmdzLmZpbHRlcih3ID0+IHcuc2V2ZXJpdHkgPT09ICdlcnJvcicpXG4gIGNvbnN0IHdhcm5zID0gd2FybmluZ3MuZmlsdGVyKHcgPT4gdy5zZXZlcml0eSA9PT0gJ3dhcm5pbmcnKVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfSBtYXJnaW5Cb3R0b209ezF9PlxuICAgICAgPFRleHQgYm9sZCBjb2xvcj17ZXJyb3JzLmxlbmd0aCA+IDAgPyAnZXJyb3InIDogJ3dhcm5pbmcnfT5cbiAgICAgICAgS2V5YmluZGluZyBDb25maWd1cmF0aW9uIElzc3Vlc1xuICAgICAgPC9UZXh0PlxuICAgICAgPEJveD5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+TG9jYXRpb246IDwvVGV4dD5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+e2dldEtleWJpbmRpbmdzUGF0aCgpfTwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgICAgPEJveCBtYXJnaW5MZWZ0PXsxfSBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgICAge2Vycm9ycy5tYXAoKGVycm9yLCBpKSA9PiAoXG4gICAgICAgICAgPEJveCBrZXk9e2BlcnJvci0ke2l9YH0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgICAgPEJveD5cbiAgICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+4pSUIDwvVGV4dD5cbiAgICAgICAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPltFcnJvcl08L1RleHQ+XG4gICAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPiB7ZXJyb3IubWVzc2FnZX08L1RleHQ+XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgIHtlcnJvci5zdWdnZXN0aW9uICYmIChcbiAgICAgICAgICAgICAgPEJveCBtYXJnaW5MZWZ0PXszfT5cbiAgICAgICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj7ihpIge2Vycm9yLnN1Z2dlc3Rpb259PC9UZXh0PlxuICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICkpfVxuICAgICAgICB7d2FybnMubWFwKCh3YXJuaW5nLCBpKSA9PiAoXG4gICAgICAgICAgPEJveCBrZXk9e2B3YXJuaW5nLSR7aX1gfSBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAgICA8Qm94PlxuICAgICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj7ilJQgPC9UZXh0PlxuICAgICAgICAgICAgICA8VGV4dCBjb2xvcj1cIndhcm5pbmdcIj5bV2FybmluZ108L1RleHQ+XG4gICAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPiB7d2FybmluZy5tZXNzYWdlfTwvVGV4dD5cbiAgICAgICAgICAgIDwvQm94PlxuICAgICAgICAgICAge3dhcm5pbmcuc3VnZ2VzdGlvbiAmJiAoXG4gICAgICAgICAgICAgIDxCb3ggbWFyZ2luTGVmdD17M30+XG4gICAgICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+4oaSIHt3YXJuaW5nLnN1Z2dlc3Rpb259PC9UZXh0PlxuICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICkpfVxuICAgICAgPC9Cb3g+XG4g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
