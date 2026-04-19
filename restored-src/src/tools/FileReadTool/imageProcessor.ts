/**
 * imageProcessor.ts — 图片处理器模块加载器
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件位于 FileReadTool 目录下，作为图片处理底层库（sharp / image-processor-napi）
 * 的统一加载入口。FileReadTool 和 imageResizer 工具函数通过本文件获取图片处理能力。
 *
 * 【主要功能】
 * - 在打包模式（bundled mode）下优先加载原生 image-processor-napi 模块
 * - 非打包模式或原生模块不可用时回退到 sharp
 * - 提供 getImageProcessor()（处理已有图片）和 getImageCreator()（从头创建图片）两个入口
 * - 单例模式缓存已加载的模块，避免重复动态 import
 * - 统一处理 ESM / CJS 两种模块导出格式（unwrapDefault）
 */

import type { Buffer } from 'buffer'
import { isInBundledMode } from '../../utils/bundledMode.js'

/**
 * Sharp 实例接口（处理图片的链式 API）。
 * 定义了 metadata、resize、jpeg、png、webp、toBuffer 等核心操作。
 */
export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

/** Sharp 构造函数类型：接收 Buffer，返回 SharpInstance（处理已有图片） */
export type SharpFunction = (input: Buffer) => SharpInstance

/** 用于从头创建图片的选项（指定宽高、通道数和背景色） */
type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

/** Sharp 创建函数类型：接收创建选项，返回 SharpInstance（从头生成图片） */
type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

// 单例缓存：避免每次调用时重复动态 import
let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

/**
 * 获取图片处理函数（用于处理已有图片 Buffer）。
 *
 * 加载策略：
 * 1. 若已缓存则直接返回（单例）
 * 2. 打包模式下优先加载 image-processor-napi（原生 NAPI 模块，性能更佳）
 * 3. 原生模块不可用时回退到 sharp
 * 4. 非打包模式直接使用 sharp
 *
 * @returns 图片处理构造函数
 */
export async function getImageProcessor(): Promise<SharpFunction> {
  // 单例检查：若已加载则直接返回缓存的模块
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // 打包模式：尝试加载原生图片处理模块
    try {
      // 使用原生 NAPI 图片处理模块（性能优于 sharp）
      const imageProcessor = await import('image-processor-napi')
      const sharp = imageProcessor.sharp || imageProcessor.default
      imageProcessorModule = { default: sharp }
      return sharp
    } catch {
      // 原生模块不可用，回退到 sharp
      // biome-ignore lint/suspicious/noConsole: intentional warning
      console.warn(
        'Native image processor not available, falling back to sharp',
      )
    }
  }

  // 非打包模式或作为回退：使用 sharp
  // 单次结构类型转换：SharpFunction 是 sharp 实际类型的子集
  const imported = (await import(
    'sharp'
  )) as unknown as MaybeDefault<SharpFunction>
  const sharp = unwrapDefault(imported)
  imageProcessorModule = { default: sharp }
  return sharp
}

/**
 * 获取图片创建函数（用于从头生成新图片）。
 *
 * 注意：image-processor-napi 不支持图片创建，
 * 因此此函数始终直接使用 sharp，不经过原生模块。
 *
 * @returns 图片创建构造函数
 */
export async function getImageCreator(): Promise<SharpCreator> {
  // 单例检查：若已加载则直接返回缓存的模块
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  // 始终使用 sharp（image-processor-napi 不支持 create 操作）
  const imported = (await import(
    'sharp'
  )) as unknown as MaybeDefault<SharpCreator>
  const sharp = unwrapDefault(imported)
  imageCreatorModule = { default: sharp }
  return sharp
}

// 动态 import 的导出形状因模块互操作模式而异：
// ESM 模式产出 { default: fn }，CJS 模式直接产出 fn
type MaybeDefault<T> = T | { default: T }

/**
 * 解包模块默认导出。
 * 若模块本身是函数（CJS 直接导出），则直接返回；
 * 若模块是 { default: fn }（ESM 格式），则提取 .default。
 *
 * @param mod - 动态 import 返回的模块对象
 * @returns 实际的工厂函数
 */
function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
