import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { ModelRouting } from "./model-routing"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { CommandFamily } from "@/tool/shell/command-family"

import { Effect, Layer, Context, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MIN_CHARS = 2_000
const TOOL_OUTPUT_MAX_CHARS = 12_000
const MIN_PRESERVE_RECENT_TOKENS = 2_000
// Recent work is the most likely to be referenced next; the old 15k cap squeezed the
// final stretch of long sessions into the summarizer, where dropped details are lost
// entirely (they are in neither the verbatim tail nor the summary).
const MAX_PRESERVE_RECENT_TOKENS = 40_000
// Token.estimate measures JSON chars/4, which undercounts tool-heavy tails by ~1.3-1.9x.
// Target the estimate at budget / TAIL_ESTIMATE_SAFETY so the real provider size fits.
const TAIL_ESTIMATE_SAFETY = 1.5
// A compaction that follows a previous summary with almost no new assistant work means
// the last tail was too big to prevent another overflow; shrink again instead of looping.
const LOOP_GUARD_ASSISTANT_MESSAGES = 3
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

// Keep the head and tail of oversized tool outputs, not just the head: paths and
// headers live at the start, but error messages and stack traces live at the end.
const truncate = (value: string, max: number) => {
  if (value.length <= max) return value
  const half = Math.floor((max - 64) / 2)
  return `${value.slice(0, half)}\n[${value.length - half * 2} chars truncated]\n${value.slice(-half)}`
}

// Scale the per-tool-output budget to the summarizer model's context so large-context
// models see more of each tool result instead of a fixed 2KB slice.
const toolOutputBudget = (input: { cfg: ConfigV1.Info; model: Provider.Model }) =>
  Math.min(TOOL_OUTPUT_MAX_CHARS, Math.max(TOOL_OUTPUT_MIN_CHARS, Math.floor(usable(input) * 0.1)))

const serialize = (message: SessionV1.WithParts, toolBudget: number) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    const subtasks = message.parts.flatMap((part) =>
      part.type === "subtask" ? [`[Subagent task launched]: agent=${part.agent}: ${part.description}`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files, ...subtasks].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? MessageV2.prunedToolStub(part.tool, part.state.input, part.state.output.length, part.state.metadata)
          : truncate([part.state.output, ...attachments].join("\n"), toolBudget)
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${truncate(part.state.error, toolBudget)}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function isRapidRecompaction(input: { messages: SessionV1.WithParts[]; prior: CompletedCompaction[] }) {
  const previous = input.prior.at(-1)
  if (!previous) return false
  const summary = input.messages[previous.assistantIndex]?.info
  if (!summary || summary.role !== "assistant") return false
  // Array position is not chronological: filterCompacted reorders to
  // [compaction-user, summary, ...retained tail..., newer...], so only count
  // assistants created after the summary (time.created, id tie-break).
  const assistants = input.messages.filter(
    (msg) =>
      msg.info.role === "assistant" &&
      !msg.info.summary &&
      (msg.info.time.created > summary.time.created ||
        (msg.info.time.created === summary.time.created && msg.info.id > summary.id)),
  ).length
  return assistants < LOOP_GUARD_ASSISTANT_MESSAGES
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

// Pruning clears an output from future replays, so results the model acts on directly (edits,
// skills, subagent results) are never cleared.
const PRUNE_NEVER_TOOLS = ["skill", "edit", "write", "apply_patch", "task"]
const PRUNE_BULKY_TOOLS = ["read", "webfetch", "glob", "grep"]
// Failure markers in check output. Only consulted for runs the shared classifier calls checks.
const CHECK_FAILURE = /\b[1-9]\d*\s+(?:fail|failed|failing|errors?)\b|\bFAIL\b|error TS\d+|\(fail\)|AssertionError|panicked/
// Pruning rewrites old parts, which invalidates the provider's prompt-prefix cache from the first
// rewritten part onward. Below this share of the usable window there is no near-term pressure to
// pay that cost, so pruning waits until the context is at least half full.
const PRUNE_CONTEXT_RATIO = 0.5

type PruneKind = "keep" | "bulky" | "other"

function pruneKind(part: SessionV1.ToolPart): PruneKind {
  if (part.state.status !== "completed") return "keep"
  if (PRUNE_NEVER_TOOLS.includes(part.tool)) return "keep"
  if (PRUNE_BULKY_TOOLS.includes(part.tool)) return "bulky"
  const command = part.state.input.command
  if (part.tool !== "bash" || typeof command !== "string") return "other"
  // A failed command's output is the evidence the next step works from, whatever the command was.
  const exit = part.state.metadata.exit
  if (typeof exit === "number" && exit !== 0) return "keep"
  const family = CommandFamily.classify(command)
  if (family === "check") {
    // Failures can hide behind exit 0 (runners that only print); only a clean run is bulk.
    return exit === 0 && !CHECK_FAILURE.test(part.state.output) ? "bulky" : "keep"
  }
  return family === "dump" ? "bulky" : "other"
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const routing = yield* ModelRouting.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
      loopGuard?: boolean
    }) {
      const limit = input.cfg.compaction?.tail_turns
      const disabled = limit !== undefined && limit <= 0
      const budget = disabled ? 0 : preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const safety = Math.floor(budget / TAIL_ESTIMATE_SAFETY)
      const loopGuard = !disabled && input.loopGuard === true
      const effective = loopGuard ? Math.floor(safety / 2) : safety
      const blocked = disabled || (loopGuard && effective < MIN_PRESERVE_RECENT_TOKENS)
      const all = blocked ? [] : turns(input.messages)
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      let keptTurns = 0
      let fallbackSize = 0
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= effective) {
          total += size
          keptTurns += 1
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = effective - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) {
          keep = split
          keptTurns += 1
          total += yield* estimate({
            messages: input.messages.slice(split.start, turn.end),
            model: input.model,
          })
        } else if (!keep) {
          fallbackSize = size
        }
        break
      }

      const tailStart = keep === undefined || keep.start === 0 ? undefined : keep.id
      yield* Effect.logInfo("tail select", {
        budget,
        effectiveBudget: effective,
        keptSize: tailStart === undefined ? 0 : total,
        keptTurns: tailStart === undefined ? 0 : keptTurns,
        tail_start_id: tailStart,
        loopGuard,
        fallbackSize,
      })
      if (keep === undefined || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // Whether the last step left the context at least PRUNE_CONTEXT_RATIO full. Reported usage and
    // the tool-output estimate are both lower bounds on the real context, so the larger wins; this
    // also covers assistant messages that carry no usage. An unknown window never blocks pruning.
    const contextPressure = Effect.fn("SessionCompaction.contextPressure")(function* (input: {
      cfg: ConfigV1.Info
      msgs: SessionV1.WithParts[]
      toolTokens: number
    }) {
      const last = input.msgs.findLast((msg) => msg.info.role === "assistant")?.info
      if (last?.role !== "assistant") return true
      const model = Option.getOrUndefined(yield* provider.getModel(last.providerID, last.modelID).pipe(Effect.option))
      if (!model) return true
      const window = usable({ cfg: input.cfg, model })
      if (window === 0) return true
      const reported =
        last.tokens.total || last.tokens.input + last.tokens.output + last.tokens.cache.read + last.tokens.cache.write
      return Math.max(reported, input.toolTokens) >= window * PRUNE_CONTEXT_RATIO
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space. Bulky, cheaply
    // re-fetchable outputs (whole-file reads, dumps, passing test logs) go first; other
    // outputs are only cleared, oldest first, when bulk alone does not reach PRUNE_MINIMUM.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!(cfg.compaction?.prune ?? true)) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let turns = 0
      // newest first, because the walk goes backwards
      const bulky: { part: SessionV1.ToolPart; tokens: number }[] = []
      const other: { part: SessionV1.ToolPart; tokens: number }[] = []

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (MessageV2.isControl(msg)) continue
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          // Not a stop condition: with selective pruning, older uncleared outputs can sit
          // behind an already-cleared one. A cleared stub is not worth counting.
          if (part.state.time.compacted) continue
          if (part.tool === "skill") continue
          const tokens = Token.estimate(part.state.output)
          total += tokens
          if (total <= PRUNE_PROTECT) continue
          // Never-prune outputs still fill the protect window; they are just never selected.
          const kind = pruneKind(part)
          if (kind === "keep") continue
          if (kind === "bulky") bulky.push({ part, tokens })
          else other.push({ part, tokens })
        }
      }

      const bulkyTokens = bulky.reduce((sum, item) => sum + item.tokens, 0)
      const toPrune = [...bulky]
      let pruned = bulkyTokens
      for (const item of other.toReversed()) {
        if (pruned > PRUNE_MINIMUM) break
        toPrune.push(item)
        pruned += item.tokens
      }

      yield* Effect.logInfo("found", { pruned, bulky: bulkyTokens, total })
      if (pruned > PRUNE_MINIMUM) {
        if (!(yield* contextPressure({ cfg, msgs, toolTokens: total }))) {
          yield* Effect.logInfo("prune deferred", { pruned })
          return
        }
        for (const item of toPrune) {
          if (item.part.state.status === "completed") {
            item.part.state.time.compacted = Date.now()
            yield* session.updatePart(item.part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      input = { ...input, messages: input.messages.filter((message) => !MessageV2.isControl(message)) }
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const routed = yield* routing.resolve({
        sessionID: input.sessionID,
        role: agent.name,
        model: agent.model ?? userMessage.model,
        auxiliary: true,
      })
      const model = yield* provider.getModel(routed.providerID, routed.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
        loopGuard: input.auto && isRapidRecompaction({ messages: history, prior }),
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const toolBudget = toolOutputBudget({ cfg, model })
      const conversation = msgs.map((msg) => serialize(msg, toolBudget)).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Review the summary above and the retained conversation that follows it. Continue from the latest state: prefer the newer conversation over the summary's Next Move when they differ, do not redo completed steps, and if no next step is actionable stop and wait for the user instead of restating the summary."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    ModelRouting.node,
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
