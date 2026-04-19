/**
 * useDebouncedDigitInput.ts — 防抖数字输入监听 Hook
 *
 * 在 Claude Code 系统流程中的位置：
 *   反馈调查组件（FeedbackSurvey / TranscriptSharePrompt / FeedbackSurveyThanks）
 *   → useDebouncedDigitInput → 监听主输入框中的数字按键 → 触发调查回调
 *
 * 主要功能：
 *   useDebouncedDigitInput：自定义 React Hook，
 *   检测用户在主输入框中输入的单个合法数字，
 *   通过 400ms 防抖避免用户键入列表（如"1. 第一项"）时误触发，
 *   确认为单独数字后从输入框中去除该字符并调用 onDigit 回调。
 *
 * 设计要点：
 *   - Latest-ref 模式：将回调函数存入 ref，避免 useEffect 依赖项变化导致防抖计时器重置
 *   - once 标志：可配置为只触发一次，防止重复回调
 *   - enabled 标志：可在调查未激活时完全禁用监听
 *   - 全角数字归一化：通过 normalizeFullWidthDigits 兼容日文/中文输入法的全角数字
 */
import { useEffect, useRef } from 'react'
import { normalizeFullWidthDigits } from '../../utils/stringUtils.js'

// 接受数字响应前的延迟时间（毫秒）：
// 防止用户输入编号列表（如"1. 第一条"）时误触发调查响应。
// 时间足够短以保证有意按键的即时体验，足够长以在用户继续输入时取消。
const DEFAULT_DEBOUNCE_MS = 400

/**
 * useDebouncedDigitInput
 *
 * 整体流程：
 *   1. 通过 callbacksRef 保存最新的 setInputValue/isValidDigit/onDigit 回调
 *      （Latest-ref 模式，防止 useEffect 因回调引用变化而频繁重新运行）
 *   2. useEffect 监听 inputValue / enabled / once / debounceMs 的变化：
 *      a. 若 enabled=false 或 once=true 且已触发过，则跳过
 *      b. 每次 inputValue 变化时，先清除上一轮防抖计时器
 *      c. 若 inputValue 与初始值不同，取最后一个字符，经全角归一化后校验是否为合法数字
 *      d. 合法则启动新的防抖计时器（debounceMs 后执行）：
 *         - 将输入框内容还原为去掉末尾数字的字符串（trimmed）
 *         - 标记 hasTriggeredRef=true（若 once=true 则阻止再次触发）
 *         - 调用 onDigit(lastChar) 上报数字选择
 *   3. useEffect 的 cleanup 函数在每次重新运行前清除未完成的计时器，防止内存泄漏
 *
 * 在系统中的角色：
 *   是调查组件（FeedbackSurveyView / TranscriptSharePrompt / FeedbackSurveyThanks）
 *   接收数字输入的统一基础设施，上层组件只需提供 isValidDigit 类型守卫和 onDigit 回调。
 */
export function useDebouncedDigitInput<T extends string = string>({
  inputValue,
  setInputValue,
  isValidDigit,
  onDigit,
  enabled = true,
  once = false,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  inputValue: string
  setInputValue: (value: string) => void
  isValidDigit: (char: string) => char is T
  onDigit: (digit: T) => void
  enabled?: boolean
  once?: boolean
  debounceMs?: number
}): void {
  // 记录 hook 首次挂载时的输入值，用于判断用户是否输入了新内容
  const initialInputValue = useRef(inputValue)
  // once 模式下的触发标志，防止 onDigit 被多次调用
  const hasTriggeredRef = useRef(false)
  // 存储当前防抖计时器 ID，用于在输入变化时取消上一轮计时
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Latest-ref 模式：将回调存入 ref 而非直接作为 useEffect 依赖项，
  // 这样调用方传入的内联函数不会触发 effect 重新运行（否则会重置防抖计时器）。
  const callbacksRef = useRef({ setInputValue, isValidDigit, onDigit })
  // 每次渲染同步更新 ref，确保计时器回调始终使用最新的回调函数
  callbacksRef.current = { setInputValue, isValidDigit, onDigit }

  useEffect(() => {
    // 若 hook 被禁用，或 once 模式下已触发过，直接退出
    if (!enabled || (once && hasTriggeredRef.current)) {
      return
    }

    // 输入值变化时，先清除上一个防抖计时器，避免旧计时器误触发
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    // 仅在输入值与初始值不同时（即用户确实输入了新字符）才处理
    if (inputValue !== initialInputValue.current) {
      // 取输入框末尾字符，并将全角数字转换为半角数字（兼容日文/中文输入法）
      const lastChar = normalizeFullWidthDigits(inputValue.slice(-1))
      // 校验末尾字符是否为调查组件认可的合法数字
      if (callbacksRef.current.isValidDigit(lastChar)) {
        // 预先计算去掉末尾数字后的输入框内容（不等待防抖结束）
        const trimmed = inputValue.slice(0, -1)
        // 启动防抖计时器：将所有依赖值作为参数传入，避免闭包捕获旧值
        debounceRef.current = setTimeout(
          (debounceRef, hasTriggeredRef, callbacksRef, trimmed, lastChar) => {
            // 计时器触发：清空计时器引用
            debounceRef.current = null
            // 标记已触发（once 模式下阻止再次触发）
            hasTriggeredRef.current = true
            // 将输入框恢复为去掉末尾数字的内容
            callbacksRef.current.setInputValue(trimmed)
            // 调用调查组件提供的数字回调，上报用户选择
            callbacksRef.current.onDigit(lastChar)
          },
          debounceMs,
          debounceRef,
          hasTriggeredRef,
          callbacksRef,
          trimmed,
          lastChar,
        )
      }
    }

    // cleanup：在 effect 下一次运行前（或组件卸载时）清除未完成的计时器，防止内存泄漏
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [inputValue, enabled, once, debounceMs])
}
