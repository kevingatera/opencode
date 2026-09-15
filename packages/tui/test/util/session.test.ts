import { describe, expect, test } from "bun:test"
import { isDefaultTitle, subagentElapsedMs, toolWaitMs, turnElapsedMs } from "../../src/util/session"
import type { Part } from "@opencode-ai/sdk/v2"

function tool(id: string, start: number, wait?: number): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: `call_${id}`,
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: "run",
      metadata: {},
      time: { start, end: start + 10 },
    },
    ...(wait === undefined ? {} : { metadata: { humanWaitMs: wait } }),
  }
}

function text(id: string): Part {
  return { id, sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" }
}

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  describe("toolWaitMs", () => {
    test("returns zero for non-tool, pending, and wait-free parts", () => {
      expect(toolWaitMs(text("p1"))).toBe(0)
      expect(toolWaitMs(tool("p2", 100))).toBe(0)
      const pending: Part = {
        id: "p3",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "call_p3",
        tool: "question",
        state: { status: "pending", input: {}, raw: "" },
      }
      expect(toolWaitMs(pending)).toBe(0)
      expect(toolWaitMs(tool("p4", 100, 250))).toBe(250)
    })
  })

  describe("turnElapsedMs", () => {
    test("subtracts waits across every message in the turn", () => {
      const elapsed = turnElapsedMs({
        start: 1000,
        completed: 6000,
        parts: [[tool("a", 1100, 2000)], [tool("b", 2000), text("c")]],
      })
      expect(elapsed).toBe(3000)
    })

    test("leaves machine time unchanged when no wait is recorded", () => {
      const elapsed = turnElapsedMs({ start: 1000, completed: 6000, parts: [[tool("a", 1100)]] })
      expect(elapsed).toBe(5000)
    })

    test("returns zero without completion and clamps negative spans", () => {
      expect(turnElapsedMs({ start: 1000, completed: undefined, parts: [[tool("a", 1100, 5)]] })).toBe(0)
      expect(turnElapsedMs({ start: 1000, completed: 6000, parts: [[tool("a", 1100, 9000)]] })).toBe(0)
    })
  })

  describe("subagentElapsedMs", () => {
    test("resumed task excludes the earlier run", () => {
      const elapsed = subagentElapsedMs({
        partStart: 5000,
        firstUserCreated: 1000,
        lastCompleted: 7000,
        parts: [tool("old", 1100, 3000), tool("new", 5100, 500)],
      })
      expect(elapsed).toBe(1500)
    })

    test("background-style run without user messages uses part start and child completion", () => {
      const elapsed = subagentElapsedMs({
        partStart: 5000,
        firstUserCreated: undefined,
        lastCompleted: 7000,
        parts: [tool("a", 5100, 500)],
      })
      expect(elapsed).toBe(1500)
    })

    test("only waits since part start are subtracted", () => {
      const elapsed = subagentElapsedMs({
        partStart: 5000,
        firstUserCreated: 4000,
        lastCompleted: 7000,
        parts: [tool("old", 4100, 1000), tool("new", 5100, 500)],
      })
      expect(elapsed).toBe(1500)
    })

    test("returns zero without completion or when the end precedes the start", () => {
      expect(
        subagentElapsedMs({ partStart: 5000, firstUserCreated: 1000, lastCompleted: undefined, parts: [] }),
      ).toBe(0)
      expect(subagentElapsedMs({ partStart: 8000, firstUserCreated: 1000, lastCompleted: 7000, parts: [] })).toBe(
        0,
      )
      expect(
        subagentElapsedMs({
          partStart: 5000,
          firstUserCreated: 5000,
          lastCompleted: 6000,
          parts: [tool("a", 5100, 5000)],
        }),
      ).toBe(0)
    })
  })
})
