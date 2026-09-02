import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { readText, writeText } from "../util/persistence"
import type { PromptInfo } from "./history"

export const HOME_KEY = "home"
export const MAX_HOLD_ENTRIES = 20

export type HoldEntry = PromptInfo & {
  id: string
  timestamp: number
}

export function holdSessionKey(sessionID?: string) {
  return sessionID || HOME_KEY
}

export function previewHold(input: string, max = 56) {
  const line = input.trim().split(/\r?\n/)[0]?.replace(/\s+/g, " ") ?? ""
  if (line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

export function nextHoldId() {
  return `hold_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isHoldEntry(value: unknown): value is HoldEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as HoldEntry
  return typeof entry.id === "string" && typeof entry.input === "string" && Array.isArray(entry.parts)
}

export function parsePromptHold(text: string) {
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, HoldEntry[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      out[key] = value.filter(isHoldEntry).slice(-MAX_HOLD_ENTRIES)
    }
    return out
  } catch {
    return {}
  }
}

export function replaceHold(entries: HoldEntry[], id: string, prompt: PromptInfo) {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return
  return entries.map((entry, entryIndex) =>
    entryIndex === index
      ? {
          ...entry,
          input: prompt.input,
          parts: prompt.parts,
          mode: prompt.mode,
        }
      : entry,
  )
}

export function adoptHold(buckets: Record<string, HoldEntry[]>, from: string, to: string) {
  if (from === to) return buckets
  const moving = buckets[from] ?? []
  if (moving.length === 0) return buckets
  const next = {
    ...buckets,
    [to]: [...(buckets[to] ?? []), ...moving].slice(-MAX_HOLD_ENTRIES),
  }
  delete next[from]
  return next
}

/** True when the agent turn is finished — not mid-run, not waiting on a child. */
export function isTurnComplete(input: {
  status: string
  childStatuses: string[]
  lastUserCreated?: number
  lastFinishedAssistantCreated?: number
}) {
  if (input.status !== "idle") return false
  if (input.childStatuses.some((status) => status !== "idle")) return false
  if (input.lastUserCreated === undefined) return true
  if (input.lastFinishedAssistantCreated === undefined) return false
  return input.lastFinishedAssistantCreated >= input.lastUserCreated
}

export const { use: usePromptHold, provider: PromptHoldProvider } = createSimpleContext({
  name: "PromptHold",
  init: () => {
    const paths = useTuiPaths()
    const holdPath = path.join(paths.state, "prompt-queue.json")
    const [store, setStore] = createStore({ buckets: {} as Record<string, HoldEntry[]> })

    const persist = () => {
      writeText(holdPath, JSON.stringify(store.buckets)).catch(() => {})
    }

    onMount(async () => {
      const buckets = parsePromptHold(await readText(holdPath).catch(() => ""))
      setStore("buckets", buckets)
    })

    return {
      list(sessionKey: string) {
        return store.buckets[sessionKey] ?? []
      },
      push(sessionKey: string, prompt: PromptInfo) {
        const entry: HoldEntry = {
          ...structuredClone(unwrap(prompt)),
          id: nextHoldId(),
          timestamp: Date.now(),
        }
        setStore(
          produce((draft) => {
            const current = draft.buckets[sessionKey] ?? []
            draft.buckets[sessionKey] = [...current, entry].slice(-MAX_HOLD_ENTRIES)
          }),
        )
        persist()
        return entry
      },
      take(sessionKey: string) {
        const current = store.buckets[sessionKey] ?? []
        if (current.length === 0) return undefined
        const [entry, ...rest] = current
        setStore("buckets", sessionKey, rest)
        persist()
        return entry
      },
      remove(sessionKey: string, id: string) {
        const current = store.buckets[sessionKey] ?? []
        const next = current.filter((item) => item.id !== id)
        if (next.length === current.length) return undefined
        const removed = current.find((item) => item.id === id)
        setStore("buckets", sessionKey, next)
        persist()
        return removed
      },
      replace(sessionKey: string, id: string, prompt: PromptInfo) {
        const next = replaceHold(store.buckets[sessionKey] ?? [], id, prompt)
        if (!next) return false
        setStore("buckets", sessionKey, next)
        persist()
        return true
      },
      adopt(from: string, to: string) {
        const next = adoptHold(store.buckets, from, to)
        if (next === store.buckets) return
        setStore("buckets", next)
        persist()
      },
    }
  },
})
