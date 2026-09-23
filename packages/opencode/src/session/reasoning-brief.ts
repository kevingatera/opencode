import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Database } from "@opencode-ai/core/database/database"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, DateTime, Effect } from "effect"
import * as Stream from "effect/Stream"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { ModelRouting } from "./model-routing"
import { Session } from "./session"
import { SessionID } from "./schema"

export const DEFAULT_MAX_OUTPUT_TOKENS = 256
export const DEFAULT_MAX_INPUT_CHARS = 9000
export const MAX_TASK_CHARS = 1000
export const MAX_ANSWER_CHARS = 2000
export const MAX_REASONING_CHARS = 6000
export const MAX_TOOL_CHARS = 1200
export const MAX_BRIEF_CHARS = 500
export const MAX_BRIEF_PROMPT_CHARS = 450
const MAX_TOOLS = 6
const TRUNCATION_MARKER = "\n[...truncated...]\n"

// One brief per reasoning block of the turn: a single plain-language paragraph.
// Post-turn fire-and-forget, persisted onto the reasoning part, never fails the turn.
export function truncateReasoning(text: string, maxChars = MAX_REASONING_CHARS) {
  if (text.length <= maxChars) return text
  const budget = maxChars - TRUNCATION_MARKER.length
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(text.length - tail)
}

export function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + TRUNCATION_MARKER
}

export function buildBriefInput(input: {
  task: string
  answer: string
  reasoning: string
  tools?: string[]
  maxOutputTokens: number
}) {
  const task = input.task.slice(0, MAX_TASK_CHARS)
  const answer = input.answer.slice(0, MAX_ANSWER_CHARS)
  const reasoning = truncateReasoning(input.reasoning)
  const tools = (input.tools ?? []).map((entry) => truncateText(entry, MAX_TOOL_CHARS)).join("\n")
  return [
    `Describe what was done and decided in one plain-language paragraph of at most ${MAX_BRIEF_PROMPT_CHARS} characters, including spaces. Keep it under ${input.maxOutputTokens} output tokens.`,
    "Write it as a plain description of completed work. Never narrate thinking and never describe plans: no planned, next, will, intended, or prepared to. Use past tense for actions that happened. The reader is technical: keep exact terms, filenames, numbers. Gloss genuine jargon once, then use it freely; never explain everyday tooling.",
    "Ground every claim in the final answer, the tool results, or the thinking. State outcomes, not intentions.",
    "The final answer may be empty. When it is, describe only concrete actions and findings present in the tool results or the thinking. If there is no completed action or finding, output an empty string. Never invent content.",
    "FORBIDDEN: bullets, labels, bold, headings, first-person rambling, filler, verbatim repeats, forward-looking statements.",
    "",
    `<task>${task}</task>`,
    `<final>${answer}</final>`,
    `<tools>${tools}</tools>`,
    `<thinking>${reasoning}</thinking>`,
  ].join("\n")
}

// Per-model resolution: an explicit entry for this turn's model wins,
// otherwise the master default applies (off when unset).
export function isBriefEnabled(
  config: { enabled?: boolean; models?: Record<string, boolean> } | undefined,
  providerID: string,
  modelID: string,
) {
  if (!config) return false
  const entry = config.models?.[`${providerID}/${modelID}`]
  if (entry !== undefined) return entry
  return config.enabled ?? false
}
// Title-only thinking carries no committable content: a complete "**Title**"
// with no body, or an unclosed "**Title" fragment. Closed-source evidence
// shows openai-style providers emit these in ~99% of turns; calling the
// brief model on them only invents decisions, so the gate skips them.
// Mirrors the TUI reasoningSummary title detection (display owns its copy).
export function isTitleOnlyReasoning(text: string) {
  const content = text.replace("[REDACTED]", "").trim()
  if (!content) return true
  const complete = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (complete) return content.slice(complete[0].length).trim().length === 0
  if (content.startsWith("**") && !content.slice(2).includes("**")) return true
  return false
}

// Single gating point: config toggle on, reasoning present and committable,
// not opaque. OpenRouter-style encrypted blocks carry metadata with no
// visible text; those never trigger a call.
export function shouldRequestBrief(input: { enabled: boolean; text: string; metadata?: unknown }) {
  if (!input.enabled) return false
  if (isTitleOnlyReasoning(input.text)) return false
  if (input.metadata !== undefined && input.metadata !== null) return false
  return true
}

export function cleanBrief(text: string) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    // Providers leak their own channel/tool markup into otherwise plain text:
    // stray closing tags (</think>), wrappers (<final>, <unknown>), and
    // DeepSeek DSML tool syntax. Strip them so the brief stays a paragraph.
    .replace(/<\/?(?:think|final|unknown|result|tool_calls|tool_call|invoke|parameter)\b[^>]*>/gi, " ")
    .replace(/<\/?[｜|][^<>]*>/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= MAX_BRIEF_CHARS) return cleaned
  return cleaned.substring(0, MAX_BRIEF_CHARS - 3).trimEnd() + "..."
}

// Backpressure: skip when a brief for the same reasoning part is in flight.
// No queue, no retry storm; the next turn gets its own chance.
const inflight = new Set<string>()

function briefKey(sessionID: string, messageID: string, reasoningID: string) {
  return `${sessionID}:${messageID}:${reasoningID}`
}

export function isBriefInflight(sessionID: string, messageID: string, reasoningID: string) {
  return inflight.has(briefKey(sessionID, messageID, reasoningID))
}

export const requestBriefsForTurn = Effect.fn("ReasoningBrief.requestBriefsForTurn")(function* (
  sessionID: SessionID,
) {
  const config = yield* Config.Service
  const briefConfig = (yield* config.get()).reasoning_brief
  if (!briefConfig) return
  const maxOutputTokens = briefConfig.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const maxInputChars = briefConfig.max_input_chars ?? DEFAULT_MAX_INPUT_CHARS

  // Mirror the title flow: auxiliary calls never run for child sessions.
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
  if (!session) return
  if (session.parentID) return

  const database = yield* Database.Service
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
    Effect.provideService(Database.Service, database),
  )
  const { user: lastUser, assistant: lastAssistant } = MessageV2.latest(msgs)
  if (!lastUser || !lastAssistant) return
  if (lastAssistant.parentID !== lastUser.id) return
  if (!lastAssistant.time.completed) return
  if (!isBriefEnabled(briefConfig, lastUser.model.providerID, lastUser.model.modelID)) return

  const userMsg = msgs.find((msg) => msg.info.id === lastUser.id)
  if (!userMsg) return
  // Every completed assistant message of the current turn carries its own
  // reasoning blocks; brief each of them in chronological order, not just
  // the latest message's blocks.
  const turnAssistants = msgs
    .filter(
      (msg): msg is SessionV1.WithParts & { info: SessionV1.Assistant } =>
        msg.info.role === "assistant" && msg.info.parentID === lastUser.id && msg.info.time.completed !== undefined,
    )
    .sort(
      (a, b) => a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0),
    )
  if (turnAssistants.length === 0) return

  const task = userMsg.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  // Sequential: the caller already forks this flow detached, and the
  // in-flight set keeps overlapping turns from stacking duplicate calls.
  for (const assistantMsg of turnAssistants) {
    const answer = assistantMsg.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    // Tool results carry the outcomes for reasoning-only steps whose final
    // answer is empty; without them a brief can only paraphrase a plan.
    const tools = assistantMsg.parts
      .flatMap((part) => {
        if (part.type !== "tool") return []
        if (part.state.status !== "completed") return []
        return [`${part.tool}: ${part.state.output}`]
      })
      .slice(-MAX_TOOLS)
    const reasoningParts = assistantMsg.parts.filter(
      (part): part is SessionV1.ReasoningPart => part.type === "reasoning",
    )
    for (const part of reasoningParts) {
      if (!shouldRequestBrief({ enabled: true, text: part.text, metadata: part.metadata })) continue
      const key = briefKey(sessionID, assistantMsg.info.id, part.id)
      if (inflight.has(key)) continue
      inflight.add(key)
      yield* requestOne({
        sessionID,
        user: lastUser,
        providerID: lastUser.model.providerID,
        modelID: lastUser.model.modelID,
        task,
        answer,
        tools,
        reasoning: part.text,
        messageID: assistantMsg.info.id,
        reasoningID: part.id,
        maxOutputTokens,
        maxInputChars,
      }).pipe(
        Effect.ensuring(Effect.sync(() => inflight.delete(key))),
        Effect.catchCause((cause) =>
          Effect.logWarning("reasoning brief skipped", { error: String(Cause.squash(cause)) }),
        ),
      )
    }
  }
})

const requestOne = Effect.fn("ReasoningBrief.requestOne")(function* (input: {
  sessionID: SessionID
  user: SessionV1.User
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  task: string
  answer: string
  tools: string[]
  reasoning: string
  messageID: string
  reasoningID: string
  maxOutputTokens: number
  maxInputChars: number
}) {
  const agents = yield* Agent.Service
  const routing = yield* ModelRouting.Service
  const provider = yield* Provider.Service
  const llm = yield* LLM.Service
  const events = yield* EventV2Bridge.Service

  const ag = yield* agents.get("reasoning-brief")
  if (!ag) return
  // Resolution order mirrors the title flow: routed model, agent model,
  // then the cheap shared model with fallback to the turn model.
  const routed = yield* routing.resolve({
    sessionID: input.sessionID,
    role: ag.name,
    model: { providerID: input.providerID, modelID: input.modelID },
    auxiliary: true,
  })
  const mdl = routed.routed
    ? yield* provider.getModel(routed.providerID, routed.modelID)
    : ag.model
      ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
      : ((yield* provider.getSmallModel(input.providerID)) ??
        (yield* provider.getModel(input.providerID, input.modelID)))
  const prompt = truncateText(
    buildBriefInput({
      task: input.task,
      answer: input.answer,
      tools: input.tools,
      reasoning: input.reasoning,
      maxOutputTokens: input.maxOutputTokens,
    }),
    input.maxInputChars,
  )
  const text = yield* llm
    .stream({
      agent: ag,
      user: input.user,
      system: [],
      small: true,
      tools: {},
      model: mdl,
      sessionID: input.sessionID,
      retries: 1,
      messages: [{ role: "user", content: prompt }],
    })
    .pipe(
      Stream.filter(LLMEvent.is.textDelta),
      Stream.map((e) => e.text),
      Stream.mkString,
      Effect.orDie,
    )
  const brief = cleanBrief(text)
  if (!brief) return
  yield* events.publish(SessionEvent.Reasoning.Brief, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    assistantMessageID: input.messageID as SessionMessage.ID,
    reasoningID: input.reasoningID,
    brief,
  })
})

export function inflightForTests() {
  return inflight
}

export * as ReasoningBrief from "./reasoning-brief"
