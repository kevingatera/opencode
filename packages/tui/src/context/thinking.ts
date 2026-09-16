import { createMemo, type Setter } from "solid-js"
import { useKV } from "./kv"

export type ThinkingMode = "show" | "hide" | "brief"

const MODES: readonly ThinkingMode[] = ["show", "hide", "brief"] as const

// OpenAI's Responses API surfaces reasoning summaries that start with a bolded
// title block: "**Inspecting PR workflow**\n\n<body>". Treat that first block,
// or a complete title still awaiting its body while streaming, as disclosure
// metadata so the TUI can style its header independently from the markdown body.
// Closed-source evidence adds two more states: title-only blocks whose body
// never arrives (declared-unavailable once finalized, not streaming-pending),
// and zero-length blocks (redacted). Unstructured prose with no leading **
// renders as-is.
export type ReasoningKind = "empty" | "title-only" | "content"

export function reasoningSummary(text: string): { title: string | null; body: string; kind: ReasoningKind } {
  const content = text.trim()
  if (!content) return { title: null, body: "", kind: "empty" }
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (match) {
    const body = content.slice(match[0].length).trimEnd()
    if (!body) return { title: match[1].trim(), body: "", kind: "title-only" }
    return { title: match[1].trim(), body, kind: "content" }
  }
  if (content.startsWith("**") && !content.slice(2).includes("**"))
    return { title: content.slice(2).trim(), body: "", kind: "title-only" }
  return { title: null, body: content, kind: "content" }
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

// Cycle order matches the slash command: show → hide → brief → show.
// "brief" shows the cheap post-turn reasoning brief when one arrived,
// falling back to the raw block otherwise.
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function useThinkingMode() {
  const kv = useKV()
  // Capture pre-state before `kv.signal` seeds a default, so we can detect
  // first-time users with a legacy `thinking_visibility` boolean and migrate.
  // The KVProvider only renders children once kv.ready, so reads here are safe.
  const hadStored = kv.get("thinking_mode") !== undefined
  const legacy = kv.get("thinking_visibility")
  const [stored, setStored] = kv.signal<ThinkingMode>("thinking_mode", "hide")

  // The kv signal exposes its setter typed as `Setter<T>` which carries Solid's
  // overload set; passing an updater fn through a property access loses the
  // bivariance trick the existing `setX((prev) => ...)` callsites rely on.
  // Wrap it in a sane shape so consumers can just call `set(next)` or pass
  // an updater.
  const set = (next: ThinkingMode | ((prev: ThinkingMode) => ThinkingMode)) => {
    if (typeof next === "function") setStored(next as Setter<ThinkingMode>)
    else setStored(() => next)
  }

  // Preserve previous experience for users who had explicitly toggled the
  // legacy `thinking_visibility` boolean. First-time users (no legacy key)
  // get the new "hide" default (collapsed thinking).
  if (!hadStored) {
    if (legacy === true) set("show")
    else if (legacy === false) set("hide")
  }

  if ((stored() as string) === "minimal") set("hide")

  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "hide"
  })

  return {
    mode,
    set,
  }
}
