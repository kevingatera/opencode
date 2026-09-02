import { describe, expect, test } from "bun:test"
import { adoptHold, isTurnComplete, parsePromptHold, previewHold, replaceHold, type HoldEntry } from "../../src/prompt/hold"

const entry = (input: string, id = input): HoldEntry => ({
  id,
  input,
  parts: [],
  timestamp: 1,
})

describe("prompt hold", () => {
  test("previews the first line and truncates", () => {
    expect(previewHold("  hello\nworld  ")).toBe("hello")
    expect(previewHold("a".repeat(80), 10)).toBe(`${"a".repeat(9)}…`)
  })

  test("recovers a session-keyed later map", () => {
    expect(parsePromptHold("")).toEqual({})
    expect(parsePromptHold("not-json")).toEqual({})
    expect(parsePromptHold(JSON.stringify({ home: [entry("one")], ses_1: "bad" }))).toEqual({
      home: [entry("one")],
    })
  })

  test("adopts home later items onto a new session", () => {
    const buckets = {
      home: [entry("follow up")],
      ses_old: [entry("keep")],
    }
    expect(adoptHold(buckets, "home", "ses_new")).toEqual({
      ses_old: [entry("keep")],
      ses_new: [entry("follow up")],
    })
    expect(adoptHold(buckets, "home", "home")).toBe(buckets)
  })

  test("waits for the parent turn and child sessions to finish", () => {
    expect(
      isTurnComplete({
        status: "busy",
        childStatuses: [],
        lastUserCreated: 1,
        lastFinishedAssistantCreated: 2,
      }),
    ).toBe(false)
    expect(
      isTurnComplete({
        status: "idle",
        childStatuses: ["busy"],
        lastUserCreated: 1,
        lastFinishedAssistantCreated: 2,
      }),
    ).toBe(false)
    expect(
      isTurnComplete({
        status: "idle",
        childStatuses: [],
        lastUserCreated: 3,
        lastFinishedAssistantCreated: 2,
      }),
    ).toBe(false)
    expect(
      isTurnComplete({
        status: "idle",
        childStatuses: ["idle"],
        lastUserCreated: 1,
        lastFinishedAssistantCreated: 2,
      }),
    ).toBe(true)
  })

  test("replaces a queued entry in place", () => {
    const entries = [entry("one", "a"), entry("two", "b")]
    expect(replaceHold(entries, "b", { input: "two edited", parts: [] })).toEqual([
      entry("one", "a"),
      { ...entry("two", "b"), input: "two edited" },
    ])
    expect(replaceHold(entries, "missing", { input: "nope", parts: [] })).toBeUndefined()
  })
})
