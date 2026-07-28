import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectMoveEvent, type DialogSelectRef } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import path from "path"
import { Locale } from "../util/locale"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { useCommandShortcut } from "../keymap"
import type { Session } from "@opencode-ai/sdk/v2"

type SessionListFilter = { scope?: "project"; path?: string }

export function createDialogSessionListQuery(input: { search?: string; filter: SessionListFilter }) {
  const search = input.search?.trim()
  return {
    roots: true,
    limit: search ? 30 : 100,
    ...(search ? { search } : {}),
    ...input.filter,
  }
}

export function loadDialogSessionList<T>(input: {
  search?: string
  filter: SessionListFilter
  list: (query: ReturnType<typeof createDialogSessionListQuery>) => Promise<{ data?: T[] }>
}) {
  return input.list(createDialogSessionListQuery(input)).then(
    (result) => result.data,
    () => undefined,
  )
}

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)
  let selectRef: DialogSelectRef<string>
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")
  const searchPageSize = 50
  const [searchPage, setSearchPage] = createStore({
    results: undefined as Session[] | undefined,
    cursor: undefined as string | undefined,
    loading: false,
    complete: true,
    oldestCursor: undefined as string | undefined,
    oldestComplete: true,
    oldestTop: undefined as string | undefined,
  })
  const sessionFilter = createMemo(() => sync.session.query())
  const sessionFilterKey = createMemo(() => JSON.stringify(sessionFilter()))
  let searchRevision = 0

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => searchPage.results ?? sync.data.session)

  function mergeSessions(current: Session[], incoming: Session[]) {
    return [...new Map([...current, ...incoming].map((item) => [item.id, item])).values()]
  }

  async function loadSearchPage(reset: boolean) {
    const query = search()
    if (!query) {
      searchRevision += 1
      setSearchPage({
        results: undefined,
        cursor: undefined,
        loading: false,
        complete: true,
        oldestCursor: undefined,
        oldestComplete: true,
        oldestTop: undefined,
      })
      return false
    }
    if (!reset && searchPage.loading) return false
    if (!reset && searchPage.complete) return false
    const cursor = reset ? undefined : searchPage.cursor
    if (!reset && !cursor) return false

    const revision = ++searchRevision
    if (reset) {
      setSearchPage({
        results: [],
        cursor: undefined,
        complete: false,
        oldestCursor: undefined,
        oldestComplete: true,
        oldestTop: undefined,
      })
    }
    setSearchPage("loading", true)
    try {
      const response = await sdk.client.session.list({
        search: query,
        limit: searchPageSize,
        cursor,
        ...sessionFilter(),
      })
      if (revision !== searchRevision) return false
      const next = response.data ?? []
      const nextCursor = response.response.headers.get("x-next-cursor") ?? undefined
      setSearchPage("results", reset ? next : mergeSessions(searchPage.results ?? [], next))
      setSearchPage("cursor", nextCursor)
      setSearchPage("complete", !nextCursor)
      return next.length > 0
    } finally {
      if (revision === searchRevision) setSearchPage("loading", false)
    }
  }

  async function loadOldestSearchPage(reset: boolean) {
    const query = search()
    if (!query) return false
    if (searchPage.loading) return false
    const cursor = reset ? undefined : searchPage.oldestCursor
    if (!reset && (searchPage.oldestComplete || !cursor)) return false

    const revision = ++searchRevision
    setSearchPage("loading", true)
    try {
      const response = await sdk.client.session.list({
        search: query,
        limit: searchPageSize,
        order: "asc",
        cursor,
        ...sessionFilter(),
      })
      if (revision !== searchRevision) return false
      const next = response.data ?? []
      const nextCursor = response.response.headers.get("x-next-cursor") ?? undefined
      setSearchPage("results", mergeSessions(searchPage.results ?? [], next))
      setSearchPage("oldestCursor", nextCursor)
      setSearchPage("oldestComplete", !nextCursor)
      setSearchPage("oldestTop", next.at(-1)?.id ?? searchPage.oldestTop)
      return next.length > 0
    } finally {
      if (revision === searchRevision) setSearchPage("loading", false)
    }
  }

  createEffect(
    on([search, sessionFilterKey], () => {
      void loadSearchPage(true)
    }),
  )

  function recover(session: NonNullable<ReturnType<typeof sessions>[number]>) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const warp = async (selection: WorkspaceSelection) => {
      const workspaceID = await (async () => {
        if (selection.type === "none") return null
        if (selection.type === "existing") return selection.workspaceID
        let result
        try {
          result = await sdk.client.experimental.workspace.create({ type: selection.workspaceType, branch: null })
        } catch (err) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(err),
            variant: "error",
          })
          return
        }
        const workspace = result?.data
        if (!workspace) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(result?.error ?? "no response"),
            variant: "error",
          })
          return
        }
        await project.workspace.sync()
        return workspace.id
      })()
      if (workspaceID === undefined) return
      await warpWorkspaceSession({
        dialog,
        sdk,
        sync,
        project,
        toast,
        sourceWorkspaceID: session.workspaceID,
        workspaceID,
        sessionID: session.id,
        copyChanges: false,
        done: list,
      })
    }
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={async () => {
          const current = currentSessionID()
          const info = current ? sync.data.session.find((item) => item.id === current) : undefined
          const result = await sdk.client.experimental.workspace.remove({ id: session.workspaceID! })
          if (result.error) {
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(result.error),
            })
            return false
          }
          await project.workspace.sync()
          await sync.session.refresh()
          if (search()) await loadSearchPage(true)
          if (info?.workspaceID === session.workspaceID) {
            route.navigate({ type: "home" })
          }
          return true
        }}
        onRestore={() => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              void warp(selection)
            },
          })
          return false
        }}
      />
    ))
  }

  function compareSessionRecency(a: Session, b: Session) {
    return b.time.updated - a.time.updated || b.id.localeCompare(a.id)
  }

  function orderByRecency(sessionsList: NonNullable<ReturnType<typeof sessions>>) {
    return sessionsList
      .filter((x) => x.parentID === undefined)
      .toSorted(compareSessionRecency)
      .map((x) => x.id)
  }

  const browseOrder = createMemo(() => orderByRecency(sync.data.session))

  const quickSwitchHint = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last) return undefined
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const sessionMap = new Map(
      sessions()
        .filter((x) => x.parentID === undefined)
        .map((x) => [x.id, x]),
    )

    const searchResult = searchPage.results
    const displayOrder = searchResult ? orderByRecency(searchResult) : browseOrder()

    const pinned = local.session.pinned().filter((id) => sessionMap.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(id: string, category: string) {
      const x = sessionMap.get(id)
      if (!x) return undefined
      const directory = x.path
        ? x.directory.endsWith(x.path)
          ? x.directory.slice(0, -x.path.length).replace(/\/$/, "")
          : undefined
        : x.directory
      const footer =
        directory && directory !== project.data.project.mainDir ? Locale.truncate(path.basename(directory), 20) : ""

      const isDeleting = toDelete() === x.id
      const status = sync.data.session_status?.[x.id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const slot = slotByID.get(x.id)
      const gutter = isWorking
        ? () => <Spinner />
        : slot !== undefined
          ? () => <text fg={theme.accent}>{slot}</text>
          : undefined
      return {
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : x.title,
        bg: isDeleting ? theme.error : undefined,
        value: x.id,
        category,
        footer,
        gutter,
      }
    }

    const remaining = displayOrder
      .filter((id) => !pinnedSet.has(id))
      .map((id) => {
        const x = sessionMap.get(id)
        if (!x) return undefined
        const label = new Date(x.time.updated).toDateString()
        return buildOption(id, label === today ? "Today" : label)
      })
      .filter((x) => x !== undefined)

    return [...pinned.map((id) => buildOption(id, "Pinned")).filter((x) => x !== undefined), ...remaining]
  })

  const searching = createMemo(() => searchPage.results !== undefined)
  const hasMore = createMemo(() => {
    if (searching()) return !searchPage.complete && !!searchPage.cursor
    return sync.session.page.more()
  })
  const loadingMore = createMemo(() => (searching() ? searchPage.loading : sync.session.page.loading()))
  const oldestMore = createMemo(() => {
    if (searching()) return !searchPage.oldestComplete && !!searchPage.oldestCursor
    return sync.session.page.oldestMore()
  })
  const oldestTop = createMemo(() => (searching() ? searchPage.oldestTop : sync.session.page.oldestTop()))

  function oldestBoundaryIndex(list: { value: string }[]) {
    const top = oldestTop()
    if (!top) return -1
    const sessionMap = new Map(sessions().map((session) => [session.id, session]))
    const boundary = sessionMap.get(top)
    if (!boundary) return -1
    const pinned = new Set(local.session.pinned())
    // Pinned rows are rendered outside chronological order, so find the
    // boundary by recency rather than by the marker row's raw option index.
    return list.findIndex((item) => {
      if (pinned.has(item.value)) return false
      const session = sessionMap.get(item.value)
      return session ? compareSessionRecency(session, boundary) >= 0 : false
    })
  }

  async function loadMore() {
    if (loadingMore()) return
    if (searching()) {
      await loadSearchPage(false)
      return
    }
    await sync.session.page.loadMore()
  }

  async function loadOldestPage() {
    // Top-to-bottom wrap is an explicit "go to the end" gesture. Fetch the
    // oldest page directly instead of walking every intermediate cursor page.
    if (searching()) return loadOldestSearchPage(true)
    return sync.session.page.loadOldest()
  }

  async function loadFromOldestPage() {
    if (searching()) return loadOldestSearchPage(false)
    return sync.session.page.loadFromOldest()
  }

  function moveToOldestLoaded() {
    // Wait for appended rows to render before asking DialogSelect to scroll to one.
    setTimeout(() => {
      selectRef.moveTo(options().length - 1, { center: true, notify: false })
    }, 0)
  }

  function moveToValue(value: string) {
    setTimeout(() => {
      const index = options().findIndex((item) => item?.value === value)
      if (index < 0) return
      selectRef.moveTo(index, { notify: false })
    }, 0)
  }

  function moveByOffsetFromValue(value: string, offset: number) {
    setTimeout(() => {
      const list = options()
      const index = list.findIndex((item) => item?.value === value)
      if (index < 0) return
      const next = Math.max(0, Math.min(list.length - 1, index + offset))
      selectRef.moveTo(next, { center: true, notify: false })
    }, 0)
  }

  function maybeLoadMore(option: { value: string }, event: DialogSelectMoveEvent) {
    setToDelete(undefined)
    const list = options()
    const index = list.findIndex((item) => item?.value === option.value)
    if (index < 0) return
    const oldestTopIndex = oldestBoundaryIndex(list)
    if (event.direction !== undefined && event.direction < 0 && oldestMore() && oldestTopIndex >= 0) {
      if (index > oldestTopIndex + 5) return
      void (async () => {
        const loaded = await loadFromOldestPage()
        if (loaded) moveToValue(option.value)
      })()
      return
    }
    if (!hasMore()) return
    if (index < list.length - 5) return
    void (async () => {
      await loadMore()
    })()
  }

  function maybeHandleBeforeMove(_option: { value: string }, event: DialogSelectMoveEvent) {
    setToDelete(undefined)
    const list = options()
    const oldestTopIndex = oldestBoundaryIndex(list)

    if (
      event.direction !== undefined &&
      event.direction < 0 &&
      event.wrapped !== "end" &&
      oldestMore() &&
      oldestTopIndex >= 0 &&
      event.previous >= oldestTopIndex &&
      event.next < oldestTopIndex
    ) {
      const previous = list[event.previous]?.value
      if (!previous) return false

      if (!loadingMore()) {
        void (async () => {
          const loaded = await loadFromOldestPage()
          if (loaded) moveByOffsetFromValue(previous, event.direction!)
        })()
      }
      // Do not let selection jump across the unloaded gap while the adjacent
      // oldest-side page is being fetched.
      return false
    }

    if (event.wrapped !== "end") return
    if (!hasMore()) return
    if (!loadingMore()) {
      void (async () => {
        await loadOldestPage()
        moveToOldestLoaded()
      })()
    }
    return false
  }

  const footerHints = createMemo(() => {
    const hints = quickSwitchFooterHints()
    if (!hasMore()) return hints
    return [
      ...hints,
      {
        title: "older",
        label: "navigate to bottom",
        side: "right" as const,
      },
    ]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      ref={(ref) => {
        selectRef = ref
      }}
      title="Sessions"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onBeforeMove={maybeHandleBeforeMove}
      onMove={maybeLoadMore}
      footerHints={footerHints()}
      onSelect={(option) => {
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            local.session.togglePin(option.value)
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              const session = sessions().find((item) => item.id === option.value)
              const status = session?.workspaceID ? project.workspace.status(session.workspaceID) : undefined

              try {
                const result = await sdk.client.session.delete({
                  sessionID: option.value,
                })
                if (result.error) {
                  if (session?.workspaceID) {
                    recover(session)
                  } else {
                    toast.show({
                      variant: "error",
                      title: "Failed to delete session",
                      message: errorMessage(result.error),
                    })
                  }
                  setToDelete(undefined)
                  return
                }
              } catch (err) {
                if (session?.workspaceID) {
                  recover(session)
                } else {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete session",
                    message: errorMessage(err),
                  })
                }
                setToDelete(undefined)
                return
              }
              if (status && status !== "connected") {
                await sync.session.refresh()
              }
              if (search()) await loadSearchPage(true)
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
