import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { For, Match, Switch, Show, createMemo } from "solid-js"

export type DialogStatusProps = {}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()

  const session = createMemo(() => (route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined))

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const usage = createMemo(() => {
    const current = session()
    const messages = current ? (sync.data.message[current.id] ?? []) : []
    const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    const detail = last
      ? last.tokens
      : current?.tokens
        ? {
            input: current.tokens.input,
            output: current.tokens.output,
            reasoning: current.tokens.reasoning,
            cache: current.tokens.cache,
          }
        : undefined
    const modelInfo = last ? { providerID: last.providerID, id: last.modelID } : current?.model
    const model = modelInfo
      ? sync.data.provider.find((item) => item.id === modelInfo.providerID)?.models[modelInfo.id]
      : undefined
    const tokens = detail
      ? detail.input + detail.output + detail.reasoning + detail.cache.read + detail.cache.write
      : 0
    return {
      input: detail?.input ?? 0,
      output: detail?.output ?? 0,
      reasoning: detail?.reasoning ?? 0,
      cacheRead: detail?.cache.read ?? 0,
      cacheWrite: detail?.cache.write ?? 0,
      tokens,
      limit: model?.limit.context,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const tokensText = createMemo(() => {
    const u = usage()
    const parts = [`${u.input.toLocaleString()} in`, `${u.output.toLocaleString()} out`]
    if (u.reasoning > 0) parts.push(`${u.reasoning.toLocaleString()} reasoning`)
    if (u.cacheRead > 0) parts.push(`${u.cacheRead.toLocaleString()} cache read`)
    if (u.cacheWrite > 0) parts.push(`${u.cacheWrite.toLocaleString()} cache write`)
    return parts.join(" · ")
  })

  const contextText = createMemo(() => {
    const u = usage()
    if (!u.limit) return `${u.tokens.toLocaleString()} tokens`
    return `${u.tokens.toLocaleString()} / ${u.limit.toLocaleString()} tokens (${u.percent}%)`
  })

  const modelText = createMemo(() => {
    const s = session()
    if (!s?.model) return "unknown"
    const label = `${s.model.providerID}/${s.model.id}`
    return s.model.variant ? `${label} (${s.model.variant})` : label
  })

  const agentText = createMemo(() => session()?.agent ?? "unknown")

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={session()}>
        {(s) => (
          <box>
            <text fg={theme.text}>Session</text>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: theme.success }}>
                •
              </text>
              <text wrapMode="word" fg={theme.text}>
                <b>Model</b>{" "}
                <span style={{ fg: theme.textMuted }}>
                  {modelText()}
                  {s().agent ? ` · ${agentText()}` : ""}
                </span>
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: theme.success }}>
                •
              </text>
              <text wrapMode="word" fg={theme.text}>
                <b>Cost</b> <span style={{ fg: theme.textMuted }}>{money.format(s().cost ?? 0)}</span>
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: theme.success }}>
                •
              </text>
              <text wrapMode="word" fg={theme.text}>
                <b>Tokens</b> <span style={{ fg: theme.textMuted }}>{tokensText()}</span>
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: theme.success }}>
                •
              </text>
              <text wrapMode="word" fg={theme.text}>
                <b>Context</b> <span style={{ fg: theme.textMuted }}>{contextText()}</span>
              </text>
            </box>
          </box>
        )}
      </Show>
      <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
        <box>
          <text fg={theme.text}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.success,
                        failed: theme.error,
                        disabled: theme.textMuted,
                        needs_auth: theme.warning,
                        needs_client_registration: theme.error,
                      } as Record<string, typeof theme.success>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        Needs authentication (run: opencode mcp auth {key})
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val) => (val() as { error: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.success,
                      error: theme.error,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.text} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
        <box>
          <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <box>
          <text fg={theme.text}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
