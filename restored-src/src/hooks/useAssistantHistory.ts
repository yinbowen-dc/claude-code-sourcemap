/**
 * useAssistantHistory.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「历史消息懒加载」子系统，仅在 viewerOnly（只读观察）
 * 模式下生效，负责在用户向上滚动时按需加载 claude assistant 的历史会话页面。
 *
 * 核心设计：
 * - 挂载时自动拉取最新一页（anchor_to_latest），并预填充视口；
 * - 用户向上滚动到距顶部 PREFETCH_THRESHOLD_ROWS=40 行时触发加载更早的页；
 * - 使用稳定的 sentinel UUID（跨页面复用）替换加载状态消息，避免虚拟滚动
 *   将其识别为 remove+insert 而导致布局抖动；
 * - 使用 useLayoutEffect 实现滚动锚定（prepend 后补偿 scrollTop，保持视口位置）；
 * - fill-viewport 链：初始加载后若内容未填满视口，自动链式加载更多页，
 *   最多 MAX_FILL_PAGES=10 次，防止全部事件都被过滤时的无限循环；
 * - 仅在 feature('KAIROS') gate 下由 REPL 调用，编译期排除无关路径。
 */

import { randomUUID } from 'crypto'
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import {
  createHistoryAuthCtx,
  fetchLatestEvents,
  fetchOlderEvents,
  type HistoryAuthCtx,
  type HistoryPage,
} from '../assistant/sessionHistory.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js'
import { convertSDKMessage } from '../remote/sdkMessageAdapter.js'
import type { Message, SystemInformationalMessage } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'

type Props = {
  /** Gated on viewerOnly — non-viewer sessions have no remote history to page. */
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  scrollRef: RefObject<ScrollBoxHandle | null>
  /** Called after prepend from the layout effect with message count + height
   *  delta. Lets useUnseenDivider shift dividerIndex + dividerYRef. */
  onPrepend?: (indexDelta: number, heightDelta: number) => void
}

type Result = {
  /** Trigger for ScrollKeybindingHandler's onScroll composition. */
  maybeLoadOlder: (handle: ScrollBoxHandle) => void
}

/** Fire loadOlder when scrolled within this many rows of the top. */
const PREFETCH_THRESHOLD_ROWS = 40

/** Max chained page loads to fill the viewport on mount. Bounds the loop if
 *  events convert to zero visible messages (everything filtered). */
const MAX_FILL_PAGES = 10

/** 加载中哨兵文本 */
const SENTINEL_LOADING = 'loading older messages…'
/** 加载失败哨兵文本（允许用户再次上滚重试） */
const SENTINEL_LOADING_FAILED =
  'failed to load older messages — scroll up to retry'
/** 已到会话起点哨兵文本 */
const SENTINEL_START = 'start of session'

/**
 * 将 HistoryPage 中的 SDK 事件转换为 REPL 可渲染的 Message 数组。
 * 使用 viewer 模式所需的选项（convertUserTextMessages + convertToolResults）。
 *
 * @param page 历史页面对象
 */
function pageToMessages(page: HistoryPage): Message[] {
  const out: Message[] = []
  for (const ev of page.events) {
    const c = convertSDKMessage(ev, {
      convertUserTextMessages: true,
      convertToolResults: true,
    })
    if (c.type === 'message') out.push(c.message)
  }
  return out
}

/**
 * 历史会话懒加载 hook（仅 viewerOnly 模式）。
 *
 * 挂载时：通过 anchor_to_latest 拉取最新一页，prepend 到消息列表。
 * 上滚时：通过 before_id 拉取更早的页，prepend 并进行滚动锚定。
 *
 * Lazy-load `claude assistant` history on scroll-up.
 *
 * On mount: fetch newest page via anchor_to_latest, prepend to messages.
 * On scroll-up near top: fetch next-older page via before_id, prepend with
 * scroll anchoring (viewport stays put).
 *
 * No-op unless config.viewerOnly. REPL only calls this hook inside a
 * feature('KAIROS') gate, so build-time elimination is handled there.
 */
export function useAssistantHistory({
  config,
  setMessages,
  scrollRef,
  onPrepend,
}: Props): Result {
  // 仅在 viewerOnly 模式下启用
  const enabled = config?.viewerOnly === true

  // Cursor state: ref-only (no re-render on cursor change). `null` = no
  // older pages. `undefined` = initial page not fetched yet.
  // cursorRef: 翻页游标（null=已到末尾，undefined=初始未加载）
  const cursorRef = useRef<string | null | undefined>(undefined)
  const ctxRef = useRef<HistoryAuthCtx | null>(null)     // 鉴权上下文
  const inflightRef = useRef(false)                       // 是否有请求正在进行中

  // Scroll-anchor: snapshot height + prepended count before setMessages;
  // compensate in useLayoutEffect after React commits. getFreshScrollHeight
  // reads Yoga directly so the value is correct post-commit.
  // 滚动锚定数据：prepend 前快照高度和条数，useLayoutEffect 中用于补偿 scrollTop
  const anchorRef = useRef<{ beforeHeight: number; count: number } | null>(null)

  // Fill-viewport chaining: after the initial page commits, if content doesn't
  // fill the viewport yet, load another page. Self-chains via the layout effect
  // until filled or the budget runs out. Budget set once on initial load; user
  // scroll-ups don't need it (maybeLoadOlder re-fires on next wheel event).
  // 填充视口的预算（最多链式加载 MAX_FILL_PAGES 次）
  const fillBudgetRef = useRef(0)

  // Stable sentinel UUID — reused across swaps so virtual-scroll treats it
  // as one item (text-only mutation, not remove+insert).
  // 稳定 sentinel UUID：跨页面复用，避免虚拟滚动的 remove+insert
  const sentinelUuidRef = useRef(randomUUID())

  /**
   * 创建系统信息类型的哨兵消息（使用稳定 UUID，跨更新保持同一条目）。
   * @param text 哨兵显示文本
   */
  function mkSentinel(text: string): SystemInformationalMessage {
    return {
      type: 'system',
      subtype: 'informational',
      content: text,
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: sentinelUuidRef.current,
      level: 'info',
    }
  }

  /**
   * 将一页历史消息前置到消息列表。
   * - 更新翻页游标；
   * - 非初始加载时快照滚动高度（用于后续锚定补偿）；
   * - 替换旧 sentinel（O(1)，sentinel 始终在 index 0）；
   * - 若无更多历史，在最前面插入"start of session" sentinel。
   *
   * Prepend a page at the front, with scroll-anchor snapshot for non-initial.
   * Replaces the sentinel (always at index 0 when present) in-place.
   */
  const prepend = useCallback(
    (page: HistoryPage, isInitial: boolean) => {
      const msgs = pageToMessages(page)
      // 更新游标：还有更多页则保留 firstId，否则置 null
      cursorRef.current = page.hasMore ? page.firstId : null

      if (!isInitial) {
        // 非初始加载：快照当前高度，用于滚动锚定
        const s = scrollRef.current
        anchorRef.current = s
          ? { beforeHeight: s.getFreshScrollHeight(), count: msgs.length }
          : null
      }

      // 若还有更多历史，不插入 sentinel；否则插入"start of session"
      const sentinel = page.hasMore ? null : mkSentinel(SENTINEL_START)
      setMessages(prev => {
        // Drop existing sentinel (index 0, known stable UUID — O(1)).
        const base =
          prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
        return sentinel ? [sentinel, ...msgs, ...base] : [...msgs, ...base]
      })

      logForDebugging(
        `[useAssistantHistory] ${isInitial ? 'initial' : 'older'} page: ${msgs.length} msgs (raw ${page.events.length}), hasMore=${page.hasMore}`,
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollRef is a stable ref; mkSentinel reads refs only
    [setMessages],
  )

  // 挂载时拉取最新一页（best-effort，失败时静默忽略）
  // Initial fetch on mount — best-effort.
  useEffect(() => {
    if (!enabled || !config) return
    let cancelled = false
    void (async () => {
      const ctx = await createHistoryAuthCtx(config.sessionId).catch(() => null)
      if (!ctx || cancelled) return
      ctxRef.current = ctx
      const page = await fetchLatestEvents(ctx)
      if (cancelled || !page) return
      // 初始加载时设置 fill-viewport 预算
      fillBudgetRef.current = MAX_FILL_PAGES
      prepend(page, true)
    })()
    return () => {
      cancelled = true
    }
    // config identity is stable (created once in main.tsx, never recreated)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  /**
   * 加载更早历史页的核心函数。
   * - 防重入（inflightRef）；
   * - 无游标（null=已到头，undefined=初始未完成）时跳过；
   * - 加载中显示"loading…" sentinel，失败时回退到"failed…" sentinel。
   */
  const loadOlder = useCallback(async () => {
    if (!enabled || inflightRef.current) return
    const cursor = cursorRef.current
    const ctx = ctxRef.current
    if (!cursor || !ctx) return // null=exhausted, undefined=initial pending
    inflightRef.current = true
    // Swap sentinel to "loading…" — O(1) slice since sentinel is at index 0.
    setMessages(prev => {
      const base =
        prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
      return [mkSentinel(SENTINEL_LOADING), ...base]
    })
    try {
      const page = await fetchOlderEvents(ctx, cursor)
      if (!page) {
        // Fetch failed — revert sentinel back to "start" placeholder so the user
        // can retry on next scroll-up. Cursor is preserved (not nulled out).
        setMessages(prev => {
          const base =
            prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
          return [mkSentinel(SENTINEL_LOADING_FAILED), ...base]
        })
        return
      }
      prepend(page, false)
    } finally {
      inflightRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mkSentinel reads refs only
  }, [enabled, prepend, setMessages])

  // Scroll-anchor compensation — after React commits the prepended items,
  // shift scrollTop by the height delta so the viewport stays put. Also
  // fire onPrepend here (not in prepend()) so dividerIndex + baseline ref
  // are shifted with the ACTUAL height delta, not an estimate.
  // No deps: runs every render; cheap no-op when anchorRef is null.
  // 滚动锚定补偿：React commit 后，将 scrollTop 增加高度差，保持视口位置不变
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    anchorRef.current = null
    const s = scrollRef.current
    if (!s || s.isSticky()) return // sticky = pinned bottom; prepend is invisible
    const delta = s.getFreshScrollHeight() - anchor.beforeHeight
    if (delta > 0) s.scrollBy(delta)
    onPrepend?.(anchor.count, delta)  // 通知 useUnseenDivider 更新 dividerIndex
  })

  // Fill-viewport chain: after paint, if content doesn't exceed the viewport,
  // load another page. Runs as useEffect (not layout effect) so Ink has
  // painted and scrollViewportHeight is populated. Self-chains via next
  // render's effect; budget caps the chain.
  //
  // The ScrollBox content wrapper has flexGrow:1 flexShrink:0 — it's clamped
  // to ≥ viewport. So `content < viewport` is never true; `<=` detects "no
  // overflow yet" correctly. Stops once there's at least something to scroll.
  // 填充视口链：paint 后检查内容是否已超出视口，未超出则继续加载（有预算限制）
  useEffect(() => {
    if (
      fillBudgetRef.current <= 0 ||  // 预算耗尽
      !cursorRef.current ||           // 已无更多历史
      inflightRef.current             // 有请求进行中
    ) {
      return
    }
    const s = scrollRef.current
    if (!s) return
    const contentH = s.getFreshScrollHeight()
    const viewH = s.getViewportHeight()
    logForDebugging(
      `[useAssistantHistory] fill-check: content=${contentH} viewport=${viewH} budget=${fillBudgetRef.current}`,
    )
    if (contentH <= viewH) {
      // 内容未填满视口，消耗一次预算并加载更多
      fillBudgetRef.current--
      void loadOlder()
    } else {
      // 内容已填满，清零预算停止链式加载
      fillBudgetRef.current = 0
    }
  })

  // Trigger wrapper for onScroll composition in REPL.
  // maybeLoadOlder：供 ScrollKeybindingHandler 的 onScroll 组合调用
  const maybeLoadOlder = useCallback(
    (handle: ScrollBoxHandle) => {
      // 距顶部不足 PREFETCH_THRESHOLD_ROWS 行时触发加载
      if (handle.getScrollTop() < PREFETCH_THRESHOLD_ROWS) void loadOlder()
    },
    [loadOlder],
  )

  return { maybeLoadOlder }
}
