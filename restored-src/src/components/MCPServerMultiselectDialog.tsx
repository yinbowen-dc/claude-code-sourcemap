/**
 * MCPServerMultiselectDialog.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件处理批量发现多个新 MCP 服务器时的审批场景。
 * 当 .mcp.json 中同时存在多个新服务器时（区别于单服务器的 MCPServerApprovalDialog），
 * 本对话框允许用户通过多选列表一次性批量决策所有服务器的启用/禁用状态。
 * 位于：.mcp.json 变更检测 → 【多服务器多选对话框】→ 设置持久化 的链路中。
 *
 * 【主要功能】
 * 1. 渲染包含所有新发现 MCP 服务器的多选对话框，默认全选
 * 2. 用户提交后，使用 partition 将服务器分为"已批准"和"已拒绝"两组
 * 3. 分别更新 enabledMcpjsonServers / disabledMcpjsonServers 设置（使用 Set 去重）
 * 4. ESC 键触发全部拒绝逻辑（handleEscRejectAll）
 * 5. 通过 logEvent 上报批量审批事件（approved/rejected 数量）
 */
import { c as _c } from "react/compiler-runtime";
import partition from 'lodash-es/partition.js';
import React, { useCallback } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Text } from '../ink.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';

// 组件 Props 类型定义
type Props = {
  serverNames: string[]; // 待审批的所有 MCP 服务器名称数组
  onDone(): void;        // 审批完成后的回调函数
};

/**
 * MCPServerMultiselectDialog 组件
 *
 * 【整体流程】
 * 1. 接收 serverNames 和 onDone
 * 2. 构建 onSubmit：处理用户最终提交的选择（批准 vs 拒绝），更新本地设置并触发 onDone
 * 3. 构建 handleEscRejectAll：ESC 时将所有服务器全部加入禁用列表
 * 4. 渲染 Dialog（警告色调）+ SelectMulti（默认全选）+ 快捷键提示
 *
 * 【React Compiler 缓存说明】
 * 使用 _c(21) 创建 21 个缓存槽位，精细化缓存两个核心回调函数和所有 JSX 节点。
 */
export function MCPServerMultiselectDialog(t0) {
  // React Compiler 生成的缓存数组，共 21 个槽位
  const $ = _c(21);
  const {
    serverNames,
    onDone
  } = t0;

  // ---- 缓存 onSubmit 处理函数（依赖 onDone 和 serverNames）----
  let t1;
  if ($[0] !== onDone || $[1] !== serverNames) {
    /**
     * onSubmit 处理函数
     *
     * 【流程】
     * 1. 读取当前设置，获取已启用/禁用服务器列表
     * 2. 使用 lodash partition 将 serverNames 分为：
     *    - approvedServers：用户在多选列表中勾选的服务器
     *    - rejectedServers：用户取消勾选的服务器
     * 3. 上报 tengu_mcp_multidialog_choice 事件
     * 4. 若有批准服务器：用 Set 去重后更新 enabledMcpjsonServers
     * 5. 若有拒绝服务器：用 Set 去重后更新 disabledMcpjsonServers
     * 6. 调用 onDone 关闭对话框
     */
    t1 = function onSubmit(selectedServers) {
      // 读取当前设置中的已启用/禁用服务器列表
      const currentSettings = getSettings_DEPRECATED() || {};
      const enabledServers = currentSettings.enabledMcpjsonServers || [];
      const disabledServers = currentSettings.disabledMcpjsonServers || [];

      // 使用 partition 将 serverNames 按"是否在 selectedServers 中"分组
      const [approvedServers, rejectedServers] = partition(serverNames, server => selectedServers.includes(server));

      // 上报批量审批事件（记录批准和拒绝的数量）
      logEvent("tengu_mcp_multidialog_choice", {
        approved: approvedServers.length,
        rejected: rejectedServers.length
      });

      // 将批准的服务器加入启用列表（使用 Set 去重，防止重复）
      if (approvedServers.length > 0) {
        const newEnabledServers = [...new Set([...enabledServers, ...approvedServers])];
        updateSettingsForSource("localSettings", {
          enabledMcpjsonServers: newEnabledServers
        });
      }

      // 将拒绝的服务器加入禁用列表（使用 Set 去重，防止重复）
      if (rejectedServers.length > 0) {
        const newDisabledServers = [...new Set([...disabledServers, ...rejectedServers])];
        updateSettingsForSource("localSettings", {
          disabledMcpjsonServers: newDisabledServers
        });
      }
      onDone(); // 关闭对话框
    };
    $[0] = onDone;
    $[1] = serverNames;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const onSubmit = t1;

  // ---- 缓存 ESC 取消处理函数（全部拒绝，依赖 onDone 和 serverNames）----
  let t2;
  if ($[3] !== onDone || $[4] !== serverNames) {
    /**
     * handleEscRejectAll 处理函数
     *
     * 当用户按 ESC 时，将所有 serverNames 中的服务器全部加入禁用列表，
     * 然后调用 onDone 关闭对话框。
     * 这是"一键拒绝所有"的快捷操作。
     */
    t2 = () => {
      const currentSettings_0 = getSettings_DEPRECATED() || {};
      const disabledServers_0 = currentSettings_0.disabledMcpjsonServers || [];
      // 将所有服务器名合并到禁用列表，用 Set 去重
      const newDisabledServers_0 = [...new Set([...disabledServers_0, ...serverNames])];
      updateSettingsForSource("localSettings", {
        disabledMcpjsonServers: newDisabledServers_0
      });
      onDone(); // 关闭对话框
    };
    $[3] = onDone;
    $[4] = serverNames;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handleEscRejectAll = t2;

  // 对话框标题：显示发现的服务器数量
  const t3 = `${serverNames.length} new MCP servers found in .mcp.json`;

  // ---- 缓存风险说明组件（静态，只创建一次）----
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <MCPServerDialogCopy />; // 风险说明文本（MCP 可能执行代码等）
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // ---- 缓存多选项列表（依赖 serverNames）----
  let t5;
  if ($[7] !== serverNames) {
    // 将 serverNames 映射为 { label, value } 对象数组
    t5 = serverNames.map(_temp); // _temp 为编译器提取的静态映射函数
    $[7] = serverNames;
    $[8] = t5;
  } else {
    t5 = $[8];
  }

  // ---- 缓存 SelectMulti 组件（依赖多个回调和选项）----
  let t6;
  if ($[9] !== handleEscRejectAll || $[10] !== onSubmit || $[11] !== serverNames || $[12] !== t5) {
    // defaultValue = serverNames：默认全选所有服务器
    t6 = <SelectMulti options={t5} defaultValue={serverNames} onSubmit={onSubmit} onCancel={handleEscRejectAll} hideIndexes={true} />;
    $[9] = handleEscRejectAll;
    $[10] = onSubmit;
    $[11] = serverNames;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // ---- 缓存 Dialog 主体（依赖 handleEscRejectAll、title、SelectMulti）----
  let t7;
  if ($[14] !== handleEscRejectAll || $[15] !== t3 || $[16] !== t6) {
    // 警告色调的 Dialog，副标题提示用户可以选择启用哪些服务器
    t7 = <Dialog title={t3} subtitle="Select any you wish to enable." color="warning" onCancel={handleEscRejectAll} hideInputGuide={true}>{t4}{t6}</Dialog>;
    $[14] = handleEscRejectAll;
    $[15] = t3;
    $[16] = t6;
    $[17] = t7;
  } else {
    t7 = $[17];
  }

  // ---- 缓存底部快捷键提示区（静态，只创建一次）----
  let t8;
  if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
    // Space=选中 Enter=确认 Esc=全部拒绝
    t8 = <Box paddingX={1}><Text dimColor={true} italic={true}><Byline><KeyboardShortcutHint shortcut="Space" action="select" /><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="reject all" /></Byline></Text></Box>;
    $[18] = t8;
  } else {
    t8 = $[18];
  }

  // ---- 缓存最终返回节点（Dialog + 快捷键提示）----
  let t9;
  if ($[19] !== t7) {
    t9 = <>{t7}{t8}</>;
    $[19] = t7;
    $[20] = t9;
  } else {
    t9 = $[20];
  }
  return t9;
}

/**
 * _temp 辅助函数（由 React Compiler 从 map 回调中提取）
 *
 * 将服务器名字符串转为 SelectMulti 所需的 { label, value } 格式。
 * 提取为独立函数可避免在渲染函数体内频繁创建匿名函数。
 */
function _temp(server_0) {
  return {
    label: server_0, // 显示名称即为服务器名
    value: server_0  // 选中值也为服务器名
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJwYXJ0aXRpb24iLCJSZWFjdCIsInVzZUNhbGxiYWNrIiwibG9nRXZlbnQiLCJCb3giLCJUZXh0IiwiZ2V0U2V0dGluZ3NfREVQUkVDQVRFRCIsInVwZGF0ZVNldHRpbmdzRm9yU291cmNlIiwiQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IiwiU2VsZWN0TXVsdGkiLCJCeWxpbmUiLCJEaWFsb2ciLCJLZXlib2FyZFNob3J0Y3V0SGludCIsIk1DUFNlcnZlckRpYWxvZ0NvcHkiLCJQcm9wcyIsInNlcnZlck5hbWVzIiwib25Eb25lIiwiTUNQU2VydmVyTXVsdGlzZWxlY3REaWFsb2ciLCJ0MCIsIiQiLCJfYyIsInQxIiwib25TdWJtaXQiLCJzZWxlY3RlZFNlcnZlcnMiLCJjdXJyZW50U2V0dGluZ3MiLCJlbmFibGVkU2VydmVycyIsImVuYWJsZWRNY3Bqc29uU2VydmVycyIsImRpc2FibGVkU2VydmVycyIsImRpc2FibGVkTWNwanNvblNlcnZlcnMiLCJhcHByb3ZlZFNlcnZlcnMiLCJyZWplY3RlZFNlcnZlcnMiLCJzZXJ2ZXIiLCJpbmNsdWRlcyIsImFwcHJvdmVkIiwibGVuZ3RoIiwicmVqZWN0ZWQiLCJuZXdFbmFibGVkU2VydmVycyIsIlNldCIsIm5ld0Rpc2FibGVkU2VydmVycyIsInQyIiwiY3VycmVudFNldHRpbmdzXzAiLCJkaXNhYmxlZFNlcnZlcnNfMCIsIm5ld0Rpc2FibGVkU2VydmVyc18wIiwiaGFuZGxlRXNjUmVqZWN0QWxsIiwidDMiLCJ0NCIsIlN5bWJvbCIsImZvciIsInQ1IiwibWFwIiwiX3RlbXAiLCJ0NiIsInQ3IiwidDgiLCJ0OSIsInNlcnZlcl8wIiwibGFiZWwiLCJ2YWx1ZSJdLCJzb3VyY2VzIjpbIk1DUFNlcnZlck11bHRpc2VsZWN0RGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgcGFydGl0aW9uIGZyb20gJ2xvZGFzaC1lcy9wYXJ0aXRpb24uanMnXG5pbXBvcnQgUmVhY3QsIHsgdXNlQ2FsbGJhY2sgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IGxvZ0V2ZW50IH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7XG4gIGdldFNldHRpbmdzX0RFUFJFQ0FURUQsXG4gIHVwZGF0ZVNldHRpbmdzRm9yU291cmNlLFxufSBmcm9tICcuLi91dGlscy9zZXR0aW5ncy9zZXR0aW5ncy5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgU2VsZWN0TXVsdGkgfSBmcm9tICcuL0N1c3RvbVNlbGVjdC9TZWxlY3RNdWx0aS5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4vZGVzaWduLXN5c3RlbS9CeWxpbmUuanMnXG5pbXBvcnQgeyBEaWFsb2cgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vRGlhbG9nLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vS2V5Ym9hcmRTaG9ydGN1dEhpbnQuanMnXG5pbXBvcnQgeyBNQ1BTZXJ2ZXJEaWFsb2dDb3B5IH0gZnJvbSAnLi9NQ1BTZXJ2ZXJEaWFsb2dDb3B5LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBzZXJ2ZXJOYW1lczogc3RyaW5nW11cbiAgb25Eb25lKCk6IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIE1DUFNlcnZlck11bHRpc2VsZWN0RGlhbG9nKHtcbiAgc2VydmVyTmFtZXMsXG4gIG9uRG9uZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgZnVuY3Rpb24gb25TdWJtaXQoc2VsZWN0ZWRTZXJ2ZXJzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IGN1cnJlbnRTZXR0aW5ncyA9IGdldFNldHRpbmdzX0RFUFJFQ0FURUQoKSB8fCB7fVxuICAgIGNvbnN0IGVuYWJsZWRTZXJ2ZXJzID0gY3VycmVudFNldHRpbmdzLmVuYWJsZWRNY3Bqc29uU2VydmVycyB8fCBbXVxuICAgIGNvbnN0IGRpc2FibGVkU2VydmVycyA9IGN1cnJlbnRTZXR0aW5ncy5kaXNhYmxlZE1jcGpzb25TZXJ2ZXJzIHx8IFtdXG5cbiAgICAvLyBVc2UgcGFydGl0aW9uIHRvIHNlcGFyYXRlIGFwcHJvdmVkIGFuZCByZWplY3RlZCBzZXJ2ZXJzXG4gICAgY29uc3QgW2FwcHJvdmVkU2VydmVycywgcmVqZWN0ZWRTZXJ2ZXJzXSA9IHBhcnRpdGlvbihzZXJ2ZXJOYW1lcywgc2VydmVyID0+XG4gICAgICBzZWxlY3RlZFNlcnZlcnMuaW5jbHVkZXMoc2VydmVyKSxcbiAgICApXG5cbiAgICBsb2dFdmVudCgndGVuZ3VfbWNwX211bHRpZGlhbG9nX2Nob2ljZScsIHtcbiAgICAgIGFwcHJvdmVkOiBhcHByb3ZlZFNlcnZlcnMubGVuZ3RoLFxuICAgICAgcmVqZWN0ZWQ6IHJlamVjdGVkU2VydmVycy5sZW5ndGgsXG4gICAgfSlcblxuICAgIC8vIFVwZGF0ZSBzZXR0aW5ncyB3aXRoIGFwcHJvdmVkIHNlcnZlcnNcbiAgICBpZiAoYXBwcm92ZWRTZXJ2ZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG5ld0VuYWJsZWRTZXJ2ZXJzID0gW1xuICAgICAgICAuLi5uZXcgU2V0KFsuLi5lbmFibGVkU2VydmVycywgLi4uYXBwcm92ZWRTZXJ2ZXJzXSksXG4gICAgICBdXG4gICAgICB1cGRhdGVTZXR0aW5nc0ZvclNvdXJjZSgnbG9jYWxTZXR0aW5ncycsIHtcbiAgICAgICAgZW5hYmxlZE1jcGpzb25TZXJ2ZXJzOiBuZXdFbmFibGVkU2VydmVycyxcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHNldHRpbmdzIHdpdGggcmVqZWN0ZWQgc2VydmVyc1xuICAgIGlmIChyZWplY3RlZFNlcnZlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgbmV3RGlzYWJsZWRTZXJ2ZXJzID0gW1xuICAgICAgICAuLi5uZXcgU2V0KFsuLi5kaXNhYmxlZFNlcnZlcnMsIC4uLnJlamVjdGVkU2VydmVyc10pLFxuICAgICAgXVxuICAgICAgdXBkYXRlU2V0dGluZ3NGb3JTb3VyY2UoJ2xvY2FsU2V0dGluZ3MnLCB7XG4gICAgICAgIGRpc2FibGVkTWNwanNvblNlcnZlcnM6IG5ld0Rpc2FibGVkU2VydmVycyxcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgb25Eb25lKClcbiAgfVxuXG4gIC8vIEhhbmRsZSBFU0MgdG8gcmVqZWN0IGFsbCBzZXJ2ZXJzXG4gIGNvbnN0IGhhbmRsZUVzY1JlamVjdEFsbCA9IHVzZUNhbGxiYWNrKCgpID0+IHtcbiAgICBjb25zdCBjdXJyZW50U2V0dGluZ3MgPSBnZXRTZXR0aW5nc19ERVBSRUNBVEVEKCkgfHwge31cbiAgICBjb25zdCBkaXNhYmxlZFNlcnZlcnMgPSBjdXJyZW50U2V0dGluZ3MuZGlzYWJsZWRNY3Bqc29uU2VydmVycyB8fCBbXVxuXG4gICAgY29uc3QgbmV3RGlzYWJsZWRTZXJ2ZXJzID0gW1xuICAgICAgLi4ubmV3IFNldChbLi4uZGlzYWJsZWRTZXJ2ZXJzLCAuLi5zZXJ2ZXJOYW1lc10pLFxuICAgIF1cblxuICAgIHVwZGF0ZVNldHRpbmdzRm9yU291cmNlKCdsb2NhbFNldHRpbmdzJywge1xuICAgICAgZGlzYWJsZWRNY3Bqc29uU2VydmVyczogbmV3RGlzYWJsZWRTZXJ2ZXJzLFxuICAgIH0pXG5cbiAgICBvbkRvbmUoKVxuICB9LCBbc2VydmVyTmFtZXMsIG9uRG9uZV0pXG5cbiAgcmV0dXJuIChcbiAgICA8PlxuICAgICAgPERpYWxvZ1xuICAgICAgICB0aXRsZT17YCR7c2VydmVyTmFtZXMubGVuZ3RofSBuZXcgTUNQIHNlcnZlcnMgZm91bmQgaW4gLm1jcC5qc29uYH1cbiAgICAgICAgc3VidGl0bGU9XCJTZWxlY3QgYW55IHlvdSB3aXNoIHRvIGVuYWJsZS5cIlxuICAgICAgICBjb2xvcj1cIndhcm5pbmdcIlxuICAgICAgICBvbkNhbmNlbD17aGFuZGxlRXNjUmVqZWN0QWxsfVxuICAgICAgICBoaWRlSW5wdXRHdWlkZVxuICAgICAgPlxuICAgICAgICA8TUNQU2VydmVyRGlhbG9nQ29weSAvPlxuXG4gICAgICAgIDxTZWxlY3RNdWx0aVxuICAgICAgICAgIG9wdGlvbnM9e3NlcnZlck5hbWVzLm1hcChzZXJ2ZXIgPT4gKHtcbiAgICAgICAgICAgIGxhYmVsOiBzZXJ2ZXIsXG4gICAgICAgICAgICB2YWx1ZTogc2VydmVyLFxuICAgICAgICAgIH0pKX1cbiAgICAgICAgICBkZWZhdWx0VmFsdWU9e3NlcnZlck5hbWVzfVxuICAgICAgICAgIG9uU3VibWl0PXtvblN1Ym1pdH1cbiAgICAgICAgICBvbkNhbmNlbD17aGFuZGxlRXNjUmVqZWN0QWxsfVxuICAgICAgICAgIGhpZGVJbmRleGVzXG4gICAgICAgIC8+XG4gICAgICA8L0RpYWxvZz5cbiAgICAgIDxCb3ggcGFkZGluZ1g9ezF9PlxuICAgICAgICA8VGV4dCBkaW1Db2xvciBpdGFsaWM+XG4gICAgICAgICAgPEJ5bGluZT5cbiAgICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIlNwYWNlXCIgYWN0aW9uPVwic2VsZWN0XCIgLz5cbiAgICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwiY29uZmlybVwiIC8+XG4gICAgICAgICAgICA8Q29uZmlndXJhYmxlU2hvcnRjdXRIaW50XG4gICAgICAgICAgICAgIGFjdGlvbj1cImNvbmZpcm06bm9cIlxuICAgICAgICAgICAgICBjb250ZXh0PVwiQ29uZmlybWF0aW9uXCJcbiAgICAgICAgICAgICAgZmFsbGJhY2s9XCJFc2NcIlxuICAgICAgICAgICAgICBkZXNjcmlwdGlvbj1cInJlamVjdCBhbGxcIlxuICAgICAgICAgICAgLz5cbiAgICAgICAgICA8L0J5bGluZT5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgPC8+XG4gIClcbn1cbiJd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LE9BQU8sQ0FBUSxNQUFTLENBQVQsU0FBUyxHQUN2RCxDQUFDLHdCQUF3QixDQUNoQixNQUFZLENBQVosWUFBWSxDQUNYLE9BQWMsQ0FBZCxjQUFjLENBQ2IsUUFBSyxDQUFMLEtBQUssQ0FDRixXQUFZLENBQVosWUFBWSxHQUU1QixFQVRDLE1BQU0sQ0FVVCxFQVhDLElBQUksQ0FZUCxFQWJDLEdBQUcsQ0FhRTtJQUFBbEMsQ0FBQSxPQUFBa0MsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWxDLENBQUE7RUFBQTtFQUFBLElBQUFtQyxFQUFBO0VBQUEsSUFBQW5DLENBQUEsU0FBQWlDLEVBQUE7SUFsQ1JFLEVBQUEsS0FDRSxDQUFBRixFQW1CUSxDQUNSLENBQUFDLEVBYUssQ0FBQyxHQUNMO0lBQUFsQyxDQUFBLE9BQUFpQyxFQUFBO0lBQUFqQyxDQUFBLE9BQUFtQyxFQUFE7RUFBQTtJQUFBQSxFQUFBLEdBQUFuQyxDQUFBO0VBQUE7RUFBQSxPQW5DSG1DLEVBbUNHO0FBQUE7QUE5RkEsU0FBQUosTUFBQUssUUFBQTtFQUFBLE9Bc0V1QztJQUFBQyxLQUFBLEVBQzNCekIsUUFBTTtJQUFBMEIsS0FBQSxFQUNOMUI7RUFDVCxDQUFDO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=
