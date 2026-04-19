/**
 * DXT（Desktop Extension）工具函数模块（dxt/helpers.ts）
 *
 * 【在系统流程中的位置】
 * 该模块属于 DXT 扩展包处理子系统，被插件加载器、扩展安装流程调用。
 * 负责解析和校验 .dxt 包中的 manifest.json，以及生成全局唯一的扩展 ID。
 *
 * 【主要功能】
 * - validateManifest()：使用 McpbManifestSchema（zod）校验 manifest JSON 对象
 * - parseAndValidateManifestFromText()：从 JSON 文本字符串解析并校验 manifest
 * - parseAndValidateManifestFromBytes()：从二进制数据（Uint8Array）解析并校验 manifest
 * - generateExtensionId()：根据作者名和扩展名生成规范化的扩展 ID 字符串
 *
 * 【延迟导入说明】
 * @anthropic-ai/mcpb 使用 zod v3，初始化时会生成约 300 个 .bind(this) 闭包
 * （对应约 700KB 堆内存）。使用动态 import() 延迟加载，避免影响启动性能。
 */
import type { McpbManifest } from '@anthropic-ai/mcpb'
import { errorMessage } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

/**
 * 使用 McpbManifestSchema 校验 manifest JSON 对象。
 *
 * 【流程说明】
 * 1. 动态 import @anthropic-ai/mcpb 以避免启动时的堆内存开销
 *    （zod v3 在每个 schema 实例初始化时会创建约 24 个 .bind(this) 闭包，
 *    schemas.js + schemas-loose.js 共约 300 个实例，合计约 700KB）
 * 2. 使用 safeParse 进行非抛出式校验，失败时收集字段错误和全局错误
 * 3. 校验失败时将所有错误拼接为可读字符串并抛出 Error
 * 4. 校验通过时返回已类型化的 McpbManifest 对象
 *
 * @param manifestJson  待校验的 JSON 对象（通常来自 JSON.parse 或 jsonParse）
 * @returns             校验通过的 McpbManifest 对象
 * @throws              校验失败时抛出包含详细错误信息的 Error
 */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  // 延迟导入 mcpb，避免将约 700KB 的 zod 闭包加入启动堆
  const { McpbManifestSchema } = await import('@anthropic-ai/mcpb')
  // 使用 safeParse 进行非抛出式校验
  const parseResult = McpbManifestSchema.safeParse(manifestJson)

  if (!parseResult.success) {
    // 收集字段级错误（格式：字段名: 错误列表）和全局表单级错误
    const errors = parseResult.error.flatten()
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) => `${field}: ${errs?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    // 将所有错误拼接后抛出，便于调用方显示给用户
    throw new Error(`Invalid manifest: ${errorMessages}`)
  }

  // 返回校验通过且类型安全的 manifest 对象
  return parseResult.data
}

/**
 * 从 JSON 文本字符串解析并校验 DXT manifest。
 *
 * 【流程说明】
 * 1. 使用 jsonParse 将文本解析为 JSON 对象（解析失败抛出含原始错误的 Error）
 * 2. 调用 validateManifest() 对解析结果进行 schema 校验
 *
 * @param manifestText  manifest.json 的原始文本内容
 * @returns             校验通过的 McpbManifest 对象
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown

  try {
    // 解析 JSON 文本，失败时包装错误信息后重新抛出
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }

  // 对解析后的 JSON 对象进行 schema 校验
  return validateManifest(manifestJson)
}

/**
 * 从二进制数据（Uint8Array）解析并校验 DXT manifest。
 *
 * 【流程说明】
 * 1. 使用 TextDecoder 将二进制字节转换为 UTF-8 字符串
 * 2. 委托 parseAndValidateManifestFromText() 完成后续解析和校验
 *
 * @param manifestData  manifest.json 的原始二进制内容（来自 ZIP 解压结果）
 * @returns             校验通过的 McpbManifest 对象
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  // 将二进制数据解码为 UTF-8 字符串
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}

/**
 * 根据 manifest 中的作者名和扩展名生成规范化的扩展 ID。
 *
 * 【流程说明】
 * 1. 定义 sanitize 函数：转小写、空格替换为连字符、移除非法字符、合并多个连字符、去除首尾连字符
 * 2. 分别对 manifest.author.name 和 manifest.name 进行规范化
 * 3. 有 prefix 时格式为 `{prefix}.{author}.{name}`，否则为 `{author}.{name}`
 * 4. 算法与目录后端（directory backend）保持一致，确保 ID 全局唯一且可预测
 *
 * @param manifest  已校验的 DXT manifest 对象
 * @param prefix    可选前缀，'local.unpacked' 表示未打包扩展，'local.dxt' 表示 .dxt 文件安装
 * @returns         规范化的扩展 ID 字符串
 */
export function generateExtensionId(
  manifest: McpbManifest,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  // 规范化函数：转小写 → 空格→连字符 → 移除非法字符 → 合并连字符 → 去首尾连字符
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  const authorName = manifest.author.name
  const extensionName = manifest.name

  // 对作者名和扩展名分别进行规范化处理
  const sanitizedAuthor = sanitize(authorName)
  const sanitizedName = sanitize(extensionName)

  // 有前缀时生成三段式 ID，否则生成两段式 ID
  return prefix
    ? `${prefix}.${sanitizedAuthor}.${sanitizedName}`
    : `${sanitizedAuthor}.${sanitizedName}`
}
