/**
 * ThemeProvider.tsx — 主题系统 Provider 与相关 Hooks
 *
 * 在 Claude Code 系统流程中的位置：
 *   设计系统（design-system）层 → 主题管理 → 全局主题上下文提供者
 *
 * 主要功能：
 *   1. ThemeProvider：React Context Provider，向整棵组件树提供主题状态。
 *      管理三类状态：
 *        - themeSetting：用户持久化偏好（可为 'auto'/'dark'/'light'）
 *        - previewTheme：主题选择器打开时的临时预览主题（null 表示无预览）
 *        - systemTheme：当设置为 'auto' 时，通过 OSC 11 协议检测到的终端实际主题
 *   2. useTheme()：最常用的 Hook，返回 [已解析主题名, setter]，
 *      解析后永不返回 'auto'（自动转换为实际的 'dark'/'light'）。
 *   3. useThemeSetting()：返回原始配置值（包含 'auto'），供主题选择器使用。
 *   4. usePreviewTheme()：返回预览相关操作（setPreviewTheme/savePreview/cancelPreview）。
 *   5. AUTO_THEME 特性标志：通过 feature('AUTO_THEME') 动态加载 systemThemeWatcher，
 *      在外部构建中通过 dead-code elimination 移除，避免包体积膨胀。
 *
 * 使用场景：
 *   在应用根部包裹整个 UI 树，使 ThemedBox/ThemedText 等组件
 *   通过 useTheme() 获取当前主题进行颜色解析。
 */
import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import useStdin from '../../ink/hooks/use-stdin.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getSystemThemeName, type SystemTheme } from '../../utils/systemTheme.js';
import type { ThemeName, ThemeSetting } from '../../utils/theme.js';
// ThemeContext 的值类型：包含主题读写所有操作
type ThemeContextValue = {
  /** 用户保存的主题偏好，可能是 'auto'（跟随系统） */
  themeSetting: ThemeSetting;
  setThemeSetting: (setting: ThemeSetting) => void;
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
  /** 实际用于渲染的主题名称，永远不会是 'auto' */
  currentTheme: ThemeName;
};

// 默认主题为 'dark'（非 'auto'），保证 useTheme() 在无 Provider 时（测试/工具环境）也能正常使用
const DEFAULT_THEME: ThemeName = 'dark';
// 创建 ThemeContext，提供安全的空操作默认值（Provider 未挂载时不会报错）
const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME
});
type Props = {
  children: React.ReactNode;
  initialState?: ThemeSetting;
  onThemeSave?: (setting: ThemeSetting) => void;
};
/**
 * defaultInitialTheme — 读取全局配置中用户保存的主题偏好
 * 作为 ThemeProvider 的默认 initialState 获取函数。
 */
function defaultInitialTheme(): ThemeSetting {
  return getGlobalConfig().theme;
}

/**
 * defaultSaveTheme — 将主题偏好写回全局配置文件
 * 作为 ThemeProvider 的默认 onThemeSave 回调。
 */
function defaultSaveTheme(setting: ThemeSetting): void {
  saveGlobalConfig(current => ({
    ...current,
    theme: setting
  }));
}
/**
 * ThemeProvider — 主题上下文 Provider 组件
 *
 * 整体流程：
 *   1. 初始化 themeSetting 状态（从 initialState 或读取全局配置）
 *   2. 初始化 previewTheme 状态（主题选择器临时预览，null=无预览）
 *   3. 初始化 systemTheme 状态：仅当初始设置为 'auto' 时才调用 getSystemThemeName()
 *      获取终端实际主题（通过 $COLORFGBG 环境变量或 OSC 11），否则默认 'dark'
 *   4. activeSetting = previewTheme ?? themeSetting（预览模式优先）
 *   5. useEffect 监听 activeSetting 变化：当且仅当 activeSetting==='auto' 且
 *      AUTO_THEME feature flag 开启时，动态加载 systemThemeWatcher 并启动 OSC 11 监听
 *   6. currentTheme = activeSetting==='auto' ? systemTheme : activeSetting（解析 auto）
 *   7. useMemo 构建 context value（含所有操作函数），deps 为 [themeSetting, previewTheme, currentTheme, onThemeSave]
 *   8. 渲染 ThemeContext.Provider
 *
 * 在系统中的作用：
 *   整个 Claude Code 终端 UI 的主题管理核心，
 *   所有主题读写操作通过此 Provider 统一协调。
 */
export function ThemeProvider({
  children,
  initialState,
  onThemeSave = defaultSaveTheme
}: Props) {
  // 主题偏好设置状态（持久化到全局配置）
  const [themeSetting, setThemeSetting] = useState(initialState ?? defaultInitialTheme);
  // 预览主题状态（主题选择器打开时的临时设置，关闭后恢复为 null）
  const [previewTheme, setPreviewTheme] = useState<ThemeSetting | null>(null);

  // 跟踪终端实际主题，用于 'auto' 模式的解析。
  // 初始值：若初始设置为 'auto' 则调用 getSystemThemeName() 读取 $COLORFGBG，
  // 否则默认 'dark'；OSC 11 watcher 启动后会修正为更精确的值。
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() => (initialState ?? themeSetting) === 'auto' ? getSystemThemeName() : 'dark');

  // activeSetting：当前实际生效的设置（预览模式下以预览主题为准）
  const activeSetting = previewTheme ?? themeSetting;
  const {
    internal_querier
  } = useStdin();

  // 当 activeSetting 为 'auto' 时，动态加载并启动 OSC 11 终端主题监听。
  // feature('AUTO_THEME') 正向检查模式：外部构建中 dead-code-eliminated，
  // 不会将 watcher 代码打包进去。
  useEffect(() => {
    if (feature('AUTO_THEME')) {
      // 非 auto 模式或无法查询终端时提前退出
      if (activeSetting !== 'auto' || !internal_querier) return;
      let cleanup: (() => void) | undefined;
      let cancelled = false;
      // 动态导入避免在非 auto 模式下加载 watcher 代码
      void import('../../utils/systemThemeWatcher.js').then(({
        watchSystemTheme
      }) => {
        if (cancelled) return; // 组件已卸载，忽略回调
        cleanup = watchSystemTheme(internal_querier, setSystemTheme);
      });
      return () => {
        cancelled = true;   // 标记已取消，防止 Promise 回调在卸载后执行
        cleanup?.();        // 清理 OSC 11 监听器
      };
    }
  }, [activeSetting, internal_querier]);
  // 解析 currentTheme：'auto' → 取 systemTheme，否则直接取 activeSetting
  const currentTheme: ThemeName = activeSetting === 'auto' ? systemTheme : activeSetting;
  // 构建 context value，useMemo 避免每次渲染都创建新对象导致子树重渲染
  const value = useMemo<ThemeContextValue>(() => ({
    themeSetting,
    setThemeSetting: (newSetting: ThemeSetting) => {
      setThemeSetting(newSetting);
      setPreviewTheme(null); // 确认新设置时清除预览状态
      // 切换到 'auto' 时重启 watcher（activeSetting dep 变化触发 useEffect）。
      // 用缓存值预填 systemTheme，避免 OSC 11 往返延迟期间闪烁错误调色板。
      if (newSetting === 'auto') {
        setSystemTheme(getSystemThemeName());
      }
      onThemeSave?.(newSetting); // 回调写入配置文件
    },
    setPreviewTheme: (newSetting_0: ThemeSetting) => {
      setPreviewTheme(newSetting_0);
      // 预览 'auto' 时也需要初始化 systemTheme
      if (newSetting_0 === 'auto') {
        setSystemTheme(getSystemThemeName());
      }
    },
    savePreview: () => {
      // 将当前预览主题确认为正式主题设置并保存
      if (previewTheme !== null) {
        setThemeSetting(previewTheme);
        setPreviewTheme(null);
        onThemeSave?.(previewTheme);
      }
    },
    cancelPreview: () => {
      // 取消预览，恢复到用户已保存的 themeSetting
      if (previewTheme !== null) {
        setPreviewTheme(null);
      }
    },
    currentTheme
  }), [themeSetting, previewTheme, currentTheme, onThemeSave]);
  // 渲染 Provider，将主题 context 注入子树
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * useTheme — 获取已解析的当前主题名称（永不为 'auto'）及主题 setter
 *
 * 整体流程：
 *   1. 从 ThemeContext 取出 currentTheme（已解析为 'dark'/'light'）和 setThemeSetting
 *   2. React Compiler 记忆化（_c(3)）：仅当两者之一变化时重新构建数组，避免无谓引用变化
 *   3. 返回 [currentTheme, setThemeSetting] 元组
 *
 * 在系统中的作用：
 *   ThemedBox/ThemedText 等组件通过此 Hook 获取当前主题进行颜色解析。
 */
export function useTheme() {
  // 初始化大小为 3 的记忆缓存（输入2个，输出1个）
  const $ = _c(3);
  const {
    currentTheme,
    setThemeSetting
  } = useContext(ThemeContext);
  let t0;
  // 若 currentTheme 或 setThemeSetting 变化，重新构建数组并缓存
  if ($[0] !== currentTheme || $[1] !== setThemeSetting) {
    t0 = [currentTheme, setThemeSetting];
    $[0] = currentTheme;
    $[1] = setThemeSetting;
    $[2] = t0;
  } else {
    // 缓存命中：直接返回上次数组，保持引用稳定性
    t0 = $[2];
  }
  return t0;
}

/**
 * useThemeSetting — 获取原始主题设置值（包括 'auto'）
 *
 * 整体流程：
 *   直接从 ThemeContext 取出 themeSetting 并返回，不经过解析。
 *
 * 在系统中的作用：
 *   主题选择器（ThemePicker）使用此 Hook 显示包含 'auto' 在内的完整选项。
 */
export function useThemeSetting() {
  return useContext(ThemeContext).themeSetting;
}

/**
 * usePreviewTheme — 获取主题预览操作对象
 *
 * 整体流程：
 *   1. 从 ThemeContext 取出三个预览相关方法
 *   2. React Compiler 记忆化（_c(4)）：任一方法引用变化时重新构建对象
 *   3. 返回 { setPreviewTheme, savePreview, cancelPreview }
 *
 * 在系统中的作用：
 *   主题选择器打开时，通过此 Hook 管理临时预览状态。
 */
export function usePreviewTheme() {
  // 初始化大小为 4 的记忆缓存（输入3个，输出1个）
  const $ = _c(4);
  const {
    setPreviewTheme,
    savePreview,
    cancelPreview
  } = useContext(ThemeContext);
  let t0;
  // 若任一方法引用变化，重新构建对象
  if ($[0] !== cancelPreview || $[1] !== savePreview || $[2] !== setPreviewTheme) {
    t0 = {
      setPreviewTheme,
      savePreview,
      cancelPreview
    };
    $[0] = cancelPreview;
    $[1] = savePreview;
    $[2] = setPreviewTheme;
    $[3] = t0;
  } else {
    // 缓存命中：复用对象，保持引用稳定性
    t0 = $[3];
  }
  return t0;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiUmVhY3QiLCJjcmVhdGVDb250ZXh0IiwidXNlQ29udGV4dCIsInVzZUVmZmVjdCIsInVzZU1lbW8iLCJ1c2VTdGF0ZSIsInVzZVN0ZGluIiwiZ2V0R2xvYmFsQ29uZmlnIiwic2F2ZUdsb2JhbENvbmZpZyIsImdldFN5c3RlbVRoZW1lTmFtZSIsIlN5c3RlbVRoZW1lIiwiVGhlbWVOYW1lIiwiVGhlbWVTZXR0aW5nIiwiVGhlbWVDb250ZXh0VmFsdWUiLCJ0aGVtZVNldHRpbmciLCJzZXRUaGVtZVNldHRpbmciLCJzZXR0aW5nIiwic2V0UHJldmlld1RoZW1lIiwic2F2ZVByZXZpZXciLCJjYW5jZWxQcmV2aWV3IiwiY3VycmVudFRoZW1lIiwiREVGQVVMVF9USEVNRSIsIlRoZW1lQ29udGV4dCIsIlByb3BzIiwiY2hpbGRyZW4iLCJSZWFjdE5vZGUiLCJpbml0aWFsU3RhdGUiLCJvblRoZW1lU2F2ZSIsImRlZmF1bHRJbml0aWFsVGhlbWUiLCJ0aGVtZSIsImRlZmF1bHRTYXZlVGhlbWUiLCJjdXJyZW50IiwiVGhlbWVQcm92aWRlciIsInByZXZpZXdUaGVtZSIsInN5c3RlbVRoZW1lIiwic2V0U3lzdGVtVGhlbWUiLCJhY3RpdmVTZXR0aW5nIiwiaW50ZXJuYWxfcXVlcmllciIsImNsZWFudXAiLCJjYW5jZWxsZWQiLCJ0aGVuIiwid2F0Y2hTeXN0ZW1UaGVtZSIsInZhbHVlIiwibmV3U2V0dGluZyIsInVzZVRoZW1lIiwiJCIsIl9jIiwidDAiLCJ1c2VUaGVtZVNldHRpbmciLCJ1c2VQcmV2aWV3VGhlbWUiXSwic291cmNlcyI6WyJUaGVtZVByb3ZpZGVyLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBmZWF0dXJlIH0gZnJvbSAnYnVuOmJ1bmRsZSdcbmltcG9ydCBSZWFjdCwge1xuICBjcmVhdGVDb250ZXh0LFxuICB1c2VDb250ZXh0LFxuICB1c2VFZmZlY3QsXG4gIHVzZU1lbW8sXG4gIHVzZVN0YXRlLFxufSBmcm9tICdyZWFjdCdcbmltcG9ydCB1c2VTdGRpbiBmcm9tICcuLi8uLi9pbmsvaG9va3MvdXNlLXN0ZGluLmpzJ1xuaW1wb3J0IHsgZ2V0R2xvYmFsQ29uZmlnLCBzYXZlR2xvYmFsQ29uZmlnIH0gZnJvbSAnLi4vLi4vdXRpbHMvY29uZmlnLmpzJ1xuaW1wb3J0IHtcbiAgZ2V0U3lzdGVtVGhlbWVOYW1lLFxuICB0eXBlIFN5c3RlbVRoZW1lLFxufSBmcm9tICcuLi8uLi91dGlscy9zeXN0ZW1UaGVtZS5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWVOYW1lLCBUaGVtZVNldHRpbmcgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcblxudHlwZSBUaGVtZUNvbnRleHRWYWx1ZSA9IHtcbiAgLyoqIFRoZSBzYXZlZCB1c2VyIHByZWZlcmVuY2UuIE1heSBiZSAnYXV0bycuICovXG4gIHRoZW1lU2V0dGluZzogVGhlbWVTZXR0aW5nXG4gIHNldFRoZW1lU2V0dGluZzogKHNldHRpbmc6IFRoZW1lU2V0dGluZykgPT4gdm9pZFxuICBzZXRQcmV2aWV3VGhlbWU6IChzZXR0aW5nOiBUaGVtZVNldHRpbmcpID0+IHZvaWRcbiAgc2F2ZVByZXZpZXc6ICgpID0+IHZvaWRcbiAgY2FuY2VsUHJldmlldzogKCkgPT4gdm9pZFxuICAvKiogVGhlIHJlc29sdmVkIHRoZW1lIHRvIHJlbmRlciB3aXRoLiBOZXZlciAnYXV0bycuICovXG4gIGN1cnJlbnRUaGVtZTogVGhlbWVOYW1lXG59XG5cbi8vIE5vbi0nYXV0bycgZGVmYXVsdCBzbyB1c2VUaGVtZSgpIHdvcmtzIHdpdGhvdXQgYSBwcm92aWRlciAodGVzdHMsIHRvb2xpbmcpLlxuY29uc3QgREVGQVVMVF9USEVNRTogVGhlbWVOYW1lID0gJ2RhcmsnXG5cbmNvbnN0IFRoZW1lQ29udGV4dCA9IGNyZWF0ZUNvbnRleHQ8VGhlbWVDb250ZXh0VmFsdWU+KHtcbiAgdGhlbWVTZXR0aW5nOiBERUZBVUxUX1RIRU1FLFxuICBzZXRUaGVtZVNldHRpbmc6ICgpID0+IHt9LFxuICBzZXRQcmV2aWV3VGhlbWU6ICgpID0+IHt9LFxuICBzYXZlUHJldmlldzogKCkgPT4ge30sXG4gIGNhbmNlbFByZXZpZXc6ICgpID0+IHt9LFxuICBjdXJyZW50VGhlbWU6IERFRkFVTFRfVEhFTUUsXG59KVxuXG50eXBlIFByb3BzID0ge1xuICBjaGlsZHJlbjogUmVhY3QuUmVhY3ROb2RlXG4gIGluaXRpYWxTdGF0ZT86IFRoZW1lU2V0dGluZ1xuICBvblRoZW1lU2F2ZT86IChzZXR0aW5nOiBUaGVtZVNldHRpbmcpID0+IHZvaWRcbn1cblxuZnVuY3Rpb24gZGVmYXVsdEluaXRpYWxUaGVtZSgpOiBUaGVtZVNldHRpbmcge1xuICByZXR1cm4gZ2V0R2xvYmFsQ29uZmlnKCkudGhlbWVcbn1cblxuZnVuY3Rpb24gZGVmYXVsdFNhdmVUaGVtZShzZXR0aW5nOiBUaGVtZVNldHRpbmcpOiB2b2lkIHtcbiAgc2F2ZUdsb2JhbENvbmZpZyhjdXJyZW50ID0+ICh7IC4uLmN1cnJlbnQsIHRoZW1lOiBzZXR0aW5nIH0pKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gVGhlbWVQcm92aWRlcih7XG4gIGNoaWxkcmVuLFxuICBpbml0aWFsU3RhdGUsXG4gIG9uVGhlbWVTYXZlID0gZGVmYXVsdFNhdmVUaGVtZSxcbn06IFByb3BzKSB7XG4gIGNvbnN0IFt0aGVtZVNldHRpbmcsIHNldFRoZW1lU2V0dGluZ10gPSB1c2VTdGF0ZShcbiAgICBpbml0aWFsU3RhdGUgPz8gZGVmYXVsdEluaXRpYWxUaGVtZSxcbiAgKVxuICBjb25zdCBbcHJldmlld1RoZW1lLCBzZXRQcmV2aWV3VGhlbWVdID0gdXNlU3RhdGU8VGhlbWVTZXR0aW5nIHwgbnVsbD4obnVsbClcblxuICAvLyBUcmFjayB0ZXJtaW5hbCB0aGVtZSBmb3IgJ2F1dG8nIHJlc29sdXRpb24uIFNlZWRzIGZyb20gJENPTE9SRkdCRyAob3JcbiAgLy8gJ2RhcmsnIGlmIHVuc2V0KTsgdGhlIE9TQyAxMSB3YXRjaGVyIGNvcnJlY3RzIGl0IG9uIGZpcnN0IHBvbGwuXG4gIGNvbnN0IFtzeXN0ZW1UaGVtZSwgc2V0U3lzdGVtVGhlbWVdID0gdXNlU3RhdGU8U3lzdGVtVGhlbWU+KCgpID0+XG4gICAgKGluaXRpYWxTdGF0ZSA/PyB0aGVtZVNldHRpbmcpID09PSAnYXV0bycgPyBnZXRTeXN0ZW1UaGVtZU5hbWUoKSA6ICdkYXJrJyxcbiAgKVxuXG4gIC8vIFRoZSBzZXR0aW5nIGN1cnJlbnRseSBpbiBlZmZlY3QgKHByZXZpZXcgd2lucyB3aGlsZSBwaWNrZXIgaXMgb3BlbilcbiAgY29uc3QgYWN0aXZlU2V0dGluZyA9IHByZXZpZXdUaGVtZSA/PyB0aGVtZVNldHRpbmdcblxuICBjb25zdCB7IGludGVybmFsX3F1ZXJpZXIgfSA9IHVzZVN0ZGluKClcblxuICAvLyBXYXRjaCBmb3IgbGl2ZSB0ZXJtaW5hbCB0aGVtZSBjaGFuZ2VzIHdoaWxlICdhdXRvJyBpcyBhY3RpdmUuXG4gIC8vIFBvc2l0aXZlIGZlYXR1cmUoKSBwYXR0ZXJuIHNvIHRoZSB3YXRjaGVyIGltcG9ydCBpcyBkZWFkLWNvZGUtZWxpbWluYXRlZFxuICAvLyBpbiBleHRlcm5hbCBidWlsZHMuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKGZlYXR1cmUoJ0FVVE9fVEhFTUUnKSkge1xuICAgICAgaWYgKGFjdGl2ZVNldHRpbmcgIT09ICdhdXRvJyB8fCAhaW50ZXJuYWxfcXVlcmllcikgcmV0dXJuXG4gICAgICBsZXQgY2xlYW51cDogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkXG4gICAgICBsZXQgY2FuY2VsbGVkID0gZmFsc2VcbiAgICAgIHZvaWQgaW1wb3J0KCcuLi8uLi91dGlscy9zeXN0ZW1UaGVtZVdhdGNoZXIuanMnKS50aGVuKFxuICAgICAgICAoeyB3YXRjaFN5c3RlbVRoZW1lIH0pID0+IHtcbiAgICAgICAgICBpZiAoY2FuY2VsbGVkKSByZXR1cm5cbiAgICAgICAgICBjbGVhbnVwID0gd2F0Y2hTeXN0ZW1UaGVtZShpbnRlcm5hbF9xdWVyaWVyLCBzZXRTeXN0ZW1UaGVtZSlcbiAgICAgICAgfSxcbiAgICAgIClcbiAgICAgIHJldHVybiAoKSA9PiB7XG4gICAgICAgIGNhbmNlbGxlZCA9IHRydWVcbiAgICAgICAgY2xlYW51cD8uKClcbiAgICAgIH1cbiAgICB9XG4gIH0sIFthY3RpdmVTZXR0aW5nLCBpbnRlcm5hbF9xdWVyaWVyXSlcblxuICBjb25zdCBjdXJyZW50VGhlbWU6IFRoZW1lTmFtZSA9XG4gICAgYWN0aXZlU2V0dGluZyA9PT0gJ2F1dG8nID8gc3lzdGVtVGhlbWUgOiBhY3RpdmVTZXR0aW5nXG5cbiAgY29uc3QgdmFsdWUgPSB1c2VNZW1vPFRoZW1lQ29udGV4dFZhbHVlPihcbiAgICAoKSA9PiAoe1xuICAgICAgdGhlbWVTZXR0aW5nLFxuICAgICAgc2V0VGhlbWVTZXR0aW5nOiAobmV3U2V0dGluZzogVGhlbWVTZXR0aW5nKSA9PiB7XG4gICAgICAgIHNldFRoZW1lU2V0dGluZyhuZXdTZXR0aW5nKVxuICAgICAgICBzZXRQcmV2aWV3VGhlbWUobnVsbClcbiAgICAgICAgLy8gU3dpdGNoaW5nIHRvICdhdXRvJyByZXN0YXJ0cyB0aGUgd2F0Y2hlciAoYWN0aXZlU2V0dGluZyBkZXApLCB3aG9zZVxuICAgICAgICAvLyBmaXJzdCBwb2xsIGZpcmVzIGltbWVkaWF0ZWx5LiBTZWVkIGZyb20gdGhlIGNhY2hlIHNvIHRoZSBPU0NcbiAgICAgICAgLy8gcm91bmQtdHJpcCBkb2Vzbid0IGZsYXNoIHRoZSB3cm9uZyBwYWxldHRlLlxuICAgICAgICBpZiAobmV3U2V0dGluZyA9PT0gJ2F1dG8nKSB7XG4gICAgICAgICAgc2V0U3lzdGVtVGhlbWUoZ2V0U3lzdGVtVGhlbWVOYW1lKCkpXG4gICAgICAgIH1cbiAgICAgICAgb25UaGVtZVNhdmU/LihuZXdTZXR0aW5nKVxuICAgICAgfSxcbiAgICAgIHNldFByZXZpZXdUaGVtZTogKG5ld1NldHRpbmc6IFRoZW1lU2V0dGluZykgPT4ge1xuICAgICAgICBzZXRQcmV2aWV3VGhlbWUobmV3U2V0dGluZylcbiAgICAgICAgaWYgKG5ld1NldHRpbmcgPT09ICdhdXRvJykge1xuICAgICAgICAgIHNldFN5c3RlbVRoZW1lKGdldFN5c3RlbVRoZW1lTmFtZSgpKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgc2F2ZVByZXZpZXc6ICgpID0+IHtcbiAgICAgICAgaWYgKHByZXZpZXdUaGVtZSAhPT0gbnVsbCkge1xuICAgICAgICAgIHNldFRoZW1lU2V0dGluZyhwcmV2aWV3VGhlbWUpXG4gICAgICAgICAgc2V0UHJldmlld1RoZW1lKG51bGwpXG4gICAgICAgICAgb25UaGVtZVNhdmU/LihwcmV2aWV3VGhlbWUpXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjYW5jZWxQcmV2aWV3OiAoKSA9PiB7XG4gICAgICAgIGlmIChwcmV2aWV3VGhlbWUgIT09IG51bGwpIHtcbiAgICAgICAgICBzZXRQcmV2aWV3VGhlbWUobnVsbClcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGN1cnJlbnRUaGVtZSxcbiAgICB9KSxcbiAgICBbdGhlbWVTZXR0aW5nLCBwcmV2aWV3VGhlbWUsIGN1cnJlbnRUaGVtZSwgb25UaGVtZVNhdmVdLFxuICApXG5cbiAgcmV0dXJuIDxUaGVtZUNvbnRleHQuUHJvdmlkZXIgdmFsdWU9e3ZhbHVlfT57Y2hpbGRyZW59PC9UaGVtZUNvbnRleHQuUHJvdmlkZXI+XG59XG5cbi8qKlxuICogUmV0dXJucyB0aGUgcmVzb2x2ZWQgdGhlbWUgZm9yIHJlbmRlcmluZyAobmV2ZXIgJ2F1dG8nKSBhbmQgYSBzZXR0ZXIgdGhhdFxuICogYWNjZXB0cyBhbnkgVGhlbWVTZXR0aW5nIChpbmNsdWRpbmcgJ2F1dG8nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVzZVRoZW1lKCk6IFtUaGVtZU5hbWUsIChzZXR0aW5nOiBUaGVtZVNldHRpbmcpID0+IHZvaWRdIHtcbiAgY29uc3QgeyBjdXJyZW50VGhlbWUsIHNldFRoZW1lU2V0dGluZyB9ID0gdXNlQ29udGV4dChUaGVtZUNvbnRleHQpXG4gIHJldHVybiBbY3VycmVudFRoZW1lLCBzZXRUaGVtZVNldHRpbmddXG59XG5cbi8qKlxuICogUmV0dXJucyB0aGUgcmF3IHRoZW1lIHNldHRpbmcgYXMgc3RvcmVkIGluIGNvbmZpZy4gVXNlIHRoaXMgaW4gVUkgdGhhdFxuICogbmVlZHMgdG8gc2hvdyAnYXV0bycgYXMgYSBkaXN0aW5jdCBjaG9pY2UgKGUuZy4sIFRoZW1lUGlja2VyKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVzZVRoZW1lU2V0dGluZygpOiBUaGVtZVNldHRpbmcge1xuICByZXR1cm4gdXNlQ29udGV4dChUaGVtZUNvbnRleHQpLnRoZW1lU2V0dGluZ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXNlUHJldmlld1RoZW1lKCkge1xuICBjb25zdCB7IHNldFByZXZpZXdUaGVtZSwgc2F2ZVByZXZpZXcsIGNhbmNlbFByZXZpZXcgfSA9XG4gICAgdXNlQ29udGV4dChUaGVtZUNvbnRleHQpXG4gIHJldHVybiB7IHNldFByZXZpZXdUaGVtZSwgc2F2ZVByZXZpZXcsIGNhbmNlbFByZXZpZXcgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBU0EsT0FBTyxRQUFRLFlBQVk7QUFDcEMsT0FBT0MsS0FBSyxJQUNWQyxhQUFhLEVBQ2JDLFVBQVUsRUFDVkMsU0FBUyxFQUNUQyxPQUFPLEVBQ1BDLFFBQVEsUUFDSCxPQUFPO0FBQ2QsT0FBT0MsUUFBUSxNQUFNLDhCQUE4QjtBQUNuRCxTQUFTQyxlQUFlLEVBQUVDLGdCQUFnQixRQUFRLHVCQUF1QjtBQUN6RSxTQUNFQyxrQkFBa0IsRUFDbEIsS0FBS0MsV0FBVyxRQUNYLDRCQUE0QjtBQUNuQyxjQUFjQyxTQUFTLEVBQUVDLFlBQVksUUFBUSxzQkFBc0I7QUFFbkUsS0FBS0MsaUJBQWlCLEdBQUc7RUFDdkI7RUFDQUMsWUFBWSxFQUFFRixZQUFZO0VBQzFCRyxlQUFlLEVBQUUsQ0FBQ0MsT0FBTyxFQUFFSixZQUFZLEVBQUUsR0FBRyxJQUFJO0VBQ2hESyxlQUFlLEVBQUUsQ0FB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