/**
 * 【文件概述】Clawd.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动阶段 → Logo 渲染 → Clawd 吉祥物绘制 → 本组件（终端 ASCII 艺术角色）
 *
 * 主要职责：
 *   使用 Unicode 块字符（▐▛▜▌▝▘▗▟▙▖ 等）在终端中绘制 Clawd 吉祥物。
 *   支持四种姿态（default / arms-up / look-left / look-right），并针对
 *   Apple Terminal 的特殊渲染行为使用背景色填充技巧（bg-fill trick）
 *   代替块字符绘制主体形状。
 *
 * 与其他模块的关系：
 *   - 由 AnimatedClawd 调用，根据动画帧序列传入不同 pose
 *   - 依赖 env.terminal 判断是否为 Apple Terminal
 *   - 使用 clawd_body / clawd_background 两个主题色名
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { env } from '../../utils/env.js';

// 四种姿态：默认 | 举臂（跳跃时）| 向左看 | 向右看
export type ClawdPose = 'default' | 'arms-up' // both arms raised (used during jump)
| 'look-left' // both pupils shifted left
| 'look-right'; // both pupils shifted right

type Props = {
  pose?: ClawdPose;
};

// Standard-terminal pose fragments. Each row is split into segments so we can
// vary only the parts that change (eyes, arms) while keeping the body/bg spans
// stable. All poses end up 9 cols wide.
//
// arms-up: the row-2 arm shapes (▝▜ / ▛▘) move to row 1 as their
// bottom-heavy mirrors (▗▟ / ▙▖) — same silhouette, one row higher.
//
// look-* use top-quadrant eye chars (▙/▟) so both eyes change from the
// default (▛/▜, bottom pupils) — otherwise only one eye would appear to move.
/**
 * 姿态分段结构：每行拆分为「左侧无背景色」「中间带背景色（眼睛/身体）」「右侧无背景色」三段，
 * 只有变化的部分（眼睛、手臂）才会引发 React Compiler 缓存失效，身体 bg 段始终稳定复用。
 * 所有姿态渲染宽度均为 9 列。
 */
type Segments = {
  /** row 1 left (no bg): optional raised arm + side */
  r1L: string;
  /** row 1 eyes (with bg): left-eye, forehead, right-eye */
  r1E: string;
  /** row 1 right (no bg): side + optional raised arm */
  r1R: string;
  /** row 2 left (no bg): arm + body curve */
  r2L: string;
  /** row 2 right (no bg): body curve + arm */
  r2R: string;
};

/**
 * POSES：标准终端下各姿态的 Unicode 块字符片段映射表。
 *
 * - default：  默认站立，眼睛居中（▛███▜），手臂垂下（▝▜ / ▛▘）
 * - look-left：向左看，双眼瞳孔使用上半块字符 ▟，整行变为 ▟███▟
 * - look-right：向右看，使用 ▙，整行变为 ▙███▙
 * - arms-up：  举臂跳跃，第一行加入手臂字符（▗▟ / ▙▖），第二行手臂缩短
 */
const POSES: Record<ClawdPose, Segments> = {
  default: {
    r1L: ' ▐',
    r1E: '▛███▜',
    r1R: '▌',
    r2L: '▝▜',
    r2R: '▛▘'
  },
  'look-left': {
    r1L: ' ▐',
    r1E: '▟███▟',
    r1R: '▌',
    r2L: '▝▜',
    r2R: '▛▘'
  },
  'look-right': {
    r1L: ' ▐',
    r1E: '▙███▙',
    r1R: '▌',
    r2L: '▝▜',
    r2R: '▛▘'
  },
  'arms-up': {
    r1L: '▗▟',
    r1E: '▛███▜',
    r1R: '▙▖',
    r2L: ' ▜',
    r2R: '▛ '
  }
};

// Apple Terminal uses a bg-fill trick (see below), so only eye poses make
// sense. Arm poses fall back to default.
/**
 * APPLE_EYES：Apple Terminal 专用眼睛行字符串映射。
 *
 * Apple Terminal 在背景色 span 之间不留缝隙，但字符间会有行间距，
 * 因此身体部分改用背景色填充；眼睛仍使用块字符，但字形选用四象限变体：
 *   - default / arms-up：▗ ▖（下半块，模拟向前看）
 *   - look-left：▘ ▘（左上块，模拟向左看）
 *   - look-right：▝ ▝（右上块，模拟向右看）
 */
const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ▗   ▖ ',
  'look-left': ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up': ' ▗   ▖ '
};

/**
 * Clawd — 主渲染组件，根据终端类型分支渲染吉祥物。
 *
 * 整体流程：
 *   1. props 解构，pose 缺省为 'default'（React Compiler 的 props 规范化处理）
 *   2. 若检测到 Apple Terminal，交给 AppleTerminalClawd 处理（缓存槽 2-3）
 *   3. 否则读取 POSES[pose]，分三行渲染：
 *      - 第一行（头部/眼睛行）：r1L + r1E（带背景色）+ r1R → t6（缓存槽 4-13）
 *      - 第二行（身体行）：r2L + 固定体块████（带背景色，静态）+ r2R → t10（缓存槽 14-21）
 *      - 第三行（脚部行）：静态 ▘▘ ▝▝ → t11（缓存槽 22）
 *   4. 用 Box flexDirection="column" 包裹三行返回（缓存槽 23-25）
 *
 * React Compiler 优化：
 *   共 26 个缓存槽（_c(26)），只有姿态变化时对应行才重建，身体段（████）永远只建一次。
 */
export function Clawd(t0) {
  // React Compiler 注入的 26 槽 memoization 缓存
  const $ = _c(26);

  // ── 槽 0-1：props 规范化 ──────────────────────────────────────────────────
  // React Compiler 将 `{ pose = 'default' }: Props = {}` 编译为：
  //   若 t0 未定义则置为空对象，再解构取 pose（undefined → 'default'）
  let t1;
  if ($[0] !== t0) {
    t1 = t0 === undefined ? {} : t0;
    $[0] = t0;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const {
    pose: t2
  } = t1;
  // pose 缺省为 'default'
  const pose = t2 === undefined ? "default" : t2;

  // ── Apple Terminal 分支（槽 2-3）──────────────────────────────────────────
  // Apple Terminal 的行间距使块字符出现裂缝，改用 AppleTerminalClawd 的背景色填充方案
  if (env.terminal === "Apple_Terminal") {
    let t3;
    if ($[2] !== pose) {
      t3 = <AppleTerminalClawd pose={pose} />;
      $[2] = pose;
      $[3] = t3;
    } else {
      t3 = $[3];
    }
    return t3;
  }

  // 取当前姿态的各段字符串
  const p = POSES[pose];

  // ── 第一行：头部 / 眼睛行 ─────────────────────────────────────────────────

  // 槽 4-5：r1L（左侧无背景）
  let t3;
  if ($[4] !== p.r1L) {
    t3 = <Text color="clawd_body">{p.r1L}</Text>;
    $[4] = p.r1L;
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // 槽 6-7：r1E（眼睛/额头段，带背景色区分深浅）
  let t4;
  if ($[6] !== p.r1E) {
    t4 = <Text color="clawd_body" backgroundColor="clawd_background">{p.r1E}</Text>;
    $[6] = p.r1E;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // 槽 8-9：r1R（右侧无背景）
  let t5;
  if ($[8] !== p.r1R) {
    t5 = <Text color="clawd_body">{p.r1R}</Text>;
    $[8] = p.r1R;
    $[9] = t5;
  } else {
    t5 = $[9];
  }

  // 槽 10-13：将三段合并为第一行 Text 节点，任一段变化时重建
  let t6;
  if ($[10] !== t3 || $[11] !== t4 || $[12] !== t5) {
    t6 = <Text>{t3}{t4}{t5}</Text>;
    $[10] = t3;
    $[11] = t4;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // ── 第二行：身体行 ────────────────────────────────────────────────────────

  // 槽 14-15：r2L（左臂/身体曲线，无背景）
  let t7;
  if ($[14] !== p.r2L) {
    t7 = <Text color="clawd_body">{p.r2L}</Text>;
    $[14] = p.r2L;
    $[15] = t7;
  } else {
    t7 = $[15];
  }

  // 槽 16：固定身体块（█████，带背景色），纯静态，整个生命周期只创建一次
  let t8;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Text color="clawd_body" backgroundColor="clawd_background">█████</Text>;
    $[16] = t8;
  } else {
    t8 = $[16];
  }

  // 槽 17-18：r2R（右身体曲线/右臂，无背景）
  let t9;
  if ($[17] !== p.r2R) {
    t9 = <Text color="clawd_body">{p.r2R}</Text>;
    $[17] = p.r2R;
    $[18] = t9;
  } else {
    t9 = $[18];
  }

  // 槽 19-21：合并左臂 + 体块 + 右臂为第二行（t8 静态，不参与 deps 判断）
  let t10;
  if ($[19] !== t7 || $[20] !== t9) {
    t10 = <Text>{t7}{t8}{t9}</Text>;
    $[19] = t7;
    $[20] = t9;
    $[21] = t10;
  } else {
    t10 = $[21];
  }

  // ── 第三行：脚部行（静态，槽 22）──────────────────────────────────────────
  // ▘▘ ▝▝ 表示两只脚，左右各两个下半块字符，全姿态通用
  let t11;
  if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <Text color="clawd_body">{"  "}▘▘ ▝▝{"  "}</Text>;
    $[22] = t11;
  } else {
    t11 = $[22];
  }

  // ── 槽 23-25：外层 Box，将三行垂直排列 ────────────────────────────────────
  // 依赖 t6（头）和 t10（身体），t11（脚）静态不参与判断
  let t12;
  if ($[23] !== t10 || $[24] !== t6) {
    t12 = <Box flexDirection="column">{t6}{t10}{t11}</Box>;
    $[23] = t10;
    $[24] = t6;
    $[25] = t12;
  } else {
    t12 = $[25];
  }
  return t12;
}

/**
 * AppleTerminalClawd — Apple Terminal 专用渲染路径。
 *
 * 背景：Apple Terminal 在字符之间默认渲染额外行间距，导致块字符之间出现裂缝，
 * 无法拼出完整实心轮廓。解决方案：用背景色填充绘制身体主体（背景色之间不留间距），
 * 只保留眼睛行使用块字符。
 *
 * 整体流程：
 *   1. t1（槽 0）：静态左耳字符 ▗
 *   2. t2：读取 APPLE_EYES[pose] 眼睛行字符串（随 pose 变化）
 *   3. t3（槽 1-2）：眼睛 Text，前景=clawd_background、背景=clawd_body（颜色反转）
 *   4. t4（槽 3）：静态右耳字符 ▖
 *   5. t5（槽 4-5）：眼睛行 = ▗ + 眼睛段 + ▖ 合并为一个 Text 节点
 *   6. t6（槽 6）：静态身体行——7 个空格填满背景色（backgroundColor="clawd_body"）
 *   7. t7（槽 6）：静态脚部行 ▘▘ ▝▝（与 t6 共用同一个哨兵槽）
 *   8. t8（槽 8-9）：Box 包裹三行，alignItems="center" 居中对齐
 *
 * React Compiler：共 10 个缓存槽（_c(10)），仅眼睛行随 pose 变化重建。
 */
function AppleTerminalClawd(t0) {
  // React Compiler 10 槽缓存
  const $ = _c(10);
  const {
    pose
  } = t0;

  // 槽 0：静态左耳 ▗（仅首次创建）
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text color="clawd_body">▗</Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }

  // 取当前姿态的眼睛行字符串（随 pose 变化）
  const t2 = APPLE_EYES[pose];

  // 槽 1-2：眼睛 Text 节点（颜色反转：前景用背景色，背景用体色，形成空洞效果）
  let t3;
  if ($[1] !== t2) {
    t3 = <Text color="clawd_background" backgroundColor="clawd_body">{t2}</Text>;
    $[1] = t2;
    $[2] = t3;
  } else {
    t3 = $[2];
  }

  // 槽 3：静态右耳 ▖（仅首次创建）
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text color="clawd_body">▖</Text>;
    $[3] = t4;
  } else {
    t4 = $[3];
  }

  // 槽 4-5：眼睛行 = 左耳 + 眼睛段 + 右耳，t3 变化时重建
  let t5;
  if ($[4] !== t3) {
    t5 = <Text>{t1}{t3}{t4}</Text>;
    $[4] = t3;
    $[5] = t5;
  } else {
    t5 = $[5];
  }

  // 槽 6-7：身体行（7 空格背景色）和脚部行（▘▘ ▝▝）共用同一个哨兵槽，一次性创建
  let t6;
  let t7;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    // 身体行：用背景色填充 7 列，Apple Terminal 背景色之间无行间距，形成实心矩形
    t6 = <Text backgroundColor="clawd_body">{" ".repeat(7)}</Text>;
    // 脚部行：块字符绘制两只脚
    t7 = <Text color="clawd_body">▘▘ ▝▝</Text>;
    $[6] = t6;
    $[7] = t7;
  } else {
    t6 = $[6];
    t7 = $[7];
  }

  // 槽 8-9：外层 Box，列方向 + 居中，t5（眼睛行）变化时重建
  let t8;
  if ($[8] !== t5) {
    t8 = <Box flexDirection="column" alignItems="center">{t5}{t6}{t7}</Box>;
    $[8] = t5;
    $[9] = t8;
  } else {
    t8 = $[9];
  }
  return t8;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJlbnYiLCJDbGF3ZFBvc2UiLCJQcm9wcyIsInBvc2UiLCJTZWdtZW50cyIsInIxTCIsInIxRSIsInIxUiIsInIyTCIsInIyUiIsIlBPU0VTIiwiUmVjb3JkIiwiZGVmYXVsdCIsIkFQUExFX0VZRVMiLCJDbGF3ZCIsInQwIiwiJCIsIl9jIiwidDEiLCJ1bmRlZmluZWQiLCJ0MiIsInRlcm1pbmFsIiwidDMiLCJwIiwidDQiLCJ0NSIsInQ2IiwidDciLCJ0OCIsIlN5bWJvbCIsImZvciIsInQ5IiwidDEwIiwidDExIiwidDEyIiwiQXBwbGVUZXJtaW5hbENsYXdkIiwicmVwZWF0Il0sInNvdXJjZXMiOlsiQ2xhd2QudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZW52IH0gZnJvbSAnLi4vLi4vdXRpbHMvZW52LmpzJ1xuXG5leHBvcnQgdHlwZSBDbGF3ZFBvc2UgPVxuICB8ICdkZWZhdWx0J1xuICB8ICdhcm1zLXVwJyAvLyBib3RoIGFybXMgcmFpc2VkICh1c2VkIGR1cmluZyBqdW1wKVxuICB8ICdsb29rLWxlZnQnIC8vIGJvdGggcHVwaWxzIHNoaWZ0ZWQgbGVmdFxuICB8ICdsb29rLXJpZ2h0JyAvLyBib3RoIHB1cGlscyBzaGlmdGVkIHJpZ2h0XG5cbnR5cGUgUHJvcHMgPSB7XG4gIHBvc2U/OiBDbGF3ZFBvc2Vcbn1cblxuLy8gU3RhbmRhcmQtdGVybWluYWwgcG9zZSBmcmFnbWVudHMuIEVhY2ggcm93IGlzIHNwbGl0IGludG8gc2VnbWVudHMgc28gd2UgY2FuXG4vLyB2YXJ5IG9ubHkgdGhlIHBhcnRzIHRoYXQgY2hhbmdlIChleWVzLCBhcm1zKSB3aGlsZSBrZWVwaW5nIHRoZSBib2R5L2JnIHNwYW5zXG4vLyBzdGFibGUuIEFsbCBwb3NlcyBlbmQgdXAgOSBjb2xzIHdpZGUuXG4vL1xuLy8gYXJtcy11cDogdGhlIHJvdy0yIGFybSBzaGFwZXMgKOKWneKWnCAvIOKWm+KWmCkgbW92ZSB0byByb3cgMSBhcyB0aGVpclxuLy8gYm90dG9tLWhlYXZ5IG1pcnJvcnMgKOKWl+KWnyAvIOKWmeKWlikg4oCUIHNhbWUgc2lsaG91ZXR0ZSwgb25lIHJvdyBoaWdoZXIuXG4vL1xuLy8gbG9vay0qIHVzZSB0b3AtcXVhZHJhbnQgZXllIGNoYXJzICjilpkv4pafKSBzbyBib3RoIGV5ZXMgY2hhbmdlIGZyb20gdGhlXG4vLyBkZWZhdWx0ICjilpsv4pacLCBib3R0b20gcHVwaWxzKSDigJQgb3RoZXJ3aXNlIG9ubHkgb25lIGV5ZSB3b3VsZCBhcHBlYXIgdG8gbW92ZS5cbnR5cGUgU2VnbWVudHMgPSB7XG4gIC8qKiByb3cgMSBsZWZ0IChubyBiZyk6IG9wdGlvbmFsIHJhaXNlZCBhcm0gKyBzaWRlICovXG4gIHIxTDogc3RyaW5nXG4gIC8qKiByb3cgMSBleWVzICh3aXRoIGJnKTogbGVmdC1leWUsIGZvcmVoZWFkLCByaWdodC1leWUgKi9cbiAgcjFFOiBzdHJpbmdcbiAgLyoqIHJvdyAxIHJpZ2h0IChubyBiZyk6IHNpZGUgKyBvcHRpb25hbCByYWlzZWQgYXJtICovXG4gIHIxUjogc3RyaW5nXG4gIC8qKiByb3cgMiBsZWZ0IChubyBiZyk6IGFybSArIGJvZHkgY3VydmUgKi9cbiAgcjJMOiBzdHJpbmdcbiAgLyoqIHJvdyAyIHJpZ2h0IChubyBiZyk6IGJvZHkgY3VydmUgKyBhcm0gKi9cbiAgcjJSOiBzdHJpbmdcbn1cblxuY29uc3QgUE9TRVM6IFJlY29yZDxDbGF3ZFBvc2UsIFNlZ21lbnRzPiA9IHtcbiAgZGVmYXVsdDogeyByMUw6ICcg4paQJywgcjFFOiAn4pab4paI4paI4paI4pacJywgcjFSOiAn4paMJywgcjJMOiAn4pad4pacJywgcjJSOiAn4pab4paYJyB9LFxuICAnbG9vay1sZWZ0JzogeyByMUw6ICcg4paQJywgcjFFOiAn4paf4paI4paI4paI4pafJywgcjFSOiAn4paMJywgcjJMOiAn4pad4pacJywgcjJSOiAn4pab4paYJyB9LFxuICAnbG9vay1yaWdodCc6IHsgcjFMOiAnIOKWkCcsIHIxRTogJ+KWmeKWiOKWiOKWiOKWmScsIHIxUjogJ+KWjCcsIHIyTDogJ+KWneKWnCcsIHIyUjogJ+KWm+KWmCcgfSxcbiAgJ2FybXMtdXAnOiB7IHIxTDogJ+KWl+KWnycsIHIxRTogJ+KWm+KWiOKWiOKWiOKWnCcsIHIxUjogJ+KWmeKWlicsIHIyTDogJyDilpwnLCByMlI6ICfilpsgJyB9LFxufVxuXG4vLyBBcHBsZSBUZXJtaW5hbCB1c2VzIGEgYmctZmlsbCB0cmljayAoc2VlIGJlbG93KSwgc28gb25seSBleWUgcG9zZXMgbWFrZVxuLy8gc2Vuc2UuIEFybSBwb3NlcyBmYWxsIGJhY2sgdG8gZGVmYXVsdC5cbmNvbnN0IEFQUExFX0VZRVM6IFJlY29yZDxDbGF3ZFBvc2UsIHN0cmluZz4gPSB7XG4gIGRlZmF1bHQ6ICcg4paXICAg4paWICcsXG4gICdsb29rLWxlZnQnOiAnIOKWmCAgIOKWmCAnLFxuICAnbG9vay1yaWdodCc6ICcg4padICAg4padICcsXG4gICdhcm1zLXVwJzogJyDilpcgICDilpYgJyxcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIENsYXdkKHsgcG9zZSA9ICdkZWZhdWx0JyB9OiBQcm9wcyA9IHt9KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKGVudi50ZXJtaW5hbCA9PT0gJ0FwcGxlX1Rlcm1pbmFsJykge1xuICAgIHJldHVybiA8QXBwbGVUZXJtaW5hbENsYXdkIHBvc2U9e3Bvc2V9IC8+XG4gIH1cbiAgY29uc3QgcCA9IFBPU0VTW3Bvc2VdXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8VGV4dD5cbiAgICAgICAgPFRleHQgY29sb3I9XCJjbGF3ZF9ib2R5XCI+e3AucjFMfTwvVGV4dD5cbiAgICAgICAgPFRleHQgY29sb3I9XCJjbGF3ZF9ib2R5XCIgYmFja2dyb3VuZENvbG9yPVwiY2xhd2RfYmFja2dyb3VuZFwiPlxuICAgICAgICAgIHtwLnIxRX1cbiAgICAgICAgPC9UZXh0PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImNsYXdkX2JvZHlcIj57cC5yMVJ9PC9UZXh0PlxuICAgICAgPC9UZXh0PlxuICAgICAgPFRleHQ+XG4gICAgICAgIDxUZXh0IGNvbG9yPVwiY2xhd2RfYm9keVwiPntwLnIyTH08L1RleHQ+XG4gICAgICAgIDxUZXh0IGNvbG9yPVwiY2xhd2RfYm9keVwiIGJhY2tncm91bmRDb2xvcj1cImNsYXdkX2JhY2tncm91bmRcIj5cbiAgICAgICAgICDilojilojilojilojilohcbiAgICAgICAgPC9UZXh0PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImNsYXdkX2JvZHlcIj57cC5yMlJ9PC9UZXh0PlxuICAgICAgPC9UZXh0PlxuICAgICAgPFRleHQgY29sb3I9XCJjbGF3ZF9ib2R5XCI+XG4gICAgICAgIHsnICAnfeKWmOKWmCDilp3ilp17JyAgJ31cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuXG5mdW5jdGlvbiBBcHBsZVRlcm1pbmFsQ2xhd2QoeyBwb3NlIH06IHsgcG9zZTogQ2xhd2RQb3NlIH0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBBcHBsZSdzIFRlcm1pbmFsIHJlbmRlcnMgdmVydGljYWwgc3BhY2UgYmV0d2VlbiBjaGFycyBieSBkZWZhdWx0LlxuICAvLyBJdCBkb2VzIE5PVCByZW5kZXIgdmVydGljYWwgc3BhY2UgYmV0d2VlbiBiYWNrZ3JvdW5kIGNvbG9yc1xuICAvLyBzbyB3ZSB1c2UgYmFja2dyb3VuZCBjb2xvciB0byBkcmF3IHRoZSBtYWluIHNoYXBlLlxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIGFsaWduSXRlbXM9XCJjZW50ZXJcIj5cbiAgICAgIDxUZXh0PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImNsYXdkX2JvZHlcIj7ilpc8L1RleHQ+XG4gICAgICAgIDxUZXh0IGNvbG9yPVwiY2xhd2RfYmFja2dyb3VuZFwiIGJhY2tncm91bmRDb2xvcj1cImNsYXdkX2JvZHlcIj5cbiAgICAgICAgICB7QVBQTEVFWUVTW3Bvc2VdfVxuICAgICAgICA8L1RleHQ+XG4gICAgICAgIDxUZXh0IGNvbG9yPVwiY2xhd2RfYm9keVwiPuKWljwvVGV4dD5cbiAgICAgIDwvVGV4dD5cbiAgICAgIDxUZXh0IGJhY2tncm91bmRDb2xvcj1cImNsYXdkX2JvZHlcIj57JyAnLnJlcGVhdCg3KX08L1RleHQ+XG4gICAgICA8VGV4dCBjb2xvcj1cImNsYXdkX2JvZHlcIj7ilpjilpgg4padilp9cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLFNBQVNDLEdBQUcsUUFBUSxvQkFBb0I7QUFFeEMsT0FBTyxLQUFLQyxTQUFTLEdBQ2pCLFNBQVMsR0FDVCxTQUFTLENBQUM7QUFBQSxFQUNWLFdBQVcsQ0FBQztBQUFBLEVBQ1osWUFBWSxFQUFDOztBQUVqQixLQUFLQyxLQUFLLEdBQUc7RUFDWEMsSUFBSSxDQUFDLEVBQUVGLFNBQVM7QUFDbEIsQ0FBQzs7QUFFRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxLQUFLRyxRQUFRLEdBQUc7RUFDZDtFQUNBQyxHQUFHLEVBQUUsTUFBTTtFQUNYO0VBQ0FDLEdBQUcsRUFBRSxNQUFNO0VBQ1g7RUFDQUMsR0FBRyxFQUFFLE1BQU07RUFDWDtFQUNBQyxHQUFHLEVBQUUsTUFBTTtFQUNYO0VBQ0FDLEdBQUcsRUFBRSxNQUFNO0FBQ2IsQ0FBQztBQUVELE1BQU1DLEtBQUssRUFBRUMsTUFBTSxDQUFDVixTQUFTLEVBQUVHLFFBQVEsQ0FBQyxHQUFHO0VBQ3pDUSxPQUFPLEVBQUU7SUFBRVAsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFLE9BQU87SUFBRUMsR0FBRyxFQUFFLEdBQUc7SUFBRUMsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFO0VBQUssQ0FBQztFQUNwRSxXQUFXLEVBQUU7SUFBRUosR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFLE9BQU87SUFBRUMsR0FBRyxFQUFFLEdBQUc7SUFBRUMsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFO0VBQUssQ0FBQztFQUN4RSxZQUFZLEVBQUU7SUFBRUosR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFLE9BQU87SUFBRUMsR0FBRyxFQUFFLEdBQUc7SUFBRUMsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFO0VBQUssQ0FBQztFQUN6RSxTQUFTLEVBQUU7SUFBRUosR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFLE9BQU87SUFBRUMsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFLElBQUk7SUFBRUMsR0FBRyxFQUFFO0VBQUs7QUFDeEUsQ0FBQzs7QUFFRDtBQUNBO0FBQ0EsTUFBTUksVUFBVSxFQUFFRixNQUFNLENBQUNWLFNBQVMsRUFBRSxNQUFNLENBQUMsR0FBRztFQUM1Q1csT0FBTyxFQUFFLFNBQVM7RUFDbEIsV0FBVyxFQUFFLFNBQVM7RUFDdEIsWUFBWSxFQUFFLFNBQVM7RUFDdkIsU0FBUyxFQUFFO0FBQ2IsQ0FBQztBQUVELE9BQU8sU0FBQUUsTUFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBRixDQUFBLFFBQUFELEVBQUE7SUFBZUcsRUFBQSxHQUFBSCxFQUFnQyxLQUFoQ0ksU0FBZ0MsR0FBaEMsQ0FBK0IsQ0FBQyxHQUFoQ0osRUFBZ0M7SUFBQUMsQ0FBQSxNQUFBRCxFQUFBO0lBQUFDLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBQWhDO0lBQUFiLElBQUEsRUFBQWlCO0VBQUEsSUFBQUYsRUFBZ0M7RUFBOUIsTUFBQWYsSUFBQSxHQUFBaUIsRUFBZ0IsS0FBaEJELFNBQWdCLEdBQWhCLFNBQWdCLEdBQWhCQyxFQUFnQjtFQUN0QyxJQUFJcEIsR0FBRyxDQUFBcUIsUUFBUyxLQUFLLGdCQUFnQjtJQUFBLElBQUFDLEVBQUE7SUFBQSxJQUFBTixDQUFBLFFBQUFiLElBQUE7TUFDNUJBLEVBQUF...

