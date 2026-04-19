/**
 * DesktopUpsellStartup.tsx — 启动时推广 Claude Desktop 的引导对话框组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动初始化层 → 功能推广引导 → Claude Desktop Upsell 弹窗
 *
 * 主要功能：
 *   1. getDesktopUpsellConfig()：通过 GrowthBook 动态配置服务读取
 *      'tengu_desktop_upsell' 特性标志，获取推广功能开关（启用快捷提示、启用启动对话框）。
 *   2. isSupportedPlatform()：检查当前平台是否支持 Claude Desktop：
 *        macOS（darwin）始终支持；Windows 仅支持 x64 架构。
 *   3. shouldShowDesktopUpsellStartup()：综合判断是否应展示推广弹窗，
 *        依次检查：平台支持 → 特性标志启用 → 未被永久关闭 → 展示次数 < 3。
 *   4. DesktopUpsellStartup 组件：
 *        - 挂载时记录展示次数并上报 'tengu_desktop_upsell_shown' 事件
 *        - 用户选择"try"后切换到 DesktopHandoff 会话移交流程
 *        - 用户选择"never"时写入全局配置 desktopUpsellDismissed: true，永久关闭
 *        - 用户选择"not-now"时直接调用 onDone() 临时跳过
 *
 * 使用场景：
 *   在 CLI 会话启动阶段，向符合条件的用户展示一次性的 Claude Desktop 推广引导，
 *   引导用户尝试具有更丰富功能的桌面客户端（可视化 Diff、实时预览、并行会话等）。
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { logEvent } from '../../services/analytics/index.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { Select } from '../CustomSelect/select.js';
import { DesktopHandoff } from '../DesktopHandoff.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';

// Desktop Upsell 功能配置类型：两个开关控制不同推广入口
type DesktopUpsellConfig = {
  enable_shortcut_tip: boolean;      // 是否在快捷键提示区显示 Desktop 推广
  enable_startup_dialog: boolean;    // 是否在启动时显示 Desktop 推广对话框
};

// GrowthBook 特性标志关闭时的默认配置：全部禁用
const DESKTOP_UPSELL_DEFAULT: DesktopUpsellConfig = {
  enable_shortcut_tip: false,
  enable_startup_dialog: false
};

/**
 * getDesktopUpsellConfig
 *
 * 整体流程：
 *   从 GrowthBook 动态配置缓存中读取 'tengu_desktop_upsell' 特性标志配置。
 *   注意：该缓存可能略微过时（_CACHED_MAY_BE_STALE），但对推广功能来说可接受。
 *
 * 在系统中的角色：
 *   供 shouldShowDesktopUpsellStartup() 调用，判断特性标志是否启用启动对话框。
 */
export function getDesktopUpsellConfig(): DesktopUpsellConfig {
  // 读取 GrowthBook 标志，未配置时降级使用默认值（全部禁用）
  return getDynamicConfig_CACHED_MAY_BE_STALE('tengu_desktop_upsell', DESKTOP_UPSELL_DEFAULT);
}

/**
 * isSupportedPlatform
 *
 * 整体流程：
 *   检查当前运行平台是否支持 Claude Desktop 安装：
 *   - macOS（darwin）：完全支持
 *   - Windows：仅 x64 架构支持（arm64 等暂不支持）
 *   - Linux 及其他：不支持
 *
 * 在系统中的角色：
 *   作为 shouldShowDesktopUpsellStartup() 的第一道门槛，避免在不支持的平台展示推广。
 */
function isSupportedPlatform(): boolean {
  // macOS 完全支持；Windows 仅支持 x64 架构
  return process.platform === 'darwin' || process.platform === 'win32' && process.arch === 'x64';
}

/**
 * shouldShowDesktopUpsellStartup
 *
 * 整体流程：
 *   按顺序执行 4 项检查，任一不通过则返回 false，全部通过才返回 true：
 *   1. 平台支持检查：非 macOS/Windows x64 → false
 *   2. 特性标志检查：GrowthBook 未启用 enable_startup_dialog → false
 *   3. 永久关闭检查：用户已选"Don't ask again" → false
 *   4. 展示次数检查：已展示 ≥ 3 次 → false（避免过度打扰）
 *
 * 在系统中的角色：
 *   由启动逻辑调用，决定是否在本次会话开始时渲染 DesktopUpsellStartup 组件。
 */
export function shouldShowDesktopUpsellStartup(): boolean {
  // 第一关：平台不支持则直接跳过
  if (!isSupportedPlatform()) return false;
  // 第二关：特性标志未启用则跳过
  if (!getDesktopUpsellConfig().enable_startup_dialog) return false;
  const config = getGlobalConfig();
  // 第三关：用户已永久关闭则跳过
  if (config.desktopUpsellDismissed) return false;
  // 第四关：展示次数已达上限（3次）则跳过
  if ((config.desktopUpsellSeenCount ?? 0) >= 3) return false;
  return true;
}

// 用户在推广对话框中可选择的操作联合类型
type DesktopUpsellSelection = 'try' | 'not-now' | 'never';

// 组件 Props：onDone 为关闭推广弹窗后的回调
type Props = {
  onDone: () => void;
};

/**
 * DesktopUpsellStartup 组件
 *
 * 整体流程：
 *   1. 挂载时（useEffect 空依赖数组）：执行 _temp，记录展示次数并上报埋点
 *   2. showHandoff=true：渲染 DesktopHandoff，进入 CLI→Desktop 会话移交流程
 *   3. showHandoff=false（默认）：渲染 PermissionDialog，展示推广内容和三个选项
 *      - "try"（_c(3-4)）：切换到移交模式（setShowHandoff(true)）
 *      - "never"（_c(3-4)）：保存永久关闭配置（_temp2），调用 onDone()
 *      - "not-now"（_c(3-4)）：临时跳过，直接调用 onDone()
 *   4. 使用 React Compiler 的 _c(14) 进行 14 槽记忆化，避免不必要重渲
 *
 * 在系统中的角色：
 *   作为启动阶段的推广入口，通过非强制引导方式鼓励用户尝试 Claude Desktop 桌面版。
 */
export function DesktopUpsellStartup(t0) {
  // _c(14)：初始化 14 个记忆化缓存槽
  const $ = _c(14);
  const {
    onDone
  } = t0;
  // showHandoff 状态：true 时切换到会话移交流程
  const [showHandoff, setShowHandoff] = useState(false);
  let t1;
  // 缓存槽 $[0]：空依赖数组（sentinel 值标记首次创建，之后直接复用）
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];  // 空依赖数组：确保 _temp 仅在挂载时执行一次
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  // 挂载时执行 _temp：递增展示次数并上报分析事件
  useEffect(_temp, t1);

  // 用户选择"try"后，切换显示 DesktopHandoff 组件
  if (showHandoff) {
    let t2;
    // 缓存槽 $[1]-$[2]，依赖 onDone
    if ($[1] !== onDone) {
      // onDone 变化时重新创建移交组件 JSX（传入包装后的回调）
      t2 = <DesktopHandoff onDone={() => onDone()} />;
      $[1] = onDone;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    return t2;
  }

  let t2;
  // 缓存槽 $[3]-$[4]，依赖 onDone：handleSelect 函数因 onDone 不同而需重建
  if ($[3] !== onDone) {
    // handleSelect：处理用户在推广对话框中的三种选择
    t2 = function handleSelect(value) {
      switch (value) {
        case "try":
          {
            // 选择"立即体验"：切换到移交流程
            setShowHandoff(true);
            return;
          }
        case "never":
          {
            // 选择"不再询问"：永久关闭推广，_temp2 写入 desktopUpsellDismissed: true
            saveGlobalConfig(_temp2);
            onDone();
            return;
          }
        case "not-now":
          {
            // 选择"暂不"：临时跳过，本次会话结束
            onDone();
            return;
          }
      }
    };
    $[3] = onDone;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const handleSelect = t2;

  // 选项 1："try"选项对象（sentinel 缓存，永不变化）
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      label: "Open in Claude Code Desktop",
      value: "try" as const
    };
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // 选项 2："not-now"选项对象（sentinel 缓存，永不变化）
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = {
      label: "Not now",
      value: "not-now" as const
    };
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // 选项数组：['try', 'not-now', 'never']（sentinel 缓存，静态不变）
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = [t3, t4, {
      label: "Don't ask again",
      value: "never" as const
    }];
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  const options = t5;

  // 描述文本区域（sentinel 缓存：静态 JSX，始终复用同一实例）
  let t6;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Box marginBottom={1}><Text>Same Claude Code with visual diffs, live app preview, parallel sessions, and more.</Text></Box>;
    $[8] = t6;
  } else {
    t6 = $[8];
  }

  // onCancel 回调（$[9]-$[10]）：Escape 键触发，等效于"not-now"选择
  let t7;
  if ($[9] !== handleSelect) {
    t7 = () => handleSelect("not-now");
    $[9] = handleSelect;
    $[10] = t7;
  } else {
    t7 = $[10];
  }

  // 最终 JSX（$[11]-$[13]）：PermissionDialog 包裹内容区与 Select 选择器
  let t8;
  if ($[11] !== handleSelect || $[12] !== t7) {
    t8 = <PermissionDialog title="Try Claude Code Desktop"><Box flexDirection="column" paddingX={2} paddingY={1}>{t6}<Select options={options} onChange={handleSelect} onCancel={t7} /></Box></PermissionDialog>;
    $[11] = handleSelect;
    $[12] = t7;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  return t8;
}

/**
 * _temp2（React Compiler 提取的模块级辅助函数）
 *
 * 整体流程：
 *   作为 saveGlobalConfig() 的更新函数，将 desktopUpsellDismissed 标志写入全局配置。
 *   采用幂等检查：若已设置则直接返回原配置，避免不必要的写入操作。
 *
 * 在系统中的角色：
 *   用户选择"Don't ask again"时调用，永久关闭 Desktop 推广弹窗。
 */
function _temp2(prev_0) {
  // 幂等检查：已设置则直接返回原配置对象，避免触发不必要的状态更新
  if (prev_0.desktopUpsellDismissed) {
    return prev_0;
  }
  // 设置 desktopUpsellDismissed: true，永久关闭推广
  return {
    ...prev_0,
    desktopUpsellDismissed: true
  };
}

/**
 * _temp（React Compiler 提取的模块级辅助函数）
 *
 * 整体流程：
 *   作为 useEffect 的 effect 函数，在组件挂载时执行一次：
 *   1. 计算新的展示次数（当前值 + 1）
 *   2. 通过 saveGlobalConfig 原子性地更新 desktopUpsellSeenCount
 *      （使用幂等检查防止 StrictMode 双重执行导致计数器多加）
 *   3. 上报 'tengu_desktop_upsell_shown' 分析事件，携带展示次数
 *
 * 在系统中的角色：
 *   追踪推广弹窗的曝光次数，用于 shouldShowDesktopUpsellStartup() 的次数限制判断，
 *   同时为产品数据分析提供展示频次数据。
 */
function _temp() {
  // 计算新的展示次数：在当前配置值基础上加 1
  const newCount = (getGlobalConfig().desktopUpsellSeenCount ?? 0) + 1;
  // 原子性更新配置：幂等检查防止并发或 StrictMode 双重执行导致计数多加
  saveGlobalConfig(prev => {
    // 若当前值已 >= 新计数（说明已被其他调用更新），直接返回不修改
    if ((prev.desktopUpsellSeenCount ?? 0) >= newCount) {
      return prev;
    }
    return {
      ...prev,
      desktopUpsellSeenCount: newCount
    };
  });
  // 上报分析事件：记录本次展示及累计展示次数
  logEvent("tengu_desktop_upsell_shown", {
    seen_count: newCount
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZVN0YXRlIiwiQm94IiwiVGV4dCIsImdldER5bmFtaWNDb25maWdfQ0FDSEVEX01BWV9CRV9TVEFMRSIsImxvZ0V2ZW50IiwiZ2V0R2xvYmFsQ29uZmlnIiwic2F2ZUdsb2JhbENvbmZpZyIsIlNlbGVjdCIsIkRlc2t0b3BIYW5kb2ZmIiwiUGVybWlzc2lvbkRpYWxvZyIsIkRlc2t0b3BVcHNlbGxDb25maWciLCJlbmFibGVfc2hvcnRjdXRfdGlwIiwiZW5hYmxlX3N0YXJ0dXBfZGlhbG9nIiwiREVTS1RPUF9VUFNFTExfREVGQVVMVCIsImdldERlc2t0b3BVcHNlbGxDb25maWciLCJpc1N1cHBvcnRlZFBsYXRmb3JtIiwicHJvY2VzcyIsInBsYXRmb3JtIiwiYXJjaCIsInNob3VsZFNob3dEZXNrdG9wVXBzZWxsU3RhcnR1cCIsImNvbmZpZyIsImRlc2t0b3BVcHNlbGxEaXNtaXNzZWQiLCJkZXNrdG9wVXBzZWxsU2VlbkNvdW50IiwiRGVza3RvcFVwc2VsbFNlbGVjdGlvbiIsIlByb3BzIiwib25Eb25lIiwiRGVza3RvcFVwc2VsbFN0YXJ0dXAiLCJ0MCIsIiQiLCJfYyIsInNob3dIYW5kb2ZmIiwic2V0U2hvd0hhbmRvZmYiLCJ0MSIsIlN5bWJvbCIsImZvciIsIl90ZW1wIiwidDIiLCJoYW5kbGVTZWxlY3QiLCJ2YWx1ZSIsIl90ZW1wMiIsInQzIiwibGFiZWwiLCJjb25zdCIsInQ0IiwidDUiLCJvcHRpb25zIiwidDYiLCJ0NyIsInQ4IiwicHJldl8wIiwicHJldiIsIm5ld0NvdW50Iiwic2Vlbl9jb3VudCJdLCJzb3VyY2VzIjpbIkRlc2t0b3BVcHNlbGxTdGFydHVwLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IGdldER5bmFtaWNDb25maWdfQ0FDSEVEX01BWV9CRV9TVEFMRSB9IGZyb20gJy4uLy4uL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHsgbG9nRXZlbnQgfSBmcm9tICcuLi8uLi9zZXJ2aWNlcy9hbmFseXRpY3MvaW5kZXguanMnXG5pbXBvcnQgeyBnZXRHbG9iYWxDb25maWcsIHNhdmVHbG9iYWxDb25maWcgfSBmcm9tICcuLi8uLi91dGlscy9jb25maWcuanMnXG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuLi9DdXN0b21TZWxlY3Qvc2VsZWN0LmpzJ1xuaW1wb3J0IHsgRGVza3RvcEhhbmRvZmYgfSBmcm9tICcuLi9EZXNrdG9wSGFuZG9mZi5qcydcbmltcG9ydCB7IFBlcm1pc3Npb25EaWFsb2cgfSBmcm9tICcuLi9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uRGlhbG9nLmpzJ1xuXG50eXBlIERlc2t0b3BVcHNlbGxDb25maWcgPSB7XG4gIGVuYWJsZV9zaG9ydGN1dF90aXA6IGJvb2xlYW5cbiAgZW5hYmxlX3N0YXJ0dXBfZGlhbG9nOiBib29sZWFuXG59XG5cbmNvbnN0IERFU0tUT1BfVVBTRUxMX0RFRkFVTFQ6IERlc2t0b3BVcHNlbGxDb25maWcgPSB7XG4gIGVuYWJsZV9zaG9ydGN1dF90aXA6IGZhbHNlLFxuICBlbmFibGVfc3RhcnR1cF9kaWFsb2c6IGZhbHNlLFxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RGVza3RvcFVwc2VsbENvbmZpZygpOiBEZXNrdG9wVXBzZWxsQ29uZmlnIHtcbiAgcmV0dXJuIGdldER5bmFtaWNDb25maWdfQ0FDSEVEX01BWV9CRV9TVEFMRShcbiAgICAndGVuZ3VfZGVza3RvcF91cHNlbGwnLFxuICAgIERFU0tUT1BfVVBTRUxMX0RFRkFVTFQsXG4gIClcbn1cblxuZnVuY3Rpb24gaXNTdXBwb3J0ZWRQbGF0Zm9ybSgpOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSAnZGFyd2luJyB8fFxuICAgIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInICYmIHByb2Nlc3MuYXJjaCA9PT0gJ3g2NCcpXG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFNob3dEZXNrdG9wVXBzZWxsU3RhcnR1cCgpOiBib29sZWFuIHtcbiAgaWYgKCFpc1N1cHBvcnRlZFBsYXRmb3JtKCkpIHJldHVybiBmYWxzZVxuICBpZiAoIWdldERlc2t0b3BVcHNlbGxDb25maWcoKS5lbmFibGVfc3RhcnR1cF9kaWFsb2cpIHJldHVybiBmYWxzZVxuICBjb25zdCBjb25maWcgPSBnZXRHbG9iYWxDb25maWcoKVxuICBpZiAoY29uZmlnLmRlc2t0b3BVcHNlbGxEaXNtaXNzZWQpIHJldHVybiBmYWxzZVxuICBpZiAoKGNvbmZpZy5kZXNrdG9wVXBzZWxsU2VlbkNvdW50ID8/IDApID49IDMpIHJldHVybiBmYWxzZVxuICByZXR1cm4gdHJ1ZVxufVxuXG50eXBlIERlc2t0b3BVcHNlbGxTZWxlY3Rpb24gPSAndHJ5JyB8ICdub3Qtbm93JyB8ICduZXZlcidcblxudHlwZSBQcm9wcyA9IHtcbiAgb25Eb25lOiAoKSA9PiB2b2lkXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZXNrdG9wVXBzZWxsU3RhcnR1cCh7IG9uRG9uZSB9OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IFtzaG93SGFuZG9mZiwgc2V0U2hvd0hhbmRvZmZdID0gdXNlU3RhdGUoZmFsc2UpXG5cbiAgLy8gSW5jcmVtZW50IHNlZW4gY291bnQgb24gbW91bnQgKGd1YXJkIGluIHVwZGF0ZXIgZm9yIFN0cmljdE1vZGUgc2FmZXR5KVxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IG5ld0NvdW50ID0gKGdldEdsb2JhbENvbmZpZygpLmRlc2t0b3BVcHNlbGxTZWVuQ291bnQgPz8gMCkgKyAxXG4gICAgc2F2ZUdsb2JhbENvbmZpZyhwcmV2ID0+IHtcbiAgICAgIGlmICgocHJldi5kZXNrdG9wVXBzZWxsU2VlbkNvdW50ID8/IDApID49IG5ld0NvdW50KSByZXR1cm4gcHJldlxuICAgICAgcmV0dXJuIHsgLi4ucHJldiwgZGVza3RvcFVwc2VsbFNlZW5Db3VudDogbmV3Q291bnQgfVxuICAgIH0pXG4gICAgbG9nRXZlbnQoJ3Rlbmd1X2Rlc2t0b3BfdXBzZWxsX3Nob3duJywgeyBzZWVuX2NvdW50OiBuZXdDb3VudCB9KVxuICB9LCBbXSlcblxuICBpZiAoc2hvd0hhbmRvZmYpIHtcbiAgICByZXR1cm4gPERlc2t0b3BIYW5kb2ZmIG9uRG9uZT17KCkgPT4gb25Eb25lKCl9IC8+XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVTZWxlY3QodmFsdWU6IERlc2t0b3BVcHNlbGxTZWxlY3Rpb24pOiB2b2lkIHtcbiAgICBzd2l0Y2ggKHZhbHVlKSB7XG4gICAgICBjYXNlICd0cnknOlxuICAgICAgICBzZXRTaG93SGFuZG9mZih0cnVlKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ25ldmVyJzpcbiAgICAgICAgc2F2ZUdsb2JhbENvbmZpZyhwcmV2ID0+IHtcbiAgICAgICAgICBpZiAocHJldi5kZXNrdG9wVXBzZWxsRGlzbWlzc2VkKSByZXR1cm4gcHJldlxuICAgICAgICAgIHJldHVybiB7IC4uLnByZXYsIGRlc2t0b3BVcHNlbGxEaXNtaXNzZWQ6IHRydWUgfVxuICAgICAgICB9KVxuICAgICAgICBvbkRvbmUoKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ25vdC1ub3cnOlxuICAgICAgICBvbkRvbmUoKVxuICAgICAgICByZXR1cm5cbiAgICB9XG4gIH1cblxuICBjb25zdCBvcHRpb25zID0gW1xuICAgIHsgbGFiZWw6ICdPcGVuIGluIENsYXVkZSBDb2RlIERlc2t0b3AnLCB2YWx1ZTogJ3RyeScgYXMgY29uc3QgfSxcbiAgICB7IGxhYmVsOiAnTm90IG5vdycsIHZhbHVlOiAnbm90LW5vdycgYXMgY29uc3QgfSxcbiAgICB7IGxhYmVsOiBcIkRvbid0IGFzayBhZ2FpblwiLCB2YWx1ZTogJ25ldmVyJyBhcyBjb25zdCB9LFxuICBdXG5cbiAgcmV0dXJuIChcbiAgICA8UGVybWlzc2lvbkRpYWxvZyB0aXRsZT1cIlRyeSBDbGF1ZGUgQ29kZSBEZXNrdG9wXCI+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBwYWRkaW5nWD17Mn0gcGFkZGluZ1k9ezF9PlxuICAgICAgICA8Qm94IG1hcmdpbkJvdHRvbT17MX0+XG4gICAgICAgICAgPFRleHQ+XG4gICAgICAgICAgICBTYW1lIENsYXVkZSBDb2RlIHdpdGggdmlzdWFsIGRpZmZzLCBsaXZlIGFwcCBwcmV2aWV3LCBwYXJhbGxlbFxuICAgICAgICAgICAgc2Vzc2lvbnMsIGFuZCBtb3JlLlxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICAgIDxTZWxlY3RcbiAgICAgICAgICBvcHRpb25zPXtvcHRpb25zfVxuICAgICAgICAgIG9uQ2hhbmdlPXtoYW5kbGVTZWxlY3R9XG4gICAgICAgICAgb25DYW5jZWw9eygpID0+IGhhbmRsZVNlbGVjdCgnbm90LW5vdycpfVxuICAgICAgICAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9QZXJtaXNzaW9uRGlhbG9nPlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLFNBQVMsRUFBRUMsUUFBUSxRQUFRLE9BQU87QUFDM0MsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxvQ0FBb0MsUUFBUSx3Q0FBd0M7QUFDN0YsU0FBU0MsUUFBUSxRQUFRLG1DQUFtQztBQUM1RCxTQUFTQyxlQUFlLEVBQUVDLGdCQUFnQixRQUFRLHVCQUF1QjtBQUN6RSxTQUFTQyxNQUFNLFFBQVEsMkJBQTJCO0FBQ2xELFNBQVNDLGNBQWMsUUFBUSxzQkFBc0I7QUFDckQsU0FBU0MsZ0JBQWdCLFFBQVEsb0NBQW9DO0FBRXJFLEtBQUtDLG1CQUFtQixHQUFHO0VBQ3pCQyxtQkFBbUIsRUFBRSxPQUFPO0VBQzVCQyxxQkFBcUIsRUFBRSxPQUFPO0FBQ2hDLENBQUM7QUFFRCxNQUFNQyxzQkFBc0IsRUFBRUgsbUJBQW1CLEdBQUc7RUFDbERDLG1CQUFtQixFQUFFLEtBQUs7RUFDMUJDLHFCQUFxQixFQUFFO0FBQ3pCLENBQUM7QUFFRCxPQUFPLFNBQVNFLHNCQUFzQkEsQ0FBQSxDQUFFLEVBQUVKLG1CQUFtQixDQUFDO0VBQzVELE9BQU9QLG9DQUFvQyxDQUN6QyxzQkFBc0IsRUFDdEJVLHNCQUNGLENBQUM7QUFDSDtBQUVBLFNBQVNFLG1CQUFtQkEsQ0FBQSxDQUFFLEVBQUUsT0FBTyxDQUFDO0VBQ3RDLE9BQ0VDLE9BQU8sQ0FBQ0MsUUFBUSxLQUFLLFFBQVEsSUFDNUJELE9BQU8sQ0FBQ0MsUUFBUSxLQUFLLE9BQU8sSUFBSUQsT0FBTyxDQUFDRSxJQUFJLEtBQUssS0FBTTtBQUU1RDtBQUVBLE9BQU8sU0FBU0MsOEJBQThCQSxDQUFBLENBQUUsRUFBRSxPQUFPLENBQUM7RUFDeEQsSUFBSSxDQUFDSixtQkFBbUIsQ0FBQyxDQUFDLEVBQUUsT0FBTyxLQUFLO0VBQ3hDLElBQUksQ0FBQ0Qsc0JBQXNCLENBQUMsQ0FBQyxDQUFDRixxQkFBcUIsRUFBRSxPQUFPLEtBQUs7RUFDakUsTUFBTVEsTUFBTSxHQUFHZixlQUFlLENBQUMsQ0FBQztFQUNoQyxJQUFJZSxNQUFNLENBQUNDLHNCQUFzQixFQUFFLE9BQU8sS0FBSztFQUMvQyxJQUFJLENBQUNELE1BQU0sQ0FBQ0Usc0JBQXNCLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxPQUFPLEtBQUs7RUFDM0QsT0FBTyxJQUFJO0FBQ2I7QUFFQSxLQUFLQyxzQkFBc0IsR0FBRyxLQUFLLEdBQUcsU0FBUyxHQUFHLE9BQU87QUFFekQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLE1BQU0sRUFBRSxHQUFHLEdBQUcsSUFBSTtBQUNwQixDQUFDO0FBRUQsT0FBTyxTQUFBQyxxQkFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUE4QjtJQUFBSjtFQUFBLElBQUFFLEVBQWlCO0VBQ3BELE9BQUFHLFdBQUEsRUFBQUMsY0FBQSxJQUFzQy9CLFFBQVEsQ0FBQyxLQUFLLENBQUM7RUFBQSxJQUFBZ0MsRUFBQTtFQUFBLElBQUFKLENBQUEsUUFBQUssTUFBQSxDQUFBQyxHQUFBO0lBVWxERixFQUFBLEtBQUU7SUFBQUosQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFQTDdCLFNBQVMsQ0FBQ29DLEtBT1QsRUFBRUgsRUFBRSxDQUFDO0VBRU4sSUFBSUYsV0FBVztJQUFBLElBQUFNLEVBQUE7SUFBQSxJQUFBUixDQUFBLFFBQUFILE1BQUE7TUFDTlcsRUFBQSxJQUFDLGNBQWMsQ0FBUyxNQUFjLENBQWQsT0FBTVgsTUFBTSxDQUFDLEVBQUMsR0FBSTtNQUFBRyxDQUFBLE1BQUFILE1BQUE7TUFBQUcsQ0FBQSxNQUFBUSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBUixDQUFBO0lBQUE7SUFBQSxPQUExQ1EsRUFBMEM7RUFBQTtFQUNsRCxJQUFBQSxFQUFBO0VBQUEsSUFBQVIsQ0FBQSxRQUFBSCxNQUFBO0lBRURXLEVBQUEsWUFBQUMsYUFBQUMsS0FBQTtNQUNFLFFBQVFBLEtBQUs7UUFBQSxLQUNOLEtBQUs7VUFBQTtZQUNSUCxjQUFjLENBQUMsSUFBSSxDQUFDO1lBQUE7VUFBQTtRQUFBLEtBRWpCLE9BQU87VUFBQTtZQUNWekIsZ0JBQWdCLENBQUNpQyxNQUdoQixDQUFDO1lBQ0ZkLE1BQU0sQ0FBQyxDQUFDO1lBQUE7VUFBQTtRQUFBLEtBRUwsU0FBUztVQUFBO1lBQ1pBLE1BQU0sQ0FBQyxDQUFDO1lBQUE7VUFBQTtNQUVaO0lBQUMsQ0FDRjtJQUFBRyxDQUFBLE1BQUFILE1BQUE7SUFBQUcsQ0FBQSxNQUFBUSxFQUFE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQWhCRCxNQUFBUyxZQUFBLEdBQUFELEVBZ0JDO0VBQUEsSUFBQUksRUFBQTtFQUFBLElBQUFaLENBQUEsUUFBQUssTUFBQSxDQUFBQyxHQUFBO0lBR0NNLEVBQUE7TUFBQUMsS0FBQSxFQUFTLDZCQUE2QjtNQUFBSCxLQUFBLEVBQVMsS0FBSyxJQUFJSTtJQUFNLENBQUM7SUFBQWQsQ0FBQSxNQUFBWSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBWixDQUFBO0VBQUE7RUFBQSxJQUFBZSxFQUFBO0VBQUEsSUFBQWYsQ0FBQSxRQUFBSyxNQUFBLENBQUFDLEdBQUE7SUFDL0RTLEVBQUEsRUFDQ0YsS0FBQSxFQUFTLFNBQVM7SUFBQUGSQ0FBQSxFQUFTLFNBQVMsSUFBSUk7RUFBTSxDQUFDO0lBQUFkLENBQUEsTUFBQWUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWYsQ0FBQTtFQUFBO0VBQUEsSUFBQWdCLEVBQUE7RUFBQSxJQUFBaEIsQ0FBQSxRQUFBSyxNQUFBLENBQUFDLEdBQUE7SUFDL0NWLEVBQUE7TUFBQUMsS0FBQSxFQUFTLGlCQUFpQjtNQUFBSCxLQUFBLEVBQVMsT0FBTyxJQUFJSTtJQUFNLENBQUM7SUFBQWQsQ0FBQSxNQUFBZ0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWhCLENBQUE7RUFBQTtFQUpELE1BQUFpQixPQUFBLEdBQWdCRCxFQUlmO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFsQixDQUFBLFFBQUFLLE1BQUEsQ0FBQUMsR0FBQTtJQUtLWSxFQUFBLElBQUMsR0FBRyxDQUFlLFlBQUMsQ0FBRCxHQUFDLENBQ2xCLENBQUMsSUFBSSxDQUFDLGtGQUdOLEVBSEMsSUFBSSxDQUlQLEVBTEMsR0FBRyxDQUtFO0lBQUFsQixDQUFBLE1BQUFrQixFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBbEIsQ0FBQTtFQUFBO0VBQUEsSUFBQW1CLEVBQUE7RUFBQSxJQUFBbkIsQ0FBQSxRQUFBUyxZQUFBO0lBSU1VLEVBQUEsR0FBQUEsQ0FBQSxLQUFNVixZQUFZLENBQUMsU0FBUyxDQUFDO0lBQUFULENBQUEsTUFBQVMsWUFBQTtJQUFBVCxDQUFBLE9BQUFBLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFuQixDQUFBO0VBQUE7RUFBQSxJQUFBb0IsRUFBQTtFQUFBLElBQUFwQixDQUFBLFNBQUFTLFlBQUEsSUFBQVQsQ0FBQSxTQUFBbUIsRUFBQTtJQVg3Q0MsRUFBQSxJQUFDLGdCQUFnQixDQUFPLEtBQXlCLENBQXpCLHlCQUF5QixDQUMvQyxDQUFDLEdBQUcsQ0FBZSxhQUFRLENBQVIsUUFBUSxDQUFXLFFBQUMsQ0FBRCxHQUFDLENBQVksUUFBQyxDQUFELEdBQUMsQ0FDbEQsQ0FBQUYsRUFLSyxDQUNMLENBQUMsTUFBTSxDQUNJRCxPQUFPLENBQVBBLFFBQU0sQ0FBQyxDQUNOUixRQUFZLENBQVpBLGFBQVcsQ0FBQyxDQUNaLFFBQTZCLENBQTdCLENBQUFVLEVBQTRCLENBQUMsR0FFM0MsRUFaQyxHQUFHLENBYU4sRUFkQyxnQkFBZ0IsQ0FjRTtJQUFBbkIsQ0FBQSxPQUFBUyxZQUFBO0lBQUFULENBQUEsT0FBQW1CLEVBQUE7SUFBQW5CLENBQUEsT0FBQW9CLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFwQixDQUFBO0VBQUE7RUFBQSxPQWRuQm9CLEVBY21CO0FBQUE7QUF4RGhCLFNBQUFULE9BQUFVLE1BQUE7RUF3QkcsSUFBSUMsTUFBSSxDQUFBN0Isc0JBQXVCO0lBQUEsT0FBUzZCLE1BQUk7RUFBQTtFQUFBLE9BQ3JDO0lBQUEsR0FBS0EsTUFBSTtJQUFBN0Isc0JBQUEsRUFBMEI7RUFBSyxDQUFDO0FBQUE7QUF6Qm5ELFNBQUFjLE1BQUE7RUFLSCxNQUFBZ0IsUUFBQSxHQUFpQixDQUFDOUMsZUFBZSxDQUFDLENBQUMsQ0FBQWlCLHNCQUE0QixJQUE3QyxDQUE2QyxJQUFJLENBQUM7RUFDcEVoQixnQkFBZ0IsQ0FBQzRDLElBQUE7SUFDZixJQUFJLENBQUNBLElBQUksQ0FBQTVCLHNCQUE0QixJQUFoQyxDQUFnQyxLQUFLNkIsUUFBUTtNQUFBLE9BQVNELElBQUk7SUFBQTtJQUFBLE9BQ3hEO01BQUEsR0FBS0EsSUFBSTtNQUFBNUIsc0JBQUEsRUFBMEI2QjtJQUFTLENBQUM7RUFBQSxDQUNyRCxDQUFDO0VBQ0YvQyxRQUFRLENBQUMsNEJBQTRCLEVBQUU7SUFBQWdELFVBQUEsRUFBY0Q7RUFBUyxDQUFDLENBQUM7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
