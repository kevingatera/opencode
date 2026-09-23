import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:session-routing-scope"

export type RoutingScope = "same" | "curated"

// Durable routing state lives in backend Storage under ["model_routing", rootSessionID].
// The backend attaches a structured snapshot to every /routing control reply as part
// metadata under "opencode.routing": { scope: "same" | "curated", rootSessionID, anchor }.
// This badge reads that payload from the newest /routing control message in the loaded
// messages. Limits: it only sees control messages within the message pages the TUI has
// loaded, so scope changed by another client, paged out of the window, or written by a
// server without the structured payload is not shown. No payload anywhere means the
// badge stays hidden (fail silent).
export function routingScope(
  messages: ReadonlyArray<Message>,
  parts: (messageID: string) => ReadonlyArray<Part>,
): RoutingScope | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue
    for (const part of parts(message.id)) {
      if (part.type !== "text" || part.metadata?.["opencode.control"] !== "routing") continue
      const payload = part.metadata?.["opencode.routing"]
      if (!payload || typeof payload !== "object") continue
      const scope = (payload as { scope?: unknown }).scope
      if (scope === "same" || scope === "curated") return scope
    }
  }
  return
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const messages = createMemo(() => props.api.state.session.messages(props.session_id))
  const scope = createMemo(() => routingScope(messages(), (messageID) => props.api.state.part(messageID)))

  return (
    <Show when={scope()}>
      {(value) => <text flexShrink={0} fg={theme().textMuted}>route: {value()}</text>}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
