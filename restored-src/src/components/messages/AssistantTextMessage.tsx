/**
 * AssistantTextMessage.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是助手文本消息的核心渲染组件，负责将 TextBlockParam 中的文字内容渲染至终端。
 * 它是 Claude 回复的主要展示入口，同时承担所有已知错误类型的差异化渲染职责。
 * 位于：消息列表 → 助手消息行 → 【文本内容渲染区】
 *
 * 【主要功能】
 * 1. 空文本过滤：isEmptyMessageText 为真时直接返回 null。
 * 2. 速率限制错误：由 isRateLimitErrorMessage 检测并交给 RateLimitMessage 组件处理。
 * 3. switch 分支覆盖所有已知错误常量：
 *    - NO_RESPONSE_REQUESTED → null（本地 JSX 命令，无需响应）
 *    - PROMPT_TOO_LONG_ERROR_MESSAGE → 红色"Context limit reached · /compact…"
 *    - CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE → 红色余额不足提示及充值链接
 *    - INVALID_API_KEY_ERROR_MESSAGE → InvalidApiKeyMessage（含钥匙串锁定检测）
 *    - INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL → 红色外部构建专用提示
 *    - ORG_DISABLED_ERROR_MESSAGE_ENV_KEY[_WITH_OAUTH] → 动态文本红色提示
 *    - TOKEN_REVOKED_ERROR_MESSAGE → 红色令牌撤销提示
 *    - API_TIMEOUT_ERROR_MESSAGE → 红色超时提示（含 API_TIMEOUT_MS 环境变量）
 *    - CUSTOM_OFF_SWITCH_MESSAGE → 红色 Opus 4 高需求警告 + 建议切换 Sonnet
 *    - ERROR_MESSAGE_USER_ABORT → InterruptedByUser 组件
 * 4. default 分支：
 *    - API 错误前缀：渲染截断错误文本 + 可选 CtrlOToExpand
 *    - 普通文本：渲染带有选中高亮、可选黑色圆点（shouldShowDot）的 Markdown 内容
 */
import { c as _c } from "react/compiler-runtime";
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useContext } from 'react';
import { ERROR_MESSAGE_USER_ABORT } from 'src/services/compact/compact.js';
import { isRateLimitErrorMessage } from 'src/services/rateLimitMessages.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, NoSelect, Text } from '../../ink.js';
import { API_ERROR_MESSAGE_PREFIX, API_TIMEOUT_ERROR_MESSAGE, CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE, CUSTOM_OFF_SWITCH_MESSAGE, INVALID_API_KEY_ERROR_MESSAGE, INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL, ORG_DISABLED_ERROR_MESSAGE_ENV_KEY, ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH, PROMPT_TOO_LONG_ERROR_MESSAGE, startsWithApiErrorPrefix, TOKEN_REVOKED_ERROR_MESSAGE } from '../../services/api/errors.js';
import { isEmptyMessageText, NO_RESPONSE_REQUESTED } from '../../utils/messages.js';
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js';
import { getDefaultSonnetModel, renderModelName } from '../../utils/model/model.js';
import { isMacOsKeychainLocked } from '../../utils/secureStorage/macOsKeychainStorage.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { InterruptedByUser } from '../InterruptedByUser.js';
import { Markdown } from '../Markdown.js';
import { MessageResponse } from '../MessageResponse.js';
import { MessageActionsSelectedContext } from '../messageActions.js';
import { RateLimitMessage } from './RateLimitMessage.js';

// API 错误文本最大显示字符数（超出时截断并提供展开提示）
const MAX_API_ERROR_CHARS = 1000;
type Props = {
  param: TextBlockParam;
  addMargin: boolean;
  shouldShowDot: boolean;
  verbose: boolean;
  width?: number | string;
  onOpenRateLimitOptions?: () => void;
};

/**
 * InvalidApiKeyMessage 内部组件
 *
 * 【作用】
 * 渲染 API Key 无效时的错误提示，同时检测 macOS 钥匙串是否已锁定：
 * - 若钥匙串已锁定，追加"· Run in another terminal: security unlock-keychain"提示。
 * 使用 _c(2)：槽 0 缓存钥匙串状态（sentinel 检查），槽 1 缓存整个 JSX 节点（sentinel 检查）。
 * 由于两个依赖值均为静态（组件生命周期内不变），实际上只渲染一次。
 */
function InvalidApiKeyMessage() {
  // React Compiler 生成的 2 槽缓存数组
  const $ = _c(2);
  let t0;
  // 槽 0：钥匙串锁定状态，只调用一次（静态结果）
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = isMacOsKeychainLocked();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const isKeychainLocked = t0;
  let t1;
  // 槽 1：整个错误提示 JSX 节点，只创建一次
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <MessageResponse><Box flexDirection="column"><Text color="error">{INVALID_API_KEY_ERROR_MESSAGE}</Text>{isKeychainLocked && <Text dimColor={true}>· Run in another terminal: security unlock-keychain</Text>}</Box></MessageResponse>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}

/**
 * AssistantTextMessage 主组件
 *
 * 【整体流程】
 * 1. 使用 _c(34) 创建 34 槽缓存数组
 * 2. 解构 param（取 text）、addMargin、shouldShowDot、verbose、onOpenRateLimitOptions
 * 3. 通过 useContext(MessageActionsSelectedContext) 获取当前消息是否被选中（用于高亮背景）
 * 4. 空文本早退 → isRateLimitErrorMessage 早退 → switch 分支处理各已知错误
 * 5. switch default 分支处理 API 错误前缀文本和普通 Markdown 文本
 *
 * 【缓存槽分配（共 34 槽）】
 * 槽 0/1/2   → RateLimitMessage（onOpenRateLimitOptions + text 变化时重建）
 * 槽 3/4     → PROMPT_TOO_LONG：upgradeHint 计算 + JSX 节点（均为 sentinel 静态）
 * 槽 5       → CREDIT_BALANCE：JSX 节点（sentinel 静态）
 * 槽 6       → INVALID_API_KEY：JSX 节点（sentinel 静态）
 * 槽 7       → INVALID_API_KEY_EXTERNAL：JSX 节点（sentinel 静态）
 * 槽 8/9     → ORG_DISABLED（含 OAuth）：text 变化时重建
 * 槽 10      → TOKEN_REVOKED：JSX 节点（sentinel 静态）
 * 槽 11      → API_TIMEOUT：JSX 节点（sentinel 静态）
 * 槽 12/13   → CUSTOM_OFF_SWITCH：错误文本节点（12，sentinel）+ 外层 Box（13，sentinel）
 * 槽 14      → USER_ABORT：JSX 节点（sentinel 静态）
 * 槽 15/16   → API 错误文本 Text 节点（依 t2 文本变化）
 * 槽 17/18   → truncated 条件下的 CtrlOToExpand 节点
 * 槽 19/20/21 → API 错误外层 MessageResponse Box
 * 槽 22/23/24 → 黑点 NoSelect 节点（依 isSelected + shouldShowDot 变化）
 * 槽 25/26   → Markdown 内容 Box（依 text 变化）
 * 槽 27/28/29 → row Box（依黑点 + Markdown 变化）
 * 槽 30/31/32/33 → 最外层对齐 Box（依 marginTop + backgroundColor + row 变化）
 */
export function AssistantTextMessage(t0) {
  // React Compiler 生成的 34 槽缓存数组
  const $ = _c(34);
  // 解构所有属性，从 param 中取出文本内容
  const {
    param: t1,
    addMargin,
    shouldShowDot,
    verbose,
    onOpenRateLimitOptions
  } = t0;
  const {
    text
  } = t1;
  // 通过 Context 判断当前消息是否处于选中状态（用于背景高亮）
  const isSelected = useContext(MessageActionsSelectedContext);
  // 早退：空文本不渲染任何内容
  if (isEmptyMessageText(text)) {
    return null;
  }
  // 速率限制错误：交由专用 RateLimitMessage 组件处理
  // 使用导出函数检测，避免脆弱的字符串硬编码耦合
  if (isRateLimitErrorMessage(text)) {
    let t2;
    // 槽 0/1/2：依 onOpenRateLimitOptions 或 text 变化重建节点
    if ($[0] !== onOpenRateLimitOptions || $[1] !== text) {
      t2 = <RateLimitMessage text={text} onOpenRateLimitOptions={onOpenRateLimitOptions} />;
      $[0] = onOpenRateLimitOptions;
      $[1] = text;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    return t2;
  }
  switch (text) {
    case NO_RESPONSE_REQUESTED:
      {
        // 本地 JSX 命令（如 /clear）无需显示响应，但 Claude 仍需看到它们
        return null;
      }
    case PROMPT_TOO_LONG_ERROR_MESSAGE:
      {
        let t2;
        // 槽 3：静态计算升级提示信息（只需计算一次）
        if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = getUpgradeMessage("warning");
          $[3] = t2;
        } else {
          t2 = $[3];
        }
        const upgradeHint = t2;
        let t3;
        // 槽 4：静态 JSX 节点（上下文限制提示 + 可选升级建议）
        if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <MessageResponse height={1}><Text color="error">Context limit reached · /compact or /clear to continue{upgradeHint ? ` · ${upgradeHint}` : ""}</Text></MessageResponse>;
          $[4] = t3;
        } else {
          t3 = $[4];
        }
        return t3;
      }
    case CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE:
      {
        let t2;
        // 槽 5：静态 JSX 节点（余额不足提示及充值链接）
        if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">Credit balance too low · Add funds: https://platform.claude.com/settings/billing</Text></MessageResponse>;
          $[5] = t2;
        } else {
          t2 = $[5];
        }
        return t2;
      }
    case INVALID_API_KEY_ERROR_MESSAGE:
      {
        let t2;
        // 槽 6：静态的 InvalidApiKeyMessage 子组件节点
        if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <InvalidApiKeyMessage />;
          $[6] = t2;
        } else {
          t2 = $[6];
        }
        return t2;
      }
    case INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL:
      {
        let t2;
        // 槽 7：静态 JSX 节点（外部构建专用无效 API Key 提示）
        if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL}</Text></MessageResponse>;
          $[7] = t2;
        } else {
          t2 = $[7];
        }
        return t2;
      }
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY:
    case ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH:
      {
        let t2;
        // 槽 8/9：依 text（含 OAuth 变体）变化重建节点
        if ($[8] !== text) {
          t2 = <MessageResponse><Text color="error">{text}</Text></MessageResponse>;
          $[8] = text;
          $[9] = t2;
        } else {
          t2 = $[9];
        }
        return t2;
      }
    case TOKEN_REVOKED_ERROR_MESSAGE:
      {
        let t2;
        // 槽 10：静态 JSX 节点（令牌已撤销提示）
        if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{TOKEN_REVOKED_ERROR_MESSAGE}</Text></MessageResponse>;
          $[10] = t2;
        } else {
          t2 = $[10];
        }
        return t2;
      }
    case API_TIMEOUT_ERROR_MESSAGE:
      {
        let t2;
        // 槽 11：静态 JSX 节点（API 超时提示，含可选 API_TIMEOUT_MS 环境变量说明）
        if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><Text color="error">{API_TIMEOUT_ERROR_MESSAGE}{process.env.API_TIMEOUT_MS && <>{" "}(API_TIMEOUT_MS={process.env.API_TIMEOUT_MS}ms, try increasing it)</>}</Text></MessageResponse>;
          $[11] = t2;
        } else {
          t2 = $[11];
        }
        return t2;
      }
    case CUSTOM_OFF_SWITCH_MESSAGE:
      {
        let t2;
        // 槽 12：静态红色错误文本节点（Opus 4 高需求警告）
        if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <Text color="error">We are experiencing high demand for Opus 4.</Text>;
          $[12] = t2;
        } else {
          t2 = $[12];
        }
        let t3;
        // 槽 13：静态外层节点（包含建议切换到默认 Sonnet 模型的提示）
        if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <MessageResponse><Box flexDirection="column" gap={1}>{t2}<Text>To continue immediately, use /model to switch to{" "}{renderModelName(getDefaultSonnetModel())} and continue coding.</Text></Box></MessageResponse>;
          $[13] = t3;
        } else {
          t3 = $[13];
        }
        return t3;
      }
    case ERROR_MESSAGE_USER_ABORT:
      {
        let t2;
        // 槽 14：静态 JSX 节点（用户中断提示，渲染 InterruptedByUser 组件）
        if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
          $[14] = t2;
        } else {
          t2 = $[14];
        }
        return t2;
      }
    default:
      {
        // ── default 分支：处理 API 错误前缀文本和普通 Markdown 文本 ──
        if (startsWithApiErrorPrefix(text)) {
          // 非 verbose 模式下截断超长 API 错误文本
          const truncated = !verbose && text.length > MAX_API_ERROR_CHARS;
          // 计算最终展示文本：仅前缀 → 加默认提示；截断 → 加省略号；否则原文
          const t2 = text === API_ERROR_MESSAGE_PREFIX ? `${API_ERROR_MESSAGE_PREFIX}: Please wait a moment and try again.` : truncated ? text.slice(0, MAX_API_ERROR_CHARS) + "\u2026" : text;
          let t3;
          // 槽 15/16：依 t2（展示文本）变化重建红色错误 Text 节点
          if ($[15] !== t2) {
            t3 = <Text color="error">{t2}</Text>;
            $[15] = t2;
            $[16] = t3;
          } else {
            t3 = $[16];
          }
          let t4;
          // 槽 17/18：依 truncated 变化重建 CtrlOToExpand 节点（截断时才显示）
          if ($[17] !== truncated) {
            t4 = truncated && <CtrlOToExpand />;
            $[17] = truncated;
            $[18] = t4;
          } else {
            t4 = $[18];
          }
          let t5;
          // 槽 19/20/21：依 t3/t4 变化重建 MessageResponse 外层 Box
          if ($[19] !== t3 || $[20] !== t4) {
            t5 = <MessageResponse><Box flexDirection="column">{t3}{t4}</Box></MessageResponse>;
            $[19] = t3;
            $[20] = t4;
            $[21] = t5;
          } else {
            t5 = $[21];
          }
          return t5;
        }
        // ── 普通 Markdown 文本渲染 ──
        // 顶部外边距：addMargin 为真时为 1
        const t2 = addMargin ? 1 : 0;
        // 选中时使用 messageActionsBackground 背景色，否则透明
        const t3 = isSelected ? "messageActionsBackground" : undefined;
        let t4;
        // 槽 22/23/24：依 isSelected 或 shouldShowDot 变化重建黑色圆点节点
        // fromLeftEdge + minWidth=2 确保圆点与文本左对齐
        if ($[22] !== isSelected || $[23] !== shouldShowDot) {
          t4 = shouldShowDot && <NoSelect fromLeftEdge={true} minWidth={2}><Text color={isSelected ? "suggestion" : "text"}>{BLACK_CIRCLE}</Text></NoSelect>;
          $[22] = isSelected;
          $[23] = shouldShowDot;
          $[24] = t4;
        } else {
          t4 = $[24];
        }
        let t5;
        // 槽 25/26：依 text 变化重建 Markdown 内容 Box
        if ($[25] !== text) {
          t5 = <Box flexDirection="column"><Markdown>{text}</Markdown></Box>;
          $[25] = text;
          $[26] = t5;
        } else {
          t5 = $[26];
        }
        let t6;
        // 槽 27/28/29：依黑点节点或 Markdown Box 变化重建 row Box
        if ($[27] !== t4 || $[28] !== t5) {
          t6 = <Box flexDirection="row">{t4}{t5}</Box>;
          $[27] = t4;
          $[28] = t5;
          $[29] = t6;
        } else {
          t6 = $[29];
        }
        let t7;
        // 槽 30/31/32/33：依 marginTop、backgroundColor 或内容 Box 变化重建最外层对齐 Box
        if ($[30] !== t2 || $[31] !== t3 || $[32] !== t6) {
          t7 = <Box alignItems="flex-start" flexDirection="row" justifyContent="space-between" marginTop={t2} width="100%" backgroundColor={t3}>{t6}</Box>;
          $[30] = t2;
          $[31] = t3;
          $[32] = t6;
          $[33] = t7;
        } else {
          t7 = $[33];
        }
        return t7;
      }
  }
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUZXh0QmxvY2tQYXJhbSIsIlJlYWN0IiwidXNlQ29udGV4dCIsIkVSUk9SX01FU1NBR0VfVVNFUl9BQk9SVCIsImlzUmF0ZUxpbWl0RXJyb3JNZXNzYWdlIiwiQkxBQ0tfQ0lSQ0xFIiwiQm94IiwiTm9TZWxlY3QiLCJUZXh0IiwiQVBJX0VSUk9SX01FU1NBR0VfUFJFRklYIiwiQVBJX1RJTUVPVVRfRVJST1JfTUVTU0FHRSIsIkNSRURJVF9CQUxBTkNFX1RPT19MT1dfRVJST1JfTUVTU0FHRSIsIkNVU1RPTV9PRkZfU1dJVENIX01FU1NBR0UiLCJJTlZBTElEX0FQSV9LRVlfRVJST1JfTUVTU0FHRSIsIklOVkFMSURfQVBJX0tFWV9FUlJPUl9NRVNTQUdFX0VYVEVSTkFMIiwiT1JHX0RJU0FCTEVEX0VSUk9SX01FU1NBR0VfRU5WX0tFWSIsIk9SR19ESVNBQkxFRF9FUlJPUl9NRVNTQUdFX0VOVl9LRVlfV0lUSF9PQVVUSCIsIlBST01QVF9UT09fTE9OR19FUlJPUl9NRVNTQUdFIiwic3RhcnRzV2l0aEFwaUVycm9yUHJlZml4IiwiVE9LRU5fUkVWT0tFRF9FUlJPUl9NRVNTQUdFIiwiaXNFbXB0eU1lc3NhZ2VUZXh0IiwiTk9fUkVTUE9OU0VfUkVRVUVTVEVEIiwiZ2V0VXBncmFkZU1lc3NhZ2UiLCJnZXREZWZhdWx0U29ubmV0TW9kZWwiLCJyZW5kZXJNb2RlbE5hbWUiLCJpc01hY09zS2V5Y2hhaW5Mb2NrZWQiLCJDdHJsT1RvRXhwYW5kIiwiSW50ZXJydXB0ZWRCeVVzZXIiLCJNYXJrZG93biIsIk1lc3NhZ2VSZXNwb25zZSIsIk1lc3NhZ2VBY3Rpb25zU2VsZWN0ZWRDb250ZXh0IiwiUmF0ZUxpbWl0TWVzc2FnZSIsIk1BWF9BUElfRVJST1JfQ0hBUlMiLCJQcm9wcyIsInBhcmFtIiwiYWRkTWFyZ2luIiwic2hvdWxkU2hvd0RvdCIsInZlcmJvc2UiLCJ3aWR0aCIsIm9uT3BlblJhdGVMaW1pdE9wdGlvbnMiLCJJbnZhbGlkQXBpS2V5TWVzc2FnZSIsIiQiLCJfYyIsInQwIiwiU3ltYm9sIiwiZm9yIiwiaXNLZXljaGFpbkxvY2tlZCIsInQxIiwiQXNzaXN0YW50VGV4dE1lc3NhZ2UiLCJ0ZXh0IiwiaXNTZWxlY3RlZCIsInQyIiwidXBncmFkZUhpbnQiLCJ0MyIsInByb2Nlc3MiLCJlbnYiLCJBUElfVElNRU9VVF9NUyIsInRydW5jYXRlZCIsImxlbmd0aCIsInNsaWNlIiwidDQiLCJ0NSIsInVuZGVmaW5lZCIsInQ2IiwidDciXSwic291cmNlcyI6WyJBc3Npc3RhbnRUZXh0TWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUZXh0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgUmVhY3QsIHsgdXNlQ29udGV4dCB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgRVJST1JfTUVTU0FHRV9VU0VSX0FCT1JUIH0gZnJvbSAnc3JjL3NlcnZpY2VzL2NvbXBhY3QvY29tcGFjdC5qcydcbmltcG9ydCB7IGlzUmF0ZUxpbWl0RXJyb3JNZXNzYWdlIH0gZnJvbSAnc3JjL3NlcnZpY2VzL3JhdGVMaW1pdE1lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgQkxBQ0tfQ0lSQ0xFIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL2ZpZ3VyZXMuanMnXG5pbXBvcnQgeyBCb3gsIE5vU2VsZWN0LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHtcbiAgQVBJX0VSUk9SX01FU1NBR0VfUFJFRklYLFxuICBBUElfVElNRU9VVF9FUlJPUl9NRVNTQUdFLFxuICBDUkVESVRfQkFMQU5DRV9UT09fTE9XX0VSUk9SX01FU1NBR0UsXG4gIENVU1RPTV9PRkZfU1dJVENIX01FU1NBR0UsXG4gIElOVkFMSURfQVBJX0tFWV9FUlJPUl9NRVNTQUdFLFxuICBJTlZBTElEX0FQSV9LRVlfRVJST1JfTUVTU0FHRV9FWFRFUk5BTCxcbiAgT1JHX0RJU0FCTEVEX0VSUk9SX01FU1NBR0VfRU5WX0tFWSxcbiAgT1JHX0RJU0FCTEVEX0VSUk9SX01FU1NBR0VfRU5WX0tFWV9XSVRIX09BVVRILFxuICBQUk9NUFRfVE9PX0xPTkdfRVJST1JfTUVTU0FHRSxcbiAgc3RhcnRzV2l0aEFwaUVycm9yUHJlZml4LFxuICBUT0tFTl9SRVZPS0VEX0VSUk9SX01FU1NBR0UsXG59IGZyb20gJy4uLy4uL3NlcnZpY2VzL2FwaS9lcnJvcnMuanMnXG5pbXBvcnQge1xuICBpc0VtcHR5TWVzc2FnZVRleHQsXG4gIE5PX1JFU1BPTlNFX1JFUVVFU1RFRCxcbn0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBnZXRVcGdyYWRlTWVzc2FnZSB9IGZyb20gJy4uLy4uL3V0aWxzL21vZGVsL2NvbnRleHRXaW5kb3dVcGdyYWRlQ2hlY2suanMnXG5pbXBvcnQge1xuICBnZXREZWZhdWx0U29ubmV0TW9kZWwsXG4gIHJlbmRlck1vZGVsTmFtZSxcbn0gZnJvbSAnLi4vLi4vdXRpbHMvbW9kZWwvbW9kZWwuanMnXG5pbXBvcnQgeyBpc01hY09zS2V5Y2hhaW5Mb2NrZWQgfSBmcm9tICcuLi8uLi91dGlscy9zZWN1cmVTdG9yYWdlL21hY09zS2V5Y2hhaW5TdG9yYWdlLmpzJ1xuaW1wb3J0IHsgQ3RybE9Ub0V4cGFuZCB9IGZyb20gJy4uL0N0cmxPVG9FeHBhbmQuanMnXG5pbXBvcnQgeyBJbnRlcnJ1cHRlZEJ5VXNlciB9IGZyb20gJy4uL0ludGVycnVwdGVkQnlVc2VyLmpzJ1xuaW1wb3J0IHsgTWFya2Rvd24gfSBmcm9tICcuLi9NYXJrZG93bi5qcydcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IE1lc3NhZ2VBY3Rpb25zU2VsZWN0ZWRDb250ZXh0IH0gZnJvbSAnLi4vbWVzc2FnZUFjdGlvbnMuanMnXG5pbXBvcnQgeyBSYXRlTGltaXRNZXNzYWdlIH0gZnJvbSAnLi9SYXRlTGltaXRNZXNzYWdlLmpzJ1xuXG5jb25zdCBNQVhfQVBJX0VSUk9SX0NIQVJTID0gMTAwMFxuXG50eXBlIFByb3BzID0ge1xuICBwYXJhbTogVGV4dEJsb2NrUGFyYW1cbiAgYWRkTWFyZ2luOiBib29sZWFuXG4gIHNob3VsZFNob3dEb3Q6IGJvb2xlYW5cbiAgdmVyYm9zZTogYm9vbGVhblxuICB3aWR0aD86IG51bWJlciB8IHN0cmluZ1xuICBvbk9wZW5SYXRlTGltaXRPcHRpb25zPzogKCkgPT4gdm9pZFxufVxuXG5mdW5jdGlvbiBJbnZhbGlkQXBpS2V5TWVzc2FnZSgpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBpc0tleWNoYWluTG9ja2VkID0gaXNNYWNPc0tleWNoYWluTG9ja2VkKClcblxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPntJTlZBTElEX0FQSV9LRVlfRVJST1JfTUVTU0FHRX08L1RleHQ+XG4gICAgICAgIHtpc0tleWNoYWluTG9ja2VkICYmIChcbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICAgIMK3IFJ1biBpbiBhbm90aGVyIHRlcm1pbmFsOiBzZWN1cml0eSB1bmxvY2sta2V5Y2hhaW5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICl9XG4gICAgICA8L0JveD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gQXNzaXN0YW50VGV4dE1lc3NhZ2Uoe1xuICBwYXJhbTogeyB0ZXh0IH0sXG4gIGFkZE1hcmdpbixcbiAgc2hvdWxkU2hvd0RvdCxcbiAgdmVyYm9zZSxcbiAgb25PcGVuUmF0ZUxpbWl0T3B0aW9ucyxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgaXNTZWxlY3RlZCA9IHVzZUNvbnRleHQoTWVzc2FnZUFjdGlvbnNTZWxlY3RlZENvbnRleHQpXG4gIGlmIChpc0VtcHR5TWVzc2FnZVRleHQodGV4dCkpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgLy8gSGFuZGxlIGFsbCByYXRlIGxpbWl0IGVycm9yIG1lc3NhZ2VzIGZyb20gZ2V0UmF0ZUxpbWl0RXJyb3JNZXNzYWdlXG4gIC8vIFVzZSB0aGUgZXhwb3J0ZWQgZnVuY3Rpb24gdG8gYXZvaWQgZnJhZ2lsZSBzdHJpbmcgY291cGxpbmdcbiAgaWYgKGlzUmF0ZUxpbWl0RXJyb3JNZXNzYWdlKHRleHQpKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxSYXRlTGltaXRNZXNzYWdlXG4gICAgICAgIHRleHQ9e3RleHR9XG4gICAgICAgIG9uT3BlblJhdGVMaW1pdE9wdGlvbnM9e29uT3BlblJhdGVMaW1pdE9wdGlvbnN9XG4gICAgICAvPlxuICAgIClcbiAgfVxuXG4gIHN3aXRjaCAodGV4dCkge1xuICAgIC8vIExvY2FsIEpTWCBjb21tYW5kcyBkb24ndCBuZWVkIGEgcmVzcG9uc2UsIGJ1dCB3ZSBzdGlsbCB3YW50IENsYXVkZSB0byBzZWUgdGhlbVxuICAgIC8vIFRvb2wgcmVzdWx0cyByZW5kZXIgdGhlaXIgb3duIGludGVycnVwdCBtZXNzYWdlc1xuICAgIGNhc2UgTk9fUkVTUE9OU0VfUkVRVUVTVEVEOlxuICAgICAgcmV0dXJuIG51bGxcblxuICAgIGNhc2UgUFJPTVBUX1RPT19MT05HX0VSUk9SX01FU1NBR0U6IHtcbiAgICAgIGNvbnN0IHVwZ3JhZGVIaW50ID0gZ2V0VXBncmFkZU1lc3NhZ2UoJ3dhcm5pbmcnKVxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgICAgIDxUZXh0IGNvbG9yPVwiZXJyb3JcIj5cbiAgICAgICAgICAgIENvbnRleHQgbGltaXQgcmVhY2hlZCDCtyAvY29tcGFjdCBvciAvY2xlYXIgdG8gY29udGludWVcbiAgICAgICAgICAgIHt1cGdyYWRlSGludCA/IGAgwrcgJHt1cGdyYWRlSGludH1gIDogJyd9XG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcbiAgICB9XG5cbiAgICBjYXNlIENSRURJVF9CQUxBTkNFX1RPT19MT1dfRVJST1JfTUVTU0FHRTpcbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+XG4gICAgICAgICAgICBDcmVkaXQgYmFsYW5jZSB0b28gbG93ICZtaWRkb3Q7IEFkZCBmdW5kczpcbiAgICAgICAgICAgIGh0dHBzOi8vcGxhdGZvcm0uY2xhdWRlLmNvbS9zZXR0aW5ncy9iaWxsaW5nXG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcblxuICAgIGNhc2UgSU5WQUxJRF9BUElfS0VZX0VSUk9SX01FU1NBR0U6XG4gICAgICByZXR1cm4gPEludmFsaWRBcGlLZXlNZXNzYWdlIC8+XG5cbiAgICBjYXNlIElOVkFMSURfQVBJX0tFWV9FUlJPUl9NRVNTQUdFX0VYVEVSTkFMOlxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgICAgIDxUZXh0IGNvbG9yPVwiZXJyb1wiPntJTlZBTElEX0FQSV9LRVlfRVJST1JfTUVTU0FHRV9FWFRFUk5BTH08L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKVxuXG4gICAgY2FzZSBPUkdfRElTQUJMRURfRVJST1JfTUVTU0FHRV9FTlZfS0VZOlxuICAgIGNhc2UgT1JHX0RJU0FCTEVEX0VSUk9SX01FU1NBR0VfRU5WX0tFWV9XSVRIX09BVVRIOlxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+e3RleHR9PC9UZXh0PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcblxuICAgIGNhc2UgVE9LRU5fUkVWT0tFRF9FUlJPUl9NRVNTQUdFOlxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgICAgIDxUZXh0IGNvbG9yPVwiZXJyb3JcIj57VE9LRU5fUkVWT0tFRF9FUlJPUl9NRVNTQUdFfTwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG5cbiAgICBjYXNlIEFQSV9USU1FT1VUX0VSUk9SX01FU1NBR0U6XG4gICAgICByZXR1cm4gKFxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPlxuICAgICAgICAgICAge0FQSV9USU1FT1VUX0VSUk9SX01FU1NBR0V9XG4gICAgICAgICAgICB7cHJvY2Vzcy5lbnYuQVBJX1RJTUVPVVRfTVMgJiYgKFxuICAgICAgICAgICAgICA8PlxuICAgICAgICAgICAgICAgIHsnICd9XG4gICAgICAgICAgICAgICAgKEFQSV9USU1FT1VUX01TPXtwcm9jZXNzLmVudi5BUElfVElNRU9VVF9NU31tcywgdHJ5IGluY3JlYXNpbmdcbiAgICAgICAgICAgICAgICBpdClcbiAgICAgICAgICAgICAgPC8+XG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG5cbiAgICBjYXNlIENVU1RPTV9PRkZfU1dJVENIX01FU1NBR0U6XG4gICAgICByZXR1cm4gKFxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIGdhcD17MX0+XG4gICAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+XG4gICAgICAgICAgICAgIFdlIGFyZSBleHBlcmllbmNpbmcgaGlnaCBkZW1hbmQgZm9yIE9wdXMgNC5cbiAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgICBUbyBjb250aW51ZSBpbW1lZGlhdGVseSwgdXNlIC9tb2RlbCB0byBzd2l0Y2ggdG97JyAnfVxuICAgICAgICAgICAgICB7cmVuZGVyTW9kZWxOYW1lKGdldERlZmF1bHRTb25uZXRNb2RlbCgpKX0gYW5kIGNvbnRpbnVlIGNvZGluZy5cbiAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG5cbiAgICAvLyBUT0RPOiBNb3ZlIHRoaXMgdG8gYSB1c2VyIHR1cm5cbiAgICBjYXNlIEVSUk9SX01FU1NBR0VfVVNFUl9BQk9SVDpcbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgICAgICA8SW50ZXJydXB0ZWRCeVVzZXIgLz5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG5cbiAgICBkZWZhdWx0OlxuICAgICAgaWYgKHN0YXJ0c1dpdGhBcGlFcnJvclByZWZpeCh0ZXh0KSkge1xuICAgICAgICBjb25zdCB0cnVuY2F0ZWQgPSAhdmVyYm9zZSAmJiB0ZXh0Lmxlbmd0aCA+IE1BWF9BUElfRVJST1JfQ0hBUlNcbiAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAgICAgIDxUZXh0IGNvbG9yPVwiZXJyb3JcIj5cbiAgICAgICAgICAgICAgICB7dGV4dCA9PT0gQVBJX0VSUk9SX01FU1NBR0VfUFJFRklYXG4gICAgICAgICAgICAgICAgICA/IGAke0FQSV9FUlJPUl9NRVNTQUdFX1BSRUZJWH06IFBsZWFzZSB3YWl0IGEgbW9tZW50IGFuZCB0cnkgYWdhaW4uYFxuICAgICAgICAgICAgICAgICAgOiB0cnVuY2F0ZWRcbiAgICAgICAgICAgICAgICAgICAgPyB0ZXh0LnNsaWNlKDAsIE1BWF9BUElfRVJST1JfQ0hBUlMpICsgJ+KApidcbiAgICAgICAgICAgICAgICAgICAgOiB0ZXh0fVxuICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICAgIHt0cnVuY2F0ZWQgJiYgPEN0cmxPVG9FeHBhbmQgLz59XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPEJveFxuICAgICAgICAgIGFsaWduSXRlbXM9XCJmbGV4LXN0YXJ0XCJcbiAgICAgICAgICBmbGV4RGlyZWN0aW9uPVwicm93XCJcbiAgICAgICAgICBqdXN0aWZ5Q29udGVudD1cInNwYWNlLWJldHdlZW5cIlxuICAgICAgICAgIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9XG4gICAgICAgICAgd2lkdGg9XCIxMDAlXCJcbiAgICAgICAgICBiYWNrZ3JvdW5kQ29sb3I9e2lzU2VsZWN0ZWQgPyAnbWVzc2FnZUFjdGlvbnNCYWNrZ3JvdW5kJyA6IHVuZGVmaW5lZH1cbiAgICAgICAgPlxuICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgICAgICAge3Nob3VsZFNob3dEb3QgJiYgKFxuICAgICAgICAgICAgICA8Tm9TZWxlY3QgZnJvbUxlZnRFZGdlIG1pbldpZHRoPXsyfT5cbiAgICAgICAgICAgICAgICA8VGV4dCBjb2xvcj17aXNTZWxlY3RlZCA/ICdzdWdnZXN0aW9uJyA6ICd0ZXh0J30+XG4gICAgICAgICAgICAgICAgICB7QkxBQ0tfQ0lSQ0xFfVxuICAgICAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgICAgPC9Ob1NlbGVjdD5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgICAgICAgPE1hcmtkb3duPnt0ZXh0fTwvTWFya2Rvd24+XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICApXG4gIH1cbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLGNBQWMsUUFBUSx1Q0FBdUM7QUFDM0UsT0FBT0MsS0FBSyxJQUFJQyxVQUFVLFFBQVEsT0FBTztBQUN6QyxTQUFTQyx3QkFBd0IsUUFBUSxpQ0FBaUM7QUFDMUUsU0FBU0MsdUJBQXVCLFFBQVEsbUNBQW1DO0FBQzNFLFNBQVNDLFlBQVksUUFBUSw0QkFBNEI7QUFDekQsU0FBU0MsR0FBRyxFQUFFQyxRQUFRLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ2xELFNBQ0VDLHdCQUF3QixFQUN4QkMseUJBQXlCLEVBQ3pCQyxvQ0FBb0MsRUFDcENDLHlCQUF5QixFQUN6QkMsNkJBQTZCLEVBQzdCQyxzQ0FBc0MsRUFDdENDLGtDQUFrQyxFQUNsQ0MsNkNBQTZDLEVBQzdDQyw2QkFBNkIsRUFDN0JDLHdCQUF3QixFQUN4QkMsMkJBQTJCLFFBQ3RCLDhCQUE4QjtBQUNyQyxTQUNFQyxrQkFBa0IsRUFDbEJDLHFCQUFxQixRQUNoQix5QkFBeUI7QUFDaEMsU0FBU0MsaUJBQWlCLFFBQVEsZ0RBQWdEO0FBQ2xGLFNBQ0VDLHFCQUFxQixFQUNyQkMsZUFBZSxRQUNWLDRCQUE0QjtBQUNuQyxTQUFTQyxxQkFBcUIsUUFBUSxtREFBbUQ7QUFDekYsU0FBU0MsYUFBYSxRQUFRLHFCQUFxQjtBQUNuRCxTQUFTQyxpQkFBaUIsUUFBUSx5QkFBeUI7QUFDM0QsU0FBU0MsUUFBUSxRQUFRLGdCQUFnQjtBQUN6QyxTQUFTQyxlQUFlLFFBQVEsdUJBQXVCO0FBQ3ZELFNBQVNDLDZCQUE2QixRQUFRLHNCQUFzQjtBQUNwRSxTQUFTQyxnQkFBZ0IsUUFBUSx1QkFBdUI7QUFFeEQsTUFBTUMsbUJBQW1CLEdBQUcsSUFBSTtBQUVoQyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsS0FBSyxFQUFFbEMsY0FBYztFQUNyQm1DLFNBQVMsRUFBRSxPQUFPO0VB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LElBQUFWLENBQUEsUUFBQVEsSUFBQTtVQUU5Q0UsRUFBQSxJQUFDLGVBQWUsQ0FDZCxDQUFDLElBQUksQ0FBTyxLQUFPLENBQVAsT0FBTyxDQUFFRixLQUFHLENBQUUsRUFBekIsSUFBSSxDQUNQLEVBRkMsZUFBZSxDQUVFO1VBQUFSLENBQUEsTUFBQVEsSUFBQTtVQUFBUixDQUFBLE1BQUFLLEVBQUE7UUFBQTtVQUFBQSxFQUFBLEdBQUFMLENBQUE7UUFBQTtRQUFBLE9BRmxCTSxFQUVrQjtNQUFBO0lBQUEsS0FHakJoQywyQkFBMkI7TUFBQTtRQUFBLElBQUFnQyxFQUFBO1FBQUEsSUFBQVYsQ0FBQSxTQUFBRyxNQUFBLENBQUFDLEdBQUE7VUFFNUJNLEVBQUFBSUFBQYEFBQWVDLEFBQVNBFU0BAAMBAAEBBPh1BGTbAAAAAABqQ0MtRVNGQUFMRURFLEFSUkVELUVSUk9SLU1FU1NBR0VfRVhURVJOQUwgQ0FNQU1FSSBFUlJPUiBNRVNTQUdFIEVYVEVSTkFMLCBBQ1RJT04gQ0FMTF9JTlRFUlJVUFRFRCBNRVNTQUdFIEFMVEVSTkFURSBBUFBFQUwgTUVTU0FHRSBDUkVESVQgQkFMQU5DRSBMRVZFTCBMT1cgRVJST1IgTUVTU0FHRS1XSVRIX09BVVRI
