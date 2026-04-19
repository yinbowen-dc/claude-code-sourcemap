/**
 * UserImageMessage.tsx
 *
 * 在 Claude Code 系统消息流中的位置：
 *   用户消息处理管道
 *     └─ UserImageMessage（本文件）
 *
 * 功能概述：
 *   渲染用户消息中附带的图片附件，显示为 "[Image #N]" 或 "[Image]" 标签。
 *   若终端支持超链接且图片有本地路径缓存，则将标签渲染为可点击链接。
 *   根据 addMargin 参数决定使用带边距的 Box 布局（独立行）还是 MessageResponse 样式（连接到上方消息）。
 *
 * 主要函数：
 *   - UserImageMessage({imageId, addMargin}): 渲染图片标签，处理超链接和布局两种场景
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { pathToFileURL } from 'url';
import Link from '../../ink/components/Link.js';
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js';
import { Box, Text } from '../../ink.js';
import { getStoredImagePath } from '../../utils/imageStore.js';
import { MessageResponse } from '../MessageResponse.js';
type Props = {
  imageId?: number;
  addMargin?: boolean;
};

/**
 * UserImageMessage — 渲染图片附件标签
 *
 * 流程：
 *   1. 根据 imageId 生成显示标签：有 ID 时为 "[Image #N]"，否则为 "[Image]"
 *   2. 尝试从 imageStore 获取图片的本地文件路径
 *   3. 若图片路径存在且终端支持超链接 → 渲染为可点击链接（file:// URL）
 *   4. 否则 → 渲染为普通文本
 *   5. addMargin=true → 用带 marginTop=1 的 Box 包裹（此图片开始新的用户回合）
 *   6. addMargin=false → 用 MessageResponse 包裹（延续上方消息的样式连接线）
 *
 * React 编译器优化：_c(7) 缓存数组，缓存 content 节点和两种布局分支的输出
 */
export function UserImageMessage(t0) {
  // React 编译器注入的缓存数组，共 7 个槽位
  const $ = _c(7);
  const {
    imageId,
    addMargin
  } = t0;
  // 生成显示标签：有 imageId 则附带序号，否则显示通用标签
  const label = imageId ? `[Image #${imageId}]` : "[Image]";
  let t1;
  // 当 imageId 或 label 变化时重新构建内容节点
  if ($[0] !== imageId || $[1] !== label) {
    // 尝试获取图片的本地缓存路径
    const imagePath = imageId ? getStoredImagePath(imageId) : null;
    // 若图片路径存在且终端支持超链接，渲染为可点击链接；否则渲染纯文本
    t1 = imagePath && supportsHyperlinks() ? <Link url={pathToFileURL(imagePath).href}><Text>{label}</Text></Link> : <Text>{label}</Text>;
    $[0] = imageId;
    $[1] = label;
    $[2] = t1;
  } else {
    // 依赖未变更，复用缓存的内容节点
    t1 = $[2];
  }
  const content = t1;
  // === 布局分支：addMargin=true 表示图片作为新一轮对话的开始 ===
  if (addMargin) {
    let t2;
    // addMargin 模式：用带顶部间距的 Box 包裹，脱离 MessageResponse 连接线
    if ($[3] !== content) {
      t2 = <Box marginTop={1}>{content}</Box>;
      $[3] = content;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    return t2;
  }
  // === 布局分支：addMargin=false 表示图片跟在文本之后，使用 MessageResponse 样式 ===
  let t2;
  if ($[5] !== content) {
    // MessageResponse 会在左侧显示竖线连接符，表示此图片属于同一用户回合
    t2 = <MessageResponse>{content}</MessageResponse>;
    $[5] = content;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInBhdGhUb0ZpbGVVUkwiLCJMaW5rIiwic3VwcG9ydHNIeXBlcmxpbmtzIiwiQm94IiwiVGV4dCIsImdldFN0b3JlZEltYWdlUGF0aCIsIk1lc3NhZ2VSZXNwb25zZSIsIlByb3BzIiwiaW1hZ2VJZCIsImFkZE1hcmdpbiIsIlVzZXJJbWFnZU1lc3NhZ2UiLCJ0MCIsIiQiLCJfYyIsImxhYmVsIiwidDEiLCJpbWFnZVBhdGgiLCJocmVmIiwiY29udGVudCIsInQyIl0sInNvdXJjZXMiOlsiVXNlckltYWdlTWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAndXJsJ1xuaW1wb3J0IExpbmsgZnJvbSAnLi4vLi4vaW5rL2NvbXBvbmVudHMvTGluay5qcydcbmltcG9ydCB7IHN1cHBvcnRzSHlwZXJsaW5rcyB9IGZyb20gJy4uLy4uL2luay9zdXBwb3J0cy1oeXBlcmxpbmtzLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZ2V0U3RvcmVkSW1hZ2VQYXRoIH0gZnJvbSAnLi4vLi4vdXRpbHMvaW1hZ2VTdG9yZS5qcydcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uL01lc3NhZ2VSZXNwb25zZS5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgaW1hZ2VJZD86IG51bWJlclxuICBhZGRNYXJnaW4/OiBib29sZWFuXG59XG5cbi8qKlxuICogUmVuZGVycyBhbiBpbWFnZSBhdHRhY2htZW50IGluIHVzZXIgbWVzc2FnZXMuXG4gKiBTaG93cyBhcyBhIGNsaWNrYWJsZSBsaW5rIGlmIHRoZSBpbWFnZSBpcyBzdG9yZWQgYW5kIHRlcm1pbmFsIHN1cHBvcnRzIGh5cGVybGlua3MuXG4gKiBVc2VzIE1lc3NhZ2VSZXNwb25zZSBzdHlsaW5nIHRvIGFwcGVhciBjb25uZWN0ZWQgdG8gdGhlIG1lc3NhZ2UgYWJvdmUsXG4gKiB1bmxlc3MgYWRkTWFyZ2luIGlzIHRydWUgKGltYWdlIHN0YXJ0cyBhIG5ldyB1c2VyIHR1cm4gd2l0aG91dCB0ZXh0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIFVzZXJJbWFnZU1lc3NhZ2Uoe1xuICBpbWFnZUlkLFxuICBhZGRNYXJnaW4sXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IGxhYmVsID0gaW1hZ2VJZCA/IGBbSW1hZ2UgIyR7aW1hZ2VJZH1dYCA6ICdbSW1hZ2VdJ1xuICBjb25zdCBpbWFnZVBhdGggPSBpbWFnZUlkID8gZ2V0U3RvcmVkSW1hZ2VQYXRoKGltYWdlSWQpIDogbnVsbFxuXG4gIGNvbnN0IGNvbnRlbnQgPVxuICAgIGltYWdlUGF0aCAmJiBzdXBwb3J0c0h5cGVybGlua3MoKSA/IChcbiAgICAgIDxMaW5rIHVybD17cGF0aFRvRmlsZVVSTChpbWFnZVBhdGgpLmhyZWZ9PlxuICAgICAgICA8VGV4dD57bGFiZWx9PC9UZXh0PlxuICAgICAgPC9MaW5rPlxuICAgICkgOiAoXG4gICAgICA8VGV4dD57bGFiZWx9PC9UZXh0PlxuICAgIClcblxuICAvLyBXaGVuIHRoaXMgaW1hZ2Ugc3RhcnRzIGEgbmV3IHVzZXIgdHVybiAobm8gdGV4dCBiZWZvcmUgaXQpLFxuICAvLyBzaG93IHdpdGggbWFyZ2luIGluc3RlYWQgb2YgdGhlIGNvbm5lY3RlZCBsaW5lIHN0eWxlXG4gIGlmIChhZGRNYXJnaW4pIHtcbiAgICByZXR1cm4gPEJveCBtYXJnaW5Ub3A9ezF9Pntjb250ZW50fTwvQm94PlxuICB9XG5cbiAgcmV0dXJuIDxNZXNzYWdlUmVzcG9uc2U+e2NvbnRlbnR9PC9NZXNzYWdlUmVzcG9uc2U+XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLGFBQWEsUUFBUSxLQUFLO0FBQ25DLE9BQU9DLElBQUksTUFBTSw4QkFBOEI7QUFDL0MsU0FBU0Msa0JBQWtCLFFBQVEsa0NBQWtDO0FBQ3JFLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0Msa0JBQWtCLFFBQVEsMkJBQTJCO0FBQzlELFNBQVNDLGVBQWUUUFBUSx1QkFBdUI7QUFFdkQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLE9BQU8sQ0FBQyxFQUFFLE1BQU07RUFDaEJDLFNBQVMsQ0FBQyxFQUFFLE9BQU87QUFDckIsQ0FBQzs7QUFFRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLFNBQUFDLGlCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQTBCO0lBQUFMLE9BQUE7SUFBQUM7RUFBQSxJQUFBRSxFQUd6QjtFQUNOLE1BQUFHLEtBQUEsR0FBY04sT0FBTyxHQUFQLFdBQXFCQSxPQUFPLEdBQWUsR0FBM0MsU0FBMkM7RUFBQSxJQUFBTyxFQUFBO0VBQUEsSUFBQUgsQ0FBQSxRQUFBSixPQUFBLElBQUFJLENBQUEsUUFBQUUsS0FBQTtJQUN6RCxNQUFBRSxTQUFBLEdBQWtCUixPQUFPLEdBQUdILGtCQUFrQixDQUFDRyxPQUFjLENBQUMsR0FBNUMsSUFBNEM7SUFHNURPLEVBQUEsR0FBQUMsU0FBaUMsSUFBcEJkLGtCQUFrQixDQUFDLENBTS9CLEdBTEMsQ0FBQyxJQUFJLENBQU0sR0FBNkIsQ0FBN0IsQ0FBQUYsYUFBYSxDQUFDZ0IsU0FBUyxDQUFDLENBQUFDLElBQUksQ0FBQyxDQUN0QyxDQUFDLElBQUksQ0FBRUgsTUFBSSxDQUFFLEVBQVosSUFBSSxDQUNQLEVBRkMsSUFBSSxDQUtOLEdBREMsQ0FBQyxJQUFJLENBQUVBLE1BQUksQ0FBRSxFQUFaLElBQUksQ0FDTjtJQUFBRixDQUFBLE1BQUFIUE9BQUE7SUFBQU8sQ0FBQSxNQUFBRSxLQUFBO0lBQUFGLENBQUEsTUFBQUcsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUgsQ0FBQTtFQUFBO0VBUEgsTUFBQU0sT0FBQSxHQUNFSCxFQU1DO0VBSUgsSUFBSU4sU0FBUztJQUFBLElBQUFVLEVBQUE7SUFBQSxJQUFBUCxDQUFBLFFBQUFNLE9BQUE7TUFDSW5CLEVBQUE7TUFBQSxJQUFDLEdBQUcsQ0FBWSxTQUFDLENBQUQsR0FBQyxDQUFHRCxRQUFNLENBQUUsRUFBM0IsR0FBRyxDQUE4QjtNQUFBTixDQUFBLE1BQUFNLE9BQUE7TUFBQU4sQ0FBQSxNQUFBTyxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBUCxDQUFBO0lBQUE7SUFBQSxPQUFsQ08sRUFBa0M7RUFBQTtFQUMxQyxJQUFBQSxFQUFBO0VBQUEsSUFBQVAsQ0FBQSxRQUFBTSxPQUFBO0lBRU1DLEVBQUEsSUFBQyxlQUFlLENBQUVELFFBQU0sQ0FBRSxFQUF6QixlQUFlLENBQTRCO0lBQUFOLENBQUEsTUFBQU0sT0FBQTtJQUFBTixDQUFBLE1BQUFPLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFQLENBQUE7RUFBQTtFQUFBLE9BQTVDTyxFQUE0QztBQUFBIiwiaWdub3JlTGlzdCI6W119
