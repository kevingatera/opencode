import { expect, test } from "bun:test"
import { Effect } from "effect"
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
import { testEffect } from "../lib/effect"

const m1 = Provider.parseModel("route-a/m1")
const m2 = Provider.parseModel("route-a/m2")
const m3 = Provider.parseModel("route-b/m3")

function routingConfig(scope: "same" | "curated", candidates: string[], extra?: Partial<Config.Info>): Config.Info {
  return {
    enabled_providers: ["route-a", "route-b"],
    model_routing: {
      scope,
      roles: { build: candidates },
    },
    provider: Object.fromEntries(
      (
        [
          ["route-a", ["m1", "m2"]],
          ["route-b", ["m3"]],
        ] satisfies [string, string[]][]
      ).map(([id, models]) => [
        id,
        {
          name: id,
          env: [],
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "test-only", baseURL: "http://127.0.0.1:1" },
          models: Object.fromEntries(
            models.map((model) => [model, { name: model, limit: { context: 100000, output: 1000 } }]),
          ),
        },
      ]),
    ),
    ...extra,
  } as Config.Info
}

function routingConfigRoles(scope: "same" | "curated", roles: Record<string, string[]>): Config.Info {
  const base = routingConfig(scope, roles.build ?? [])
  return {
    ...base,
    model_routing: {
      ...(base.model_routing as NonNullable<Config.Info["model_routing"]>),
      roles,
    },
  } as Config.Info
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

it.instance(
  "failover returns undefined when routing is off",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      expect(yield* routing.failover({ sessionID: root.id, role: "build", model: m1, attempted: [m1] })).toBeUndefined()
    }),
)

it.instance(
  "failover prefers the remaining pinned-provider candidate before cross-provider",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1 })).toMatchObject(m1)
      const next = yield* routing.failover({ sessionID: child.id, role: "build", model: m1, attempted: [m1] })
      expect(next).toMatchObject({ providerID: "route-a", modelID: "m2", pinUpdated: false })
      // Same-provider picks write nothing: the pin is unchanged.
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ pins: { [child.id]: "route-a" } })
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-a/m2", "route-b/m3"]) },
)

it.instance(
  "cross-provider failover updates the pin so later turns agree",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1 })).toMatchObject(m1)
      const next = yield* routing.failover({ sessionID: child.id, role: "build", model: m1, attempted: [m1] })
      expect(next).toMatchObject({ providerID: "route-b", modelID: "m3", pinUpdated: true })
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ pins: { [child.id]: "route-b" } })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1 })).toMatchObject(m3)
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-b/m3"]) },
)

it.instance(
  "failover returns undefined when every candidate is exhausted",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      expect(
        yield* routing.failover({ sessionID: root.id, role: "build", model: m1, attempted: [m1, m3] }),
      ).toBeUndefined()
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-b/m3"]) },
)

it.instance(
  "failover skips candidates blocked by provider restrictions",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      expect(
        yield* routing.failover({ sessionID: root.id, role: "build", model: m1, attempted: [m1] }),
      ).toBeUndefined()
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-b/m3"], { disabled_providers: ["route-b"] }) },
)

it.instance(
  "same-scope failover never crosses to another provider",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      expect(
        yield* routing.failover({ sessionID: root.id, role: "build", model: m1, attempted: [m1] }),
      ).toBeUndefined()
    }),
  { config: routingConfig("same", ["route-a/m1", "route-b/m3"]) },
)

it.instance(
  "root failover never persists a pin",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const next = yield* routing.failover({ sessionID: root.id, role: "build", model: m1, attempted: [m1] })
      expect(next).toMatchObject({ providerID: "route-b", modelID: "m3", pinUpdated: false })
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({ pins: {} })
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-b/m3"]) },
)

it.instance(
  "same-provider failover leaves a recorded explicit override authoritative",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1, override: m2 })).toMatchObject(
        m2,
      )
      // The override model failed: failover uses other permitted role
      // candidates without rewriting the recorded override.
      const next = yield* routing.failover({ sessionID: child.id, role: "build", model: m1, attempted: [m2] })
      expect(next).toMatchObject({ providerID: "route-a", modelID: "m1", pinUpdated: false })
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        pins: { [child.id]: "route-a" },
        overrides: { [child.id]: { role: "build", providerID: "route-a", modelID: "m2" } },
      })
      // Later turns still honor the recorded override first.
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1 })).toMatchObject(m2)
    }),
  { config: routingConfig("same", ["route-a/m1", "route-a/m2"]) },
)

it.instance(
  "cross-provider failover repoints a stale recorded override in the same write",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1, override: m1 })).toMatchObject(
        m1,
      )
      const next = yield* routing.failover({ sessionID: child.id, role: "build", model: m1, attempted: [m1] })
      expect(next).toMatchObject({ providerID: "route-b", modelID: "m3", pinUpdated: true })
      // Without the repoint, the recorded route-a override would fail closed
      // against the new route-b pin on every later turn.
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        pins: { [child.id]: "route-b" },
        overrides: { [child.id]: { role: "build", providerID: "route-b", modelID: "m3" } },
      })
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1 })).toMatchObject(m3)
    }),
  { config: routingConfig("curated", ["route-a/m1", "route-b/m3"]) },
)

it.instance(
  "cross-provider failover drops an override recorded for another role",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      // Record a route-a override for the build role and pin the child there.
      expect(yield* routing.resolve({ sessionID: child.id, role: "build", model: m1, override: m1 })).toMatchObject(
        m1,
      )
      // A different role fails over across providers. Keeping the build
      // override would contradict the new pin and fail closed forever.
      const next = yield* routing.failover({ sessionID: child.id, role: "general", model: m1, attempted: [m1] })
      expect(next).toMatchObject({ providerID: "route-b", modelID: "m3", pinUpdated: true })
      expect(yield* storage.read(["model_routing", root.id])).toMatchObject({
        pins: { [child.id]: "route-b" },
        overrides: {},
      })
    }),
  {
    config: routingConfigRoles("curated", {
      build: ["route-a/m1", "route-b/m3"],
      general: ["route-a/m1", "route-b/m3"],
    }),
  },
)

it.instance(
  "explicit override failures only fail over to policy-permitted candidates",
  () =>
    Effect.gen(function* () {
      const routing = yield* ModelRouting.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root", model: { providerID: m1.providerID, id: m1.modelID } })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      // Same scope: the route-b candidate is outside the anchor provider, so
      // no failover target remains once the override model has failed.
      expect(
        yield* routing.failover({ sessionID: child.id, role: "build", model: m1, attempted: [m1] }),
      ).toBeUndefined()
    }),
  { config: routingConfig("same", ["route-b/m3", "route-a/m1"]) },
)
