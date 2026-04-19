/**
 * MCP服务器重连辅助工具模块
 *
 * 在Claude Code系统中的位置：
 * 本文件位于MCP（Model Context Protocol）服务器管理的工具层，
 * 为上层的MCP服务器连接管理组件提供重连结果处理的纯函数。
 *
 * 主要功能：
 * - 将服务器重连操作的结果（connected/needs-auth/failed）统一转换为用户可读的消息对象
 * - 将重连过程中抛出的异常统一格式化为错误字符串
 *
 * 上游：MCPServerConnectView 或其他发起重连操作的组件
 * 下游：调用方使用返回的 ReconnectResult.message 向用户展示状态信息
 */

import type { Command } from '../../../commands.js';
import type { MCPServerConnection, ServerResource } from '../../../services/mcp/types.js';
import type { Tool } from '../../../Tool.js';

// 重连操作的返回结果接口：包含展示给用户的消息和是否成功的布尔标志
export interface ReconnectResult {
  message: string;
  success: boolean;
}

/**
 * 处理MCP服务器重连操作的结果，返回统一的用户提示信息
 *
 * 流程：
 * 1. 接收重连操作完成后的result对象（含client连接状态）和服务器名称
 * 2. 根据 result.client.type 的值进行分支处理：
 *    - 'connected'：连接成功，返回成功提示
 *    - 'needs-auth'：服务器要求认证，提示用户使用认证选项
 *    - 'failed'：连接失败，返回失败提示
 *    - 其他：返回未知结果提示（防御性兜底）
 * 3. 每个分支均返回 { message, success } 结构的 ReconnectResult
 *
 * @param result  重连操作结果对象，包含client连接状态、已加载的tools/commands/resources
 * @param serverName  服务器名称，用于插入到提示消息中
 * @returns ReconnectResult  包含用户提示消息和成功状态
 */
export function handleReconnectResult(result: {
  client: MCPServerConnection;
  tools: Tool[];
  commands: Command[];
  resources?: ServerResource[];
}, serverName: string): ReconnectResult {
  switch (result.client.type) {
    case 'connected':
      // 重连成功
      return {
        message: `Reconnected to ${serverName}.`,
        success: true
      };
    case 'needs-auth':
      // 服务器需要认证，提示用户通过认证入口操作
      return {
        message: `${serverName} requires authentication. Use the 'Authenticate' option.`,
        success: false
      };
    case 'failed':
      // 重连失败
      return {
        message: `Failed to reconnect to ${serverName}.`,
        success: false
      };
    default:
      // 未知状态兜底
      return {
        message: `Unknown result when reconnecting to ${serverName}.`,
        success: false
      };
  }
}

/**
 * 处理重连过程中抛出的异常，将其格式化为用户可读的错误字符串
 *
 * 流程：
 * 1. 判断 error 是否为 Error 实例：是则取 .message 属性，否则用 String() 转换
 * 2. 拼接服务器名称和错误消息，返回完整的错误提示字符串
 *
 * @param error  捕获到的异常（unknown类型，需做类型判断）
 * @param serverName  发生错误的服务器名称
 * @returns string  格式化后的错误提示
 */
export function handleReconnectError(error: unknown, serverName: string): string {
  // 安全地将 error 转为字符串：Error实例取.message，其余直接String()转换
  const errorMessage = error instanceof Error ? error.message : String(error);
  return `Error reconnecting to ${serverName}: ${errorMessage}`;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJDb21tYW5kIiwiTUNQU2VydmVyQ29ubmVjdGlvbiIsIlNlcnZlclJlc291cmNlIiwiVG9vbCIsIlJlY29ubmVjdFJlc3VsdCIsIm1lc3NhZ2UiLCJzdWNjZXNzIiwiaGFuZGxlUmVjb25uZWN0UmVzdWx0IiwicmVzdWx0IiwiY2xpZW50IiwidG9vbHMiLCJjb21tYW5kcyIsInJlc291cmNlcyIsInNlcnZlck5hbWUiLCJ0eXBlIiwiaGFuZGxlUmVjb25uZWN0RXJyb3IiLCJlcnJvciIsImVycm9yTWVzc2FnZSIsIkVycm9yIiwiU3RyaW5nIl0sInNvdXJjZXMiOlsicmVjb25uZWN0SGVscGVycy50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb21tYW5kIH0gZnJvbSAnLi4vLi4vLi4vY29tbWFuZHMuanMnXG5pbXBvcnQgdHlwZSB7XG4gIE1DUFNlcnZlckNvbm5lY3Rpb24sXG4gIFNlcnZlclJlc291cmNlLFxufSBmcm9tICcuLi8uLi8uLi9zZXJ2aWNlcy9tY3AvdHlwZXMuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2wgfSBmcm9tICcuLi8uLi8uLi9Ub29sLmpzJ1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlY29ubmVjdFJlc3VsdCB7XG4gIG1lc3NhZ2U6IHN0cmluZ1xuICBzdWNjZXNzOiBib29sZWFuXG59XG5cbi8qKlxuICogSGFuZGxlcyB0aGUgcmVzdWx0IG9mIGEgcmVjb25uZWN0IGF0dGVtcHQgYW5kIHJldHVybnMgYW4gYXBwcm9wcmlhdGUgdXNlciBtZXNzYWdlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVSZWNvbm5lY3RSZXN1bHQoXG4gIHJlc3VsdDoge1xuICAgIGNsaWVudDogTUNQU2VydmVyQ29ubmVjdGlvblxuICAgIHRvb2xzOiBUb29sW11cbiAgICBjb21tYW5kczogQ29tbWFuZFtdXG4gICAgcmVzb3VyY2VzPzogU2VydmVyUmVzb3VyY2VbXVxuICB9LFxuICBzZXJ2ZXJOYW1lOiBzdHJpbmcsXG4pOiBSZWNvbm5lY3RSZXN1bHQge1xuICBzd2l0Y2ggKHJlc3VsdC5jbGllbnQudHlwZSkge1xuICAgIGNhc2UgJ2Nvbm5lY3RlZCc6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBtZXNzYWdlOiBgUmVjb25uZWN0ZWQgdG8gJHtzZXJ2ZXJOYW1lfS5gLFxuICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgfVxuXG4gICAgY2FzZSAnbmVlZHMtYXV0aCc6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBtZXNzYWdlOiBgJHtzZXJ2ZXJOYW1lfSByZXF1aXJlcyBhdXRoZW50aWNhdGlvbi4gVXNlIHRoZSAnQXV0aGVudGljYXRlJyBvcHRpb24uYCxcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICB9XG5cbiAgICBjYXNlICdmYWlsZWQnOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbWVzc2FnZTogYEZhaWxlZCB0byByZWNvbm5lY3QgdG8gJHtzZXJ2ZXJOYW1lfS5gLFxuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIH1cblxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBtZXNzYWdlOiBgVW5rbm93biByZXN1bHQgd2hlbiByZWNvbm5lY3RpbmcgdG8gJHtzZXJ2ZXJOYW1lfS5gLFxuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIEhhbmRsZXMgZXJyb3JzIGZyb20gcmVjb25uZWN0IGF0dGVtcHRzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVSZWNvbm5lY3RFcnJvcihcbiAgZXJyb3I6IHVua25vd24sXG4gIHNlcnZlck5hbWU6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICByZXR1cm4gYEVycm9yIHJlY29ubmVjdGluZyB0byAke3NlcnZlck5hbWV9OiAke2Vycm9yTWVzc2FnZX1gXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLGNBQWNBLE9BQU8sUUFBUSxzQkFBc0I7QUFDbkQsY0FDRUMsbUJBQW1CLEVBQ25CQyxjQUFjLFFBQ1QsZ0NBQWdDO0FBQ3ZDLGNBQWNDLElBQUksUUFBUSxrQkFBa0I7QUFFNUMsT0FBTyxVQUFVQyxlQUFlLENBQUM7RUFDL0JDLE9BQU8sRUFBRSxNQUFNO0VBQ2ZDLE9BQU8sRUFBRSxPQUFPO0FBQ2xCOztBQUVBO0FBQ0E7QUFDQTtBQUNBLE9BQU8sU0FBU0MscUJBQXFCQSxDQUNuQ0MsTUFBTSxFQUFFO0VBQ05DLE1BQU0sRUFBRVIsbUJBQW1CO0VBQzNCUyxLQUFLLEVBQUVQLElBQUksRUFBRTtFQUNiUSxRQUFRLEVBQUVYLE9BQU8sRUFBRTtFQUNuQlksU0FBUyxDQUFDLEVBQUVWLGNBQWMsRUFBRTtBQUM5QixDQUFDLEVBQ0RXLFVBQVUsRUFBRSxNQUFNLENBQ25CLEVBQUVULGVBQWUsQ0FBQztFQUNqQixRQUFRSSxNQUFNLENBQUNDLE1BQU0sQ0FBQ0ssSUFBSTtJQUN4QixLQUFLLFdBQVc7TUFDZCxPQUFPO1FBQ0xULE9BQU8sRUFBRSxrQkFBa0JRLFVBQVUsR0FBRztRQUN4Q1AsT0FBTyxFQUFFO01BQ1gsQ0FBQztJQUVILEtBQUssWUFBWTtNQUNmLE9BQU87UUFDTEQsT0FBTyxFQUFFLEdBQUdRLFVBQVUsMERBQTBEO1FBQ2hGUCxPQUFPLEVBQUU7TUFDWCxDQUFDO0lBRUgsS0FBSyxRQUFRO01BQ1gsT0FBTztRQUNMRCxPQUFPLEVBQUUsMEJBQTBCUSxVQUFVLEdBQUc7UUFDaERQLE9BQU8sRUFBRTtNQUNYLENBQUM7SUFFSDtNQUNFLE9BQU87UUFDTEQsT0FBTyxFQUFFLHVDQUF1Q1EsVUFBVSxHQUFHO1FBQzdEUCxPQUFPLEVBQUU7TUFDWCxDQUFDO0VBQ0w7QUFDRjs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLFNBQVNTLG9CQUFvQkEsQ0FDbENDLEtBQUssRUFBRSxPQUFPLEVBQ2RILFVBQVUsRUFBRSxNQUFNLENBQ25CLEVBQUUsTUFBTSxDQUFDO0VBQ1IsTUFBTUksWUFBWSxHQUFHRCxLQUFLIFlBQVlFLEtBQUssR0FBR0YsS0FBSyxDQUFDWCxPQUFPLEdBQUdjLE1BQU0sQ0FBQ0gsS0FBSyxDQUFDO0VBQzNFLE9BQU8seUJBQXlCSCxVQUFVLEtBQUtJLFlBQVksRUFBRTtBQUMvRCIsImlnbm9yZUxpc3QiOltdfQ==
