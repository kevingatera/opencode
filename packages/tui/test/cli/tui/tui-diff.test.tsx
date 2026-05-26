/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { TuiDiff } from "../../../src/component/tui-diff"

test("split diff keeps wrapped replacement rows aligned", async () => {
  const app = await testRender(
    () => (
      <TuiDiff
        diff={`--- a/docs.md
+++ b/docs.md
@@ -63 +63 @@
-- **Facility type resolution** -- Maps a user's natural-language request to a canonical facility type using a bilingual alias table.
+- **Facility type resolution**: Maps a user's natural-language request to a canonical facility type using a bilingual alias table.`}
        view="split"
        splitWidth={80}
        showLineNumbers
        width="100%"
        wrapMode="word"
        fg={RGBA.fromHex("#ffffff")}
        addedBg={RGBA.fromHex("#003300")}
        removedBg={RGBA.fromHex("#330000")}
        contextBg={RGBA.fromHex("#000000")}
        addedSignColor={RGBA.fromHex("#00ff00")}
        removedSignColor={RGBA.fromHex("#ff0000")}
        lineNumberFg={RGBA.fromHex("#888888")}
        lineNumberBg={RGBA.fromHex("#000000")}
        addedLineNumberBg={RGBA.fromHex("#002200")}
        removedLineNumberBg={RGBA.fromHex("#220000")}
        highlightAddedBg={RGBA.fromHex("#004400")}
        highlightRemovedBg={RGBA.fromHex("#440000")}
      />
    ),
    { width: 80, height: 12 },
  )

  try {
    await app.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()

    const lines = app.captureCharFrame().split("\n")
    const first = lines.find((line) => line.includes("63 --"))
    const continuation = lines.find((line) => line.includes("natural-language"))

    expect(first).toContain("63 +-")
    expect(continuation?.match(/natural-language/g)).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})
