import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Permission } from "../src/permission"
import { siblingConcurrencyPermission, siblingSharesDirectory } from "../src/agent/subagent-permissions"
import { Config } from "@/config/config"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Config.node))

const load = Config.use.get()

describe("Permission.evaluate for permission.task", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("returns ask when no match (default)", () => {
    expect(Permission.evaluate("task", "code-reviewer", []).action).toBe("ask")
  })

  test("returns deny for explicit deny", () => {
    const ruleset = createRuleset({ "code-reviewer": "deny" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
  })

  test("returns allow for explicit allow", () => {
    const ruleset = createRuleset({ "code-reviewer": "allow" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
  })

  test("returns ask for explicit ask", () => {
    const ruleset = createRuleset({ "code-reviewer": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with deny", () => {
    const ruleset = createRuleset({ "orchestrator-*": "deny" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with allow", () => {
    const ruleset = createRuleset({ "orchestrator-*": "allow" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("allow")
  })

  test("matches wildcard patterns with ask", () => {
    const ruleset = createRuleset({ "orchestrator-*": "ask" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("ask")
    const globalRuleset = createRuleset({ "*": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", globalRuleset).action).toBe("ask")
  })

  test("later rules take precedence (last match wins)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      "orchestrator-fast": "allow",
    })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
  })

  test("matches global wildcard", () => {
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "allow" })).action).toBe("allow")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "deny" })).action).toBe("deny")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "ask" })).action).toBe("ask")
  })
})

describe("Permission.disabled for task tool", () => {
  // Note: The `disabled` function checks if a TOOL should be completely removed from the tool list.
  // It only disables a tool when there's a rule with `pattern: "*"` and `action: "deny"`.
  // It does NOT evaluate complex subagent patterns - those are handled at runtime by `evaluate`.
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("task tool is disabled when global deny pattern exists (even with specific allows)", () => {
    // When "*": "deny" exists, the task tool is disabled because the disabled() function
    // only checks for wildcard deny patterns - it doesn't consider that specific subagents might be allowed
    const ruleset = createRuleset({
      "orchestrator-*": "allow",
      "*": "deny",
    })
    const disabled = Permission.disabled(["task", "bash", "read"], ruleset)
    // The task tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is disabled when global deny pattern exists (even with ask overrides)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "ask",
      "*": "deny",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    // The task tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is disabled when global deny pattern exists", () => {
    const ruleset = createRuleset({ "*": "deny" })
    const disabled = Permission.disabled(["task"], ruleset)
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is NOT disabled when only specific patterns are denied (no wildcard)", () => {
    // The disabled() function only disables tools when pattern: "*" && action: "deny"
    // Specific subagent denies don't disable the task tool - those are handled at runtime
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      general: "deny",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    // The task tool is NOT disabled because no rule has pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(false)
  })

  test("task tool is enabled when no task rules exist (default ask)", () => {
    const disabled = Permission.disabled(["task"], [])
    expect(disabled.has("task")).toBe(false)
  })

  test("task tool is NOT disabled when last wildcard pattern is allow", () => {
    // Last matching rule wins - if wildcard allow comes after wildcard deny, tool is enabled
    const ruleset = createRuleset({
      "*": "deny",
      "orchestrator-coder": "allow",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    // The disabled() function uses findLast and checks if the last matching rule
    // has pattern: "*" and action: "deny". In this case, the last rule matching
    // "task" permission has pattern "orchestrator-coder", not "*", so not disabled
    expect(disabled.has("task")).toBe(false)
  })
})

describe("siblingConcurrencyPermission", () => {
  const rules = siblingConcurrencyPermission()

  test("does not lock file edits", () => {
    const parent = [{ permission: "*", pattern: "*", action: "allow" as const }]
    expect(Permission.evaluate("edit", "/tmp/file.ts", parent, rules).action).toBe("allow")
  })

  test("leaves ordinary commands to the agent ruleset", () => {
    const parent = [{ permission: "*", pattern: "*", action: "allow" as const }]
    expect(Permission.evaluate("bash", "ls *", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status *", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "python app.py", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "az boards query", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "jq -r . foo.json", parent, rules).action).toBe("allow")
  })

  test("blocks destructive shell prefixes", () => {
    expect(Permission.evaluate("bash", "rm *", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git checkout *", rules).action).toBe("deny")
  })

  test("does not prompt on unknown commands over a parent bash allow", () => {
    const parent = [{ permission: "bash", pattern: "*", action: "allow" as const }]
    expect(Permission.evaluate("bash", "python app.py", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "ls *", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm *", parent, rules).action).toBe("deny")
  })

  test("ignores the current session when detecting a shared directory", () => {
    expect(
      siblingSharesDirectory({
        parentID: "ses_parent",
        directory: "/tmp/repo",
        excludeSessionID: "ses_self",
        jobs: [
          {
            type: "task",
            status: "running",
            metadata: { parentSessionId: "ses_parent", sessionId: "ses_self", directory: "/tmp/repo" },
          },
        ],
      }),
    ).toBe(false)
  })

  test("treats siblings as sharing a directory when metadata is missing", () => {
    expect(
      siblingSharesDirectory({
        parentID: "ses_parent",
        directory: "/tmp/repo",
        jobs: [
          {
            type: "task",
            status: "running",
            metadata: { parentSessionId: "ses_parent" },
          },
        ],
      }),
    ).toBe(true)
  })

  test("does not sandbox siblings in different working trees", () => {
    expect(
      siblingSharesDirectory({
        parentID: "ses_parent",
        directory: "/tmp/repo/.worktrees/a",
        jobs: [
          {
            type: "task",
            status: "running",
            metadata: { parentSessionId: "ses_parent", directory: "/tmp/repo/.worktrees/b" },
          },
        ],
      }),
    ).toBe(false)
  })

  test("sandboxes siblings that resolve to the same directory", () => {
    expect(
      siblingSharesDirectory({
        parentID: "ses_parent",
        directory: "/tmp/repo/.worktrees/a",
        jobs: [
          {
            type: "task",
            status: "running",
            metadata: { parentSessionId: "ses_parent", directory: "/tmp/repo/.worktrees/a/../a" },
          },
        ],
      }),
    ).toBe(true)
  })
})

// Integration tests that load permissions from real config files
describe("permission.task with real config files", () => {
  it.instance(
    "loads task permissions from opencode.json config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        // general and orchestrator-fast should be allowed, code-reviewer denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "loads task permissions with wildcard patterns from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        // general and code-reviewer should be ask, orchestrator-* denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "ask",
            "orchestrator-*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "evaluate respects task permission from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        // Unspecified agents default to "ask"
        expect(Permission.evaluate("task", "unknown-agent", ruleset).action).toBe("ask")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "mixed permission config with task and other tools",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Verify task permissions
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

        // Verify other tool permissions
        expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
        expect(Permission.evaluate("edit", "*", ruleset).action).toBe("ask")

        // Verify disabled tools
        const disabled = Permission.disabled(["bash", "edit", "task"], ruleset)
        expect(disabled.has("bash")).toBe(false)
        expect(disabled.has("edit")).toBe(false)
        // task is NOT disabled because disabled() uses findLast, and the last rule
        // matching "task" permission is {pattern: "general", action: "allow"}, not pattern: "*"
        expect(disabled.has("task")).toBe(false)
      }),
    {
      git: true,
      config: {
        permission: {
          bash: "allow",
          edit: "ask",
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "task tool disabled when global deny comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Last matching rule wins - "*" deny is last, so all agents are denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("deny")

        // Since "*": "deny" is the last rule, disabled() finds it with findLast
        // and sees pattern: "*" with action: "deny", so task is disabled
        const disabled = Permission.disabled(["task"], ruleset)
        expect(disabled.has("task")).toBe(true)
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "allow",
            "*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "task tool NOT disabled when specific allow comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Evaluate uses findLast - "general" allow comes after "*" deny
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        // Other agents still denied by the earlier "*" deny
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

        // disabled() uses findLast and checks if the last rule has pattern: "*" with action: "deny"
        // In this case, the last rule is {pattern: "general", action: "allow"}, not pattern: "*"
        // So the task tool is NOT disabled (even though most subagents are denied)
        const disabled = Permission.disabled(["task"], ruleset)
        expect(disabled.has("task")).toBe(false)
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )
})
