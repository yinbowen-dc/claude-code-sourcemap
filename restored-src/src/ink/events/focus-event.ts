/**
 * 焦点变化事件类（Focus Change Event）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，专门处理组件焦点的转移事件。
 * 当 FocusManager 的 focus() 或 blur() 方法被调用时，
 * 会创建 FocusEvent 实例并通过 Dispatcher 进行捕获/冒泡分发，
 * 触发组件上注册的 onFocus / onBlur 处理器。
 *
 * 【事件传播模型】
 * - 'focus' 事件：在目标元素获得焦点时触发，relatedTarget 为之前获得焦点的元素
 * - 'blur' 事件：在目标元素失去焦点时触发，relatedTarget 为即将获得焦点的元素
 * - 两种事件均向上冒泡（bubbles=true），镜像 react-dom 使用 focusin/focusout
 *   语义的做法，使父组件可以观察后代节点的焦点变化。
 */
import { type EventTarget, TerminalEvent } from './terminal-event.js'

/**
 * 组件焦点变化事件。
 *
 * 在焦点在元素间移动时触发。
 * 'focus' 事件在新获得焦点的元素上触发；
 * 'blur' 事件在之前获得焦点的元素上触发。
 * 两者均向上冒泡，与 react-dom 使用 focusin/focusout 语义保持一致，
 * 使父组件可以观察后代节点的焦点变化。
 */
export class FocusEvent extends TerminalEvent {
  /**
   * 与本次焦点变化相关的另一个元素。
   * - 'focus' 事件中：之前失去焦点的元素（null 表示无前任焦点元素）
   * - 'blur' 事件中：即将获得焦点的元素（null 表示焦点移出组件树）
   */
  readonly relatedTarget: EventTarget | null

  /**
   * 创建一个焦点变化事件。
   *
   * @param type - 事件类型：'focus' 表示获得焦点，'blur' 表示失去焦点
   * @param relatedTarget - 相关的另一个焦点元素，默认为 null
   */
  constructor(
    type: 'focus' | 'blur',
    relatedTarget: EventTarget | null = null,
  ) {
    // bubbles=true：焦点事件向上冒泡；cancelable=false：焦点变化不可取消
    super(type, { bubbles: true, cancelable: false })
    this.relatedTarget = relatedTarget
  }
}
