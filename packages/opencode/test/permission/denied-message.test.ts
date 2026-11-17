import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Permission } from "../../src/permission"
import { siblingConcurrencyPermission, SIBLING_DENIAL_HINT } from "../../src/permission/sibling"
import { SessionID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, PermissionSaved.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const denied = (command: string, ruleset: PermissionV1.Ruleset) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const err = yield* permission
      .ask({
        sessionID: SessionID.make("session_denied_message"),
        permission: "bash",
        patterns: [command],
        metadata: {},
        always: [],
        ruleset,
      })
      .pipe(Effect.flip)
    if (!(err instanceof PermissionV1.DeniedError)) throw new Error("expected DeniedError")
    return err
  })

const parent: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]

describe("sibling concurrency denials", () => {
  const ruleset = [...parent, ...siblingConcurrencyPermission()]

  it.instance("names the matched rule and includes the sibling hint", () =>
    Effect.gen(function* () {
      const err = yield* denied("rm x", ruleset)
      expect(err.message).toContain('pattern "rm *"')
      expect(err.message).toContain('action "deny"')
      expect(err.message).toContain(SIBLING_DENIAL_HINT)
      expect(err.message).not.toContain("tee *")
    }),
  )

  it.instance("in-place sed message names a sed pattern and stays under 500 chars", () =>
    Effect.gen(function* () {
      const err = yield* denied("sed -i 's/a/b/' file", ruleset)
      expect(err.message).toContain('permission "bash", pattern "sed -i / sed --in-place"')
      expect(err.message).toContain(SIBLING_DENIAL_HINT)
      expect(err.message).not.toContain('pattern "rm *"')
      expect(err.message.length).toBeLessThan(500)
    }),
  )

  it.instance("keeps the full filtered ruleset on the error object", () =>
    Effect.gen(function* () {
      const err = yield* denied("rm x", ruleset)
      expect(err.ruleset.length).toBeGreaterThan(1)
      expect(err.message).not.toContain("tee *")
    }),
  )
})

describe("hint provenance", () => {
  it.instance("a user-authored rm deny without sibling rules gets no sibling hint", () =>
    Effect.gen(function* () {
      const err = yield* denied("rm x", [...parent, { permission: "bash", pattern: "rm *", action: "deny" }])
      expect(err.message).toContain('pattern "rm *"')
      expect(err.message).not.toContain(SIBLING_DENIAL_HINT)
    }),
  )

  it.instance("a user-authored sed deny without sibling rules gets no sibling hint", () =>
    Effect.gen(function* () {
      const err = yield* denied("sed -i x f", [...parent, { permission: "bash", pattern: "sed *", action: "deny" }])
      expect(err.message).toContain('pattern "sed *"')
      expect(err.message).not.toContain(SIBLING_DENIAL_HINT)
    }),
  )

  it.instance("a sibling deny gets the hint when the sibling rules are active", () =>
    Effect.gen(function* () {
      const err = yield* denied('sed "$FLAGS" f', [...parent, ...siblingConcurrencyPermission()])
      expect(err.message).toContain(SIBLING_DENIAL_HINT)
    }),
  )
})

describe("generic denials", () => {
  it.instance("names only the matched rule and omits the sibling hint", () =>
    Effect.gen(function* () {
      const ruleset: PermissionV1.Ruleset = [
        ...parent,
        { permission: "bash", pattern: "curl *", action: "deny" },
        { permission: "bash", pattern: "wget *", action: "deny" },
      ]
      const err = yield* denied("curl http://x", ruleset)
      expect(err.message).toContain('pattern "curl *"')
      expect(err.message).not.toContain("wget")
      expect(err.message).not.toContain(SIBLING_DENIAL_HINT)
    }),
  )
})
