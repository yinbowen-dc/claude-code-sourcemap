/**
 * ChannelDowngradeDialog.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件属于更新/发布渠道切换流程。当用户将更新渠道从 "latest"（最新版）切换到
 * "stable"（稳定版）时，由于 stable 版本可能低于当前已安装版本，系统需要询问用户
 * 是否接受降级，或继续使用当前版本直到 stable 版本追上来。
 *
 * 主要功能：
 * 1. 展示当前运行版本（currentVersion），提示 stable 渠道可能较旧
 * 2. 提供两个操作选项："允许可能的降级" 或 "保持当前版本直到 stable 追上"
 * 3. 支持 ESC/取消操作，触发 'cancel' 选项
 * 4. 通过 onChoice 回调将用户决策（'downgrade' | 'stay' | 'cancel'）传回父组件
 */

import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Text } from '../ink.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

// 用户可能的选择类型：降级 / 保持当前版本 / 取消
export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel';

// 组件 Props：当前版本号字符串 + 选择回调
type Props = {
  currentVersion: string;
  onChoice: (choice: ChannelDowngradeChoice) => void;
};

/**
 * ChannelDowngradeDialog
 *
 * 从 latest 切换到 stable 渠道时展示的确认对话框。
 * 允许用户选择是否降级或保持当前版本。
 *
 * 整体流程：
 * 1. _c(17) 初始化 17 个槽位的记忆化缓存
 * 2. handleSelect：将 Select 组件的选中值直接透传给 onChoice 回调
 * 3. handleCancel：ESC 取消时传递 'cancel' 值给 onChoice
 * 4. t3 依赖 currentVersion 渲染当前版本提示文字
 * 5. t4 为静态提示文字（无依赖），只渲染一次
 * 6. t5 为第一个静态选项对象（"允许降级"），只创建一次
 * 7. t6/t7 为第二个选项（包含 currentVersion 的动态标签），currentVersion 变化时重建
 * 8. t8 在 handleSelect 或选项列表变化时重建 Select 组件
 * 9. t9 在 handleCancel/t3/t8 任一变化时重建整个 Dialog
 */
export function ChannelDowngradeDialog(t0) {
  // 初始化 17 槽位的记忆化缓存
  const $ = _c(17);
  const {
    currentVersion,
    onChoice
  } = t0;

  // 槽位 $[0]/$[1]：onChoice 变化时重建 handleSelect
  let t1;
  if ($[0] !== onChoice) {
    // handleSelect：将选中值直接传递给父组件的 onChoice 回调
    t1 = function handleSelect(value) {
      onChoice(value);
    };
    $[0] = onChoice;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const handleSelect = t1;

  // 槽位 $[2]/$[3]：onChoice 变化时重建 handleCancel
  let t2;
  if ($[2] !== onChoice) {
    // handleCancel：ESC 或取消操作，固定传递 'cancel'
    t2 = function handleCancel() {
      onChoice("cancel");
    };
    $[2] = onChoice;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleCancel = t2;

  // 槽位 $[4]/$[5]：currentVersion 变化时重建包含版本号的提示文本
  let t3;
  if ($[4] !== currentVersion) {
    t3 = <Text>The stable channel may have an older version than what you're currently running ({currentVersion}).</Text>;
    $[4] = currentVersion;
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // 槽位 $[6]：静态提示文本，只创建一次
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text dimColor={true}>How would you like to handle this?</Text>;
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // 槽位 $[7]：第一个静态选项（"允许可能的降级"），只创建一次
  let t5;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "Allow possible downgrade to stable version",
      value: "downgrade" as ChannelDowngradeChoice
    };
    $[7] = t5;
  } else {
    t5 = $[7];
  }

  // 第二个选项的 label 包含 currentVersion，每次 currentVersion 变化时重新生成
  const t6 = `Stay on current version (${currentVersion}) until stable catches up`;

  // 槽位 $[8]/$[9]：t6（含版本号的标签）变化时重建选项数组
  let t7;
  if ($[8] !== t6) {
    t7 = [t5, {
      label: t6,
      value: "stay" as ChannelDowngradeChoice
    }];
    $[8] = t6;
    $[9] = t7;
  } else {
    t7 = $[9];
  }

  // 槽位 $[10]-$[12]：handleSelect 或选项列表变化时重建 Select 组件
  let t8;
  if ($[10] !== handleSelect || $[11] !== t7) {
    t8 = <Select options={t7} onChange={handleSelect} />;
    $[10] = handleSelect;
    $[11] = t7;
    $[12] = t8;
  } else {
    t8 = $[12];
  }

  // 槽位 $[13]-$[16]：handleCancel/t3/t8 任一变化时重建完整 Dialog
  let t9;
  if ($[13] !== handleCancel || $[14] !== t3 || $[15] !== t8) {
    // 渲染 Dialog：标题"切换到 Stable 渠道"，隐藏边框和输入提示
    t9 = <Dialog title="Switch to Stable Channel" onCancel={handleCancel} color="permission" hideBorder={true} hideInputGuide={true}>{t3}{t4}{t8}</Dialog>;
    $[13] = handleCancel;
    $[14] = t3;
    $[15] = t8;
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  return t9;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlRleHQiLCJTZWxlY3QiLCJEaWFsb2ciLCJDaGFubmVsRG93bmdyYWRlQ2hvaWNlIiwiUHJvcHMiLCJjdXJyZW50VmVyc2lvbiIsIm9uQ2hvaWNlIiwiY2hvaWNlIiwiQ2hhbm5lbERvd25ncmFkZURpYWxvZyIsInQwIiwiJCIsIl9jIiwidDEiLCJoYW5kbGVTZWxlY3QiLCJ2YWx1ZSIsInQyIiwiaGFuZGxlQ2FuY2VsIiwidDMiLCJ0NCIsIlN5bWJvbCIsImZvciIsInQ1IiwibGFiZWwiLCJ0NiIsInQ3IiwidDgiLCJ0OSJdLCJzb3VyY2VzIjpbIkNoYW5uZWxEb3duZ3JhZGVEaWFsb2cudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi9pbmsuanMnXG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuL0N1c3RvbVNlbGVjdC9pbmRleC5qcydcbmltcG9ydCB7IERpYWxvZyB9IGZyb20gJy4vZGVzaWduLXN5c3RlbS9EaWFsb2cuanMnXG5cbmV4cG9ydCB0eXBlIENoYW5uZWxEb3duZ3JhZGVDaG9pY2UgPSAnZG93bmdyYWRlJyB8ICdzdGF5JyB8ICdjYW5jZWwnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmdcbiAgb25DaG9pY2U6IChjaG9pY2U6IENoYW5uZWxEb3duZ3JhZGVDaG9pY2UpID0+IHZvaWRcbn1cblxuLyoqXG4gKiBEaWFsb2cgc2hvd24gd2hlbiBzd2l0Y2hpbmcgZnJvbSBsYXRlc3QgdG8gc3RhYmxlIGNoYW5uZWwuXG4gKiBBbGxvd3MgdXNlciB0byBjaG9vc2Ugd2hldGhlciB0byBkb3duZ3JhZGUgb3Igc3RheSBvbiBjdXJyZW50IHZlcnNpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBDaGFubmVsRG93bmdyYWRlRGlhbG9nKHtcbiAgY3VycmVudFZlcnNpb24sXG4gIG9uQ2hvaWNlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBmdW5jdGlvbiBoYW5kbGVTZWxlY3QodmFsdWU6IENoYW5uZWxEb3duZ3JhZGVDaG9pY2UpOiB2b2lkIHtcbiAgICBvbkNob2ljZSh2YWx1ZSlcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNhbmNlbCgpOiB2b2lkIHtcbiAgICBvbkNob2ljZSgnY2FuY2VsJylcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPERpYWxvZ1xuICAgICAgdGl0bGU9XCJTd2l0Y2ggdG8gU3RhYmxlIENoYW5uZWxcIlxuICAgICAgb25DYW5jZWw9e2hhbmRsZUNhbmNlbH1cbiAgICAgIGNvbG9yPVwicGVybWlzc2lvblwiXG4gICAgICBoaWRlQm9yZGVyXG4gICAgICBoaWRlSW5wdXRHdWlkZVxuICAgID5cbiAgICAgIDxUZXh0PlxuICAgICAgICBUaGUgc3RhYmxlIGNoYW5uZWwgbWF5IGhhdmUgYW4gb2xkZXIgdmVyc2lvbiB0aGFuIHdoYXQgeW91JmFwb3M7cmVcbiAgICAgICAgY3VycmVudGx5IHJ1bm5pbmcgKHtjdXJyZW50VmVyc2lvbn0pLlxuICAgICAgPC9UZXh0PlxuICAgICAgPFRleHQgZGltQ29sb3I+SG93IHdvdWxkIHlvdSBsaWtlIHRvIGhhbmRsZSB0aGlzPzwvVGV4dD5cbiAgICAgIDxTZWxlY3RcbiAgICAgICAgb3B0aW9ucz17W1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGxhYmVsOiAnQWxsb3cgcG9zc2libGUgZG93bmdyYWRlIHRvIHN0YWJsZSB2ZXJzaW9uJyxcbiAgICAgICAgICAgIHZhbHVlOiAnZG93bmdyYWRlJyBhcyBDaGFubmVsRG93bmdyYWRlQ2hvaWNlLFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgbGFiZWw6IGBTdGF5IG9uIGN1cnJlbnQgdmVyc2lvbiAoJHtjdXJyZW50VmVyc2lvbn0pIHVudGlsIHN0YWJsZSBjYXRjaGVzIHVwYCxcbiAgICAgICAgICAgIHZhbHVlOiAnc3RheScgYXMgQ2hhbm5lbERvd25ncmFkZUNob2ljZSxcbiAgICAgICAgICB9LFxuICAgICAgICBdfVxuICAgICAgICBvbkNoYW5nZT17aGFuZGxlU2VsZWN0fVxuICAgICAgLz5cbiAgICA8L0RpYWxvZz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsSUFBSSxRQUFRLFdBQVc7QUFDaEMsU0FBU0MsTUFBTSxRQUFRLHlCQUF5QjtBQUNoRCxTQUFTQyxNQUFNLFFBQVEsMkJBQTJCO0FBRWxELE9BQU8sS0FBS0Msc0JBQXNCLEdBQUcsV0FBVyxHQUFHLE1BQU0sR0FBRyxRQUFRO0FBRXBFLEtBQUtDLEtBQUssR0FBRztFQUNYQyxjQUFjLEVBQUUsTUFBTTtFQUN0QkMsUUFBUSxFQUFFLENBQUNDLE1BQU0sRUFBRUosc0JBQXNCLEVBQUUsR0FBRyxJQUFJO0FBQ2xELENBQUM7O0FBRUQ7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLFNBQUFLLHVCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQWdDO0lBQUFOLGNBQUE7SUFBQUM7RUFBQSxJQUFBRyxFQUcvQjtFQUFBLElBQUFHLEVBQUE7RUFBQSxJQUFBRixDQUFBLFFBQUFKLFFBQUE7SUFDTk0sRUFBQSxZQUFBQyxhQUFBQyxLQUFBO01BQ0VSLFFBQVEsQ0FBQ1EsS0FBSyxDQUFDO0lBQUEsQ0FDaEI7SUFBQUosQ0FBQSxNQUFBSixRQUFBO0lBQUFJLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBRkQsTUFBQUcsWUFBQSxHQUFBRCxFQUVDO0VBQUEsSUFBQUcsRUFBQTtFQUFBLElBQUFMLENBQUEsUUFBQUosUUFBQTtJQUVEUyxFQUFBLFlBQUFDLGFBQUE7TUFDRVYsUUFBUSxDQUFDLFFBQVEsQ0FBQztJQUFBLENBQ25CO0lBQUFJLENBQUEsTUFBQUosUUFBQTtJQUFBSSxDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFMLENBQUE7RUFBQTtFQUZELE1BQUFNLFlBQUEsR0FBQUQsRUFFQztFQUFBLElBQUFFLEVBQUE7RUFBQSxJQUFBUCxDQUFBLFFBQUFMLGNBQUE7SUFVR1ksRUFBQSxJQUFDLElBQUksQ0FBQyxpRkFFZ0JaLGVBQWEsQ0FBRSxFQUNyQyxFQUhDLElBQUksQ0FHRTtJQUFBSyxDQUFBLE1BQUFMLGNBQUE7SUFBQUssQ0FBQSxNQUFBTyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUCxDQUFBO0VBQUE7RUFBQSxJQUFBUSxFQUFBO0VBQUEsSUFBQVIsQ0FBQSxRQUFBUyxNQUFBLENBQUFDLEdBQUE7SUFDUEYsRUFBQSxJQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsa0NBQWtDLEVBQWhELElBQUksQ0FBbUQ7SUFBQVIsQ0FBQSxNQUFBUSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUixDQUFBO0VBQUE7RUFBQSxJQUFBVyxFQUFBO0VBQUEsSUFBQVgsQ0FBQSxRQUFBUyxNQUFBLENBQUFDLEdBQUE7SUFHcERDLEVBQUE7TUFBQUMsS0FBQSxFQUNTLDRDQUE0QztNQUFBUixLQUFBLEVBQzVDLFdBQVcsSUFBSVg7SUFDeEIsQ0FBQztJQUFBTyxDQUFBLE1BQUFXLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFYLENBQUE7RUFBQTtFQUVRLE1BQUFhLEVBQUEsK0JBQTRCbEIsY0FBYywyQkFBMkI7RUFBQSxJQUFBbUIsRUFBQTtFQUFBLElBQUFkLENBQUEsUUFBQWEsRUFBQTtJQU52RUMsRUFBQSxJQUNQSCxFQUdDLEVBQ0Q7TUFBQUMsS0FBQSxFQUNTQyxFQUFxRTtNQUFBVCxLQUFBLEVBQ3JFLE1BQU0sSUFBSVg7SUFDbkIsQ0FBQyxDQUNGO0lBQUFPLENBQUEsTUFBQWEsRUFBQTtJQUFBYixDQUFBLE1BQUFjLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFkLENBQUE7RUFBQTtFQUFBLElBQUFlLEVBQUE7RUFBQSxJQUFBZixDQUFBLFNBQUFHLFlBQUEsSUFBQUgsQ0FBQSxTQUFBYyxFQUFBO0lBVkhDLEVBQUEsSUFBQyxNQUFNLENBQ0ksT0FTUixDQVRRLENBQUFELEVBU1QsQ0FBQyxDQUNTWCxRQUFZLENBQVpBLGFBQVcsQ0FBQyxHQUN0QjtJQUFBSCxDQUFBLE9BQUFHLFlBQUE7SUFBQUgsQ0FBQSxPQUFBYyxFQUFE7SUFBQWQsQ0FBQSxPQUFBZSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZixDQUFBO0VBQUE7RUFBQSxJQUFBZ0IsRUFBQTtFQUFBLElBQUFoQixDQUFBLFNBQUFNLFlBQUEsSUFBQU4sQ0FBQSxTQUFBTyxFQUFBLElBQUFQLENBQUEsU0FBQWVFQUFBO0lBeEJKQyxFQUFBLElBQUMsTUFBTSxDQUNDLEtBQTBCLENBQTFCLDBCQUEwQixDQUN0QlYsUUFBWSxDQUFaQSxhQUFXLENBQUMsQ0FDaEIsS0FBWSxDQUFaLFlBQVksQ0FDbEIsVUFBVSxDQUFWLEtBQVMsQ0FBQyxDQUNWLGNBQWMsQ0FBZCxLQUFhLENBQUMsQ0FFZCxDQUFBQyxFQUdNLENBQ04sQ0FBQUMsRUFBdUQsQ0FDdkQsQ0FBQU8sRUFZQyxDQUNILEVBekJDLE1BQU0sQ0F5QkU7SUFBQWYsQ0FBQSxPQUFBTSxZQUFBO0lBQUFOLENBQUEsT0FBQU8sRUFBQTtJQUFBUCxDQUFBLE9BQUFlLEVBQUE7SUFBQWYsQ0FBQSxPQUFBZ0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWhCLENBQUE7RUFBQTtFQUFBLE9BekJUZ0IsRUF5QlM7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
