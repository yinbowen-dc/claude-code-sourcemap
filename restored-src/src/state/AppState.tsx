/**
 * AppState React 上下文与 Hook 层
 *
 * 在 Claude Code 的状态管理体系中，本文件处于 React 集成层：
 * - 下层：store.ts 提供通用发布-订阅存储原语（createStore）；
 *         AppStateStore.ts 定义完整的 AppState 类型与默认值
 * - 本层：将 AppStateStore 封装为 React Context，并通过
 *         useSyncExternalStore 提供细粒度订阅 Hook
 * - 上层：所有 React 组件通过 useAppState(selector) 订阅特定状态切片，
 *         仅在选择值变化时重新渲染，避免全树重渲染
 *
 * 注意：本文件为 React Compiler 编译输出，使用 _c（memo cache）进行
 * 细粒度 memoization；阅读时可将 $[n] 视为编译器生成的缓存槽。
 *
 * 导出内容：
 * - AppStoreContext：原始 React Context，供需要直接访问 Store 的代码使用
 * - AppStateProvider：应用根组件，初始化并提供 AppStateStore
 * - useAppState(selector)：订阅 AppState 切片的主要 Hook
 * - useSetAppState()：仅获取 setState，不订阅任何状态
 * - useAppStateStore()：获取完整 Store 对象（非 React 代码使用）
 * - useAppStateMaybeOutsideOfProvider(selector)：Provider 外部安全版 Hook
 */

import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import React, { useContext, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import { MailboxProvider } from '../context/mailbox.js';
import { useSettingsChange } from '../hooks/useSettingsChange.js';
import { logForDebugging } from '../utils/debug.js';
import { createDisabledBypassPermissionsContext, isBypassPermissionsModeDisabled } from '../utils/permissions/permissionSetup.js';
import { applySettingsChange } from '../utils/settings/applySettingsChange.js';
import type { SettingSource } from '../utils/settings/constants.js';
import { createStore } from './store.js';

// DCE: voice context is ant-only. External builds get a passthrough.
/* eslint-disable @typescript-eslint/no-require-imports */
// VoiceProvider：ant 版本使用真实语音上下文；外部构建使用透传组件（直接渲染子节点）
const VoiceProvider: (props: {
  children: React.ReactNode;
}) => React.ReactNode = feature('VOICE_MODE') ? require('../context/voice.js').VoiceProvider : ({
  children
}) => children;

/* eslint-enable @typescript-eslint/no-require-imports */
import { type AppState, type AppStateStore, getDefaultAppState } from './AppStateStore.js';

// TODO: Remove these re-exports once all callers import directly from
// ./AppStateStore.js. Kept for back-compat during migration so .ts callers
// can incrementally move off the .tsx import and stop pulling React.
// 向后兼容的重新导出：迁移期间保留，允许 .ts 文件逐步从 .tsx 导入迁移到 .ts 导入
export { type AppState, type AppStateStore, type CompletionBoundary, getDefaultAppState, IDLE_SPECULATION_STATE, type SpeculationResult, type SpeculationState } from './AppStateStore.js';

/** AppStateStore 的 React Context，初始值为 null（未在 Provider 内时） */
export const AppStoreContext = React.createContext<AppStateStore | null>(null);

/** AppStateProvider 的 Props 类型 */
type Props = {
  children: React.ReactNode;
  initialState?: AppState;          // 可选初始状态（测试/SSR 场景使用）
  onChangeAppState?: (args: {
    newState: AppState;
    oldState: AppState;
  }) => void;                       // 状态变化副作用回调（如 onChangeAppState.ts）
};

/** 内部 Context：用于检测 Provider 嵌套，防止意外的多层 Provider */
const HasAppStateContext = React.createContext<boolean>(false);

/**
 * AppState 根 Provider 组件。
 *
 * 职责：
 * 1. 防嵌套检查：确保不在另一个 AppStateProvider 内部渲染
 * 2. 单次创建 Store：通过 useState 惰性初始化，Store 实例在整个生命周期保持稳定，
 *    避免 Context value 变化导致的全树重渲染
 * 3. 挂载时 bypass 权限检查：处理远程设置在 React 挂载前完成加载的竞态条件——
 *    此时 bypass 权限应被禁用，但订阅者尚未注册，需在 useEffect 中补处理
 * 4. 外部设置文件监听：通过 useSettingsChange + applySettingsChange 将文件
 *    监听器的变更同步到 AppState，确保设置文件修改实时生效
 * 5. Context 层叠：从外到内依次包裹 HasAppStateContext → AppStoreContext →
 *    MailboxProvider → VoiceProvider
 *
 * 注：本函数为 React Compiler 编译输出，$[n] 为编译器生成的 memoization 缓存槽。
 */
export function AppStateProvider(t0) {
  const $ = _c(13); // 编译器分配 13 个缓存槽用于细粒度 memoization
  const {
    children,
    initialState,
    onChangeAppState
  } = t0;

  // 检查是否嵌套在另一个 AppStateProvider 内，若是则抛出错误
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error("AppStateProvider can not be nested within another AppStateProvider");
  }

  // memoization：仅当 initialState 或 onChangeAppState 变化时重新创建 store 初始化函数
  let t1;
  if ($[0] !== initialState || $[1] !== onChangeAppState) {
    t1 = () => createStore(initialState ?? getDefaultAppState(), onChangeAppState); // 惰性初始化：Store 仅创建一次
    $[0] = initialState;
    $[1] = onChangeAppState;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const [store] = useState(t1); // useState 确保 store 实例在组件生命周期内稳定

  // memoization：仅当 store 引用变化时重新创建挂载效果函数
  let t2;
  if ($[3] !== store) {
    t2 = () => {
      // 处理竞态：远程设置可能在 React 挂载前已加载并禁用了 bypass 权限
      const {
        toolPermissionContext
      } = store.getState();
      if (toolPermissionContext.isBypassPermissionsModeAvailable && isBypassPermissionsModeDisabled()) {
        logForDebugging("Disabling bypass permissions mode on mount (remote settings loaded before mount)");
        store.setState(_temp); // 使用 _temp updater 禁用 bypass 权限模式
      }
    };
    $[3] = store;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  // 空依赖数组：仅在挂载时执行一次 bypass 权限检查
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = []; // 空依赖数组，确保 effect 只在挂载时运行
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  useEffect(t2, t3);

  // memoization：仅当 store.setState 变化时重新创建设置变化处理函数
  let t4;
  if ($[6] !== store.setState) {
    t4 = source => applySettingsChange(source, store.setState); // 将外部设置变更应用到 AppState
    $[6] = store.setState;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  const onSettingsChange = useEffectEvent(t4); // useEffectEvent 确保 onSettingsChange 始终读取最新 store.setState
  useSettingsChange(onSettingsChange); // 注册文件监听器，设置文件变化时触发 onSettingsChange

  // memoization：仅当 children 变化时重新创建 Provider 内层结构
  let t5;
  if ($[8] !== children) {
    t5 = <MailboxProvider><VoiceProvider>{children}</VoiceProvider></MailboxProvider>; // 依次包裹 Mailbox 和 Voice 上下文
    $[8] = children;
    $[9] = t5;
  } else {
    t5 = $[9];
  }

  // memoization：仅当 store 或内层结构变化时重新创建完整 JSX 树
  let t6;
  if ($[10] !== store || $[11] !== t5) {
    t6 = <HasAppStateContext.Provider value={true}><AppStoreContext.Provider value={store}>{t5}</AppStoreContext.Provider></HasAppStateContext.Provider>;
    // HasAppStateContext.Provider value=true 标记已在 Provider 内，防止嵌套
    // AppStoreContext.Provider 将 store 实例注入 Context，供子组件通过 useAppStore 访问
    $[10] = store;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  return t6;
}

/**
 * 禁用 bypass 权限模式的状态 updater。
 *
 * 从 prev 状态中取出 toolPermissionContext，调用
 * createDisabledBypassPermissionsContext 返回禁用 bypass 权限的新上下文，
 * 其余字段通过展开运算符保持不变。
 */
function _temp(prev) {
  return {
    ...prev,
    toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext) // 禁用 bypass 权限模式
  };
}

/**
 * 内部 Hook：从 Context 获取 AppStateStore 实例。
 *
 * 若在 AppStateProvider 外部调用，则抛出 ReferenceError，
 * 以提早发现误用场景（比在 undefined 上调用方法报错更友好）。
 */
function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext); // 从 Context 获取 Store 实例
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState cannot be called outside of an <AppStateProvider />');
  }
  return store;
}

/**
 * 订阅 AppState 切片的主要 Hook。
 *
 * 流程：
 * 1. 获取 Store 实例（通过 useAppStore）
 * 2. 构造 get 函数：调用 selector(store.getState()) 提取所需切片
 * 3. 通过 useSyncExternalStore 订阅 store，当 store 通知更新时，
 *    React 会调用 get 并用 Object.is 与上次结果比较，
 *    仅在切片值变化时触发组件重渲染
 *
 * 使用要求：
 * - selector 必须返回 AppState 的某个属性，不得返回 AppState 本身
 * - selector 不得返回新建对象（Object.is 永远返回 false，导致无限重渲染）
 * - 需要多个独立字段时，多次调用本 Hook 而非返回对象
 *
 * 注：$[n] 为 React Compiler 生成的 memoization 缓存槽，
 *    仅在 selector 或 store 变化时重新构造 get 函数。
 */
export function useAppState(selector) {
  const $ = _c(3); // 3 个缓存槽：selector、store、get 函数
  const store = useAppStore();
  let t0;
  if ($[0] !== selector || $[1] !== store) {
    t0 = () => {
      const state = store.getState();        // 读取当前状态快照
      const selected = selector(state);      // 通过 selector 提取切片
      if (false && state === selected) {
        // 开发模式（ant 构建）下检测 selector 返回整个 state 的错误用法
        throw new Error(`Your selector in \`useAppState(${selector.toString()})\` returned the original state, which is not allowed. You must instead return a property for optimised rendering.`);
      }
      return selected;
    };
    $[0] = selector;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  const get = t0;
  return useSyncExternalStore(store.subscribe, get, get); // 订阅 store，服务端/客户端均使用同一 get 函数
}

/**
 * 获取 setState 更新函数，不订阅任何状态切片。
 *
 * 返回的引用永远稳定（来自 Store 对象，不随状态变化），
 * 因此使用本 Hook 的组件不会因状态变化而重渲染。
 * 适合仅需触发状态更新而不需读取状态的组件（如事件处理器）。
 */
export function useSetAppState() {
  return useAppStore().setState; // 直接返回 store.setState，引用稳定
}

/**
 * 获取完整 Store 对象（适合需要同时访问 getState/setState 的非 React 代码）。
 *
 * 与 useAppState 不同，本 Hook 不建立任何订阅，
 * 调用方需自行管理 getState 的时机。
 */
export function useAppStateStore() {
  return useAppStore(); // 返回完整 Store 实例
}

/** 空订阅函数：在 Provider 外部时作为 useSyncExternalStore 的 subscribe 占位 */
const NOOP_SUBSCRIBE = () => () => {};

/**
 * AppStateProvider 外部安全版 Hook。
 *
 * 与 useAppState 的区别：
 * - 不抛出错误：在 Provider 外部时返回 undefined 而非抛出 ReferenceError
 * - 适用于可能在 Provider 外渲染的组件（如跨层弹窗、测试场景）
 *
 * 当 store 不存在时，使用 NOOP_SUBSCRIBE（永不触发更新）和返回 undefined 的 get，
 * 组件将始终读取到 undefined 且不会重渲染。
 */
export function useAppStateMaybeOutsideOfProvider(selector) {
  const $ = _c(3); // 3 个缓存槽：selector、store、get 函数
  const store = useContext(AppStoreContext); // 直接读取 Context，不经过 useAppStore（避免抛错）
  let t0;
  if ($[0] !== selector || $[1] !== store) {
    t0 = () => store ? selector(store.getState()) : undefined; // store 存在时调用 selector，否则返回 undefined
    $[0] = selector;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, t0); // store 不存在时使用空订阅，避免报错
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiUmVhY3QiLCJ1c2VDb250ZXh0IiwidXNlRWZmZWN0IiwidXNlRWZmZWN0RXZlbnQiLCJ1c2VTdGF0ZSIsInVzZVN5bmNFeHRlcm5hbFN0b3JlIiwiTWFpbGJveFByb3ZpZGVyIiwidXNlU2V0dGluZ3NDaGFuZ2UiLCJsb2dGb3JEZWJ1Z2dpbmciLCJjcmVhdGVEaXNhYmxlZEJ5cGFzc1Blcm1pc3Npb25zQ29udGV4dCIsImlzQnlwYXNzUGVybWlzc2lvbnNNb2RlRGlzYWJsZWQiLCJhcHBseVNldHRpbmdzQ2hhbmdlIiwiU2V0dGluZ1NvdXJjZSIsImNyZWF0ZVN0b3JlIiwiVm9pY2VQcm92aWRlciIsInByb3BzIiwiY2hpbGRyZW4iLCJSZWFjdE5vZGUiLCJyZXF1aXJlIiwiQXBwU3RhdGUiLCJBcHBTdGF0ZVN0b3JlIiwiZ2V0RGVmYXVsdEFwcFN0YXRlIiwiQ29tcGxldGlvbkJvdW5kYXJ5IiwiSURMRV9TUEVDVUxBVElPTl9TVEFURSIsIlNwZWN1bGF0aW9uUmVzdWx0IiwiU3BlY3VsYXRpb25TdGF0ZSIsIkFwcFN0b3JlQ29udGV4dCIsImNyZWF0ZUNvbnRleHQiLCJQcm9wcyIsImluaXRpYWxTdGF0ZSIsIm9uQ2hhbmdlQXBwU3RhdGUiLCJhcmdzIiwibmV3U3RhdGUiLCJvbGRTdGF0ZSIsIkhhc0FwcFN0YXRlQ29udGV4dCIsIkFwcFN0YXRlUHJvdmlkZXIiLCJ0MCIsIiQiLCJfYyIsImhhc0FwcFN0YXRlQ29udGV4dCIsIkVycm9yIiwidDEiLCJzdG9yZSIsInQyIiwidG9vbFBlcm1pc3Npb25Db250ZXh0IiwiZ2V0U3RhdGUiLCJpc0J5cGFzc1Blcm1pc3Npb25zTW9kZUF2YWlsYWJsZSIsInNldFN0YXRlIiwiX3RlbXAiLCJ0MyIsIlN5bWJvbCIsImZvciIsInQ0Iiwic291cmNlIiwib25TZXR0aW5nc0NoYW5nZSIsInQ1IiwidDYiLCJwcmV2IiwidXNlQXBwU3RvcmUiLCJSZWZlcmVuY2VFcnJvciIsInVzZUFwcFN0YXRlIiwic2VsZWN0b3IiLCJzdGF0ZSIsInNlbGVjdGVkIiwidG9TdHJpbmciLCJnZXQiLCJzdWJzY3JpYmUiLCJ1c2VTZXRBcHBTdGF0ZSIsInVzZUFwcFN0YXRlU3RvcmUiLCJOT09QX1NVQlNDUklCRSIsInVzZUFwcFN0YXRlTWF5YmVPdXRzaWRlT2ZQcm92aWRlciIsInVuZGVmaW5lZCJdLCJzb3VyY2VzIjpbIkFwcFN0YXRlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBmZWF0dXJlIH0gZnJvbSAnYnVuOmJ1bmRsZSdcbmltcG9ydCBSZWFjdCwge1xuICB1c2VDb250ZXh0LFxuICB1c2VFZmZlY3QsXG4gIHVzZUVmZmVjdEV2ZW50LFxuICB1c2VTdGF0ZSxcbiAgdXNlU3luY0V4dGVybmFsU3RvcmUsXG59IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgTWFpbGJveFByb3ZpZGVyIH0gZnJvbSAnLi4vY29udGV4dC9tYWlsYm94LmpzJ1xuaW1wb3J0IHsgdXNlU2V0dGluZ3NDaGFuZ2UgfSBmcm9tICcuLi9ob29rcy91c2VTZXR0aW5nc0NoYW5nZS5qcydcbmltcG9ydCB7IGxvZ0ZvckRlYnVnZ2luZyB9IGZyb20gJy4uL3V0aWxzL2RlYnVnLmpzJ1xuaW1wb3J0IHtcbiAgY3JlYXRlRGlzYWJsZWRCeXBhc3NQZXJtaXNzaW9uc0NvbnRleHQsXG4gIGlzQnlwYXNzUGVybWlzc2lvbnNNb2RlRGlzYWJsZWQsXG59IGZyb20gJy4uL3V0aWxzL3Blcm1pc3Npb25zL3Blcm1pc3Npb25TZXR1cC5qcydcbmltcG9ydCB7IGFwcGx5U2V0dGluZ3NDaGFuZ2UgfSBmcm9tICcuLi91dGlscy9zZXR0aW5ncy9hcHBseVNldHRpbmdzQ2hhbmdlLmpzJ1xuaW1wb3J0IHR5cGUgeyBTZXR0aW5nU291cmNlIH0gZnJvbSAnLi4vdXRpbHMvc2V0dGluZ3MvY29uc3RhbnRzLmpzJ1xuaW1wb3J0IHsgY3JlYXRlU3RvcmUgfSBmcm9tICcuL3N0b3JlLmpzJ1xuXG4vLyBEQ0U6IHZvaWNlIGNvbnRleHQgaXMgYW50LW9ubHkuIEV4dGVybmFsIGJ1aWxkcyBnZXQgYSBwYXNzdGhyb3VnaC5cbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbmNvbnN0IFZvaWNlUHJvdmlkZXI6IChwcm9wczogeyBjaGlsZHJlbjogUmVhY3QuUmVhY3ROb2RlIH0pID0+IFJlYWN0LlJlYWN0Tm9kZSA9XG4gIGZlYXR1cmUoJ1ZPSUNFX01PREUnKVxuICAgID8gcmVxdWlyZSgnLi4vY29udGV4dC92b2ljZS5qcycpLlZvaWNlUHJvdmlkZXJcbiAgICA6ICh7IGNoaWxkcmVuIH0pID0+IGNoaWxkcmVuXG5cbi8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuaW1wb3J0IHtcbiAgdHlwZSBBcHBTdGF0ZSxcbiAgdHlwZSBBcHBTdGF0ZVN0b3JlLFxuICBnZXREZWZhdWx0QXBwU3RhdGUsXG59IGZyb20gJy4vQXBwU3RhdGVTdG9yZS5qcydcblxuLy8gVE9ETzogUmVtb3ZlIHRoZXNlIHJlLWV4cG9ydHMgb25jZSBhbGwgY2FsbGVycyBpbXBvcnQgZGlyZWN0bHkgZnJvbVxuLy8gLi9BcHBTdGF0ZVN0b3JlLmpzLiBLZXB0IGZvciBiYWNrLWNvbXBhdCBkdXJpbmcgbWlncmF0aW9uIHNvIC50cyBjYWxsZXJzXG4vLyBjYW4gaW5jcmVtZW50YWxseSBtb3ZlIG9mZiB0aGUgLnRzeCBpbXBvcnQgYW5kIHN0b3AgcHVsbGluZyBSZWFjdC5cbmV4cG9ydCB7XG4gIHR5cGUgQXBwU3RhdGUsXG4gIHR5cGUgQXBwU3RhdGVTdG9yZSxcbiAgdHlwZSBDb21wbGV0aW9uQm91bmRhcnksXG4gIGdldERlZmF1bHRBcHBTdGF0ZSxcbiAgSURMRV9TUEVDVUxBVElPTl9TVEFURSxcbiAgdHlwZSBTcGVjdWxhdGlvblJlc3VsdCxcbiAgdHlwZSBTcGVjdWxhdGlvblN0YXRlLFxufSBmcm9tICcuL0FwcFN0YXRlU3RvcmUuanMnXG5cbmV4cG9ydCBjb25zdCBBcHBTdG9yZUNvbnRleHQgPSBSZWFjdC5jcmVhdGVDb250ZXh0PEFwcFN0YXRlU3RvcmUgfCBudWxsPihudWxsKVxuXG50eXBlIFByb3BzID0ge1xuICBjaGlsZHJlbjogUmVhY3QuUmVhY3ROb2RlXG4gIGluaXRpYWxTdGF0ZT86IEFwcFN0YXRlXG4gIG9uQ2hhbmdlQXBwU3RhdGU/OiAoYXJnczogeyBuZXdTdGF0ZTogQXBwU3RhdGU7IG9sZFN0YXRlOiBBcHBTdGF0ZSB9KSA9PiB2b2lkXG59XG5cbmNvbnN0IEhhc0FwcFN0YXRlQ29udGV4dCA9IFJlYWN0LmNyZWF0ZUNvbnRleHQ8Ym9vbGVhbj4oZmFsc2UpXG5cbmV4cG9ydCBmdW5jdGlvbiBBcHBTdGF0ZVByb3ZpZGVyKHtcbiAgY2hpbGRyZW4sXG4gIGluaXRpYWxTdGF0ZSxcbiAgb25DaGFuZ2VBcHBTdGF0ZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgLy8gRG9uJ3QgYWxsb3cgbmVzdGVkIEFwcFN0YXRlUHJvdmlkZXJzLlxuICBjb25zdCBoYXNBcHBTdGF0ZUNvbnRleHQgPSB1c2VDb250ZXh0KEhhc0FwcFN0YXRlQ29udGV4dClcbiAgaWYgKGhhc0FwcFN0YXRlQ29udGV4dCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdBcHBTdGF0ZVByb3ZpZGVyIGNhbiBub3QgYmUgbmVzdGVkIHdpdGhpbiBhbm90aGVyIEFwcFN0YXRlUHJvdmlkZXInLFxuICAgIClcbiAgfVxuXG4gIC8vIFN0b3JlIGlzIGNyZWF0ZWQgb25jZSBhbmQgbmV2ZXIgY2hhbmdlcyAtLSBzdGFibGUgY29udGV4dCB2YWx1ZSBtZWFuc1xuICAvLyB0aGUgcHJvdmlkZXIgbmV2ZXIgdHJpZ2dlcnMgcmUtcmVuZGVycy4gQ29uc3VtZXJzIHN1YnNjcmliZSB0byBzbGljZXNcbiAgLy8gdmlhIHVzZVN5bmNFeHRlcm5hbFN0b3JlIGluIHVzZUFwcFN0YXRlKHNlbGVjdG9yKS5cbiAgY29uc3QgW3N0b3JlXSA9IHVzZVN0YXRlKCgpID0+XG4gICAgY3JlYXRlU3RvcmU8QXBwU3RhdGU+KFxuICAgICAgaW5pdGlhbFN0YXRlID8/IGdldERlZmF1bHRBcHBTdGF0ZSgpLFxuICAgICAgb25DaGFuZ2VBcHBTdGF0ZSxcbiAgICApLFxuICApXG5cbiAgLy8gQ2hlY2sgb24gbW91bnQgaWYgYnlwYXNzIG1vZGUgc2hvdWxkIGJlIGRpc2FibGVkXG4gIC8vIFRoaXMgaGFuZGxlcyB0aGUgcmFjZSBjb25kaXRpb24gd2hlcmUgcmVtb3RlIHNldHRpbmdzIGxvYWQgQkVGT1JFIHRoaXMgY29tcG9uZW50IG1vdW50cyxcbiAgLy8gbWVhbmluZyB0aGUgc2V0dGluZ3MgY2hhbmdlIG5vdGlmaWNhdGlvbiB3YXMgc2VudCB3aGVuIG5vIGxpc3RlbmVycyB3ZXJlIHN1YnNjcmliZWQuXG4gIC8vIE9uIHN1YnNlcXVlbnQgc2Vzc2lvbnMsIHRoZSBjYWNoZWQgcmVtb3RlLXNldHRpbmdzLmpzb24gaXMgcmVhZCBkdXJpbmcgaW5pdGlhbCBzZXR1cCxcbiAgLy8gYnV0IG9uIHRoZSBmaXJzdCBzZXNzaW9uIHRoZSByZW1vdGUgZmV0Y2ggbWF5IGNvbXBsZXRlIGJlZm9yZSBSZWFjdCBtb3VudHMuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgY29uc3QgeyB0b29sUGVybWlzc2lvbkNvbnRleHQgfSA9IHN0b3JlLmdldFN0YXRlKClcbiAgICBpZiAoXG4gICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQuaXNCeXBhc3NQZXJtaXNzaW9uc01vZGVBdmFpbGFibGUgJiZcbiAgICAgIGlzQnlwYXNzUGVybWlzc2lvbnNNb2RlRGlzYWJsZWQoKVxuICAgICkge1xuICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAnRGlzYWJsaW5nIGJ5cGFzcyBwZXJtaXNzaW9ucyBtb2RlIG9uIG1vdW50IChyZW1vdGUgc2V0dGluZ3MgbG9hZGVkIGJlZm9yZSBtb3VudCknLFxuICAgICAgKVxuICAgICAgc3RvcmUuc2V0U3RhdGUocHJldiA9PiAoe1xuICAgICAgICAuLi5wcmV2LFxuICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQ6IGNyZWF0ZURpc2FibGVkQnlwYXNzUGVybWlzc2lvbnNDb250ZXh0KFxuICAgICAgICAgIHByZXYudG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICAgICAgICApLFxuICAgICAgfSkpXG4gICAgfVxuICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L2NvcnJlY3RuZXNzL3VzZUV4aGF1c3RpdmVEZXBlbmRlbmNpZXM6IGludGVudGlvbmFsIG1vdW50LW9ubHkgZWZmZWN0XG4gIH0sIFtdKVxuXG4gIC8vIExpc3RlbiBmb3IgZXh0ZXJuYWwgc2V0dGluZ3MgY2hhbmdlcyBhbmQgc3luYyB0byBBcHBTdGF0ZS5cbiAgLy8gVGhpcyBlbnN1cmVzIGZpbGUgd2F0Y2hlciBjaGFuZ2VzIHByb3BhZ2F0ZSB0aHJvdWdoIHRoZSBhcHAgLS1cbiAgLy8gc2hhcmVkIHdpdGggdGhlIGhlYWRsZXNzL1NESyBwYXRoIHZpYSBhcHBseVNldHRpbmdzQ2hhbmdlLlxuICBjb25zdCBvblNldHRpbmdzQ2hhbmdlID0gdXNlRWZmZWN0RXZlbnQoKHNvdXJjZTogU2V0dGluZ1NvdXJjZSkgPT5cbiAgICBhcHBseVNldHRpbmdzQ2hhbmdlKHNvdXJjZSwgc3RvcmUuc2V0U3RhdGUpLFxuICApXG4gIHVzZVNldHRpbmdzQ2hhbmdlKG9uU2V0dGluZ3NDaGFuZ2UpXG5cbiAgcmV0dXJuIChcbiAgICA8SGFzQXBwU3RhdGVDb250ZXh0LlByb3ZpZGVyIHZhbHVlPXt0cnVlfT5cbiAgICAgIDxBcHBTdG9yZUNvbnRleHQuUHJvdmlkZXIgdmFsdWU9e3N0b3JlfT5cbiAgICAgICAgPE1haWxib3hQcm92aWRlcj5cbiAgICAgICAgICA8Vm9pY2VQcm92aWRlcj57Y2hpbGRyZW59PC9Wb2ljZVByb3ZpZGVyPlxuICAgICAgICA8L01haWxib3hQcm92aWRlcj5cbiAgICAgIDwvQXBwU3RvcmVDb250ZXh0LlByb3ZpZGVyPlxuICAgIDwvSGFzQXBwU3RhdGVDb250ZXh0LlByb3ZpZGVyPlxuICApXG59XG5cbmZ1bmN0aW9uIHVzZUFwcFN0b3JlKCk6IEFwcFN0YXRlU3RvcmUge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgcmVhY3QtaG9va3MvcnVsZXMtb2YtaG9va3NcbiAgY29uc3Qgc3RvcmUgPSB1c2VDb250ZXh0KEFwcFN0b3JlQ29udGV4dClcbiAgaWYgKCFzdG9yZSkge1xuICAgIHRocm93IG5ldyBSZWZlcmVuY2VFcnJvcihcbiAgICAgICd1c2VBcHBTdGF0ZS91c2VTZXRBcHBTdGF0ZSBjYW5ub3QgYmUgY2FsbGVkIG91dHNpZGUgb2YgYW4gPEFwcFN0YXRlUHJvdmlkZXIgLz4nLFxuICAgIClcbiAgfVxuICByZXR1cm4gc3RvcmVcbn1cblxuLyoqXG4gKiBTdWJzY3JpYmUgdG8gYSBzbGljZSBvZiBBcHBTdGF0ZS4gT25seSByZS1yZW5kZXJzIHdoZW4gdGhlIHNlbGVjdGVkIHZhbHVlXG4gKiBjaGFuZ2VzIChjb21wYXJlZCB2aWEgT2JqZWN0LmlzKS5cbiAqXG4gKiBGb3IgbXVsdGlwbGUgaW5kZXBlbmRlbnQgZmllbGRzLCBjYWxsIHRoZSBob29rIG11bHRpcGxlIHRpbWVzOlxuICogYGBgXG4gKiBjb25zdCB2ZXJib3NlID0gdXNlQXBwU3RhdGUocyA9PiBzLnZlcmJvc2UpXG4gKiBjb25zdCBtb2RlbCA9IHVzZUFwcFN0YXRlKHMgPT4gcy5tYWluTG9vcE1vZGVsKVxuICogYGBgXG4gKlxuICogRG8gTk9UIHJldHVybiBuZXcgb2JqZWN0cyBmcm9tIHRoZSBzZWxlY3RvciAtLSBPYmplY3QuaXMgd2lsbCBhbHdheXMgc2VlXG4gKiB0aGVtIGFzIGNoYW5nZWQuIEluc3RlYWQsIHNlbGVjdCBhbiBleGlzdGluZyBzdWItb2JqZWN0IHJlZmVyZW5jZTpcbiAqIGBgYFxuICogY29uc3QgeyB0ZXh0LCBwcm9tcHRJZCB9ID0gdXNlQXBwU3RhdGUocyA9PiBzLnByb21wdFN1Z2dlc3Rpb24pIC8vIGdvb2RcbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gdXNlQXBwU3RhdGU8VD4oc2VsZWN0b3I6IChzdGF0ZTogQXBwU3RhdGUpID0+IFQpOiBUIHtcbiAgY29uc3Qgc3RvcmUgPSB1c2VBcHBTdG9yZSgpXG5cbiAgY29uc3QgZ2V0ID0gKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gc3RvcmUuZ2V0U3RhdGUoKVxuICAgIGNvbnN0IHNlbGVjdGVkID0gc2VsZWN0b3Ioc3RhdGUpXG5cbiAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50JyAmJiBzdGF0ZSA9PT0gc2VsZWN0ZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFlvdXIgc2VsZWN0b3IgaW4gXFxgdXNlQXBwU3RhdGUoJHtzZWxlY3Rvci50b1N0cmluZygpfSlcXGAgcmV0dXJuZWQgdGhlIG9yaWdpbmFsIHN0YXRlLCB3aGljaCBpcyBub3QgYWxsb3dlZC4gWW91IG11c3QgaW5zdGVhZCByZXR1cm4gYSBwcm9wZXJ0eSBmb3Igb3B0aW1pc2VkIHJlbmRlcmluZy5gLFxuICAgICAgKVxuICAgIH1cblxuICAgIHJldHVybiBzZWxlY3RlZFxuICB9XG5cbiAgcmV0dXJuIHVzZVN5bmNFeHRlcm5hbFN0b3JlKHN0b3JlLnN1YnNjcmliZSwgZ2V0LCBnZXQpXG59XG5cbi8qKlxuICogR2V0IHRoZSBzZXRBcHBTdGF0ZSB1cGRhdGVyIHdpdGhvdXQgc3Vic2NyaWJpbmcgdG8gYW55IHN0YXRlLlxuICogUmV0dXJucyBhIHN0YWJsZSByZWZlcmVuY2UgdGhhdCBuZXZlciBjaGFuZ2VzIC0tIGNvbXBvbmVudHMgdXNpbmcgb25seVxuICogdGhpcyBob29rIHdpbGwgbmV2ZXIgcmUtcmVuZGVyIGZyb20gc3RhdGUgY2hhbmdlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVzZVNldEFwcFN0YXRlKCk6IChcbiAgdXBkYXRlcjogKHByZXY6IEFwcFN0YXRlKSA9PiBBcHBTdGF0ZSxcbikgPT4gdm9pZCB7XG4gIHJldHVybiB1c2VBcHBTdG9yZSgpLnNldFN0YXRlXG59XG5cbi8qKlxuICogR2V0IHRoZSBzdG9yZSBkaXJlY3RseSAoZm9yIHBhc3NpbmcgZ2V0U3RhdGUvc2V0U3RhdGUgdG8gbm9uLVJlYWN0IGNvZGUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXNlQXBwU3RhdGVTdG9yZSgpOiBBcHBTdGF0ZVN0b3JlIHtcbiAgcmV0dXJuIHVzZUFwcFN0b3JlKClcbn1cblxuY29uc3QgTk9PUF9TVUJTQ1JJQkUgPSAoKSA9PiAoKSA9PiB7fVxuXG4vKipcbiAqIFNhZmUgdmVyc2lvbiBvZiB1c2VBcHBTdGF0ZSB0aGF0IHJldHVybnMgdW5kZWZpbmVkIGlmIGNhbGxlZCBvdXRzaWRlIG9mIEFwcFN0YXRlUHJvdmlkZXIuXG4gKiBVc2VmdWwgZm9yIGNvbXBvbmVudHMgdGhhdCBtYXkgYmUgcmVuZGVyZWQgaW4gY29udGV4dHMgd2hlcmUgQXBwU3RhdGVQcm92aWRlciBpc24ndCBhdmFpbGFibGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1c2VBcHBTdGF0ZU1heWJlT3V0c2lkZU9mUHJvdmlkZXI8VD4oXG4gIHNlbGVjdG9yOiAoc3RhdGU6IEFwcFN0YXRlKSA9PiBULFxuKTogVCB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHN0b3JlID0gdXNlQ29udGV4dChBcHBTdG9yZUNvbnRleHQpXG4gIHJldHVybiB1c2VTeW5jRXh0ZXJuYWxTdG9yZShzdG9yZSA/IHN0b3JlLnN1YnNjcmliZSA6IE5PT1BfU1VCU0NSSUJFLCAoKSA9PlxuICAgIHN0b3JlID8gc2VsZWN0b3Ioc3RvcmUuZ2V0U3RhdGUoKSkgOiB1bmRlZmluZWQsXG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVNBLE9BQU8sUUFBUSxZQUFZO0FBQ3BDLE9BQU9DLEtBQUssSUFDVkMsVUFBVSxFQUNWQyxTQUFTLEVBQ1RDLGNBQWMsRUFDZEMsUUFBUSxFQUNSQyxvQkFBb0IsUUFDZixPQUFPO0FBQ2QsU0FBU0MsZUFBZSxRQUFRLHVCQUF1QjtBQUN2RCxTQUFTQyxpQkFBaUIsUUFBUSw2QkFB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
