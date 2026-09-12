import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Config } from "@/config/config"
import { ModelRouting } from "@/session/model-routing"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Storage } from "@/storage/storage"
import { MessageID, PartID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const a = Provider.parseModel("route-a/claude")
const b = Provider.parseModel("route-b/claude")
const config: Config.Info = {
  enabled_providers: ["route-a", "route-b"],
  model_routing: {
    scope: "same",
    roles: {
      general: ["missing/claude", "route-b/claude", "route-a/claude"],
      nongpt: ["route-b/claude"],
      empty: [],
      title: ["route-b/claude", "route-a/claude"],
      compaction: ["route-b/claude", "route-a/claude"],
    },
  },
  provider: Object.fromEntries(
    ["route-a", "route-b"].map((id) => [
      id,
      {
        name: id,
        env: [],
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "test-only", baseURL: "http://127.0.0.1:1" },
        models: {
          claude: { name: "Claude", limit: { context: 100000, output: 1000 } },
          gpt: { name: "GPT", limit: { context: 100000, output: 1000 } },
        },
      },
    ]),
  ),
}

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ModelRouting.node,
      Session.node,
      SessionProjector.node,
      Storage.node,
      Config.node,
      LLM.node,
      Agent.node,
      Provider.node,
    ]),
  ),
)

test("legacy config accepts routing and rejects malformed candidates", () => {
  expect(Schema.decodeUnknownSync(Config.Info)(config).model_routing).toEqual(config.model_routing)
  expect(() =>
    Schema.decodeUnknownSync(Config.Info)({ model_routing: { scope: "same", roles: { general: ["claude"] } } }),
  ).toThrow()
})

it.instance("routing stays opt-in", () =>
  Effect.gen(function* () {
    const routing = yield* ModelRouting.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "Root" })
    expect(yield* routing.resolve({ sessionID: root.id, role: "general", model: b })).toEqual(b)
    expect(yield* routing.command({ sessionID: root.id, action: "same", model: b })).toContain("routing is off")
  }),
)

it.instance(
  "unconfigured root preserves a selected model within the same provider",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ model: { providerID: a.providerID, id: a.modelID } })
      const selected = Provider.parseModel("route-a/gpt")
      expect(yield* routing.resolve({ sessionID: root.id, role: "build", model: selected })).toMatchObject(selected)
      yield* routing.check({ sessionID: root.id, role: "build", model: selected })
      const text = yield* routing.command({ sessionID: root.id, action: "status", model: selected })
      expect(text).toContain("/models selects the main model")
      expect(text).toContain("provider anchor stays fixed")
    }),
  { config },
)

it.instance(
  "unconfigured root rejects a different provider in same scope without replacement",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ model: { providerID: a.providerID, id: a.modelID } })
      const exit = yield* routing.resolve({ sessionID: root.id, role: "build", model: b }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("outside the same-provider anchor route-a")
    }),
  { config },
)

it.instance(
  "curated honors explicit root selection while preserving the original provider anchor",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ model: { providerID: a.providerID, id: a.modelID } })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: root.id, role: "build", model: b })).toMatchObject(b)
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ anchor: a })
      yield* routing.command({ sessionID: root.id, action: "same", model: b })
      expect(
        Exit.isFailure(yield* routing.resolve({ sessionID: root.id, role: "build", model: b }).pipe(Effect.exit)),
      ).toBe(true)
    }),
  { config },
)

it.instance(
  "configured root roles still enforce their candidates over explicit selection",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ model: { providerID: a.providerID, id: a.modelID } })
      expect(
        yield* routing.resolve({ sessionID: root.id, role: "general", model: Provider.parseModel("route-a/gpt") }),
      ).toMatchObject(a)
    }),
  { config },
)

for (const scope of ["same", "curated"] as const) {
  it.instance(
    `unconfigured children and auxiliary roles retain anchor fallback in ${scope}`,
    () =>
      Effect.gen(function* () {
        const routing = yield* ModelRouting.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ model: { providerID: a.providerID, id: a.modelID } })
        yield* routing.command({ sessionID: root.id, action: scope, model: a })
        const child = yield* sessions.create({ parentID: root.id })
        expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: b })).toMatchObject(a)
        expect(
          yield* routing.resolve({ sessionID: root.id, role: "summary", model: b, auxiliary: true }),
        ).toMatchObject(a)
        expect(
          yield* routing.resolve({ sessionID: child.id, role: "summary", model: b, auxiliary: true }),
        ).toMatchObject(a)
      }),
    { config },
  )
}

it.instance(
  "same routing anchors the root and nested descendants, not the immediate parent",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const parent = yield* sessions.create({
        parentID: root.id,
        title: "Parent",
        model: { providerID: b.providerID, id: b.modelID },
      })
      const child = yield* sessions.create({ parentID: parent.id, title: "Nested" })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: b })).toMatchObject(a)
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        anchor: a,
        scope: "same",
        pins: { [child.id]: a.providerID },
      })
      expect(yield* storage.list(["model_routing", child.id])).toEqual([])
    }),
  { config },
)

it.instance(
  "curated routing uses ordered available candidates and persisted root scope",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      expect(yield* routing.command({ sessionID: child.id, action: "curated", model: b })).toContain(
        "Legacy model routing: curated",
      )
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: a })).toMatchObject(b)
      expect(yield* routing.command({ sessionID: root.id, action: "status", model: b })).toContain(
        "Provider anchor: route-a",
      )
      const storage = yield* Storage.Service
      yield* storage.update<{ scope: string }>(["model_routing", root.id], (state) => {
        state.scope = "same"
      })
      expect(yield* routing.command({ sessionID: child.id, action: "status", model: b })).toContain(
        "Legacy model routing: same",
      )
    }),
  { config },
)

for (const role of ["nongpt", "empty"]) {
  it.instance(
    `routing rejects ${role} without an unrelated model fallback`,
    () =>
      Effect.gen(function* () {
        const routing = yield* ModelRouting.Service
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ title: "Root" })
        const result = yield* routing.resolve({ sessionID: root.id, role, model: a }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("no fallback was used")
      }),
    { config },
  )
}

const fallbackConfig: Config.Info = {
  ...config,
  model_routing: {
    scope: "same",
    anchor_fallback: true,
    roles: {
      explore: ["route-b/claude"],
      deep: ["missing/claude"],
    },
  },
}

it.instance(
  "same-scope roles fall back to the anchor model when anchor_fallback is enabled",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      expect(yield* routing.resolve({ sessionID: root.id, role: "explore", model: a })).toMatchObject(a)
      const text = yield* routing.command({ sessionID: root.id, action: "status", model: a })
      expect(text).toContain("explore: route-a/claude (anchor fallback")
      expect(yield* routing.resolve({ sessionID: root.id, role: "explore", model: b })).toMatchObject(a)
      // Curated keeps the fail-closed contract even with anchor_fallback enabled.
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      const result = yield* routing.resolve({ sessionID: root.id, role: "deep", model: a }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }),
  { config: fallbackConfig },
)

it.instance(
  "resumed children do not migrate when the root scope narrows",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: a })).toMatchObject(b)
      yield* routing.command({ sessionID: root.id, action: "same", model: a })
      const result = yield* routing.resolve({ sessionID: child.id, role: "general", model: a }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("child pinned to route-b")
    }),
  { config },
)

it.instance(
  "historical children adopt their stored provider rather than the new first candidate",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "Child",
        model: { providerID: a.providerID, id: a.modelID },
      })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: b })).toMatchObject(a)
    }),
  { config },
)

it.instance(
  "historical child transcripts pin provider when session model is absent",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Historical child" })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: child.id,
        role: "user",
        agent: "general",
        model: a,
        time: { created: Date.now() },
      })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: b })).toMatchObject(a)
    }),
  { config },
)

it.instance(
  "historical pin ignores summaries and deterministic controls",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const routing = yield* ModelRouting.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: child.id,
        role: "user",
        agent: "general",
        model: a,
        time: { created: 1 },
      })
      for (const [index, kind] of ["general", "compaction", "routing"].entries()) {
        const model = index === 0 ? a : b
        const info = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          parentID: user.id,
          role: "assistant",
          agent: kind === "routing" ? "general" : kind,
          mode: kind,
          modelID: model.modelID,
          providerID: model.providerID,
          summary: kind === "compaction",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: index + 2, completed: index + 2 },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: info.id,
          type: "text",
          text: kind,
          ...(kind === "routing" ? { metadata: { "opencode.control": "routing" }, synthetic: true } : {}),
        })
      }
      const text = yield* routing.command({ sessionID: child.id, action: "curated", model: b })
      expect(text).toContain("general: route-a/claude")
      expect(text).toContain("candidates (in order): missing/claude -> route-b/claude -> route-a/claude")
      expect(text).toContain("empty: unavailable")
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ pins: {} })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: b })).toMatchObject(a)
    }),
  { config },
)

it.instance(
  "durable routing survives service restart and removal of opt-in config",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      const resolved = yield* Effect.gen(function* () {
        const restarted = yield* ModelRouting.Service
        return yield* restarted.resolve({ sessionID: root.id, role: "general", model: a })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(ModelRouting.node, [
            [
              Config.node,
              Layer.mock(Config.Service, {
                get: () => Effect.succeed({ ...config, model_routing: undefined }),
              }),
            ],
          ]),
        ),
      )
      expect(resolved).toMatchObject(b)
    }),
  { config },
)

// A module-level override lets refresh tests edit model_routing mid-test while
// every service (sessions, storage, provider) stays on one shared instance.
let configOverride: Config.Info | undefined
const itOverridable = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ModelRouting.node,
      Session.node,
      SessionProjector.node,
      Storage.node,
      Config.node,
      LLM.node,
      Agent.node,
      Provider.node,
    ]),
    [[Config.node, Layer.mock(Config.Service, { get: () => Effect.succeed(configOverride ?? config) })]],
  ),
)

itOverridable.instance(
  "refresh adopts edited config roles on an existing root",
  () =>
    Effect.gen(function* () {
      configOverride = undefined
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      expect(yield* routing.resolve({ sessionID: root.id, role: "general", model: a })).toMatchObject(a)
      configOverride = {
        ...config,
        model_routing: { scope: "curated", roles: { general: ["route-b/claude"] } },
      }
      const text = yield* routing.command({ sessionID: root.id, action: "refresh", model: a })
      expect(text).toContain("general: route-b/claude")
      expect(yield* routing.resolve({ sessionID: root.id, role: "general", model: a })).toMatchObject(b)
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        anchor: a,
        scope: "curated",
        roles: { general: ["route-b/claude"] },
      })
    }),
  { config },
)

itOverridable.instance(
  "refresh with routing config removed turns routing off for the root",
  () =>
    Effect.gen(function* () {
      configOverride = undefined
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      configOverride = { ...config, model_routing: undefined }
      const text = yield* routing.command({ sessionID: root.id, action: "refresh", model: a })
      expect(text).toContain("routing is off")
      expect(text).toContain("removed")
      const storage = yield* Storage.Service
      const stored = yield* storage.read(["model_routing", root.id]).pipe(Effect.exit)
      expect(Exit.isFailure(stored)).toBe(true)
      expect(yield* routing.resolve({ sessionID: root.id, role: "general", model: b })).toEqual(b)
    }),
  { config },
)

itOverridable.instance(
  "refresh preserves the anchor and child provider pins",
  () =>
    Effect.gen(function* () {
      configOverride = undefined
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: child.id, role: "general", model: a })).toMatchObject(b)
      configOverride = {
        ...config,
        model_routing: { scope: "same", roles: { general: ["route-a/claude"] } },
      }
      yield* routing.command({ sessionID: root.id, action: "refresh", model: a })
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        anchor: a,
        pins: { [child.id]: b.providerID },
      })
      // The child keeps its pinned provider, so the refreshed same-scope candidates cannot satisfy it.
      const result = yield* routing.resolve({ sessionID: child.id, role: "general", model: a }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("child pinned to route-b")
    }),
  { config },
)

it.instance(
  "parallel child admission does not lose durable provider pins",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const children = yield* Effect.all([
        sessions.create({ parentID: root.id }),
        sessions.create({ parentID: root.id }),
      ])
      yield* Effect.all(
        children.map((child) => routing.resolve({ sessionID: child.id, role: "general", model: b })),
        { concurrency: "unbounded" },
      )
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        pins: Object.fromEntries(children.map((child) => [child.id, a.providerID])),
      })
    }),
  { config },
)

it.instance(
  "routing filters provider restrictions before selecting a candidate",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      expect(yield* routing.resolve({ sessionID: root.id, role: "general", model: b })).toMatchObject(a)
    }),
  { config: { ...config, disabled_providers: ["route-b"] } },
)

it.instance(
  "auxiliary routing follows the root scope without repinning a child",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      yield* routing.command({ sessionID: root.id, action: "curated", model: a })
      yield* routing.resolve({ sessionID: child.id, role: "general", model: a })
      yield* routing.command({ sessionID: root.id, action: "same", model: a })
      for (const role of ["title", "compaction"]) {
        expect(yield* routing.resolve({ sessionID: child.id, role, model: b, auxiliary: true })).toMatchObject(a)
      }
      const storage = yield* Storage.Service
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ pins: { [child.id]: b.providerID } })
    }),
  { config },
)

for (const role of ["general", "title", "compaction"]) {
  it.instance(
    `LLM boundary blocks an unauthorized ${role} request before transport`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const llm = yield* LLM.Service
        const provider = yield* Provider.Service
        const agents = yield* Agent.Service
        const root = yield* sessions.create({ title: "Root", model: { providerID: a.providerID, id: a.modelID } })
        const result = yield* llm
          .stream({
            sessionID: root.id,
            user: {
              id: MessageID.ascending(),
              sessionID: root.id,
              role: "user",
              agent: "build",
              model: a,
              time: { created: Date.now() },
            },
            model: yield* provider.getModel(b.providerID, b.modelID),
            agent: yield* agents.get(role),
            small: role === "title",
            system: [],
            tools: {},
            messages: [],
          })
          .pipe(Stream.runDrain, Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Legacy routing rejected")
      }),
    { config },
  )
}
