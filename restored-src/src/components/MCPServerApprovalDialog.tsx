/**
 * MCPServerApprovalDialog.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 MCP（模型上下文协议）服务器权限审批流程的入口组件。
 * 当 Claude Code 在项目根目录的 .mcp.json 文件中发现一个新的 MCP 服务器时，
 * 会弹出此对话框，要求用户确认是否启用该服务器。
 * 它处于：MCP 配置发现 → 【审批对话框】→ 设置持久化 → 服务器启动 的链路中。
 *
 * 【主要功能】
 * 1. 展示警告对话框，告知用户发现了新的 MCP 服务器
 * 2. 提供三种选择：启用所有项目服务器 / 仅启用本服务器 / 跳过
 * 3. 将用户选择持久化到本地设置（enabledMcpjsonServers / disabledMcpjsonServers）
 * 4. 通过 logEvent 上报用户选择行为到分析系统
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';

// 组件 Props 类型定义
type Props = {
  serverName: string; // 新发现的 MCP 服务器名称
  onDone(): void;     // 用户完成选择后的回调函数
};

/**
 * MCPServerApprovalDialog 组件
 *
 * 【整体流程】
 * 1. 接收 serverName（服务器名）和 onDone（完成回调）作为 props
 * 2. 内部构建 onChange 处理函数，响应用户的三种选择
 * 3. 渲染 Dialog 容器，内含风险说明文本（MCPServerDialogCopy）和选项列表（Select）
 * 4. 用户选择后更新本地设置并调用 onDone 关闭对话框
 *
 * 【React Compiler 缓存说明】
 * 使用 _c(13) 创建 13 个缓存槽位，对 onChange 函数、JSX 节点、选项列表等进行细粒度缓存，
 * 避免因 props 未变化而导致的不必要重渲染。
 */
export function MCPServerApprovalDialog(t0) {
  // React Compiler 生成的缓存数组，共 13 个槽位
  const $ = _c(13);
  const {
    serverName,
    onDone
  } = t0;

  // ---- 层 1：缓存 onChange 回调 ----
  // 仅当 onDone 或 serverName 发生变化时重新创建 onChange 函数
  let t1;
  if ($[0] !== onDone || $[1] !== serverName) {
    /**
     * onChange 内部处理函数
     *
     * 【流程】
     * 1. 先通过 logEvent 上报用户的选择（'yes' / 'yes_all' / 'no'）到分析系统
     * 2. 根据选择值进入不同分支：
     *    - 'yes' / 'yes_all'：将服务器加入启用列表；若为 yes_all 则还开启全局启用标志
     *    - 'no'：将服务器加入禁用列表
     * 3. 任意分支最终调用 onDone() 关闭对话框
     */
    t1 = function onChange(value) {
      // 上报用户选择事件到分析服务
      logEvent("tengu_mcp_dialog_choice", {
        choice: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });

      // bb2 是编译器生成的带标签 switch，用于支持 break 跳出
      bb2: switch (value) {
        case "yes":
        case "yes_all":
          {
            // 读取当前设置，获取已启用的服务器列表（若无则默认为空数组）
            const currentSettings_0 = getSettings_DEPRECATED() || {};
            const enabledServers = currentSettings_0.enabledMcpjsonServers || [];

            // 避免重复添加：仅当服务器名不在已启用列表中时才更新
            if (!enabledServers.includes(serverName)) {
              updateSettingsForSource("localSettings", {
                enabledMcpjsonServers: [...enabledServers, serverName] // 追加新服务器名
              });
            }

            // 若用户选择"启用所有项目 MCP 服务器"，额外设置全局标志
            if (value === "yes_all") {
              updateSettingsForSource("localSettings", {
                enableAllProjectMcpServers: true // 开启全局自动启用标志
              });
            }
            onDone(); // 完成处理，关闭对话框
            break bb2;
          }
        case "no":
          {
            // 读取当前设置，获取已禁用的服务器列表（若无则默认为空数组）
            const currentSettings = getSettings_DEPRECATED() || {};
            const disabledServers = currentSettings.disabledMcpjsonServers || [];

            // 避免重复添加：仅当服务器名不在已禁用列表中时才更新
            if (!disabledServers.includes(serverName)) {
              updateSettingsForSource("localSettings", {
                disabledMcpjsonServers: [...disabledServers, serverName] // 追加被拒绝的服务器名
              });
            }
            onDone(); // 完成处理，关闭对话框
          }
      }
    };
    // 更新缓存
    $[0] = onDone;
    $[1] = serverName;
    $[2] = t1;
  } else {
    // 依赖未变化，直接取缓存
    t1 = $[2];
  }
  const onChange = t1;

  // 构建对话框标题，将服务器名嵌入标题字符串
  const t2 = `New MCP server found in .mcp.json: ${serverName}`;

  // ---- 缓存取消处理函数（ESC 键 → 视为 'no'）----
  let t3;
  if ($[3] !== onChange) {
    t3 = () => onChange("no"); // 按 ESC 等同于选择"不启用"
    $[3] = onChange;
    $[4] = t3;
  } else {
    t3 = $[4];
  }

  // ---- 缓存风险说明文本组件（内容固定，无 props，只需创建一次）----
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <MCPServerDialogCopy />; // 显示 MCP 风险说明和文档链接
    $[5] = t4;
  } else {
    t4 = $[5];
  }

  // ---- 缓存选项列表（静态数据，只需创建一次）----
  let t5;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = [{
      label: "Use this and all future MCP servers in this project", // 启用本项目所有 MCP 服务器
      value: "yes_all"
    }, {
      label: "Use this MCP server",                                 // 仅启用当前这个服务器
      value: "yes"
    }, {
      label: "Continue without using this MCP server",             // 跳过，不启用
      value: "no"
    }];
    $[6] = t5;
  } else {
    t5 = $[6];
  }

  // ---- 缓存 Select 组件（依赖 onChange，onChange 变化时重建）----
  let t6;
  if ($[7] !== onChange) {
    t6 = <Select options={t5} onChange={value_0 => onChange(value_0 as 'yes_all' | 'yes' | 'no')} onCancel={() => onChange("no")} />;
    $[7] = onChange;
    $[8] = t6;
  } else {
    t6 = $[8];
  }

  // ---- 缓存最终 Dialog JSX（依赖 title、onCancel、Select 三个节点）----
  let t7;
  if ($[9] !== t2 || $[10] !== t3 || $[11] !== t6) {
    // 渲染警告级别的 Dialog，包含风险说明和选项选择器
    t7 = <Dialog title={t2} color="warning" onCancel={t3}>{t4}{t6}</Dialog>;
    $[9] = t2;
    $[10] = t3;
    $[11] = t6;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMiLCJsb2dFdmVudCIsImdldFNldHRpbmdzX0RFUFJFQ0FURUQiLCJ1cGRhdGVTZXR0aW5nc0ZvclNvdXJjZSIsIlNlbGVjdCIsIkRpYWxvZyIsIk1DUFNlcnZlckRpYWxvZ0NvcHkiLCJQcm9wcyIsInNlcnZlck5hbWUiLCJvbkRvbmUiLCJNQ1BTZXJ2ZXJBcHByb3ZhbERpYWxvZyIsInQwIiwiJCIsIl9jIiwidDEiLCJvbkNoYW5nZSIsInZhbHVlIiwiY2hvaWNlIiwiYmIyIiwiY3VycmVudFNldHRpbmdzXzAiLCJlbmFibGVkU2VydmVycyIsImN1cnJlbnRTZXR0aW5ncyIsImVuYWJsZWRNY3Bqc29uU2VydmVycyIsImluY2x1ZGVzIiwiZW5hYmxlQWxsUHJvamVjdE1jcFNlcnZlcnMiLCJkaXNhYmxlZFNlcnZlcnMiLCJkaXNhYmxlZE1jcGpzb25TZXJ2ZXJzIiwidDIiLCJ0MyIsInQ0IiwiU3ltYm9sIiwiZm9yIiwidDUiLCJsYWJlbCIsInQ2IiwidmFsdWVfMCIsInQ3Il0sInNvdXJjZXMiOlsiTUNQU2VydmVyQXBwcm92YWxEaWFsb2cudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7XG4gIHR5cGUgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgbG9nRXZlbnQsXG59IGZyb20gJ3NyYy9zZXJ2aWNlcy9hbmFseXRpY3MvaW5kZXguanMnXG5pbXBvcnQge1xuICBnZXRTZXR0aW5nc19ERVBSRUNBVEVELFxuICB1cGRhdGVTZXR0aW5nc0ZvclNvdXJjZSxcbn0gZnJvbSAnLi4vdXRpbHMvc2V0dGluZ3Mvc2V0dGluZ3MuanMnXG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuL0N1c3RvbVNlbGVjdC9pbmRleC5qcydcbmltcG9ydCB7IERpYWxvZyB9IGZyb20gJy4vZGVzaWduLXN5c3RlbS9EaWFsb2cuanMnXG5pbXBvcnQgeyBNQ1BTZXJ2ZXJEaWFsb2dDb3B5IH0gZnJvbSAnLi9NQ1BTZXJ2ZXJEaWFsb2dDb3B5LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBzZXJ2ZXJOYW1lOiBzdHJpbmdcbiAgb25Eb25lKCk6IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIE1DUFNlcnZlckFwcHJvdmFsRGlhbG9nKHtcbiAgc2VydmVyTmFtZSxcbiAgb25Eb25lLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBmdW5jdGlvbiBvbkNoYW5nZSh2YWx1ZTogJ3llcycgfCAneWVzX2FsbCcgfCAnbm8nKSB7XG4gICAgbG9nRXZlbnQoJ3Rlbmd1X21jcF9kaWFsb2dfY2hvaWNlJywge1xuICAgICAgY2hvaWNlOlxuICAgICAgICB2YWx1ZSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgIH0pXG5cbiAgICBzd2l0Y2ggKHZhbHVlKSB7XG4gICAgICBjYXNlICd5ZXMnOlxuICAgICAgY2FzZSAneWVzX2FsbCc6IHtcbiAgICAgICAgLy8gR2V0IGN1cnJlbnQgZW5hYmxlZCBzZXJ2ZXJzIGZyb20gc2V0dGluZ3NcbiAgICAgICAgY29uc3QgY3VycmVudFNldHRpbmdzID0gZ2V0U2V0dGluZ3NfREVQUkVDQVRFRCgpIHx8IHt9XG4gICAgICAgIGNvbnN0IGVuYWJsZWRTZXJ2ZXJzID0gY3VycmVudFNldHRpbmdzLmVuYWJsZWRNY3Bqc29uU2VydmVycyB8fCBbXVxuXG4gICAgICAgIC8vIEFkZCBzZXJ2ZXIgaWYgbm90IGFscmVhZHkgZW5hYmxlZFxuICAgICAgICBpZiAoIWVuYWJsZWRTZXJ2ZXJzLmluY2x1ZGVzKHNlcnZlck5hbWUpKSB7XG4gICAgICAgICAgdXBkYXRlU2V0dGluZ3NGb3JTb3VyY2UoJ2xvY2FsU2V0dGluZ3MnLCB7XG4gICAgICAgICAgICBlbmFibGVkTWNwanNvblNlcnZlcnM6IFsuLi5lbmFibGVkU2VydmVycywgc2VydmVyTmFtZV0sXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZSA9PT0gJ3llc19hbGwnKSB7XG4gICAgICAgICAgdXBkYXRlU2V0dGluZ3NGb3JTb3VyY2UoJ2xvY2FsU2V0dGluZ3MnLCB7XG4gICAgICAgICAgICBlbmFibGVBbGxQcm9qZWN0TWNwU2VydmVyczogdHJ1ZSxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICAgIG9uRG9uZSgpXG4gICAgICAgIGJyZWFrXG4gICAgICB9XG4gICAgICBjYXNlICdubyc6IHtcbiAgICAgICAgLy8gR2V0IGN1cnJlbnQgZGlzYWJsZWQgc2VydmVycyBmcm9tIHNldHRpbmdzXG4gICAgICAgIGNvbnN0IGN1cnJlbnRTZXR0aW5ncyA9IGdldFNldHRpbmdzX0RFUFJFQ0FURUQoKSB8fCB7fVxuICAgICAgICBjb25zdCBkaXNhYmxlZFNlcnZlcnMgPSBjdXJyZW50U2V0dGluZ3MuZGlzYWJsZWRNY3Bqc29uU2VydmVycyB8fCBbXVxuXG4gICAgICAgIC8vIEFkZCBzZXJ2ZXIgaWYgbm90IGFscmVhZHkgZGlzYWJsZWRcbiAgICAgICAgaWYgKCFkaXNhYmxlZFNlcnZlcnMuaW5jbHVkZXMoc2VydmVyTmFtZSkpIHtcbiAgICAgICAgICB1cGRhdGVTZXR0aW5nc0ZvclNvdXJjZSgnbG9jYWxTZXR0aW5ncycsIHtcbiAgICAgICAgICAgIGRpc2FibGVkTWNwanNvblNlcnZlcnM6IFsuLi5kaXNhYmxlZFNlcnZlcnMsIHNlcnZlck5hbWVdLFxuICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICAgICAgb25Eb25lKClcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxEaWFsb2dcbiAgICAgIHRpdGxlPXtgTmV3IE1DUCBzZXJ2ZXIgZm91bmQgaW4gLm1jcC5qc29uOiAke3NlcnZlck5hbWV9YH1cbiAgICAgIGNvbG9yPVwid2FybmluZ1wiXG4gICAgICBvbkNhbmNlbD17KCkgPT4gb25DaGFuZ2UoJ25vJyl9XG4gICAgPlxuICAgICAgPE1DUFNlcnZlckRpYWxvZ0NvcHkgLz5cblxuICAgICAgPFNlbGVjdFxuICAgICAgICBvcHRpb25zPXtbXG4gICAgICAgICAge1xuICAgICAgICAgICAgbGFiZWw6IGBVc2UgdGhpcyBhbmQgYWxsIGZ1dHVyZSBNQ1Agc2VydmVycyBpbiB0aGlzIHByb2plY3RgLFxuICAgICAgICAgICAgdmFsdWU6ICd5ZXNfYWxsJyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgbGFiZWw6IGBVc2UgdGhpcyBNQ1Agc2VydmVyYCwgdmFsdWU6ICd5ZXMnIH0sXG4gICAgICAgICAgeyBsYWJlbDogYENvbnRpbnVlIHdpdGhvdXQgdXNpbmcgdGhpcyBNQ1Agc2VydmVyYCwgdmFsdWU6ICdubycgfSxcbiAgICAgICAgXX1cbiAgICAgICAgb25DaGFuZ2U9e3ZhbHVlID0+IG9uQ2hhbmdlKHZhbHVlIGFzICd5ZXNfYWxsJyB8ICd5ZXMnIHwgJ25vJyl9XG4gICAgICAgIG9uQ2FuY2VsPXsoKSA9PiBvbkNoYW5nZSgnbm8nKX1cbiAgICAgIC8+XG4gICAgPC9EaWFsb2c+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssTUFBTSxPQUFPO0FBQ3pCLFNBQ0UsS0FBS0MsMERBQTBELEVBQy9EQyxRQUFRLFFBQ0gsaUNBQWlDO0FBQ3hDLFNBQ0VDLHNCQUFzQixFQUN0QkMsdUJBQXVCLFFBQ2xCLCtCQUErQjtBQUN0QyxTQUFTQyxNQUFNLFFBQVEseUJBQXlCO0FBQ2hELFNBQVNDLE1BQU0sUUFBUSwyQkFBMkI7QUFDbEQsU0FBU0MsbUJBQW1CLFFBQVEsMEJBQTBCO0FBRTlELEtBQUtDLEtBQUssR0FBRztFQUNYQyxVQUFVLEVBQUUsTUFBTTtFQUNsQkMsTUFBTSxFQUFFLEVBQUUsSUFBSTtBQUNoQixDQUFDO0FBRUQsT0FBTyxT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
