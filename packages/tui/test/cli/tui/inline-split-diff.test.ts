import { describe, expect, test } from "bun:test"
import {
  buildInlineSplitDiffRows,
  splitDiffLineNumberWidth,
  wordHighlightRanges,
} from "../../../src/util/inline-split-diff"

describe("inline split diff", () => {
  test("pairs replacement lines into one aligned row", () => {
    const rows = buildInlineSplitDiffRows(`--- a/docs.md
+++ b/docs.md
@@ -42 +42 @@
-**Facility record querying and matching** -- Queries City Facilities.
+**Facility record querying and matching**: Queries City Facilities.`)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.left.lineNumber).toBe(42)
    expect(rows[0]?.right.lineNumber).toBe(42)
    expect(rows[0]?.left.type).toBe("remove")
    expect(rows[0]?.right.type).toBe("add")
    expect(rows[0]?.left.segments.some((segment) => segment.text.includes("--") && segment.changed)).toBe(true)
    expect(rows[0]?.right.segments.some((segment) => segment.text === ":" && segment.changed)).toBe(true)
    expect(rows[0]?.left.segments.some((segment) => segment.text.includes("Queries") && segment.changed)).toBe(false)
    expect(rows[0]?.right.segments.some((segment) => segment.text.includes("Queries") && segment.changed)).toBe(false)
  })

  test("keeps shared replacement text unhighlighted around punctuation edits", () => {
    const rows = buildInlineSplitDiffRows(`--- a/docs/ottawa-gis-api-integration.md
+++ b/docs/ottawa-gis-api-integration.md
@@ -149 +149 @@
-## How It Works  --  Ward & Councillor Lookup
+## How It Works: Ward & Councillor Lookup
@@ -1 +1 @@
-  └─► Return: "Ward 14 Somerset  --  Councillor: Ariel Troster (link)"
+  └─► Return: "Ward 14 Somerset: Councillor: Ariel Troster (link)"`)

    expect(rows).toHaveLength(2)
    expect(rows[0]?.left.segments.some((segment) => segment.text.includes("--") && segment.changed)).toBe(true)
    expect(rows[0]?.right.segments.some((segment) => segment.text === ":" && segment.changed)).toBe(true)
    expect(rows[0]?.left.segments.some((segment) => segment.text.includes("How It Works") && segment.changed)).toBe(
      false,
    )
    expect(
      rows[0]?.right.segments.some((segment) => segment.text.includes("Ward & Councillor") && segment.changed),
    ).toBe(false)
    expect(rows[1]?.left.segments.some((segment) => segment.text.includes("--") && segment.changed)).toBe(true)
    expect(rows[1]?.right.segments.some((segment) => segment.text === ":" && segment.changed)).toBe(true)
    expect(rows[1]?.left.segments.some((segment) => segment.text.includes("Ariel Troster") && segment.changed)).toBe(
      false,
    )
    expect(rows[1]?.right.segments.some((segment) => segment.text.includes("Ariel Troster") && segment.changed)).toBe(
      false,
    )
  })

  test("keeps one-sided changes on one visual row with an empty opposite side", () => {
    const rows = buildInlineSplitDiffRows(`--- a/app.ts
+++ b/app.ts
@@ -10,0 +11 @@
+const value = 1`)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.left.type).toBe("empty")
    expect(rows[0]?.right.type).toBe("add")
    expect(rows[0]?.right.lineNumber).toBe(11)
  })

  test("keeps matching context lines on one row after right-side insertions", () => {
    const rows = buildInlineSplitDiffRows(
      [
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,2 +1,3 @@",
        " function before()",
        "+function inserted()",
        " function after()",
      ].join("\n"),
    )

    expect(rows).toHaveLength(3)
    expect(rows[0]?.left.lineNumber).toBe(1)
    expect(rows[0]?.right.lineNumber).toBe(1)
    expect(rows[1]?.left.type).toBe("empty")
    expect(rows[1]?.right.type).toBe("add")
    expect(rows[2]?.left.lineNumber).toBe(2)
    expect(rows[2]?.right.lineNumber).toBe(3)
  })

  test("treats identical replacement lines as context", () => {
    const rows = buildInlineSplitDiffRows(
      [
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,3 +1,4 @@",
        " unchanged",
        "-function same() {",
        "+function same() {",
        "+function inserted()",
        " function after()",
      ].join("\n"),
    )

    expect(rows).toHaveLength(4)
    expect(rows[1]?.left.type).toBe("context")
    expect(rows[1]?.right.type).toBe("context")
    expect(rows[1]?.left.lineNumber).toBe(2)
    expect(rows[1]?.right.lineNumber).toBe(2)
    expect(rows[2]?.left.type).toBe("empty")
    expect(rows[2]?.right.type).toBe("add")
    expect(rows[3]?.left.lineNumber).toBe(3)
    expect(rows[3]?.right.lineNumber).toBe(4)
  })

  test("highlights only removed tokens on the left when a word is deleted", () => {
    const rows = buildInlineSplitDiffRows(
      ["--- a/f.py", "+++ b/f.py", "@@ -9,1 +9,1 @@", "-if not args.json_only:", "+if args.json_only:"].join("\n"),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.left.segments.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["not"])
    expect(rows[0]?.right.segments.some((segment) => segment.changed)).toBe(false)
  })

  test("keeps the next context line on one row after a one-line to multiline replacement", () => {
    const rows = buildInlineSplitDiffRows(
      [
        "--- a/run.py",
        "+++ b/run.py",
        "@@ -28,4 +28,5 @@",
        ' parser.add_argument("--start", type=int, default=0)',
        '-parser.add_argument("--count", type=int, default=len(STANDARD_PROBES))',
        "+parser.add_argument(",
        '+    "--count", type=int, default=len(STANDARD_PROBES), help="Number of probes.")',
        " parser.add_argument(",
        '     "--output", type=str, default="data/generated/quality_audit_full.jsonl")',
      ].join("\n"),
    )

    const openerRow = rows.find(
      (row) =>
        row.left.lineNumber === 30 &&
        row.right.lineNumber === 31 &&
        row.left.segments.some((segment) => segment.text.includes("parser.add_argument(")),
    )
    const outputRow = rows.find(
      (row) =>
        row.left.lineNumber === 31 &&
        row.right.lineNumber === 32 &&
        row.left.segments.some((segment) => segment.text.includes('"--output"')),
    )
    expect(openerRow?.left.type).toBe("context")
    expect(openerRow?.right.type).toBe("context")
    expect(outputRow?.left.type).toBe("context")
    expect(outputRow?.right.type).toBe("context")
    expect(rows.indexOf(outputRow!)).toBe(rows.indexOf(openerRow!) + 1)
  })

  test("merges adjacent changed words into one highlight range", () => {
    const rows = buildInlineSplitDiffRows(`--- a/app.ts
+++ b/app.ts
@@ -1 +1 @@
-alpha beta gamma
+alpha delta epsilon`)

    const left = rows[0]?.left.segments ?? []
    expect(left.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(["beta gamma"])
    expect(wordHighlightRanges(left)).toEqual([[6, 16]])
  })

  test("skips word highlights when most of the line changed", () => {
    const rows = buildInlineSplitDiffRows(`--- a/app.ts
+++ b/app.ts
@@ -1 +1 @@
-a aaaaaaaaaaaaa
+a ccccccccccccc`)

    expect(wordHighlightRanges(rows[0]?.left.segments ?? [])).toEqual([])
    expect(wordHighlightRanges(rows[0]?.right.segments ?? [])).toEqual([])
  })

  test("uses the largest line number width across both panes", () => {
    const rows = buildInlineSplitDiffRows(`--- a/app.ts
+++ b/app.ts
@@ -9 +100 @@
-old
+new`)

    expect(splitDiffLineNumberWidth(rows)).toBe(3)
  })
})
