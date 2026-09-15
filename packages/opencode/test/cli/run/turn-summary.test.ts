import { describe, expect, test } from "bun:test"
import { messageTurnSummaryCommit } from "@/cli/cmd/run/turn-summary"
import type { SessionMessages } from "@/cli/cmd/run/session.shared"

function message(
  created: number,
  completed: number,
  parts: SessionMessages[number]["parts"],
): SessionMessages[number] {
  return {
    info: {
      id: "msg_123",
      sessionID: "ses_123",
      role: "assistant",
      agent: "build",
      modelID: "test-model",
      providerID: "test",
      mode: "",
      parentID: "msg_parent",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed },
    },
    parts,
  } as unknown as SessionMessages[number]
}

function waitedTool(wait: number): SessionMessages[number]["parts"][number] {
  return {
    id: "part_1",
    sessionID: "ses_123",
    messageID: "msg_123",
    type: "tool",
    callID: "call_1",
    tool: "question",
    state: {
      status: "completed",
      input: {},
      output: "answer",
      title: "Question",
      metadata: {},
      time: { start: 1000, end: 5000 },
    },
    metadata: { humanWaitMs: wait },
  } as unknown as SessionMessages[number]["parts"][number]
}

describe("messageTurnSummaryCommit", () => {
  test("subtracts recorded human wait", () => {
    const result = messageTurnSummaryCommit(message(1000, 6000, [waitedTool(2000)]))
    expect(result?.summary).toEqual({ agent: "Build", model: "test-model", duration: "3.0s" })
  })

  test("leaves machine time unchanged without recorded wait", () => {
    const result = messageTurnSummaryCommit(message(1000, 6000, []))
    expect(result?.summary?.duration).toBe("5.0s")
  })

  test("returns undefined when the corrected duration is zero or negative", () => {
    expect(messageTurnSummaryCommit(message(1000, 6000, [waitedTool(5000)]))).toBeUndefined()
    expect(messageTurnSummaryCommit(message(1000, 6000, [waitedTool(9000)]))).toBeUndefined()
  })
})
