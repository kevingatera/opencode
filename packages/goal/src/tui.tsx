/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import {
  clearGoal,
  readGoal,
  remainingTokens,
  setGoal,
  setGoalStatus,
  type Goal,
  type GoalStatus,
} from "./server"

const id = "opencode-goal-plugin"

function sessionID(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session") return
  const sessionID = current.params?.sessionID
  if (typeof sessionID !== "string") return
  return sessionID
}

function usage(goal: Goal) {
  if (goal.tokenBudget) return `${goal.tokensUsed}/${goal.tokenBudget}`
  if (goal.tokensUsed > 0) return goal.tokensUsed.toLocaleString()
  return ""
}

function statusLabel(status: GoalStatus) {
  if (status === "budgetLimited") return "budget limited"
  if (status === "usageLimited") return "usage limited"
  return status
}

async function totalTokens(api: TuiPluginApi, sessionID: string) {
  const messages = await api.client.session
    .messages({ sessionID, limit: 1000 }, { throwOnError: true })
    .then((result) => result.data ?? [])
  return messages.reduce((sum, message) => {
    if (message.info.role !== "assistant") return sum
    const tokens = message.info.tokens
    return sum + (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
  }, 0)
}

async function load(_api: TuiPluginApi, sessionID: string) {
  return readGoal(sessionID)
}

function setObjective(api: TuiPluginApi, sessionID: string, objective: string, goal?: Goal) {
  return totalTokens(api, sessionID)
    .then((tokens) =>
      setGoal({
        sessionID,
        objective,
        tokenBudget: goal?.status === "complete" ? undefined : goal?.tokenBudget,
        totalTokens: tokens,
      }),
    )
    .then((result) => {
      api.ui.toast({ variant: "success", message: `Goal ${statusLabel(result.status)}` })
    })
    .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
}

function goalFooter(goal: Goal) {
  return [usage(goal), remainingTokens(goal) !== undefined ? `${remainingTokens(goal)} left` : undefined]
    .filter(Boolean)
    .join(" ")
}

function edit(api: TuiPluginApi, sessionID: string, goal?: Goal) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={goal?.status === "complete" ? "Start new goal" : goal ? "Edit goal" : "Set goal"}
      placeholder="Goal objective"
      value={goal?.objective}
      onConfirm={(value) => {
        const objective = value.trim()
        if (!objective) {
          api.ui.toast({ variant: "error", message: "Goal objective is required" })
          return
        }

        void setObjective(api, sessionID, objective, goal).then(() => show(api))
      }}
    />
  ))
}

function setBudget(api: TuiPluginApi, sessionID: string, goal: Goal) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title="Set goal budget"
      placeholder="Token budget"
      value={goal.tokenBudget?.toString()}
      onConfirm={(value) => {
        const tokenBudget = Number.parseInt(value.trim(), 10)
        if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
          api.ui.toast({ variant: "error", message: "Goal budget must be a positive integer" })
          return
        }

        void totalTokens(api, sessionID)
          .then((tokens) => setGoal({ sessionID, objective: goal.objective, tokenBudget, totalTokens: tokens }))
          .then(() => show(api))
          .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
      }}
    />
  ))
}

function clear(api: TuiPluginApi, sessionID: string) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogConfirm
      title="Clear goal"
      message="Clear the current session goal?"
      onConfirm={() => {
        void clearGoal(sessionID)
          .then(() => show(api))
          .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
      }}
    />
  ))
}

function show(api: TuiPluginApi) {
  if (!sessionID(api)) {
    api.ui.toast({ variant: "warning", message: "Open a session before setting a goal" })
    return
  }
  const currentSessionID = sessionID(api)!

  void load(api, currentSessionID)
    .then((goal) => {
      const goalComplete = goal?.status === "complete"
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title={goal ? `Goal: ${statusLabel(goal.status)}` : "Goal"}
          placeholder={goal?.objective}
          options={[
            {
              title: goalComplete ? "Start new goal" : goal ? "Edit objective" : "Set goal",
              value: "edit",
              description: goal?.objective,
              footer: goal ? goalFooter(goal) : undefined,
              onSelect: () => edit(api, currentSessionID, goal),
            },
            ...(goal && !goalComplete
              ? [
                  {
                    title: goal.status === "active" ? "Pause" : "Resume",
                    value: "toggle",
                    description: goal.status === "active" ? "Pause automatic continuation" : "Resume as active",
                    onSelect: () => {
                      void totalTokens(api, currentSessionID)
                        .then((tokens) =>
                          setGoalStatus(currentSessionID, goal.status === "active" ? "paused" : "active", tokens),
                        )
                        .then(() => show(api))
                        .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
                    },
                  },
                  {
                    title: "Set token budget",
                    value: "budget",
                    description: goal.tokenBudget ? `${goal.tokenBudget} tokens` : undefined,
                    onSelect: () => setBudget(api, currentSessionID, goal),
                  },
                  {
                    title: "Mark blocked",
                    value: "blocked",
                    onSelect: () => {
                      void totalTokens(api, currentSessionID)
                        .then((tokens) => setGoalStatus(currentSessionID, "blocked", tokens))
                        .then(() => show(api))
                        .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
                    },
                  },
                  {
                    title: "Mark complete",
                    value: "complete",
                    onSelect: () => {
                      void totalTokens(api, currentSessionID)
                        .then((tokens) => setGoalStatus(currentSessionID, "complete", tokens))
                        .then(() => show(api))
                        .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
                    },
                  },
                  {
                    title: "Clear",
                    value: "clear",
                    onSelect: () => clear(api, currentSessionID),
                  },
                ]
              : []),
            ...(goalComplete
              ? [
                  {
                    title: "Clear",
                    value: "clear",
                    onSelect: () => clear(api, currentSessionID),
                  },
                ]
              : []),
          ]}
        />
      ))
    })
    .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
}

function setInline(api: TuiPluginApi, objective: string) {
  if (!sessionID(api)) {
    api.ui.toast({ variant: "warning", message: "Open a session before setting a goal" })
    return
  }
  const currentSessionID = sessionID(api)!
  const trimmed = objective.trim()
  if (!trimmed) {
    show(api)
    return
  }

  void load(api, currentSessionID)
    .then((goal) => setObjective(api, currentSessionID, trimmed, goal))
    .catch((error) => api.ui.toast({ variant: "error", message: String(error) }))
}

function Indicator(props: { api: TuiPluginApi; sessionID: string }) {
  const [goal, setGoal] = createSignal<Goal>()

  createEffect(() => {
    void load(props.api, props.sessionID)
      .then(setGoal)
      .catch(() => setGoal(undefined))
  })

  return (
    <Show when={goal()}>
      {(item) => (
        <text fg={props.api.theme.current.textMuted}>
          {["goal:" + statusLabel(item().status), usage(item())].filter(Boolean).join(" ")}
        </text>
      )}
    </Show>
  )
}

type SlashCommandContext = {
  payload?: unknown
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "goal.set",
        title: "Set goal",
        desc: "Create or update the active session goal",
        category: "Session",
        namespace: "palette",
        slashName: "goal",
        run(ctx: SlashCommandContext) {
          const payload = ctx.payload
          const args =
            payload && typeof payload === "object" && "args" in payload && typeof payload.args === "string"
              ? payload.args
              : ""
          if (args.trim()) {
            setInline(api, args)
            return
          }
          show(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("goal.palette", ["goal.set"]),
  })
  api.slots.register({
    order: 80,
    slots: {
      session_prompt_right(_ctx, props) {
        return <Indicator api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin = {
  id,
  tui,
}

export default plugin
