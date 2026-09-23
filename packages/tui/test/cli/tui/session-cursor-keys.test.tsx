/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { KeyCodes } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { sessionCursorKeyLayer } from "../../../src/routes/session"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("session cursor-key navigation yields to the focused prompt editor", async () => {
  const ran: string[] = []
  let textarea: TextareaRenderable | undefined
  let latestKeymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    latestKeymap = keymap
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    const record = (name: string) => () => {
      ran.push(name)
    }
    const offCommands = keymap.registerLayer({
      commands: [
        { name: "session.child.next", run: record("next") },
        { name: "session.child.previous", run: record("previous") },
        { name: "session.parent", run: record("parent") },
        { name: "session.first", run: record("first") },
        { name: "session.last", run: record("last") },
      ],
      bindings: [],
    })
    const offCursorKeys = keymap.registerLayer(sessionCursorKeyLayer(config))
    onCleanup(() => {
      offCursorKeys()
      offCommands()
      off()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <textarea
          ref={(r: TextareaRenderable) => {
            textarea = r
            r.setText("hello")
            r.gotoBufferEnd()
            r.focus()
          }}
        />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const offset = () => textarea?.cursorOffset ?? -1

    app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(ran).toEqual([])
    expect(offset()).toBe(4)

    app.mockInput.pressArrow("right")
    await Bun.sleep(20)
    expect(ran).toEqual([])
    expect(offset()).toBe(5)

    app.mockInput.pressArrow("up")
    await Bun.sleep(20)
    expect(ran).toEqual([])
    expect(offset()).toBe(5)

    app.mockInput.pressKey(KeyCodes.HOME)
    await Bun.sleep(20)
    expect(ran).toEqual([])
    expect(offset()).toBe(0)

    app.mockInput.pressKey(KeyCodes.END)
    await Bun.sleep(20)
    expect(ran).toEqual([])
    expect(offset()).toBe(5)

    // The ctrl-bound variants of the same commands do not collide with editor keys.
    app.mockInput.pressKey("g", { ctrl: true })
    await Bun.sleep(20)
    expect(ran).toEqual(["first"])

    // With no focused editor the shared keys navigate again.
    ran.length = 0
    textarea?.blur()
    await Bun.sleep(20)
    app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(ran).toEqual(["previous"])

    // Footer mouse targets dispatch the command directly, without the key layer.
    if (!latestKeymap) throw new Error("expected keymap")
    ran.length = 0
    latestKeymap.dispatchCommand("session.child.next")
    await Bun.sleep(20)
    expect(ran).toEqual(["next"])
  } finally {
    app.renderer.destroy()
  }
})
