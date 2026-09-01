import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "opencode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("temp globs cover the system temp directory and OpenCode tmp", () => {
    const globs = Global.tempGlobs()
    expect(globs).toContain(path.join(os.tmpdir(), "*"))
    expect(globs).toContain(path.join(Global.Path.tmp, "*"))
  })
})
