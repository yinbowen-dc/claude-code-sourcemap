/**
 * MCPServerDesktopImportDialog.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件实现了从 Claude Desktop 应用导入 MCP 服务器配置的对话框。
 * 当用户通过 CLI 命令触发 Desktop 配置迁移时，此组件被激活，
 * 允许用户从 Claude Desktop 的 MCP 配置中批量选择并导入服务器。
 * 位于：CLI 迁移命令 → 【Desktop 导入对话框】→ MCP 配置写入 → 进程退出 的链路中。
 *
 * 【主要功能】
 * 1. 挂载时异步获取所有现有 MCP 配置，检测命名冲突
 * 2. 渲染多选列表（SelectMulti），预选无冲突的服务器
 * 3. 冲突服务器显示 "(already exists)" 警告，导入时自动追加 _1, _2 等后缀
 * 4. 导入完成后向 stdout 输出成功信息，调用 onDone 并触发进程退出（gracefulShutdown）
 */
import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useEffect, useState } from 'react';
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js';
import { writeToStdout } from 'src/utils/process.js';
import { Box, color, Text, useTheme } from '../ink.js';
import { addMcpConfig, getAllMcpConfigs } from '../services/mcp/config.js';
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js';
import { plural } from '../utils/stringUtils.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';

// 组件 Props 类型定义
type Props = {
  servers: Record<string, McpServerConfig>; // 待导入的服务器配置映射（名称 → 配置）
  scope: ConfigScope;                        // 导入目标的配置作用域（local / global 等）
  onDone(): void;                            // 完成后的回调
};

/**
 * MCPServerDesktopImportDialog 组件
 *
 * 【整体流程】
 * 1. 从 props 中解构服务器列表和作用域
 * 2. 通过 useEffect 在挂载时异步加载现有 MCP 配置，更新 existingServers 状态
 * 3. 计算 collisions：哪些待导入服务器名在现有配置中已存在
 * 4. 渲染 Dialog，内含：
 *    - 冲突警告提示（如有）
 *    - SelectMulti 多选列表，预选无冲突项
 * 5. 用户确认后，onSubmit 依次调用 addMcpConfig 写入配置，冲突项自动加后缀
 * 6. 写入完成后输出结果并调用 onDone + gracefulShutdown
 *
 * 【React Compiler 缓存说明】
 * 使用 _c(36) 创建 36 个缓存槽位，涵盖：服务器名数组、useEffect 回调、
 * 碰撞检测结果、done/handleEscCancel 函数、Select 选项、最终 JSX 等。
 */
export function MCPServerDesktopImportDialog(t0) {
  // React Compiler 生成的缓存数组，共 36 个槽位
  const $ = _c(36);
  const {
    servers,
    scope,
    onDone
  } = t0;

  // ---- 缓存服务器名数组（仅 servers 变化时重新计算）----
  let t1;
  if ($[0] !== servers) {
    t1 = Object.keys(servers); // 提取所有待导入服务器的名称
    $[0] = servers;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const serverNames = t1;

  // ---- 初始化 existingServers 状态（空对象作为初始值，只创建一次）----
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {}; // 空对象，代表"尚未加载现有服务器"
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const [existingServers, setExistingServers] = useState(t2);

  // ---- useEffect：挂载时异步加载现有 MCP 配置 ----
  let t3;
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => {
      // 异步获取所有已配置的 MCP 服务器，更新 existingServers 状态
      getAllMcpConfigs().then(t5 => {
        const {
          servers: servers_0
        } = t5;
        return setExistingServers(servers_0); // 将加载到的服务器写入 state
      });
    };
    t4 = []; // 空依赖数组，保证只在挂载时执行一次
    $[3] = t3;
    $[4] = t4;
  } else {
    t3 = $[3];
    t4 = $[4];
  }
  useEffect(t3, t4);

  // ---- 计算命名冲突列表（当 existingServers 或 serverNames 变化时重算）----
  let t5;
  if ($[5] !== existingServers || $[6] !== serverNames) {
    // 找出待导入服务器中，名称已存在于现有配置的部分
    t5 = serverNames.filter(name => existingServers[name] !== undefined);
    $[5] = existingServers;
    $[6] = serverNames;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  const collisions = t5;

  /**
   * onSubmit 异步处理函数
   *
   * 【流程】
   * 1. 遍历用户选中的服务器名列表
   * 2. 对每个服务器，若存在命名冲突则查找可用后缀（_1, _2, …）
   * 3. 调用 addMcpConfig 将服务器写入指定作用域的配置
   * 4. 统计成功导入数量，最终调用 done(importedCount)
   */
  const onSubmit = async function onSubmit(selectedServers) {
    let importedCount = 0;
    for (const serverName of selectedServers) {
      const serverConfig = servers[serverName];
      if (serverConfig) {
        let finalName = serverName; // 最终写入配置使用的名称
        // 检测命名冲突，若冲突则递增计数器查找可用名称
        if (existingServers[finalName] !== undefined) {
          let counter = 1;
          // 循环递增直到找到未被占用的名称（如 server_1、server_2 …）
          while (existingServers[`${serverName}_${counter}`] !== undefined) {
            counter++;
          }
          finalName = `${serverName}_${counter}`; // 最终确定的去重名称
        }
        await addMcpConfig(finalName, serverConfig, scope); // 写入配置文件
        importedCount++;
      }
    }
    done(importedCount); // 通知完成，传入实际导入数量
  };

  // 获取当前主题（用于 color() 输出着色）
  const [theme] = useTheme();

  // ---- 缓存 done 回调（依赖 onDone、scope、theme）----
  let t6;
  if ($[8] !== onDone || $[9] !== scope || $[10] !== theme) {
    t6 = importedCount_0 => {
      if (importedCount_0 > 0) {
        // 导入成功：用绿色输出成功信息（服务器数量 + 复数形式 + 目标作用域）
        writeToStdout(`\n${color("success", theme)(`Successfully imported ${importedCount_0} MCP ${plural(importedCount_0, "server")} to ${scope} config.`)}\n`);
      } else {
        // 未导入任何服务器
        writeToStdout("\nNo servers were imported.");
      }
      onDone();              // 通知父组件对话框结束
      gracefulShutdown();    // 优雅退出进程（此对话框通常在 CLI 一次性命令中使用）
    };
    $[8] = onDone;
    $[9] = scope;
    $[10] = theme;
    $[11] = t6;
  } else {
    t6 = $[11];
  }
  const done = t6;

  // ---- 缓存 ESC 取消处理（导入 0 个，相当于取消）----
  let t7;
  if ($[12] !== done) {
    t7 = () => {
      done(0); // 传入 0 表示没有导入任何服务器
    };
    $[12] = done;
    $[13] = t7;
  } else {
    t7 = $[13];
  }
  done; // 防止 React Compiler 的 dead code 消除（编译器副作用占位）
  const handleEscCancel = t7;

  // 计算标题所需的服务器数量和单复数形式
  const t8 = serverNames.length;
  let t9;
  if ($[14] !== serverNames.length) {
    t9 = plural(serverNames.length, "server"); // 根据数量返回 "server" 或 "servers"
    $[14] = serverNames.length;
    $[15] = t9;
  } else {
    t9 = $[15];
  }
  const t10 = `Found ${t8} MCP ${t9} in Claude Desktop.`; // 副标题文本

  // ---- 缓存冲突警告（仅当 collisions.length 变化时重建）----
  let t11;
  if ($[16] !== collisions.length) {
    // 若存在冲突，显示橙色警告文本；否则为 false（不渲染）
    t11 = collisions.length > 0 && <Text color="warning">Note: Some servers already exist with the same name. If selected, they will be imported with a numbered suffix.</Text>;
    $[16] = collisions.length;
    $[17] = t11;
  } else {
    t11 = $[17];
  }

  // ---- 缓存静态提示文本（内容固定，只创建一次）----
  let t12;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <Text>Please select the servers you want to import:</Text>;
    $[18] = t12;
  } else {
    t12 = $[18];
  }

  // ---- 缓存多选项列表和默认值（依赖 collisions 和 serverNames）----
  let t13; // SelectMulti 的选项数组
  let t14; // 默认选中值（排除冲突项）
  if ($[19] !== collisions || $[20] !== serverNames) {
    // 构建选项：冲突项附加 "(already exists)" 标注
    t13 = serverNames.map(server => ({
      label: `${server}${collisions.includes(server) ? " (already exists)" : ""}`,
      value: server
    }));
    // 默认只预选无冲突的服务器
    t14 = serverNames.filter(name_0 => !collisions.includes(name_0));
    $[19] = collisions;
    $[20] = serverNames;
    $[21] = t13;
    $[22] = t14;
  } else {
    t13 = $[21];
    t14 = $[22];
  }

  // ---- 缓存 SelectMulti 组件（依赖 handleEscCancel、onSubmit、选项、默认值）----
  let t15;
  if ($[23] !== handleEscCancel || $[24] !== onSubmit || $[25] !== t13 || $[26] !== t14) {
    t15 = <SelectMulti options={t13} defaultValue={t14} onSubmit={onSubmit} onCancel={handleEscCancel} hideIndexes={true} />;
    $[23] = handleEscCancel;
    $[24] = onSubmit;
    $[25] = t13;
    $[26] = t14;
    $[27] = t15;
  } else {
    t15 = $[27];
  }

  // ---- 缓存 Dialog 主体（依赖 handleEscCancel、subtitle、冲突警告、SelectMulti）----
  let t16;
  if ($[28] !== handleEscCancel || $[29] !== t10 || $[30] !== t11 || $[31] !== t15) {
    // 成功色调的 Dialog，隐藏内置输入指南（自定义快捷键提示在下方 Box 中）
    t16 = <Dialog title="Import MCP Servers from Claude Desktop" subtitle={t10} color="success" onCancel={handleEscCancel} hideInputGuide={true}>{t11}{t12}{t15}</Dialog>;
    $[28] = handleEscCancel;
    $[29] = t10;
    $[30] = t11;
    $[31] = t15;
    $[32] = t16;
  } else {
    t16 = $[32];
  }

  // ---- 缓存底部快捷键提示区（静态，只创建一次）----
  let t17;
  if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
    // Space=选中/取消 Enter=确认 Esc=取消导入
    t17 = <Box paddingX={1}><Text dimColor={true} italic={true}><Byline><KeyboardShortcutHint shortcut="Space" action="select" /><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline></Text></Box>;
    $[33] = t17;
  } else {
    t17 = $[33];
  }

  // ---- 缓存最终返回节点（Dialog + 快捷键提示）----
  let t18;
  if ($[34] !== t16) {
    t18 = <>{t16}{t17}</>;
    $[34] = t16;
    $[35] = t18;
  } else {
    t18 = $[35];
  }
  return t18;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNhbGxiYWNrIiwidXNlRWZmZWN0IiwidXNlU3RhdGUiLCJncmFjZWZ1bFNodXRkb3duIiwid3JpdGVUb1N0ZG91dCIsIkJveCIsImNvbG9yIiwiVGV4dCIsInVzZVRoZW1lIiwiYWRkTWNwQ29uZmlnIiwiZ2V0QWxsTWNwQ29uZmlncyIsIkNvbmZpZ1Njb3BlIiwiTWNwU2VydmVyQ29uZmlnIiwiU2NvcGVkTWNwU2VydmVyQ29uZmlnIiwicGx1cmFsIiwiQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IiwiU2VsZWN0TXVsdGkiLCJCeWxpbmUiLCJEaWFsb2ciLCJLZXlib2FyZFNob3J0Y3V0SGludCIsIlByb3BzIiwic2VydmVycyIsIlJlY29yZCIsInNjb3BlIiwib25Eb25lIiwiTUNQU2VydmVyRGVza3RvcEltcG9ydERpYWxvZyIsInQwIiwiJCIsIl9jIiwidDEiLCJPYmplY3QiLCJrZXlzIiwic2VydmVyTmFtZXMiLCJ0MiIsIlN5bWJvbCIsImZvciIsImV4aXN0aW5nU2VydmVycyIsInNldEV4aXN0aW5nU2VydmVycyIsInQzIiwidDQiLCJ0aGVuIiwidDUiLCJzZXJ2ZXJzXzAiLCJmaWx0ZXIiLCJuYW1lIiwidW5kZWZpbmVkIiwiY29sbGlzaW9ucyIsIm9uU3VibWl0Iiwic2VsZWN0ZWRTZXJ2ZXJzIiwiaW1wb3J0ZWRDb3VudCIsInNlcnZlck5hbWUiLCJzZXJ2ZXJDb25maWciLCJmaW5hbE5hbWUiLCJjb3VudGVyIiwiZG9uZSIsInRoZW1lIiwidDYiLCJpbXBvcnRlZENvdW50XzAiLCJ0NyIsImhhbmRsZUVzY0NhbmNlbCIsInQ4IiwibGVuZ3RoIiwidDkiLCJ0MTAiLCJ0MTEiLCJ0MTIiLCJ0MTMiLCJ0MTQiLCJtYXAiLCJzZXJ2ZXIiLCJsYWJlbCIsImluY2x1ZGVzIiwidmFsdWUiLCJuYW1lXzAiLCJ0MTUiLCJ0MTYiLCJ0MTciLCJ0MTgiXSwic291cmNlcyI6WyJNQ1BTZXJ2ZXJEZXNrdG9wSW1wb3J0RGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QsIHsgdXNlQ2FsbGJhY2ssIHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IGdyYWNlZnVsU2h1dGRvd24gfSBmcm9tICdzcmMvdXRpbHMvZ3JhY2VmdWxTaHV0ZG93bi5qcydcbmltcG9ydCB7IHdyaXRlVG9TdGRvdXQgfSBmcm9tICdzcmMvdXRpbHMvcHJvY2Vzcy5qcydcbmltcG9ydCB7IEJveCwgY29sb3IsIFRleHQsIHVzZVRoZW1lIH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgYWRkTWNwQ29uZmlnLCBnZXRBbGxNY3BDb25maWdzIH0gZnJvbSAnLi4vc2VydmljZXMvbWNwL2NvbmZpZy5qcydcbmltcG9ydCB0eXBlIHtcbiAgQ29uZmlnU2NvcGUsXG4gIE1jcFNlcnZlckNvbmZpZyxcbiAgU2NvcGVkTWNwU2VydmVyQ29uZmlnLFxufSBmcm9tICcuLi9zZXJ2aWNlcy9tY3AvdHlwZXMuanMnXG5pbXBvcnQgeyBwbHVyYWwgfSBmcm9tICcuLi91dGlscy9zdHJpbmdVdGlscy5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgU2VsZWN0TXVsdGkgfSBmcm9tICcuL0N1c3RvbVNlbGVjdC9TZWxlY3RNdWx0aS5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4vZGVzaWduLXN5c3RlbS9CeWxpbmUuanMnXG5pbXBvcnQgeyBEaWFsb2cgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vRGlhbG9nLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vS2V5Ym9hcmRTaG9ydGN1dEhpbnQuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIHNlcnZlcnM6IFJlY29yZDxzdHJpbmcsIE1jcFNlcnZlckNvbmZpZz5cbiAgc2NvcGU6IENvbmZpZ1Njb3BlXG4gIG9uRG9uZSgpOiB2b2lkXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBNQ1BTZXJ2ZXJEZXNrdG9wSW1wb3J0RGlhbG9nKHtcbiAgc2VydmVycyxcbiAgc2NvcGUsXG4gIG9uRG9uZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3Qgc2VydmVyTmFtZXMgPSBPYmplY3Qua2V5cyhzZXJ2ZXJzKVxuICBjb25zdCBbZXhpc3RpbmdTZXJ2ZXJzLCBzZXRFeGlzdGluZ1NlcnZlcnNdID0gdXNlU3RhdGU8XG4gICAgUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPlxuICA+KHt9KVxuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgdm9pZCBnZXRBbGxNY3BDb25maWdzKCkudGhlbigoeyBzZXJ2ZXJzIH0pID0+IHNldEV4aXN0aW5nU2VydmVycyhzZXJ2ZXJzKSlcbiAgfSwgW10pXG5cbiAgY29uc3QgY29sbGlzaW9ucyA9IHNlcnZlck5hbWVzLmZpbHRlcihcbiAgICBuYW1lID0+IGV4aXN0aW5nU2VydmVyc1tuYW1lXSAhPT0gdW5kZWZpbmVkLFxuICApXG5cbiAgYXN5bmMgZnVuY3Rpb24gb25TdWJtaXQoc2VsZWN0ZWRTZXJ2ZXJzOiBzdHJpbmdbXSkge1xuICAgIGxldCBpbXBvcnRlZENvdW50ID0gMFxuXG4gICAgZm9yIChjb25zdCBzZXJ2ZXJOYW1lIG9mIHNlbGVjdGVkU2VydmVycykge1xuICAgICAgY29uc3Qgc2VydmVyQ29uZmlnID0gc2VydmVyc1tzZXJ2ZXJOYW1lXVxuICAgICAgaWYgKHNlcnZlckNvbmZpZykge1xuICAgICAgICAvLyBJZiB0aGUgc2VydmVyIG5hbWUgYWxyZWFkeSBleGlzdHMsIGZpbmQgYSBuZXcgbmFtZSB3aXRoIF8xLCBfMiwgZXRjLlxuICAgICAgICBsZXQgZmluYWxOYW1lID0gc2VydmVyTmFtZVxuICAgICAgICBpZiAoZXhpc3RpbmdTZXJ2ZXJzW2ZpbmFsTmFtZV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGxldCBjb3VudGVyID0gMVxuICAgICAgICAgIHdoaWxlIChleGlzdGluZ1NlcnZlcnNbYCR7c2VydmVyTmFtZX1fJHtjb3VudGVyfWBdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNvdW50ZXIrK1xuICAgICAgICAgIH1cbiAgICAgICAgICBmaW5hbE5hbWUgPSBgJHtzZXJ2ZXJOYW1lfV8ke2NvdW50ZXJ9YFxuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgYWRkTWNwQ29uZmlnKGZpbmFsTmFtZSwgc2VydmVyQ29uZmlnLCBzY29wZSlcbiAgICAgICAgaW1wb3J0ZWRDb3VudCsrXG4gICAgICB9XG4gICAgfVxuXG4gICAgZG9uZShpbXBvcnRlZENvdW50KVxuICB9XG5cbiAgY29uc3QgW3RoZW1lXSA9IHVzZVRoZW1lKClcblxuICAvLyBEZWZpbmUgZG9uZSBiZWZvcmUgdXNpbmcgaW4gdXNlQ2FsbGJhY2tcbiAgY29uc3QgZG9uZSA9IHVzZUNhbGxiYWNrKFxuICAgIChpbXBvcnRlZENvdW50OiBudW1iZXIpID0+IHtcbiAgICAgIGlmIChpbXBvcnRlZENvdW50ID4gMCkge1xuICAgICAgICB3cml0ZVRvU3Rkb3V0KFxuICAgICAgICAgIGBcXG4ke2NvbG9yKCdzdWNjZXNzJywgdGhlbWUpKGBTdWNjZXNzZnVsbHkgaW1wb3J0ZWQgJHtpbXBvcnRlZENvdW50fSBNQ1AgJHtwbHVyYWwoaW1wb3J0ZWRDb3VudCwgJ3NlcnZlcicpfSB0byAke3Njb3BlfSBjb25maWcuYCl9XFxuYCxcbiAgICAgICAgKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgd3JpdGVUb1N0ZG91dCgnXFxuTm8gc2VydmVycyB3ZXJlIGltcG9ydGVkLicpXG4gICAgICB9XG4gICAgICBvbkRvbmUoKVxuXG4gICAgICB2b2lkIGdyYWNlZnVsU2h1dGRvd24oKVxuICAgIH0sXG4gICAgW3RoZW1lLCBzY29wZSwgb25Eb25lXSxcbiAgKVxuXG4gIC8vIEhhbmRsZSBFU0MgdG8gY2FuY2VsIChpbXBvcnQgMCBzZXJ2ZXJzKVxuICBjb25zdCBoYW5kbGVFc2NDYW5jZWwgPSB1c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgZG9uZSgwKVxuICB9LCBbZG9uZV0pXG5cbiAgcmV0dXJuIChcbiAgICA8PlxuICAgICAgPERpYWxvZ1xuICAgICAgICB0aXRsZT1cIkltcG9ydCBNQ1AgU2VydmVycyBmcm9tIENsYXVkZSBEZXNrdG9wXCJcbiAgICAgICAgc3VidGl0bGU9e2BGb3VuZCAke3NlcnZlck5hbWVzLmxlbmd0aH0gTUNQICR7cGx1cmFsKHNlcnZlck5hbWVzLmxlbmd0aCwgJ3NlcnZlcicpfSBpbiBDbGF1ZGUgRGVza3RvcC5gfVxuICAgICAgICBjb2xvcj1cInN1Y2Nlc3NcIlxuICAgICAgICBvbkNhbmNlbD17aGFuZGxlRXNjQ2FuY2VsfVxuICAgICAgICBoaWRlSW5wdXRHdWlkZVxuICAgICAgPlxuICAgICAgICB7Y29sbGlzaW9ucy5sZW5ndGggPiAwICYmIChcbiAgICAgICAgICA8VGV4dCBjb2xvcj1cIndhcm5pbmdcIj5cbiAgICAgICAgICAgIE5vdGU6IFNvbWUgc2VydmVycyBhbHJlYWR5IGV4aXN0IHdpdGggdGhlIHNhbWUgbmFtZS4gSWYgc2VsZWN0ZWQsXG4gICAgICAgICAgICB0aGV5IHdpbGwgYmUgaW1wb3J0ZWQgd2l0aCBhIG51bWJlcmVkIHN1ZmZpeC5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICl9XG4gICAgICAgIDxUZXh0PlBsZWFzZSBzZWxlY3QgdGhlIHNlcnZlcnMgeW91IHdhbnQgdG8gaW1wb3J0OjwvVGV4dD5cblxuICAgICAgICA8U2VsZWN0TXVsdGlcbiAgICAgICAgICBvcHRpb25zPXtzZXJ2ZXJOYW1lcy5tYXAoc2VydmVyID0+ICh7XG4gICAgICAgICAgICBsYWJlbDogYCR7c2VydmVyfSR7Y29sbGlzaW9ucy5pbmNsdWRlcyhzZXJ2ZXIpID8gJyAoYWxyZWFkeSBleGlzdHMpJyA6ICcnfWAsXG4gICAgICAgICAgICB2YWx1ZTogc2VydmVyLFxuICAgICAgICAgIH0pKX1cbiAgICAgICAgICBkZWZhdWx0VmFsdWU9e3NlcnZlck5hbWVzLmZpbHRlcihuYW1lID0+ICFjb2xsaXNpb25zLmluY2x1ZGVzKG5hbWUpKX0gLy8gT25seSBwcmVzZWxlY3Qgbm9uLWNvbGxpZGluZyBzZXJ2ZXJzXG4gICAgICAgICAgb25TdWJtaXQ9e29uU3VibWl0fVxuICAgICAgICAgIG9uQ2FuY2VsPXtoYW5kbGVFc2NDYW5jZWx9XG4gICAgICAgICAgaGlkZUluZGV4ZXNcbiAgICAgICAgLz5cbiAgICAgIDwvRGlhbG9nPlxuICAgICAgPEJveCBwYWRkaW5nWD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yIGl0YWxpYz5cbiAgICAgICAgICA8QnlsaW5lPlxuICAgICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwiU3BhY2VcIiBhY3Rpb249XCJzZWxlY3RcIiAvPlxuICAgICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwiRW50ZXJcIiBhY3Rpb249XCJjb25maXJtXCIgLz5cbiAgICAgICAgICAgIDxDb25maWd1cmFibGVTaG9ydGN1dEhpbnRcbiAgICAgICAgICAgICAgYWN0aW9uPVwiY29uZmlybTpub1wiXG4gICAgICAgICAgICAgIGNvbnRleHQ9XCJDb25maXJtYXRpb25cIlxuICAgICAgICAgICAgICBmYWxsYmFjaz1cIkVzY1wiXG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiY2FuY2VsXCJcbiAgICAgICAgICAgIC8+XG4gICAgICAgICAgPC9CeWxpbmU+XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgIDwvPlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLElBQUlDLFdBQVcsRUFBRUMsU0FBUyxFQUFFQyxRQUFRLFFBQVEsT0FBTztBQUMvRCxTQUFTQyxnQkFBZ0IsUUFBUSwrQkFBK0I7QUFDaEUsU0FBU0MsYUFBYSxRQUFRLHNCQUFzQjtBQUNwRCxTQUFTQyxHQUFHLEVBQUVDLEtB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
