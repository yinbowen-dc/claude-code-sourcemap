/**
 * mailbox.ts — Claude Code 消息邮箱模块
 *
 * 【系统流程定位】
 * 本模块处于 Claude Code 的 多智能体（Multi-Agent）通信基础层。
 * 它为 Agent、系统组件和用户输入之间提供一个基于队列的异步消息传递机制，
 * 是 Teammate、任务调度器等组件相互传递消息的底层通道。
 *
 * 【主要职责】
 * 1. 定义消息类型（MessageSource / Message）；
 * 2. Mailbox 类：维护消息队列（queue）和等待者列表（waiters），
 *    实现"发送-立即消费 / 发送-入队-异步等待"两种投递模式；
 * 3. 通过 Signal 机制向外部订阅者通知队列变化（用于 React useSyncExternalStore）。
 *
 * 【典型调用链】
 * Teammate 发送消息 → Mailbox.send() → 唤醒等待的 receive() / 放入队列
 * 消费方调用 Mailbox.poll() 或 Mailbox.receive() 取出消息
 */

import { createSignal } from './signal.js'

/** 消息来源枚举：区分消息是由用户、队友、系统、定时任务还是任务产生的 */
export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

/** 消息结构：每条消息携带唯一 ID、来源、正文内容及时间戳，可选发送方和颜色标识 */
export type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}

/**
 * 等待者描述符：记录一个正在 await receive() 的调用者
 * - fn：过滤谓词，只有满足条件的消息才会唤醒该等待者
 * - resolve：Promise 的 resolve 回调，调用后将消息返回给等待方
 */
type Waiter = {
  fn: (msg: Message) => boolean
  resolve: (msg: Message) => void
}

/**
 * Mailbox 类 — 基于队列的异步消息邮箱
 *
 * 【核心设计】
 * - queue：已入队但尚未被消费的消息列表（FIFO）；
 * - waiters：等待特定消息的异步消费者列表（先注册先匹配）；
 * - 每次队列变化（入队 / 出队）都会触发 changed 信号，供 React 订阅刷新。
 *
 * 【投递流程（send）】
 * 1. 增加版本号（_revision），用于外部检测变化；
 * 2. 在 waiters 中找到第一个能接受该消息的等待者，立即 resolve 并移除等待者；
 * 3. 若无等待者，将消息推入 queue。
 *
 * 【消费流程（poll / receive）】
 * - poll：同步非阻塞，找到第一条满足谓词的消息并移除返回，无则返回 undefined；
 * - receive：异步阻塞，先从 queue 查找；若没有则注册 waiter 等待下一条匹配消息。
 */
export class Mailbox {
  // 等待被消费的消息队列
  private queue: Message[] = []
  // 正在等待消息的异步调用者列表
  private waiters: Waiter[] = []
  // 信号对象：每次队列变化时触发，通知外部订阅者（如 React）
  private changed = createSignal()
  // 版本号：每次 send() 递增，供外部判断队列是否有变化
  private _revision = 0

  /** 返回队列中当前未消费消息的数量 */
  get length(): number {
    return this.queue.length
  }

  /** 返回当前版本号（单调递增），每次 send() 后 +1 */
  get revision(): number {
    return this._revision
  }

  /**
   * 发送一条消息到邮箱。
   *
   * 流程：
   * 1. 递增版本号；
   * 2. 在 waiters 中查找第一个能接受该消息的等待者；
   *    - 找到 → splice 移除该等待者并调用其 resolve，然后 notify 后直接返回；
   *    - 未找到 → 将消息 push 进 queue，然后 notify。
   *
   * @param msg 要发送的消息对象
   */
  send(msg: Message): void {
    // 每次发送都更新版本号，方便外部轮询检测变化
    this._revision++
    // 查找第一个能接受此消息的等待者（按注册顺序匹配）
    const idx = this.waiters.findIndex(w => w.fn(msg))
    if (idx !== -1) {
      // 从 waiters 中移除该等待者（避免重复触发）
      const waiter = this.waiters.splice(idx, 1)[0]
      if (waiter) {
        // 直接 resolve 等待者的 Promise，将消息传递给等待方
        waiter.resolve(msg)
        this.notify()
        return
      }
    }
    // 没有等待者，将消息放入持久队列
    this.queue.push(msg)
    this.notify()
  }

  /**
   * 同步轮询：从队列中取出第一条满足谓词的消息并移除。
   *
   * @param fn 过滤谓词，默认接受所有消息
   * @returns 找到则返回消息对象，否则返回 undefined（不阻塞）
   */
  poll(fn: (msg: Message) => boolean = () => true): Message | undefined {
    // 查找队列中第一条满足条件的消息位置
    const idx = this.queue.findIndex(fn)
    if (idx === -1) return undefined
    // splice 移除并返回该条消息
    return this.queue.splice(idx, 1)[0]
  }

  /**
   * 异步等待接收：从队列中取出第一条满足谓词的消息，若队列中暂无则挂起等待。
   *
   * 流程：
   * 1. 先在 queue 中同步查找；有则立即 resolve 并返回；
   * 2. 无则创建 Promise 并将等待者注册进 waiters，等 send() 时被唤醒。
   *
   * @param fn 过滤谓词，默认接受所有消息
   * @returns 满足谓词的消息（可能异步等待）
   */
  receive(fn: (msg: Message) => boolean = () => true): Promise<Message> {
    // 先尝试从已有队列中同步取出
    const idx = this.queue.findIndex(fn)
    if (idx !== -1) {
      const msg = this.queue.splice(idx, 1)[0]
      if (msg) {
        // 取出后通知订阅者（队列长度已变化）
        this.notify()
        return Promise.resolve(msg)
      }
    }
    // 队列中无匹配消息，注册等待者，等待 send() 唤醒
    return new Promise<Message>(resolve => {
      this.waiters.push({ fn, resolve })
    })
  }

  /**
   * 订阅队列变化信号（代理 changed.subscribe）。
   * React 组件通过 useSyncExternalStore 传入此方法实现响应式刷新。
   */
  subscribe = this.changed.subscribe

  /**
   * 通知所有订阅者：队列状态已发生变化。
   * 内部方法，每次 send/poll/receive 操作后调用。
   */
  private notify(): void {
    this.changed.emit()
  }
}
