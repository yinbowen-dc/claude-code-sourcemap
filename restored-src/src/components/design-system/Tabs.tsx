/**
 * Tabs.tsx — 标签页导航组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   设计系统（design-system）层 → UI 基础原语 → 多标签页容器
 *
 * 主要功能：
 *   1. Tabs：多标签页容器组件，支持受控模式（selectedTab/onTabChange）和
 *      非受控模式（内部 state），渲染标签头部行与内容区域。
 *   2. Tab：单个标签页内容组件，通过 TabsContext 判断是否为当前选中标签，
 *      仅渲染活跃标签内容。
 *   3. useTabsWidth：读取内容区域宽度（useFullWidth 模式下为终端宽度）。
 *   4. useTabHeaderFocus：子组件通过此 Hook 注册"焦点分离"特性，
 *      使 ↑ 返回标签头、↓ 进入内容区，支持复杂键盘导航场景。
 *
 * 键盘导航架构：
 *   - headerFocused=true 时：← / → / Tab 切换标签页（tabs:next/previous 绑定）
 *   - headerFocused=true 且有子组件 opt-in 时：↓ 将焦点移入内容区
 *   - navFromContent=true 且 headerFocused=false 时：允许从内容区直接切换标签
 *
 * 受控/非受控模式：
 *   - 传入 selectedTab（字符串）→ 受控模式，切换时调用 onTabChange 回调
 *   - 不传 selectedTab → 非受控模式，切换时更新内部 internalSelectedTab state
 */
import { c as _c } from "react/compiler-runtime";
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useIsInsideModal, useModalScrollRef } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import ScrollBox from '../../ink/components/ScrollBox.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text } from '../../ink.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { Theme } from '../../utils/theme.js';

// Tabs 组件的 Props 类型定义
type TabsProps = {
  children: Array<React.ReactElement<TabProps>>;  // Tab 子组件数组
  title?: string;              // 显示在标签行左侧的标题
  color?: keyof Theme;         // 当前标签的高亮颜色（主题键）
  defaultTab?: string;         // 非受控模式下的初始选中标签
  hidden?: boolean;            // 是否隐藏整个标签头部行
  useFullWidth?: boolean;      // 是否撑满终端宽度
  /** 受控模式：当前选中标签的 id 或 title */
  selectedTab?: string;
  /** 受控模式：切换标签时的回调 */
  onTabChange?: (tabId: string) => void;
  /** 可选 banner，显示在标签行与内容区之间 */
  banner?: React.ReactNode;
  /** 禁用键盘导航（当子组件已接管方向键时使用） */
  disableNavigation?: boolean;
  /**
   * 标签头部行的初始焦点状态。默认 true（头部有焦点，导航始终可用）。
   * 对于只使用上下键的 Select/列表内容无需修改；
   * 仅当内容实际绑定了左右/Tab 键（如枚举切换）时才设为 false，
   * 此时应在页脚展示"↑ tabs"提示，否则导航入口不可见。
   */
  initialHeaderFocused?: boolean;
  /**
   * 内容区的固定高度。设置后所有标签在同一高度内渲染（overflow hidden），
   * 切换标签不会引起布局偏移；较短内容留白，较高内容被裁剪。
   */
  contentHeight?: number;
  /**
   * 允许从内容区通过 Tab/←/→ 切换标签（opt-in，因为部分内容自用这些键）。
   * 传入响应式布尔值以便在需要时临时让出这些键。
   * 从内容切换会自动将焦点返回头部。
   */
  navFromContent?: boolean;
};

// TabsContext 的值类型：向 Tab/useTabsWidth/useTabHeaderFocus 暴露的信息
type TabsContextValue = {
  selectedTab: string | undefined;   // 当前选中标签的 id（传递给 Tab 组件判断显示/隐藏）
  width: number | undefined;         // 内容区宽度（useFullWidth 时为终端宽度）
  headerFocused: boolean;            // 当前头部行是否持有焦点
  focusHeader: () => void;           // 将焦点移回头部行
  blurHeader: () => void;            // 将焦点移入内容区
  registerOptIn: () => () => void;   // 注册"焦点分离"opt-in，返回取消注册的清理函数
};

// 创建 TabsContext，提供在 Tabs 组件外部使用时的安全默认值（测试/独立组件场景）
const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  width: undefined,
  // 组件树外部默认：内容区有焦点，focusHeader 为空操作
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
  registerOptIn: () => () => {}
});

/**
 * Tabs — 多标签页容器组件
 *
 * 整体流程：
 *   1. 从 children 提取 [id, title] 对（_temp 辅助函数）
 *   2. 计算当前选中索引（受控/非受控双模式）
 *   3. 管理 headerFocused 状态、focusHeader/blurHeader 回调
 *   4. 管理 optInCount（已注册焦点分离的子组件数量）
 *   5. 注册两套键盘绑定：
 *      a. 头部焦点模式（headerFocused=true）：← / → 切换标签
 *      b. 内容焦点模式（navFromContent=true）：从内容区切换并返回头部焦点
 *   6. 监听 onKeyDown 的 ↓ 键：headerFocused 且有 optIn 时，将焦点移入内容区
 *   7. 计算 spacerWidth（useFullWidth 模式下填满终端剩余宽度）
 *   8. 渲染：TabsContext.Provider > Box > [头部行] [banner] [内容区]
 *
 * React Compiler 记忆化（_c(25)，共 25 个缓存槽）：
 *   根据 props 和内部 state 细粒度缓存各段 JSX 和回调函数，避免不必要的子树重渲染。
 */
export function Tabs(t0) {
  // 初始化大小为 25 的 React 编译器记忆缓存槽数组
  const $ = _c(25);
  const {
    title,
    color,
    defaultTab,
    children,
    hidden,
    useFullWidth,
    selectedTab: controlledSelectedTab, // 受控模式传入的选中标签值
    onTabChange,
    banner,
    disableNavigation,
    initialHeaderFocused: t1,           // 头部焦点初始值（默认 true）
    contentHeight,
    navFromContent: t2                  // 是否允许内容区导航（默认 false）
  } = t0;
  // 应用 initialHeaderFocused 默认值 true
  const initialHeaderFocused = t1 === undefined ? true : t1;
  // 应用 navFromContent 默认值 false
  const navFromContent = t2 === undefined ? false : t2;

  // 获取终端列数（用于 useFullWidth 模式计算宽度）
  const {
    columns: terminalWidth
  } = useTerminalSize();

  // 从 children 提取 [id, title] 对：id 优先使用 props.id，否则 fallback 到 props.title
  const tabs = children.map(_temp);

  // 计算默认标签索引：若指定了 defaultTab 则查找，否则默认第 0 个
  const defaultTabIndex = defaultTab ? tabs.findIndex(tab => defaultTab === tab[0]) : 0;

  // 判断是否为受控模式
  const isControlled = controlledSelectedTab !== undefined;

  // 非受控模式内部状态：当前选中标签的索引
  const [internalSelectedTab, setInternalSelectedTab] = useState(defaultTabIndex !== -1 ? defaultTabIndex : 0);

  // 受控模式：通过 id 查找当前选中索引
  const controlledTabIndex = isControlled ? tabs.findIndex(tab_0 => tab_0[0] === controlledSelectedTab) : -1;

  // 最终使用的选中索引：受控时用 controlledTabIndex（未找到时 fallback 0），非受控时用 internalSelectedTab
  const selectedTabIndex = isControlled ? controlledTabIndex !== -1 ? controlledTabIndex : 0 : internalSelectedTab;

  // 获取 Modal 滚动 ref（在 Modal 内部时需要特殊处理内容区滚动）
  const modalScrollRef = useModalScrollRef();

  // 头部焦点状态（true=头部有焦点，可切换标签；false=内容区有焦点）
  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused);

  // focusHeader：将焦点移回头部行（使用 React Compiler 缓存，无依赖，永不变）
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建并缓存 focusHeader 回调
    t3 = () => setHeaderFocused(true);
    $[0] = t3;
  } else {
    t3 = $[0];
  }
  const focusHeader = t3;

  // blurHeader：将焦点移入内容区（同样永久缓存）
  let t4;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建并缓存 blurHeader 回调
    t4 = () => setHeaderFocused(false);
    $[1] = t4;
  } else {
    t4 = $[1];
  }
  const blurHeader = t4;

  // optInCount：已通过 useTabHeaderFocus 注册"焦点分离"特性的子组件数量
  const [optInCount, setOptInCount] = useState(0);

  // registerOptIn：供 useTabHeaderFocus 调用，计数 +1 并返回清理函数（-1）
  let t5;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建并缓存 registerOptIn 回调（依赖 setOptInCount，引用稳定）
    t5 = () => {
      setOptInCount(_temp2);       // 使用辅助函数将计数 +1
      return () => setOptInCount(_temp3); // 清理函数：将计数 -1
    };
    $[2] = t5;
  } else {
    t5 = $[2];
  }
  const registerOptIn = t5;

  // optedIn：是否有任何子组件已注册焦点分离（决定 ↓ 键是否生效）
  const optedIn = optInCount > 0;

  /**
   * handleTabChange — 切换标签页
   * @param offset  偏移量：+1 下一个，-1 上一个（环形切换）
   *
   * 流程：
   *   1. 用模运算计算新索引（支持循环）
   *   2. 受控模式：调用 onTabChange 通知父组件；非受控：更新内部 state
   *   3. 切换后将焦点设回头部（保持在头部以便连续切换）
   */
  const handleTabChange = offset => {
    // 环形索引计算：加上 tabs.length 防止负数取模
    const newIndex = (selectedTabIndex + tabs.length + offset) % tabs.length;
    const newTabId = tabs[newIndex]?.[0];

    if (isControlled && onTabChange && newTabId) {
      // 受控模式：通知外部切换
      onTabChange(newTabId);
    } else {
      // 非受控模式：更新内部选中索引
      setInternalSelectedTab(newIndex);
    }
    // 切换后回到头部焦点，以便用户可继续切换标签
    setHeaderFocused(true);
  };

  // 计算头部焦点导航的 isActive：未隐藏 && 未禁用导航 && 头部有焦点
  const t6 = !hidden && !disableNavigation && headerFocused;
  let t7;
  if ($[3] !== t6) {
    // isActive 变化时重新创建 options 对象
    t7 = {
      context: "Tabs",
      isActive: t6
    };
    $[3] = t6;
    $[4] = t7;
  } else {
    t7 = $[4];
  }
  // 注册头部焦点模式下的 tabs:next / tabs:previous 键绑定
  useKeybindings({
    "tabs:next": () => handleTabChange(1),     // Tab / → 切换到下一个标签
    "tabs:previous": () => handleTabChange(-1) // Shift+Tab / ← 切换到上一个标签
  }, t7);

  // handleKeyDown：处理 ↓ 键（头部焦点 + 有 optIn 时，将焦点移入内容区）
  let t8;
  if ($[5] !== headerFocused || $[6] !== hidden || $[7] !== optedIn) {
    // 依赖的任一值变化时重新创建处理器
    t8 = e => {
      // 头部无焦点、无 optIn 子组件、或已隐藏时忽略
      if (!headerFocused || !optedIn || hidden) {
        return;
      }
      if (e.key === "down") {
        e.preventDefault();
        // ↓ 键：将焦点从头部移入内容区
        setHeaderFocused(false);
      }
    };
    $[5] = headerFocused;
    $[6] = hidden;
    $[7] = optedIn;
    $[8] = t8;
  } else {
    t8 = $[8];
  }
  const handleKeyDown = t8;

  // 计算内容区导航的 isActive：允许从内容区切换 && 头部无焦点 && 有 optIn && 未隐藏 && 未禁用
  const t9 = navFromContent && !headerFocused && optedIn && !hidden && !disableNavigation;
  let t10;
  if ($[9] !== t9) {
    // isActive 变化时重新创建 options 对象
    t10 = {
      context: "Tabs",
      isActive: t9
    };
    $[9] = t9;
    $[10] = t10;
  } else {
    t10 = $[10];
  }
  // 注册内容区焦点模式下的 tabs:next / tabs:previous 键绑定（切换后将焦点返回头部）
  useKeybindings({
    "tabs:next": () => {
      handleTabChange(1);
      setHeaderFocused(true); // 切换后焦点回到头部，后续按键走头部模式
    },
    "tabs:previous": () => {
      handleTabChange(-1);
      setHeaderFocused(true); // 同上
    }
  }, t10);

  // 计算标题宽度（+1 是为 gap 留位）
  const titleWidth = title ? stringWidth(title) + 1 : 0;
  // 计算所有标签的宽度之和（每个标签：文字宽度 + 2 padding + 1 gap）
  const tabsWidth = tabs.reduce(_temp4, 0);
  const usedWidth = titleWidth + tabsWidth;
  // 计算填充剩余宽度的 spacer 宽度（仅 useFullWidth 时有效）
  const spacerWidth = useFullWidth ? Math.max(0, terminalWidth - usedWidth) : 0;
  // 内容区宽度（useFullWidth 时为终端宽度，否则 undefined 让 Ink 自动布局）
  const contentWidth = useFullWidth ? terminalWidth : undefined;

  // 创建外层 Box 组件引用（React Compiler 提取为变量以便细粒度缓存）
  const T0 = Box;
  const t11 = "column";     // flexDirection
  const t12 = 0;            // tabIndex（使 Box 可聚焦）
  const t13 = true;         // autoFocus
  // Modal 内部需要 flexShrink=0 防止布局收缩问题（见 #23592）
  const t14 = modalScrollRef ? 0 : undefined;

  // 标签头部行（hidden=true 时不渲染）
  const t15 = !hidden && <Box flexDirection="row" gap={1} flexShrink={modalScrollRef ? 0 : undefined}>{title !== undefined && <Text bold={true} color={color}>{title}</Text>}{tabs.map((t16, i) => {
      const [id, title_0] = t16;
      const isCurrent = selectedTabIndex === i;
      // 当有颜色且当前标签被选中且头部有焦点时，使用彩色光标样式
      const hasColorCursor = color && isCurrent && headerFocused;
      return <Text key={id} backgroundColor={hasColorCursor ? color : undefined} color={hasColorCursor ? "inverseText" : undefined} inverse={isCurrent && !hasColorCursor} bold={isCurrent}>{" "}{title_0}{" "}</Text>;
    })}{spacerWidth > 0 && <Text>{" ".repeat(spacerWidth)}</Text>}</Box>;

  // 内容区：Modal 内部使用 ScrollBox（支持滚动），否则使用普通 Box
  let t17;
  if ($[11] !== children || $[12] !== contentHeight || $[13] !== contentWidth || $[14] !== hidden || $[15] !== modalScrollRef || $[16] !== selectedTabIndex) {
    // 任一依赖变化时重新创建内容区 JSX
    t17 = modalScrollRef ? (
      // Modal 内：使用 ScrollBox，key 为 selectedTabIndex 以便切换标签时重置滚动位置
      <Box width={contentWidth} marginTop={hidden ? 0 : 1} flexShrink={0}><ScrollBox key={selectedTabIndex} ref={modalScrollRef} flexDirection="column" flexShrink={0}>{children}</ScrollBox></Box>
    ) : (
      // 普通模式：可选固定高度（overflow hidden）
      <Box width={contentWidth} marginTop={hidden ? 0 : 1} height={contentHeight} overflowY={contentHeight !== undefined ? "hidden" : undefined}>{children}</Box>
    );
    $[11] = children;
    $[12] = contentHeight;
    $[13] = contentWidth;
    $[14] = hidden;
    $[15] = modalScrollRef;
    $[16] = selectedTabIndex;
    $[17] = t17;
  } else {
    t17 = $[17];
  }

  // 组合最终 JSX：若任一外层 prop 变化则重新创建
  let t18;
  if ($[18] !== T0 || $[19] !== banner || $[20] !== handleKeyDown || $[21] !== t14 || $[22] !== t15 || $[23] !== t17) {
    t18 = <T0 flexDirection={t11} tabIndex={t12} autoFocus={t13} onKeyDown={handleKeyDown} flexShrink={t14}>{t15}{banner}{t17}</T0>;
    $[18] = T0;
    $[19] = banner;
    $[20] = handleKeyDown;
    $[21] = t14;
    $[22] = t15;
    $[23] = t17;
    $[24] = t18;
  } else {
    t18 = $[24];
  }

  // 通过 TabsContext.Provider 将选中标签、宽度、焦点状态和操作函数传递给子树
  return <TabsContext.Provider value={{
    selectedTab: tabs[selectedTabIndex][0], // 当前选中标签的 id
    width: contentWidth,
    headerFocused,
    focusHeader,
    blurHeader,
    registerOptIn
  }}>{t18}</TabsContext.Provider>;
}

/**
 * _temp4 — reduce 辅助函数：累加所有标签的显示宽度
 * 每个标签宽度 = 文字宽度 + 2（左右各一个空格 padding）+ 1（gap）
 */
function _temp4(sum, t0) {
  const [, tabTitle] = t0;
  return sum + (tabTitle ? stringWidth(tabTitle) : 0) + 2 + 1;
}

/**
 * _temp3 — setState 辅助函数：将 optInCount 减 1（useTabHeaderFocus 卸载时调用）
 */
function _temp3(n_0) {
  return n_0 - 1;
}

/**
 * _temp2 — setState 辅助函数：将 optInCount 加 1（useTabHeaderFocus 挂载时调用）
 */
function _temp2(n) {
  return n + 1;
}

/**
 * _temp — map 辅助函数：从 Tab 子组件中提取 [id, title]
 * id 优先使用 props.id，否则 fallback 到 props.title（两者一致时可省略 id）
 */
function _temp(child) {
  return [child.props.id ?? child.props.title, child.props.title];
}

// Tab 组件的 Props 类型定义
type TabProps = {
  title: string;                 // 显示在标签头部的标题文本
  id?: string;                   // 可选标签 id（不传时以 title 作为 id）
  children: React.ReactNode;     // 标签页内容
};

/**
 * Tab — 单个标签页内容组件
 *
 * 整体流程：
 *   1. 通过 TabsContext 读取当前选中标签 id 和内容区宽度
 *   2. 判断当前 Tab 的 id（优先）或 title 是否等于 selectedTab
 *   3. 不匹配：返回 null（不渲染）
 *   4. 匹配：渲染 Box 包裹的子内容（Modal 内部 flexShrink=0，防止内容被压缩）
 *
 * React Compiler 记忆化（_c(4)，共 4 个缓存槽）：
 *   仅当 children、flexShrink 或 width 变化时重新创建 JSX。
 */
export function Tab(t0) {
  // 初始化大小为 4 的记忆缓存槽
  const $ = _c(4);
  const {
    title,
    id,
    children
  } = t0;
  // 从 TabsContext 读取当前选中标签 id 和内容区宽度
  const {
    selectedTab,
    width
  } = useContext(TabsContext);
  // 检测当前是否处于 Modal 内部（影响 flexShrink 设置）
  const insideModal = useIsInsideModal();
  // 若当前标签不是选中状态，直接返回 null（不渲染）
  if (selectedTab !== (id ?? title)) {
    return null;
  }
  // Modal 内部需要 flexShrink=0，避免内容区被压缩
  const t1 = insideModal ? 0 : undefined;
  let t2;
  if ($[0] !== children || $[1] !== t1 || $[2] !== width) {
    // 依赖变化时重新创建 JSX
    t2 = <Box width={width} flexShrink={t1}>{children}</Box>;
    $[0] = children;
    $[1] = t1;
    $[2] = width;
    $[3] = t2;
  } else {
    // 缓存命中：复用上次渲染结果
    t2 = $[3];
  }
  return t2;
}

/**
 * useTabsWidth — 读取当前 Tabs 内容区宽度
 *
 * 整体流程：
 *   直接从 TabsContext 取出 width 并返回。
 *   useFullWidth=true 时为终端列数，否则为 undefined。
 *
 * 在系统中的作用：
 *   内容组件需要与 Tabs 宽度对齐时（如进度条）通过此 Hook 获取准确宽度。
 */
export function useTabsWidth() {
  const {
    width
  } = useContext(TabsContext);
  return width;
}

/**
 * useTabHeaderFocus — 注册焦点分离特性，获取头部焦点状态和操作函数
 *
 * 整体流程：
 *   1. 从 TabsContext 读取 headerFocused、focusHeader、blurHeader、registerOptIn
 *   2. useEffect 在挂载时调用 registerOptIn()，增加 optInCount；
 *      卸载时调用返回的清理函数，减少 optInCount。
 *      deps 为 [registerOptIn]，因其引用稳定（由 React Compiler 缓存），effect 只执行一次。
 *   3. React Compiler 记忆化（_c(6)）：仅当三个输出值变化时重新构建返回对象。
 *   4. 返回 { headerFocused, focusHeader, blurHeader }
 *
 * 使用方式示例：
 *   const { headerFocused, focusHeader } = useTabHeaderFocus()
 *   // 在 Select 上：isDisabled={headerFocused}，onUpFromFirstItem={focusHeader}
 *
 * 注意事项：
 *   不要在早返回（返回静态内容）的分支之上调用此 Hook，
 *   否则 ↓ 键会将焦点移入内容区但没有 focusHeader 出口。
 *   应将 Hook 所在组件拆分，使其只在 Select 渲染时执行。
 */
export function useTabHeaderFocus() {
  // 初始化大小为 6 的记忆缓存槽
  const $ = _c(6);
  const {
    headerFocused,
    focusHeader,
    blurHeader,
    registerOptIn
  } = useContext(TabsContext);

  // 构建 deps 数组（缓存：仅 registerOptIn 变化时重建）
  let t0;
  if ($[0] !== registerOptIn) {
    t0 = [registerOptIn];
    $[0] = registerOptIn;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  // 挂载时注册 opt-in（registerOptIn 返回卸载时的清理函数）
  useEffect(registerOptIn, t0);

  // 构建返回对象（缓存：仅三值变化时重建，避免引用变动导致消费方重渲染）
  let t1;
  if ($[2] !== blurHeader || $[3] !== focusHeader || $[4] !== headerFocused) {
    t1 = {
      headerFocused,
      focusHeader,
      blurHeader
    };
    $[2] = blurHeader;
    $[3] = focusHeader;
    $[4] = headerFocused;
    $[5] = t1;
  } else {
    // 缓存命中：返回同一对象引用
    t1 = $[5];
  }
  return t1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsImNyZWF0ZUNvbnRleHQiLCJ1c2VDYWxsYmFjayIsInVzZUNvbnRleHQiLCJ1c2VFZmZlY3QiLCJ1c2VTdGF0ZSIsInVzZUlzSW5zaWRlTW9kYWwiLCJ1c2VNb2RhbFNjcm9sbFJlZiIsInVzZVRlcm1pbmFsU2l6ZSIsIlNjcm9sbEJveCIsIktleWJvYXJkRXZlbnQiLCJzdHJpbmdXaWR0aCIsIkJveCIsIlRleHQiLCJ1c2VLZXliaW5kaW5ncyIsIlRoZW1lIiwiVGFic1Byb3BzIiwiY2hpbGRyZW4iLCJBcnJheSIsIlJlYWN0RWxlbWVudCIsIlRhYlByb3BzIiwidGl0bGUiLCJjb2xvciIsImRlZmF1bHRUYWIiLCJoaWRkZW4iLCJ1c2VGdWxsV2lkdGgiLCJzZWxlY3RlZFRhYiIsIm9uVGFiQ2hhbmdlIiwidGFiSWQiLCJiYW5uZXIiLCJSZWFjdE5vZGUiLCJkaXNhYmxlTmF2aWdhdGlvbiIsImluaXRpYWxIZWFkZXJGb2N1c2VkIiwiY29udGVudEhlaWdodCIsIm5hdkZyb21Db250ZW50IiwiVGFic0NvbnRleHRWYWx1ZSIsIndpZHRoIiwiaGVhZGVyRm9jdXNlZCIsImZvY3VzSGVhZGVyIiwiYmx1ckhlYWRlciIsInJlZ2lzdGVyT3B0SW4iLCJUYWJzQ29udGV4dCIsInVuZGVmaW5lZCIsIlRhYnMiLCJ0MCIsIiQiLCJfYyIsImNvbnRyb2xsZWRTZWxlY3RlZFRhYiIsInQxIiwidDIiLCJjb2x1bW5zIiwidGVybWluYWxXaWR0aCIsInRhYnMiLCJtYXAiLCJfdGVtcCIsImRlZmF1bHRUYWJJbmRleCIsImZpbmRJbmRleCIsInRhYiIsImlzQ29udHJvbGxlZCIsImludGVybmFsU2VsZWN0ZWRUYWIiLCJzZXRJbnRlcm5hbFNlbGVjdGVkVGFiIiwiY29udHJvbGxlZFRhYkluZGV4IiwidGFiXzAiLCJzZWxlY3RlZFRhYkluZGV4IiwibW9kYWxTY3JvbGxSZWYiLCJzZXRIZWFkZXJGb2N1c2VkIiwidDMiLCJTeW1ib2wiLCJmb3IiLCJ0NCIsIm9wdEluQ291bnQiLCJzZXRPcHRJbkNvdW50IiwidDUiLCJfdGVtcDIiLCJfdGVtcDMiLCJvcHRlZEluIiwiaGFuZGxlVGFiQ2hhbmdlIiwib2Zmc2V0IiwibmV3SW5kZXgiLCJsZW5ndGgiLCJuZXdUYWJJZCIsInQ2IiwidDciLCJjb250ZXh0IiwiaXNBY3RpdmUiLCJ0YWJzOm5leHQiLCJ0YWJzOnByZXZpb3VzIiwidDgiLCJlIiwia2V5IiwicHJldmVudERlZmF1bHQiLCJoYW5kbGVLZXlEb3duIiwidDkiLCJ0MTAiLCJ0aXRsZVdpZHRoIiwidGFic1dpZHRoIiwicmVkdWNlIiwiX3RlbXA0IiwidXNlZFdpZHRoIiwic3BhY2VyV2lkdGgiLCJNYXRoIiwibWF4IiwiY29udGVudFdpZHRoIiwiVDAiLCJ0MTEiLCJ0MTIiLCJ0MTMiLCJ0MTQiLCJ0MTUiLCJ0MTYiLCJpIiwiaWQiLCJ0aXRsZV8wIiwiaXNDdXJyZW50IiwiaGFzQ29sb3JDdXJzb3IiLCJyZXBlYXQiLCJ0MTciLCJ0MTgiLCJzdW0iLCJ0YWJUaXRsZSIsIm5fMCIsIm4iLCJjaGlsZCIsInByb3BzIiwiVGFiIiwiaW5zaWRlTW9kYWwiLCJ1c2VUYWJzV2lkdGgiLCJ1c2VUYWJIZWFkZXJGb2N1cyJdLCJzb3VyY2VzIjpbIlRhYnMudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwge1xuICBjcmVhdGVDb250ZXh0LFxuICB1c2VDYWxsYmFjayxcbiAgdXNlQ29udGV4dCxcbiAgdXNlRWZmZWN0LFxuICB1c2VTdGF0ZSxcbn0gZnJvbSAncmVhY3QnXG5pbXBvcnQge1xuICB1c2VJc0luc2lkZU1vZGFsLFxuICB1c2VNb2RhbFNjcm9sbFJlZixcbn0gZnJvbSAnLi4vLi4vY29udGV4dC9tb2RhbENvbnRleHQuanMnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICcuLi8uLi9ob29rcy91c2VUZXJtaW5hbFNpemUuanMnXG5pbXBvcnQgU2Nyb2xsQm94IGZyb20gJy4uLy4uL2luay9jb21wb25lbnRzL1Njcm9sbEJveC5qcydcbmltcG9ydCB0eXBlIHsgS2V5Ym9hcmRFdmVudCB9IGZyb20gJy4uLy4uL2luay9ldmVudHMva2V5Ym9hcmQtZXZlbnQuanMnXG5pbXBvcnQgeyBzdHJpbmdXaWR0aCB9IGZyb20gJy4uLy4uL2luay9zdHJpbmdXaWR0aC5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUtleWJpbmRpbmdzIH0gZnJvbSAnLi4vLi4va2V5YmluZGluZ3MvdXNlS2V5YmluZGluZy5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbiJdLCJtYXBwaW5ncyI6IiIsImlnbm9yZUxpc3QiOltdfQ==
