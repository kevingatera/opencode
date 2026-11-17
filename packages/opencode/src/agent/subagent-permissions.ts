import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import type { Agent } from "./agent"

// The sibling policy lives in the permission module so permission does not depend on agent.
export { siblingConcurrencyPermission } from "@/permission/sibling"

export function resolveTaskDirectory(cwd: string, override?: string) {
  if (!override?.trim()) return path.resolve(cwd)
  return path.resolve(cwd, override.trim())
}

export function siblingSharesDirectory(input: {
  jobs: { type: string; status: string; metadata?: Record<string, unknown> }[]
  parentID: string
  directory: string
  taskType?: string
  excludeSessionID?: string
}) {
  const type = input.taskType ?? "task"
  const mine = path.resolve(input.directory)
  return input.jobs.some((job) => {
    if (job.type !== type || job.status !== "running") return false
    if (job.metadata?.parentSessionId !== input.parentID) return false
    if (input.excludeSessionID && job.metadata?.sessionId === input.excludeSessionID) return false
    const raw = job.metadata?.directory
    const theirs = typeof raw === "string" && raw.trim() ? path.resolve(raw) : mine
    return theirs === mine
  })
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent?: Agent.Info
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
