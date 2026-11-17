import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { siblingConcurrencyPermission } from "../../src/permission/sibling"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const parent: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
const rules = siblingConcurrencyPermission()

// Runs the real shell tool up to its permission request, then stops before the
// command executes. Returns the sibling-rule verdict for each sub-command the
// tool asked about.
const verdicts = (command: string, directory?: string) =>
  Effect.gen(function* () {
    const tmp = directory ?? (yield* tmpdirScoped())
    return yield* Effect.gen(function* () {
      const stop = new Error("stop after permission")
      const patterns: string[] = []
      const tool = yield* (yield* ShellTool).init()
      yield* tool
        .execute(
          { command },
          {
            sessionID: SessionID.make("ses_sibling_shell"),
            messageID: MessageID.make("msg_sibling_shell"),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                if (req.permission === "bash") patterns.push(...req.patterns)
                throw stop
              }),
          },
        )
        .pipe(Effect.exit)
      return patterns.map((pattern) => ({ pattern, action: Permission.evaluate("bash", pattern, parent, rules).action }))
    }).pipe(provideInstance(tmp))
  })

describe("sibling rules via the shell tool's permission patterns", () => {
  it.live("allows read-only sed", () =>
    Effect.gen(function* () {
      for (const command of ["sed -n '/i /p' file", "sed -n '/ -i /p' f", "sed -n '1,5p' x", "sed -e 's/i/I/' f"]) {
        const result = yield* verdicts(command)
        expect(result).toEqual([{ pattern: command, action: "allow" }])
      }
    }),
  )

  it.live("denies in-place sed", () =>
    Effect.gen(function* () {
      for (const command of [
        "sed -i 's/a/b/' f",
        "sed -i.bak 's/a/b/' f",
        "sed --in-place=.bak 's/a/b/' f",
        "sed -e x -i f",
        "sed -ni p f",
        "sed -Ei 's/a/b/' f",
      ]) {
        const result = yield* verdicts(command)
        expect(result).toEqual([{ pattern: command, action: "deny" }])
      }
    }),
  )

  it.live("checks chained commands per sub-command", () =>
    Effect.gen(function* () {
      expect(yield* verdicts("cd sub && sed -n '/ -i /p' f")).toEqual([{ pattern: "sed -n '/ -i /p' f", action: "allow" }])
      expect(yield* verdicts("cd sub && sed -i 's/a/b/' f")).toEqual([{ pattern: "sed -i 's/a/b/' f", action: "deny" }])
    }),
  )

  it.live("denies sed whose options come from an expansion", () =>
    Effect.gen(function* () {
      for (const command of ['sed "$(printf -- -i)" s/a/b/ f', "sed $FLAGS f", "sed `echo -i` f", 'sed "-$X" f']) {
        const result = yield* verdicts(command)
        // Nested command substitutions are separate patterns; only the sed one matters here.
        expect(result.filter((item) => item.pattern.startsWith("sed "))).toEqual([
          { pattern: expect.stringContaining("sed "), action: "deny" },
        ])
      }
    }),
  )

  it.live("denies sed with an unquoted glob that expands to an option-like file name", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      // The shell would expand `*` to `-i.bak f`, so sed would edit `f` in place.
      yield* Effect.promise(() => Promise.all([Bun.write(`${tmp}/-i.bak`, ""), Bun.write(`${tmp}/f`, "a\n")]))
      const command = "sed -e 's/a/b/' *"
      const result = yield* verdicts(command, tmp)
      expect(result).toEqual([{ pattern: command, action: "deny" }])
      // Evaluation only: sed never runs, so the file is untouched.
      expect(yield* Effect.promise(() => Bun.file(`${tmp}/f`).text())).toBe("a\n")
    }),
  )

  it.live("denies sed whose option is hidden by a line continuation or locale quoting", () =>
    Effect.gen(function* () {
      for (const command of ["sed \\\n-i s/a/b/ f", "sed -\\\ni s/a/b/ f", 'sed "-\\\ni" x f', "sed\t-i x f", 'sed $"-i" x f']) {
        const result = yield* verdicts(command)
        // The tool hands over the command source, line break included.
        expect(result).toEqual([{ pattern: command, action: "deny" }])
      }
    }),
  )

  // bash keeps CR and VT inside the word: `sed -e x<VT>-e -i f` -> [-e][x<VT>-e][-i][f]
  it.live("denies sed whose in-place option sits behind a CR or VT inside a word", () =>
    Effect.gen(function* () {
      for (const command of ["sed -e 's/a/b/' foo\r-e -i f", "sed -e x\v-e -i f"]) {
        const result = yield* verdicts(command)
        expect(result.filter((item) => item.pattern.includes("sed"))).toEqual([
          { pattern: expect.stringContaining("sed"), action: "deny" },
        ])
      }
    }),
  )

  it.live("allows sed when a continuation, comment, or single-quoted backslash-newline hides nothing", () =>
    Effect.gen(function* () {
      for (const command of ["sed -n \\\n'1,5p' f", "sed -n p f # -i", "sed -n 'a\\\nb' f"]) {
        const result = yield* verdicts(command)
        expect(result.filter((item) => item.pattern.startsWith("sed"))).toEqual([
          { pattern: expect.stringContaining("sed"), action: "allow" },
        ])
      }
    }),
  )

  it.live("allows sed with single-quoted or double-quoted literal scripts", () =>
    Effect.gen(function* () {
      for (const command of ["sed -n '$p' f", 'sed -n "1,5p" f']) {
        expect(yield* verdicts(command)).toEqual([{ pattern: command, action: "allow" }])
      }
    }),
  )

  it.live("still denies rm", () =>
    Effect.gen(function* () {
      expect(yield* verdicts("rm x")).toEqual([{ pattern: "rm x", action: "deny" }])
    }),
  )
})
