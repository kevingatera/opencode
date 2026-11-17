import { describe, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createCompactionMarker(sessionID: SessionID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
      })
      return msg
    }),
  )
}

function createCompactionMarkerWithTail(sessionID: SessionID, tail_start_id: MessageID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: false,
        tail_start_id,
      })
      return msg
    }),
  )
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

function createAssistantText(sessionID: SessionID, messageID: MessageID, text: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "text",
      text,
    }),
  )
}

function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, compaction }) }))
}

const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])

const compactionEnv = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const it = testEffect(compactionEnv)

function withCompaction(config: Layer.Layer<Config.Service>) {
  return Effect.provide(
    AppNodeBuilder.build(compactionTestNode, [
      [Provider.node, wide().layer],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [SessionSummary.node, summary],
      [SessionProcessorModule.SessionProcessor.node, processorLayer("continue")],
      [Config.node, config],
    ]),
  )
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readLastCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages
          .flatMap((msg) => msg.parts)
          .findLast((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

// A 2_000-char text turn estimates to ~514 tokens, so two of them are ~1_027.
// Budget 1_300 fits both raw but its safety-adjusted 866 only fits one.
const SAFETY_PROBE_BUDGET = 1_300
// Budget 1_700 adjusts to ~1_133, which still fits both ~1_027-token tails.
const FITS_ADJUSTED_BUDGET = 1_700

describe("session.compaction.tail", () => {
  it.instance(
    "does not fully retain a tail that fits the raw budget but exceeds budget/1.5",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      yield* createUserMessage(session.id, "a".repeat(2_000))
      const second = yield* createUserMessage(session.id, "b".repeat(2_000))
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readLastCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(second.id)
    }).pipe(withCompaction(cfg({ tail_turns: 2, preserve_recent_tokens: SAFETY_PROBE_BUDGET }))),
  )

  it.instance(
    "retains a tail that fits within budget/1.5",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older context")
      const first = yield* createUserMessage(session.id, "a".repeat(2_000))
      yield* createUserMessage(session.id, "b".repeat(2_000))
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readLastCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(first.id)
    }).pipe(withCompaction(cfg({ tail_turns: 2, preserve_recent_tokens: FITS_ADJUSTED_BUDGET }))),
  )

  it.instance(
    "summarizes everything on immediate re-compaction after a previous summary",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service

      const guarded = yield* ssn.create({})
      yield* createUserMessage(guarded.id, "older filler")
      const marker = yield* createCompactionMarker(guarded.id)
      yield* createSummaryAssistantMessage(guarded.id, marker.id, test.directory, "prior summary")
      yield* createUserMessage(guarded.id, "c".repeat(2_000))
      yield* createUserMessage(guarded.id, "d".repeat(2_000))
      yield* createSummaryCompaction(guarded.id)

      const baseline = yield* ssn.create({})
      yield* createUserMessage(baseline.id, "older filler")
      const baselineFirst = yield* createUserMessage(baseline.id, "c".repeat(2_000))
      yield* createUserMessage(baseline.id, "d".repeat(2_000))
      yield* createSummaryCompaction(baseline.id)

      const guardedMsgs = yield* ssn.messages({ sessionID: guarded.id })
      const guardedParent = guardedMsgs.at(-1)?.info.id
      expect(guardedParent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: guardedParent!,
        messages: guardedMsgs,
        sessionID: guarded.id,
        auto: true,
      })

      const baselineMsgs = yield* ssn.messages({ sessionID: baseline.id })
      const baselineParent = baselineMsgs.at(-1)?.info.id
      expect(baselineParent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: baselineParent!,
        messages: baselineMsgs,
        sessionID: baseline.id,
        auto: true,
      })

      const guardedPart = yield* readLastCompactionPart(guarded.id)
      const baselinePart = yield* readLastCompactionPart(baseline.id)
      expect(baselinePart?.tail_start_id).toBe(baselineFirst.id)
      expect(guardedPart?.tail_start_id).toBeUndefined()
    }).pipe(withCompaction(cfg({ tail_turns: 2, preserve_recent_tokens: FITS_ADJUSTED_BUDGET }))),
  )

  it.instance(
    "leaves tail_turns<=0 behavior unchanged",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      yield* createUserMessage(session.id, "second")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readLastCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBeUndefined()
    }).pipe(withCompaction(cfg({ tail_turns: 0, preserve_recent_tokens: 10_000 }))),
  )

  it.instance(
    "fires the loop guard on filterCompacted input despite a large retained tail",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "u1".padEnd(2_000, "1"))
      yield* createUserMessage(session.id, "u2".padEnd(2_000, "2"))
      const retained = yield* createUserMessage(session.id, "u3".padEnd(2_000, "3"))
      for (const reply of ["retained one", "retained two", "retained three"]) {
        const assistant = yield* createAssistantMessage(session.id, retained.id, test.directory)
        yield* createAssistantText(session.id, assistant.id, reply.padEnd(500, "."))
      }
      const marker = yield* createCompactionMarkerWithTail(session.id, retained.id)
      yield* createSummaryAssistantMessage(session.id, marker.id, test.directory, "prior summary")
      const fresh = yield* createUserMessage(session.id, "n1".padEnd(2_000, "4"))
      const freshReply = yield* createAssistantMessage(session.id, fresh.id, test.directory)
      yield* createAssistantText(session.id, freshReply.id, "fresh reply".padEnd(500, "."))
      yield* createUserMessage(session.id, "n2".padEnd(2_000, "5"))
      yield* createSummaryCompaction(session.id)

      // Production compacts filterCompacted output, which reorders to
      // [compaction-user, summary, ...retained tail..., newer...]: the three
      // retained assistants sit after the summary by position but before it
      // chronologically, so only the one fresh assistant counts as new work.
      const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const part = yield* readLastCompactionPart(session.id)
      expect(part?.tail_start_id).toBeUndefined()
    }).pipe(withCompaction(cfg({ preserve_recent_tokens: 3_000 }))),
  )

  it.instance(
    "halves the tail on immediate re-compaction while keeping a smaller tail",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older filler")
      const marker = yield* createCompactionMarker(session.id)
      yield* createSummaryAssistantMessage(session.id, marker.id, test.directory, "prior summary")
      // Eight ~489-token turns are ~3_912 total: budget 6_200 adjusts to ~4_133
      // (fits all) and halves to ~2_066, which retains the newest four.
      const fresh: MessageID[] = []
      for (let i = 0; i < 8; i++) {
        const msg = yield* createUserMessage(session.id, `t${i}`.padEnd(1_900, String(i % 10)))
        fresh.push(msg.id)
      }
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const part = yield* readLastCompactionPart(session.id)
      expect(part?.tail_start_id).toBe(fresh[4])
    }).pipe(withCompaction(cfg({ preserve_recent_tokens: 6_200 }))),
  )
})
