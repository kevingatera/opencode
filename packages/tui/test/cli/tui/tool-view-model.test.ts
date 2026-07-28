import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { toolViewModel } from "../../../src/util/tool-view-model"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("tool view model", () => {
  test("synthesizes edit diffs from provider-shaped input", () => {
    const view = toolViewModel({
      tool: "edit",
      input: {
        path: "src/app.ts",
        old_string: "old\n",
        new_string: "new\n",
      },
    })

    expect(view.metadata.diff).toContain("--- src/app.ts")
    expect(view.metadata.diff).toContain("-old")
    expect(view.metadata.diff).toContain("+new")
  })

  test("offsets synthetic edit diff line numbers when current file contains the replacement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-tool-view-"))
    tempDirs.push(dir)
    const file = path.join(dir, "docs.md")
    const prefix = Array.from({ length: 52 }, (_, i) => `line ${i + 1}`).join("\n")
    await writeFile(file, `${prefix}\nnew paragraph\n`, "utf8")

    const view = toolViewModel({
      tool: "edit",
      input: {
        path: file,
        old_string: "old paragraph\n",
        new_string: "new paragraph\n",
      },
    })

    expect(view.metadata.diff).toContain("@@ -53,1 +53,1 @@")
  })

  test("uses filediff patches for write tools", () => {
    const view = toolViewModel({
      tool: "write",
      input: { filePath: "src/app.ts", content: "new\n" },
      metadata: { filediff: { patch: "diff content" } },
    })

    expect(view.metadata.diff).toBe("diff content")
  })

  test("synthesizes write diffs only when older history identifies a new file", () => {
    const added = toolViewModel({
      tool: "write",
      input: { path: "src/new.ts", content: "new\n" },
      metadata: { exists: false },
    })
    const overwritten = toolViewModel({
      tool: "write",
      input: { path: "src/existing.ts", content: "new\n" },
      metadata: { exists: true },
    })

    expect(added.metadata.diff).toContain("--- src/new.ts")
    expect(added.metadata.diff).toContain("+new")
    expect(overwritten.metadata.diff).toBeUndefined()
  })

  test("classifies shell sed reads with cd prefixes as read tool views", () => {
    const view = toolViewModel({
      tool: "bash",
      input: {
        command:
          "$ cd /Users/GateraKe/sources/opencode && sed -n '19820,19835p' packages/opencode/node_modules/@opentui/core/index-3fq5hq97.js",
      },
    })

    expect(view.name).toBe("read")
    expect(view.input.filePath).toBe(
      "/Users/GateraKe/sources/opencode/packages/opencode/node_modules/@opentui/core/index-3fq5hq97.js",
    )
    expect(view.input.offset).toBe(19820)
    expect(view.input.limit).toBe(16)
    expect(view.filePath).toBe(
      "/Users/GateraKe/sources/opencode/packages/opencode/node_modules/@opentui/core/index-3fq5hq97.js",
    )
  })

  test("classifies common read-only shell commands from session history", () => {
    const cat = toolViewModel({ tool: "bash", input: { command: "cat package.json" } })
    const rg = toolViewModel({ tool: "bash", input: { command: 'rg -n "toolViewModel" packages/opencode/src' } })
    const grep = toolViewModel({ tool: "shell", input: { command: 'grep -n "renderSelf" index.js | head -5' } })
    const ls = toolViewModel({ tool: "bash", input: { command: "cd /tmp && ls -la fixtures" } })
    const redirectedCat = toolViewModel({
      tool: "bash",
      input: { command: "cat /Users/GateraKe/sources/AUT_Data_Insights/fastapi/TODO.md 2>/dev/null | head -200" },
    })

    expect(cat.name).toBe("read")
    expect(cat.input.filePath).toBe("package.json")
    expect(redirectedCat.name).toBe("read")
    expect(redirectedCat.input.filePath).toBe("/Users/GateraKe/sources/AUT_Data_Insights/fastapi/TODO.md")
    expect(rg.name).toBe("grep")
    expect(rg.input.pattern).toBe("toolViewModel")
    expect(rg.input.path).toBe("packages/opencode/src")
    expect(grep.name).toBe("grep")
    expect(grep.input.pattern).toBe("renderSelf")
    expect(grep.input.path).toBe("index.js")
    expect(ls.name).toBe("list")
    expect(ls.input.path).toBe("/tmp/fixtures")
  })

  test("classifies shell file discovery commands only when they map directly to glob", () => {
    const find = toolViewModel({ tool: "bash", input: { command: "find src -name '*.ts' | head -5" } })
    const fd = toolViewModel({ tool: "bash", input: { command: "fd -g '*.tsx' packages/opencode/src" } })
    const rgFiles = toolViewModel({ tool: "bash", input: { command: "rg --files -g '*.json' packages/opencode" } })
    const ambiguousRgFiles = toolViewModel({ tool: "bash", input: { command: "rg --files packages/opencode" } })
    const ambiguousFind = toolViewModel({
      tool: "bash",
      input: { command: "find . -name '*.ts' -o -name '*.tsx' | head -10" },
    })

    expect(find.name).toBe("glob")
    expect(find.input.pattern).toBe("*.ts")
    expect(find.input.path).toBe("src")
    expect(fd.name).toBe("glob")
    expect(fd.input.pattern).toBe("*.tsx")
    expect(fd.input.path).toBe("packages/opencode/src")
    expect(rgFiles.name).toBe("glob")
    expect(rgFiles.input.pattern).toBe("*.json")
    expect(rgFiles.input.path).toBe("packages/opencode")
    expect(ambiguousRgFiles.name).toBe("bash")
    expect(ambiguousFind.name).toBe("bash")
  })

  test("keeps non-read shell commands as shell views", () => {
    const view = toolViewModel({ tool: "bash", input: { command: "bun test && git status --short" } })
    const outputRedirect = toolViewModel({ tool: "bash", input: { command: "cat package.json > package.copy.json" } })
    const nonReadPipeline = toolViewModel({
      tool: "bash",
      input: { command: "cat package.json | python3 -m json.tool" },
    })

    expect(view.name).toBe("bash")
    expect(view.input.command).toBe("bun test && git status --short")
    expect(outputRedirect.name).toBe("bash")
    expect(nonReadPipeline.name).toBe("bash")
  })

  test("normalizes general-purpose task history to general", () => {
    const view = toolViewModel({
      tool: "task",
      input: { description: "probe sweep", subagent_type: "general-purpose" },
    })

    expect(view.name).toBe("task")
    expect(view.input.subagent_type).toBe("general")
  })
})
