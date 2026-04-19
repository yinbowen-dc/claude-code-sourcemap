/**
 * MemoryUpdateNotification.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件属于内存（Memory）功能模块，在用户执行 /memory 相关命令后，
 * 向用户展示"记忆文件已更新"的通知提示。
 * 位于：Claude Code 主界面 → 消息列表 → 【Memory 更新通知行】
 *
 * 【主要功能】
 * 1. getRelativeMemoryPath(path)：将绝对路径转换为相对路径（相对于 home 目录或当前工作目录），
 *    并选择更短的表示方式展示给用户。
 * 2. MemoryUpdateNotification 组件：渲染一行提示文本，
 *    显示"Memory updated in <相对路径> · /memory to edit"。
 */
import { c as _c } from "react/compiler-runtime";
import { homedir } from 'os';
import { relative } from 'path';
import React from 'react';
import { Box, Text } from '../../ink.js';
import { getCwd } from '../../utils/cwd.js';

/**
 * getRelativeMemoryPath
 *
 * 【整体流程】
 * 1. 获取系统 home 目录和当前工作目录（cwd）
 * 2. 计算 path 相对于 home 的表示（以 ~ 开头）
 * 3. 计算 path 相对于 cwd 的表示（以 ./ 开头）
 * 4. 若两者均存在，返回字符串更短的那个；若只有一个，直接返回；
 *    若均不适用，返回原始绝对路径
 *
 * 【设计意图】
 * 在终端界面显示内存文件路径时，尽量使用简短的相对路径，
 * 提升可读性，避免展示冗长的绝对路径。
 */
export function getRelativeMemoryPath(path: string): string {
  // 获取操作系统 home 目录
  const homeDir = homedir();
  // 获取当前工作目录
  const cwd = getCwd();

  // Calculate relative paths
  // 若路径以 home 目录开头，生成 ~/xxx 形式；否则为 null
  const relativeToHome = path.startsWith(homeDir) ? '~' + path.slice(homeDir.length) : null;
  // 若路径以 cwd 开头，生成 ./xxx 形式；否则为 null
  const relativeToCwd = path.startsWith(cwd) ? './' + relative(cwd, path) : null;

  // Return the shorter path, or absolute if neither is applicable
  // 两者均可用时，返回更短的一个
  if (relativeToHome && relativeToCwd) {
    return relativeToHome.length <= relativeToCwd.length ? relativeToHome : relativeToCwd;
  }
  // 只有一个可用或均不可用时，按优先级返回
  return relativeToHome || relativeToCwd || path;
}

/**
 * MemoryUpdateNotification 组件
 *
 * 【整体流程】
 * 1. 接收 memoryPath 属性（内存文件的绝对路径）
 * 2. 使用 _c(4) 创建 4 槽缓存数组
 * 3. 若 memoryPath 变化，重新调用 getRelativeMemoryPath 计算 displayPath 并缓存（槽 0/1）
 * 4. 若 displayPath 变化，重新构建 JSX 节点并缓存（槽 2/3）
 * 5. 返回包含更新通知文本的 Box 容器
 *
 * 【设计意图】
 * 通过两级缓存（路径计算缓存 + JSX 节点缓存）避免不必要的重新渲染，
 * 提升性能。
 */
export function MemoryUpdateNotification(t0) {
  // React Compiler 生成的 4 槽缓存数组
  const $ = _c(4);
  // 解构获取 memoryPath 属性
  const {
    memoryPath
  } = t0;
  let t1;
  // 若 memoryPath 发生变化，重新计算相对路径并更新缓存槽 0/1
  if ($[0] !== memoryPath) {
    t1 = getRelativeMemoryPath(memoryPath);
    $[0] = memoryPath; // 缓存新的 memoryPath
    $[1] = t1;         // 缓存计算结果
  } else {
    // memoryPath 未变，直接取缓存值
    t1 = $[1];
  }
  // 将计算所得相对路径赋给 displayPath
  const displayPath = t1;
  let t2;
  // 若 displayPath 发生变化，重新构建 JSX 并更新缓存槽 2/3
  if ($[2] !== displayPath) {
    // 渲染"Memory updated in <路径> · /memory to edit"提示文本
    t2 = <Box flexDirection="column" flexGrow={1}><Text color="text">Memory updated in {displayPath} · /memory to edit</Text></Box>;
    $[2] = displayPath; // 缓存新的 displayPath
    $[3] = t2;          // 缓存新的 JSX 节点
  } else {
    // displayPath 未变，直接取缓存 JSX
    t2 = $[3];
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJob21lZGlyIiwicmVsYXRpdmUiLCJSZWFjdCIsIkJveCIsIlRleHQiLCJnZXRDd2QiLCJnZXRSZWxhdGl2ZU1lbW9yeVBhdGgiLCJwYXRoIiwiaG9tZURpciIsImN3ZCIsInJlbGF0aXZlVG9Ib21lIiwic3RhcnRzV2l0aCIsInNsaWNlIiwibGVuZ3RoIiwicmVsYXRpdmVUb0N3ZCIsIk1lbW9yeVVwZGF0ZU5vdGlmaWNhdGlvbiIsInQwIiwiJCIsIl9jIiwibWVtb3J5UGF0aCIsInQxIiwiZGlzcGxheVBhdGgiLCJ0MiJdLCJzb3VyY2VzIjpbIk1lbW9yeVVwZGF0ZU5vdGlmaWNhdGlvbi50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ29zJ1xuaW1wb3J0IHsgcmVsYXRpdmUgfSBmcm9tICdwYXRoJ1xuaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnLi4vLi4vdXRpbHMvY3dkLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVsYXRpdmVNZW1vcnlQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGhvbWVEaXIgPSBob21lZGlyKClcbiAgY29uc3QgY3dkID0gZ2V0Q3dkKClcblxuICAvLyBDYWxjdWxhdGUgcmVsYXRpdmUgcGF0aHNcbiAgY29uc3QgcmVsYXRpdmVUb0hvbWUgPSBwYXRoLnN0YXJ0c1dpdGgoaG9tZURpcilcbiAgICA/ICd+JyArIHBhdGguc2xpY2UoaG9tZURpci5sZW5ndGgpXG4gICAgOiBudWxsXG5cbiAgY29uc3QgcmVsYXRpdmVUb0N3ZCA9IHBhdGguc3RhcnRzV2l0aChjd2QpID8gJy4vJyArIHJlbGF0aXZlKGN3ZCwgcGF0aCkgOiBudWxsXG5cbiAgLy8gUmV0dXJuIHRoZSBzaG9ydGVyIHBhdGgsIG9yIGFic29sdXRlIGlmIG5laXRoZXIgaXMgYXBwbGljYWJsZVxuICBpZiAocmVsYXRpdmVUb0hvbWUgJiYgcmVsYXRpdmVUb0N3ZCkge1xuICAgIHJldHVybiByZWxhdGl2ZVRvSG9tZS5sZW5ndGggPD0gcmVsYXRpdmVUb0N3ZC5sZW5ndGhcbiAgICAgID8gcmVsYXRpdmVUb0hvbWVcbiAgICAgIDogcmVsYXRpdmVUb0N3ZFxuICB9XG5cbiAgcmV0dXJuIHJlbGF0aXZlVG9Ib21lIHx8IHJlbGF0aXZlVG9Dd2QgfHwgcGF0aFxufVxuXG5leHBvcnQgZnVuY3Rpb24gTWVtb3J5VXBkYXRlTm90aWZpY2F0aW9uKHtcbiAgbWVtb3J5UGF0aCxcbn06IHtcbiAgbWVtb3J5UGF0aDogc3RyaW5nXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgZGlzcGxheVBhdGggPSBnZXRSZWxhdGl2ZU1lbW9yeVBhdGgobWVtb3J5UGF0aClcblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIGZsZXhHcm93PXsxfT5cbiAgICAgIDxUZXh0IGNvbG9yPVwidGV4dFwiPlxuICAgICAgICBNZW1vcnkgdXBkYXRlZCBpbiB7ZGlzcGxheVBhdGh9IMK3IC9tZW1vcnkgdG8gZWRpdFxuICAgICAgPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTQSxPQUFPLFFBQVEsSUFBSTtBQUM1QixTQUFTQyxRQUFRLFFBQVEsTUFBTTtBQUMvQixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLFNBQVNDLE1BQU0sUUFBUSxvQkFBb0I7QUFFM0MsT0FBTyxTQUFTQyxxQkFBcUJBLENBQUNDLElBQUksRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUM7RUFDbEUsTUFBTUMsT0FBTyxHQUFHUixPQUFPLENBQUMsQ0FBQztFQUN6QixNQUFNUyxHQUFHLEdBQUdKLE1BQU0sQ0FBQyxDQUFDOztFQUVwQjtFQUNBLE1BQU1LLGNBQWMsR0FBR0gsSUFBSSxDQUFDSSxVQUFVLENBQUNILE9BQU8sQ0FBQyxHQUMzQyxHQUFHLEdBQUdELElBQUksQ0FBQ0ssS0FBSyxDQUFDSixPQUFPLENBQUNLLE1BQU0sQ0FBQyxHQUNoQyxJQUFJO0VBRVIsTUFBTUMsYUFBYSxHQUFHUCxJQUFJLENBQUNJLFVBQVUsQ0FBQ0YsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHUixRQUFRLENBQUNRLEdBQUcsRUFBRUYsSUFBSSxDQUFDLEdBQUcsSUFBSTs7RUFFOUU7RUFDQSxJQUFJRyxjQUFjLElBQUlJLGFBQWEsRUFBRTtJQUNuQyxPQUFPSixjQUFjLENBQUNHLE1BQU0sSUFBSUMsYUFBYSxDQUFDRCxNQUFNLEdBQ2hESCxjQUFjLEdBQ2RJLGFBQWE7RUFDbkI7RUFFQSxPQUFPSixjQUFjLElBQUlJLGFBQWEsSUFBSVAsSUFBSTtBQUNoRDtBQUVBLE9BQU8sU0FBQVEseUJBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBa0M7SUFBQUM7RUFBQSxJQUFBSCxFQUl4QztFQUFBLElBQUFJLEVBQUE7RUFBQSxJQUFBSCxDQUFBLFFBQUFFLFVBQUE7SUFDcUJDLEVBQUEsR0FBQWQscUJBQXFCLENBQUNhLFVBQVUsQ0FBQztJQUFBRixDQUFBLE1BQUFFLE1BQUFSO0lBQUFGLENBQUEsTUFBQUcsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUgsQ0FBQTtFQUFBO0VBQXJELEtBQUFJLFdBQUEsR0FBb0JELEVBQWlDO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFMLENBQUEsUUFBQUksV0FBQTtJQUduREMsRUFBQSxJQUFDLEdBQUcsQ0FBZSxhQUFRLENBQVIsUUFBUSxDQUFXLFFBQUMsQ0FBRCxHQUFDLENBQ3JDLENBQUMsSUFBSSxDQUFPLEtBQU0sQ0FBTixNQUFNLENBQUMsa0JBQ0VELFlBQVUsQ0FBRSxrQkFDakMsRUFGQyxJQUFJLENBR1AsRUFKQyxHQUFHLENBSUU7SUFBQUosQ0FBQSxNQUFBSSxXQUFBO0lBQUFKLENBQUEsTUFBQUssRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUwsQ0FBQTtFQUFBO0VBQUEsT0FKTkssRUFJTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
