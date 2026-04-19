/**
 * PowerShellPermissionRequest.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 PowerShell 命令权限请求的专属 UI 组件，位于权限请求 UI 层的具体工具实现层。
 * 被 PermissionRequest.tsx 中的 permissionComponentForTool() 调度器选择并渲染，
 * 专门处理 PowerShellTool 的权限确认弹框。
 *
 * 【主要功能】
 * - 渲染 PowerShell 命令权限确认对话框（基于 PermissionDialog）
 * - 支持可编辑命令前缀（editablePrefix）用于生成"不再询问"规则：
 *   - 单行命令同步初始化为原始命令，再通过异步 AST 提取精确前缀
 *   - 多行命令（含换行符）初始化为 undefined，隐藏"不再询问"选项
 *   - 复合命令提取各子命令前缀，过滤已允许的只读子命令
 * - 集成 AI 权限解释器（usePermissionExplainerUI + PermissionExplainerContent）
 * - 支持 Tab 进入反馈输入模式（useShellPermissionFeedback）
 * - 支持破坏性命令警告（tengu_destructive_command_warning 特性标志）
 * - 支持调试信息面板切换（permission:toggleDebug 快捷键）
 * - 上报分析事件：tengu_permission_request_option_selected、tengu_accept/reject_submitted
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../services/analytics/index.js';
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js';
import { getDestructiveCommandWarning } from '../../../tools/PowerShellTool/destructiveCommandWarning.js';
import { PowerShellTool } from '../../../tools/PowerShellTool/PowerShellTool.js';
import { isAllowlistedCommand } from '../../../tools/PowerShellTool/readOnlyValidation.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { getCompoundCommandPrefixesStatic } from '../../../utils/powershell/staticPrefix.js';
import { Select } from '../../CustomSelect/select.js';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js';
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionExplainerContent, usePermissionExplainerUI } from '../PermissionExplanation.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js';
import { logUnaryPermissionEvent } from '../utils.js';
import { powershellToolUseOptions } from './powershellToolUseOptions.js';

/**
 * PowerShellPermissionRequest 组件
 *
 * PowerShell 命令权限请求弹框，渲染流程：
 * 1. 解构 props：toolUseConfirm、toolUseContext、onDone、onReject、workerBadge
 * 2. 解析 PowerShellTool.inputSchema 获取 command、description
 * 3. 初始化 AI 解释器状态（usePermissionExplainerUI）
 * 4. 初始化 Shell 权限反馈状态（useShellPermissionFeedback）
 * 5. 检查特性标志决定是否显示破坏性命令警告
 * 6. 管理可编辑命令前缀状态（editablePrefix）：
 *    - 单行命令：同步初始化为原始命令，异步通过 getCompoundCommandPrefixesStatic 提取精确前缀
 *    - 多行命令：初始化为 undefined（隐藏"不再询问"选项）
 *    - hasUserEditedPrefix ref：用户手动修改前缀后不再被异步结果覆盖
 * 7. 注册 permission:toggleDebug 快捷键切换调试信息面板
 * 8. 定义 onSelect 处理用户选择：
 *    - yes-prefix-edited：将修剪后的前缀作为 addRules 规则写入 localSettings
 *    - yes：允许执行，可附加反馈文字
 *    - yes-apply-suggestions：应用权限建议（permissionResult.suggestions）后允许
 *    - no：拒绝执行，可附加反馈文字
 * 9. 渲染 PermissionDialog，内部分两个面板：
 *    - 调试面板（showPermissionDebug=true）：显示 PermissionDecisionDebugInfo
 *    - 正常面板：PermissionRuleExplanation + 破坏性警告 + Select 选项 + 底部提示文字
 *
 * @param props - PermissionRequestProps（包含 toolUseConfirm、toolUseContext、onDone、onReject、workerBadge）
 * @returns PowerShell 命令权限确认弹框节点
 */
export function PowerShellPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  // 解构 props
  const {
    toolUseConfirm,
    toolUseContext,
    onDone,
    onReject,
    workerBadge
  } = props;

  // 从工具输入解析 PowerShell 命令内容
  const {
    command,
    description
  } = PowerShellTool.inputSchema.parse(toolUseConfirm.input);

  // 获取当前主题（用于命令渲染着色）
  const [theme] = useTheme();

  // 初始化 AI 权限解释器 UI 状态（Ctrl+E 触发解释）
  const explainerState = usePermissionExplainerUI({
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
    toolDescription: toolUseConfirm.description,
    messages: toolUseContext.messages
  });

  // 初始化 Shell 权限反馈状态（Tab 进入反馈模式）
  const {
    yesInputMode,      // 是否处于"接受+反馈"输入模式
    noInputMode,       // 是否处于"拒绝+反馈"输入模式
    yesFeedbackModeEntered,  // 是否曾进入接受反馈模式（用于分析）
    noFeedbackModeEntered,   // 是否曾进入拒绝反馈模式（用于分析）
    acceptFeedback,    // 接受时的反馈文字
    rejectFeedback,    // 拒绝时的反馈文字
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,     // 当前聚焦的选项（用于显示 Tab 提示）
    handleInputModeToggle,  // Tab 键切换反馈输入模式
    handleReject,      // 执行拒绝操作
    handleFocus        // 选项聚焦回调
  } = useShellPermissionFeedback({
    toolUseConfirm,
    onDone,
    onReject,
    explainerVisible: explainerState.visible
  });

  // 检查特性标志，决定是否对命令进行破坏性操作检测
  const destructiveWarning = getFeatureValue_CACHED_MAY_BE_STALE('tengu_destructive_command_warning', false) ? getDestructiveCommandWarning(command) : null;

  // 调试面板显示状态（permission:toggleDebug 快捷键控制）
  const [showPermissionDebug, setShowPermissionDebug] = useState(false);

  // Editable prefix — compute static prefix locally (no LLM call).
  // Initialize synchronously to the raw command for single-line commands so
  // the editable input renders immediately, then refine to the extracted prefix
  // once the AST parser resolves. Multiline commands (`# comment\n...`,
  // foreach loops) get undefined → powershellToolUseOptions:64 hides the
  // "don't ask again" option — those literals are one-time-use (settings
  // corpus shows 14 multiline rules, zero match twice). For compound commands,
  // computes a prefix per subcommand, excluding subcommands that are already
  // auto-allowed (read-only).
  // 可编辑前缀初始化：多行命令→undefined（隐藏"不再询问"），单行命令→原始命令
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(command.includes('\n') ? undefined : command);

  // 用户是否手动修改过前缀（防止异步结果覆盖用户编辑）
  const hasUserEditedPrefix = useRef(false);

  // 异步提取精确前缀：通过静态 AST 解析复合命令子命令前缀
  useEffect(() => {
    let cancelled = false;
    // Filter receives ParsedCommandElement — isAllowlistedCommand works from
    // element.name/nameType/args directly. isReadOnlyCommand(text) would need
    // to reparse (pwsh.exe spawn per subcommand) and returns false without the
    // full parsed AST, making the filter a no-op.
    // 提取复合命令前缀，过滤已允许的只读子命令（不需要规则）
    getCompoundCommandPrefixesStatic(command, element => isAllowlistedCommand(element, element.text)).then(prefixes => {
      // 若已取消或用户已手动编辑，不覆盖
      if (cancelled || hasUserEditedPrefix.current) return;
      if (prefixes.length > 0) {
        // 取第一个前缀并追加 ":*" 通配符
        setEditablePrefix(`${prefixes[0]}:*`);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // 前缀变更回调：标记用户已手动编辑
  const onEditablePrefixChange = useCallback((value: string) => {
    hasUserEditedPrefix.current = true;
    setEditablePrefix(value);
  }, []);

  // 分析事件：固定 unary 事件元数据（单次工具使用）
  const unaryEvent = useMemo<UnaryEvent>(() => ({
    completion_type: 'tool_use_single',
    language_name: 'none'
  }), []);

  // 注册权限请求日志记录
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  // 构建 Select 选项列表（依赖 yesInputMode、noInputMode、editablePrefix 变化重算）
  const options = useMemo(() => powershellToolUseOptions({
    // 仅在 behavior==='ask' 时传入 suggestions（用于生成"不再询问"选项）
    suggestions: toolUseConfirm.permissionResult.behavior === 'ask' ? toolUseConfirm.permissionResult.suggestions : undefined,
    onRejectFeedbackChange: setRejectFeedback,
    onAcceptFeedbackChange: setAcceptFeedback,
    yesInputMode,
    noInputMode,
    editablePrefix,
    onEditablePrefixChange
  }), [toolUseConfirm, yesInputMode, noInputMode, editablePrefix, onEditablePrefixChange]);

  // Toggle permission debug info with keybinding
  // 注册调试面板切换快捷键（permission:toggleDebug，仅在 Confirmation 上下文激活）
  const handleToggleDebug = useCallback(() => {
    setShowPermissionDebug(prev => !prev);
  }, []);
  useKeybinding('permission:toggleDebug', handleToggleDebug, {
    context: 'Confirmation'
  });

  /**
   * onSelect
   *
   * 处理用户在 Select 中的选择，根据选项值执行对应权限操作：
   * - yes-prefix-edited：将修剪后的前缀写入 localSettings 规则，或直接允许（前缀为空时）
   * - yes：允许执行（可附加反馈文字）
   * - yes-apply-suggestions：应用 permissionResult.suggestions 规则后允许
   * - no：拒绝执行（可附加反馈文字）
   *
   * 同时上报 tengu_permission_request_option_selected 分析事件（数字 optionIndex）
   * 以及 tengu_accept_submitted / tengu_reject_submitted 详细事件
   */
  function onSelect(value: string) {
    // Map options to numeric values for analytics (strings not allowed in logEvent)
    // 将选项字符串映射为数字用于分析（logEvent 不允许字符串枚举）
    const optionIndex: Record<string, number> = {
      yes: 1,
      'yes-apply-suggestions': 2,
      'yes-prefix-edited': 2,
      no: 3
    };
    // 上报选项选择事件（含 optionIndex 和解释器可见性）
    logEvent('tengu_permission_request_option_selected', {
      option_index: optionIndex[value],
      explainer_visible: explainerState.visible
    });
    // 净化工具名称用于分析上报（不包含代码或路径信息）
    const toolNameForAnalytics = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;

    if (value === 'yes-prefix-edited') {
      // 用户编辑前缀后选择"不再询问"：将前缀写入 localSettings 规则
      const trimmedPrefix = (editablePrefix ?? '').trim();
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      if (!trimmedPrefix) {
        // 前缀为空：直接允许，不添加规则
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
      } else {
        // 前缀非空：构造 addRules 类型的 PermissionUpdate 写入 localSettings
        const prefixUpdates: PermissionUpdate[] = [{
          type: 'addRules',
          rules: [{
            toolName: PowerShellTool.name,
            ruleContent: trimmedPrefix
          }],
          behavior: 'allow',
          destination: 'localSettings'
        }];
        toolUseConfirm.onAllow(toolUseConfirm.input, prefixUpdates);
      }
      onDone();
      return;
    }

    switch (value) {
      case 'yes':
        {
          const trimmedFeedback = acceptFeedback.trim();
          logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
          // Log accept submission with feedback context
          // 上报接受提交事件（含工具名、是否 MCP、反馈长度、是否进入反馈模式）
          logEvent('tengu_accept_submitted', {
            toolName: toolNameForAnalytics,
            isMcp: toolUseConfirm.tool.isMcp ?? false,
            has_instructions: !!trimmedFeedback,
            instructions_length: trimmedFeedback.length,
            entered_feedback_mode: yesFeedbackModeEntered
          });
          // 允许执行，附带可选反馈文字（用于 Claude 下一步行动指导）
          toolUseConfirm.onAllow(toolUseConfirm.input, [], trimmedFeedback || undefined);
          onDone();
          break;
        }
      case 'yes-apply-suggestions':
        {
          logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
          // Extract suggestions if present (works for both 'ask' and 'passthrough' behaviors)
          // 提取权限建议（兼容 'ask' 和 'passthrough' behavior）
          const permissionUpdates = 'suggestions' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.suggestions || [] : [];
          toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates);
          onDone();
          break;
        }
      case 'no':
        {
          const trimmedFeedback = rejectFeedback.trim();

          // Log reject submission with feedback context
          // 上报拒绝提交事件（含工具名、是否 MCP、反馈长度、是否进入反馈模式）
          logEvent('tengu_reject_submitted', {
            toolName: toolNameForAnalytics,
            isMcp: toolUseConfirm.tool.isMcp ?? false,
            has_instructions: !!trimmedFeedback,
            instructions_length: trimmedFeedback.length,
            entered_feedback_mode: noFeedbackModeEntered
          });

          // Process rejection (with or without feedback)
          // 执行拒绝操作，附带可选反馈文字
          handleReject(trimmedFeedback || undefined);
          break;
        }
    }
  }

  return <PermissionDialog workerBadge={workerBadge} title="PowerShell command">
      {/* 命令预览区域：显示 PowerShell 命令文本 + 解释器内容 */}
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {/* 解释器可见时命令文字变灰（让解释内容更突出）*/}
        <Text dimColor={explainerState.visible}>
          {PowerShellTool.renderToolUseMessage({
          command,
          description
        }, {
          theme,
          verbose: true
        } // always show the full command
        )}
        </Text>
        {/* 解释器不可见时显示工具描述文字 */}
        {!explainerState.visible && <Text dimColor>{toolUseConfirm.description}</Text>}
        {/* AI 解释器内容（Ctrl+E 展开） */}
        <PermissionExplainerContent visible={explainerState.visible} promise={explainerState.promise} />
      </Box>
      {showPermissionDebug ? <>
          {/* 调试面板：权限决策详细信息 */}
          <PermissionDecisionDebugInfo permissionResult={toolUseConfirm.permissionResult} toolName="PowerShell" />
          {toolUseContext.options.debug && <Box justifyContent="flex-end" marginTop={1}>
              <Text dimColor>Ctrl-D to hide debug info</Text>
            </Box>}
        </> : <>
          {/* 正常面板：权限规则说明 + 破坏性警告 + 选项列表 + 底部提示 */}
          <Box flexDirection="column">
            {/* 权限规则说明（显示触发原因） */}
            <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="command" />
            {/* 破坏性命令警告（仅在特性标志开启且命令被标记时显示）*/}
            {destructiveWarning && <Box marginBottom={1}>
                <Text color="warning">{destructiveWarning}</Text>
              </Box>}
            <Text>Do you want to proceed?</Text>
            {/* 选项选择器：Yes / Yes+前缀 / No，支持内联描述和输入模式 */}
            <Select options={options} inlineDescriptions onChange={onSelect} onCancel={() => handleReject()} onFocus={handleFocus} onInputModeToggle={handleInputModeToggle} />
          </Box>
          {/* 底部提示行：Esc 取消 / Tab 修改 / ctrl+e 解释 / ctrl+d 调试 */}
          <Box justifyContent="space-between" marginTop={1}>
            <Text dimColor>
              Esc to cancel
              {/* 聚焦在 yes/no 且未进入输入模式时，提示 Tab 可修改 */}
              {(focusedOption === 'yes' && !yesInputMode || focusedOption === 'no' && !noInputMode) && ' · Tab to amend'}
              {/* 解释器功能可用时，提示 ctrl+e */}
              {explainerState.enabled && ` · ctrl+e to ${explainerState.visible ? 'hide' : 'explain'}`}
            </Text>
            {/* 调试模式下显示 ctrl+d 提示 */}
            {toolUseContext.options.debug && <Text dimColor>Ctrl+d to show debug info</Text>}
          </Box>
        </>}
    </PermissionDialog>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNhbGxiYWNrIiwidXNlRWZmZWN0IiwidXNlTWVtbyIsInVzZVJlZiIsInVzZVN0YXRlIiwiQm94IiwiVGV4dCIsInVzZVRoZW1lIiwidXNlS2V5YmluZGluZyIsImdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFIiwiQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyIsImxvZ0V2ZW50Iiwic2FuaXRpemVUb29sTmFtZUZvckFuYWx5dGljcyIsImdldERlc3RydWN0aXZlQ29tbWFuZFdhcm5pbmciLCJQb3dlclNoZWxsVG9vbCIsImlzQWxsb3dsaXN0ZWRDb21tYW5kIiwiUGVybWlzc2lvblVwZGF0ZSIsImdldENvbXBvdW5kQ29tbWFuZFByZWZpeGVzU3RhdGljIiwiU2VsZWN0IiwiVW5hcnlFdmVudCIsInVzZVBlcm1pc3Npb25SZXF1ZXN0TG9nZ2luZyIsIlBlcm1pc3Npb25EZWNpc2lvbkRlYnVnSW5mbyIsIlBlcm1pc3Npb25EaWFsb2ciLCJQZXJtaXNzaW9uRXhwbGFpbmVyQ29udGVudCIsInVzZVBlcm1pc3Npb25FeHBsYWluZXJVSSIsIlBlcm1pc3Npb25SZXF1ZXN0UHJvcHMiLCJQZXJtaXNzaW9uUnVsZUV4cGxhbmF0aW9uIiwidXNlU2hlbGxQZXJtaXNzaW9uRmVlZGJhY2siLCJsb2dVbmFyeVBlcm1pc3Npb25FdmVudCIsInBvd2Vyc2hlbGxUb29sVXNlT3B0aW9ucyJdLCJzb3VyY2VzIjpbIlBvd2VyU2hlbGxQZXJtaXNzaW9uUmVxdWVzdC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZUNhbGxiYWNrLCB1c2VFZmZlY3QsIHVzZU1lbW8sIHVzZVJlZiwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCwgdXNlVGhlbWUgfSBmcm9tICcuLi8uLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB1c2VLZXliaW5kaW5nIH0gZnJvbSAnLi4vLi4vLi4va2V5YmluZGluZ3MvdXNlS2V5YmluZGluZy5qcydcbmltcG9ydCB7IGdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFIH0gZnJvbSAnLi4vLi4vLi4vc2VydmljZXMvYW5hbHl0aWNzL2dyb3d0aGJvb2suanMnXG5pbXBvcnQge1xuICB0eXBlIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gIGxvZ0V2ZW50LFxufSBmcm9tICcuLi8uLi8uLi9zZXJ2aWNlcy9hbmFseXRpY3MvaW5kZXguanMnXG5pbXBvcnQgeyBzYW5pdGl6ZVRvb2xOYW1lRm9yQW5hbHl0aWNzIH0gZnJvbSAnLi4vLi4vLi4vc2VydmljZXMvYW5hbHl0aWNzL21ldGFkYXRhLmpzJ1xuaW1wb3J0IHsgZ2V0RGVzdHJ1Y3RpdmVDb21tYW5kV2FybmluZyB9IGZyb20gJy4uLy4uLy4uL3Rvb2xzL1Bvd2VyU2hlbGxUb29sL2Rlc3RydWN0aXZlQ29tbWFuZFdhcm5pbmcuanMnXG5pbXBvcnQgeyBQb3dlclNoZWxsVG9vbCB9IGZyb20gJy4uLy4uLy4uL3Rvb2xzL1Bvd2VyU2hlbGxUb29sL1Bvd2VyU2hlbGxUb29sLmpzJ1xuaW1wb3J0IHsgaXNBbGxvd2xpc3RlZENvbW1hbmQgfSBmcm9tICcuLi8uLi8uLi90b29scy9Qb3dlclNoZWxsVG9vbC9yZWFkT25seVZhbGlkYXRpb24uanMnXG5pbXBvcnQgdHlwZSB7IFBlcm1pc3Npb25VcGRhdGUgfSBmcm9tICcuLi8uLi8uLi91dGlscy9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uVXBkYXRlU2NoZW1hLmpzJ1xuaW1wb3J0IHsgZ2V0Q29tcG91bmRDb21tYW5kUHJlZml4ZXNTdGF0aWMgfSBmcm9tICcuLi8uLi8uLi91dGlscy9wb3dlcnNoZWxsL3N0YXRpY1ByZWZpeC5qcydcbmltcG9ydCB7IFNlbGVjdCB9IGZyb20gJy4uLy4uL0N1c3RvbVNlbGVjdC9zZWxlY3QuanMnXG5pbXBvcnQgeyB0eXBlIFVuYXJ5RXZlbnQsIHVzZVBlcm1pc3Npb25SZXF1ZXN0TG9nZ2luZyB9IGZyb20gJy4uL2hvb2tzLmpzJ1xuaW1wb3J0IHsgUGVybWlzc2lvbkRlY2lzaW9uRGVidWdJbmZvIH0gZnJvbSAnLi4vUGVybWlzc2lvbkRlY2lzaW9uRGVidWdJbmZvLmpzJ1xuaW1wb3J0IHsgUGVybWlzc2lvbkRpYWxvZyB9IGZyb20gJy4uL1Blcm1pc3Npb25EaWFsb2cuanMnXG5pbXBvcnQge1xuICBQZXJtaXNzaW9uRXhwbGFpbmVyQ29udGVudCxcbiAgdXNlUGVybWlzc2lvbkV4cGxhaW5lclVJLFxufSBmcm9tICcuLi9QZXJtaXNzaW9uRXhwbGFuYXRpb24uanMnXG5pbXBvcnQgdHlwZSB7IFBlcm1pc3Npb25SZXF1ZXN0UHJvcHMgfSBmcm9tICcuLi9QZXJtaXNzaW9uUmVxdWVzdC5qcydcbmltcG9ydCB7IFBlcm1pc3Npb25SdWxlRXhwbGFuYXRpb24gfSBmcm9tICcuLi9QZXJtaXNzaW9uUnVsZUV4cGxhbmF0aW9uLmpzJ1xuaW1wb3J0IHsgdXNlU2hlbGxQZXJtaXNzaW9uRmVlZGJhY2sgfSBmcm9tICcuLi91c2VTaGVsbFBlcm1pc3Npb25GZWVkYmFjay5qcydcbmltcG9ydCB7IGxvZ1VuYXJ5UGVybWlzc2lvbkV2ZW50IH0gZnJvbSAnLi4vdXRpbHMuanMnXG5pbXBvcnQgeyBwb3dlcnNoZWxsVG9vbFVzZU9wdGlvbnMgfSBmcm9tICcuL3Bvd2Vyc2hlbGxUb29sVXNlT3B0aW9ucy5qcydcbiJdLCJtYXBwaW5ncyI6IiIsImlnbm9yZUxpc3QiOltdfQ==
