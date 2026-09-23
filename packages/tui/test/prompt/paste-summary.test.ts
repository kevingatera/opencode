import { describe, expect, test } from "bun:test"
import { shouldCollapsePastedText } from "../../src/component/prompt/index"

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

describe("paste summary threshold", () => {
  test("short pastes stay expanded", () => {
    expect(shouldCollapsePastedText(lines(2), true)).toBe(false)
    // Three-line snippets collapsed under the old (lineCount >= 3) rule.
    expect(shouldCollapsePastedText(lines(3), true)).toBe(false)
  })

  test("exactly-at-threshold pastes stay expanded", () => {
    expect(shouldCollapsePastedText(lines(8), true)).toBe(false)
    expect(shouldCollapsePastedText("a".repeat(500), true)).toBe(false)
    expect(shouldCollapsePastedText("a".repeat(150), true)).toBe(false)
  })

  test("past long pastes still collapse", () => {
    expect(shouldCollapsePastedText(lines(9), true)).toBe(true)
    // Single long lines (URLs/tokens) collapse on length alone.
    expect(shouldCollapsePastedText("a".repeat(501), true)).toBe(true)
  })

  test("toggle-off overrides everything", () => {
    expect(shouldCollapsePastedText(lines(9), false)).toBe(false)
    expect(shouldCollapsePastedText("a".repeat(501), false)).toBe(false)
    expect(shouldCollapsePastedText(lines(20), false)).toBe(false)
  })

  test("empty and whitespace pastes stay expanded", () => {
    expect(shouldCollapsePastedText("", true)).toBe(false)
    expect(shouldCollapsePastedText("   ", true)).toBe(false)
  })
})
