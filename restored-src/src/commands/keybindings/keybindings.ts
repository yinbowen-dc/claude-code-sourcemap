/**
 * keybindings 命令实现模块
 *
 * 在 Claude Code 命令体系中，本文件实现 `/keybindings` 命令的核心逻辑。
 * 该命令用于打开或创建用户的键位绑定配置文件，让用户在外部编辑器中自定义快捷键。
 *
 * 执行流程：
 * 1. 检查键位绑定自定义特性是否已开启（预览功能门控）
 * 2. 获取配置文件路径（`getKeybindingsPath()`）
 * 3. 若文件不存在，用 `wx` 排他创建标志写入模板内容（避免 TOCTOU 竞态）
 * 4. 若文件已存在（EEXIST 错误），跳过写入直接打开
 * 5. 调用 `editFileInEditor()` 在用户配置的外部编辑器中打开文件
 * 6. 根据是否为新建文件以及编辑器打开结果，返回相应提示文本
 */
import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  getKeybindingsPath,
  isKeybindingCustomizationEnabled,
} from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import { getErrnoCode } from '../../utils/errors.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

/**
 * `/keybindings` 命令的执行入口
 *
 * 流程：
 * 1. 检查键位绑定自定义特性是否已启用，若未启用则立即返回提示
 * 2. 获取键位绑定配置文件的绝对路径
 * 3. 确保配置文件所在目录存在（递归创建）
 * 4. 用 `wx` 排他写入标志尝试创建配置文件并写入模板：
 *    - 成功：文件新建完成
 *    - EEXIST 错误：文件已存在，标记 fileExists = true，跳过写入
 *    - 其他错误：向上抛出
 * 5. 调用 editFileInEditor 在外部编辑器中打开文件
 * 6. 根据 fileExists 和编辑器打开结果，构造并返回用户提示文案
 *
 * @returns 包含操作结果描述的文本命令结果
 */
export async function call(): Promise<{ type: 'text'; value: string }> {
  // 键位绑定自定义为预览功能，未开启时直接返回提示
  if (!isKeybindingCustomizationEnabled()) {
    return {
      type: 'text',
      value:
        'Keybinding customization is not enabled. This feature is currently in preview.',
    }
  }

  // 获取键位绑定配置文件的绝对路径（通常为 ~/.claude/keybindings.json）
  const keybindingsPath = getKeybindingsPath()

  // Write template with 'wx' flag (exclusive create) — fails with EEXIST if
  // the file already exists. Avoids a stat pre-check (TOCTOU race + extra syscall).
  // fileExists 标记配置文件是否已存在，用于后续返回不同的提示文案
  let fileExists = false
  // 确保配置文件所在目录存在（递归创建，幂等操作）
  await mkdir(dirname(keybindingsPath), { recursive: true })
  try {
    // 使用 'wx' 排他创建标志写入模板：若文件不存在则新建，若已存在则抛出 EEXIST
    // 避免了"先 stat 再写入"的 TOCTOU 竞态条件，同时减少一次系统调用
    await writeFile(keybindingsPath, generateKeybindingsTemplate(), {
      encoding: 'utf-8',
      flag: 'wx',
    })
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      // 文件已存在，标记为 true，后续跳过写入直接打开
      fileExists = true
    } else {
      // 其他 I/O 错误（如权限不足等），向上抛出
      throw e
    }
  }

  // Open in editor
  // 在用户配置的外部编辑器中打开键位绑定配置文件
  const result = await editFileInEditor(keybindingsPath)
  if (result.error) {
    // 编辑器打开失败，返回带有文件路径和错误信息的提示文案
    return {
      type: 'text',
      value: `${fileExists ? 'Opened' : 'Created'} ${keybindingsPath}. Could not open in editor: ${result.error}`,
    }
  }
  // 编辑器打开成功，根据是新建还是已有文件，返回相应的成功提示
  return {
    type: 'text',
    value: fileExists
      ? `Opened ${keybindingsPath} in your editor.`
      : `Created ${keybindingsPath} with template. Opened in your editor.`,
  }
}
