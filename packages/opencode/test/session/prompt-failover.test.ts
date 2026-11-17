import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelRouting } from "@/session/model-routing"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const a1 = {
  providerID: ProviderV2.ID.make("route-a"),
  modelID: ModelV2.ID.make("m1"),
}
const b3 = {
  providerID: ProviderV2.ID.make("route-b"),
  modelID: ModelV2.ID.make("m3"),
}

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
      startAuth: () => Effect.die("unexpected MCP auth in failover tests"),
      authenticate: () => Effect.die("unexpected MCP auth in failover tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in failover tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
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
  ModelRouting.node,
  Storage.node,
])

function makeHttp() {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  return LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
  ])
}

const it = testEffect(makeHttp())

function routeProvider(url: string, name: string, models: string[]) {
  return {
    name,
    id: name,
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: Object.fromEntries(
      models.map((id) => [
        id,
        {
          id,
          name: id,
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      ]),
    ),
    options: { apiKey: "test-key", baseURL: url },
  }
}

const useServerConfig = Effect.fn("test.useServerConfig")(function* (
  config: (url: string) => Record<string, unknown>,
) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    `${dir}/opencode.json`,
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config(llm.url) }),
  )
  return { dir, llm }
})

function serverConfig(url: string, candidates: string[], routing: Record<string, unknown> = {}) {
  return {
    enabled_providers: ["route-a", "route-b"],
    model_routing: { scope: "curated", roles: { build: candidates }, ...routing },
    provider: {
      "route-a": routeProvider(url, "route-a", ["m1", "m2"]),
      "route-b": routeProvider(url, "route-b", ["m3"]),
    },
  }
}

const missingSession = () =>
  httpError(400, { error: { message: "Request is missing x-opencode-session header" } })

const chunk = (delta: unknown) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta }],
})

// A mid-stream provider error chunk: the AI SDK surfaces chunks already
// received (so partial text/tool parts persist on the failed message) and
// then fails the stream with a non-retryable error.
const errorChunk = {
  error: {
    message: "Request is missing x-opencode-session header",
    type: "invalid_request_error",
    code: "invalid_prompt",
  },
}

const failAfter = (...tail: unknown[]) =>
  raw({
    head: [chunk({ role: "assistant" })],
    tail,
  })

const failAfterText = (text: string) => failAfter(chunk({ content: text }), errorChunk)

const failAfterTool = (name: string, args: unknown) =>
  failAfter(
    chunk({
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    errorChunk,
  )

it.instance("fails over to the next candidate on a non-retryable provider error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Failover",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(missingSession(), reply().text("recovered").stop().item())

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(2)
    expect((yield* llm.hits).map((hit) => hit.body.model)).toEqual(["m1", "m3"])
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)

    // The errored attempt stays visible in the transcript.
    const history = yield* sessions.messages({ sessionID: chat.id })
    const assistants = history.filter((message) => message.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const [failed, retried] = assistants
    expect(failed?.info.role).toBe("assistant")
    expect(retried?.info.role).toBe("assistant")
    if (failed?.info.role === "assistant" && retried?.info.role === "assistant") {
      expect(failed.info.error?.name).toBe("APIError")
      expect(failed.info).toMatchObject({ providerID: "route-a", modelID: "m1" })
      expect(retried.info).toMatchObject({ providerID: "route-b", modelID: "m3" })
      expect(retried.info.error).toBeUndefined()
    }
  }),
)

it.instance("does not fail over a separation role", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) =>
      serverConfig(url, ["route-a/m1", "route-b/m3"], { separation_roles: ["build"] }),
    )
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Separation",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(missingSession(), reply().text("should not run").stop().item())

    const result = yield* prompt.loop({ sessionID: chat.id })
    // Reviewer independence: no automatic switch to the writer model.
    expect(yield* llm.calls).toBe(1)
    expect((yield* llm.hits).map((hit) => hit.body.model)).toEqual(["m1"])
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("APIError")
  }),
)

it.instance("failover prefers the remaining pinned-provider candidate", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-a/m2", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({
      title: "Root",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const child = yield* sessions.create({ parentID: root.id, title: "Child" })
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(missingSession(), reply().text("pinned retry").stop().item())

    const result = yield* prompt.loop({ sessionID: child.id })
    // Candidate 2 sits on the pinned provider, so it wins over route-b.
    expect((yield* llm.hits).map((hit) => hit.body.model)).toEqual(["m1", "m2"])
    expect(result.parts.some((part) => part.type === "text" && part.text === "pinned retry")).toBe(true)

    // Same-provider failover persists nothing: later turns resolve on route-a/m1 again.
    const routing = yield* ModelRouting.Service
    expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: a1 })).toMatchObject(a1)
  }),
)

it.instance("cross-provider failover updates the pin for later turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const routing = yield* ModelRouting.Service
    const root = yield* sessions.create({
      title: "Root",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const child = yield* sessions.create({ parentID: root.id, title: "Child" })
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(missingSession(), reply().text("first turn").stop().item())
    const first = yield* prompt.loop({ sessionID: child.id })
    expect(first.parts.some((part) => part.type === "text" && part.text === "first turn")).toBe(true)
    expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: a1 })).toMatchObject(b3)

    // A later turn starts on the new provider without another failure.
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* llm.push(reply().text("second turn").stop().item())
    const second = yield* prompt.loop({ sessionID: child.id })
    expect(second.parts.some((part) => part.type === "text" && part.text === "second turn")).toBe(true)
    expect((yield* llm.hits).map((hit) => hit.body.model)).toEqual(["m1", "m3", "m3"])
  }),
)

it.instance("no failover after a text part was persisted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Failover",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(failAfterText("partial response"))

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("UnknownError")
    expect(result.parts.some((part) => part.type === "text" && part.text === "partial response")).toBe(true)
  }),
)

it.instance("no failover after a tool part was persisted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Failover",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(failAfterTool("read", { filePath: "/tmp/x" }))

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("UnknownError")
    expect(result.parts.some((part) => part.type === "tool")).toBe(true)
  }),
)

it.instance("no failover on content-filter errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1", "route-b/m3"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Failover",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter().item())

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("ContentFilterError")
  }),
)

it.instance("no failover when every candidate is exhausted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => serverConfig(url, ["route-a/m1"]))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Failover",
      model: { providerID: a1.providerID, id: a1.modelID },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: a1,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(missingSession())

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(1)
    expect(result.info.role).toBe("assistant")
    // Generic provider errors carry no finish; the turn ends on the error.
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("APIError")
    // The turn ends instead of looping forever.
    const history = yield* sessions.messages({ sessionID: chat.id })
    expect(history.filter((message) => message.info.role === "assistant")).toHaveLength(1)
  }),
)

test("failover eligibility excludes non-provider errors", () => {
  const error = (name: string, data: Record<string, unknown> = {}) => ({ name, data })
  expect(SessionPrompt.isFailoverEligibleError(error("APIError", { message: "boom", isRetryable: false }))).toBe(true)
  expect(SessionPrompt.isFailoverEligibleError(error("Unknown", { message: "boom" }))).toBe(true)
  expect(SessionPrompt.isFailoverEligibleError(error("ContentFilterError"))).toBe(false)
  expect(SessionPrompt.isFailoverEligibleError(error("StructuredOutputError"))).toBe(false)
  expect(SessionPrompt.isFailoverEligibleError(error("ContextOverflowError"))).toBe(false)
  expect(SessionPrompt.isFailoverEligibleError(error("MessageAbortedError"))).toBe(false)
  expect(SessionPrompt.isFailoverEligibleError(error("MessageOutputLengthError"))).toBe(false)
  expect(SessionPrompt.isFailoverEligibleError(undefined)).toBe(false)
})

test("failover parts gate blocks on partial work only", () => {
  const text = (value: string) =>
    ({ type: "text", text: value }) as unknown as SessionV1.TextPart
  const tool = { type: "tool" } as unknown as SessionV1.ToolPart
  const step = { type: "step-start" } as unknown as SessionV1.Part
  expect(SessionPrompt.hasFailoverBlockingParts([])).toBe(false)
  expect(SessionPrompt.hasFailoverBlockingParts([text("hello")])).toBe(true)
  expect(SessionPrompt.hasFailoverBlockingParts([text("  ")])).toBe(false)
  expect(SessionPrompt.hasFailoverBlockingParts([tool])).toBe(true)
  expect(SessionPrompt.hasFailoverBlockingParts([step])).toBe(false)
})
