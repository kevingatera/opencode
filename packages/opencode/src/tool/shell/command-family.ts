// Classifies a shell command by the family of what it does, to choose output policy.
//
// Consumers:
// - shell.ts (inline output cap): "dump" keeps the head of the output (file or history
//   listings read top-down); "check" and "other" keep the tail.
// - session/compaction.ts (prune retention priority): "dump" output is pruned first after a
//   clean exit, "check" is pruned first only on exit 0 without a failure marker, and "other"
//   is pruned later, once bulky candidates are exhausted. This is retention priority, not
//   protection. Compaction always keeps non-zero exits, whatever the family.
//
// Contract: this is a heuristic over the raw string, not a shell parser. Classification is
// NOT guaranteed to be conservative. A misclassified command can be given the "dump" policy
// (head-only inline output, and pruned by compaction after a clean exit) even when its output
// matters. Quotes, pipelines, and redirects are handled as described below; anything the
// scanner cannot prove is a simple read falls back to "other".
export type Family = "dump" | "check" | "other"

const DUMP = new Set(["cat", "nl", "head", "tail", "ls", "find", "tree", "rg", "grep", "bat"])
// Filters that may follow a dump in a pipeline. This list is a heuristic for output classification
// only. It grants no permission or safety guarantee: awk, for example, can run system() or write files.
const FILTER = new Set(["cat", "head", "tail", "grep", "rg", "sort", "uniq", "wc", "cut", "sed", "awk", "jq", "nl"])
const GIT_DUMP = new Set(["show", "diff", "log"])
const CHECK = new Set(["tsgo", "tsc", "pytest", "vitest", "jest"])

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
const GIT_GLOBAL_FLAG = new Set(["--no-pager", "-P", "--paginate", "--no-optional-locks", "--bare"])

// Splits into sub-commands (separated by `&&`, `||`, `;`, newline) and each sub-command into
// pipeline stages (separated by `|`), each stage as argv. Only unquoted separators split.
// Returns null on an unterminated quote or on a construct the scanner does not model
// (`<`/`>` redirects and heredocs, which also covers `tee` writes via `>`): the caller answers "other".
function splitUnquoted(command: string): string[][][] | null {
  const commands: string[][][] = []
  let pipeline: string[][] = []
  let argv: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let hasWord = false

  const endWord = () => {
    if (hasWord) argv.push(word)
    word = ""
    hasWord = false
  }
  const endStage = () => {
    endWord()
    if (argv.length > 0) pipeline.push(argv)
    argv = []
  }
  const endCommand = () => {
    endStage()
    if (pipeline.length > 0) commands.push(pipeline)
    pipeline = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += ch
      hasWord = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasWord = true
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
      continue
    }
    if (ch === " " || ch === "\t") {
      endWord()
      continue
    }
    if (ch === "\n" || ch === ";") {
      endCommand()
      continue
    }
    if (ch === "&" && command[i + 1] === "&") {
      endCommand()
      i++
      continue
    }
    if (ch === "|" && command[i + 1] === "|") {
      endCommand()
      i++
      continue
    }
    if (ch === "|") {
      endStage()
      continue
    }
    if (ch === "<" || ch === ">") return null
    word += ch
    hasWord = true
  }
  if (quote) return null
  endCommand()
  return commands
}

// Drop git's global options so `git -C dir --no-pager log` is seen as `git log`.
function stripGitGlobals(args: string[]) {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (GIT_GLOBAL_WITH_VALUE.has(arg)) {
      i += 2
      continue
    }
    if (GIT_GLOBAL_FLAG.has(arg)) {
      i += 1
      continue
    }
    break
  }
  return args.slice(i)
}

// `sed -n 1,40p file` reads; `sed -i ...` edits in place and is not a dump.
function isReadSed(args: string[]) {
  return args.includes("-n") && !args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place")
}

// `awk` is a filter here only because redirects already return null in splitUnquoted;
// awk's own system()/print-to-file are not analysed, which is one of the documented gaps.
function isFilter(argv: string[]) {
  const [name, ...rest] = argv
  if (name === "sed") return isReadSed(rest)
  return FILTER.has(name)
}

function family(argv: string[]): Family {
  const [name, ...rest] = argv
  if (!name) return "other"

  if (name === "git") {
    const args = stripGitGlobals(rest)
    return GIT_DUMP.has(args[0] ?? "") ? "dump" : "other"
  }

  if (name === "bun") return rest[0] === "test" || rest[0] === "typecheck" ? "check" : "other"
  if (name === "npm") return rest[0] === "test" || (rest[0] === "run" && rest[1] === "test") ? "check" : "other"
  if (name === "go" || name === "cargo") return rest[0] === "test" ? "check" : "other"
  if (CHECK.has(name)) return "check"
  if (name === "sed") return isReadSed(rest) ? "dump" : "other"
  if (DUMP.has(name)) return "dump"
  return "other"
}

// A pipeline is a dump only if its first stage is a dump and every later stage is a filter.
// `cat f | python x.py` is other: the python stage can transform or discard what cat printed.
function pipelineFamily(pipeline: string[][]): Family {
  const [head, ...rest] = pipeline
  const first = family(head)
  if (first !== "dump") return first
  return rest.every(isFilter) ? "dump" : "other"
}

// Returns the family of the first sub-command that is not a bare `cd`.
// `cd x && git log` -> dump; `cd x; bun test` -> check; `cat f | wc -l` -> dump.
export function classify(command: string): Family {
  const commands = splitUnquoted(command)
  if (!commands) return "other"
  for (const pipeline of commands) {
    const [head] = pipeline[0]
    if (head === "cd" || head === "pushd" || head === "popd") continue
    return pipelineFamily(pipeline)
  }
  return "other"
}

export * as CommandFamily from "./command-family"
