import { PermissionV1 } from "@opencode-ai/core/v1/permission"

/**
 * Reserved permission key for the sibling in-place `sed` deny. It never matches
 * a real permission such as `bash`, so ordinary evaluation ignores it. Globs
 * cannot tell an option from quoted script text (`sed -n '/ -i /p'`), so
 * `siblingSedDenial` applies the deny after parsing the command's arguments.
 *
 * Session rules are persisted as plain JSON, so the marker is also how the
 * sibling rules are recognised later: no marker, no sibling provenance.
 */
export const SIBLING_SED_MARKER = "sibling_in_place_sed"

/** The rule reported when the sibling in-place `sed` deny fires. */
export const SIBLING_SED_RULE: PermissionV1.Rule = {
  permission: "bash",
  pattern: "sed -i / sed --in-place",
  action: "deny",
}

const SIBLING_DESTRUCTIVE_BASH = [
  "rm *",
  "rmdir *",
  "mv *",
  "cp *",
  "chmod *",
  "chown *",
  "ln *",
  "kill *",
  "killall *",
  "pkill *",
  "tee *",
  "truncate *",
  "git add *",
  "git checkout *",
  "git switch *",
  "git restore *",
  "git reset *",
  "git stash *",
  "git clean *",
  "git commit *",
  "git rebase *",
  "git merge *",
  "git cherry-pick *",
]

export const SIBLING_DENIAL_HINT =
  "Another subagent is running in this directory; destructive shell commands are blocked. Read-only commands and the edit tool are allowed."

/**
 * Extra session rules when another Task is already running in the same
 * directory. Edit stays allowed — the handoff prompt is the coordination
 * layer for overlapping files. Ordinary shell stays allowed; only
 * destructive prefixes are denied so siblings are not blocked on az/jq/python.
 */
export function siblingConcurrencyPermission(): PermissionV1.Ruleset {
  return [
    ...SIBLING_DESTRUCTIVE_BASH.map((pattern) => ({ permission: "bash", pattern, action: "deny" as const })),
    { permission: SIBLING_SED_MARKER, pattern: "*", action: "deny" },
  ]
}

/**
 * The sibling deny for a bash command that may edit files with `sed` in place,
 * or undefined. `matched` is the index of the rule that already matched the
 * command, so like every rule the sibling deny only wins when it comes later.
 */
export function siblingSedDenial(permission: string, command: string, rules: PermissionV1.Ruleset, matched: number) {
  if (permission !== "bash") return undefined
  const marker = rules.findLastIndex((rule) => rule.permission === SIBLING_SED_MARKER && rule.action === "deny")
  if (marker <= matched) return undefined
  return editsSedInPlace(command) ? SIBLING_SED_RULE : undefined
}

/**
 * True when `rule` is a sibling-concurrency deny and the sibling rules are
 * active in `ruleset`. A user-authored `rm *` deny without the marker is not
 * attributed to siblings.
 */
export function isSiblingDenial(rule: PermissionV1.Rule, ruleset: PermissionV1.Ruleset) {
  if (!ruleset.some((item) => item.permission === SIBLING_SED_MARKER)) return false
  if (rule.permission !== "bash" || rule.action !== "deny") return false
  return rule.pattern === SIBLING_SED_RULE.pattern || SIBLING_DESTRUCTIVE_BASH.includes(rule.pattern)
}

/**
 * True when `command` is a `sed` that may edit in place. Fails closed: an
 * argument that could expand into an option, or a command that cannot be split
 * into shell words, counts as in-place.
 */
export function editsSedInPlace(command: string) {
  const lines = commandLines(command)
  if (!lines) return /^\s*sed\s/m.test(command)
  // The shell tool passes one command at a time, but a redirected command can
  // carry a heredoc, and any text with a newline is several commands.
  return lines.some((args) => {
    const name = args[0]
    if (!name) return false
    if (name.text === "sed" && !name.dynamic) return mayEditInPlace(args.slice(1))
    // `sed$X` or `sed<CR>` may or may not run sed in bash. Deny rather than guess.
    // Other names, such as `sedutil`, are not sed.
    return name.text.startsWith("sed") && unknown(name)
  })
}

// Control characters other than tab and newline, which are the only ones bash
// treats specially between words. Everything else, CR included, stays inside a
// word, so a parser that disagrees about it could hide an option.
function hasControl(text: string) {
  return [...text].some((char) => {
    const code = char.charCodeAt(0)
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f
  })
}

// A word the shell may rewrite or split into several words, or whose boundaries
// this parser may disagree about.
function unknown(word: Word) {
  return word.dynamic || hasControl(word.text)
}

// Decides whether a sed invocation may edit in place, from its words after the
// command name.
//
// General rule: every word up to the first literal `--` must be fully known. A
// word with an unquoted expansion (`$`, backtick, `${}`, `$()`, `$'..'`, `$".."`),
// an unquoted glob or brace, or a control character could become any number of
// words, such as an extra `-i` (`sed -es/a/b/$FLAGS f` with FLAGS=" -i"). That
// holds in every position: flags, inline or separate option values, script and
// file names. Such a command counts as in-place. Words after a literal `--`
// cannot be options and are not examined.
//
// Accepted trade-off: read-only commands with an unquoted variable or glob before
// `--`, like `sed -n p $FILE` or `sed -n p *.txt`, are denied while siblings run.
// The read and edit tools remain available, and `sed -n p -- $FILE` is allowed.
//
// For fully literal words only static option analysis is left. GNU sed permutes
// options, so one can follow the script or files.
function mayEditInPlace(args: Word[]) {
  for (let i = 0; i < args.length; i++) {
    if (unknown(args[i])) return true
    const arg = args[i].text
    if (arg === "--") return false
    if (!arg.startsWith("-") || arg === "-") continue

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=")
      const name = arg.slice(2, equals === -1 ? undefined : equals)
      // getopt accepts any unambiguous prefix, and `in-place` is the only long option starting with `i`.
      if (name && "in-place".startsWith(name)) return true
      // `--expression x` takes the next word as its value; `--expression=x` does not.
      if (equals === -1 && ["expression", "file", "line-length"].some((long) => long.startsWith(name))) {
        const value = args[++i]
        if (value && unknown(value)) return true
      }
      continue
    }

    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]
      if (flag === "i") return true
      if ("efl".includes(flag)) {
        // `-e script` takes the next word; `-es/a/b/` carries its value inline.
        if (j === arg.length - 1) {
          const value = args[++i]
          if (value && unknown(value)) return true
        }
        break
      }
      if (!/[A-Za-z]/.test(flag)) break
    }
  }
  return false
}

// `dynamic` is set when the word contains an expansion, an unquoted glob
// character (`*`, `?`, `[`) or an unquoted `{`.
interface Word {
  text: string
  dynamic?: boolean
}

// Length of a backslash-newline at `i`, which the shell deletes before word
// splitting. Only a bare LF counts: in bash, `\` + CR + LF escapes the CR (which
// stays in the word) and the LF then ends the command.
function lineContinuation(command: string, i: number) {
  return command.startsWith("\\\n", i) ? 2 : 0
}

// Minimal shell word splitting, one array of words per command line. Quotes and
// backslashes group and are removed. Nothing is expanded; words that would
// expand are flagged instead.
//
// - Single quotes are literal, so a backslash-newline inside them stays.
// - Elsewhere, and inside double quotes, backslash-newline is deleted outright
//   and does not separate words.
// - Double quotes still expand `$` and backticks. `$'..'` and `$".."` start with
//   an unquoted `$`, so they are flagged as expansions.
// - Inside double quotes a backslash only escapes `$`, backtick, `"` and `\`;
//   before anything else it stays literal.
// - An unquoted `{` is flagged because brace expansion can produce `-i`, and
//   unquoted glob characters because pathname expansion can produce file names
//   that start with `-`.
// - An unquoted newline ends the command. `#` at the start of a word begins a
//   comment that runs to the end of the line.
// - Only space, tab and (unquoted) newline separate words. CR, vertical tab,
//   form feed, NBSP and other Unicode whitespace stay inside the word, exactly
//   as in bash. Words containing control characters are rejected by the caller.
//
// Returns undefined for an unterminated quote or a trailing backslash.
function commandLines(command: string) {
  const lines: Word[][] = []
  let line: Word[] = []
  let word: Word | undefined
  const current = () => (word ??= { text: "" })
  const endWord = () => {
    if (word) line.push(word)
    word = undefined
  }
  const expansion = () => {
    current().dynamic = true
  }

  let i = 0
  while (i < command.length) {
    const char = command[i]
    if (char === "\n") {
      endWord()
      lines.push(line)
      line = []
      i++
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      i++
      continue
    }
    if (char === "#" && !word) {
      const end = command.indexOf("\n", i)
      i = end === -1 ? command.length : end
      continue
    }
    if (char === "\\") {
      const continuation = lineContinuation(command, i)
      if (continuation) {
        i += continuation
        continue
      }
      if (i + 1 >= command.length) return undefined
      current().text += command[i + 1]
      i += 2
      continue
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return undefined
      current().text += command.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (char === '"') {
      i++
      const target = current()
      while (command[i] !== '"') {
        // Double quotes keep `*`, `?`, `[` and `{` literal but still expand `$` and backticks.
        if (i >= command.length) return undefined
        if (command[i] === "\\") {
          const continuation = lineContinuation(command, i)
          if (continuation) {
            i += continuation
            continue
          }
          if (i + 1 >= command.length) return undefined
          const next = command[i + 1]
          target.text += '$`"\\'.includes(next) ? next : "\\" + next
          i += 2
          continue
        }
        if (command[i] === "$" || command[i] === "`") expansion()
        target.text += command[i]
        i++
      }
      i++
      continue
    }
    if ("$`{*?[".includes(char)) expansion()
    current().text += char
    i++
  }
  endWord()
  lines.push(line)
  return lines
}
