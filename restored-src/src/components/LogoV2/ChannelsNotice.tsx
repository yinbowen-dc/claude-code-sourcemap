/**
 * 【文件概述】ChannelsNotice.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动阶段 → LogoV2 渲染 → Channels 功能通知（此文件）
 *
 * 特殊加载机制：
 *   本文件通过 LogoV2.tsx 中的 require() 动态导入，
 *   仅当 feature('KAIROS') 或 feature('KAIROS_CHANNELS') 为 true 时才会加载。
 *   当两个特性标志均为 false 时，整个文件会被 tree-shake 掉，
 *   因此本文件内部无需再做 feature() 守卫。
 *   ⚠️ 禁止从未加守卫的代码中静态导入此模块。
 *
 * 主要职责：
 *   在 Logo 下方展示 Channels 功能的状态通知，包含四种分支：
 *     1. disabled  — Channels 服务当前不可用（平台未开启）
 *     2. noAuth    — 未登录 claude.ai，需要先执行 /login
 *     3. policyBlocked — 企业/团队管理员策略禁用了 Channels
 *     4. 正常监听中 — 显示订阅的频道列表及警告项
 *
 * 关键设计决策：
 *   所有状态在组件挂载时通过 useState(_temp) 一次性快照，
 *   避免组件进入终端滚动回放区域后因 re-render 导致终端重置。
 */
import { c as _c } from "react/compiler-runtime";
// Conditionally require()'d in LogoV2.tsx behind feature('KAIROS') ||
// feature('KAIROS_CHANNELS'). No feature() guard here — the whole file
// tree-shakes via the require pattern when both flags are false (see
// docs/feature-gating.md). Do NOT import this module statically from
// unguarded code.

import * as React from 'react';
import { useState } from 'react';
import { type ChannelEntry, getAllowedChannels, getHasDevChannels } from '../../bootstrap/state.js';
import { Box, Text } from '../../ink.js';
import { isChannelsEnabled } from '../../services/mcp/channelAllowlist.js';
import { getEffectiveChannelAllowlist } from '../../services/mcp/channelNotification.js';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import { getClaudeAIOAuthTokens, getSubscriptionType } from '../../utils/auth.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getSettingsForSource } from '../../utils/settings/settings.js';

/**
 * ChannelsNotice — Channels 功能状态通知组件
 *
 * 整体流程：
 *   1. 通过 useState(_temp) 在挂载时一次性快照所有状态（snapshot-at-mount 模式）
 *      - 防止组件进入滚动回放区后因后台轮询导致的意外 re-render
 *   2. 若 channels 列表为空，直接返回 null（不渲染任何内容）
 *   3. 计算 hasNonDev（是否包含非开发频道）和 flag（用于显示的命令行标志名）
 *   4. 按优先级依次检查：disabled → noAuth → policyBlocked → 正常运行
 *      每个分支都有独立的缓存槽位，由 React Compiler (_c(32)) 管理
 *
 * React Compiler 优化：
 *   使用 _c(32) 共 32 个缓存槽，每个渲染分支的 JSX 节点独立缓存，
 *   只有相关依赖（flag / list / unmatched）变化时才重建对应节点。
 *
 * 注意：本组件渲染后会立即进入终端滚动历史区，re-render 会强制刷新终端，
 * 因此通过 useState 初始化器快照数据是必要的保护措施。
 */
export function ChannelsNotice() {
  // React Compiler 注入的 memoization 缓存，共 32 个槽位
  const $ = _c(32);

  // ── 挂载时快照所有状态 ────────────────────────────────────────────────────
  // useState(_temp) 将 _temp 作为初始化函数，仅在首次渲染时调用一次。
  // 这样后续任何 re-render 都不会重新读取这些值，防止终端重刷。
  const [t0] = useState(_temp);

  // 解构快照数据：频道列表、各种阻断状态、显示用文本、未匹配警告列表
  const {
    channels,       // 允许的频道条目数组
    disabled,       // 布尔：Channels 服务是否被平台禁用
    noAuth,         // 布尔：是否缺少 claude.ai 认证令牌
    policyBlocked,  // 布尔：企业/团队策略是否禁用了 Channels
    list,           // 格式化后的频道列表字符串（逗号分隔）
    unmatched       // 未匹配的警告条目（未安装/未授权/未配置）
  } = t0;

  // ── 快速返回：无频道时不渲染 ─────────────────────────────────────────────
  if (channels.length === 0) {
    return null;
  }

  // ── 计算显示用的命令行标志名 ─────────────────────────────────────────────
  // 判断是否存在非开发频道（dev=false 的条目）
  const hasNonDev = channels.some(_temp2);
  // 根据频道组合选择合适的标志名：
  //   同时有 dev+非dev → "Channels"（混合，避免误导用户）
  //   仅有 dev 频道   → "--dangerously-load-development-channels"
  //   仅有普通频道    → "--channels"
  const flag = getHasDevChannels() && hasNonDev ? "Channels" : getHasDevChannels() ? "--dangerously-load-development-channels" : "--channels";

  // ── 分支 1：Channels 服务被平台禁用 ─────────────────────────────────────
  if (disabled) {
    // 缓存槽 0-2：动态标题行（flag/list 变化时重建）
    let t1;
    if ($[0] !== flag || $[1] !== list) {
      // 错误色提示："{flag} ignored ({list})"
      t1 = <Text color="error">{flag} ignored ({list})</Text>;
      $[0] = flag;
      $[1] = list;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    // 缓存槽 3：静态说明文字，整个生命周期只创建一次
    let t2;
    if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>Channels are not currently available</Text>;
      $[3] = t2;
    } else {
      t2 = $[3];
    }
    // 缓存槽 4-5：外层 Box 容器
    let t3;
    if ($[4] !== t1) {
      t3 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}</Box>;
      $[4] = t1;
      $[5] = t3;
    } else {
      t3 = $[5];
    }
    return t3;
  }

  // ── 分支 2：未登录 claude.ai ─────────────────────────────────────────────
  if (noAuth) {
    // 缓存槽 6-8：动态标题行（flag/list 变化时重建）
    let t1;
    if ($[6] !== flag || $[7] !== list) {
      // 错误色提示："{flag} ignored ({list})"
      t1 = <Text color="error">{flag} ignored ({list})</Text>;
      $[6] = flag;
      $[7] = list;
      $[8] = t1;
    } else {
      t1 = $[8];
    }
    // 缓存槽 9：静态说明文字（告知用户需要 /login）
    let t2;
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Text dimColor={true}>Channels require claude.ai authentication · run /login, then restart</Text>;
      $[9] = t2;
    } else {
      t2 = $[9];
    }
    // 缓存槽 10-11：外层 Box 容器
    let t3;
    if ($[10] !== t1) {
      t3 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}</Box>;
      $[10] = t1;
      $[11] = t3;
    } else {
      t3 = $[11];
    }
    return t3;
  }

  // ── 分支 3：企业/团队策略禁用 ────────────────────────────────────────────
  if (policyBlocked) {
    // 缓存槽 12-14：动态标题行（flag/list 变化时重建）
    let t1;
    if ($[12] !== flag || $[13] !== list) {
      // 错误色提示："{flag} blocked by org policy ({list})"
      t1 = <Text color="error">{flag} blocked by org policy ({list})</Text>;
      $[12] = flag;
      $[13] = list;
      $[14] = t1;
    } else {
      t1 = $[14];
    }
    // 缓存槽 15-16：两行静态说明文字（整个生命周期只创建一次）
    let t2;
    let t3;
    if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
      // 说明消息将被静默丢弃
      t2 = <Text dimColor={true}>Inbound messages will be silently dropped</Text>;
      // 指引管理员在 managed settings 中开启 channelsEnabled
      t3 = <Text dimColor={true}>Have an administrator set channelsEnabled: true in managed settings to enable</Text>;
      $[15] = t2;
      $[16] = t3;
    } else {
      t2 = $[15];
      t3 = $[16];
    }
    // 缓存槽 17-18：未匹配条目警告列表（unmatched 变化时重建）
    let t4;
    if ($[17] !== unmatched) {
      // 将每个未匹配条目映射为警告色 Text 节点（使用 _temp3 提取的回调）
      t4 = unmatched.map(_temp3);
      $[17] = unmatched;
      $[18] = t4;
    } else {
      t4 = $[18];
    }
    // 缓存槽 19-21：外层 Box 容器（t1 或 t4 变化时重建）
    let t5;
    if ($[19] !== t1 || $[20] !== t4) {
      t5 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}{t3}{t4}</Box>;
      $[19] = t1;
      $[20] = t4;
      $[21] = t5;
    } else {
      t5 = $[21];
    }
    return t5;
  }

  // ── 分支 4（默认）：正常监听中 ───────────────────────────────────────────
  // 注意：此处仅表示已配置了允许的频道列表，并不代表 MCP 服务器已连接

  // 缓存槽 22-23：监听中标题行（list 变化时重建）
  let t1;
  if ($[22] !== list) {
    // 错误色（高对比度）提示当前监听的频道来源列表
    t1 = <Text color="error">Listening for channel messages from: {list}</Text>;
    $[22] = list;
    $[23] = t1;
  } else {
    t1 = $[23];
  }

  // 缓存槽 24-25：实验性功能警告文字（flag 变化时重建，提示 prompt injection 风险）
  let t2;
  if ($[24] !== flag) {
    t2 = <Text dimColor={true}>Experimental · inbound messages will be pushed into this session, this carries prompt injection risks. Restart Claude Code without {flag} to disable.</Text>;
    $[24] = flag;
    $[25] = t2;
  } else {
    t2 = $[25];
  }

  // 缓存槽 26-27：未匹配条目警告列表（unmatched 变化时重建）
  let t3;
  if ($[26] !== unmatched) {
    // 将每个未匹配条目映射为警告色 Text 节点（使用 _temp4 提取的回调）
    t3 = unmatched.map(_temp4);
    $[26] = unmatched;
    $[27] = t3;
  } else {
    t3 = $[27];
  }

  // 缓存槽 28-31：外层 Box 容器（任一子节点变化时重建）
  let t4;
  if ($[28] !== t1 || $[29] !== t2 || $[30] !== t3) {
    t4 = <Box paddingLeft={2} flexDirection="column">{t1}{t2}{t3}</Box>;
    $[28] = t1;
    $[29] = t2;
    $[30] = t3;
    $[31] = t4;
  } else {
    t4 = $[31];
  }
  return t4;
}

/**
 * _temp4 — React Compiler 提取的 .map() 回调（正常运行分支）
 *
 * 将 unmatched 数组中的每个条目渲染为带警告色的 Text 节点。
 * key 格式："{entry}:{why}"，用于 React 列表 diff 优化。
 * 参数名 u_0 是编译器生成的重命名（与 _temp3 中的 u 区分）。
 */
function _temp4(u_0) {
  return <Text key={`${formatEntry(u_0.entry)}:${u_0.why}`} color="warning">{formatEntry(u_0.entry)} · {u_0.why}</Text>;
}

/**
 * _temp3 — React Compiler 提取的 .map() 回调（policyBlocked 分支）
 *
 * 将 unmatched 数组中的每个条目渲染为带警告色的 Text 节点。
 * key 格式："{entry}:{why}"，与 _temp4 结构完全相同（编译器为每个调用点生成独立函数）。
 */
function _temp3(u) {
  return <Text key={`${formatEntry(u.entry)}:${u.why}`} color="warning">{formatEntry(u.entry)} · {u.why}</Text>;
}

/**
 * _temp2 — React Compiler 提取的 .some() 回调
 *
 * 用于判断频道列表中是否包含非开发频道（dev=false）。
 * 原始代码：channels.some(c => !c.dev)
 */
function _temp2(c) {
  return !c.dev;
}

/**
 * _temp — React Compiler 提取的 useState 初始化函数
 *
 * 在组件首次挂载时调用一次，快照当前所有频道相关状态。
 * 原始代码是内联箭头函数：useState(() => { ... })
 *
 * 整体流程：
 *   1. 读取 getAllowedChannels() 获取允许的频道列表
 *   2. 若列表为空，直接返回带空值的对象（避免不必要的 API 调用）
 *   3. 否则：
 *      a. 格式化频道列表为显示字符串（逗号分隔）
 *      b. 读取订阅类型（team/enterprise = managed）
 *      c. 读取 policySettings 中的 channelsEnabled 配置
 *      d. 获取有效的频道白名单（org 白名单 > ledger 白名单）
 *      e. 返回完整的状态快照对象
 */
function _temp() {
  // 读取当前允许的频道列表（来自 bootstrap state，启动时已确定）
  const ch = getAllowedChannels();

  // 快速路径：无频道时返回空状态，跳过所有后续 API 调用
  if (ch.length === 0) {
    return {
      channels: ch,
      disabled: false,
      noAuth: false,
      policyBlocked: false,
      list: "",
      unmatched: [] as Unmatched[]
    };
  }

  // 将频道条目格式化为可读字符串，用于 UI 展示
  const l = ch.map(formatEntry).join(", ");

  // 读取订阅类型，判断是否为受管理的账户（team 或 enterprise）
  const sub = getSubscriptionType();
  const managed = sub === "team" || sub === "enterprise";

  // 读取策略设置（企业/团队管理员通过 managed settings 下发的配置）
  const policy = getSettingsForSource("policySettings");

  // 获取有效的频道白名单：企业账户优先使用 org 白名单，否则使用 ledger 白名单
  const allowlist = getEffectiveChannelAllowlist(sub, policy?.allowedChannelPlugins);

  // 返回完整的状态快照
  return {
    channels: ch,
    disabled: !isChannelsEnabled(),                          // GrowthBook 特性标志
    noAuth: !getClaudeAIOAuthTokens()?.accessToken,          // 检查 OAuth access token
    policyBlocked: managed && policy?.channelsEnabled !== true, // 仅受管理账户受此限制
    list: l,
    unmatched: findUnmatched(ch, allowlist)                  // 检查各频道的配置合法性
  };
}

/**
 * formatEntry — 将 ChannelEntry 格式化为显示字符串
 *
 * 根据频道类型生成不同格式：
 *   plugin 类型 → "plugin:{name}@{marketplace}"
 *   server 类型 → "server:{name}"
 */
function formatEntry(c: ChannelEntry): string {
  return c.kind === 'plugin' ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`;
}

// Unmatched 类型：表示一个配置问题（频道条目 + 原因说明）
type Unmatched = {
  entry: ChannelEntry;  // 出现问题的频道条目
  why: string;          // 问题描述（未安装/未授权/未配置等）
};

/**
 * findUnmatched — 检查所有频道条目的配置合法性
 *
 * 整体流程：
 *   1. 构建所有 MCP scope（enterprise/user/project/local）中已配置的服务器名 Set
 *      - getMcpConfigsByScope 不缓存（project scope 需遍历目录树），
 *        提前构建 Set 避免每条 entry 重复触发目录遍历
 *   2. 构建已安装插件 ID 的 Set（key 格式："{name}@{marketplace}"）
 *      - loadInstalledPluginsV2 已缓存，安全调用
 *   3. 从 allowlist 中解构 entries（允许列表）和 source（来源：org/ledger）
 *   4. 遍历每个频道条目，使用独立 if 检查（不用 else if），
 *      这样同时存在多个问题的条目会产生多条警告
 *
 * server 类型检查：
 *   - 未在任何 scope 中配置名称 → "no MCP server configured with that name"
 *   - 没有 --dangerously-load-development-channels 标志 → "server: entries need ..."
 *
 * plugin 类型检查：
 *   - 未安装（不在 installedPluginIds 中）→ "plugin not installed"
 *   - 未在白名单中（dev 标志可绕过此检查）→ "not on org/approved allowlist"
 *     - GrowthBook 缓存可能是冷缓存（返回空列表），此时所有插件都会警告
 *
 * @param entries - 需要验证的频道条目列表
 * @param allowlist - 有效的频道白名单（含来源信息）
 * @returns 未匹配（有问题）的条目及其原因列表
 */
function findUnmatched(entries: readonly ChannelEntry[], allowlist: ReturnType<typeof getEffectiveChannelAllowlist>): Unmatched[] {
  // Server-kind: build one Set from all scopes up front. getMcpConfigsByScope
  // is not cached (project scope walks the dir tree); getMcpConfigByName would
  // redo that walk per entry.
  // 预构建所有已配置 MCP 服务器名的集合（跨所有 scope）
  const scopes = ['enterprise', 'user', 'project', 'local'] as const;
  const configured = new Set<string>();
  for (const scope of scopes) {
    // 遍历该 scope 中所有服务器名，加入 Set
    for (const name of Object.keys(getMcpConfigsByScope(scope).servers)) {
      configured.add(name);
    }
  }

  // Plugin-kind installed check: installed_plugins.json keys are
  // `name@marketplace`. loadInstalledPluginsV2 is cached.
  // 构建已安装插件 ID 的集合（格式："{name}@{marketplace}"）
  const installedPluginIds = new Set(Object.keys(loadInstalledPluginsV2().plugins));

  // Plugin-kind allowlist check: same {marketplace, plugin} test as the
  // gate at channelNotification.ts. entry.dev bypasses (dev flag opts out
  // of the allowlist). Org list replaces ledger when set (team/enterprise).
  // GrowthBook _CACHED_MAY_BE_STALE — cold cache yields [] so every plugin
  // entry warns; same tradeoff the gate already accepts.
  // 解构白名单的允许条目和来源（org 或 ledger）
  const {
    entries: allowed,
    source
  } = allowlist;

  // Independent ifs — a plugin entry that's both uninstalled AND
  // unlisted shows two lines. Server kind checks config + dev flag.
  // 使用独立 if（非 else if），让同时存在多个问题的条目产生多条警告
  const out: Unmatched[] = [];
  for (const entry of entries) {
    if (entry.kind === 'server') {
      // 检查 1：服务器名是否在任何 scope 中配置
      if (!configured.has(entry.name)) {
        out.push({
          entry,
          why: 'no MCP server configured with that name'
        });
      }
      // 检查 2：server 类型的频道需要开发模式标志
      if (!entry.dev) {
        out.push({
          entry,
          why: 'server: entries need --dangerously-load-development-channels'
        });
      }
      continue; // server 类型不做插件检查
    }

    // 检查 3（plugin 类型）：插件是否已安装
    if (!installedPluginIds.has(`${entry.name}@${entry.marketplace}`)) {
      out.push({
        entry,
        why: 'plugin not installed'
      });
    }

    // 检查 4（plugin 类型）：插件是否在白名单中（dev 模式可绕过）
    if (!entry.dev && !allowed.some(e => e.plugin === entry.name && e.marketplace === entry.marketplace)) {
      out.push({
        entry,
        // 根据白名单来源给出不同的提示文案
        why: source === 'org' ? "not on your org's approved channels list" : 'not on the approved channels allowlist'
      });
    }
  }
  return out;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZVN0YXRlIiwiQ2hhbm5lbEVudHJ5IiwiZ2V0QWxsb3dlZENoYW5uZWxzIiwiZ2V0SGFzRGV2Q2hhbm5lbHMiLCJCb3giLCJUZXh0IiwiaXNDaGFubmVsc0VuYWJsZWQiLCJnZXRFZmZlY3RpdmVDaGFubmVsQWxsb3dsaXN0IiwiZ2V0TWNwQ29uZmlnc0J5U2NvcGUiLCJnZXRDbGF1ZGVBSU9BdXRoVG9rZW5zIiwiZ2V0U3Vic2NyaXB0aW9uVHlwZSIsImxvYWRJbnN0YWxsZWRQbHVnaW5zVjIiLCJnZXRTZXR0aW5nc0ZvclNvdXJjZSIsIkNoYW5uZWxzTm90aWNlIiwiJCIsIl9jIiwidDAiLCJfdGVtcCIsImNoYW5uZWxzIiwiZGlzYWJsZWQiLCJub0F1dGgiLCJwb2xpY3lCbG9ja2VkIiwibGlzdCIsInVubWF0Y2hlZCIsImxlbmd0aCIsImhhc05vbkRldiIsInNvbWUiLCJfdGVtcDIiLCJmbGFnIiwidDEiLCJ0MiIsIlN5bWJvbCIsImZvciIsInQzIiwidDQiLCJtYXAiLCJfdGVtcDMiLCJ0NSIsIl90ZW1wNCIsInVfMCIsImZvcm1hdEVudHJ5IiwidSIsImVudHJ5Iiwid2h5IiwiYyIsImRldiIsImNoIiwiVW5tYXRjaGVkIiwibCIsImpvaW4iLCJzdWIiLCJtYW5hZ2VkIiwicG9saWN5IiwiYWxsb3dsaXN0IiwiYWxsb3dlZENoYW5uZWxQbHVnaW5zIiwiYWNjZXNzVG9rZW4iLCJjaGFubmVsc0VuYWJsZWQiLCJmaW5kVW5tYXRjaGVkIiwia2luZCIsIm5hbWUiLCJtYXJrZXRwbGFjZSIsImVudHJpZXMiLCJSZXR1cm5UeXBlIiwic2NvcGVzIiwiY29uc3QiLCJjb25maWd1cmVkIiwiU2V0Iiwic2NvcGUiLCJPYmplY3QiLCJrZXlzIiwic2VydmVycyIsImFkZCIsImluc3RhbGxlZFBsdWdpbklkcyIsInBsdWdpbnMiLCJhbGxvd2VkIiwic291cmNlIiwib3V0IiwiaGFzIiwicHVzaCIsImUiLCJwbHVnaW4iXSwic291cmNlcyI6WyJDaGFubmVsc05vdGljZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29uZGl0aW9uYWxseSByZXF1aXJlKCknZCBpbiBMb2dvVjIudHN4IGJlaGluZCBmZWF0dXJlKCdLQUlST1MnKSB8fFxuLy8gZmVhdHVyZSgnS0FJUk9TX0NIQU5ORUxTJykuIE5vIGZlYXR1cmUoKSBndWFyZCBoZXJlIOKAlCB0aGUgd2hvbGUgZmlsZVxuLy8gdHJlZS1zaGFrZXMgdmlhIHRoZSByZXF1aXJlIHBhdHRlcm4gd2hlbiBib3RoIGZsYWdzIGFyZSBmYWxzZSAoc2VlXG4vLyBkb2NzL2ZlYXR1cmUtZ2F0aW5nLm1kKS4gRG8gTk9UIGltcG9ydCB0aGlzIG1vZHVsZSBzdGF0aWNhbGx5IGZyb21cbi8vIHVuZ3VhcmRlZCBjb2RlLlxuXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQge1xuICB0eXBlIENoYW5uZWxFbnRyeSxcbiAgZ2V0QWxsb3dlZENoYW5uZWxzLFxuICBnZXRIYXNEZXZDaGFubmVscyxcbn0gZnJvbSAnLi4vLi4vYm9vdHN0cmFwL3N0YXRlLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgaXNDaGFubmVsc0VuYWJsZWQgfSBmcm9tICcuLi8uLi9zZXJ2aWNlcy9tY3AvY2hhbm5lbEFsbG93bGlzdC5qcydcbmltcG9ydCB7IGdldEVmZmVjdGl2ZUNoYW5uZWxBbGxvd2xpc3QgfSBmcm9tICcuLi8uLi9zZXJ2aWNlcy9tY3AvY2hhbm5lbE5vdGlmaWNhdGlvbi5qcydcbmltcG9ydCB7IGdldE1jcENvbmZpZ3NCeVNjb3BlIH0gZnJvbSAnLi4vLi4vc2VydmljZXMvbWNwL2NvbmZpZy5qcydcbmltcG9ydCB7XG4gIGdldENsYXVkZUFJT0F1dGhUb2tlbnMsXG4gIGdldFN1YnNjcmlwdGlvblR5cGUsXG59IGZyb20gJy4uLy4uL3V0aWxzL2F1dGguanMnXG5pbXBvcnQgeyBsb2FkSW5zdGFsbGVkUGx1Z2luc1YyIH0gZnJvbSAnLi4vLi4vdXRpbHMvcGx1Z2lucy9pbnN0YWxsZWRQbHVnaW5zTWFuYWdlci5qcydcbmltcG9ydCB7IGdldFNldHRpbmdzRm9yU291cmNlIH0gZnJvbSAnLi4vLi4vdXRpbHMvc2V0dGluZ3Mvc2V0dGluZ3MuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBDaGFubmVsc05vdGljZSgpOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBTbmFwc2hvdCBhbGwgcmVhZHMgYXQgbW91bnQuIFRoaXMgbm90aWNlIGVudGVycyBzY3JvbGxiYWNrIGltbWVkaWF0ZWx5XG4gIC8vIGFmdGVyIHRoZSBsb2dvOyBhbnkgcmUtcmVuZGVyIHBhc3QgdGhhdCBwb2ludCBmb3JjZXMgYSBmdWxsIHRlcm1pbmFsXG4gIC8vIHJlc2V0LiBnZXRBbGxvd2VkQ2hhbm5lbHMgKGJvb3RzdHJhcCBzdGF0ZSksIGdldFNldHRpbmdzRm9yU291cmNlXG4gIC8vIChzZXNzaW9uIGNhY2hlIHVwZGF0ZWQgYnkgYmFja2dyb3VuZCBwb2xsaW5nIC8gL2xvZ2luKSwgYW5kXG4gIC8vIGlzQ2hhbm5lbHNFbmFibGVkIChHcm93dGhCb29rIDUtbWluIHJlZnJlc2gpIG11c3QgYmUgY2FwdHVyZWQgb25jZVxuICAvLyBzbyBhIGxhdGVyIHJlLXJlbmRlciBjYW5ub3QgZmxpcCBicmFuY2hlcy5cbiAgY29uc3QgW3sgY2hhbm5lbHMsIGRpc2FibGVkLCBub0F1dGgsIHBvbGljeUJsb2NrZWQsIGxpc3QsIHVubWF0Y2hlZCB9XSA9XG4gICAgdXNlU3RhdGUoKCkgPT4ge1xuICAgICAgY29uc3QgY2ggPSBnZXRBbGxvd2VkQ2hhbm5lbHMoKVxuICAgICAgaWYgKGNoLmxlbmd0aCA9PT0gMClcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjaGFubmVsczogY2gsXG4gICAgICAgICAgZGlzYWJsZWQ6IGZhbHNlLFxuICAgICAgICAgIG5vQXV0aDogZmFsc2UsXG4gICAgICAgICAgcG9saWN5QmxvY2tlZDogZmFsc2UsXG4gICAgICAgICAgbGlzdDogJycsXG4gICAgICAgICAgdW5tYXRjaGVkOiBbXSBhcyBVbm1hdGNoZWRbXSxcbiAgICAgICAgfVxuICAgICAgY29uc3QgbCA9IGNoLm1hcChmb3JtYXRFbnRyeSkuam9pbignLCAnKVxuICAgICAgY29uc3Qgc3ViID0gZ2V0U3Vic2NyaXB0aW9uVHlwZSgpXG4gICAgICBjb25zdCBtYW5hZ2VkID0gc3ViID09PSAndGVhbScgfHwgc3ViID09PSAnZW50ZXJwcmlzZSdcbiAgICAgIGNvbnN0IHBvbGljeSA9IGdldFNldHRpbmdzRm9yU291cmNlKCdwb2xpY3lTZXR0aW5ncycpXG4gICAgICBjb25zdCBhbGxvd2xpc3QgPSBnZXRFZmZlY3RpdmVDaGFubmVsQWxsb3dsaXN0KFxuICAgICAgICBzdWIsXG4gICAgICAgIHBvbGljeT8uYWxsb3dlZENoYW5uZWxQbHVnaW5zLFxuICAgICAgKVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY2hhbm5lbHM6IGNoLFxuICAgICAgICBkaXNhYmxlZDogIWlzQ2hhbm5lbHNFbmFibGVkKCksXG4gICAgICAgIG5vQXV0aDogIWdldENsYXVkZUFJT0F1dGhUb2tlbnMoKT8uYWNjZXNzVG9rZW4sXG4gICAgICAgIHBvbGljeUJsb2NrZWQ6IG1hbmFnZWQgJiYgcG9saWN5Py5jaGFubmVsc0VuYWJsZWQgIT09IHRydWUsXG4gICAgICAgIGxpc3Q6IGwsXG4gICAgICAgIHVubWF0Y2hlZDogZmluZFVubWF0Y2hlZChjaCwgYWxsb3dsaXN0KSxcbiAgICAgIH1cbiAgICB9KVxuICBpZiAoY2hhbm5lbHMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbFxuXG4gIC8vIFdoZW4gYm90aCBmbGFncyBhcmUgcGFzc2VkLCB0aGUgbGlzdCBtaXhlcyBlbnRyaWVzIGFuZCBhIHNpbmdsZSBmbGFnXG4gIC8vIG5hbWUgd291bGQgYmUgd3JvbmcgZm9yIGhhbGYgb2YgaXQuIGVudHJ5LmRldiBkaXN0aW5ndWlzaGVzIG9yaWdpbi5cbiAgY29uc3QgaGFzTm9uRGV2ID0gY2hhbm5lbHMuc29tZShjID0+ICFjLmRldilcbiAgY29uc3QgZmxhZyA9XG4gICAgZ2V0SGFzRGV2Q2hhbm5lbHMoKSAmJiBoYXNOb25EZXZcbiAgICAgID8gJ0NoYW5uZWxzJ1xuICAgICAgOiBnZXRIYXNEZXZDaGFubmVscygpXG4gICAgICAgID8gJy0tZGFuZ2Vyb3VzbHktbG9hZC1kZXZlbG9wbWVudC1jaGFubmVscydcbiAgICAgICAgOiAnLS1jaGFubmVscydcblxuICBpZiAoZGlzYWJsZWQpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBwYWRkaW5nTGVmdD17Mn0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+XG4gICAgICAgICAge2ZsYWd9IGlnbm9yZWQgKHtsaXN0fSlcbiAgICAgICAgPC9UZXh0PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5DaGFubmVscyBhcmUgbm90IGN1cnJlbnRseSBhdmFpbGFibGU8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICApXG4gIH1cblxuICBpZiAobm9BdXRoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezJ9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPlxuICAgICAgICAgIHtmbGFnfSBpZ25vcmVkICh7bGlzdH0pXG4gICAgICAgIDwvVGV4dD5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgQ2hhbm5lbHMgcmVxdWlyZSBjbGF1ZGUuYWkgYXV0aGVudGljYXRpb24gwrcgcnVuIC9sb2dpbiwgdGhlbiByZXN0YXJ0XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIGlmIChwb2xpY3lCbG9ja2VkKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezJ9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPlxuICAgICAgICAgIHtmbGFnfSBibG9ja2VkIGJ5IG9yZyBwb2xpY3kgKHtsaXN0fSlcbiAgICAgICAgPC9UZXh0PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5JbmJvdW5kIG1lc3NhZ2VzIHdpbGwgYmUgc2lsZW50bHkgZHJvcHBlZDwvVGV4dD5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgSGF2ZSBhbiBhZG1pbmlzdHJhdG9yIHNldCBjaGFubmVsc0VuYWJsZWQ6IHRydWUgaW4gbWFuYWdlZCBzZXR0aW5ncyB0b1xuICAgICAgICAgIGVuYWJsZVxuICAgICAgICA8L1RleHQ+XG4gICAgICAgIHt1bm1hdGNoZWQubWFwKHUgPT4gKFxuICAgICAgICAgIDxUZXh0IGtleT17YCR7Zm9ybWF0RW50cnkodS5lbnRyeSl9OiR7dS53aHl9YH0gY29sb3I9XCJ3YXJuaW5nXCI+XG4gICAgICAgICAgICB7Zm9ybWF0RW50cnkodS5lbnRyeSl9IMK3IHt1LndoeX1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICkpfVxuICAgICAgPC9Cb3g+XG4gICAgKVxuICB9XG5cbiAgLy8gXCJMaXN0ZW5pbmcgZm9yXCIgbm90IFwiYWN0aXZlXCIg4oCUIGF0IHRoaXMgcG9pbnQgd2Ugb25seSBrbm93IHRoZSBhbGxvd2xpc3RcbiAgLy8gd2FzIHNldC4gU2VydmVyIGNvbm5lY3Rpb24sIGNhcGFiaWxpdHkgZGVjbGFyYXRpb24sIGFuZCB3aGV0aGVyIHRoZSBuYW1lXG4gIC8vIGV2ZW4gbWF0Y2hlcyBhIGNvbmZpZ3VyZWQgTUNQIHNlcnZlciBhcmUgYWxsIHN0aWxsIHVua25vd24uXG4gIHJldHVybiAoXG4gICAgPEJveCBwYWRkaW5nTGVmdD17Mn0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPkxpc3RlbmluZyBmb3IgY2hhbm5lbCBtZXNzYWdlcyBmcm9tOiB7bGlzdH08L1RleHQ+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgRXhwZXJpbWVudGFsIMK3IGluYm91bmQgbWVzc2FnZXMgd2lsbCBiZSBwdXNoZWQgaW50byB0aGlzIHNlc3Npb24sIHRoaXNcbiAgICAgICAgY2FycmllcyBwcm9tcHQgaW5qZWN0aW9uIHJpc2tzLiBSZXN0YXJ0IENsYXVkZSBDb2RlIHdpdGhvdXQge2ZsYWd9IHRvXG4gICAgICAgIGRpc2FibGUuXG4gICAgICA8L1RleHQ+XG4gICAgICB7dW5tYXRjaGVkLm1hcCh1ID0+IChcbiAgICAgICAgPFRleHQga2V5PXtgJHtmb3JtYXRFbnRyeSh1LmVudHJ5KX06JHt1LndoeX1gfSBjb2xvcj1cIndhcm5pbmdcIj5cbiAgICAgICAgICB7Zm9ybWF0RW50cnkodS5lbnRyeSl9IMK3IHt1LndoeX1cbiAgICAgICAgPC9UZXh0PlxuICAgICAgKSl9XG4gICAgPC9Cb3g+XG4gIClcbn1cblxuZnVuY3Rpb24gZm9ybWF0RW50cnkoYzogQ2hhbm5lbEVudHJ5KTogc3RyaW5nIHtcbiAgcmV0dXJuIGMua2luZCA9PT0gJ3BsdWdpbidcbiAgICA/IGBwbHVnaW46JHtjLm5hbWV9QCR7Yy5tYXJrZXRwbGFjZX1gXG4gICAgOiBgc2VydmVyOiR7Yy5uYW1lfWBcbn1cblxudHlwZSBVbm1hdGNoZWQgPSB7IGVudHJ5OiBDaGFubmVsRW50cnk7IHdoeTogc3RyaW5nIH1cblxuZnVuY3Rpb24gZmluZFVubWF0Y2hlZChcbiAgZW50cmllczogcmVhZG9ubHkgQ2hhbm5lbEVudHJ5W10sXG4gIGFsbG93bGlzdDogUmV0dXJuVHlwZTx0eXBlb2YgZ2V0RWZmZWN0aXZlQ2hhbm5lbEFsbG93bGlzdD4sXG4pOiBVbm1hdGNoZWRbXSB7XG4gIC8vIFNlcnZlci1raW5kOiBidWlsZCBvbmUgU2V0IGZyb20gYWxsIHNjb3BlcyB1cCBmcm9udC4gZ2V0TWNwQ29uZmlnc0J5U2NvcGVcbiAgLy8gaXMgbm90IGNhY2hlZCAocHJvamVjdCBzY29wZSB3YWxrcyB0aGUgZGlyIHRyZWUpOyBnZXRNY3BDb25maWdCeU5hbWUgd291bGRcbiAgLy8gcmVkbyB0aGF0IHdhbGsgcGVyIGVudHJ5LlxuICBjb25zdCBzY29wZXMgPSBbJ2VudGVycHJpc2UnLCAndXNlcicsICdwcm9qZWN0JywgJ2xvY2FsJ10gYXMgY29uc3RcbiAgY29uc3QgY29uZmlndXJlZCA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIGZvciAoY29uc3Qgc2NvcGUgb2Ygc2NvcGVzKSB7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGdldE1jcENvbmZpZ3NCeVNjb3BlKHNjb3BlKS5zZXJ2ZXJzKSkge1xuICAgICAgY29uZmlndXJlZC5hZGQobmFtZSlcbiAgICB9XG4gIH1cblxuICAvLyBQbHVnaW4ta2luZCBpbnN0YWxsZWQgY2hlY2s6IGluc3RhbGxlZF9wbHVnaW5zLmpzb24ga2V5cyBhcmVcbiAgLy8gYG5hbWVAbWFya2V0cGxhY2VgLiBsb2FkSW5zdGFsbGVkUGx1Z2luc1YyIGlzIGNhY2hlZC5cbiAgY29uc3QgaW5zdGFsbGVkUGx1Z2luSWRzID0gbmV3IFNldChcbiAgICBPYmplY3Qua2V5cyhsb2FkSW5zdGFsbGVkUGx1Z2luc1YyKCkucGx1Z2lucyksXG4gIClcblxuICAvLyBQbHVnaW4ta2luZCBhbGxvd2xpc3QgY2hlY2s6IHNhbWUge21hcmtldHBsYWNlLCBwbHVnaW59IHRlc3QgYXMgdGhlXG4gIC8vIGdhdGUgYXQgY2hhbm5lbE5vdGlmaWNhdGlvbi50cy4gZW50cnkuZGV2IGJ5cGFzc2VzIChkZXYgZmxhZyBvcHRzIG91dFxuICAvLyBvZiB0aGUgYWxsb3dsaXN0KS4gT3JnIGxpc3QgcmVwbGFjZXMgbGVkZ2VyIHdoZW4gc2V0ICh0ZWFtL2VudGVycHJpc2UpLlxuICAvLyBHcm93dGhCb29rIF9DQUNIRURfTUFZX0JFX1NUQUxFIOKAlCBjb2xkIGNhY2hlIHlpZWxkcyBbXSBzbyBldmVyeSBwbHVnaW5cbiAgLy8gZW50cnkgd2FybnM7IHNhbWUgdHJhZGVvZmYgdGhlIGdhdGUgYWxyZWFkeSBhY2NlcHRzLlxuICBjb25zdCB7IGVudHJpZXM6IGFsbG93ZWQsIHNvdXJjZSB9ID0gYWxsb3dsaXN0XG5cbiAgLy8gSW5kZXBlbmRlbnQgaWZzIOKAlCBhIHBsdWdpbiBlbnRyeSB0aGF0J3MgYm90aCB1bmluc3RhbGxlZCBBTkRcbiAgLy8gdW5saXN0ZWQgc2hvd3MgdHdvIGxpbmVzLiBTZXJ2ZXIga2luZCBjaGVja3MgY29uZmlnICsgZGV2IGZsYWcuXG4gIGNvbnN0IG91dDogVW5tYXRjaGVkW10gPSBbXVxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZW50cnkua2luZCA9PT0gJ3NlcnZlcicpIHtcbiAgICAgIGlmICghY29uZmlndXJlZC5oYXMoZW50cnkubmFtZSkpIHtcbiAgICAgICAgb3V0LnB1c2goeyBlbnRyeSwgd2h5OiAnbm8gTUNQIHNlcnZlciBjb25maWd1cmVkIHdpdGggdGhhdCBuYW1lJyB9KVxuICAgICAgfVxuICAgICAgaWYgKCFlbnRyeS5kZXYpIHtcbiAgICAgICAgb3V0LnB1c2goe1xuICAgICAgICAgIGVudHJ5LFxuICAgICAgICAgIHdoeTogJ3NlcnZlcjogZW50cmllcyBuZWVkIC0tZGFuZ2Vyb3VzbHktbG9hZC1kZXZlbG9wbWVudC1jaGFubmVscycsXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgICBjb250aW51ZVxuICAgIH1cbiAgICBpZiAoIWluc3RhbGxlZFBsdWdpbklkcy5oYXMoYCR7ZW50cnkubmFtZX1AJHtlbnRyeS5tYXJrZXRwbGFjZX1gKSkge1xuICAgICAgb3V0LnB1c2goeyBlbnRyeSwgd2h5OiAncGx1Z2luIG5vdCBpbnN0YWxsZWQnIH0pXG4gICAgfVxuICAgIGlmIChcbiAgICAgICFlbnRyeS5kZXYgJiZcbiAgICAgICFhbGxvd2VkLnNvbWUoXG4gICAgICAgIGUgPT4gZS5wbHVnaW4gPT09IGVudHJ5Lm5hbWUgJiYgZS5tYXJrZXRwbGFjZSA9PT0gZW50cnkubWFya2V0cGxhY2UsXG4gICAgICApXG4gICAgKSB7XG4gICAgICBvdXQucHVzaCh7XG4gICAgICAgIGVudHJ5LFxuICAgICAgICB3aHk6XG4gICAgICAgICAgc291cmNlID09PSAnb3JnJ1xuICAgICAgICAgICAgPyBcIm5vdCBvbiB5b3VyIG9yZydzIGFwcHJvdmVkIGNoYW5uZWxzIGxpc3RcIlxuICAgICAgICAgICAgOiAnbm90IG9uIHRoZSBhcHByb3ZlZCBjaGFubmVscyBhbGxvd2xpc3QnLFxuICAgICAgfSlcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dFxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLFFBQVEsUUFBUSxPQUFPO0FBQ2hDLFNBQ0UsS0FBS0MsWUFBWSxFQUNqQkMsa0JBQWtCLEVBQ2xCQyxpQkFBaUIsUUFDWiwwQkFBMEI7QUFDakMsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxpQkFBaUIsUUFBUSx3Q0FBd0M7QUFDMUUsU0FBU0MsNEJBQTRCLFFBQVEsMkNBQTJDO0FBQ3hGLFNBQVNDLG9CQUFvQixRQUFRLDhCQUE4QjtBQUNuRSxTQUNFQyxzQkFBc0IsRUFDdEJDLG1CQUFtQixRQUNkLHFCQUFxQjtBQUM1QixTQUFTQyxzQkFBc0IsUUFBUSxnREFBZ0Q7QUFDdkYsU0FBU0Msb0JBQW9CLFFBQVEsa0NBQWtDO0FBRXZFLE9BQU8sU0FBQUMsZUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQU9MLE9BQUFDLEVBQUEsSUFDRWhCLFFBQVEsQ0FBQ2lCLEtBMkJSLENBQUM7RUE1Qkc7SUFBQUMsUUFBQTtJQUFBQyxRQUFBO0lBQUFDLE1BQUE7SUFBQUMsYUFBQTtJQUFBQyxJQUFBO0lBQUFDO0VBQUEsSUFBQVAsRUFBOEQ7RUE2QnJFLElBQUlFLFFBQVEsQ0FBQU0sTUFBTyxLQUFLLENBQUM7SUFBQSxPQUFTLElBQUk7RUFBQTtFQUl0QyxNQUFBQyxTQUFBLEdBQWtCUCxRQUFRLENBQUFRLElBQUssQ0FBQ0MsTUFBVyxDQUFDO0VBQzVDLE1BQUFDLElBQUEsR0FDRXpCLGlCQUFpQixDQUFjLENBQUMsSUFBaENzQixTQUlrQixHQUpsQixVQUlrQixHQUZkdEIsaUJBQWlCLENBRUosQ0FBQyxHQUZkLHlDQUVjLEdBRmQsWUFFYztFQUVwQixJQUFJZ0IsUUFBUTtJQUFBLElBQUFVLEVBQUE7SUFBQSxJQUFBZixDQUFBLFFBQUFjLElBQUEsSUFBQWQsQ0FBQSxRQUFBUSxJQUFBO01BR05PLEVBQUEsSUFBQyxJQUFJLENBQU8sS0FBTyxDQUFQLE9BQU8sQ0FDaEJELEtBQUcsQ0FBRSxVQUFXTixLQUFHLENBQUUsQ0FDeEIsRUFGQyxJQUFJLENBRUU7TUFBQVIsQ0FBQSxNQUFBYyxJQUFBO01BQUFkLENBQUEsTUFBQVEsSUFBQTtNQUFBUixDQUFBLE1BQUFlLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUFmLENBQUE7SUFBQTtJQUFBLElBQUFnQixFQUFBO0lBQUEsSUFBQWhCLENBQUEsUUFBQWlCLE1BQUEsQ0FBQUMsR0FBQTtNQUNQRixFQUFBLElBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyxvQ0FBb0MsRUFBbEQsSUFBSSxDQUFxRDtNQUFBaEIsQ0FBQSxNQUFBZ0IsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQWhCLENBQUE7SUFBQTtJQUFBLElBQUFtQixFQUFBO0lBQUEsSUFBQW5CLENBQUEsUUFBQWUsRUFBQTtNQUo1REksRUFBQSxJQUFDLEdBQUcsQ0FBYyxXQUFDLENBQUQsR0FBQyxDQUFnQixhQUFRLENBQVIsUUFBUSxDQUN6QyxDQUFBSixFQUVNLENBQ04sQ0FBQUMsRUFBeUQsQ0FDM0QsRUFMQyxHQUFHLENBS0U7TUFBQWhCLENBQUEsTUFBQWUsRUFBQTtNQUFBZixDQUFBLE1BQUFtQixFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBbkIsQ0FBQTtJQUFBO0lBQUEsT0FMTm1CLEVBT007RUFBQTtFQUlWLElBQUliLE1BQU07SUFBQSxJQUFBUyxFQUFBO0lBQUEsSUFBQWYsQ0FBQSxRQUFBYyxJQUFBLElBQUFkLENBQUEsUUFBQVEsSUFBQTtNQUdKTyxFQUFBLElBQUMsSUFBSSxDQUFPLEtBQU8sQ0FBUCxPQUFPLENBQ2hCRCxLQUFHLENBQUUsVUFBV04sS0FBRyxDQUFFLENBQ3hCLEVBRkMsSUFBSSxDQUVFO01BQUFSLENBQUEsTUFBQWMsSUFBQTtNQUFBZCxDQUFBLE1BQUFRLElBQUE7TUFBQVIsQ0FBQSxNQUFBZSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBZixDQUFBO0lBQUE7SUFBQSxJQUFBZ0IsRUFBQTtJQUFBLElBQUFoQixDQUFBLFFBQUFpQixNQUFBLENBQUFDLEdBQUE7TUFDUEYsRUFBQSxJQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsb0VBRWYsRUFGQyxJQUFJLENBRUU7TUFBQWhCLENBQUEsTUFBQWdCLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUFoQixDQUFBO0lBQUE7SUFBQSxJQUFBbUIsRUFBQTtJQUFBLElBQUFuQixDQUFBLFNBQUFlLEVBQUE7TUFOVEksRUFBQSxJQUFDLEdBQUcsQ0FBYyxXQUFDLENBQUQsR0FBQyxDQUFnQixhQUFRLENBQVIsUUFBUSxDQUN6QyxDQUFBSixFQUVNLENBQ04sQ0FBQUMsRUFFTSxDQUNSLEVBUEMsR0FBRyxDQU9FO01BQUFoQixDQUFBLE9BQUFlLEVBQUE7TUFBQWYsQ0FBQSxPQUFBbUIsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQW5CLENBQUE7SUFBQTtJQUFBLE9BUE5tQixFQU9NO0VBQUE7RUFJVixJQUFJWixhQUFhO0lBQUEsSUFBQVEsRUFBQTtJQUFBLElBQUFmLENBQUEsU0FBQWMsSUFBQSxJQUFBZCxDQUFBLFNBQUFRLElBQUE7TUFHWE8sRUFBQSxJQUFDLElBQUksQ0FBTyxLQUFPLENBQVAsT0FBTyxDQUNoQkQsS0FBRyxDQUFFLHdCQUF5Qk4sS0FBRyxDQUFFLENBQ3RDLEVBRkMsSUFBSSxDQUVFO01BQUFSLENBQUEsT0FBQWMsSUFBQTtNQUFBZCxDQUFBLE9BQUFRLElBQUE7TUFBQVIsQ0FBQSxPQUFBZSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBZixDQUFBO0lBQUE7SUFBQSxJQUFBZ0IsRUFBQTtJQUFBLElBQUFHLEVBQUE7SUFBQSxJQUFBbkIsQ0FBQSxTQUFBaUIsTUFBQSxDQUFBQyxHQUFBO01BQ1BGLEVBQUEsSUFBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFDLHlDQUF5QyxFQUF2RCxJQUFJLENBQTBEO01BQy9ERyxFQUFBLElBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyw2RUFHZixFQUhDLElBQUksQ0FHRTtNQUFBbkIsQ0FBQSxPQUFBZ0IsRUFBQTtNQUFBaEIsQ0FBQSxPQUFBbUIsRUFBQTtJQUFBO01BQUFILEVBQUEsR0FBQWhCLENBQUE7TUFBQW1CLEVBQUEsR0FBQW5CLENBQUE7SUFBQTtJQUFBLElBQUFvQixFQUFBO0lBQUEsSUFBQXBCLENBQUEsU0FBQVMsU0FBQTtNQUNOVyxFQUFBLEdBQUFYLFNBQVMsQ0FBQVksR0FBSSxDQUFDQyxNQUlkLENBQUM7TUFBQXRCLENBQUEsT0FBQVMsU0FBQTtNQUFBVCxDQUFBLE9BQUFvQixFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBcEIsQ0FBQTtJQUFBO0lBQUEsSUFBQXVCLEVBQUE7SUFBQSxJQUFBdkIsQ0FBQSxTQUFBZSxFQUFBLElBQUFmLENBQUEsU0FBQW9CLEVBQUE7TUFiSkcsRUFBQSxJQUFDLEdBQUcsQ0FBYyxXQUFDLENBQUQsR0FBQyxDQUFnQixhQUFRLENBQVIsUUFBUSxDQUN6QyxDQUFBUixFQUVNLENBQ04sQ0FBQUMsRUFBOEQsQ0FDOUQsQ0FBQUcsRUFHTSxDQUNMLENBQUFDLEVBSUEsQ0FDSCxFQWRDLEdBQUcsQ0FjRTtNQUFBcEIsQ0FBQSxPQUFBZSxFQUFBO01BQUFmLENBQUEsT0FBQW9CLEVBQUE7TUFBQXBCLENBQUEsT0FBQXVCLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUF2QixDQUFBO0lBQUE7SUFBQSxPQWROdUIsRUFjTTtFQUFBO0VBRVQsSUFBQVIsRUFBQTtFQUFBLElBQUFmLENBQUEsU0FBQVEsSUFBQTtJQU9HTyxFQUFBLElBQUMsSUFBSSxDQUFPLEtBQU8sQ0FBUCxPQUFPLENBQUMscUNBQXNDUCxLQUFHLENBQUUsRUFBOUQsSUFBSSxDQUFpRTtJQUFBUixDQUFBLE9BQUFRLElBQUE7SUFBQVIsQ0FBQSxPQUFBZSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZixDQUFBO0VBQUE7RUFBQSxJQUFBZ0IsRUFBQTtFQUFBLElBQUFoQixDQUFBLFNBQUFjLElBQUE7SUFDdEVFLEVBQUEsSUFBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFDLG1JQUVnREYsS0FBRyxDQUFFLFlBRXBFLEVBSkMsSUFBSSxDQUlFO0lBQUFkLENBQUEsT0FBQWMsSUFBQTtJQUFBZCxDQUFBLE9BQUFnQixFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBaEIsQ0FBQTtFQUFBO0VBQUEsSUFBQW1CLEVBQUE7RUFBQSxJQUFBbkIsQ0FBQSxTQUFBUyxTQUFBO0lBQ05VLEVBQUEsR0FBQVYsU0FBUyxDQUFBWSxHQUFJLENBQUNHLE1BSWQsQ0FBQztJQUFBeEIsQ0FBQSxPQUFBUyxTQUFBO0lBQUFULENBQUEsT0FBQW1CLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFuQixDQUFBO0VBQUE7RUFBQSxJQUFBb0IsRUFBQTtFQUFBLElBQUFwQixDQUFBLFNBQUFlLEVBQUEsSUFBQWYsQ0FBQSxTQUFBZ0IsRUFBQSxJQUFBaEIsQ0FBQSxTQUFBbUIsRUFBQTtJQVhKQyxFQUFBLElBQUMsR0FBRyxDQUFjLFdBQUMsQ0FBRCxHQUFDLENBQWdCLGFBQVEsQ0FBUixRQUFRLENBQ3pDLENBQUFMLEVBQXFFLENBQ3JFLENBQUFDLEVBSU0sQ0FDTCxDQUFBRyxFQUlBLENBQ0gsRUFaQyxHQUFHLENBWUU7SUFBQW5CLENBQUEsT0FBQWUsRUFBQTtJQUFBZixDQUFBLE9BQUFnQixFQUFBO0lBQUFoQixDQUFBLE9BQUFtQixFQUFBO0lBQUFuQixDQUFBLE9BQUFvQixFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBcEIsQ0FBQTtFQUFBO0VBQUEsT0FaTm9CLEVBWU07QUFBQTtBQTVHSCxTQUFBSSxPQUFBQyxHQUFBO0VBQUEsT0F3R0MsQ0FBQyxJQUFJLENBQU0sR0FBa0MsQ0FBbEMsSUFBR0MsV0FBVyxDQUFDQyxHQUFDLENBQUFDLEtBQU0sQ0FBQyxJQUFJRCxHQUFDLENBQUFFLEdBQUksRUFBQyxDQUFDLENBQVEsS0FBUyxDQUFULFNBQVMsQ0FDM0QsQ0FBQUgsV0FBVyxDQUFDQyxHQUFDLENBQUFDLEtBQU0sRUFBRSxHQUFJLENBQUFELEdBQUMsQ0FBQUUsR0FBRyxDQUNoQyxFQUZDLElBQUksQ0FFRTtBQUFBO0FBMUdSLFNBQUFQLE9BQUFLLEVBQUE7RUFBQSxPQW9GRyxDQUFDLElBQUksQ0FBTSxHQUFrQyxDQUFsQyxJQUFHRCxXQUFXLENBQUNDLEVBQUUsQ0FBQUMsS0FBTSxDQUFDLElBQUlELEVBQUUsQ0FBQUUsR0FBSSxFQUFDLENBQUMsQ0FBUSxLQUFTLENBQVQsU0FBUyxDQUMzRCxDQUFBSCxXQUFXLENBQUNDLEVBQUUsQ0FBQUMsS0FBTSxFQUFFLEdBQUksQ0FBQUQsRUFBRSxDQUFBRSxHQUFHLENBQ2hDLEVBRkMsSUFBSSxDQUVFO0FBQUE7QUF0RlYsU0FBQWhCLE9BQUFpQixFQUFBO0VBQUEsT0F3Q2dDLENBQUNBLEVBQUUsQ0FBQUMsR0FBSTtBQUFBO0FBeEN0QyxTQUFBNUIsTUFBQTtFQVNELE1BQUE2QixFQUFBLEdBQVc1QyxrQkFBa0IsQ0FBQyxDQUFDO0VBQy9CLElBQUk0QyxFQUFFLENBQUF0QixNQUFPLEtBQUssQ0FBQztJQUFBLE9BQ1Y7TUFBQU4sUUFBQSxFQUNLNEIsRUFBRTtNQUFBM0IsUUFBQSxFQUNGLEtBQUs7TUFBQUMsTUFBQSxFQUNQLEtBQUs7TUFBQUMsYUFBQSxFQUNFLEtBQUs7TUFBQUMsSUFBQSxFQUNkLEVBQUU7TUFBQUMsU0FBQSxFQUNHLEVBQUUsSUFBSXdCLFNBQVM7SUFDNUIsQ0FBQztFQUFBO0VBQ0gsTUFBQUMsQ0FBQSxHQUFVRixFQUFFLENBQUFYLEdBQUksQ0FBQ0ssV0FBVyxDQUFDLENBQUFTLElBQUssQ0FBQyxJQUFJLENBQUM7RUFDeEMsTUFBQUMsR0FBQSxHQUFZeEMsbUJBQW1CLENBQUMsQ0FBQztFQUNqQyxNQUFBeUMsT0FBQSxHQUFnQkQsR0FBRyxLQUFLLE1BQThCLElBQXBCQSxHQUFHLEtBQUssWUFBWTtFQUN0RCxNQUFBRSxNQUFBLEdBQWV4QyxvQkFBb0IsQ0FBQyxnQkFBZ0IsQ0FBQztFQUNyRCxNQUFBeUMsU0FBQSxHQUFrQjlDLDRCQUE0QixDQUM1QzJDLEdBQUcsRUFDSEUsTUFBTSxFQUFBRSxxQkFDUixDQUFDO0VBQUEsT0FDTTtJQUFBcEMsUUFBQSxFQUNLNEIsRUFBRTtJQUFBM0IsUUFBQSxFQUNGLENBQUNiLGlCQUFpQixDQUFDLENBQUM7SUFBQWMsTUFBQSxFQUN0QixDQUFDWCxzQkFBc0IsQ0FBYyxDQUFDLEVBQUE4QyxXQUFBO0lBQUFsQyxhQUFBLEVBQy9COEIsT0FBMkMsSUFBaENDLE1BQU0sRUFBQUksZUFBaUIsS0FBSyxJQUFJO0lBQUFsQyxJQUFBLEVBQ3BEMEIsQ0FBQztJQUFBekIsU0FBQSxFQUNJa0MsYUFBYSxDQUFDWCxFQUFFLEVBQUVPLFNBQVM7RUFDeEMsQ0FBQztBQUFBO0FBOEVQLFNBQVNiLFdBQVdBLENBQUNJLENBQUMsRUFBRTNDLFlBQVksQ0FBQyxFQUFFLE1BQU0sQ0FBQztFQUM1QyxPQUFPMkMsQ0FBQyxDQUFDYyxJQUFJLEtBQUssUUFBUSxHQUN0QixVQUFVZCxDQUFDLENBQUNlLElBQUksSUFBSWYsQ0FBQyxDQUFDZ0IsV0FBVyxFQUFFLEdBQ25DLFVBQVVoQixDQUFDLENBQUNlLElBQUksRUFBRTtBQUN4QjtBQUVBLEtBQUtaLFNBQVMsR0FBRztFQUFFTCxLQUFLLEVBQUV6QyxZQUFZO0VBQUUwQyxHQUFHLEVBQUUsTUFBTTtBQUFDLENBQUM7QUFFckQsU0FBU2MsYUFBYUEsQ0FDcEJJLE9BQU8sRUFBRSxTQUFTNUQsWUFBWSxFQUFFLEVBQ2hDb0QsU0FBUyxFQUFFUyxVQUFVLENBQUMsT0FBT3ZELDRCQUE0QixDQUFDLENBQzNELEVBQUV3QyxTQUFTLEVBQUUsQ0FBQztFQUNiO0VBQ0E7RUFDQTtFQUNBLE1BQU1nQixNQUFNLEdBQUcsQ0FBQyxZQUFZLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxPQUFPLENBQUMsSUFBSUMsS0FBSztFQUNsRSxNQUFNQyxVQUFVLEdBQUcsSUFBSUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7RUFDcEMsS0FBSyxNQUFNQyxLQUFLLElBQUlKLE1BQU0sRUFBRTtJQUMxQixLQUFLLE1BQU1KLElBQUksSUFBSVMsTUFBTSxDQUFDQyxJQUFJLENBQUM3RCxvQkFBb0IsQ0FBQzJELEtBQUssQ0FBQyxDQUFDRyxPQUFPLENBQUMsRUFBRTtNQUNuRUwsVUFBVSxDQUFDTSxHQUFHLENBQUNaLElBQUksQ0FBQztJQUN0QjtFQUNGOztFQUVBO0VBQ0E7RUFDQSxNQUFNYSxrQkFBa0IsR0FBRyxJQUFJTixHQUFHLENBQ2hDRSxNQUFNLENBQUNDLElBQUksQ0FBQzFELHNCQUFzQixDQUFDLENBQUMsQ0FBQzhELE9BQU8sQ0FDOUMsQ0FBQzs7RUFFRDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0EsTUFBTTtJQUFFWixPQUFPLEVBQUVhLE9BQU87SUFBRUM7RUFBTyxDQUFDLEdBQUd0QixTQUFTOztFQUU5QztFQUNBO0VBQ0EsTUFBTXVCLEdBQUcsRUFBRTdCLFNBQVMsRUFBRSxHQUFHLEVBQUU7RUFDM0IsS0FBSyxNQUFNTCxLQUFLLElBQUltQixPQUFPLEVBQUU7SUFDM0IsSUFBSW5CLEtBQUssQ0FBQ2dCLElBQUksS0FBSyxRQUFRLEVBQUU7TUFDM0IsSUFBSSxDQUFDTyxVQUFVLENBQUNZLEdBQUcsQ0FBQ25DLEtBQUssQ0FBQ2lCLElBQUksQ0FBQyxFQUFFO1FBQy9CaUIsR0FBRyxDQUFDRSxJQUFJLENBQUM7VUFBRXBDLEtBQUs7VUFBRUMsR0FBRyxFQUFFO1FBQTBDLENBQUMsQ0FBQztNQUNyRTtNQUNBLElBQUksQ0FBQ0QsS0FBSyxDQUFDRyxHQUFHLEVBQUU7UUFDZCtCLEdBQUcsQ0FBQ0UsSUFBSSxDQUFDO1VBQ1BwQyxLQUFLO1VBQ0xDLEdBQUcsRUFBRTtRQUNQLENBQUMsQ0FBQztNQUNKO01BQ0E7SUFDRjtJQUNBLElBQUksQ0FBQzZCLGtCQUFrQixDQUFDSyxHQUFHLENBQUMsR0FBR25DLEtBQUssQ0FBQ2lCLElBQUksSUFBSWpCLEtBQUssQ0FBQ2tCLFdBQVcsRUFBRSxDQUFDLEVBQUU7TUFDakVnQixHQUFHLENBQUNFLElBQUksQ0FBQztRQUFFcEMsS0FBSztRQUFFQyxHQUFHLEVBQUU7TUFBdUIsQ0FBQyxDQUFDO0lBQ2xEO0lBQ0EsSUFDRSxDQUFDRCxLQUFLLENBQUNHLEdBQUcsSUFDVixDQUFDNkIsT0FBTyxDQUFDaEQsSUFBSSxDQUNYcUQsQ0FBQyxJQUFJQSxDQUFDLENBQUNDLE1BQU0sS0FBS3RDLEtBQUssQ0FBQ2lCLElBQUksSUFBSW9CLENBQUMsQ0FBQ25CLFdBQVcsS0FBS2xCLEtBQUssQ0FBQ2tCLFdBQzFELENBQUMsRUFDRDtNQUNBZ0IsR0FBRyxDQUFDRSxJQUFJLENBQUM7UUFDUHBDLEtBQUs7UUFDTEMsR0FBRyxFQUNEZ0MsTUFBTSxLQUFLLEtBQUssR0FDWiwwQ0FBMEMsR0FDMUM7TUFDUixDQUFDLENBQUM7SUFDSjtFQUNGO0VBQ0EsT0FBT0MsR0FBRztBQUNaIiwiaWdub3JlTGlzdCI6W119
