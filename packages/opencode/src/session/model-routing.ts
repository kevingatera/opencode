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
const Override = Schema.Struct({
  role: Schema.String,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})
type Override = typeof Override.Type
const State = Schema.Struct({
  ...ConfigModelRouting.Info.fields,
  anchor: Model,
  pins: Schema.Record(Schema.String, ProviderV2.ID),
  overrides: Schema.Record(Schema.String, Override),
})
type State = typeof State.Type
// Stored states written before overrides existed have no overrides key;
// accept them and normalize to an empty map instead of failing the decode.
const StoredState = Schema.Struct({
  ...ConfigModelRouting.Info.fields,
  anchor: Model,
  pins: Schema.Record(Schema.String, ProviderV2.ID),
  overrides: Schema.optional(Schema.Record(Schema.String, Override)),
})

export class RoutingError extends Schema.TaggedErrorClass<RoutingError>()("ModelRoutingError", {
  message: Schema.String,
}) {}

// Fail-closed validation for an explicit per-call Task model override. Every
// policy gate (same-scope anchor, resumed-child pin, enabled/disabled
// providers, catalog availability) must pass; the first violation is reported
// and the caller falls back to nothing.
function explicitOverrideViolation(input: {
  providerID: string
  modelID: string
  scope: string
  anchorProviderID: string
  pin: string | undefined
  disabledProviders: readonly string[] | undefined
  enabledProviders: readonly string[] | undefined
  catalogHasModel: boolean
}): string | undefined {
  if (input.scope === "same" && input.providerID !== input.anchorProviderID)
    return `provider "${input.providerID}" is outside the same-provider anchor "${input.anchorProviderID}"`
  if (input.pin && input.providerID !== input.pin)
    return `provider "${input.providerID}" conflicts with the child provider pin "${input.pin}" (resumed sessions keep their provider)`
  if (input.disabledProviders?.includes(input.providerID))
    return `provider "${input.providerID}" is disabled via disabled_providers`
  if (input.enabledProviders && !input.enabledProviders.includes(input.providerID))
    return `provider "${input.providerID}" is not listed in enabled_providers`
  if (!input.catalogHasModel) return `model "${input.providerID}/${input.modelID}" is not available in the provider catalog`
  return undefined
}

function overrideRejection(input: { providerID: string; modelID: string; role: string; violation: string }) {
  return new RoutingError({
    message: `Explicit Task model override ${input.providerID}/${input.modelID} for role "${input.role}" rejected: ${input.violation}. No fallback was used.`,
  })
}

export type RoutingRead = MessageV2.RoutingControlPayload

type Input = {
  sessionID: SessionID
  role: string
  model: Model
  auxiliary?: boolean
  override?: Model
  // Read-only preview of exactly what execution selection would decide for
  // this session and role (pins and recorded overrides apply). Writes nothing.
  // Distinct from auxiliary, which skips pins and recorded overrides entirely.
  preview?: boolean
}

// Bounded automatic failover after a provider/model failure at request time.
// attempted lists the provider/model pairs already tried for the current user
// message; failover returns the next permitted candidate the routing policy
// allows, or undefined when every candidate is exhausted. Ordering is
// pinned-provider candidates first (in configured order), then candidates on
// other providers. Only a cross-provider pick persists a new pin (plus a
// repoint of a stale recorded override that would otherwise fail closed
// against the new pin); same-provider picks write nothing so explicit
// overrides stay authoritative for later turns.
type FailoverInput = {
  sessionID: SessionID
  role: string
  model: Model
  attempted?: readonly Model[]
  auxiliary?: boolean
}
export interface Interface {
  readonly resolve: (input: Input) => Effect.Effect<Model & { routed?: boolean }>
  readonly failover: (input: FailoverInput) => Effect.Effect<(Model & { pinUpdated: boolean }) | undefined>
  readonly check: (input: Input) => Effect.Effect<void>
  readonly command: (input: { sessionID: SessionID; action: string; model: Model }) => Effect.Effect<string>
  readonly read: (input: { sessionID: SessionID; model: Model }) => Effect.Effect<RoutingRead | undefined>
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
        const decoded = yield* Schema.decodeUnknownEffect(StoredState)(stored).pipe(Effect.orDie)
        const state: State = { ...decoded, overrides: decoded.overrides ?? {} }
        return { session, root, key, state }
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
      const state: State = { ...cfg.model_routing, anchor, pins: {}, overrides: {} }
      yield* storage.write(key, state).pipe(Effect.orDie)
      return { session, root, key, state }
    })

    const selection = Effect.fn("ModelRouting.selection")(function* (
      loaded: NonNullable<Effect.Success<ReturnType<typeof load>>>,
      input: Input,
      opts?: { ignoreOverride?: boolean },
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
      // An empty candidate list behaves like a missing role and falls back to
      // the anchor branch below, so warn-proceed guards and downstream
      // resolution agree instead of failing closed on [].
      const roleCandidates = state.roles[input.role]
      const hasRoleCandidates = Array.isArray(roleCandidates) && roleCandidates.length > 0
      const candidates = hasRoleCandidates
        ? roleCandidates.map((candidate) =>
            candidate === "session" ? input.model : Provider.parseModel(candidate),
          )
        : [!session.parentID && !input.auxiliary ? input.model : state.anchor]
      const permittedIgnoringPin = (candidate: Model) =>
        (state.scope !== "same" || candidate.providerID === state.anchor.providerID) &&
        !cfg.disabled_providers?.includes(candidate.providerID) &&
        (!cfg.enabled_providers || cfg.enabled_providers.includes(candidate.providerID)) &&
        Boolean(available[candidate.providerID]?.models[candidate.modelID])
      const permitted = (candidate: Model) =>
        (!pin || candidate.providerID === pin) && permittedIgnoringPin(candidate)
      const formatCandidate = (candidate: Model) => `${candidate.providerID}/${candidate.modelID}`
      // An explicit per-call override wins over role candidates but must pass
      // every policy gate itself. A recorded override (written at Task
      // admission) applies to later turns of the same session and role so
      // downstream resolve/check cannot reroute back to the role default.
      const recorded = state.overrides[session.id]
      const recordedOverride = recorded && !input.auxiliary && recorded.role === input.role ? recorded : undefined
      const explicit = opts?.ignoreOverride ? undefined : (input.override ?? recordedOverride)
      if (explicit) {
        // An explicitly requested switch re-pins the child instead of being
        // blocked by the old pin; a recorded override must still match it.
        const effectivePin = input.override ? undefined : pin
        const violation = explicitOverrideViolation({
          providerID: explicit.providerID,
          modelID: explicit.modelID,
          scope: state.scope,
          anchorProviderID: state.anchor.providerID,
          pin: effectivePin,
          disabledProviders: cfg.disabled_providers,
          enabledProviders: cfg.enabled_providers,
          catalogHasModel: Boolean(available[explicit.providerID]?.models[explicit.modelID]),
        })
        if (violation)
          return yield* Effect.die(
            overrideRejection({
              providerID: explicit.providerID,
              modelID: explicit.modelID,
              role: input.role,
              violation,
            }),
          )
        const selected = { providerID: explicit.providerID, modelID: explicit.modelID }
        return { selected, candidates: [selected], pin, pinFree: [], anchorFallback: false, permittedIgnoringPin }
      }
      const selected = candidates.find(permitted)
      // In same scope the anchor model always satisfies the provider contract,
      // so a configured role whose candidates all sit on other providers can
      // fall back to it when the config opts in. Curated stays fail-closed.
      const anchorFallback =
        !selected &&
        state.scope === "same" &&
        state.anchor_fallback === true &&
        hasRoleCandidates &&
        (!pin || pin === state.anchor.providerID) &&
        permitted(state.anchor)
      // Candidates blocked ONLY by the stale child pin: every other policy
      // gate passes, so resuming with one of these exact models is a valid
      // switch. Candidates failing anything else are never suggested.
      const pinFree =
        !selected && pin
          ? [
              ...new Set(
                candidates
                  .filter((candidate) => !permitted(candidate) && permittedIgnoringPin(candidate))
                  .map(formatCandidate),
              ),
            ]
          : []
      return {
        selected: selected ?? (anchorFallback ? state.anchor : undefined),
        candidates,
        pin,
        pinFree,
        anchorFallback: !selected && anchorFallback,
        permittedIgnoringPin,
      }
    })

    const resolve = Effect.fn("ModelRouting.resolve")(function* (input: Input) {
      const loaded = yield* load(input.sessionID, input.model)
      if (!loaded) {
        // Routing is off, so there is no anchor or pin — but an explicit
        // override still answers to global provider policy and the catalog.
        if (!input.override) return input.model
        const overrideCfg = yield* config.get()
        const overrideAvailable = yield* provider.list()
        const violation = explicitOverrideViolation({
          providerID: input.override.providerID,
          modelID: input.override.modelID,
          scope: "curated",
          anchorProviderID: input.override.providerID,
          pin: undefined,
          disabledProviders: overrideCfg.disabled_providers,
          enabledProviders: overrideCfg.enabled_providers,
          catalogHasModel: Boolean(overrideAvailable[input.override.providerID]?.models[input.override.modelID]),
        })
        if (violation)
          return yield* Effect.die(
            overrideRejection({
              providerID: input.override.providerID,
              modelID: input.override.modelID,
              role: input.role,
              violation,
            }),
          )
        return { ...input.override }
      }
      const { state, session, root, key } = loaded
      const configuredCandidates = state.roles[input.role]
      const hasConfiguredCandidates =
        Array.isArray(configuredCandidates) && configuredCandidates.length > 0
      if (
        !session.parentID &&
        !input.auxiliary &&
        !hasConfiguredCandidates &&
        state.scope === "same" &&
        input.model.providerID !== state.anchor.providerID
      ) {
        return yield* Effect.die(
          new RoutingError({
            message: `Selected root model ${input.model.providerID}/${input.model.modelID} is outside the same-provider anchor ${state.anchor.providerID}. Select a model from ${state.anchor.providerID} or use /routing curated; no fallback was used.`,
          }),
        )
      }
      const { selected, pin, pinFree } = yield* selection(loaded, input)
      if (!selected) {
        const qualifier = `legacy routing ${state.scope}, anchor ${state.anchor.providerID}${pin ? `, child pinned to ${pin}` : ""}`
        if (pinFree.length > 0) {
          const [first, ...rest] = pinFree
          return yield* Effect.die(
            new RoutingError({
              message: `No permitted available model for role "${input.role}" (${qualifier}). Permitted alternatives ignoring the pin: ${pinFree.join(", ")}. Resume the same task with task_id="${session.id}" and model="${first}" to switch; the pin updates.${rest.length > 0 ? ` Other exact IDs: ${rest.join(", ")}.` : ""}`,
            }),
          )
        }
        if (pin)
          return yield* Effect.die(
            new RoutingError({
              message: `No permitted available model for role "${input.role}" (${qualifier}). No alternative satisfies the anchor/provider/catalog policy; change the provider restrictions (/routing scope, enabled providers, role candidates) or clarify which model this session should run.`,
            }),
          )
        return yield* Effect.die(
          new RoutingError({
            message: `No permitted available model for role "${input.role}" (${qualifier}). Change /routing scope or start a new root with matching role candidates; no fallback was used.`,
          }),
        )
      }
      if (session.id !== root.id && !input.auxiliary && !input.preview) {
        // An explicit switch re-pins the child and records the sticky
        // override together in one write; implicit turns keep both as-is.
        const nextPins =
          input.override || !state.pins[session.id]
            ? { ...state.pins, [session.id]: selected.providerID }
            : state.pins
        const nextOverrides = input.override
          ? {
              ...state.overrides,
              [session.id]: { role: input.role, providerID: selected.providerID, modelID: selected.modelID },
            }
          : state.overrides
        if (nextPins !== state.pins || nextOverrides !== state.overrides) {
          yield* storage
            .write(key, { ...state, pins: nextPins, overrides: nextOverrides })
            .pipe(Effect.orDie)
        }
      }
      return { ...selected, routed: true }
    }, lock.withPermits(1))

    const failover = Effect.fn("ModelRouting.failover")(function* (input: FailoverInput) {
      const loaded = yield* load(input.sessionID, input.model)
      if (!loaded) return undefined
      const { state, session, root, key } = loaded
      // Order from the role candidates under the same permit predicates as
      // selection, ignoring any recorded or per-call override: failover only
      // engages when the override model itself already failed, and then only
      // other policy-permitted candidates are eligible.
      const view = yield* selection(
        loaded,
        { sessionID: input.sessionID, role: input.role, model: input.model, auxiliary: input.auxiliary },
        { ignoreOverride: true },
      )
      const attempted = new Set((input.attempted ?? []).map((model) => `${model.providerID}/${model.modelID}`))
      const remaining = view.candidates.filter(
        (candidate) =>
          !attempted.has(`${candidate.providerID}/${candidate.modelID}`) &&
          view.permittedIgnoringPin(candidate),
      )
      const ordered = view.pin
        ? [
            ...remaining.filter((candidate) => candidate.providerID === view.pin),
            ...remaining.filter((candidate) => candidate.providerID !== view.pin),
          ]
        : remaining
      // Mirror selection's anchor fallback as a last resort when the anchor
      // itself has not been attempted yet.
      const anchorKey = `${state.anchor.providerID}/${state.anchor.modelID}`
      const pick = ordered[0] ?? (view.anchorFallback && !attempted.has(anchorKey) ? state.anchor : undefined)
      if (!pick) return undefined
      if (session.id === root.id || input.auxiliary || view.pin === undefined || pick.providerID === view.pin) {
        return { ...pick, pinUpdated: false }
      }
      // Cross-provider pick: persist the new pin atomically so later turns
      // agree. Any recorded override for this child is keyed by session and
      // stores one role, so it must agree with the new pin. Repoint it when it
      // belongs to the failing role; drop it when it belongs to another role,
      // because keeping it would fail closed against the new pin forever.
      // Same-provider picks write nothing, leaving explicit overrides
      // authoritative for later turns.
      const recorded = state.overrides[session.id]
      let nextOverrides = state.overrides
      if (recorded && recorded.providerID !== pick.providerID) {
        if (recorded.role === input.role) {
          nextOverrides = {
            ...state.overrides,
            [session.id]: { role: input.role, providerID: pick.providerID, modelID: pick.modelID },
          }
        } else {
          nextOverrides = Object.fromEntries(
            Object.entries(state.overrides).filter(([childSessionID]) => childSessionID !== session.id),
          )
          yield* Effect.logWarning("failover dropped incompatible override", {
            "session.id": session.id,
            role: recorded.role,
            from: `${recorded.providerID}/${recorded.modelID}`,
            pin: pick.providerID,
          })
        }
      }
      yield* storage
        .write(
          key,
          { ...state, pins: { ...state.pins, [session.id]: pick.providerID }, overrides: nextOverrides },
        )
        .pipe(Effect.orDie)
      return { ...pick, pinUpdated: true }
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
          ? {
              ...cfg.model_routing,
              anchor: loaded.state.anchor,
              pins: loaded.state.pins,
              overrides: loaded.state.overrides,
            }
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
              auxiliary: ["title", "summary", "compaction", "reasoning-brief"].includes(role),
            },
          )
          return `${role}: ${result.selected ? `${result.selected.providerID}/${result.selected.modelID}${result.anchorFallback ? " (anchor fallback: no configured candidate matches the anchor provider in same scope)" : ""}` : "unavailable"}; candidates (in order): ${result.candidates.map((candidate) => `${candidate.providerID}/${candidate.modelID}`).join(" -> ") || "none"}${result.pin ? `; child provider: ${result.pin}` : ""}`
        }),
      )
      const sticky = Object.entries(state.overrides).toSorted(([left], [right]) => (left < right ? -1 : 1))
      return [
        `Legacy model routing: ${scope}`,
        `Root session: ${loaded.root.id}`,
        `Provider anchor: ${state.anchor.providerID}`,
        ...roles,
        `Explicit Task overrides (sticky per child session): ${sticky.length > 0 ? sticky.map(([sessionID, override]) => `${sessionID} ${override.role} -> ${override.providerID}/${override.modelID}`).join("; ") : "none"}`,
        `Unconfigured child and auxiliary roles: ${state.anchor.providerID}/${state.anchor.modelID} (subject to availability and child provider pin)`,
        "Role candidates are snapshotted when this root opts in; /routing refresh rewrites the snapshot (scope, anchor_fallback, roles) from the current config while keeping the anchor, child provider pins, and explicit Task overrides, and removes the stored state when model_routing config is gone. Configured roles always use their candidate lists; the literal \"session\" candidate follows whatever model the session is currently running (skipped for a later candidate when the current model is not permitted); with anchor_fallback enabled, a same-scope role with no matching candidate runs the anchor model instead of failing (shown as anchor fallback above).",
        "Explicit Task overrides persist across refresh and are re-validated on every turn: a later config change that makes a recorded override impermissible fails that turn without substituting another model.",
        "Resume an idle child with task_id+model to switch its model (same provider) or provider (curated scope); the provider pin and sticky override update together, with no switch while the child is running and no implicit switch when model is omitted.",
        "For unconfigured root roles, /models selects the main model: same allows the anchor provider; curated also allows explicit choices from other permitted available providers.",
        "The provider anchor stays fixed when /models changes, so switching back to same restores the original provider restriction.",
        "Applies to this root and nested children. Resumed children retain their provider; incompatible routes fail without fallback. A routed turn that fails at the provider before producing text or tool work automatically tries the remaining permitted candidates (pinned provider first, then others, each at most once per turn); reviewer roles are excluded so independent review is never silently replaced.",
        "Scope changes apply to subsequent LLM calls, not requests already in flight. V2 sessions share this id space, but the V2 runner resolves models through the catalog without consulting routing state, so V2 turns are not gated.",
      ].join("\n")
    }, lock.withPermits(1))

    const read = Effect.fn("ModelRouting.read")(function* (input: { sessionID: SessionID; model: Model }) {
      const loaded = yield* load(input.sessionID, input.model).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!loaded) return undefined
      if (!loaded.state.anchor) return undefined
      return {
        scope: loaded.state.scope,
        rootSessionID: loaded.root.id,
        anchor: {
          providerID: loaded.state.anchor.providerID,
          modelID: loaded.state.anchor.modelID,
        },
      }
    })

      return Service.of({ resolve, failover, check, command, read })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, Session.node, Storage.node, Provider.node],
})

export * as ModelRouting from "./model-routing"
