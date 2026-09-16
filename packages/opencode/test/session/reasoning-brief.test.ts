import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Deferred, Effect, Layer, Schema } from "effect"
import path from "path"
import { Plugin } from "@/plugin"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "@/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelRouting } from "@/session/model-routing"
import {
  buildBriefInput,
  cleanBrief,
  isTitleOnlyReasoning,
  MAX_BRIEF_CHARS,
  MAX_REASONING_CHARS,
  requestBriefsForTurn,
  shouldRequestBrief,
  truncateReasoning,
  truncateText,
} from "@/session/reasoning-brief"

describe("reasoning_brief config", () => {
  test("decodes optional toggle with overrides", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({
      reasoning_brief: { enabled: true, max_output_tokens: 128, max_input_chars: 4000 },
    })
    expect(decoded.reasoning_brief?.enabled).toBe(true)
    expect(decoded.reasoning_brief?.max_output_tokens).toBe(128)
    expect(decoded.reasoning_brief?.max_input_chars).toBe(4000)
  })

  test("absent by default so behavior is unchanged", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({})
    expect(decoded.reasoning_brief).toBeUndefined()
  })
})

describe("truncateReasoning", () => {
  test("short text passes through unchanged", () => {
    expect(truncateReasoning("let me think")).toBe("let me think")
  })

  test("long text keeps head and tail with a marker", () => {
    const text = "h".repeat(4000) + "t".repeat(4000)
    const result = truncateReasoning(text)
    expect(result.length).toBe(MAX_REASONING_CHARS)
    expect(result).toContain("[...truncated...]")
    expect(result.startsWith("h".repeat(100))).toBe(true)
    expect(result.endsWith("t".repeat(100))).toBe(true)
  })

  test("boundary length passes through unchanged", () => {
    const text = "x".repeat(MAX_REASONING_CHARS)
    expect(truncateReasoning(text)).toBe(text)
  })
})

describe("truncateText", () => {
  test("caps at max chars with a marker", () => {
    const result = truncateText("abcdef", 4)
    expect(result.startsWith("abcd")).toBe(true)
    expect(result).toContain("[...truncated...]")
  })
})

describe("buildBriefInput", () => {
  test("carries task, answer, and reasoning sections with a token budget", () => {
    const input = buildBriefInput({
      task: "fix the login bug",
      answer: "fixed by resetting the token",
      reasoning: "the token expired",
      maxOutputTokens: 256,
    })
    expect(input).toContain("fix the login bug")
    expect(input).toContain("fixed by resetting the token")
    expect(input).toContain("the token expired")
    expect(input).toContain("256")
  })

  test("caps each section", () => {
    const input = buildBriefInput({
      task: "t".repeat(5000),
      answer: "a".repeat(5000),
      reasoning: "r".repeat(20000),
      maxOutputTokens: 256,
    })
    expect(input).toContain("t".repeat(1000))
    expect(input).not.toContain("t".repeat(1001))
    expect(input).toContain("[...truncated...]")
  })

  test("carries the skeleton labels and budgets", () => {
    const input = buildBriefInput({ task: "t", answer: "a", reasoning: "r", maxOutputTokens: 256 })
    expect(input).toContain("- Chose:")
    expect(input).toContain("- Rejected:")
    expect(input).toContain("- Uncertain:")
    expect(input).toContain("Rejected: not stated")
    expect(input).toContain("180")
    expect(input).toContain("500")
    expect(input).toContain("OUTCOMES")
  })
})

describe("cleanBrief", () => {
  test("strips think tags and blank lines", () => {
    expect(cleanBrief("<think>hmm</think>\n\n- decided X\n- decided Y\n")).toBe("- decided X\n- decided Y")
  })

  test("empty output stays empty", () => {
    expect(cleanBrief("   \n  ")).toBe("")
  })

  test("caps at the brief char budget", () => {
    const result = cleanBrief("w".repeat(1000))
    expect(result.length).toBe(MAX_BRIEF_CHARS)
    expect(result.endsWith("...")).toBe(true)
  })
})

describe("isTitleOnlyReasoning", () => {
  test("empty and redacted-only carry nothing committable", () => {
    expect(isTitleOnlyReasoning("")).toBe(true)
    expect(isTitleOnlyReasoning("   ")).toBe(true)
    expect(isTitleOnlyReasoning("[REDACTED]")).toBe(true)
  })

  test("complete title without body is title-only", () => {
    expect(isTitleOnlyReasoning("**Planning to close run-created tab cautiously**")).toBe(true)
  })

  test("unclosed title fragment is title-only", () => {
    expect(isTitleOnlyReasoning("**Planning to close run-created tab cautiously")).toBe(true)
  })

  test("title with a body stays committable", () => {
    expect(isTitleOnlyReasoning("**Inspecting PR workflow**\n\nChecked the merge queue.")).toBe(false)
  })

  test("unstructured prose stays committable", () => {
    expect(isTitleOnlyReasoning("Compared patch IDs via git cherry and separated them.")).toBe(false)
    expect(isTitleOnlyReasoning("**Important:** keep this in the body.")).toBe(false)
  })
})

describe("shouldRequestBrief", () => {
  test("disabled config never requests", () => {
    expect(shouldRequestBrief({ enabled: false, text: "some thinking" })).toBe(false)
  })

  test("empty reasoning never requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "   " })).toBe(false)
  })

  test("redacted-only reasoning never requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "[REDACTED]" })).toBe(false)
  })

  test("opaque reasoning with metadata never requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "", metadata: { signature: "abc" } })).toBe(false)
  })

  test("visible non-opaque reasoning requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "chose Postgres for JSONB" })).toBe(true)
  })

  test("title-only reasoning never requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "**Planning to close run-created tab cautiously**" })).toBe(
      false,
    )
    expect(shouldRequestBrief({ enabled: true, text: "**Planning to close run-created tab cautiously" })).toBe(false)
  })

  test("title with a body still requests", () => {
    expect(shouldRequestBrief({ enabled: true, text: "**Inspecting PR workflow**\n\nChecked the merge queue." })).toBe(
      true,
    )
  })
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

function makeMcp() {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed([]),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in reasoning-brief tests"),
      authenticate: () => Effect.die("unexpected MCP auth in reasoning-brief tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in reasoning-brief tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const briefRoot = LayerNode.group([
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  Storage.node,
  ModelRouting.node,
  Plugin.node,
  Database.node,
])

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the brief flow.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeText(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(llm.url) }))
  return { dir, llm }
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([briefRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
  ]),
)

function seedTurn(input: {
  sessionID: SessionID
  directory: string
  reasoning: { text: string; metadata?: Record<string, unknown> }
}) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: input.sessionID,
      type: "text",
      text: "Which database should I use for JSON documents?",
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID: input.sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: input.directory, root: input.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    })
    const reasoning = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "reasoning",
      text: input.reasoning.text,
      ...(input.reasoning.metadata === undefined ? {} : { metadata: input.reasoning.metadata }),
      time: { start: Date.now(), end: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: input.sessionID,
      type: "text",
      text: "Use Postgres with JSONB.",
    })
    return { user, assistant, reasoning }
  })
}

describe("requestBriefsForTurn end to end", () => {
  it.instance("publishes a live-only brief for visible reasoning", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        reasoning_brief: { enabled: true },
      }))
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Brief" })
      const { directory } = yield* TestInstance
      const seeded = yield* seedTurn({
        sessionID: chat.id,
        directory,
        reasoning: { text: "Postgres JSONB supports indexes; the workload is relational." },
      })
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("<thinking>"),
        "Decided on Postgres for indexed JSONB.",
      )
      const received = yield* Deferred.make<typeof SessionEvent.Reasoning.Brief.data.Type>()
      const off = yield* events.listen((event) => {
        if (event.type !== SessionEvent.Reasoning.Brief.type) return Effect.void
        const data = event.data as typeof SessionEvent.Reasoning.Brief.data.Type
        return Deferred.succeed(received, data)
      })
      yield* requestBriefsForTurn(chat.id)
      const brief = yield* awaitWithTimeout(Deferred.await(received), "brief never published")
      yield* off
      expect(brief.brief).toBe("Decided on Postgres for indexed JSONB.")
      expect(brief.sessionID).toBe(chat.id)
      expect(String(brief.assistantMessageID)).toBe(String(seeded.assistant.id))
      expect(brief.reasoningID).toBe(seeded.reasoning.id)
      expect(yield* llm.calls).toBe(1)
      const stored = yield* sessions.messages({ sessionID: chat.id })
      const storedReasoning = stored
        .flatMap((message) => message.parts)
        .find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
      expect(storedReasoning?.text).toBe("Postgres JSONB supports indexes; the workload is relational.")
      expect("brief" in (storedReasoning ?? {})).toBe(false)
    }),
  )

  it.instance("carries a prose wall through and publishes the skeleton verbatim", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        reasoning_brief: { enabled: true },
      }))
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({ title: "Wall" })
      const { directory } = yield* TestInstance
      const wall =
        "I'm skeptical of the unreplicated comparison, so I compared patch IDs via git cherry and separated them. " +
        "The first approach failed on the join path; that dead-end cost an hour before the indexed scan worked. " +
        "No fallback was evaluated yet."
      yield* seedTurn({ sessionID: chat.id, directory, reasoning: { text: wall } })
      const skeleton = [
        "- Chose: Comparing patch IDs → separated via git cherry",
        "- Rejected: not stated",
        "- Uncertain: join-path dead-end cost an hour; no fallback evaluated",
      ].join("\n")
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("<thinking>"), skeleton)
      const received = yield* Deferred.make<typeof SessionEvent.Reasoning.Brief.data.Type>()
      const off = yield* events.listen((event) => {
        if (event.type !== SessionEvent.Reasoning.Brief.type) return Effect.void
        const data = event.data as typeof SessionEvent.Reasoning.Brief.data.Type
        return Deferred.succeed(received, data)
      })
      yield* requestBriefsForTurn(chat.id)
      const brief = yield* awaitWithTimeout(Deferred.await(received), "brief never published")
      yield* off
      expect(brief.brief).toBe(skeleton)
      expect(yield* llm.calls).toBe(1)
      const inputs = yield* llm.inputs
      expect(inputs.some((body) => JSON.stringify(body).includes("unreplicated comparison"))).toBe(true)
    }),
  )

  it.instance("makes no LLM call when the toggle is off", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url) }))
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "NoBrief" })
      const { directory } = yield* TestInstance
      yield* seedTurn({
        sessionID: chat.id,
        directory,
        reasoning: { text: "Visible thinking that must not trigger a call." },
      })
      yield* requestBriefsForTurn(chat.id)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.instance("makes no LLM call for opaque reasoning", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        reasoning_brief: { enabled: true },
      }))
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Opaque" })
      const { directory } = yield* TestInstance
      yield* seedTurn({
        sessionID: chat.id,
        directory,
        reasoning: { text: "", metadata: { signature: "encrypted" } },
      })
      yield* requestBriefsForTurn(chat.id)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.instance("makes no LLM call for title-only reasoning", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        reasoning_brief: { enabled: true },
      }))
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "TitleOnly" })
      const { directory } = yield* TestInstance
      yield* seedTurn({
        sessionID: chat.id,
        directory,
        reasoning: { text: "**Planning to close run-created tab cautiously**" },
      })
      yield* requestBriefsForTurn(chat.id)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.instance("makes no LLM call for child sessions", () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        reasoning_brief: { enabled: true },
      }))
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({ parentID: root.id, agent: "general" })
      yield* requestBriefsForTurn(child.id)
      expect(yield* llm.calls).toBe(0)
    }),
  )
})
