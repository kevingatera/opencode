import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:session-routing-scope"

export type RoutingScope = "same" | "curated"

// Durable routing state lives in backend Storage under ["model_routing", rootSessionID]
// with no HTTP read path yet, so this badge derives the scope from the newest /routing
// control message the backend persisted for the session: a synthetic assistant message
// whose text part carries metadata { "opencode.control": "routing" } and starts with
// "Legacy model routing: same|curated". Staleness limits: the badge only updates when a
// /routing command runs in the visible session and only within the message pages the
// TUI has loaded, so scope set by another client or paged out of the window is not
// shown. Servers without the /routing feature never emit these messages, so the badge
// stays hidden (fail silent).
export function routingScope(
  messages: ReadonlyArray<Message>,
  parts: (messageID: string) => ReadonlyArray<Part>,
): RoutingScope | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue
    for (const part of parts(message.id)) {
      if (part.type !== "text" || part.metadata?.["opencode.control"] !== "routing") continue
      const scope = part.text.match(/^Legacy model routing: (same|curated)$/m)?.[1]
      if (scope) return scope as RoutingScope
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
