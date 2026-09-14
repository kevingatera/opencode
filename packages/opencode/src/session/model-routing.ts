import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Config } from "@/config/config"
import { ConfigModelRouting } from "@/config/model-routing"
import { Provider } from "@/provider/provider"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"

const Model = Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID })
type Model = typeof Model.Type
const State = Schema.Struct({
  ...ConfigModelRouting.Info.fields,
  anchor: Model,
  pins: Schema.Record(Schema.String, ProviderV2.ID),
})
type State = typeof State.Type

export class RoutingError extends Schema.TaggedErrorClass<RoutingError>()("ModelRoutingError", {
  message: Schema.String,
}) {}

type Input = { sessionID: SessionID; role: string; model: Model; auxiliary?: boolean }
export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Model & { routed?: boolean }>
  readonly check: (input: Input) => Effect.Effect<void>
  readonly command: (input: { sessionID: SessionID; action: string; model: Model }) => Effect.Effect<string>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ModelRouting") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const provider = yield* Provider.Service
    // Serialize read/initialize/write as one operation, including parallel title and task admission.
    const lock = yield* Semaphore.make(1)

    const load = Effect.fn("ModelRouting.load")(function* (sessionID: SessionID, model: Model) {
      const cfg = yield* config.get()
      const session = yield* sessions
        .get(sessionID)
        .pipe(
          Effect.catch(() =>
            cfg.model_routing
              ? Effect.die(new RoutingError({ message: "Routing session not found" }))
              : Effect.succeed(undefined),
          ),
        )
      if (!session) return
      let root = session
      const seen = new Set<SessionID>()
      while (root.parentID) {
        if (seen.has(root.id))
          return yield* Effect.die(new RoutingError({ message: "Cyclic routing session ancestry" }))
        seen.add(root.id)
        root = yield* sessions.get(root.parentID).pipe(Effect.orDie)
      }
      const key = ["model_routing", root.id]
      const stored = yield* storage.read<unknown>(key).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (stored !== undefined) {
        return { session, root, key, state: yield* Schema.decodeUnknownEffect(State)(stored).pipe(Effect.orDie) }
      }
      if (!cfg.model_routing) return
      const history = root.model ? undefined : yield* sessions.messages({ sessionID: root.id }).pipe(Effect.orDie)
      const first = history?.find((item) => !MessageV2.isControl(item) && item.info.role === "user")?.info
      const anchor = root.model
        ? { providerID: root.model.providerID, modelID: root.model.id }
        : first?.role === "user"
          ? first.model
          : root.id === sessionID
            ? model
            : undefined
      if (!anchor)
        return yield* Effect.die(new RoutingError({ message: "Root session has no model to anchor routing" }))
      const state: State = { ...cfg.model_routing, anchor, pins: {} }
      yield* storage.write(key, state).pipe(Effect.orDie)
      return { session, root, key, state }
    })

    const selection = Effect.fn("ModelRouting.selection")(function* (
      loaded: NonNullable<Effect.Success<ReturnType<typeof load>>>,
      input: Input,
    ) {
      const { state, session } = loaded
      const cfg = yield* config.get()
      const available = yield* provider.list()
      const history =
        session.parentID && !input.auxiliary && !state.pins[session.id] && !session.model
          ? yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
          : undefined
      const execution = history
        ?.filter((item) => !MessageV2.isControl(item))
        .toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
      const prior = execution?.findLast(
        (item) =>
          item.info.role === "assistant" &&
          !item.info.summary &&
          !["title", "summary", "compaction"].includes(item.info.agent),
      )?.info
      const user = execution?.findLast(
        (item) => item.info.role === "user" && !item.parts.some((part) => part.type === "compaction"),
      )?.info
      const pin =
        session.parentID && !input.auxiliary
          ? (state.pins[session.id] ??
            session.model?.providerID ??
            (prior?.role === "assistant"
              ? prior.providerID
              : user?.role === "user"
                ? user.model.providerID
                : undefined))
          : undefined
      // The literal "session" candidate means "whatever this session is
      // currently running" — callers pass the live model as input.model, so
      // it participates in the same permitted checks as any other candidate.
      const candidates = state.roles[input.role]?.map((candidate) =>
        candidate === "session" ? input.model : Provider.parseModel(candidate),
      ) ?? [
        !session.parentID && !input.auxiliary ? input.model : state.anchor,
      ]
      const permitted = (candidate: Model) =>
        (state.scope !== "same" || candidate.providerID === state.anchor.providerID) &&
        (!pin || candidate.providerID === pin) &&
        !cfg.disabled_providers?.includes(candidate.providerID) &&
        (!cfg.enabled_providers || cfg.enabled_providers.includes(candidate.providerID)) &&
        Boolean(available[candidate.providerID]?.models[candidate.modelID])
      const selected = candidates.find(permitted)
      // In same scope the anchor model always satisfies the provider contract,
      // so a configured role whose candidates all sit on other providers can
      // fall back to it when the config opts in. Curated stays fail-closed.
      const anchorFallback =
        !selected &&
        state.scope === "same" &&
        state.anchor_fallback === true &&
        Boolean(state.roles[input.role]) &&
        (!pin || pin === state.anchor.providerID) &&
        permitted(state.anchor)
      return { selected: selected ?? (anchorFallback ? state.anchor : undefined), candidates, pin, anchorFallback: !selected && anchorFallback }
    })

    const resolve = Effect.fn("ModelRouting.resolve")(function* (input: Input) {
      const loaded = yield* load(input.sessionID, input.model)
      if (!loaded) return input.model
      const { state, session, root, key } = loaded
      if (
        !session.parentID &&
        !input.auxiliary &&
        !Object.hasOwn(state.roles, input.role) &&
        state.scope === "same" &&
        input.model.providerID !== state.anchor.providerID
      ) {
        return yield* Effect.die(
          new RoutingError({
            message: `Selected root model ${input.model.providerID}/${input.model.modelID} is outside the same-provider anchor ${state.anchor.providerID}. Select a model from ${state.anchor.providerID} or use /routing curated; no fallback was used.`,
          }),
        )
      }
      const { selected, pin } = yield* selection(loaded, input)
      if (!selected)
        return yield* Effect.die(
          new RoutingError({
            message: `No permitted available model for role "${input.role}" (legacy routing ${state.scope}, anchor ${state.anchor.providerID}${pin ? `, child pinned to ${pin}` : ""}). Change /routing scope or start a new root with matching role candidates; no fallback was used.`,
          }),
        )
      if (session.id !== root.id && !input.auxiliary && !state.pins[session.id]) {
        yield* storage
          .write(key, { ...state, pins: { ...state.pins, [session.id]: selected.providerID } })
          .pipe(Effect.orDie)
      }
      return { ...selected, routed: true }
    }, lock.withPermits(1))

    const check = Effect.fn("ModelRouting.check")(function* (input: Input) {
      const selected = yield* resolve(input)
      if (selected.providerID === input.model.providerID && selected.modelID === input.model.modelID) return
      return yield* Effect.die(
        new RoutingError({
          message: `Legacy routing rejected ${input.model.providerID}/${input.model.modelID} for role "${input.role}"; expected ${selected.providerID}/${selected.modelID}. Retry the turn with the current routing policy.`,
        }),
      )
    })

    const command = Effect.fn("ModelRouting.command")(function* (input: {
      sessionID: SessionID
      action: string
      model: Model
    }) {
      const action = input.action.trim() || "status"
      if (!["same", "curated", "status", "refresh"].includes(action)) {
        return "Usage: /routing same|curated|status|refresh. Legacy SessionPrompt only; V2 routing is not enforced."
      }
      const loaded = yield* load(input.sessionID, input.model)
      if (!loaded)
        return "Legacy model routing is off. Configure model_routing with scope and role candidates to opt in. V2 routing is not enforced."
      const cfg = yield* config.get()
      if (action === "refresh" && !cfg.model_routing) {
        yield* storage.remove(loaded.key).pipe(Effect.orDie)
        return `Legacy model routing is off for root ${loaded.root.id}: model_routing config was removed, so the stored routing state was deleted. V2 routing is not enforced.`
      }
      const state =
        action === "refresh" && cfg.model_routing
          ? { ...cfg.model_routing, anchor: loaded.state.anchor, pins: loaded.state.pins }
          : loaded.state
      if (state !== loaded.state) yield* storage.write(loaded.key, state).pipe(Effect.orDie)
      const scope = action === "same" || action === "curated" ? action : state.scope
      if (scope !== state.scope) yield* storage.write(loaded.key, { ...state, scope }).pipe(Effect.orDie)
      const roles = yield* Effect.forEach(
        Object.keys(state.roles).toSorted(),
        Effect.fnUntraced(function* (role) {
          const result = yield* selection(
            { ...loaded, state: { ...state, scope } },
            {
              sessionID: input.sessionID,
              role,
              model: input.model,
              auxiliary: ["title", "summary", "compaction"].includes(role),
            },
          )
          return `${role}: ${result.selected ? `${result.selected.providerID}/${result.selected.modelID}${result.anchorFallback ? " (anchor fallback: no configured candidate matches the anchor provider in same scope)" : ""}` : "unavailable"}; candidates (in order): ${result.candidates.map((candidate) => `${candidate.providerID}/${candidate.modelID}`).join(" -> ") || "none"}${result.pin ? `; child provider: ${result.pin}` : ""}`
        }),
      )
      return [
        `Legacy model routing: ${scope}`,
        `Root session: ${loaded.root.id}`,
        `Provider anchor: ${state.anchor.providerID}`,
        ...roles,
        `Unconfigured child and auxiliary roles: ${state.anchor.providerID}/${state.anchor.modelID} (subject to availability and child provider pin)`,
        "Role candidates are snapshotted when this root opts in; /routing refresh rewrites the snapshot (scope, anchor_fallback, roles) from the current config while keeping the anchor and child provider pins, and removes the stored state when model_routing config is gone. Configured roles always use their candidate lists; the literal \"session\" candidate follows whatever model the session is currently running (skipped for a later candidate when the current model is not permitted); with anchor_fallback enabled, a same-scope role with no matching candidate runs the anchor model instead of failing (shown as anchor fallback above).",
        "For unconfigured root roles, /models selects the main model: same allows the anchor provider; curated also allows explicit choices from other permitted available providers.",
        "The provider anchor stays fixed when /models changes, so switching back to same restores the original provider restriction.",
        "Applies to this root and nested children. Resumed children retain their provider; incompatible routes fail without fallback.",
        "Scope changes apply to subsequent LLM calls, not requests already in flight. V2 sessions share this id space, but the V2 runner resolves models through the catalog without consulting routing state, so V2 turns are not gated.",
      ].join("\n")
    }, lock.withPermits(1))

    return Service.of({ resolve, check, command })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, Session.node, Storage.node, Provider.node],
})

export * as ModelRouting from "./model-routing"
