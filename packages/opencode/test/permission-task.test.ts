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
  const parent = [{ permission: "bash", pattern: "*", action: "allow" as const }]

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

  test.each([
    "sed -n '1,5p' x",
    "sed -n '1,20p' file",
    "sed -n '/i /p' file",
    "sed -n '/ -i /p' f",
    "sed -e 's/i/I/' f",
    "sed -n \"/ -i /p\" f",
    "sed -e '-i' f",
    "sed -n -- -i f",
    "sed --quiet --expression=p f",
    "sed --regexp-extended -n p f",
    "sed",
  ])("allows read-only sed: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  test.each([
    "sed -i 's/a/b/' f",
    "sed -i.bak 's/a/b/' f",
    "sed --in-place 's/a/b/' f",
    "sed --in-place=.bak 's/a/b/' f",
    "sed -e x -i f",
    "sed -ni p f",
    "sed -Ei 's/a/b/' f",
    "sed -n -e p -i f",
    "sed 's/a/b/' f -i",
    "sed --in-pl 's/a/b/' f",
    "sed -s -i p f",
    "sed -n -i.bak p f",
  ])("denies in-place sed: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
  })

  // Expansion and malformed quoting fail closed: the shell could turn them into `-i`.
  test.each([
    'sed "$(printf -- -i)" s/a/b/ f',
    "sed $FLAGS f",
    "sed `echo -i` f",
    'sed "-$X" f',
    "sed ${FLAGS} f",
    "sed -n 'unterminated f",
    'sed -n "unterminated f',
    "sed -n p f\\",
    "sed {-i,-n} p f",
  ])("denies sed that may expand into in-place: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
  })

  // Preprocessing cases. argv confirmed with bash, using a printing stub in place
  // of sed (`sed() { printf '[%s]' "$@"; }`); real sed never ran:
  //   sed \<LF>-i s/a/b/ f      -> [-i][s/a/b/][f]   (continuation is deleted)
  //   sed -\<LF>i s/a/b/ f      -> [-i][s/a/b/][f]   (continuation inside a word)
  //   sed "-\<LF>i" x f         -> [-i][x][f]        (also inside double quotes)
  //   sed<TAB>-i x f            -> [-i][x][f]
  //   sed $"-i" x f             -> [-i][x][f]        (locale quoting)
  //   sed $'-i' x f             -> [-i][x][f]        (ANSI-C quoting)
  test.each([
    "sed \\\n-i s/a/b/ f",
    "sed -\\\ni s/a/b/ f",
    'sed "-\\\ni" x f',
    "sed\t-i x f",
    'sed $"-i" x f',
    "sed $'-i' x f",
    "sed \\\r\n-i s/a/b/ f",
    "sed\r-i x f",
    "sed\r -i x f",
    "sed -n p f\nsed -i x f",
    "sed -n p f \\\n -i",
    "sed -n p f\\\n# -i",
  ])("denies sed whose option is hidden by line continuation or quoting: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
  })

  // Only space, tab and newline separate words in bash; CR, VT, FF and NBSP stay
  // inside the word. A parser that split on them would invent an option boundary
  // and consume the real `-i` as the value of a fake `-e`. argv confirmed the
  // same way (<CR>, <VT>, <FF> are the raw control characters):
  //   sed -e 's/a/b/' foo<CR>-e -i f -> [-e][s/a/b/][foo<CR>-e][-i][f]
  //   sed -e x<VT>-e -i f            -> [-e][x<VT>-e][-i][f]
  //   sed -e x<FF>-e -i f            -> [-e][x<FF>-e][-i][f]
  //   sed -e x<NBSP>-e -i f          -> [-e][x<NBSP>-e][-i][f]   (NBSP is not a separator)
  //   sed<CR> -i x f                 -> bash: sed<CR>: command not found (not sed at all; deny is conservative)
  //   sed<CR>-i x f                  -> bash: sed<CR>-i: command not found (same)
  //   sed \<CR><LF>-i x f            -> [<CR>], then `-i x f` runs as its own command
  //   sed -n p \<CR>-i f             -> [-n][p][<CR>-i][f]
  test.each([
    "sed -e 's/a/b/' foo\r-e -i f",
    "sed -e x\v-e -i f",
    "sed -e x\f-e -i f",
    "sed -e x\u00a0-e -i f",
    "sed\r -i x f",
    "sed\r-i x f",
    "sed \\\r\n-i x f",
    "sed -n p \\\r-i f",
    "sed -n p f\r",
    "sed -n p f\u007f",
    "sed -n p f\u0000",
    // Fail closed even when the control character is quoted: `-n 'a<CR>b' f` is
    // [-n][a<CR>b][f] in bash, but any control character voids the safety argument.
    "sed -n 'a\rb' f",
    "sed --expression=x\r-e -i f",
    "sed --expression x\r-e -i f",
  ])("denies sed when a control character may hide a word boundary: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
  })

  // General rule: any unquoted expansion, glob or brace before a literal `--` makes
  // the command possibly in-place, in every position (inline option values, script,
  // file names). argv confirmed with the printing sed stub, FLAGS=' -i', X=b,
  // FILE='a b'; real sed never ran:
  //   sed -es/a/b/$FLAGS f              -> <-es/a/b/><-i><f>
  //   sed --expression=s/a/b/$FLAGS f   -> <--expression=s/a/b/><-i><f>
  //   sed -fscript$X f                  -> <-fscriptb><f>
  //   sed -n p $FILE                    -> <-n><p><a><b>        (word-split)
  //   sed -n "p" $FILE                  -> <-n><p><a><b>
  //   sed -n p "$FILE"                  -> <-n><p><a b>         (one word; denied anyway: still dynamic)
  //   sed -e "s/a/$X/" f                -> <-e><s/a/b/><f>      (denied anyway: still dynamic)
  test.each([
    "sed -es/a/b/$FLAGS f",
    "sed --expression=s/a/b/$FLAGS f",
    "sed -fscript$X f",
    "sed -n p $FILE",
    'sed -n "p" $FILE',
    'sed -n p "$FILE"',
    'sed -e "s/a/$X/" f',
    "sed -n p ${FILE}",
    "sed -n p $(echo f)",
    "sed -n p `echo f`",
    "sed -n p f{,.bak}",
    "sed$X -n p f",
  ])("denies sed with an unquoted expansion before --: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
  })

  // After a literal `--` words cannot be options. Single quotes keep `$` literal,
  // and double quotes without `$` or a backtick are literal too:
  //   sed -n p -- $FILE                 -> <-n><p><--><a><b>
  //   sed -n 's/$/x/p' f                -> <-n><s/$/x/p><f>
  //   sed -e 's/a/b/' -e p f            -> <-e><s/a/b/><-e><p><f>
  //   sed -n '1,5p' f                   -> <-n><1,5p><f>
  test.each([
    "sed -n p -- $FILE",
    "sed -n p -- *.txt",
    "sed -n 's/$/x/p' f",
    "sed -e 's/a/b/' -e p f",
    "sed -n '1,5p' f",
    'sed -n "1,5p" f',
    "sed -n 'p' '$FILE' f",
    "sedutil-cli --scan",
  ])("allows sed with only literal words before --: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  // Option values that are not a single literal word are not skipped, because
  // they can become several words: `-e *` could expand to `-e -i f`.
  test.each(["sed -e * f", "sed -e $X f", "sed --expression=x -e * f", "sed -f $(echo y) f"])(
    "denies sed whose option value may be several words: %s",
    (command) => {
      expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
    },
  )

  // NBSP is ordinary word text in bash, not a separator or control character:
  //   sed -n p a<NBSP>-i f -> [-n][p][a<NBSP>-i][f]
  //   sed -n p 'a b' f     -> [-n][p][a b][f]
  test.each([
    "sed -n '1,5p' f",
    "sed -n p 'a b' f",
    "sed -n p 'a\u00a0b' f",
    "sed -n p a\u00a0-i f",
    "sed -e 's/a/b/' -e p f",
  ])("still allows plain read-only sed: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  // argv confirmed the same way:
  //   sed -n \<LF>'1,5p' f      -> [-n][1,5p][f]
  //   sed -n p f # -i           -> [-n][p][f]        (`# -i` is a comment)
  //   sed -n 'a\<LF>b' f        -> [-n][a\<LF>b][f]  (single quotes keep it literal)
  //   sed -n "a\qb" f           -> [-n][a\qb][f]     (backslash stays before `q`)
  //   sed -n p f#-i             -> [-n][p][f#-i]     (`#` mid-word is not a comment)
  //   sed -n p f \<LF># -i      -> [-n][p][f]        (space first, so `#` starts a comment)
  //   sed -n p f<LF>-i          -> [-n][p][f], then `-i` runs as its own command
  // and in the deny list above:
  //   sed -n p f \<LF> -i       -> [-n][p][f][-i]
  //   sed -n p f\<LF># -i       -> [-n][p][f#][-i]   (continuation joins `#` to `f`, so -i is an argument)
  test.each([
    "sed -n \\\n'1,5p' f",
    "sed -n p f # -i",
    "sed -n 'a\\\nb' f",
    'sed -n "a\\qb" f',
    "sed -n p f#-i",
    "sed -n p f\n-i",
    "sed -n p f \\\n# -i",
  ])("allows sed when the continuation or comment hides nothing: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  // Pathname expansion can produce file names like `-i.bak`, which sed reads as
  // options. Read-only globs such as `*.txt` are denied too, by design.
  test.each(["sed -e 's/a/b/' *", "sed -n p *.txt", "sed -e x f?", "sed -e x [-]i*", "sed -n p f[0-9]"])(
    "denies sed with an unquoted glob: %s",
    (command) => {
      expect(Permission.evaluate("bash", command, parent, rules).action).toBe("deny")
    },
  )

  test.each([
    "sed -n '/a*/p' f",
    'sed -n "s/[0-9]//p" f',
    "sed -n '1,5p' file.txt",
    "sed -n 'p' 'f*'",
    "sed -n p f\\*",
    "sed -e 's/a*/b/' f",
  ])("allows quoted or escaped glob characters: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  test.each([
    "sed -n '$p' f",
    'sed -n "1,5p" f',
    "sed -n 'x$' f",
    "sed -e '$d' f",
    'sed -e "s/a/b/" -- f',
    "sed -n 1p f > out.txt",
  ])("allows quoted literals without expansion: %s", (command) => {
    expect(Permission.evaluate("bash", command, parent, rules).action).toBe("allow")
  })

  test("rules after the sibling rules still win, like any other rule", () => {
    expect(Permission.evaluate("bash", "sed -i x f", rules, parent).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm x", rules, parent).action).toBe("allow")
  })

  test("does not treat other commands as sed", () => {
    expect(Permission.evaluate("bash", "echo $FLAGS -i", parent, rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "grep -i x f", parent, rules).action).toBe("allow")
  })
})

// The in-place sed check is a sibling-only, deny-only step. Without the sibling
// rules, rules must match the real command text and nothing else.
describe("evaluate without sibling rules", () => {
  const rule = (pattern: string, action: "allow" | "deny" | "ask") => ({ permission: "bash", pattern, action })

  test("a user allow for the old synthetic string does not widen a deny", () => {
    const user = [rule("*", "deny"), rule("sed --in-place", "allow")]
    expect(Permission.evaluate("bash", "sed -i x f", user).action).toBe("deny")
    expect(Permission.evaluate("bash", "sed -i s/a/b/ private.txt", user).action).toBe("deny")
  })

  test("a user sed ask rule governs both in-place and read-only sed", () => {
    const user = [rule("sed *", "ask")]
    expect(Permission.evaluate("bash", "sed -i x f", user).action).toBe("ask")
    expect(Permission.evaluate("bash", "sed -n p f", user).action).toBe("ask")
  })

  test("an allow-all rule allows in-place sed when siblings are absent", () => {
    expect(Permission.evaluate("bash", "sed -i x f", [rule("*", "allow")]).action).toBe("allow")
  })

  test("a user rule for the marker permission name cannot match real bash commands", () => {
    const user = [{ permission: "sibling_in_place_sed", pattern: "*", action: "allow" as const }]
    expect(Permission.evaluate("bash", "ls", user).action).toBe("ask")
  })
})

describe("siblingConcurrencyPermission rules", () => {
  const rules = siblingConcurrencyPermission()
  const parent = [{ permission: "bash", pattern: "*", action: "allow" as const }]

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
