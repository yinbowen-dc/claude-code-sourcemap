/**
 * 控制消息键名兼容性模块。
 *
 * 在 Claude Code 系统中，该模块提供向下兼容处理：
 * 将控制消息（control_request / control_response）中的驼峰式 `requestId`
 * 规范化为下划线式 `request_id`，以兼容未正确实现 Swift CodingKeys 的旧版 iOS 客户端。
 * - normalizeControlMessageKeys()：原地修改消息对象的键名
 */
/**
 * 将控制消息中的驼峰式 `requestId` 规范化为下划线式 `request_id`。
 *
 * 兼容性背景：旧版 iOS 客户端（Swift 端 CodingKeys 未正确实现）发送 camelCase 键名，
 * 而服务端和新版客户端使用 snake_case。此函数对入站消息做原地（in-place）修正，
 * 处理顶层字段和嵌套 `response` 对象两处 requestId。
 *
 * 仅在键存在且目标键不存在时才转换，避免覆盖正常的 snake_case 字段。
 */
export function normalizeControlMessageKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  const record = obj as Record<string, unknown>
  // 顶层 requestId → request_id（仅在 request_id 不存在时转换）
  if ('requestId' in record && !('request_id' in record)) {
    record.request_id = record.requestId
    delete record.requestId
  }
  // 嵌套 response.requestId → response.request_id
  if (
    'response' in record &&
    record.response !== null &&
    typeof record.response === 'object'
  ) {
    const response = record.response as Record<string, unknown>
    if ('requestId' in response && !('request_id' in response)) {
      response.request_id = response.requestId
      delete response.requestId
    }
  }
  return obj
}
