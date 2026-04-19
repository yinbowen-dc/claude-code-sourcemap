/**
 * HelpV2/HelpV2.tsx
 *
 * 在 Claude Code 系统流中的位置：
 * 本文件是帮助对话框的顶层容器组件，通过 `/help` 斜杠命令触发，
 * 也可在其他场景（如 Modal 槽位）中嵌入显示。
 *
 * 主要功能：
 * 1. 读取终端尺寸（行/列），计算最大可用高度；若在 Modal 内则不限制高度
 * 2. 注册 help:dismiss 快捷键，支持 Ctrl+C/D 退出
 * 3. 将命令列表按类型分组：内置命令（builtinCommands）、自定义命令（customCommands）
 *    以及内部专用命令（antOnlyCommands，外部构建版本始终为空数组）
 * 4. 以 Tabs 组件组织三个选项卡：general / commands / custom-commands
 * 5. 在底部展示文档链接和快捷键提示（支持二次确认退出提示）
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js';
import { builtInCommandNames, type Command, type CommandResultDisplay, INTERNAL_ONLY_COMMANDS } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Link, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { Pane } from '../design-system/Pane.js';
import { Tab, Tabs } from '../design-system/Tabs.js';
import { Commands } from './Commands.js';
import { General } from './General.js';

// Props 类型：关闭回调 + 命令列表
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};

/**
 * HelpV2 组件
 *
 * 整体流程：
 * 1. 通过 useTerminalSize() 获取终端行列数，计算最大高度为行数的一半。
 * 2. 通过 useIsInsideModal() 判断是否在 Modal 槽位内：
 *    - Modal 内：不设置 height 约束，由 FullscreenLayout 管理大小
 *    - 独立展示：设置 height={maxHeight} 防止溢出屏幕
 * 3. 构建 close 函数，关闭时传递 "Help dialog dismissed" 消息（display: "system"）。
 * 4. 注册 help:dismiss 快捷键（上下文为 "Help"），注册 Ctrl+C/D 退出处理。
 * 5. 按 builtInCommandNames() 将命令集分为内置/自定义两组（外部构建版本忽略内部专用命令）。
 * 6. 构建 tabs 数组：general（静态内容）、commands（内置命令浏览）、custom-commands（自定义命令浏览）。
 * 7. 渲染：Box > Pane > Tabs + 文档链接 + 底部提示文字。
 */
export function HelpV2(t0) {
  // React 编译器运行时：分配 44 个缓存槽位
  const $ = _c(44);
  const {
    onClose,
    commands
  } = t0;

  // 获取终端尺寸
  const {
    rows,
    columns
  } = useTerminalSize();

  // 最大显示高度：终端行数的一半
  const maxHeight = Math.floor(rows / 2);

  // 是否在 Modal 槽位内渲染
  const insideModal = useIsInsideModal();

  let t1;
  // 记忆化 close 函数：onClose 变化时重新创建
  if ($[0] !== onClose) {
    t1 = () => onClose("Help dialog dismissed", {
      display: "system" // 以 system 消息形式关闭，不显示在对话历史中
    });
    $[0] = onClose;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const close = t1;

  let t2;
  // 缓存静态 keybinding 配置对象（context 固定为 "Help"）
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Help" // 限定快捷键作用域为 Help 对话框
    };
    $[2] = t2;
  } else {
    t2 = $[2];
  }

  // 注册 help:dismiss 快捷键（通常为 Esc），激活时调用 close
  useKeybinding("help:dismiss", close, t2);

  // 注册 Ctrl+C/D 退出处理（需二次确认），返回退出状态
  const exitState = useExitOnCtrlCDWithKeybindings(close);

  // 获取 help:dismiss 快捷键的显示文本（回退为 "esc"）
  const dismissShortcut = useShortcutDisplay("help:dismiss", "Help", "esc");

  let antOnlyCommands;
  let builtinCommands;
  let t3;

  // 记忆化命令分组：仅当 commands 变化时重新分组
  if ($[3] !== commands) {
    const builtinNames = builtInCommandNames(); // 获取内置命令名称集合

    // 内置命令：名称在内置集合内且未被隐藏
    builtinCommands = commands.filter(cmd => builtinNames.has(cmd.name) && !cmd.isHidden);

    let t4;
    // antOnlyCommands 在外部构建版本中始终为空数组（静态缓存）
    if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = [];
      $[7] = t4;
    } else {
      t4 = $[7];
    }
    antOnlyCommands = t4;

    // 自定义命令：名称不在内置集合且未被隐藏
    t3 = commands.filter(cmd_2 => !builtinNames.has(cmd_2.name) && !cmd_2.isHidden);
    $[3] = commands;
    $[4] = antOnlyCommands;
    $[5] = builtinCommands;
    $[6] = t3;
  } else {
    antOnlyCommands = $[4];
    builtinCommands = $[5];
    t3 = $[6];
  }
  const customCommands = t3;

  let t4;
  // General 选项卡完全静态，永久缓存
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Tab key="general" title="general"><General /></Tab>;
    $[8] = t4;
  } else {
    t4 = $[8];
  }

  let tabs;
  // 构建选项卡数组：任何影响选项卡内容的参数变化时重新构建
  if ($[9] !== antOnlyCommands || $[10] !== builtinCommands || $[11] !== close || $[12] !== columns || $[13] !== customCommands || $[14] !== maxHeight) {
    tabs = [t4]; // 始终包含 General 选项卡

    let t5;
    // 内置命令选项卡（commands）
    if ($[16] !== builtinCommands || $[17] !== close || $[18] !== columns || $[19] !== maxHeight) {
      t5 = (
        <Tab key="commands" title="commands">
          <Commands
            commands={builtinCommands}
            maxHeight={maxHeight}
            columns={columns}
            title="Browse default commands:"
            onCancel={close}
          />
        </Tab>
      );
      $[16] = builtinCommands;
      $[17] = close;
      $[18] = columns;
      $[19] = maxHeight;
      $[20] = t5;
    } else {
      t5 = $[20];
    }
    tabs.push(t5);

    let t6;
    // 自定义命令选项卡（custom-commands），列表为空时显示提示文字
    if ($[21] !== close || $[22] !== columns || $[23] !== customCommands || $[24] !== maxHeight) {
      t6 = (
        <Tab key="custom" title="custom-commands">
          <Commands
            commands={customCommands}
            maxHeight={maxHeight}
            columns={columns}
            title="Browse custom commands:"
            emptyMessage="No custom commands found" // 无自定义命令时的空状态提示
            onCancel={close}
          />
        </Tab>
      );
      $[21] = close;
      $[22] = columns;
      $[23] = customCommands;
      $[24] = maxHeight;
      $[25] = t6;
    } else {
      t6 = $[25];
    }
    tabs.push(t6);

    // 内部专用命令选项卡（ant-only）：外部构建版本中 false 条件永不执行，已通过 tree-shaking 消除
    if (false && antOnlyCommands.length > 0) {
      let t7;
      if ($[26] !== antOnlyCommands || $[27] !== close || $[28] !== columns || $[29] !== maxHeight) {
        t7 = (
          <Tab key="ant-only" title="[ant-only]">
            <Commands
              commands={antOnlyCommands}
              maxHeight={maxHeight}
              columns={columns}
              title="Browse ant-only commands:"
              onCancel={close}
            />
          </Tab>
        );
        $[26] = antOnlyCommands;
        $[27] = close;
        $[28] = columns;
        $[29] = maxHeight;
        $[30] = t7;
      } else {
        t7 = $[30];
      }
      tabs.push(t7);
    }

    $[9] = antOnlyCommands;
    $[10] = builtinCommands;
    $[11] = close;
    $[12] = columns;
    $[13] = customCommands;
    $[14] = maxHeight;
    $[15] = tabs;
  } else {
    tabs = $[15]; // 命中缓存，复用上次选项卡数组
  }

  // Modal 内不限高度，独立展示时限制为 maxHeight（行数一半）
  const t5 = insideModal ? undefined : maxHeight;

  let t6;
  // 记忆化 Tabs 组件（标题使用版本号，颜色为 professionalBlue）
  if ($[31] !== tabs) {
    t6 = (
      <Tabs
        title={false ? "/help" : `Claude Code v${MACRO.VERSION}`} // 外部构建显示版本号
        color="professionalBlue"
        defaultTab="general"
      >
        {tabs}
      </Tabs>
    );
    $[31] = tabs;
    $[32] = t6;
  } else {
    t6 = $[32];
  }

  let t7;
  // 文档链接（完全静态，永久缓存）
  if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = (
      <Box marginTop={1}>
        <Text>For more help:{" "}<Link url="https://code.claude.com/docs/en/overview" /></Text>
      </Box>
    );
    $[33] = t7;
  } else {
    t7 = $[33];
  }

  let t8;
  // 底部提示文字：等待二次确认时提示"再按一次退出"，否则提示快捷键取消
  if ($[34] !== dismissShortcut || $[35] !== exitState.keyName || $[36] !== exitState.pending) {
    t8 = (
      <Box marginTop={1}>
        <Text dimColor={true}>
          {exitState.pending
            ? <>Press {exitState.keyName} again to exit</> // 等待二次确认退出
            : <Text italic={true}>{dismissShortcut} to cancel</Text> // 正常状态：显示关闭快捷键
          }
        </Text>
      </Box>
    );
    $[34] = dismissShortcut;
    $[35] = exitState.keyName;
    $[36] = exitState.pending;
    $[37] = t8;
  } else {
    t8 = $[37];
  }

  let t9;
  // 记忆化 Pane 内容（Tabs + 链接 + 提示）
  if ($[38] !== t6 || $[39] !== t8) {
    t9 = (
      <Pane color="professionalBlue">
        {t6}  {/* Tabs 选项卡区域 */}
        {t7}  {/* 文档链接 */}
        {t8}  {/* 底部退出提示 */}
      </Pane>
    );
    $[38] = t6;
    $[39] = t8;
    $[40] = t9;
  } else {
    t9 = $[40];
  }

  let t10;
  // 最外层 Box：Modal 内不限高度，独立时限制高度
  if ($[41] !== t5 || $[42] !== t9) {
    t10 = <Box flexDirection="column" height={t5}>{t9}</Box>;
    $[41] = t5;
    $[42] = t9;
    $[43] = t10;
  } else {
    t10 = $[43];
  }
  return t10;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncyIsInVzZVNob3J0Y3V0RGlzcGxheSIsImJ1aWx0SW5Db21tYW5kTmFtZXMiLCJDb21tYW5kIiwiQ29tbWFuZFJlc3VsdERpc3BsYXkiLCJJTlRFUk5BTF9PTkxZX0NPTU1BTkRTIiwidXNlSXNJbnNpZGVNb2RhbCIsInVzZVRlcm1pbmFsU2l6ZSIsIkJveCIsIkxpbmsiLCJUZXh0IiwidXNlS2V5YmluZGluZyIsIlBhbmUiLCJUYWIiLCJUYWJzIiwiQ29tbWFuZHMiLCJHZW5lcmFsIiwiUHJvcHMiLCJvbkNsb3NlIiwicmVzdWx0Iiwib3B0aW9ucyIsImRpc3BsYXkiLCJjb21tYW5kcyIsIkhlbHBWMiIsInQwIiwiJCIsIl9jIiwicm93cyIsImNvbHVtbnMiLCJtYXhIZWlnaHQiLCJNYXRoIiwiZmxvb3IiLCJpbnNpZGVNb2RhbCIsInQxIiwiY2xvc2UiLCJ0MiIsIlN5bWJvbCIsImZvciIsImNvbnRleHQiLCJleGl0U3RhdGUiLCJkaXNtaXNzU2hvcnRjdXQiLCJhbnRPbmx5Q29tbWFuZHMiLCJidWlsdGluQ29tbWFuZHMiLCJ0MyIsImJ1aWx0aW5OYW1lcyIsImZpbHRlciIsImNtZCIsImhhcyIsIm5hbWUiLCJpc0hpZGRlbiIsInQ0IiwiY21kXzIiLCJjdXN0b21Db21tYW5kcyIsInRhYnMiLCJ0NSIsInB1c2giLCJ0NiIsImxlbmd0aCIsInQ3IiwidW5kZWZpbmVkIiwiTUFDUk8iLCJWRVJTSU9OIiwidDgiLCJrZXlOYW1lIiwicGVuZGluZyIsInQ5IiwidDEwIl0sInNvdXJjZXMiOlsiSGVscFYyLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncyB9IGZyb20gJ3NyYy9ob29rcy91c2VFeGl0T25DdHJsQ0RXaXRoS2V5YmluZGluZ3MuanMnXG5pbXBvcnQgeyB1c2VTaG9ydGN1dERpc3BsYXkgfSBmcm9tICdzcmMva2V5YmluZGluZ3MvdXNlU2hvcnRjdXREaXNwbGF5LmpzJ1xuaW1wb3J0IHtcbiAgYnVpbHRJbkNvbW1hbmROYW1lcyxcbiAgdHlwZSBDb21tYW5kLFxuICB0eXBlIENvbW1hbmRSZXN1bHREaXNwbGF5LFxuICBJTlRFUk5BTF9PTkxZX0NPTU1BTkRTLFxufSBmcm9tICcuLi8uLi9jb21tYW5kcy5qcydcbmltcG9ydCB7IHVzZUlzSW5zaWRlTW9kYWwgfSBmcm9tICcuLi8uLi9jb250ZXh0L21vZGFsQ29udGV4dC5qcydcbmltcG9ydCB7IHVzZVRlcm1pbmFsU2l6ZSB9IGZyb20gJy4uLy4uL2hvb2tzL3VzZVRlcm1pbmFsU2l6ZS5qcydcbmltcG9ydCB7IEJveCwgTGluaywgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUtleWJpbmRpbmcgfSBmcm9tICcuLi8uLi9rZXliaW5kaW5ncy91c2VLZXliaW5kaW5nLmpzJ1xuaW1wb3J0IHsgUGFuZSB9IGZyb20gJy4uL2Rlc2lnbi1zeXN0ZW0vUGFuZS5qcydcbmltcG9ydCB7IFRhYiwgVGFicyB9IGZyb20gJy4uL2Rlc2lnbi1zeXN0ZW0vVGFicy5qcydcbmltcG9ydCB7IENvbW1hbmRzIH0gZnJvbSAnLi9Db21tYW5kcy5qcydcbmltcG9ydCB7IEdlbmVyYWwgfSBmcm9tICcuL0dlbmVyYWwuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIG9uQ2xvc2U6IChcbiAgICByZXN1bHQ/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IHsgZGlzcGxheT86IENvbW1hbmRSZXN1bHREaXNwbGF5IH0sXG4gICkgPT4gdm9pZFxuICBjb21tYW5kczogQ29tbWFuZFtdXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBIZWxwVjIoeyBvbkNsb3NlLCBjb21tYW5kcyB9OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgcm93cywgY29sdW1ucyB9ID0gdXNlVGVybWluYWxTaXplKClcbiAgY29uc3QgbWF4SGVpZ2h0ID0gTWF0aC5mbG9vcihyb3dzIC8gMilcbiAgLy8gSW5zaWRlIHRoZSBtb2RhbCBzbG90LCBGdWxsc2NyZWVuTGF5b3V0IGFscmVhZHkgY2FwcyBoZWlnaHQgYW5kIFBhbmUvVGFic1xuICAvLyB1c2UgZmxleFNocmluaz0wIChzZWUgIzIzNTkyKSDigJQgb3VyIG93biBoZWlnaHQ9IGNvbnN0cmFpbnQgd291bGQgY2xpcCB0aGVcbiAgLy8gZm9vdGVyIHNpbmNlIFRhYnMgd29uJ3Qgc2hyaW5rIHRvIGZpdC4gTGV0IHRoZSBtb2RhbCBzbG90IGhhbmRsZSBzaXppbmcuXG4gIGNvbnN0IGluc2lkZU1vZGFsID0gdXNlSXNJbnNpZGVNb2RhbCgpXG5cbiAgY29uc3QgY2xvc2UgPSAoKSA9PiBvbkNsb3NlKCdIZWxwIGRpYWxvZyBkaXNtaXNzZWQnLCB7IGRpc3BsYXk6ICdzeXN0ZW0nIH0pXG4gIHVzZUtleWJpbmRpbmcoJ2hlbHA6ZGlzbWlzcycsIGNsb3NlLCB7IGNvbnRleHQ6ICdIZWxwJyB9KVxuICBjb25zdCBleGl0U3RhdGUgPSB1c2VFeGl0T25DdHJsQ0RXaXRoS2V5YmluZGluZ3MoY2xvc2UpXG4gIGNvbnN0IGRpc21pc3NTaG9ydGN1dCA9IHVzZVNob3J0Y3V0RGlzcGxheSgnaGVscDpkaXNtaXNzJywgJ0hlbHAnLCAnZXNjJylcblxuICBjb25zdCBidWlsdGluTmFtZXMgPSBidWlsdEluQ29tbWFuZE5hbWVzKClcbiAgbGV0IGJ1aWx0aW5Db21tYW5kcyA9IGNvbW1hbmRzLmZpbHRlcihcbiAgICBjbWQgPT4gYnVpbHRpbk5hbWVzLmhhcyhjbWQubmFtZSkgJiYgIWNtZC5pc0hpZGRlbixcbiAgKVxuICBsZXQgYW50T25seUNvbW1hbmRzOiBDb21tYW5kW10gPSBbXVxuXG4gIC8vIFdlIGhhdmUgdG8gZG8gdGhpcyBpbiBhbiBgaWZgIHRvIGhlbHAgdHJlZXNoYWtpbmdcbiAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICBjb25zdCBpbnRlcm5hbE9ubHlOYW1lcyA9IG5ldyBTZXQoSU5URVJOQUxfT05MWV9DT01NQU5EUy5tYXAoXyA9PiBfLm5hbWUpKVxuICAgIGJ1aWx0aW5Db21tYW5kcyA9IGJ1aWx0aW5Db21tYW5kcy5maWx0ZXIoXG4gICAgICBjbWQgPT4gIWludGVybmFsT25seU5hbWVzLmhhcyhjbWQubmFtZSksXG4gICAgKVxuICAgIGFudE9ubHlDb21tYW5kcyA9IGNvbW1hbmRzLmZpbHRlcihcbiAgICAgIGNtZCA9PiBpbnRlcm5hbE9ubHlOYW1lcy5oYXMoY21kLm5hbWUpICYmICFjbWQuaXNIaWRkZW4sXG4gICAgKVxuICB9XG5cbiAgY29uc3QgY3VzdG9tQ29tbWFuZHMgPSBjb21tYW5kcy5maWx0ZXIoXG4gICAgY21kID0+ICFidWlsdGluTmFtZXMuaGFzKGNtZC5uYW1lKSAmJiAhY21kLmlzSGlkZGVuLFxuICApXG5cbiAgY29uc3QgdGFicyA9IFtcbiAgICA8VGFiIGtleT1cImdlbmVyYWxcIiB0aXRsZT1cImdlbmVyYWxcIj5cbiAgICAgIDxHZW5lcmFsIC8+XG4gICAgPC9UYWI+LFxuICBdXG5cbiAgdGFicy5wdXNoKFxuICAgIDxUYWIga2V5PVwiY29tbWFuZHNcIiB0aXRsZT1cImNvbW1hbmRzXCI+XG4gICAgICA8Q29tbWFuZHNcbiAgICAgICAgY29tbWFuZHM9e2J1aWx0aW5Db21tYW5kc31cbiAgICAgICAgbWF4SGVpZ2h0PXttYXhIZWlnaHR9XG4gICAgICAgIGNvbHVtbnM9e2NvbHVtbnN9XG4gICAgICAgIHRpdGxlPVwiQnJvd3NlIGRlZmF1bHQgY29tbWFuZHM6XCJcbiAgICAgICAgb25DYW5jZWw9e2Nsb3NlfVxuICAgICAgLz5cbiAgICA8L1RhYj4sXG4gIClcblxuICB0YWJzLnB1c2goXG4gICAgPFRhYiBrZXk9XCJjdXN0b21cIiB0aXRsZT1cImN1c3RvbS1jb21tYW5kc1wiPlxuICAgICAgPENvbW1hbmRzXG4gICAgICAgIGNvbW1hbmRzPXtjdXN0b21Db21tYW5kc31cbiAgICAgICAgbWF4SGVpZ2h0PXttYXhIZWlnaHR9XG4gICAgICAgIGNvbHVtbnM9e2NvbHVtbnN9XG4gICAgICAgIHRpdGxlPVwiQnJvd3NlIGN1c3RvbSBjb21tYW5kczpcIlxuICAgICAgICBlbXB0eU1lc3NhZ2U9XCJObyBjdXN0b20gY29tbWFuZHMgZm91bmRcIlxuICAgICAgICBvbkNhbmNlbD17Y2xvc2V9XG4gICAgICAvPlxuICAgIDwvVGFiPixcbiAgKVxuXG4gIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnICYmIGFudE9ubHlDb21tYW5kcy5sZW5ndGggPiAwKSB7XG4gICAgdGFicy5wdXNoKFxuICAgICAgPFRhYiBrZXk9XCJhbnQtb25seVwiIHRpdGxlPVwiW2FudC1vbmx5XVwiPlxuICAgICAgICA8Q29tbWFuZHNcbiAgICAgICAgICBjb21tYW5kcz17YW50T25seUNvbW1hbmRzfVxuICAgICAgICAgIG1heEhlaWdodD17bWF4SGVpZ2h0fVxuICAgICAgICAgIGNvbHVtbnM9e2NvbHVtbnN9XG4gICAgICAgICAgdGl0bGU9XCJCcm93c2UgYW50LW9ubHkgY29tbWFuZHM6XCJcbiAgICAgICAgICBvbkNhbmNlbD17Y2xvc2V9XG4gICAgICAgIC8+XG4gICAgICA8L1RhYj4sXG4gICAgKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBoZWlnaHQ9e2luc2lkZU1vZGFsID8gdW5kZWZpbmVkIDogbWF4SGVpZ2h0fT5cbiAgICAgIDxQYW5lIGNvbG9yPVwicHJvZmVzc2lvbmFsQmx1ZVwiPlxuICAgICAgICA8VGFic1xuICAgICAgICAgIHRpdGxlPXtcbiAgICAgICAgICAgIFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCdcbiAgICAgICAgICAgICAgPyAnL2hlbHAnXG4gICAgICAgICAgICAgIDogYENsYXVkZSBDb2RlIHYke01BQ1JPLlZFUlNJT059YFxuICAgICAgICAgIH1cbiAgICAgICAgICBjb2xvcj1cInByb2Zlc3Npb25hbEJsdWVcIlxuICAgICAgICAgIGRlZmF1bHRUYWI9XCJnZW5lcmFsXCJcbiAgICAgICAgPlxuICAgICAgICAgIHt0YWJzfVxuICAgICAgICA8L1RhYnM+XG4gICAgICAgIDxCb3ggbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgIEZvciBtb3JlIGhlbHA6eycgJ31cbiAgICAgICAgICAgIDxMaW5rIHVybD1cImh0dHBzOi8vY29kZS5jbGF1ZGUuY29tL2RvY3MvZW4vb3ZlcnZpZXdcIiAvPlxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICAgIDxCb3ggbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICAgIHtleGl0U3RhdGUucGVuZGluZyA/IChcbiAgICAgICAgICAgICAgPD5QcmVzcyB7ZXhpdFN0YXRlLmtleU5hbWV9IGFnYWluIHRvIGV4aXQ8Lz5cbiAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgIDxUZXh0IGl0YWxpYz57ZGlzbWlzc1Nob3J0Y3V0fSB0byBjYW5jZWw8L1RleHQ+XG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICA8L1BhbmU+XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsOEJBQThCLFFBQVEsNkNBQTZDO0FBQzVGLFNBQVNDLGtCQUFrQixRQUFRLHVDQUF1QztBQUMxRSxTQUNFQyxtQkFBbUIsRUFDbkIsS0FBS0MsT0FBTyxFQUNaLEtBQUtDLG9CQUFvQixFQUN6QkMsc0JBQXNCLFFBQ2pCLG1CQUFtQjtBQUMxQixTQUFTQyxnQkFBZ0IsUUFBUSxrQ0FBa0M7QUFDbkUsU0FBU0MsZUFBZSxRQUFRLGdDQUFnQztBQUNoRSxTQUFTQyxHQUFHLEVBQUVDLElBQUksRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDOUMsU0FBU0MsYUFBYSxRQUFRLG9DQUFv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QUFrQixDQUFsQixrQkFBa0IsQ0FDNUIsQ0FBQVhFQVVNLENBQ04sQ0FBQU9FS0sQ0FDTCxDQUFBSUVRSyxDQUNQLEVBM0JDLElBQUksQ0EyQkU7SUFBQXJDLENBQUE7SUFBQXJCLENBQUE7SUFBQXFCLENBQUEsT0FBQWZFLENBQUE7SUFBQWUsQ0FBQSxPQUFBeUMsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQXpDLENBQUE7RUFBQTtFQUFBLElBQUEwQyxHQUFBO0VBQUEsSUFBQTFDLENBQUEsU0FBQWlDLEVBQUEsSUFBQWpDLENBQUEsU0FBQXVDLEVBQUE7SUE1QlRHLEdBQUEsSUFBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FBUyxNQUFtQyxDQUFuQyxDQUFBYixFQUFrQyxDQUFDLENBQ3JFLENBQUFZRTJCTSxDQUNSLEVBN0JDLEdBQUcsQ0E2QkU7SUFBQTFDLENBQUE7SUFBQTJDLENBQUE7SUFBQTNDLENBQUEsT0FBQTBDLENBQUE7RUFBQTtJQUFBQSxHQUFBLEdBQUExQyxDQUFBO0VBQUE7RUFBQSxPQTdCTjBDLEdBNkJNO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=
