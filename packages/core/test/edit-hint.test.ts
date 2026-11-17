import { describe, expect, test } from "bun:test"
import { EditHint } from "@opencode-ai/core/tool/edit-hint"

const large = (count: number) => Array.from({ length: count }, (_, index) => `const value${index} = compute(index${index})`)

describe("EditHint.nearestRegion", () => {
  test("returns a bounded hint for a 100-line search on a 100k-line file, in well under a second", () => {
    const lines = large(100_000)
    const target = 70_000
    lines[target + 3] = "export function resolveCustomerRecordByIdentifier(identifier, options) {"
    const content = lines.join("\n")
    const search = [
      "export function resolveCustomerRecordByIdentifer(identifier, options) {",
      ...Array.from({ length: 99 }, (_, index) => `const filler${index} = unrelated${index}(${index})`),
    ].join("\n")

    const started = performance.now()
    const hint = EditHint.nearestRegion(content, search)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(1500)
    expect(hint).toBeDefined()
    // Points near the right region: the hint's line range includes the real target line.
    const header = hint!.split("\n")[0]
    const range = header.match(/lines (\d+)-(\d+)/)
    expect(range).not.toBeNull()
    const first = Number(range![1])
    const last = Number(range![2])
    expect(first).toBeLessThanOrEqual(target + 4)
    expect(last).toBeGreaterThanOrEqual(target + 4)
  })

  test("keeps the hint under 1500 characters and never cuts a line", () => {
    const content = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(300)}`).join("\n")
    const hint = EditHint.nearestRegion(content, "line 50 " + "x".repeat(300))!

    expect(hint.length).toBeLessThanOrEqual(1500)
    for (const row of hint.split("\n").slice(1)) {
      expect(row).toMatch(/^\d+: line \d+ x+$/)
    }
  })

  test("points to an over-long matching line instead of showing any part of it", () => {
    const longLine = `needle ${"y".repeat(5000)}`
    const content = ["alpha", longLine, "omega"].join("\n")
    const hint = EditHint.nearestRegion(content, "needle yyy")!

    expect(hint.length).toBeLessThan(1500)
    expect(hint).toBe(
      `Closest match is line 2 (${longLine.length} chars, too long to show). Read it with offset=2 limit=1.`,
    )
    expect(hint).not.toContain("needle yyy")
    expect(hint).not.toContain("yyyy")
    expect(hint).not.toContain("…")
  })

  test("returns undefined when nothing in the file shares a word with the search", () => {
    expect(EditHint.nearestRegion("alpha beta\ngamma", "zzzz qqqq")).toBeUndefined()
  })
})
