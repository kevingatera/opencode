import { SessionV1 } from "@opencode-ai/core/v1/session"

export const HUMAN_WAIT_ONLY_TOOLS = new Set(["question", "plan_exit"])

// Internal part-metadata key. Must never reach provider request metadata; see
// `providerMeta` in `message-v2.ts`, which strips it alongside providerExecuted.
export const HUMAN_WAIT_METADATA_KEY = "humanWaitMs"

export function isHumanWaitOnlyTool(tool: string) {
  return HUMAN_WAIT_ONLY_TOOLS.has(tool)
}

function existingWaitMs(part: SessionV1.ToolPart) {
  const value = part.metadata?.[HUMAN_WAIT_METADATA_KEY]
  return typeof value === "number" ? value : 0
}

export function accumulateWait(part: SessionV1.ToolPart, ms: number): SessionV1.ToolPart {
  if (!(ms > 0)) return part
  const increment = Math.floor(ms)
  if (increment <= 0) return part
  return {
    ...part,
    metadata: { ...part.metadata, [HUMAN_WAIT_METADATA_KEY]: existingWaitMs(part) + increment },
  }
}

export function finalizeWait(part: SessionV1.ToolPart, end: number): SessionV1.ToolPart {
  if (!isHumanWaitOnlyTool(part.tool)) return part
  if (part.state.status === "pending") return part
  const span = Math.max(0, end - part.state.time.start)
  return {
    ...part,
    metadata: { ...part.metadata, [HUMAN_WAIT_METADATA_KEY]: Math.max(existingWaitMs(part), span) },
  }
}

export * as HumanWait from "./human-wait"
