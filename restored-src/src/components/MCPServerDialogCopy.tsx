/**
 * MCPServerDialogCopy.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 MCP 服务器审批对话框的风险说明子组件。
 * 它被 MCPServerApprovalDialog 和 MCPServerMultiselectDialog 复用，
 * 作为所有 MCP 审批场景中统一展示的安全提示文本。
 * 位于：MCP 审批对话框内容区 → 【风险说明文本】→ 选项选择器
 *
 * 【主要功能】
 * 渲染一段静态提示文本：告知用户 MCP 服务器可能执行代码或访问系统资源，
 * 所有工具调用需要用户审批，并提供 MCP 文档的可点击链接。
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Link, Text } from '../ink.js';

/**
 * MCPServerDialogCopy 组件
 *
 * 【整体流程】
 * 1. 无 props 输入，内容完全静态
 * 2. 使用 React Compiler 的 _c(1) 单槽缓存：首次渲染时创建 JSX 节点，
 *    后续渲染直接取缓存，避免重复创建静态内容
 * 3. 返回包含内联链接的纯文本节点
 *
 * 【设计意图】
 * 将安全说明文本抽离为独立组件，便于在多个 MCP 对话框中统一复用，
 * 保证风险告知信息的一致性。
 */
export function MCPServerDialogCopy() {
  // React Compiler 生成的单槽缓存数组
  const $ = _c(1);
  let t0;
  // 首次渲染时（缓存为 sentinel 值），创建静态 JSX 节点并存入缓存
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // 渲染风险说明：MCP 服务器可能执行代码，附 MCP 文档链接
    t0 = <Text>MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the{" "}<Link url="https://code.claude.com/docs/en/mcp">MCP documentation</Link>.</Text>;
    $[0] = t0; // 存入缓存，后续渲染直接复用
  } else {
    // 缓存命中，直接返回已创建的节点
    t0 = $[0];
  }
  return t0;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkxpbmsiLCJUZXh0IiwiTUNQU2VydmVyRGlhbG9nQ29weSIsIiQiLCJfYyIsInQwIiwiU3ltYm9sIiwiZm9yIl0sInNvdXJjZXMiOlsiTUNQU2VydmVyRGlhbG9nQ29weS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgTGluaywgVGV4dCB9IGZyb20gJy4uL2luay5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIE1DUFNlcnZlckRpYWxvZ0NvcHkoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8VGV4dD5cbiAgICAgIE1DUCBzZXJ2ZXJzIG1heSBleGVjdXRlIGNvZGUgb3IgYWNjZXNzIHN5c3RlbSByZXNvdXJjZXMuIEFsbCB0b29sIGNhbGxzXG4gICAgICByZXF1aXJlIGFwcHJvdmFsLiBMZWFybiBtb3JlIGluIHRoZXsnICd9XG4gICAgICA8TGluayB1cmw9XCJodHRwczovL2NvZGUuY2xhdWRlLmNvbS9kb2NzL2VuL21jcFwiPk1DUCBkb2N1bWVudGF0aW9uPC9MaW5rPi5cbiAgICA8L1RleHQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssTUFBTSxPQUFPO0FBQ3pCLFNBQVNDLElBQUksRUFBRUMsSUFBSSxRQUFRLFdBQVc7QUFFdEMsT0FBTyxTQUFBQyxvQkFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBRixDQUFBLFFBQUFHLE1BQUEsQ0FBQUMsR0FBQTtJQUVIRixFQUFBLElBQUMsSUFBSSxDQUFDLDJHQUVnQyxJQUFFLENBQ3RDLENBQUMsSUFBSSxDQUFLLEdBQXFDLENBQXJDLHFDQUFxQyxDQUFDLGlCQUFpQixFQUFoRSxJQUFJLENBQW1FLENBQzFFLEVBSkMsSUFBSSxDQUlFO0lBQUFGLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBQUEsT0FKUEUsRUFJTztBQUFBIiwiaWdub3JlTGlzdCI6W119
