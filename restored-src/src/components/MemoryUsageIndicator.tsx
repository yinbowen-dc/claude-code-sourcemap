/**
 * MemoryUsageIndicator.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是内存使用量指示器组件，仅在 Anthropic 内部构建（USER_TYPE === 'ant'）中生效。
 * 当进程堆内存使用量达到"高"或"危急"状态时，在界面顶部展示内存警告提示。
 * 位于：Claude Code 主界面顶部状态栏 → 【内存使用量警告行】
 *
 * 【主要功能】
 * 1. 通过编译期常量 USER_TYPE 进行分支裁剪：外部构建直接返回 null，
 *    不会触发 useMemoryUsage hook 的定时轮询（10 秒一次）。
 * 2. 调用 useMemoryUsage() 获取当前堆内存状态（heapUsed、status）。
 * 3. 若 status 为 'normal'，不渲染任何内容；
 *    若为 'high' 或 'critical'，渲染带颜色的警告文本并提供 /heapdump 调试命令提示。
 */
import * as React from 'react';
import { useMemoryUsage } from '../hooks/useMemoryUsage.js';
import { Box, Text } from '../ink.js';
import { formatFileSize } from '../utils/format.js';

/**
 * MemoryUsageIndicator 组件
 *
 * 【整体流程】
 * 1. 编译期常量检查：若 USER_TYPE !== 'ant'（即外部构建），立即返回 null，
 *    不调用任何 hook，避免不必要的后台轮询。
 * 2. 调用 useMemoryUsage() 获取内存快照；若返回 null（尚未初始化），返回 null。
 * 3. 解构 heapUsed（已使用堆大小，字节数）和 status（'normal' | 'high' | 'critical'）。
 * 4. status === 'normal' 时不渲染任何内容，保持界面简洁。
 * 5. 将 heapUsed 格式化为人类可读字符串（如 "256 MB"）。
 * 6. 根据 status 确定颜色：'critical' → 'error'（红色），否则 → 'warning'（黄色）。
 * 7. 渲染警告文本："High memory usage (<size>) · /heapdump"，
 *    wrap="truncate" 防止长文本超出终端宽度。
 *
 * 【设计意图】
 * 仅在内部调试构建中提供内存监控入口，外部用户构建完全不触发此逻辑，
 * 保持产品界面干净，同时为内部开发者提供实时性能诊断能力。
 */
export function MemoryUsageIndicator(): React.ReactNode {
  // Ant-only: the /heapdump link is an internal debugging aid. Gating before
  // the hook means the 10s polling interval is never set up in external builds.
  // USER_TYPE is a build-time constant, so the hook call below is either always
  // reached or dead-code-eliminated — never conditional at runtime.
  // 编译期常量分支：非内部构建直接返回 null，不启动内存轮询
  if ("external" !== 'ant') {
    return null;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  // biome-ignore lint/correctness/useHookAtTopLevel: USER_TYPE is a build-time constant
  // 获取当前进程内存使用快照（10 秒轮询一次）
  const memoryUsage = useMemoryUsage();
  // 尚未获取到数据时不渲染
  if (!memoryUsage) {
    return null;
  }
  // 解构已使用堆内存（字节）和使用状态
  const {
    heapUsed,
    status
  } = memoryUsage;

  // Only show indicator when memory usage is high or critical
  // 内存正常时不展示任何内容
  if (status === 'normal') {
    return null;
  }
  // 将字节数格式化为人类可读尺寸字符串（如 "256 MB"）
  const formattedSize = formatFileSize(heapUsed);
  // 危急状态用红色，高使用率用黄色
  const color = status === 'critical' ? 'error' : 'warning';
  // 渲染内存警告文本，truncate 防止溢出终端宽度
  return <Box>
      <Text color={color} wrap="truncate">
        High memory usage ({formattedSize}) · /heapdump
      </Text>
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZU1lbW9yeVVzYWdlIiwiQm94IiwiVGV4dCIsImZvcm1hdEZpbGVTaXplIiwiTWVtb3J5VXNhZ2VJbmRpY2F0b3IiLCJSZWFjdE5vZGUiLCJtZW1vcnlVc2FnZSIsImhlYXBVc2VkIiwic3RhdHVzIiwiZm9ybWF0dGVkU2l6ZSIsImNvbG9yIl0sInNvdXJjZXMiOlsiTWVtb3J5VXNhZ2VJbmRpY2F0b3IudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlTWVtb3J5VXNhZ2UgfSBmcm9tICcuLi9ob29rcy91c2VNZW1vcnlVc2FnZS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7IGZvcm1hdEZpbGVTaXplIH0gZnJvbSAnLi4vdXRpbHMvZm9ybWF0LmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gTWVtb3J5VXNhZ2VJbmRpY2F0b3IoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgLy8gQW50LW9ubHk6IHRoZSAvaGVhcGR1bXAgbGluayBpcyBhbiBpbnRlcm5hbCBkZWJ1Z2dpbmcgYWlkLiBHYXRpbmcgYmVmb3JlXG4gIC8vIHRoZSBob29rIG1lYW5zIHRoZSAxMHMgcG9sbGluZyBpbnRlcnZhbCBpcyBuZXZlciBzZXQgdXAgaW4gZXh0ZXJuYWwgYnVpbGRzLlxuICAvLyBVU0VSX1RZUEUgaXMgYSBidWlsZC10aW1lIGNvbnN0YW50LCBzbyB0aGUgaG9vayBjYWxsIGJlbG93IGlzIGVpdGhlciBhbHdheXNcbiAgLy8gcmVhY2hlZCBvciBkZWFkLWNvZGUtZWxpbWluYXRlZCDigJQgbmV2ZXIgY29uZGl0aW9uYWwgYXQgcnVudGltZS5cbiAgaWYgKFwiZXh0ZXJuYWxcIiAhPT0gJ2FudCcpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIHJlYWN0LWhvb2tzL3J1bGVzLW9mLWhvb2tzXG4gIC8vIGJpb21lLWlnbm9yZSBsaW50L2NvcnJlY3RuZXNzL3VzZUhvb2tBdFRvcExldmVsOiBVU0VSX1RZUEUgaXMgYSBidWlsZC10aW1lIGNvbnN0YW50XG4gIGNvbnN0IG1lbW9yeVVzYWdlID0gdXNlTWVtb3J5VXNhZ2UoKVxuXG4gIGlmICghbWVtb3J5VXNhZ2UpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgY29uc3QgeyBoZWFwVXNlZCwgc3RhdHVzIH0gPSBtZW1vcnlVc2FnZVxuXG4gIC8vIE9ubHkgc2hvdyBpbmRpY2F0b3Igd2hlbiBtZW1vcnkgdXNhZ2UgaXMgaGlnaCBvciBjcml0aWNhbFxuICBpZiAoc3RhdHVzID09PSAnbm9ybWFsJykge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBjb25zdCBmb3JtYXR0ZWRTaXplID0gZm9ybWF0RmlsZVNpemUoaGVhcFVzZWQpXG4gIGNvbnN0IGNvbG9yID0gc3RhdHVzID09PSAnY3JpdGljYWwnID8gJ2Vycm9yJyA6ICd3YXJuaW5nJ1xuXG4gIHJldHVybiAoXG4gICAgPEJveD5cbiAgICAgIDxUZXh0IGNvbG9yPXtjb2xvcn0gd3JhcD1cInRydW5jYXRlXCI+XG4gICAgICAgIEhpZ2ggbWVtb3J5IHVzYWdlICh7Zm9ybWF0dGVkU2l6ZX0pIMK3IC9oZWFwZHVtcFxuICAgICAgPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsY0FBYyxRQUFRLDRCQUE0QjtBQUMzRCxTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxXQUFXO0FBQ3JDLFNBQVNDLGNBQWMsUUFBUSxvQkFBb0I7QUFFbkQsT0FBTyxTQUFTQyxvQkFBb0JBLENBQUEsQ0FBRSxFQUFFTCxLQUFLLENBQUNNLFNBQVMsQ0FBQztFQUN0RDtFQUNBO0VBQ0E7RUFDQTtFQUNBLElBQUksVUFBVSxLQUFLLEtBQUssRUFBRTtJQUN4QixPQUFPLElBQUk7RUFDYjs7RUFFQTtFQUNBO0VBQ0EsTUFBTUMsV0FBVyxHQUFHTixjQUFjLENBQUMsQ0FBQztFQUVwQyxJQUFJLENBQUNNLFdBQVcsRUFBRTtJQUNoQixPQUFPLElBQUk7RUFDYjtFQUVBLE1BQU07SUFBRUMsUUFBUTtJQUFFQztFQUFPLENBQUMsR0FBR0YsV0FBVzs7RUFFeEM7RUFDQSxJQUFJRSxNQUFNLEtBQUssUUFBUSxFQUFFO0lBQ3ZCLE9BQU8sSUFBSTtFQUNiO0VBRUEsTUFBTUMsYUFBYSxHQUFHTixjQUFjLENBQUNJLFFBQVEsQ0FBQztFQUM5QyxNQUFNRyxLQUFLLEdBQUdGLE1BQU0sS0FBSyxVQUFVLEdBQUcsT0FBTyxHQUFHLFNBQVM7RUFFekQsT0FDRSxDQUFDLEdBQUc7QUFDUixNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDRSxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBVTtBQUN6QywyQkFBMkIsQ0FBQ0QsYUFBYSxDQUFDO0FBQzFDLE1BQU0sRUFBRSxJQUFJO0FBQ1osSUFBSSxFQUFFLEdBQUcsQ0FBQztBQUVWIiwiaWdub3JlTGlzdCI6W119
