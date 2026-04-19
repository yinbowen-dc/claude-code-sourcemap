/**
 * 【设计系统 - 进度条组件】
 *
 * 在 Claude Code 系统流程中的位置：
 * 终端 UI 进度反馈层。用于长时间操作（文件处理、模型加载、批量任务等）
 * 的进度可视化。通过字符块拼接实现亚字符精度的平滑进度条，
 * 而无需任何图形库——完全在文本终端中渲染。
 *
 * 主要功能：
 * 1. 将 0~1 的进度比例映射到 width 个字符宽度的文本条
 * 2. 使用 8 级 Unicode 块字符（▏▎▍▌▋▊▉█）实现亚字符精度
 * 3. 支持可选的填充色和空白色（均为主题键名）
 * 4. React Compiler 编译优化（_c(13) 缓存）
 */

import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Text } from '../../ink.js';
import type { Theme } from '../../utils/theme.js';

type Props = {
  /**
   * 显示的进度值，范围 0 到 1（含端点）
   */
  ratio: number; // [0, 1]

  /**
   * 进度条宽度（字符数）
   */
  width: number; // how many characters wide

  /**
   * 已填充部分的可选颜色（主题键名）
   */
  fillColor?: keyof Theme;

  /**
   * 空白部分的可选颜色（主题键名）
   */
  emptyColor?: keyof Theme;
};

/**
 * 8 级块字符数组，索引 0 为空格（最小），索引 8 为实心块（最大）。
 * 用于亚字符级精度：整块用 BLOCKS[8]（█），分数块用中间索引，空白用 BLOCKS[0]（空格）。
 */
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/**
 * 渲染文本进度条。
 *
 * 整体流程：
 * 1. 将 inputRatio 箝位到 [0, 1] 区间，计算整块数量 whole = floor(ratio * width)
 * 2. 拼接 whole 个满块（BLOCKS[8] 重复）
 * 3. 若还有剩余空间（whole < width）：
 *    a. 计算分数部分 remainder = ratio*width - whole，取对应分数块字符
 *    b. 计算剩余空白数量 empty = width - whole - 1，用 BLOCKS[0] 填充
 * 4. 将所有片段 join('') 后渲染为 <Text>，应用 fillColor 和 emptyColor
 *
 * React Compiler 使用 _c(13) 缓存依赖，避免相同 ratio/width 时重复计算。
 */
export function ProgressBar(t0) {
  // React Compiler 缓存数组，共 13 个槽位
  const $ = _c(13);
  const {
    ratio: inputRatio,  // 原始进度值（可能超出 [0,1] 范围，需要箝位）
    width,
    fillColor,
    emptyColor
  } = t0;

  // 箝位到 [0, 1]，避免负值或超过 1 的值导致渲染异常
  const ratio = Math.min(1, Math.max(0, inputRatio));
  // 整块数量：完全填充的字符位数
  const whole = Math.floor(ratio * width);

  // 构建满块字符串（whole 个 █）
  let t1;
  if ($[0] !== whole) {
    t1 = BLOCKS[BLOCKS.length - 1].repeat(whole);  // BLOCKS[8] = '█'
    $[0] = whole;
    $[1] = t1;
  } else {
    t1 = $[1];
  }

  // 构建完整的 segments 数组：[满块字符串, 分数块字符, 空白字符串]
  let segments;
  if ($[2] !== ratio || $[3] !== t1 || $[4] !== whole || $[5] !== width) {
    segments = [t1];  // 先放满块字符串
    if (whole < width) {
      // 还有剩余空间，计算分数块和空白块
      const remainder = ratio * width - whole;  // 分数部分（0~1）
      const middle = Math.floor(remainder * BLOCKS.length);  // 对应块字符索引
      segments.push(BLOCKS[middle]);  // 推入分数块字符（部分填充的过渡字符）

      const empty = width - whole - 1;  // 剩余空白字符数
      if (empty > 0) {
        let t2;
        if ($[7] !== empty) {
          t2 = BLOCKS[0].repeat(empty);  // BLOCKS[0] = ' '（空格）
          $[7] = empty;
          $[8] = t2;
        } else {
          t2 = $[8];
        }
        segments.push(t2);  // 推入空白字符串
      }
    }
    $[2] = ratio;
    $[3] = t1;
    $[4] = whole;
    $[5] = width;
    $[6] = segments;
  } else {
    segments = $[6];
  }

  // 将所有片段合并为单个字符串
  const t2 = segments.join("");

  // 渲染：color 应用到前景色（填充块颜色），backgroundColor 应用到背景色（空白块颜色）
  let t3;
  if ($[9] !== emptyColor || $[10] !== fillColor || $[11] !== t2) {
    t3 = <Text color={fillColor} backgroundColor={emptyColor}>{t2}</Text>;
    $[9] = emptyColor;
    $[10] = fillColor;
    $[11] = t2;
    $[12] = t3;
  } else {
    t3 = $[12];
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlRleHQiLCJUaGVtZSIsIlByb3BzIiwicmF0aW8iLCJ3aWR0aCIsImZpbGxDb2xvciIsImVtcHR5Q29sb3IiLCJCTE9DS1MiLCJQcm9ncmVzc0JhciIsInQwIiwiJCIsIl9jIiwiaW5wdXRSYXRpbyIsIk1hdGgiLCJtaW4iLCJtYXgiLCJ3aG9sZSIsImZsb29yIiwidDEiLCJsZW5ndGgiLCJyZXBlYXQiLCJzZWdtZW50cyIsInJlbWFpbmRlciIsIm1pZGRsZSIsInB1c2giLCJlbXB0eSIsInQyIiwiam9pbiIsInQzIl0sInNvdXJjZXMiOlsiUHJvZ3Jlc3NCYXIudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lIH0gZnJvbSAnLi4vLi4vdXRpbHMvdGhlbWUuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIC8qKlxuICAgKiBIb3cgbXVjaCBwcm9ncmVzcyB0byBkaXNwbGF5LCBiZXR3ZWVuIDAgYW5kIDEgaW5jbHVzaXZlXG4gICAqL1xuICByYXRpbzogbnVtYmVyIC8vIFswLCAxXVxuXG4gIC8qKlxuICAgKiBIb3cgbWFueSBjaGFyYWN0ZXJzIHdpZGUgdG8gZHJhdyB0aGUgcHJvZ3Jlc3MgYmFyXG4gICAqL1xuICB3aWR0aDogbnVtYmVyIC8vIGhvdyBtYW55IGNoYXJhY3RlcnMgd2lkZVxuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBjb2xvciBmb3IgdGhlIGZpbGxlZCBwb3J0aW9uIG9mIHRoZSBiYXJcbiAgICovXG4gIGZpbGxDb2xvcj86IGtleW9mIFRoZW1lXG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGNvbG9yIGZvciB0aGUgZW1wdHkgcG9ydGlvbiBvZiB0aGUgYmFyXG4gICAqL1xuICBlbXB0eUNvbG9yPzoga2V5b2YgVGhlbWVcbn1cblxuY29uc3QgQkxPQ0tTID0gWycgJywgJ+KWjycsICfilo4nLCAn4paNJywgJ+KWjCcsICfilosnLCAn4paKJywgJ+KWiScsICfilognXVxuXG5leHBvcnQgZnVuY3Rpb24gUHJvZ3Jlc3NCYXIoe1xuICByYXRpbzogaW5wdXRSYXRpbyxcbiAgd2lkdGgsXG4gIGZpbGxDb2xvcixcbiAgZW1wdHlDb2xvcixcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgcmF0aW8gPSBNYXRoLm1pbigxLCBNYXRoLm1heCgwLCBpbnB1dFJhdGlvKSlcbiAgY29uc3Qgd2hvbGUgPSBNYXRoLmZsb29yKHJhdGlvICogd2lkdGgpXG4gIGNvbnN0IHNlZ21lbnRzID0gW0JMT0NLU1tCTE9DS1MubGVuZ3RoIC0gMV0hLnJlcGVhdCh3aG9sZSldXG4gIGlmICh3aG9sZSA8IHdpZHRoKSB7XG4gICAgY29uc3QgcmVtYWluZGVyID0gcmF0aW8gKiB3aWR0aCAtIHdob2xlXG4gICAgY29uc3QgbWlkZGxlID0gTWF0aC5mbG9vcihyZW1haW5kZXIgKiBCTE9DS1MubGVuZ3RoKVxuICAgIHNlZ21lbnRzLnB1c2goQkxPQ0tTW21pZGRsZV0hKVxuXG4gICAgY29uc3QgZW1wdHkgPSB3aWR0aCAtIHdob2xlIC0gMVxuICAgIGlmIChlbXB0eSA+IDApIHtcbiAgICAgIHNlZ21lbnRzLnB1c2goQkxPQ0tTWzBdIS5yZXBlYXQoZW1wdHkpKVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPFRleHQgY29sb3I9e2ZpbGxDb2xvcn0gYmFja2dyb3VuZENvbG9yPXtlbXB0eUNvbG9yfT5cbiAgICAgIHtzZWdtZW50cy5qb2luKCcnKX1cbiAgICA8L1RleHQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssTUFBTSxPQUFPO0FBQ3pCLFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLGNBQWNDLEtBQUssUUFBUSxzQkFBc0I7QUFFakQsS0FBS0MsS0FBSyxHQUFHO0VBQ1g7QUFDRjtBQUNBO0VBQ0VDLEtBQUssRUFBRSxNQUFNLEVBQUM7O0VBRWQ7QUFDRjtBQUNBO0VBQ0VDLEtBQUssRUFBRSxNQUFNLEVBQUM7O0VBRWQ7QUFDRjtBQUNBO0VBQ0VDLFNBQVMsQ0FBQyxFQUFFLE1BQU1KLEtBQUs7O0VBRXZCO0FBQ0Y7QUFDQTtFQUNFSyxVQUFVLENBQUMsRUFBRSxNQUFNTCxLQUFLO0FBQzFCLENBQUM7QUFFRCxNQUFNTSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQztBQUU1RCxPQUFPLFNBQUFDLFlBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBcUI7SUFBQVIsS0FBQSxFQUFBUyxVQUFBO0lBQUFSLEtBQUE7SUFBQUMsU0FBQTtJQUFBQztFQUFBLElBQUFHLEVBS3BCO0VBQ04sTUFBQU4sS0FBQSxHQUFjVSxJQUFJLENBQUFDLEdBQUksQ0FBQyxDQUFDLEVBQUVELElBQUksQ0FBQUVHQU1BLENBQUksQ0FBQyxDQUFDLEVBQUVILFVBQVUsQ0FBQyxDQUFDO0VBQ2xELE1BQUFJLEtBQUEsR0FBY0gsSUFBSSxDQUFBSSxLQUFNLENBQUNkLEtBQUssR0FBR0MsS0FBSyxDQUFDO0VBQUEsSUFBQWMsRUFBQTtFQUFBLElBQUFSLENBQUEsUUFBQU0sS0FBQTtJQUNyQkUsRUFBQSxHQUFBWCxNQUFNLENBQUNBLE1BQU0sQ0FBQVksTUFBTyxHQUFHLENBQUMsQ0FBQyxDQUFBQyxNQUFRLENBQUNKLEtBQUssQ0FBQztJQUFBTixDQUFBLE1BQUFFLE1BQUEsTUFBQU0sS0FBQTtJQUFBUixDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUFBLElBQUFXLFFBQUE7RUFBQSxJQUFBWCxDQUFBLFFBQUFQLEtBQUEsSUFBQU8sQ0FBQSxRQUFBUSxFQUFBLElBQUFSLENBQUEsUUFBQU0sS0FBQSxJQUFBTixDQUFBLFFBQUFOLEtBQUE7SUFBMURpQixRQUFBLEdBQWlCLENBQUNILEVBQXdDLENBQUM7SUFDM0QsSUFBSUYsS0FBSyxHQUFHWixLQUFLO01BQ2YsTUFBQWtCLFNBQUEsR0FBa0JuQixLQUFLLEdBQUdDLEtBQUssR0FBR1ksS0FBSztNQUN2QyxNQUFBTyxNQUFBLEdBQWVWLElBQUksQ0FBQUksS0FBTSxDQUFDSyxTQUFTLEdBQUdmLE1BQU0sQ0FBQVksTUFBTyxDQUFDO01BQ3BERSxRQUFRLENBQUFHLElBQUssQ0FBQ2pCLE1BQU0sQ0FBQ2dCLE1BQU0sQ0FBRSxDQUFDO01BRTlCLE1BQUFFLEtBQUEsR0FBY3JCLEtBQUssR0FBR1ksS0FBSyxHQUFHLENBQUM7TUFDL0IsSUFBSVMsS0FBSyxHQUFHLENBQUM7UUFBQSxJQUFBQyxFQUFBO1FBQUEsSUFBQWhCLENBQUEsUUFBQWUsS0FBQTtVQUNHQyxFQUFBLEdBQUFuQixNQUFNLEdBQUcsQ0FBQWEsTUFBUSxDQUFDSyxLQUFLLENBQUM7VUFBQWYsQ0FBQSxNQUFBZSxLQUFBO1VBQUFmLENBQUEsTUFBQWdCLEVBQUE7UUFBQTtVQUFBQSxFQUFBLEdBQUFoQixDQUFBO1FBQUE7UUFBdENXLFFBQVEsQ0FBQUcsSUFBSyxDQUFDRSxFQUF3QixDQUFDO01BQUE7SUFDeEM7SUFDRmhCLENBQUEsTUFBQVAsS0FBQTtJQUFBTyxDQUFBLE1BQUFRLEVBQUE7SUFBQVIsQ0FBQSxNQUFBTSxLQUFBO0lBQUFOLENBQUEsTUFBQU4sS0FBQTtJQUFBTSxDQUFBLE1BQUFULFFBQUE7RUFBQTtJQUFBQSxRQUFBLEdBQUFYLENBQUE7RUFBQTtFQUlJLE1BQUFnQixFQUFBLEdBQUFMLFFBQVEsQ0FBQU0sSUFBSyxDQUFDLEVBQUUsQ0FBQztFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBbEIsQ0FBQSxRQUFBSixVQUFBLElBQUFJLENBQUEsU0FBQUwsU0FBQSxJQUFBSyxDQUFBLFNBQUFnQixFQUFBO0lBRHBCRSxFQUFBLElBQUMsSUFBSSxDQUFRdkIsS0FBUyxDQUFUQSxVQUFRLENBQUMsQ0FBbUJDLGVBQVUsQ0FBVkEsV0FBUyxDQUFDLENBQ2hELENBQUFvQixFQUFnQixDQUNuQixFQUZDLElBQUksQ0FFRTtJQUFBaEIsQ0FBQSxNQUFBSixVQUFBO0lBQUFJLENBQUEsT0FBQUwsU0FBQTtJQUFBSyxDQUFBLE9BQUFnQixFQUFBO0lBQUFoQixDQUFBLE9BQUFrQixFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBbEIsQ0FBQTtFQUFBO0VBQUEsT0FGUGtCLEVBRU87QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
