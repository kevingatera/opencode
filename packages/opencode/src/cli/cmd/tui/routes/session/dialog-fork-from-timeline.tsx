import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import {
  DialogSelect,
  type DialogSelectMoveEvent,
  type DialogSelectOption,
  type DialogSelectRef,
} from "@tui/ui/dialog-select"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

type MessageWithParts = {
  info: Message
  parts: Part[]
}

function compareMessageTime(a: MessageWithParts, b: MessageWithParts) {
  return a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id)
}

function compareMessageRecency(a: Message, b: Message) {
  return b.time.created - a.time.created || b.id.localeCompare(a.id)
}

export function mergeForkTimelineMessages(current: MessageWithParts[], incoming: MessageWithParts[]) {
  return [...new Map([...current, ...incoming].map((message) => [message.info.id, message])).values()].toSorted(
    compareMessageTime,
  )
}

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const pageSize = 100
  const initialMessages = (sync.data.message[props.sessionID] ?? []).map((info) => ({
    info,
    parts: sync.data.part[info.id] ?? [],
  }))
  const [messages, setMessages] = createSignal<MessageWithParts[]>(initialMessages)
  const [newestCursor, setNewestCursor] = createSignal<string>()
  const [newestComplete, setNewestComplete] = createSignal(false)
  const [newestBottom, setNewestBottom] = createSignal<Message>()
  const [oldestCursor, setOldestCursor] = createSignal<string>()
  const [oldestComplete, setOldestComplete] = createSignal(true)
  const [oldestTop, setOldestTop] = createSignal<Message>()
  const [loading, setLoading] = createSignal(false)
  let selectRef: DialogSelectRef<string | undefined>

  async function fetchMessages(input?: { order?: "asc" | "desc"; before?: string }) {
    const response = await sdk.client.session.messages({
      sessionID: props.sessionID,
      limit: pageSize,
      order: input?.order,
      before: input?.before,
    })
    return {
      items: response.data ?? [],
      cursor: response.response.headers.get("x-next-cursor") ?? undefined,
    }
  }

  async function loadLatestMessages() {
    if (loading()) return false
    setLoading(true)
    try {
      const page = await fetchMessages()
      setMessages(page.items)
      setNewestCursor(page.cursor)
      setNewestComplete(!page.cursor)
      setNewestBottom(page.items[0]?.info)
      setOldestCursor(undefined)
      setOldestComplete(true)
      setOldestTop(undefined)
      return page.items.length > 0
    } finally {
      setLoading(false)
    }
  }

  async function loadMoreFromNewest() {
    if (loading() || newestComplete()) return false
    const before = newestCursor()
    if (!before) return false
    setLoading(true)
    try {
      const page = await fetchMessages({ before })
      setMessages(mergeForkTimelineMessages(messages(), page.items))
      setNewestCursor(page.cursor)
      setNewestComplete(!page.cursor)
      if (page.items[0]) setNewestBottom(page.items[0].info)
      return page.items.length > 0
    } finally {
      setLoading(false)
    }
  }

  async function loadOldestPage() {
    if (loading()) return false
    setLoading(true)
    try {
      const page = await fetchMessages({ order: "asc" })
      setMessages(mergeForkTimelineMessages(messages(), page.items))
      setOldestCursor(page.cursor)
      setOldestComplete(!page.cursor)
      setOldestTop(page.items.at(-1)?.info)
      return page.items.length > 0
    } finally {
      setLoading(false)
    }
  }

  async function loadMoreFromOldest() {
    if (loading() || oldestComplete()) return false
    const before = oldestCursor()
    if (!before) return false
    setLoading(true)
    try {
      // The legacy query parameter is named "before"; with order=asc it is the
      // cursor for the next newer page from the oldest side.
      const page = await fetchMessages({ order: "asc", before })
      setMessages(mergeForkTimelineMessages(messages(), page.items))
      setOldestCursor(page.cursor)
      setOldestComplete(!page.cursor)
      if (page.items.at(-1)) setOldestTop(page.items.at(-1)!.info)
      return page.items.length > 0
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    dialog.setSize("large")
    void loadLatestMessages()
  })

  const messageMap = createMemo(() => new Map(messages().map((message) => [message.info.id, message.info])))

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        const forked = await sdk.client.session.fork({ sessionID: props.sessionID })
        route.navigate({
          sessionID: forked.data!.id,
          type: "session",
        })
        dialog.clear()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const item of messages()) {
      const message = item.info
      if (message.role !== "user") continue
      const part = item.parts.find((x) => x.type === "text" && !x.synthetic && !x.ignored) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          const forked = await sdk.client.session.fork({
            sessionID: props.sessionID,
            messageID: message.id,
          })
          const prompt = item.parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          route.navigate({
            sessionID: forked.data!.id,
            type: "session",
            prompt,
          })
          dialog.clear()
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  function messageForOption(option: DialogSelectOption<string | undefined>) {
    if (!option.value) return
    return messageMap().get(option.value)
  }

  function oldestBoundaryIndex(list: DialogSelectOption<string | undefined>[]) {
    const boundary = oldestTop()
    if (!boundary) return -1
    return list.findIndex((item) => {
      const message = messageForOption(item)
      return message ? compareMessageRecency(message, boundary) >= 0 : false
    })
  }

  function newestBoundaryIndex(list: DialogSelectOption<string | undefined>[]) {
    const boundary = newestBottom()
    if (!boundary) return -1
    let index = -1
    for (let i = 0; i < list.length; i++) {
      const message = messageForOption(list[i]!)
      if (message && compareMessageRecency(message, boundary) <= 0) index = i
    }
    return index
  }

  function moveToOldestLoaded() {
    setTimeout(() => {
      selectRef.moveTo(options().length - 1, { center: true, notify: false })
    }, 0)
  }

  function moveToNextLoaded(previous: number) {
    setTimeout(() => {
      selectRef.moveTo(Math.min(previous + 1, options().length - 1), { center: true, notify: false })
    }, 0)
  }

  function moveByOffsetFromValue(value: string, offset: number) {
    setTimeout(() => {
      const list = options()
      const index = list.findIndex((item) => item.value === value)
      if (index < 0) return
      const next = Math.max(0, Math.min(list.length - 1, index + offset))
      selectRef.moveTo(next, { center: true, notify: false })
    }, 0)
  }

  function maybeLoadMore(option: DialogSelectOption<string | undefined>, event: DialogSelectMoveEvent) {
    props.onMove(option.value)
    if (loading()) return
    const list = options()
    const index = list.findIndex((item) => item.value === option.value)
    if (index < 0) return

    const oldestIndex = oldestBoundaryIndex(list)
    const newestIndex = newestBoundaryIndex(list)
    const hasLoadedGap = oldestIndex >= 0 && newestIndex >= 0 && oldestIndex > newestIndex
    if (event.direction !== undefined && event.direction < 0 && !oldestComplete() && hasLoadedGap) {
      if (index > oldestIndex + 5) return
      void (async () => {
        const loaded = await loadMoreFromOldest()
        if (loaded && option.value) moveByOffsetFromValue(option.value, 0)
      })()
      return
    }

    if (newestComplete()) return
    if (hasLoadedGap) {
      if (event.direction === undefined || event.direction < 0) return
      if (index < newestIndex - 5 || index > newestIndex) return
    } else if (index < list.length - 5) {
      return
    }
    void loadMoreFromNewest()
  }

  function maybePreventWrap(event: DialogSelectMoveEvent) {
    const list = options()
    const oldestIndex = oldestBoundaryIndex(list)
    const newestIndex = newestBoundaryIndex(list)
    const hasLoadedGap = oldestIndex >= 0 && newestIndex >= 0 && oldestIndex > newestIndex

    if (
      event.direction !== undefined &&
      event.direction > 0 &&
      !newestComplete() &&
      hasLoadedGap &&
      event.previous <= newestIndex &&
      event.next >= oldestIndex
    ) {
      const previous = list[event.previous]?.value
      if (!loading()) {
        void (async () => {
          const loaded = await loadMoreFromNewest()
          if (loaded && previous) moveByOffsetFromValue(previous, event.direction!)
        })()
      }
      // Keep selection at the gap edge while the adjacent page is fetched.
      return false
    }

    if (
      event.direction !== undefined &&
      event.direction < 0 &&
      !oldestComplete() &&
      hasLoadedGap &&
      event.previous >= oldestIndex &&
      event.next <= newestIndex
    ) {
      const previous = list[event.previous]?.value
      if (!loading()) {
        void (async () => {
          const loaded = await loadMoreFromOldest()
          if (loaded && previous) moveByOffsetFromValue(previous, event.direction!)
        })()
      }
      return false
    }

    if (event.wrapped === "end" && !oldestTop() && !newestComplete()) {
      if (!loading()) {
        void (async () => {
          const loaded = await loadOldestPage()
          if (loaded) moveToOldestLoaded()
        })()
      }
      return false
    }

    if (event.wrapped === "start" && !oldestTop() && !newestComplete()) {
      if (!loading()) {
        void (async () => {
          const loaded = await loadMoreFromNewest()
          if (loaded) moveToNextLoaded(event.previous)
        })()
      }
      return false
    }
  }

  const footerHints = createMemo(() =>
    newestComplete() && oldestComplete()
      ? []
      : [
          {
            title: "older",
            label: "navigate to bottom",
            side: "right" as const,
          },
        ],
  )

  return (
    <DialogSelect
      ref={(ref) => {
        selectRef = ref
      }}
      onBeforeMove={(_option, event) => maybePreventWrap(event)}
      onMove={maybeLoadMore}
      title="Fork session"
      options={options()}
      footerHints={footerHints()}
    />
  )
}
