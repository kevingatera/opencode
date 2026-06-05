import { writeSync } from "node:fs"
import type { CliRenderer } from "@opentui/core"

// Disable every mouse-tracking mode (normal, button, any-motion, SGR, urxvt),
// focus reporting, and bracketed paste, then show the cursor. Mirrors what
// opentui's native core emits on destroy so a signal-killed process does not
// leave the parent shell receiving mouse reports.
const RESTORE_TERMINAL =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?25h"

export function restoreTerminalModes() {
  try {
    writeSync(1, RESTORE_TERMINAL)
  } catch {}
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) {
    restoreTerminalModes()
    return
  }
  renderer.destroy()
  restoreTerminalModes()
}
