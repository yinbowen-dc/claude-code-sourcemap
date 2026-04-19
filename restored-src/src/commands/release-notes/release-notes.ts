/**
 * release-notes/release-notes.ts —— 发布说明获取与格式化实现
 *
 * 在整体流程中的位置：
 *   /release-notes 命令触发 → 懒加载本模块 → 调用 call()
 *   → 尝试在线拉取最新 changelog → 格式化为可读文本 → 返回给命令框架渲染
 *
 * 核心策略（三级降级）：
 *   1. 以 500ms 为超时，并行竞速拉取最新在线 changelog 与超时计时器；
 *      若在超时内拉取成功，使用最新数据。
 *   2. 超时或网络失败时，读取本地磁盘缓存（上次成功拉取后存储）。
 *   3. 缓存也不可用时，输出 changelog 网页链接作为最终兜底。
 *
 * 这样的设计保证了命令响应速度（不阻塞等待网络）的同时，尽可能展示最新内容。
 */
import type { LocalCommandResult } from '../../types/command.js'
import {
  CHANGELOG_URL,
  fetchAndStoreChangelog,
  getAllReleaseNotes,
  getStoredChangelog,
} from '../../utils/releaseNotes.js'

/**
 * formatReleaseNotes —— 将版本号与更新条目数组转换为可读的纯文本字符串
 *
 * 输入格式：[['1.2.3', ['修复 xxx', '新增 yyy']], ...]
 * 输出格式：
 *   Version 1.2.3:
 *   · 修复 xxx
 *   · 新增 yyy
 *
 * @param notes  版本条目数组，每项为 [版本号, 更新说明列表]
 * @returns       格式化后的多行字符串，版本块间以空行分隔
 */
function formatReleaseNotes(notes: Array<[string, string[]]>): string {
  return notes
    .map(([version, notes]) => {
      const header = `Version ${version}:`           // 版本标题行
      const bulletPoints = notes.map(note => `· ${note}`).join('\n') // 每条更新以 · 开头
      return `${header}\n${bulletPoints}`
    })
    .join('\n\n') // 版本块之间空一行以提高可读性
}

/**
 * call —— /release-notes 命令的核心执行函数
 *
 * 流程：
 *   1. 创建 500ms 超时 Promise，与 fetchAndStoreChangelog() 竞速
 *   2. 若在线拉取成功（未超时），读取 freshNotes 直接使用
 *   3. 否则 catch 块静默处理超时/网络错误，继续执行
 *   4. freshNotes 为空时再尝试读取本地磁盘缓存 cachedNotes
 *   5. 两者均无数据时，返回 changelog 网页地址作为兜底
 *
 * @returns LocalCommandResult  type: 'text' + 格式化后的版本说明文本
 */
export async function call(): Promise<LocalCommandResult> {
  // Try to fetch the latest changelog with a 500ms timeout
  // 尝试在 500ms 内从网络拉取最新 changelog
  let freshNotes: Array<[string, string[]]> = []

  try {
    // 超时 Promise：500ms 后 reject，与网络请求竞速
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => rej(new Error('Timeout')), 500, reject)
    })

    // Promise.race：网络请求与超时谁先完成就用谁的结果
    await Promise.race([fetchAndStoreChangelog(), timeoutPromise])
    // 到达此处说明网络请求在超时前完成，读取刚存储的数据
    freshNotes = getAllReleaseNotes(await getStoredChangelog())
  } catch {
    // Either fetch failed or timed out - just use cached notes
    // 超时或网络失败：静默降级，不影响后续逻辑
  }

  // If we have fresh notes from the quick fetch, use those
  // 第一优先级：刚从网络拉取的最新数据
  if (freshNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(freshNotes) }
  }

  // Otherwise check cached notes
  // 第二优先级：本地磁盘缓存（上次网络请求成功后保存的版本）
  const cachedNotes = getAllReleaseNotes(await getStoredChangelog())
  if (cachedNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(cachedNotes) }
  }

  // Nothing available, show link
  // 最终兜底：在线和缓存均无数据，返回 changelog 网页链接
  return {
    type: 'text',
    value: `See the full changelog at: ${CHANGELOG_URL}`,
  }
}
