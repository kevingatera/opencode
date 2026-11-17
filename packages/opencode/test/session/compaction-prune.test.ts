import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session as SessionNs } from "@/session/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const env = AppNodeBuilder.build(
  LayerNode.group([
    SessionCompaction.node,
    SessionNs.node,
    SessionProjector.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [Provider.node, ProviderTest.fake({ model: ProviderTest.model({ id: ref.modelID, providerID: ref.providerID }) }).layer],
    [SessionProcessor.node, Layer.mock(SessionProcessor.Service, {})],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ],
)

const it = testEffect(env)

// Token.estimate is chars / 4 and PRUNE_PROTECT is 40K tokens, so this fits inside the protect
// window and anything older than it is eligible for pruning.
const PROTECT_FILLER = 150_000
// Alone this clears PRUNE_MINIMUM (20K tokens); two of them are more than enough.
const BULK = 100_000
// ProviderTest.model has a 200K window and 10K max output, so 190K is usable and pruning waits
// until the last step reported at least half of that (95K).
const OVER_THRESHOLD = 120_000
const UNDER_THRESHOLD = 10_000

type Seed = {
  callID: string
  tool: string
  input?: Record<string, unknown>
  chars: number
  metadata?: Record<string, unknown>
  output?: string
  status?: "completed" | "error"
}

// Parts are written oldest first. The last one is the protect-window filler: the newest output
// is always kept, so everything before it is judged by the prune policy.
const filler: Seed = { callID: "filler", tool: "bash", input: { command: "./watch.sh" }, chars: PROTECT_FILLER }

// contextTokens is the usage the last assistant step reported, which the prune gate compares
// against the model's usable window.
function seedSession(dir: string, seeds: Seed[], contextTokens = OVER_THRESHOLD) {
  return Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const info = yield* sessions.create({})
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: info.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: info.id,
      type: "text",
      text: "first",
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID: info.id,
      mode: "build",
      agent: "build",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { input: contextTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: user.id,
      time: { created: Date.now() },
      finish: "end_turn",
    })
    for (const seed of seeds) {
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: info.id,
        type: "tool",
        callID: seed.callID,
        tool: seed.tool,
        state:
          seed.status === "error"
            ? {
                status: "error",
                input: seed.input ?? {},
                error: "x".repeat(seed.chars),
                time: { start: Date.now(), end: Date.now() },
              }
            : {
                status: "completed",
                input: seed.input ?? {},
                output: seed.output ?? "x".repeat(seed.chars),
                title: seed.tool,
                metadata: seed.metadata ?? {},
                time: { start: Date.now(), end: Date.now() },
              },
      })
    }
    // prune skips the two most recent user turns
    for (const text of ["second", "third"]) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: info.id,
        type: "text",
        text,
      })
    }
    return info.id
  })
}

// callIDs of the tool parts that prune cleared
function clearedCalls(sessionID: SessionID) {
  return SessionNs.Service.use((sessions) => sessions.messages({ sessionID })).pipe(
    Effect.map((msgs) =>
      msgs
        .flatMap((msg) => msg.parts)
        .flatMap((part) =>
          part.type === "tool" && part.state.status === "completed" && part.state.time.compacted !== undefined
            ? [part.callID]
            : [],
        ),
    ),
  )
}

describe("session.compaction.prune policy", () => {
  it.live(
    "runs by default and clears old bulk while keeping edits, errors and failing test output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
          { callID: "old-edit", tool: "edit", input: { filePath: "/repo/big.ts" }, chars: BULK },
          { callID: "old-error", tool: "bash", input: { command: "make" }, chars: BULK, status: "error" },
          {
            callID: "old-failing-test",
            tool: "bash",
            input: { command: "bun test" },
            chars: BULK,
            metadata: { exit: 1 },
            output: `${"x".repeat(BULK)}\n(fail) suite > case\n 1 fail`,
          },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual(["old-read"])
      }),
    ),
  )

  it.live(
    "does nothing when compaction.prune is false",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessionID = yield* seedSession(dir, [
            { callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
            filler,
          ])

          yield* SessionCompaction.use.prune({ sessionID })

          expect(yield* clearedCalls(sessionID)).toEqual([])
        }),
      { config: { compaction: { prune: false } } },
    ),
  )

  it.live(
    "never clears edit, write, apply_patch, task or skill results",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
          { callID: "old-edit", tool: "edit", chars: BULK },
          { callID: "old-write", tool: "write", chars: BULK },
          { callID: "old-patch", tool: "apply_patch", chars: BULK },
          { callID: "old-task", tool: "task", chars: BULK },
          { callID: "old-skill", tool: "skill", chars: BULK },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual(["old-read"])
      }),
    ),
  )

  it.live(
    "clears bulky shell dumps and passing checks but keeps a failing typecheck",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "git-show", tool: "bash", input: { command: "git show abc123" }, chars: BULK },
          { callID: "sed-dump", tool: "bash", input: { command: "sed -n '1,400p' src/a.ts" }, chars: BULK },
          { callID: "webfetch", tool: "webfetch", input: { url: "https://example.com" }, chars: BULK },
          {
            callID: "passing-test",
            tool: "bash",
            input: { command: "bun test test/a.test.ts" },
            chars: BULK,
            metadata: { exit: 0 },
          },
          {
            callID: "failing-typecheck",
            tool: "bash",
            input: { command: "bun typecheck" },
            chars: BULK,
            metadata: { exit: 2 },
            output: `${"x".repeat(BULK)}\nsrc/a.ts(1,1): error TS2322: nope`,
          },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        expect((yield* clearedCalls(sessionID)).toSorted()).toEqual([
          "git-show",
          "passing-test",
          "sed-dump",
          "webfetch",
        ])
      }),
    ),
  )

  it.live(
    "clears bulky families before other outputs when bulk alone frees enough",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "old-build", tool: "bash", input: { command: "./build.sh" }, chars: BULK },
          { callID: "newer-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        // the older build log would be first in age order, but the newer bulky read goes instead
        expect(yield* clearedCalls(sessionID)).toEqual(["newer-read"])
      }),
    ),
  )

  it.live(
    "clears other outputs oldest first only to cover what bulk did not free",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "older-build", tool: "bash", input: { command: "./build.sh" }, chars: 60_000 },
          { callID: "newer-build", tool: "bash", input: { command: "./deploy.sh" }, chars: 60_000 },
          { callID: "small-read", tool: "read", input: { filePath: "/repo/a.ts" }, chars: 40_000 },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        // 10K bulky tokens < PRUNE_MINIMUM, so the older build log is added; that reaches 25K
        expect((yield* clearedCalls(sessionID)).toSorted()).toEqual(["older-build", "small-read"])
      }),
    ),
  )

  it.live(
    "keeps the output of any failed shell command, not only failed checks",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
          { callID: "failed-build", tool: "bash", input: { command: "./build.sh" }, chars: BULK, metadata: { exit: 1 } },
          { callID: "failed-make", tool: "bash", input: { command: "make all" }, chars: BULK, metadata: { exit: 2 } },
          { callID: "failed-dump", tool: "bash", input: { command: "cat missing.txt" }, chars: BULK, metadata: { exit: 1 } },
          { callID: "ok-build", tool: "bash", input: { command: "./build.sh" }, chars: 1_000, metadata: { exit: 0 } },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual(["old-read"])
      }),
    ),
  )

  it.live(
    "waits while the last step used under half of the usable window",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(
          dir,
          [{ callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK }, filler],
          UNDER_THRESHOLD,
        )

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual([])
      }),
    ),
  )

  it.live(
    "prunes bulk once the last step used at least half of the usable window",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(
          dir,
          [{ callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK }, filler],
          OVER_THRESHOLD,
        )

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual(["old-read"])
      }),
    ),
  )

  it.live(
    "does nothing when OPENCODE_DISABLE_PRUNE is set, through the real config path",
    provideTmpdirInstance((dir) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Flag.OPENCODE_DISABLE_PRUNE
          Flag.OPENCODE_DISABLE_PRUNE = true
          return previous
        }),
        () =>
          Effect.gen(function* () {
            const sessionID = yield* seedSession(dir, [
              { callID: "old-read", tool: "read", input: { filePath: "/repo/big.ts" }, chars: BULK },
              filler,
            ])

            yield* SessionCompaction.use.prune({ sessionID })

            expect(yield* clearedCalls(sessionID)).toEqual([])
          }),
        (previous) =>
          Effect.sync(() => {
            Flag.OPENCODE_DISABLE_PRUNE = previous
          }),
      ),
    ),
  )

  it.live(
    "leaves everything when the freeable total is under PRUNE_MINIMUM",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionID = yield* seedSession(dir, [
          { callID: "small-read", tool: "read", input: { filePath: "/repo/a.ts" }, chars: 40_000 },
          filler,
        ])

        yield* SessionCompaction.use.prune({ sessionID })

        expect(yield* clearedCalls(sessionID)).toEqual([])
      }),
    ),
  )
})

describe("pruned tool output stub", () => {
  test("read stub names path, range and size", () => {
    expect(MessageV2.prunedToolStub("read", { filePath: "packages/x/y.ts", offset: 1, limit: 400 }, 12_000)).toBe(
      "[Pruned: read packages/x/y.ts lines 1-400 (12K chars). Re-read with offset/limit if needed]",
    )
  })

  test("read stub without a range says nothing about lines", () => {
    expect(MessageV2.prunedToolStub("read", { filePath: "a.ts" }, 900)).toBe(
      "[Pruned: read a.ts (900 chars). Re-read with offset/limit if needed]",
    )
    expect(MessageV2.prunedToolStub("read", { filePath: "a.ts", offset: 200 }, 5_000)).toBe(
      "[Pruned: read a.ts from line 200 (5K chars). Re-read with offset/limit if needed]",
    )
  })

  test("bash stub quotes the command, flattened and clipped", () => {
    expect(MessageV2.prunedToolStub("bash", { command: "git show abc123" }, 18_000)).toBe(
      '[Pruned: bash "git show abc123" (18K chars)]',
    )
    const stub = MessageV2.prunedToolStub("bash", { command: `echo\n${"a".repeat(300)}` }, 18_000)
    expect(stub).toStartWith('[Pruned: bash "echo aaaa')
    expect(stub).toContain("…")
    expect(stub.length).toBeLessThan(200)
  })

  test("bash stub points at the saved full output when the tool kept one", () => {
    expect(
      MessageV2.prunedToolStub("bash", { command: "git show abc" }, 16_000, {
        truncated: true,
        outputPath: "/home/u/.local/share/opencode/tool-output/tool_abc123",
      }),
    ).toBe(
      '[Pruned: bash "git show abc" (16K chars). Full output: /home/u/.local/share/opencode/tool-output/tool_abc123 — read it with offset/limit]',
    )
  })

  test("webfetch stub prefers the saved path over the refetch hint", () => {
    expect(
      MessageV2.prunedToolStub("webfetch", { url: "https://example.com/a" }, 41_000, { outputPath: "/tmp/tool_x" }),
    ).toBe("[Pruned: webfetch https://example.com/a (41K chars). Full output: /tmp/tool_x — read it with offset/limit]")
  })

  test("long saved paths lose their middle, not their file name, and the stub stays short", () => {
    const path = `/Users/someone/${"deeply/".repeat(30)}tool-output/tool_abc123`
    const stub = MessageV2.prunedToolStub("bash", { command: `git log ${"--oneline ".repeat(40)}` }, 16_000, {
      outputPath: path,
    })
    expect(stub).toContain("…")
    expect(stub).toContain("tool-output/tool_abc123")
    expect(stub).toStartWith("[Pruned: bash \"git log --oneline")
    expect(stub.length).toBeLessThan(250)
  })

  test("metadata without a saved path adds nothing", () => {
    expect(MessageV2.prunedToolStub("bash", { command: "ls" }, 2_000, { exit: 0, truncated: false })).toBe(
      '[Pruned: bash "ls" (2K chars)]',
    )
  })

  test("falls back to tool name and size when the input has nothing to cite", () => {
    expect(MessageV2.prunedToolStub("mystery", {}, 3_000)).toBe("[Pruned: mystery output (3K chars)]")
  })

  test("replay shows the stub for compacted outputs instead of the old placeholder", async () => {
    const sessionID = SessionID.make("session")
    const userID = "msg_user"
    const assistantID = "msg_assistant"
    const part = (id: string) => ({ id: PartID.make(`prt_${id}`), sessionID, messageID: MessageID.make(assistantID) })
    const model = {
      id: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, input: 0, output: 0 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    } satisfies Provider.Model
    const input = [
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "user",
          model: { providerID: model.providerID, modelID: model.id },
          tools: {},
          mode: "",
        },
        parts: [{ ...part("u"), messageID: MessageID.make(userID), type: "text", text: "go" }],
      },
      {
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          time: { created: 0 },
          parentID: userID,
          modelID: model.api.id,
          providerID: model.providerID,
          mode: "",
          agent: "agent",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: ["read", "bash"].map((tool) => ({
          ...part(tool),
          type: "tool",
          callID: `call-${tool}`,
          tool,
          state: {
            status: "completed",
            input:
              tool === "read"
                ? { filePath: "packages/x/y.ts", offset: 1, limit: 400 }
                : { command: "git show abc123" },
            output: "z".repeat(tool === "read" ? 12_000 : 18_000),
            title: tool,
            metadata: tool === "bash" ? { truncated: true, outputPath: "/tmp/tool_saved" } : {},
            time: { start: 0, end: 1, compacted: 1 },
          },
        })),
      },
    ] as unknown as SessionV1.WithParts[]

    const result = JSON.stringify(await MessageV2.toModelMessages(input, model))

    expect(result).toContain("[Pruned: read packages/x/y.ts lines 1-400 (12K chars). Re-read with offset/limit if needed]")
    expect(result).toContain(
      '[Pruned: bash \\"git show abc123\\" (18K chars). Full output: /tmp/tool_saved — read it with offset/limit]',
    )
    expect(result).not.toContain("Old tool result content cleared")
    expect(result).not.toContain("zzzz")
  })
})
