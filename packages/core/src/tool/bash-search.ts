export const SEARCH_OUTPUT_PREVIEW_LINES = 40

const SEARCH_CMD_RE = /\b(?:command\s+)?(rg|grep)\b/gi
const DIFF_PIPE_RE = /\b(git\s+(?:show|diff|grep|log)|git\s+.*\|\s*(?:rg|grep)\b)/i
const BOUNDED_LONG_FLAG_RE =
  /(?:^|\s)(--count(?:-matches)?|--files-with-matches|--max-count(?:=|\s)|--glob(?:=|\s)|--type(?:=|\s)|--type-add(?:=|\s)|--include(?:=|\s)|--exclude(?:=|\s)|--json)\b/i
const BOUNDED_SHORT_FLAG_RE = /(?:^|\s)-[A-Za-z]*[clmgt][A-Za-z]*/i
const OUTPUT_LIMIT_RE = /\|\s*head(?:\s+-(?:n\s+)?\d+)?\b/i

const isSearchInvocationStart = (before: string) => {
  const trimmed = before.trimEnd()
  return /(?:^|(?:;|&&|\|\||\|)\s*|\(\s*)$/.test(before) || /\|\s*$/.test(trimmed)
}

const searchInvocationStarts = (command: string) => {
  const starts: number[] = []
  for (const match of command.matchAll(SEARCH_CMD_RE)) {
    const start = match.index ?? 0
    if (!isSearchInvocationStart(command.slice(0, start))) continue
    starts.push(start)
  }
  return starts
}

const statementStart = (command: string, index: number) => {
  const before = command.slice(0, index)
  const semi = before.lastIndexOf(";")
  const and = before.lastIndexOf("&&")
  const or = before.lastIndexOf("||")
  const max = Math.max(semi, and, or)
  if (max === -1) return 0
  if (max === and) return and + 2
  if (max === or) return or + 2
  return max + 1
}

const statementEnd = (command: string, start: number) => {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let i = start; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ";" || command.startsWith("&&", i) || command.startsWith("||", i)) return i
  }
  return command.length
}

const invocationSegment = (command: string, start: number) => {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let i = start; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ";" || command.startsWith("&&", i) || command.startsWith("||", i)) {
      return command.slice(start, i)
    }
    if (char === "|" && command[i + 1] !== "|") return command.slice(start, i)
  }
  return command.slice(start)
}

const takeQuoted = (rest: string) => {
  const quote = rest[0]
  if (quote !== '"' && quote !== "'") return
  let escaped = false
  for (let i = 1; i < rest.length; i++) {
    const char = rest[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === quote) return { value: rest.slice(1, i), next: rest.slice(i + 1).trim() }
  }
  return { value: rest.slice(1), next: "" }
}

const isStdinPipeFilter = (command: string, start: number) => {
  const prefix = command.slice(statementStart(command, start), start)
  return /\s\|\s/.test(prefix) || prefix.trimEnd().endsWith("|")
}

const isBounded = (text: string) =>
  BOUNDED_LONG_FLAG_RE.test(text) || BOUNDED_SHORT_FLAG_RE.test(text) || OUTPUT_LIMIT_RE.test(text)

const searchPaths = (segment: string) => {
  let rest = segment.replace(/^(?:command\s+)?(?:rg|grep)\b/i, "").trim()
  const paths: string[] = []
  let pattern = false

  while (rest.length) {
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = takeQuoted(rest)
      if (!quoted) break
      if (pattern) paths.push(quoted.value)
      pattern = true
      rest = quoted.next
      continue
    }
    if (rest.startsWith("-")) {
      const match = rest.match(/^--?[A-Za-z][\w-]*(?:=\S+)?/)
      rest = match ? rest.slice(match[0].length).trim() : rest.slice(1).trim()
      continue
    }
    const match = rest.match(/^(\S+)/)
    if (!match) break
    if (pattern) paths.push(match[1])
    pattern = true
    rest = rest.slice(match[1].length).trim()
  }

  return paths
}

const hasExplicitPathOperand = (segment: string) =>
  searchPaths(segment).some((path) => path !== "." && path !== "..")

const pipelineBoundsSearch = (command: string, start: number) => {
  const pipeline = command.slice(start, statementEnd(command, start))
  return isBounded(pipeline)
}

const isUnboundedFilesystemSearch = (command: string, start: number) => {
  const segment = invocationSegment(command, start).trim()
  if (isStdinPipeFilter(command, start)) return false
  if (pipelineBoundsSearch(command, start)) return false
  if (hasExplicitPathOperand(segment)) return false
  return true
}

export const warning = (command: string) => {
  if (DIFF_PIPE_RE.test(command)) return

  let hasUnbounded = false
  for (const start of searchInvocationStarts(command)) {
    if (isUnboundedFilesystemSearch(command, start)) {
      hasUnbounded = true
      break
    }
  }
  if (!hasUnbounded) return

  return [
    "This looks like repo content search through Bash.",
    "Use the Grep tool next so output is match-bounded, permission-scoped, and respects repo ignore files.",
    "If Bash search is necessary, narrow it with an explicit path/glob/count-only option.",
  ].join(" ")
}

export const shapeOutput = (command: string, output: string) => {
  const searchWarning = warning(command)
  if (!searchWarning) return { output, warnings: [] as string[], truncated: false, omittedLines: 0 }
  if (output.startsWith("Bash search warning:")) {
    return { output, warnings: [searchWarning], truncated: false, omittedLines: 0 }
  }

  const lines = output.replace(/\n+$/, "").split(/\r?\n/)
  const shouldOmitSearchOutput = lines.length > SEARCH_OUTPUT_PREVIEW_LINES
  const omittedLines = shouldOmitSearchOutput ? lines.length : 0
  const preview = shouldOmitSearchOutput
    ? `[${omittedLines} Bash search output lines omitted. Use Grep with a narrower pattern/path before answering.]`
    : output
  return {
    output: [`Bash search warning: ${searchWarning}`, "", preview].join("\n"),
    warnings: [searchWarning],
    truncated: shouldOmitSearchOutput,
    omittedLines,
  }
}

export const BashSearch = {
  warning,
  shapeOutput,
} as const
