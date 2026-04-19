/**
 * DesktopHandoff.tsx — CLI 到 Claude Desktop 应用的会话移交组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   命令层（/desktop 命令）→ 会话移交 → Claude Desktop 深链跳转
 *
 * 主要功能：
 *   1. getDownloadUrl()：根据操作系统平台（win32/其他）返回对应的 Claude Desktop
 *      下载链接，供用户安装 Desktop 应用。
 *   2. DesktopHandoff 组件：实现 CLI → Desktop 的完整移交状态机：
 *        checking → 检查 Desktop 是否已安装及版本是否满足要求
 *        prompt-download → Desktop 未安装或版本过旧时提示用户下载
 *        flushing → 等待 sessionStorage 写入完毕（确保会话数据完整）
 *        opening → 通过 claude-dev:// 深链打开 Desktop 并传递当前会话
 *        success → 移交成功，500ms 后调用 gracefulShutdown 退出 CLI
 *        error → 任一步骤失败，显示错误信息，等待用户按键确认
 *   3. 键盘输入处理：error 状态按任意键关闭；prompt-download 状态 y/Y 触发下载，
 *      n/N 取消并退出对话框。
 *
 * 使用场景：
 *   用户执行 /desktop 命令时，从 CLI 界面无缝切换到 Claude Desktop 桌面客户端。
 */
import { c as _c } from "react/compiler-runtime";
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../commands.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw input for "any key" dismiss and y/n prompt
import { Box, Text, useInput } from '../ink.js';
import { openBrowser } from '../utils/browser.js';
import { getDesktopInstallStatus, openCurrentSessionInDesktop } from '../utils/desktopDeepLink.js';
import { errorMessage } from '../utils/errors.js';
import { gracefulShutdown } from '../utils/gracefulShutdown.js';
import { flushSessionStorage } from '../utils/sessionStorage.js';
import { LoadingState } from './design-system/LoadingState.js';
// Desktop 相关文档链接，用于引导用户了解 Claude Desktop
const DESKTOP_DOCS_URL = 'https://clau.de/desktop';

/**
 * getDownloadUrl
 *
 * 整体流程：
 *   根据当前操作系统平台（process.platform）返回对应的 Claude Desktop 下载链接。
 *   - win32 → Windows EXE 安装包重定向链接
 *   - 其他（含 darwin）→ macOS Universal DMG 安装包重定向链接
 *
 * 在系统中的角色：
 *   当用户在 prompt-download 状态选择 'y' 下载时，调用此函数获取下载地址，
 *   再通过 openBrowser() 打开系统浏览器触发下载。
 */
export function getDownloadUrl(): string {
  // 根据平台选择对应的下载链接
  switch (process.platform) {
    case 'win32':
      // Windows 平台：返回 x64 EXE 安装包下载重定向链接
      return 'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect';
    default:
      // 其他平台（主要为 macOS）：返回 Universal DMG 安装包下载重定向链接
      return 'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect';
  }
}

// 移交状态机的所有合法状态联合类型
type DesktopHandoffState = 'checking' | 'prompt-download' | 'flushing' | 'opening' | 'success' | 'error';

// 组件 Props：onDone 回调，移交流程结束后向父组件报告结果
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
/**
 * DesktopHandoff 组件
 *
 * 整体流程（状态机）：
 *   1. 初始化三个状态：state（移交阶段）、error（错误信息）、downloadMessage（下载提示）
 *   2. useInput：监听键盘输入，处理 error/prompt-download 两个交互状态
 *      - error 状态：任意键 → 调用 onDone 退出
 *      - prompt-download 状态：y/Y → 打开下载链接；n/N → 直接退出
 *   3. useEffect：组件挂载后立即执行 performHandoff 异步函数，驱动状态机：
 *      checking → (未安装/版本过旧 → prompt-download) → flushing → opening → success/error
 *   4. JSX 渲染：根据当前 state 渲染对应 UI
 *      - error → 显示错误信息 + "按任意键继续"提示
 *      - prompt-download → 显示下载原因 + "Download now? (y/n)"
 *      - 其他 → 渲染 LoadingState 动态提示文字
 *
 * 在系统中的角色：
 *   /desktop 命令的核心交互组件，承接从 CLI 到 Desktop 的完整移交流程。
 */
export function DesktopHandoff(t0) {
  // _c(20)：初始化大小为 20 的 React 编译器记忆缓存槽
  const $ = _c(20);
  const {
    onDone
  } = t0;

  // 状态机当前阶段，初始值为 'checking'
  const [state, setState] = useState("checking");
  // 错误信息，失败时存储错误字符串
  const [error, setError] = useState(null);
  // prompt-download 状态显示的原因文字（未安装 or 版本过旧）
  const [downloadMessage, setDownloadMessage] = useState("");

  // 缓存槽 $[0]~$[3]：依赖 error/onDone/state 变化时重新创建输入处理函数
  let t1;
  if ($[0] !== error || $[1] !== onDone || $[2] !== state) {
    // 键盘输入处理器：仅 error 和 prompt-download 状态需要响应用户输入
    t1 = input => {
      if (state === "error") {
        // error 状态：任意键触发 onDone，将错误信息显示为系统消息后退出
        onDone(error ?? "Unknown error", {
          display: "system"
        });
        return;
      }
      if (state === "prompt-download") {
        if (input === "y" || input === "Y") {
          // 用户确认下载：打开浏览器触发下载（忽略错误），然后退出并提示重启
          openBrowser(getDownloadUrl()).catch(_temp);
          onDone(`Starting download. Re-run /desktop once you\u2019ve installed the app.\nLearn more at ${DESKTOP_DOCS_URL}`, {
            display: "system"
          });
        } else {
          if (input === "n" || input === "N") {
            // 用户拒绝下载：退出并告知 /desktop 需要 Desktop 应用
            onDone(`The desktop app is required for /desktop. Learn more at ${DESKTOP_DOCS_URL}`, {
              display: "system"
            });
          }
        }
      }
    };
    $[0] = error;
    $[1] = onDone;
    $[2] = state;
    $[3] = t1;
  } else {
    // 缓存命中：复用上次创建的输入处理函数
    t1 = $[3];
  }
  useInput(t1);

  // 缓存槽 $[4]~$[6]：依赖 onDone 变化时重新创建 effect 函数和依赖数组
  let t2;
  let t3;
  if ($[4] !== onDone) {
    // performHandoff 异步状态机：驱动完整移交流程
    t2 = () => {
      const performHandoff = async function performHandoff() {
        // 第一步：检查 Desktop 安装状态
        setState("checking");
        const installStatus = await getDesktopInstallStatus();

        // 未安装：设置提示消息并进入 prompt-download 状态等待用户决策
        if (installStatus.status === "not-installed") {
          setDownloadMessage("Claude Desktop is not installed.");
          setState("prompt-download");
          return;
        }

        // 版本过旧：提示版本信息并进入 prompt-download 状态
        if (installStatus.status === "version-too-old") {
          setDownloadMessage(`Claude Desktop needs to be updated (found v${installStatus.version}, need v1.1.2396+).`);
          setState("prompt-download");
          return;
        }

        // 第二步：刷新 sessionStorage，确保会话数据完整写入磁盘
        setState("flushing");
        await flushSessionStorage();

        // 第三步：通过深链打开 Desktop 并传递当前会话
        setState("opening");
        const result = await openCurrentSessionInDesktop();

        // 深链打开失败：记录错误并进入 error 状态
        if (!result.success) {
          setError(result.error ?? "Failed to open Claude Desktop");
          setState("error");
          return;
        }

        // 第四步：移交成功，500ms 后通知父组件并优雅退出 CLI
        setState("success");
        setTimeout(_temp2, 500, onDone);
      };

      // 捕获 performHandoff 中的未处理异常，统一进入 error 状态
      performHandoff().catch(err => {
        setError(errorMessage(err));
        setState("error");
      });
    };
    // effect 依赖数组：仅在 onDone 变化时重新执行
    t3 = [onDone];
    $[4] = onDone;
    $[5] = t2;
    $[6] = t3;
  } else {
    t2 = $[5];
    t3 = $[6];
  }
  // 组件挂载后立即触发移交流程
  useEffect(t2, t3);

  // ── 渲染分支 ──

  // error 状态：显示错误信息 + 按任意键提示
  if (state === "error") {
    let t4;
    // 缓存槽 $[7]~$[8]：依赖 error 变化时重建错误文本节点
    if ($[7] !== error) {
      t4 = <Text color="error">Error: {error}</Text>;
      $[7] = error;
      $[8] = t4;
    } else {
      t4 = $[8];
    }
    let t5;
    // 缓存槽 $[9]：静态提示文字，只创建一次
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <Text dimColor={true}>Press any key to continue…</Text>;
      $[9] = t5;
    } else {
      t5 = $[9];
    }
    let t6;
    // 缓存槽 $[10]~$[11]：依赖 error 文本节点变化时重建容器
    if ($[10] !== t4) {
      t6 = <Box flexDirection="column" paddingX={2}>{t4}{t5}</Box>;
      $[10] = t4;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    return t6;
  }

  // prompt-download 状态：显示下载原因 + y/n 提示
  if (state === "prompt-download") {
    let t4;
    // 缓存槽 $[12]~$[13]：依赖 downloadMessage 变化时重建原因文本
    if ($[12] !== downloadMessage) {
      t4 = <Text>{downloadMessage}</Text>;
      $[12] = downloadMessage;
      $[13] = t4;
    } else {
      t4 = $[13];
    }
    let t5;
    // 缓存槽 $[14]：静态下载确认提示，只创建一次
    if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <Text>Download now? (y/n)</Text>;
      $[14] = t5;
    } else {
      t5 = $[14];
    }
    let t6;
    // 缓存槽 $[15]~$[16]：依赖 downloadMessage 文本变化时重建容器
    if ($[15] !== t4) {
      t6 = <Box flexDirection="column" paddingX={2}>{t4}{t5}</Box>;
      $[15] = t4;
      $[16] = t6;
    } else {
      t6 = $[16];
    }
    return t6;
  }

  // 其他过渡状态（checking/flushing/opening/success）：渲染 LoadingState
  let t4;
  // 缓存槽 $[17]：各过渡状态对应的显示文字，静态对象只创建一次
  if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = {
      checking: "Checking for Claude Desktop\u2026",   // 检查 Desktop 安装状态
      flushing: "Saving session\u2026",                 // 写入会话数据
      opening: "Opening Claude Desktop\u2026",          // 深链打开 Desktop
      success: "Opening in Claude Desktop\u2026"        // 移交成功
    };
    $[17] = t4;
  } else {
    t4 = $[17];
  }
  const messages = t4;

  // 从映射表中取出当前状态对应的提示文字
  const t5 = messages[state];
  let t6;
  // 缓存槽 $[18]~$[19]：依赖当前提示文字变化时重建 LoadingState
  if ($[18] !== t5) {
    t6 = <LoadingState message={t5} />;
    $[18] = t5;
    $[19] = t6;
  } else {
    t6 = $[19];
  }
  return t6;
}
/**
 * _temp2（移交成功后的异步回调）
 *
 * 整体流程：
 *   由 setTimeout 在移交成功 500ms 后调用，执行两个最终操作：
 *   1. 调用 onDone 通知父组件"Session transferred to Claude Desktop"，以 system 消息形式显示
 *   2. 调用 gracefulShutdown(0, 'other') 优雅退出 CLI 进程（退出码 0，原因为 'other'）
 *
 * 在系统中的角色：
 *   React 编译器将 DesktopHandoff 内的内联 async 函数提取为独立命名函数，
 *   以避免闭包捕获问题。此为提取后的成功收尾函数。
 */
async function _temp2(onDone_0) {
  // 通知父组件移交完成，显示系统消息
  onDone_0("Session transferred to Claude Desktop", {
    display: "system"
  });
  // 优雅退出 CLI 进程
  await gracefulShutdown(0, "other");
}

/**
 * _temp（openBrowser 错误吞咽函数）
 *
 * 整体流程：
 *   作为 openBrowser().catch() 的回调传入，捕获但忽略浏览器打开失败的错误。
 *   即使浏览器无法打开，onDone 已被调用，不影响用户体验。
 *
 * 在系统中的角色：
 *   React 编译器提取的空函数，防止 Promise rejection 未处理警告。
 */
function _temp() {}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZVN0YXRlIiwiQ29tbWFuZFJlc3VsdERpc3BsYXkiLCJCb3giLCJUZXh0IiwidXNlSW5wdXQiLCJvcGVuQnJvd3NlciIsImdldERlc2t0b3BJbnN0YWxsU3RhdHVzIiwib3BlbkN1cnJlbnRTZXNzaW9uSW5EZXNrdG9wIiwiZXJyb3JNZXNzYWdlIiwiZ3JhY2VmdWxTaHV0ZG93biIsImZsdXNoU2Vzc2lvblN0b3JhZ2UiLCJMb2FkaW5nU3RhdGUiLCJERVNLVE9QX0RPQ1NfVVJMIiwiZ2V0RG93bmxvYWRVcmwiLCJwcm9jZXNzIiwicGxhdGZvcm0iLCJEZXNrdG9wSGFuZG9mZlN0YXRlIiwiUHJvcHMiLCJvbkRvbmUiLCJyZXN1bHQiLCJvcHRpb25zIiwiZGlzcGxheSIsIkRlc2t0b3BIYW5kb2ZmIiwidDAiLCIkIiwiX2MiLCJzdGF0ZSIsInNldFN0YXRlIiwiZXJyb3IiLCJzZXRFcnJvciIsImRvd25sb2FkTWVzc2FnZSIsInNldERvd25sb2FkTWVzc2FnZSIsInQxIiwiaW5wdXQiLCJjYXRjaCIsIl90ZW1wIiwidDIiLCJ0MyIsInBlcmZvcm1IYW5kb2ZmIiwiaW5zdGFsbFN0YXR1cyIsInN0YXR1cyIsInZlcnNpb24iLCJzdWNjZXNzIiwic2V0VGltZW91dCIsIl90ZW1wMiIsImVyciIsInQ0IiwidDUiLCJTeW1ib2wiLCJmb3IiLCJ0NiIsImNoZWNraW5nIiwiZmx1c2hpbmciLCJvcGVuaW5nIiwibWVzc2FnZXMiLCJvbkRvbmVfMCJdLCJzb3VyY2VzIjpbIkRlc2t0b3BIYW5kb2ZmLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QsIHsgdXNlRWZmZWN0LCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHR5cGUgeyBDb21tYW5kUmVzdWx0RGlzcGxheSB9IGZyb20gJy4uL2NvbW1hbmRzLmpzJ1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGN1c3RvbS1ydWxlcy9wcmVmZXItdXNlLWtleWJpbmRpbmdzIC0tIHJhdyBpbnB1dCBmb3IgXCJhbnkga2V5XCIgZGlzbWlzcyBhbmQgeS9uIHByb21wdFxuaW1wb3J0IHsgQm94LCBUZXh0LCB1c2VJbnB1dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7IG9wZW5Ccm93c2VyIH0gZnJvbSAnLi4vdXRpbHMvYnJvd3Nlci5qcydcbmltcG9ydCB7XG4gIGdldERlc2t0b3BJbnN0YWxsU3RhdHVzLFxuICBvcGVuQ3VycmVudFNlc3Npb25JbkRlc2t0b3AsXG59IGZyb20gJy4uL3V0aWxzL2Rlc2t0b3BEZWVwTGluay5qcydcbmltcG9ydCB7IGVycm9yTWVzc2FnZSB9IGZyb20gJy4uL3V0aWxzL2Vycm9ycy5qcydcbmltcG9ydCB7IGdyYWNlZnVsU2h1dGRvd24gfSBmcm9tICcuLi91dGlscy9ncmFjZWZ1bFNodXRkb3duLmpzJ1xuaW1wb3J0IHsgZmx1c2hTZXNzaW9uU3RvcmFnZSB9IGZyb20gJy4uL3V0aWxzL3Nlc3Npb25TdG9yYWdlLmpzJ1xuaW1wb3J0IHsgTG9hZGluZ1N0YXRlIH0gZnJvbSAnLi9kZXNpZ24tc3lzdGVtL0xvYWRpbmdTdGF0ZS5qcydcblxuY29uc3QgREVTS1RPUF9ET0NTX1VSTCA9ICdodHRwczovL2NsYXUuZGUvZGVza3RvcCdcblxuZXhwb3J0IGZ1bmN0aW9uIGdldERvd25sb2FkVXJsKCk6IHN0cmluZyB7XG4gIHN3aXRjaCAocHJvY2Vzcy5wbGF0Zm9ybSkge1xuICAgIGNhc2UgJ3dpbjMyJzpcbiAgICAgIHJldHVybiAnaHR0cHM6Ly9jbGF1ZGUuYWkvYXBpL2Rlc2t0b3Avd2luMzIveDY0L2V4ZS9sYXRlc3QvcmVkaXJlY3QnXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiAnaHR0cHM6Ly9jbGF1ZGUuYWkvYXBpL2Rlc2t0b3AvZGFyd2luL3VuaXZlcnNhbC9kbWcvbGF0ZXN0L3JlZGlyZWN0J1xuICB9XG59XG5cbnR5cGUgRGVza3RvcEhhbmRvZmZTdGF0ZSA9XG4gIHwgJ2NoZWNraW5nJ1xuICB8ICdwcm9tcHQtZG93bmxvYWQnXG4gIHwgJ2ZsdXNoaW5nJ1xuICB8ICdvcGVuaW5nJ1xuICB8ICdzdWNjZXNzJ1xuICB8ICdlcnJvcidcblxudHlwZSBQcm9wcyA9IHtcbiAgb25Eb25lOiAoXG4gICAgcmVzdWx0Pzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiB7IGRpc3BsYXk/OiBDb21tYW5kUmVzdWx0RGlzcGxheSB9LFxuICApID0+IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlc2t0b3BIYW5kb2ZmKHsgb25Eb25lIH06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgW3N0YXRlLCBzZXRTdGF0ZV0gPSB1c2VTdGF0ZTxEZXNrdG9wSGFuZG9mZlN0YXRlPignY2hlY2tpbmcnKVxuICBjb25zdCBbZXJyb3IsIHNldEVycm9yXSA9IHVzZVN0YXRlPHN0cmluZyB8IG51bGw+KG51bGwpXG4gIGNvbnN0IFtkb3dubG9hZE1lc3NhZ2UsIHNldERvd25sb2FkTWVzc2FnZV0gPSB1c2VTdGF0ZTxzdHJpbmc+KCcnKVxuXG4gIC8vIEhhbmRsZSBrZXlib2FyZCBpbnB1dCBmb3IgZXJyb3IgYW5kIHByb21wdC1kb3dubG9hZCBzdGF0ZXNcbiAgdXNlSW5wdXQoaW5wdXQgPT4ge1xuICAgIGlmIChzdGF0ZSA9PT0gJ2Vycm9yJykge1xuICAgICAgb25Eb25lKGVycm9yID8/ICdVbmtub3duIGVycm9yJywgeyBkaXNwbGF5OiAnc3lzdGVtJyB9KVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIGlmIChzdGF0ZSA9PT0gJ3Byb21wdC1kb3dubG9hZCcpIHtcbiAgICAgIGlmIChpbnB1dCA9PT0gJ3knIHx8IGlucHV0ID09PSAnWScpIHtcbiAgICAgICAgb3BlbkJyb3dzZXIoZ2V0RG93bmxvYWRVcmwoKSkuY2F0Y2goKCkgPT4ge30pXG4gICAgICAgIG9uRG9uZShcbiAgICAgICAgICBgU3RhcnRpbmcgZG93bmxvYWQuIFJlLXJ1biAvZGVza3RvcCBvbmNlIHlvdVxcdTIwMTl2ZSBpbnN0YWxsZWQgdGhlIGFwcC5cXG5MZWFybiBtb3JlIGF0ICR7REVTS1RPUF9ET0NTX1VSTH1gLFxuICAgICAgICAgIHsgZGlzcGxheTogJ3N5c3RlbScgfSxcbiAgICAgICAgKVxuICAgICAgfSBlbHNlIGlmIChpbnB1dCA9PT0gJ24nIHx8IGlucHV0ID09PSAnTicpIHtcbiAgICAgICAgb25Eb25lKFxuICAgICAgICAgIGBUaGUgZGVza3RvcCBhcHAgaXMgcmVxdWlyZWQgZm9yIC9kZXNrdG9wLiBMZWFybiBtb3JlIGF0ICR7REVTS1RPUF9ET0NTX1VSTH1gLFxuICAgICAgICAgIHsgZGlzcGxheTogJ3N5c3RlbScgfSxcbiAgICAgICAgKVxuICAgICAgfVxuICAgIH1cbiAgfSlcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1IYW5kb2ZmKCk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgLy8gQ2hlY2sgRGVza3RvcCBpbnN0YWxsIHN0YXR1c1xuICAgICAgc2V0U3RhdGUoJ2NoZWNraW5nJylcbiAgICAgIGNvbnN0IGluc3RhbGxTdGF0dXMgPSBhd2FpdCBnZXREZXNrdG9wSW5zdGFsbFN0YXR1cygpXG5cbiAgICAgIGlmIChpbnN0YWxsU3RhdHVzLnN0YXR1cyA9PT0gJ25vdC1pbnN0YWxsZWQnKSB7XG4gICAgICAgIHNldERvd25sb2FkTWVzc2FnZSgnQ2xhdWRlIERlc2t0b3AgaXMgbm90IGluc3RhbGxlZC4nKVxuICAgICAgICBzZXRTdGF0ZSgncHJvbXB0LWRvd25sb2FkJylcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIGlmIChpbnN0YWxsU3RhdHVzLnN0YXR1cyA9PT0gJ3ZlcnNpb24tdG9vLW9sZCcpIHtcbiAgICAgICAgc2V0RG93bmxvYWRNZXNzYWdlKFxuICAgICAgICAgIGBDbGF1ZGUgRGVza3RvcCBuZWVkcyB0byBiZSB1cGRhdGVkIChmb3VuZCB2JHtpbnN0YWxsU3RhdHVzLnZlcnNpb259LCBuZWVkIHYxLjEuMjM5NispLmAsXG4gICAgICAgIClcbiAgICAgICAgc2V0U3RhdGUoJ3Byb21wdC1kb3dubG9hZCcpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBGbHVzaCBzZXNzaW9uIHN0b3JhZ2UgdG8gZW5zdXJlIHRyYW5zY3JpcHQgaXMgZnVsbHkgd3JpdHRlblxuICAgICAgc2V0U3RhdGUoJ2ZsdXNoaW5nJylcbiAgICAgIGF3YWl0IGZsdXNoU2Vzc2lvblN0b3JhZ2UoKVxuXG4gICAgICAvLyBPcGVuIHRoZSBkZWVwIGxpbmsgKHVzZXMgY2xhdWRlLWRldjovLyBpbiBkZXYgbW9kZSlcbiAgICAgIHNldFN0YXRlKCdvcGVuaW5nJylcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9wZW5DdXJyZW50U2Vzc2lvbkluRGVza3RvcCgpXG5cbiAgICAgIGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgICAgc2V0RXJyb3IocmVzdWx0LmVycm9yID8/ICdGYWlsZWQgdG8gb3BlbiBDbGF1ZGUgRGVza3RvcCcpXG4gICAgICAgIHNldFN0YXRlKCdlcnJvcicpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBTdWNjZXNzIC0gZXhpdCB0aGUgQ0xJXG4gICAgICBzZXRTdGF0ZSgnc3VjY2VzcycpXG5cbiAgICAgIC8vIEdpdmUgdGhlIHVzZXIgYSBtb21lbnQgdG8gc2VlIHRoZSBzdWNjZXNzIG1lc3NhZ2VcbiAgICAgIHNldFRpbWVvdXQoXG4gICAgICAgIGFzeW5jIChvbkRvbmU6IFByb3BzWydvbkRvbmUnXSkgPT4ge1xuICAgICAgICAgIG9uRG9uZSgnU2Vzc2lvbiB0cmFuc2ZlcnJlZCB0byBDbGF1ZGUgRGVza3RvcCcsIHsgZGlzcGxheTogJ3N5c3RlbScgfSlcbiAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDAsICdvdGhlcicpXG4gICAgICAgIH0sXG4gICAgICAgIDUwMCxcbiAgICAgICAgb25Eb25lLFxuICAgICAgKVxuICAgIH1cblxuICAgIHBlcmZvcm1IYW5kb2ZmKCkuY2F0Y2goZXJyID0+IHtcbiAgICAgIHNldEVycm9yKGVycm9yTWVzc2FnZShlcnIpKVxuICAgICAgc2V0U3RhdGUoJ2Vycm9yJylcbiAgICB9KVxuICB9LCBbb25Eb25lXSlcblxuICBpZiAoc3RhdGUgPT09ICdlcnJvcicpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgcGFkZGluZ1g9ezJ9PlxuICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+RXJyb3I6IHtlcnJvcn08L1RleHQ+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPlByZXNzIGFueSBrZXkgdG8gY29udGludWXigKY8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICApXG4gIH1cblxuICBpZiAoc3RhdGUgPT09ICdwcm9tcHQtZG93bmxvYWQnKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIHBhZGRpbmdYPXsyfT5cbiAgICAgICAgPFRleHQ+e2Rvd25sb2FkTWVzc2FnZX08L1RleHQ+XG4gICAgICAgIDxUZXh0PkRvd25sb2FkIG5vdz8gKHkvbik8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICApXG4gIH1cblxuICBjb25zdCBtZXNzYWdlczogUmVjb3JkPFxuICAgIEV4Y2x1ZGU8RGVza3RvcEhhbmRvZmZTdGF0ZSwgJ2Vycm9yJyB8ICdwcm9tcHQtZG93bmxvYWQnPixcbiAgICBzdHJpbmdcbiAgPiA9IHtcbiAgICBjaGVja2luZzogJ0NoZWNraW5nIGZvciBDbGF1ZGUgRGVza3RvcOKApicsXG4gICAgZmx1c2hpbmc6ICdTYXZpbmcgc2Vzc2lvbuKApicsXG4gICAgb3BlbmluZzogJ09wZW5pbmcgQ2xhdWRlIERlc2t0b3DigKYnLFxuICAgIHN1Y2Nlc3M6ICdPcGVuaW5nIGluIENsYXVkZSBEZXNrdG9w4oCmJyxcbiAgfVxuXG4gIHJldHVybiA8TG9hZGluZ1N0YXRlIG1lc3NhZ2U9e21lc3NhZ2VzW3N0YXRl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