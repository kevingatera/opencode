import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { readdir, rm } from "node:fs/promises"
import path from "path"
import {
  GoalPlugin,
  goalPath as pluginGoalPath,
  setGoal,
  setGoalStatus,
  stopGoalForError,
} from "opencode-goal-plugin/server"

const touched = new Set<string>()
const goalDir = path.dirname(pluginGoalPath("ses_goal_dir_probe"))

function goalPath(sessionID: string, track = true) {
  if (track) touched.add(sessionID)
  return pluginGoalPath(sessionID)
}

function ctx(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function message(input: { input: number; output: number; reasoning?: number }) {
  return {
    info: {
      role: "assistant",
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning ?? 0,
      },
    },
  }
}

async function plugin(messages: ReturnType<typeof message>[] = [], prompts: unknown[] = []) {
  return GoalPlugin({
    client: {
      session: {
        messages: async () => ({ data: messages }),
        promptAsync: async (input: unknown) => {
          prompts.push(input)
          return { data: true }
        },
      },
    },
  } as unknown as PluginInput)
}

function parse(result: ToolResult) {
  const output = typeof result === "string" ? result : result.output
  return JSON.parse(output) as {
    goal: {
      sessionID: string
      objective: string
      status: string
      tokenBudget: number | null
      tokensUsed: number
    } | null
    remainingTokens: number | null
    completionBudgetReport: string | null
  }
}

afterEach(async () => {
  await Promise.all(
    (await readdir(goalDir).catch(() => []))
      .filter((file) => file.startsWith("ses_goal_") && file.endsWith(".json"))
      .map((file) => rm(path.join(goalDir, file), { force: true })),
  )
  touched.clear()
})

describe("goal plugin", () => {
  test("creates, reads, and completes a goal", async () => {
    const sessionID = "ses_goal_create"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    const created = parse(await hooks.tool!.create_goal.execute({ objective: "Ship goal support" }, ctx(sessionID)))
    expect(created.goal?.objective).toBe("Ship goal support")
    expect(created.goal?.status).toBe("active")

    const current = parse(await hooks.tool!.get_goal.execute({}, ctx(sessionID)))
    expect(current.goal?.sessionID).toBe(sessionID)

    const completed = parse(await hooks.tool!.update_goal.execute({ status: "complete" }, ctx(sessionID)))
    expect(completed.goal?.status).toBe("complete")
  })

  test("rejects a second unfinished goal", async () => {
    const sessionID = "ses_goal_unfinished"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "First" }, ctx(sessionID))

    await expect(hooks.tool!.create_goal.execute({ objective: "Second" }, ctx(sessionID))).rejects.toThrow(
      "unfinished goal",
    )
  })

  test("marks an active goal budget limited from message token usage", async () => {
    const sessionID = "ses_goal_budget"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "Spend carefully", token_budget: 10 }, ctx(sessionID))
    const withUsage = await plugin([message({ input: 8, output: 7 })])
    const output = { system: [] as string[] }

    await withUsage["experimental.chat.system.transform"]!({ sessionID, model: {} as never }, output)

    expect(output.system.join("\n")).toContain("token budget")
    const current = parse(await withUsage.tool!.get_goal.execute({}, ctx(sessionID)))
    expect(current.goal?.status).toBe("budgetLimited")
    expect(current.remainingTokens).toBe(0)
  })

  test("does not inject continuation for paused or complete goals", async () => {
    const sessionID = "ses_goal_paused"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "Pause me" }, ctx(sessionID))
    await setGoalStatus(sessionID, "paused", 0)

    const pausedOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as never }, pausedOutput)
    expect(pausedOutput.system).toEqual([])

    await setGoalStatus(sessionID, "complete", 0)
    const completeOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as never }, completeOutput)
    expect(completeOutput.system).toEqual([])
  })

  test("replaces a complete goal as fresh work", async () => {
    const sessionID = "ses_goal_replace_complete"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "Old goal" }, ctx(sessionID))
    const withUsage = await plugin([message({ input: 10, output: 5 })])
    const complete = parse(await withUsage.tool!.update_goal.execute({ status: "complete" }, ctx(sessionID)))
    expect(complete.goal?.tokensUsed).toBe(15)

    const next = await setGoal({
      sessionID,
      objective: "New goal",
      tokenBudget: 100,
      totalTokens: 15,
    })

    expect(next.objective).toBe("New goal")
    expect(next.status).toBe("active")
    expect(next.tokensUsed).toBe(0)
    expect(next.baselineTokens).toBe(15)
  })

  test("marks active goals blocked after non-abort session errors", async () => {
    const sessionID = "ses_goal_error"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "Handle errors" }, ctx(sessionID))
    await stopGoalForError({
      sessionID,
      error: { name: "UnknownError", data: { message: "provider failed" } },
      totalTokens: 0,
    })

    const current = parse(await hooks.tool!.get_goal.execute({}, ctx(sessionID)))
    expect(current.goal?.status).toBe("blocked")
  })

  test("marks active goals usage limited after usage limit errors", async () => {
    const sessionID = "ses_goal_usage_limit"
    await rm(goalPath(sessionID), { force: true })
    const hooks = await plugin()

    await hooks.tool!.create_goal.execute({ objective: "Hit limit" }, ctx(sessionID))
    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            name: "APIError",
            data: {
              message: "Usage limit reached",
              responseBody: "GoUsageLimitError",
            },
          },
        },
      },
    } as never)

    const current = parse(await hooks.tool!.get_goal.execute({}, ctx(sessionID)))
    expect(current.goal?.status).toBe("usageLimited")
  })

  test("continues active goals after session idle", async () => {
    const sessionID = "ses_goal_idle"
    await rm(goalPath(sessionID), { force: true })
    const prompts: unknown[] = []
    const hooks = await plugin([], prompts)

    await hooks.tool!.create_goal.execute({ objective: "Keep going" }, ctx(sessionID))
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as never)

    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0])).toContain("Continue working toward the active session goal")

    await setGoalStatus(sessionID, "paused", 0)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as never)
    expect(prompts).toHaveLength(1)
  })
})
