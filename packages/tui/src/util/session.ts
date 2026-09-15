import type { Part } from "@opencode-ai/sdk/v2"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function toolWaitMs(part: Part): number {
  if (part.type !== "tool" || part.state.status === "pending") return 0
  const value = part.metadata?.humanWaitMs
  return typeof value === "number" ? value : 0
}

function sumToolWait(parts: Part[]): number {
  let total = 0
  for (const part of parts) total += toolWaitMs(part)
  return total
}

export function turnElapsedMs(input: { start: number; completed: number | undefined; parts: Part[][] }): number {
  if (input.completed === undefined) return 0
  return Math.max(0, input.completed - input.start - sumToolWait(input.parts.flat()))
}

export function subagentElapsedMs(input: {
  partStart: number | undefined
  firstUserCreated: number | undefined
  lastCompleted: number | undefined
  parts: Part[]
}): number {
  const end = input.lastCompleted
  if (end === undefined) return 0
  const start = Math.max(input.firstUserCreated ?? input.partStart ?? end, input.partStart ?? 0)
  if (end < start) return 0
  const threshold = input.partStart ?? 0
  let waited = 0
  for (const part of input.parts) {
    if (part.type !== "tool" || part.state.status === "pending") continue
    if (part.state.time.start < threshold) continue
    waited += toolWaitMs(part)
  }
  return Math.max(0, end - start - waited)
}
