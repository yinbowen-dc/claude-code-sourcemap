/**
 * FilePathLink.tsx — 文件路径超链接组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具输出层 → 文件路径渲染 → OSC 8 终端超链接封装
 *
 * 主要功能：
 *   将绝对文件路径转换为 OSC 8 协议的可点击超链接，
 *   使支持该协议的终端（如 iTerm2、WezTerm）能正确识别并渲染文件路径为链接，
 *   即使路径出现在括号或其他文本包围的场景中也能被正确解析。
 *
 *   - filePath：必须是绝对路径（如 /Users/xxx/project/file.ts）
 *   - children：可选显示文本，默认展示 filePath 本身
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { pathToFileURL } from 'url';
import Link from '../ink/components/Link.js';

// 组件 Props 类型：filePath 为必填绝对路径，children 为可选显示内容
type Props = {
  /** The absolute file path */
  filePath: string;
  /** Optional display text (defaults to filePath) */
  children?: React.ReactNode;
};

/**
 * FilePathLink 组件
 *
 * 整体流程：
 *   1. 接收 filePath（绝对路径）和可选的 children（显示文本）
 *   2. 使用 Node.js 内置 pathToFileURL 将路径转为 file:// URL，
 *      这是 OSC 8 超链接要求的格式（需要 URL scheme）
 *   3. 将转换后的 URL 传给 Ink 的 Link 组件，
 *      Link 组件负责生成终端 OSC 8 转义序列
 *   4. 显示文本优先使用 children，若未提供则回退到原始 filePath
 *
 * 为何要做这层转换：
 *   终端在文本中识别超链接时，普通路径（不带 scheme）可能被括号截断；
 *   使用 file:// URL 则能让终端精准识别链接范围。
 *
 * 在系统中的角色：
 *   供工具输出（如 FileEditTool、ReadTool 等）使用，
 *   让用户可以在支持的终端中直接点击跳转到相关文件。
 */
export function FilePathLink(t0) {
  // _c(5)：React 编译器记忆缓存，共 5 个槽位，用于避免重复计算
  const $ = _c(5);
  const {
    filePath,
    children
  } = t0;

  // 槽位 $[0]/$[1]：缓存 filePath → URL 的转换结果
  // 只有当 filePath 变化时才重新调用 pathToFileURL（避免重复解析）
  let t1;
  if ($[0] !== filePath) {
    // filePath 已变化，重新将绝对路径转为 file:// URL 对象
    t1 = pathToFileURL(filePath);
    $[0] = filePath;  // 更新缓存键
    $[1] = t1;        // 缓存 URL 对象
  } else {
    // filePath 未变化，直接取缓存中的 URL 对象
    t1 = $[1];
  }

  // 确定显示文本：优先使用 children，未提供则展示原始路径字符串
  const t2 = children ?? filePath;

  // 槽位 $[2]/$[3]/$[4]：缓存最终 JSX，依赖 URL href 和显示文本
  let t3;
  if ($[2] !== t1.href || $[3] !== t2) {
    // URL 或显示文本发生变化，重新创建 Link 元素
    // t1.href 是 file:// 形式的字符串，如 "file:///Users/xxx/file.ts"
    t3 = <Link url={t1.href}>{t2}</Link>;
    $[2] = t1.href;  // 缓存 URL href
    $[3] = t2;       // 缓存显示文本
    $[4] = t3;       // 缓存 JSX 元素
  } else {
    // 依赖未变，直接复用已缓存的 JSX
    t3 = $[4];
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInBhdGhUb0ZpbGVVUkwiLCJMaW5rIiwiUHJvcHMiLCJmaWxlUGF0aCIsImNoaWxkcmVuIiwiUmVhY3ROb2RlIiwiRmlsZVBhdGhMaW5rIiwidDAiLCIkIiwiX2MiLCJ0MSIsInQyIiwidDMiLCJocmVmIl0sInNvdXJjZXMiOlsiRmlsZVBhdGhMaW5rLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAndXJsJ1xuaW1wb3J0IExpbmsgZnJvbSAnLi4vaW5rL2NvbXBvbmVudHMvTGluay5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgLyoqIFRoZSBhYnNvbHV0ZSBmaWxlIHBhdGggKi9cbiAgZmlsZVBhdGg6IHN0cmluZ1xuICAvKiogT3B0aW9uYWwgZGlzcGxheSB0ZXh0IChkZWZhdWx0cyB0byBmaWxlUGF0aCkgKi9cbiAgY2hpbGRyZW4/OiBSZWFjdC5SZWFjdE5vZGVcbn1cblxuLyoqXG4gKiBSZW5kZXJzIGEgZmlsZSBwYXRoIGFzIGFuIE9TQyA4IGh5cGVybGluay5cbiAqIFRoaXMgaGVscHMgdGVybWluYWxzIGxpa2UgaVRlcm0gY29ycmVjdGx5IGlkZW50aWZ5IGZpbGUgcGF0aHNcbiAqIGV2ZW4gd2hlbiB0aGV5IGFwcGVhciBpbnNpZGUgcGFyZW50aGVzZXMgb3Igb3RoZXIgdGV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIEZpbGVQYXRoTGluayh7IGZpbGVQYXRoLCBjaGlsZHJlbiB9OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiA8TGluayB1cmw9e3BhdGhUb0ZpbGVVUkwoZmlsZVBhdGgpLmhyZWZ9PntjaGlsZHJlbiA/PyBmaWxlUGF0aH08L0xpbms+XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxhQUFhLFFBQVEsS0FBSztBQUNuQyxPQUFPQyxJQUFJLE1BQU0sMkJBQTJCO0FBRTVDLEtBQUtDLEtBQUssR0FBRztFQUNYO0VBQ0FDLFFBQVEsRUFBRSxNQUFNO0VBQ2hCO0VBQ0FDLFFBQVEsQ0FBQyxFQUFFTCxLQUFLLENBQUNNLFNBQVM7QUFDNUIsQ0FBQzs7QUFFRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsT0FBTyxTQUFBQyxhQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQXNCO0lBQUFOLFFBQUE7SUFBQUM7RUFBQSxJQUFBRyxFQUE2QjtFQUFBLElBQUFGLEVBQUE7RUFBQSxJQUFBRixDQUFBLFFBQUFMLFFBQUE7SUFDdENPLEVBQUEsR0FBQVYsYUFBYSxDQUFDRyxRQUFRLENBQUM7SUFBQUssQ0FBQSxNQUFBTCxRQUFBO0lBQUFLLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBQVEsTUFBQUcsRUFBQSxHQUFBUCxRQUFvQixJQUFwQkQsUUFBb0I7RUFBQSxJQUFBUyxFQUFBO0VBQUEsSUFBQUosQ0FBQSxRQUFBRSxFQUFBLENBQUFHLElBQUEsSUFBQUwsQ0FBQSxRQUFBRyxFQUFBO0lBQTlEQyxFQUFBLElBQUMsSUFBSSxDQUFNLEdBQTRCLENBQTVCLENBQUFGLEVBQXVCLENBQUFHLElBQUksQ0FBQyxDQUFHLENBQUFGLEVBQW1CLENBQUUsRUFBOUQsSUFBSSxDQUFpRTtJQUFBSCxDQUFBLE1BQUFFLEVBQUEsQ0FBQUcsSUFBQTtJQUFBTCxDQUFBLE1BQUFHLEVBQUE7SUFBQUgsQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFBQSxPQUF0RUksRUFBc0U7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
