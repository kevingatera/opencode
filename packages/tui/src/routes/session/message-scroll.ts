import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, on, onCleanup, onMount } from "solid-js"
import type { useSync } from "../../context/sync"

const EDGE_THRESHOLD = 3
const SCROLL_POLL_MS = 100
// Minimum gap between two older-history loads so a single scroll-to-top
// gesture cannot fan out into a burst of page requests.
const LOAD_COOLDOWN_MS = 350

export function useSessionMessageScroll(input: {
  sessionID: () => string
  messageCount: () => number
  scroll: () => ScrollBoxRenderable | undefined
  sync: ReturnType<typeof useSync>
}) {
  let lastTop = -1
  let paginationQueued = false
  let anchorReady = false
  let loadingOlder = false
  let cooldownUntil = 0

  function viewportHeight(scroll: ScrollBoxRenderable) {
    return scroll.viewport.height || scroll.height
  }

  function resetAnchor() {
    anchorReady = false
    loadingOlder = false
    cooldownUntil = 0
    lastTop = -1
  }

  function anchorToBottom() {
    const scroll = input.scroll()
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
    lastTop = scroll.scrollTop
    const nearBottom = scroll.scrollTop + viewportHeight(scroll) >= scroll.scrollHeight - EDGE_THRESHOLD
    if (nearBottom) {
      anchorReady = true
      input.sync.session.messages.setFollowing(input.sessionID(), true)
    }
  }

  async function maybePaginate() {
    const scroll = input.scroll()
    if (!scroll || scroll.isDestroyed) return

    const sessionID = input.sessionID()
    const height = viewportHeight(scroll)
    const nearTop = scroll.scrollTop <= EDGE_THRESHOLD
    const nearBottom = scroll.scrollTop + height >= scroll.scrollHeight - EDGE_THRESHOLD
    const overflows = scroll.scrollHeight > height + EDGE_THRESHOLD

    if (nearBottom) {
      anchorReady = true
      input.sync.session.messages.setFollowing(sessionID, true)
      input.sync.session.messages.trimToWindow(sessionID)
    } else if (anchorReady) {
      input.sync.session.messages.setFollowing(sessionID, false)
    }

    if (loadingOlder || !anchorReady || !nearTop || !overflows) return
    if (Date.now() < cooldownUntil) return

    const page = input.sync.session.messages.page(sessionID)
    if (!page || page.loading || page.olderComplete) return

    loadingOlder = true
    const prevHeight = scroll.scrollHeight
    const prevTop = scroll.scrollTop
    try {
      const loaded = await input.sync.session.messages.loadOlder(sessionID)
      if (!loaded) return
      // Restore the viewport anchor after older rows are prepended above.
      // A single load per gesture is intentional: the next page only loads
      // once the user scrolls back up to the top, detected by the poll.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const current = input.scroll()
      if (current && !current.isDestroyed) {
        current.scrollTo(prevTop + (current.scrollHeight - prevHeight))
        lastTop = current.scrollTop
      }
    } finally {
      loadingOlder = false
      cooldownUntil = Date.now() + LOAD_COOLDOWN_MS
    }
  }

  function queuePaginate() {
    if (paginationQueued) return
    paginationQueued = true
    requestAnimationFrame(() => {
      paginationQueued = false
      void maybePaginate()
    })
  }

  createEffect(
    on(input.sessionID, () => {
      resetAnchor()
    }),
  )

  // Keep snapping to the bottom as rows hydrate, until the first anchor lands.
  createEffect(() => {
    input.messageCount()
    if (anchorReady) return
    requestAnimationFrame(() => anchorToBottom())
  })

  onMount(() => {
    const id = setInterval(() => {
      const scroll = input.scroll()
      if (!scroll || scroll.isDestroyed) return
      if (loadingOlder) return
      if (scroll.scrollTop === lastTop) return
      lastTop = scroll.scrollTop
      queuePaginate()
    }, SCROLL_POLL_MS)
    onCleanup(() => clearInterval(id))
  })

  return { queuePaginate, resetAnchor, anchorToBottom }
}
