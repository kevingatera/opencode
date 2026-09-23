import { describe, expect, test } from "bun:test"
import { briefedSummary, reasoningSummary, resolveThinkingBriefAction } from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
      kind: "content",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
      kind: "title-only",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
      kind: "content",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
      kind: "content",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only.", kind: "content" })
  })

  test("marks an unclosed title-only block as title-only, not streaming prose", () => {
    expect(reasoningSummary("**Planning to close run-created tab cautiously")).toEqual({
      title: "Planning to close run-created tab cautiously",
      body: "",
      kind: "title-only",
    })
  })

  test("marks zero-length blocks as empty", () => {
    expect(reasoningSummary("")).toEqual({ title: null, body: "", kind: "empty" })
    expect(reasoningSummary("   \n  ")).toEqual({ title: null, body: "", kind: "empty" })
  })

  test("renders unstructured Claude prose as-is", () => {
    const wall =
      "I'm skeptical of the unreplicated comparison. The first approach failed on the join path, so I went with the indexed scan instead."
    expect(reasoningSummary(wall)).toEqual({ title: null, body: wall, kind: "content" })
  })
})

describe("briefedSummary", () => {
  test("keeps the raw title and shows the brief as the body", () => {
    expect(briefedSummary("**Inspecting database state**\n\nChecked the merge queue.", "Decided on Postgres.")).toEqual(
      {
        title: "Inspecting database state",
        body: "Decided on Postgres.",
        kind: "content",
      },
    )
  })

  test("falls back to the raw summary when no brief arrived", () => {
    const raw = "**Inspecting database state**\n\nChecked the merge queue."
    expect(briefedSummary(raw, undefined)).toEqual({
      title: "Inspecting database state",
      body: "Checked the merge queue.",
      kind: "content",
    })
  })

  test("treats a blank brief as no brief", () => {
    expect(briefedSummary("Details only.", "   ")).toEqual({
      title: null,
      body: "Details only.",
      kind: "content",
    })
  })
})

describe("resolveThinkingBriefAction", () => {
  test("maps on and off to display plus forward", () => {
    expect(resolveThinkingBriefAction("on", "hide")).toEqual({ display: "brief", forward: "on" })
    expect(resolveThinkingBriefAction("OFF", "brief")).toEqual({ display: "hide", forward: "off" })
  })

  test("status forwards without touching display", () => {
    expect(resolveThinkingBriefAction("status", "brief")).toEqual({ display: null, forward: "status" })
  })

  test("bare input toggles", () => {
    expect(resolveThinkingBriefAction("", "brief")).toEqual({ display: "hide", forward: "off" })
    expect(resolveThinkingBriefAction("", "hide")).toEqual({ display: "brief", forward: "on" })
    expect(resolveThinkingBriefAction("", "show")).toEqual({ display: "brief", forward: "on" })
  })

  test("unknown input forwards untouched for the server usage reply", () => {
    expect(resolveThinkingBriefAction("maybe", "hide")).toEqual({ display: null, forward: "maybe" })
  })
})
