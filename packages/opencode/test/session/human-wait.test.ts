import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { HumanWait } from "@/session/human-wait"

const sessionID = SessionID.make("ses_test")

function runningTool(tool: string, start: number, wait?: number): SessionV1.ToolPart {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID: MessageID.ascending(),
    type: "tool",
    tool,
    callID: "call_1",
    state: { status: "running", input: {}, time: { start } },
    ...(wait === undefined ? {} : { metadata: { humanWaitMs: wait } }),
  }
}

describe("HumanWait", () => {
  test("identifies the real pure-wait tool ids", () => {
    expect(HumanWait.isHumanWaitOnlyTool("question")).toBeTrue()
    expect(HumanWait.isHumanWaitOnlyTool("plan_exit")).toBeTrue()
    expect(HumanWait.isHumanWaitOnlyTool("task")).toBeFalse()
    expect(HumanWait.isHumanWaitOnlyTool("bash")).toBeFalse()
  })

  test("accumulateWait adds to any tool part", () => {
    const part = runningTool("bash", 1000)
    const next = HumanWait.accumulateWait(part, 250.7)
    expect(next.metadata?.humanWaitMs).toBe(250)
    const again = HumanWait.accumulateWait(next, 100)
    expect(again.metadata?.humanWaitMs).toBe(350)
  })

  test("accumulateWait floors and ignores non-positive durations", () => {
    const part = runningTool("bash", 1000, 40)
    expect(HumanWait.accumulateWait(part, 0)).toBe(part)
    expect(HumanWait.accumulateWait(part, -10)).toBe(part)
    expect(HumanWait.accumulateWait(part, 0.4)).toBe(part)
    expect(HumanWait.accumulateWait(part, 10.9).metadata?.humanWaitMs).toBe(50)
  })

  test("finalizeWait resolves a pure-wait tool to its span", () => {
    const part = runningTool("question", 1000, 500)
    expect(HumanWait.finalizeWait(part, 7000).metadata?.humanWaitMs).toBe(6000)
  })

  test("finalizeWait keeps the larger recorded wait", () => {
    const part = runningTool("plan_exit", 1000, 9000)
    expect(HumanWait.finalizeWait(part, 2000).metadata?.humanWaitMs).toBe(9000)
  })

  test("finalizeWait leaves normal tools untouched", () => {
    const recorded = runningTool("bash", 1000, 500)
    expect(HumanWait.finalizeWait(recorded, 7000)).toBe(recorded)
    const absent = runningTool("task", 1000)
    expect(HumanWait.finalizeWait(absent, 7000)).toBe(absent)
    expect(absent.metadata).toBeUndefined()
  })
})
