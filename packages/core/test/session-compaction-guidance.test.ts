import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

const fresh = () => SessionCompaction.buildPrompt({ context: ["conversation history"] })
const update = () => SessionCompaction.buildPrompt({ context: ["new conversation"], previousSummary: "existing summary" })

test("summary prompt asks for path:line-range pointers to files the next step touches", () => {
  const prompt = fresh()

  expect(prompt).toContain("path:line-range")
  expect(prompt).toContain("so the next turn can read only that range")
  expect(prompt).toContain("do not invent line numbers")
})

test("summary prompt caps standing directives and quotes a subagent brief once", () => {
  const prompt = fresh()

  expect(prompt).toContain("at most ~1,500 characters in total")
  expect(prompt).toContain("capped at ~1,500 characters in total")
  expect(prompt).toContain("In a subagent session, quote the task brief once instead of restating it in every bullet")
})

test("summary prompt targets a 6-8K character summary", () => {
  expect(fresh()).toContain("Target ~6,000-8,000 characters for the whole summary")
})

test("summary prompt records loaded skills as not to be reloaded", () => {
  const prompt = fresh()

  expect(prompt).toContain('Record each skill already loaded in this session by name, marked "already loaded; do not reload"')
  expect(prompt).toContain("skills already loaded in this session by name")
})

test("update prompt carries the cap, loaded skills and line ranges forward", () => {
  const prompt = update()

  expect(prompt).toContain("the ~1,500-character cap forces out the least essential one")
  expect(prompt).toContain('Carry forward the skills already loaded, by name, marked "already loaded; do not reload"')
  expect(prompt).toContain("Keep the whole summary within ~6,000-8,000 characters")
})
