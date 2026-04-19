/**
 * ComputerUseApproval/ComputerUseApproval.tsx
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件是 Computer Use（计算机控制）功能的权限批准入口组件。当 Claude 的
 * Computer Use MCP 工具需要控制 macOS 应用程序时，本文件负责展示权限批准对话框。
 * 根据当前的 macOS TCC（透明度、许可与控制）权限状态，分发到两个子面板之一：
 * - 若 TCC 权限缺失（辅助功能/屏幕录制未授权），显示引导用户开启系统权限的 TCC 面板
 * - 若 TCC 权限已就绪，显示应用程序允许列表面板，让用户选择允许 Claude 控制哪些 APP
 *
 * 【主要功能】
 * - 定义 ComputerUseApprovalProps 和 DENY_ALL_RESPONSE 常量
 * - ComputerUseApproval：顶层调度组件，根据 tccState 选择渲染哪个子面板
 * - ComputerUseTccPanel：macOS TCC 权限引导面板（辅助功能 / 屏幕录制）
 * - ComputerUseAppListPanel：应用程序允许列表面板（支持 Sentinel 风险警告）
 * - 使用 React Compiler 运行时（_c）进行细粒度缓存
 */

import { c as _c } from "react/compiler-runtime";
import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps';
import type { CuPermissionRequest, CuPermissionResponse } from '@ant/computer-use-mcp/types';
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp/types';
import figures from 'figures';
import * as React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from '../../../ink.js';
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js';
import { plural } from '../../../utils/stringUtils.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { Select } from '../../CustomSelect/select.js';
import { Dialog } from '../../design-system/Dialog.js';

// 组件 Props 类型：接收 CU 权限请求对象和完成回调
type ComputerUseApprovalProps = {
  request: CuPermissionRequest;
  onDone: (response: CuPermissionResponse) => void;
};

// 拒绝所有权限的默认响应（无授权应用、无拒绝应用，使用默认标志）
const DENY_ALL_RESPONSE: CuPermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_GRANT_FLAGS
};

/**
 * ComputerUseApproval — 顶层调度组件
 *
 * 【调度逻辑】
 * - 若 request.tccState 存在，说明 macOS 系统权限（辅助功能/屏幕录制）尚未授予，
 *   显示 TCC 引导面板，取消时以 DENY_ALL_RESPONSE 调用 onDone
 * - 否则显示应用程序允许列表面板，直接传递 request 和 onDone
 */
export function ComputerUseApproval(t0) {
  // React Compiler 缓存槽，共 3 个槽位
  const $ = _c(3);
  const {
    request,   // CU 权限请求（含应用列表、标志、TCC 状态等）
    onDone     // 完成回调，接收 CuPermissionResponse
  } = t0;
  let t1;
  if ($[0] !== onDone || $[1] !== request) {
    // 根据 tccState 决定渲染哪个子面板
    t1 = request.tccState
      ? <ComputerUseTccPanel tccState={request.tccState} onDone={() => onDone(DENY_ALL_RESPONSE)} />
      : <ComputerUseAppListPanel request={request} onDone={onDone} />;
    $[0] = onDone;
    $[1] = request;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  return t1;
}

// ── TCC panel ─────────────────────────────────────────────────────────────

// TCC 面板的选项值类型：打开辅助功能设置 / 打开屏幕录制设置 / 重试
type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry';

/**
 * ComputerUseTccPanel — macOS TCC 权限引导面板
 *
 * 【渲染逻辑】
 * 1. 根据 tccState.accessibility 和 tccState.screenRecording 状态动态构建选项：
 *    - 辅助功能未授权时：追加"打开系统设置 → 辅助功能"选项
 *    - 屏幕录制未授权时：追加"打开系统设置 → 屏幕录制"选项
 *    - 始终追加"重试"选项
 * 2. 选择"打开设置"选项时，通过 execFileNoThrow 以 URL Scheme 打开对应的系统设置页面
 * 3. 选择"重试"时调用 onDone()，让模型重新调用 request_access（重新检查 TCC 状态）
 * 4. 以 ✓/✗ 符号展示当前权限状态，提示用户授权后重启 Claude Code
 */
function ComputerUseTccPanel(t0) {
  // React Compiler 缓存槽，共 26 个槽位
  const $ = _c(26);
  const {
    tccState,  // TCC 状态：{ accessibility: boolean, screenRecording: boolean }
    onDone     // 面板关闭回调
  } = t0;

  // ── 动态构建选项列表（根据哪些权限缺失） ──────────────────────────────
  let opts;
  if ($[0] !== tccState.accessibility || $[1] !== tccState.screenRecording) {
    opts = [];
    if (!tccState.accessibility) {
      // 辅助功能未授权时，追加打开对应设置页面的选项
      let t1;
      if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = {
          label: "Open System Settings \u2192 Accessibility",  // → 辅助功能
          value: "open_accessibility"
        };
        $[3] = t1;
      } else {
        t1 = $[3];
      }
      opts.push(t1);
    }
    if (!tccState.screenRecording) {
      // 屏幕录制未授权时，追加打开对应设置页面的选项
      let t1;
      if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = {
          label: "Open System Settings \u2192 Screen Recording",  // → 屏幕录制
          value: "open_screen_recording"
        };
        $[4] = t1;
      } else {
        t1 = $[4];
      }
      opts.push(t1);
    }
    // 始终追加"重试"选项
    let t1;
    if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = {
        label: "Try again",
        value: "retry"
      };
      $[5] = t1;
    } else {
      t1 = $[5];
    }
    opts.push(t1);
    $[0] = tccState.accessibility;
    $[1] = tccState.screenRecording;
    $[2] = opts;
  } else {
    opts = $[2];
  }
  const options = opts;

  // ── 选项选择处理 ────────────────────────────────────────────────────────
  let t1;
  if ($[6] !== onDone) {
    t1 = function onChange(value) {
      switch (value) {
        case "open_accessibility":
          {
            // 通过 URL Scheme 打开 macOS 系统设置 → 隐私与安全 → 辅助功能
            execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
              useCwd: false
            });
            return;
          }
        case "open_screen_recording":
          {
            // 通过 URL Scheme 打开 macOS 系统设置 → 隐私与安全 → 屏幕录制
            execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], {
              useCwd: false
            });
            return;
          }
        case "retry":
          {
            // 重试：以 deny-all 结果返回，让模型重新调用 request_access 检查 TCC 状态
            onDone();
            return;
          }
      }
    };
    $[6] = onDone;
    $[7] = t1;
  } else {
    t1 = $[7];
  }
  const onChange = t1;

  // ── 辅助功能权限状态文本（✓ granted / ✗ not granted） ──────────────────
  const t2 = tccState.accessibility ? `${figures.tick} granted` : `${figures.cross} not granted`;
  let t3;
  if ($[8] !== t2) {
    t3 = <Text>Accessibility:{" "}{t2}</Text>;
    $[8] = t2;
    $[9] = t3;
  } else {
    t3 = $[9];
  }

  // ── 屏幕录制权限状态文本 ────────────────────────────────────────────────
  const t4 = tccState.screenRecording ? `${figures.tick} granted` : `${figures.cross} not granted`;
  let t5;
  if ($[10] !== t4) {
    t5 = <Text>Screen Recording:{" "}{t4}</Text>;
    $[10] = t4;
    $[11] = t5;
  } else {
    t5 = $[11];
  }

  // ── 权限状态展示区域 ────────────────────────────────────────────────────
  let t6;
  if ($[12] !== t3 || $[13] !== t5) {
    t6 = <Box flexDirection="column">{t3}{t5}</Box>;
    $[12] = t3;
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14];
  }

  // ── 提示文本（静态，仅构建一次） ────────────────────────────────────────
  let t7;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    // 提示用户在系统设置中授权后点击"重试"，屏幕录制权限可能需要重启 Claude Code
    t7 = <Text dimColor={true}>Grant the missing permissions in System Settings, then select "Try again". macOS may require you to restart Claude Code after granting Screen Recording.</Text>;
    $[15] = t7;
  } else {
    t7 = $[15];
  }

  // ── 选项选择组件 ────────────────────────────────────────────────────────
  let t8;
  if ($[16] !== onChange || $[17] !== onDone || $[18] !== options) {
    t8 = <Select options={options} onChange={onChange} onCancel={onDone} />;
    $[16] = onChange;
    $[17] = onDone;
    $[18] = options;
    $[19] = t8;
  } else {
    t8 = $[19];
  }

  // ── 内容区域（状态 + 提示 + 选项） ─────────────────────────────────────
  let t9;
  if ($[20] !== t6 || $[21] !== t8) {
    t9 = <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{t6}{t7}{t8}</Box>;
    $[20] = t6;
    $[21] = t8;
    $[22] = t9;
  } else {
    t9 = $[22];
  }

  // ── 最终渲染：Dialog 包裹内容区域 ──────────────────────────────────────
  let t10;
  if ($[23] !== onDone || $[24] !== t9) {
    t10 = <Dialog title="Computer Use needs macOS permissions" onCancel={onDone}>{t9}</Dialog>;
    $[23] = onDone;
    $[24] = t9;
    $[25] = t10;
  } else {
    t10 = $[25];
  }
  return t10;
}

// ── App allowlist panel ───────────────────────────────────────────────────

// 应用列表面板的选项值类型：允许本次会话 / 拒绝
type AppListOption = 'allow_all' | 'deny';

// Sentinel 应用风险警告文本映射（shell/文件系统/系统设置类应用具有更高风险）
const SENTINEL_WARNING: Record<NonNullable<ReturnType<typeof getSentinelCategory>>, string> = {
  shell: 'equivalent to shell access',          // 等同于 shell 访问权限
  filesystem: 'can read/write any file',        // 可读写任意文件
  system_settings: 'can change system settings' // 可更改系统设置
};

/**
 * ComputerUseAppListPanel — 应用程序允许列表面板
 *
 * 【渲染逻辑】
 * 1. 初始化 checked 集合：预勾选所有已解析且尚未授权的应用（Sentinel 应用也预勾选，
 *    通过警告文本而非取消勾选来提示风险）
 * 2. 过滤出 requestedFlagKeys（用户请求的附加权限标志：剪贴板读写、系统快捷键）
 * 3. 构建两个选项：
 *    - allow_all：允许本次会话，标签显示已勾选应用数量
 *    - deny：拒绝，提示用户告知 Claude 做什么不同的事
 * 4. respond(allow) 函数：
 *    - 若 allow=false：返回 DENY_ALL_RESPONSE
 *    - 若 allow=true：构建 granted（已勾选且已解析的应用）和 denied（未解析或未勾选的应用）
 *      列表，合并请求的 flag（全部置 true），调用 onDone
 * 5. 渲染应用列表：
 *    - 未安装：灰色圆圈 + "(not installed)"
 *    - 已授权：✓ + "(already granted)"
 *    - 正常：填充圆圈/空圆圈 + 应用名，Sentinel 应用显示警告图标和风险说明
 * 6. 渲染附加权限标志列表（若有）
 * 7. 渲染将被隐藏的应用数量提示（若有）
 */
function ComputerUseAppListPanel(t0) {
  // React Compiler 缓存槽，共 48 个槽位
  const $ = _c(48);
  const {
    request,   // CU 权限请求（含应用列表、请求标志等）
    onDone     // 完成回调，接收 CuPermissionResponse
  } = t0;

  // ── 初始化已勾选应用集合（预勾选所有已解析且未授权的应用） ──────────
  let t1;
  if ($[0] !== request.apps) {
    // 使用惰性初始化函数，避免重复执行
    t1 = () => new Set(request.apps.flatMap(_temp));  // _temp：提取已解析且未授权的 bundleId
    $[0] = request.apps;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const [checked] = useState(t1);  // checked 为已勾选 bundleId 的 Set，setChecked 暂未使用

  // ── 所有支持的权限标志键（用于过滤用户请求的标志） ──────────────────
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = ["clipboardRead", "clipboardWrite", "systemKeyCombos"];  // 剪贴板读/写、系统快捷键
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const ALL_FLAG_KEYS = t2;

  // ── 过滤出本次实际请求的标志键 ──────────────────────────────────────
  let t3;
  if ($[3] !== request.requestedFlags) {
    t3 = ALL_FLAG_KEYS.filter(k => request.requestedFlags[k]);
    $[3] = request.requestedFlags;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const requestedFlagKeys = t3;

  // ── 构建"允许本次会话"选项标签（包含已勾选应用数量） ──────────────
  const t4 = checked.size;
  let t5;
  if ($[5] !== checked.size) {
    t5 = plural(checked.size, "app");  // "app" 或 "apps"
    $[5] = checked.size;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  const t6 = `Allow for this session (${t4} ${t5})`;  // 如 "Allow for this session (3 apps)"
  let t7;
  if ($[7] !== t6) {
    t7 = {
      label: t6,
      value: "allow_all"
    };
    $[7] = t6;
    $[8] = t7;
  } else {
    t7 = $[8];
  }

  // ── 构建"拒绝"选项（静态，仅构建一次） ─────────────────────────────
  let t8;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = {
      label: <Text>Deny, and tell Claude what to do differently <Text bold={true}>(esc)</Text></Text>,
      value: "deny"
    };
    $[9] = t8;
  } else {
    t8 = $[9];
  }

  // ── 最终选项列表 ─────────────────────────────────────────────────────
  let t9;
  if ($[10] !== t7) {
    t9 = [t7, t8];
    $[10] = t7;
    $[11] = t9;
  } else {
    t9 = $[11];
  }
  const options = t9;

  // ── respond：处理用户选择允许或拒绝 ─────────────────────────────────
  let t10;
  if ($[12] !== checked || $[13] !== onDone || $[14] !== request.apps || $[15] !== requestedFlagKeys) {
    t10 = function respond(allow) {
      if (!allow) {
        // 用户选择拒绝，直接返回 deny-all 响应
        onDone(DENY_ALL_RESPONSE);
        return;
      }
      const now = Date.now();
      // 构建已授权应用列表：已解析且在 checked 中的应用
      const granted = request.apps.flatMap(a_0 => a_0.resolved && checked.has(a_0.resolved.bundleId) ? [{
        bundleId: a_0.resolved.bundleId,
        displayName: a_0.resolved.displayName,
        grantedAt: now  // 记录授权时间戳
      }] : []);
      // 构建被拒绝应用列表：未解析或未勾选的应用
      const denied = request.apps.filter(a_1 => !a_1.resolved || !checked.has(a_1.resolved.bundleId)).map(_temp2);  // _temp2：构建 { bundleId, reason } 对象
      // 合并默认标志和用户请求的标志（允许时全部标志置 true）
      const flags = {
        ...DEFAULT_GRANT_FLAGS,
        ...Object.fromEntries(requestedFlagKeys.map(_temp3))  // _temp3：将 key 映射为 [key, true]
      };
      onDone({
        granted,
        denied,
        flags
      });
    };
    $[12] = checked;
    $[13] = onDone;
    $[14] = request.apps;
    $[15] = requestedFlagKeys;
    $[16] = t10;
  } else {
    t10 = $[16];
  }
  const respond = t10;

  // ── 取消回调（Esc 视同拒绝） ─────────────────────────────────────────
  let t11;
  if ($[17] !== respond) {
    t11 = () => respond(false);
    $[17] = respond;
    $[18] = t11;
  } else {
    t11 = $[18];
  }

  // ── 原因文本（若请求携带 reason 字段则灰色展示） ────────────────────
  let t12;
  if ($[19] !== request.reason) {
    t12 = request.reason ? <Text dimColor={true}>{request.reason}</Text> : null;
    $[19] = request.reason;
    $[20] = t12;
  } else {
    t12 = $[20];
  }

  // ── 应用列表渲染（每个应用显示状态图标和名称） ──────────────────────
  let t13;
  if ($[21] !== checked || $[22] !== request.apps) {
    let t14;
    if ($[24] !== checked) {
      // 应用列表的渲染映射函数（依赖 checked，单独缓存）
      t14 = a_3 => {
        const resolved = a_3.resolved;
        if (!resolved) {
          // 未安装的应用：灰色圆圈 + "(not installed)"
          return <Text key={a_3.requestedName} dimColor={true}>{"  "}{figures.circle} {a_3.requestedName}{" "}<Text dimColor={true}>(not installed)</Text></Text>;
        }
        if (a_3.alreadyGranted) {
          // 已授权的应用：✓ + "(already granted)"
          return <Text key={resolved.bundleId} dimColor={true}>{"  "}{figures.tick} {resolved.displayName}{" "}<Text dimColor={true}>(already granted)</Text></Text>;
        }
        // 检查是否为 Sentinel 风险应用（shell/文件系统/系统设置类）
        const sentinel = getSentinelCategory(resolved.bundleId);
        const isChecked = checked.has(resolved.bundleId);
        // 正常应用：填充/空圆圈 + 名称，Sentinel 应用额外显示风险警告
        return <Box key={resolved.bundleId} flexDirection="column"><Text>{"  "}{isChecked ? figures.circleFilled : figures.circle}{" "}{resolved.displayName}</Text>{sentinel ? <Text bold={true}>{"    "}{figures.warning} {SENTINEL_WARNING[sentinel]}</Text> : null}</Box>;
      };
      $[24] = checked;
      $[25] = t14;
    } else {
      t14 = $[25];
    }
    t13 = request.apps.map(t14);
    $[21] = checked;
    $[22] = request.apps;
    $[23] = t13;
  } else {
    t13 = $[23];
  }

  // ── 应用列表容器 ─────────────────────────────────────────────────────
  let t14;
  if ($[26] !== t13) {
    t14 = <Box flexDirection="column">{t13}</Box>;
    $[26] = t13;
    $[27] = t14;
  } else {
    t14 = $[27];
  }

  // ── 附加权限标志列表（剪贴板读写、系统快捷键等） ────────────────────
  let t15;
  if ($[28] !== requestedFlagKeys) {
    t15 = requestedFlagKeys.length > 0 ? <Box flexDirection="column"><Text dimColor={true}>Also requested:</Text>{requestedFlagKeys.map(_temp4)}</Box> : null;
    $[28] = requestedFlagKeys;
    $[29] = t15;
  } else {
    t15 = $[29];
  }

  // ── 将被隐藏的应用数量提示 ──────────────────────────────────────────
  let t16;
  if ($[30] !== request.willHide) {
    t16 = request.willHide && request.willHide.length > 0 ? <Text dimColor={true}>{request.willHide.length} other{" "}{plural(request.willHide.length, "app")} will be hidden while Claude works.</Text> : null;
    $[30] = request.willHide;
    $[31] = t16;
  } else {
    t16 = $[31];
  }

  // ── 选择组件的 onChange 和 onCancel 回调 ─────────────────────────────
  let t17;
  let t18;
  if ($[32] !== respond) {
    // 将 "allow_all" 映射为 respond(true)，其余（"deny"）映射为 respond(false)
    t17 = v => respond(v === "allow_all");
    t18 = () => respond(false);
    $[32] = respond;
    $[33] = t17;
    $[34] = t18;
  } else {
    t17 = $[33];
    t18 = $[34];
  }

  // ── 选项选择组件 ────────────────────────────────────────────────────
  let t19;
  if ($[35] !== options || $[36] !== t17 || $[37] !== t18) {
    t19 = <Select options={options} onChange={t17} onCancel={t18} />;
    $[35] = options;
    $[36] = t17;
    $[37] = t18;
    $[38] = t19;
  } else {
    t19 = $[38];
  }

  // ── 内容区域（原因 + 应用列表 + 标志 + 隐藏提示 + 选项） ───────────
  let t20;
  if ($[39] !== t12 || $[40] !== t14 || $[41] !== t15 || $[42] !== t16 || $[43] !== t19) {
    t20 = <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{t12}{t14}{t15}{t16}{t19}</Box>;
    $[39] = t12;
    $[40] = t14;
    $[41] = t15;
    $[42] = t16;
    $[43] = t19;
    $[44] = t20;
  } else {
    t20 = $[44];
  }

  // ── 最终渲染：Dialog 包裹内容区域 ──────────────────────────────────
  let t21;
  if ($[45] !== t11 || $[46] !== t20) {
    t21 = <Dialog title="Computer Use wants to control these apps" onCancel={t11}>{t20}</Dialog>;
    $[45] = t11;
    $[46] = t20;
    $[47] = t21;
  } else {
    t21 = $[47];
  }
  return t21;
}

// ── 提取自 React Compiler 的辅助函数（替代内联箭头函数以优化缓存）──

// _temp4：渲染附加权限标志列表的每一项（带 key 的灰色文本）
function _temp4(flag) {
  return <Text key={flag} dimColor={true}>{"  "}· {flag}</Text>;
}

// _temp3：将标志键映射为 [key, true] 条目（用于 Object.fromEntries）
function _temp3(k_0) {
  return [k_0, true] as const;
}

// _temp2：将应用映射为拒绝条目（bundleId + reason: user_denied/not_installed）
function _temp2(a_2) {
  return {
    bundleId: a_2.resolved?.bundleId ?? a_2.requestedName,
    reason: a_2.resolved ? "user_denied" as const : "not_installed" as const
  };
}

// _temp：提取已解析且尚未授权的应用 bundleId（用于初始化 checked 集合）
function _temp(a) {
  return a.resolved && !a.alreadyGranted ? [a.resolved.bundleId] : [];
}
