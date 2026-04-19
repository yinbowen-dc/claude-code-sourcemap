/**
 * BashPermissionRequest/bashToolUseOptions.tsx
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件属于 Bash 工具权限请求流程的选项构建层。当 Claude 需要执行 Bash 命令时，
 * 权限系统会向用户弹出确认对话框，本文件负责构建该对话框中所有可选的用户操作按钮
 * （"是"/"是，始终允许"/"否"等），并根据当前模式、分类器状态、权限建议动态组合选项列表。
 *
 * 【主要功能】
 * - 定义 BashToolUseOption 类型（所有可能的用户选择值）
 * - 提供辅助函数 descriptionAlreadyExists / stripBashRedirections
 * - 导出核心函数 bashToolUseOptions，根据入参动态生成选项数组
 */

import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js';
import { extractOutputRedirections } from '../../../utils/bash/commands.js';
import { isClassifierPermissionsEnabled } from '../../../utils/permissions/bashClassifier.js';
import type { PermissionDecisionReason } from '../../../utils/permissions/PermissionResult.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js';

// 用户在 Bash 权限对话框中可以选择的操作值类型
export type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'yes-classifier-reviewed' | 'no';

/**
 * 检查某个描述是否已存在于允许列表中。
 * 比较时忽略大小写并去除末尾空白，避免重复添加相同描述。
 */
function descriptionAlreadyExists(description: string, existingDescriptions: string[]): boolean {
  // 将目标描述规范化：转小写并去末尾空白
  const normalized = description.toLowerCase().trimEnd();
  // 逐一与已有描述对比（同样规范化后比较）
  return existingDescriptions.some(existing => existing.toLowerCase().trimEnd() === normalized);
}

/**
 * 去除 Bash 命令中的输出重定向部分，使标签只展示实际命令名，不包含文件路径。
 * 仅在存在重定向时才使用剥离版本，否则原样返回。
 */
function stripBashRedirections(command: string): string {
  const {
    commandWithoutRedirections, // 去掉重定向后的命令
    redirections                // 提取出的重定向列表
  } = extractOutputRedirections(command);
  // 只有存在重定向时才使用剥离版本，否则返回原始命令
  return redirections.length > 0 ? commandWithoutRedirections : command;
}

/**
 * 根据当前权限状态、用户输入模式、AI 分类器建议等动态构建 Bash 权限对话框的选项列表。
 *
 * 【整体流程】
 * 1. 根据 yesInputMode 决定"是"选项是普通按钮还是带文本输入框的选项
 * 2. 若未被 allowManagedPermissionRulesOnly 限制，则追加"始终允许"相关选项：
 *    a. 若存在可编辑前缀（editablePrefix）且建议中无非 Bash 条目，则展示可编辑前缀输入框
 *    b. 否则若有 AI 生成的建议，则展示生成的建议标签选项
 *    c. 若 ANT 内部构建且分类器已启用，额外提供分类器描述输入框选项
 * 3. 根据 noInputMode 决定"否"选项是普通按钮还是带文本输入框的选项
 */
export function bashToolUseOptions({
  suggestions = [],          // AI 生成的权限规则建议列表
  decisionReason,            // 当前权限决策原因（用于判断是否跳过分类器选项）
  onRejectFeedbackChange,    // 用户输入"否"反馈时的回调
  onAcceptFeedbackChange,    // 用户输入"是"反馈时的回调
  onClassifierDescriptionChange, // 用户编辑分类器描述时的回调
  classifierDescription,         // 分类器预填的描述文本
  initialClassifierDescriptionEmpty = false, // 初始分类器描述是否为空（为空时隐藏该选项）
  existingAllowDescriptions = [], // 已存在的允许描述列表（用于去重）
  yesInputMode = false,      // "是"选项是否以文本输入框形式呈现
  noInputMode = false,       // "否"选项是否以文本输入框形式呈现
  editablePrefix,            // 可编辑的命令前缀规则（如 "npm run:*"）
  onEditablePrefixChange     // 用户编辑前缀时的回调
}: {
  suggestions?: PermissionUpdate[];
  decisionReason?: PermissionDecisionReason;
  onRejectFeedbackChange: (value: string) => void;
  onAcceptFeedbackChange: (value: string) => void;
  onClassifierDescriptionChange?: (value: string) => void;
  classifierDescription?: string;
  /** Whether the initial classifier description was empty. When true, hides the option. */
  initialClassifierDescriptionEmpty?: boolean;
  existingAllowDescriptions?: string[];
  yesInputMode?: boolean;
  noInputMode?: boolean;
  /** Editable prefix rule content (e.g., "npm run:*"). When set, replaces Haiku-based suggestions. */
  editablePrefix?: string;
  /** Callback when the user edits the prefix value. */
  onEditablePrefixChange?: (value: string) => void;
}): OptionWithDescription<BashToolUseOption>[] {
  // 最终返回的选项数组，按顺序追加各个选项
  const options: OptionWithDescription<BashToolUseOption>[] = [];

  // ── "是" 选项 ──────────────────────────────────────────────────────────────
  if (yesInputMode) {
    // 输入模式：显示带有文本输入框的"是"选项，用户可附加说明
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell Claude what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true // 空输入可取消此模式
    });
  } else {
    // 普通模式：简单的"是"按钮
    options.push({
      label: 'Yes',
      value: 'yes'
    });
  }

  // ── "始终允许" 相关选项（受全局配置控制） ──────────────────────────────────
  // 只有在未被 allowManagedPermissionRulesOnly 限制时才显示这些选项
  if (shouldShowAlwaysAllowOptions()) {
    // 检查建议列表中是否包含非 Bash 工具的条目（如 addDirectories 或 Read 规则）
    // 若存在，则可编辑前缀无法表示这些规则，需回退到普通建议标签模式
    const hasNonBashSuggestions = suggestions.some(s => s.type === 'addDirectories' || s.type === 'addRules' && s.rules?.some(r => r.toolName !== BASH_TOOL_NAME));

    if (editablePrefix !== undefined && onEditablePrefixChange && !hasNonBashSuggestions && suggestions.length > 0) {
      // 优先展示可编辑前缀输入框，让用户直接修改 AI 建议的命令前缀规则
      options.push({
        type: 'input',
        label: 'Yes, and don\u2019t ask again for',
        value: 'yes-prefix-edited',
        placeholder: 'command prefix (e.g., npm run:*)',
        initialValue: editablePrefix,        // 预填 AI 建议的前缀
        onChange: onEditablePrefixChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,            // 同时展示标签和当前值
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true            // 每次值更新后重置光标位置
      });
    } else if (suggestions.length > 0) {
      // 没有可编辑前缀时，使用 AI 生成的建议标签（由 generateShellSuggestionsLabel 构建）
      const label = generateShellSuggestionsLabel(suggestions, BASH_TOOL_NAME, stripBashRedirections);
      if (label) {
        options.push({
          label,
          value: 'yes-apply-suggestions' // 用户选择后会应用 AI 建议的规则
        });
      }
    }

    // ── 分类器审查选项（仅限 ANT 内部构建） ─────────────────────────────────
    // 满足以下所有条件时才显示：
    //   1. 当前为 ANT 内部构建（"external" === 'ant' 在外部构建中永远为 false）
    //   2. 可编辑前缀选项未展示（两者功能重叠，同时显示会造成混淆）
    //   3. 分类器权限已启用
    //   4. 初始描述非空（空描述无需显示）
    //   5. 描述不与已有允许列表重复
    //   6. 决策原因不是服务端分类器触发（服务端分类器触发时，规则添加无效）
    const editablePrefixShown = options.some(o => o.value === 'yes-prefix-edited');
    if ("external" === 'ant' && !editablePrefixShown && isClassifierPermissionsEnabled() && onClassifierDescriptionChange && !initialClassifierDescriptionEmpty && !descriptionAlreadyExists(classifierDescription ?? '', existingAllowDescriptions) && decisionReason?.type !== 'classifier') {
      options.push({
        type: 'input',
        label: 'Yes, and don\u2019t ask again for',
        value: 'yes-classifier-reviewed',
        placeholder: 'describe what to allow...',
        initialValue: classifierDescription ?? '', // 预填分类器描述
        onChange: onClassifierDescriptionChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true
      });
    }
  }

  // ── "否" 选项 ──────────────────────────────────────────────────────────────
  if (noInputMode) {
    // 输入模式：显示带有文本输入框的"否"选项，用户可说明希望 Claude 改变的行为
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell Claude what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true
    });
  } else {
    // 普通模式：简单的"否"按钮
    options.push({
      label: 'No',
      value: 'no'
    });
  }

  return options;
}
