import { describe, expect, test } from "bun:test"
import { resolveDiffView } from "../../../src/util/diff-view"

describe("resolveDiffView", () => {
  test("uses split for wide short diffs", () => {
    expect(
      resolveDiffView({
        diffStyle: "auto",
        width: 160,
      }),
    ).toBe("split")
  })

  test("uses unified for stacked diffs", () => {
    expect(
      resolveDiffView({
        diffStyle: "stacked",
        width: 160,
      }),
    ).toBe("unified")
  })

  test("uses unified below the split width", () => {
    expect(resolveDiffView({ diffStyle: "auto", width: 80 })).toBe("unified")
  })

  test("keeps split decisions independent of line wrapping", () => {
    expect(resolveDiffView({ diffStyle: "auto", width: 160 })).toBe("split")
  })
})
