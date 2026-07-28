import type { ToolFileContent, ToolTextContent } from "@opencode-ai/sdk/v2"
import { createTwoFilesPatch } from "diff"
import { readFileSync } from "fs"
import path from "path"

export type ToolViewModel = {
  name: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  filePath?: string
  content?: string
  isList: boolean
}

// Session history can contain SDK-shaped, v2-shaped, and provider-native tool parts.
// Normalize those variants once so both TUI renderers make the same display decisions.
export function toolViewModel(input: {
  part?: { name?: unknown; tool?: unknown }
  name?: unknown
  tool?: unknown
  input?: unknown
  metadata?: unknown
  output?: unknown
  content?: Array<ToolTextContent | ToolFileContent>
}): ToolViewModel {
  const toolInput = inputRecord(input.input)
  const metadata = recordValue(input.metadata)
  const rawName =
    stringValue(input.name) ??
    stringValue(input.part?.name) ??
    stringValue(input.tool) ??
    stringValue(input.part?.tool) ??
    ""
  const viewInput = normalizeToolInput(rawName, toolInput)
  const shellView =
    rawName === "bash" || rawName === "shell"
      ? classifyShellCommand(stringValue(viewInput.command)?.trim() ?? "")
      : undefined
  const name = shellView?.name ?? rawName
  const normalizedInput: Record<string, unknown> = shellView?.input ?? viewInput
  return {
    name,
    input: normalizedInput,
    metadata: normalizeMetadata(name, normalizedInput, metadata),
    output: stringValue(input.output) ?? toolContentOutput(input.content),
    filePath: filePathValue(normalizedInput),
    content: stringValue(normalizedInput.content) ?? stringValue(normalizedInput.file_content),
    isList: isListTool(name),
  }
}

function normalizeToolInput(name: string, input: Record<string, unknown>) {
  if (name !== "task" || input.subagent_type !== "general-purpose") return input
  return { ...input, subagent_type: "general" }
}

function classifyShellCommand(command: string) {
  if (!command) return undefined

  const prepared = stripShellCommandPrefix(command)
  const tokens = shellTokens(trimReadOnlyPipeline(prepared.command))
  if (tokens.length === 0) return undefined
  if (hasShellOperator(tokens) || hasUnsupportedShellRedirect(tokens)) return undefined

  const read = readShellCommand(tokens, prepared.cwd)
  if (read) return { name: "read", input: read }

  const grep = grepShellCommand(tokens, prepared.cwd)
  if (grep) return { name: "grep", input: grep }

  const glob = globShellCommand(tokens, prepared.cwd)
  if (glob) return { name: "glob", input: glob }

  const list = listShellCommand(tokens, prepared.cwd)
  if (list) return { name: "list", input: list }

  return undefined
}

function stripShellCommandPrefix(command: string) {
  const current = command.replace(/^\$\s+/, "").trim()
  const match = current.match(/^cd\s+((?:"[^"]+"|'[^']+'|\S)+)\s*&&\s*(.*)$/s)
  if (!match) return { command: current, cwd: undefined }
  return { command: match[2].trim(), cwd: unquote(match[1]) }
}

function trimReadOnlyPipeline(command: string) {
  return command
    .replace(/\s+2>&1\s*$/g, "")
    .replace(/\s*\|\s*(head|tail)(\s+-\d+|\s+-n\s+\d+)?\s*$/g, "")
    .replace(/\s*\|\s*sed\s+-n\s+(['\"])?\d+(,\d+)?p\1\s*$/g, "")
}

function readShellCommand(tokens: string[], cwd?: string) {
  const command = path.basename(tokens[0] ?? "")
  const args = shellCommandArgs(tokens)

  if (command === "sed") {
    const rangeIndex = args.findIndex((token) => /^\d+(,\d+)?p$/.test(token))
    if (rangeIndex < 0) return undefined
    const filePath = args.slice(rangeIndex + 1).find((token) => !token.startsWith("-"))
    if (!filePath) return undefined
    const [start, end] = args[rangeIndex]
      .slice(0, -1)
      .split(",")
      .map((item) => Number(item))
    return {
      filePath: resolveShellPath(filePath, cwd),
      offset: start,
      ...(end && end >= start ? { limit: end - start + 1 } : {}),
    }
  }

  if (command === "cat" || command === "head" || command === "tail" || command === "nl") {
    const filePath = lastFileToken(tokens)
    if (!filePath) return undefined
    return { filePath: resolveShellPath(filePath, cwd) }
  }

  return undefined
}

function grepShellCommand(tokens: string[], cwd?: string) {
  const command = path.basename(tokens[0] ?? "")
  if (command !== "rg" && command !== "grep") return undefined
  if (command === "rg" && tokens.includes("--files")) return undefined

  const args = shellCommandArgs(tokens).filter((token) => !token.startsWith("-"))
  const pattern = args[0]
  if (!pattern) return undefined
  const searchPath = args[1]
  return {
    pattern,
    ...(searchPath ? { path: resolveShellPath(searchPath, cwd) } : {}),
  }
}

function globShellCommand(tokens: string[], cwd?: string) {
  const command = path.basename(tokens[0] ?? "")
  const args = shellCommandArgs(tokens)

  if (command === "find") {
    const patternIndexes = tokens.flatMap((token, index) => (token === "-name" || token === "-path" ? [index] : []))
    if (patternIndexes.length !== 1) return undefined
    const pattern = tokens[patternIndexes[0] + 1]
    if (!pattern || pattern.startsWith("-")) return undefined
    const searchPath = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined
    return {
      pattern,
      ...(searchPath ? { path: resolveShellPath(searchPath, cwd) } : {}),
    }
  }

  if (command === "fd") {
    const globFlag = args.findIndex((token) => token === "-g" || token === "--glob")
    if (globFlag < 0) return undefined
    const pattern = args[globFlag + 1]
    if (!pattern || pattern.startsWith("-")) return undefined
    const searchPath = args.slice(globFlag + 2).find((token) => !token.startsWith("-"))
    return {
      pattern,
      ...(searchPath ? { path: resolveShellPath(searchPath, cwd) } : {}),
    }
  }

  if (command === "rg" && tokens.includes("--files")) {
    const globFlag = args.findIndex((token) => token === "-g" || token === "--glob")
    if (globFlag < 0) return undefined
    const pattern = args[globFlag + 1]
    if (!pattern || pattern.startsWith("-")) return undefined
    const searchPath = args.filter((token) => !token.startsWith("-") && token !== pattern).at(-1)
    return {
      pattern,
      ...(searchPath ? { path: resolveShellPath(searchPath, cwd) } : {}),
    }
  }

  return undefined
}

function listShellCommand(tokens: string[], cwd?: string) {
  const command = path.basename(tokens[0] ?? "")
  if (command !== "ls") return undefined

  const target = shellCommandArgs(tokens).findLast((token) => !token.startsWith("-")) ?? cwd ?? "."
  return { path: resolveShellPath(target, cwd) }
}

function lastFileToken(tokens: string[]) {
  return shellCommandArgs(tokens).findLast((token) => !token.startsWith("-"))
}

function shellCommandArgs(tokens: string[]) {
  const args = tokens.slice(1)
  return args.filter(
    (token, index) =>
      !isIgnoredShellRedirect(token, args[index + 1]) && !isIgnoredShellRedirectTarget(args[index - 1], token),
  )
}

function hasShellOperator(tokens: string[]) {
  return tokens.slice(1).some((token) => token === "|" || token === "&&" || token === "||" || token === ";")
}

function hasUnsupportedShellRedirect(tokens: string[]) {
  const args = tokens.slice(1)
  return args.some((token, index) => isShellRedirect(token) && !isIgnoredShellRedirect(token, args[index + 1]))
}

function isShellRedirect(token: string) {
  return /^(?:\d+)?(?:<{1,3}|>{1,2})\S*$/.test(token) || /^&>{1,2}\S*$/.test(token)
}

function isIgnoredShellRedirect(token: string, next?: string) {
  return /^2>{1,2}(?:\/dev\/null|&1)$/.test(token) || (/^2>{1,2}$/.test(token) && next === "/dev/null")
}

function isIgnoredShellRedirectTarget(previous: string | undefined, token: string) {
  return /^2>{1,2}$/.test(previous ?? "") && token === "/dev/null"
}

function resolveShellPath(filePath: string, cwd?: string) {
  if (!cwd || path.isAbsolute(filePath) || filePath === ".") return filePath
  return path.join(cwd, filePath)
}

function shellTokens(command: string) {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)).map((match) => match[1] ?? match[2] ?? match[3])
}

function unquote(input: string) {
  return input.replace(/^['"]|['"]$/g, "")
}

function inputRecord(input: unknown) {
  if (isRecord(input)) return input
  return {}
}

function recordValue(input: unknown) {
  if (isRecord(input)) return input
  return {}
}

function normalizeMetadata(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  if (stringValue(metadata.diff)) return metadata

  const filediffPatch = isRecord(metadata.filediff) ? stringValue(metadata.filediff.patch) : undefined
  if (filediffPatch) return { ...metadata, diff: filediffPatch }

  if (name === "edit") {
    const diff = syntheticEditDiff(input)
    if (!diff) return metadata
    return { ...metadata, diff }
  }

  if (name === "write") {
    const diff = syntheticWriteDiff(input, metadata)
    if (!diff) return metadata
    return { ...metadata, diff }
  }

  return metadata
}

function syntheticWriteDiff(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const content = stringValue(input.content) ?? stringValue(input.file_content)
  const filePath = filePathValue(input)
  // Existing-file writes need the previous content for a truthful diff. Older
  // history usually did not persist that, so only synthesize safe new-file diffs.
  if (content === undefined || !filePath || metadata.exists !== false) return undefined
  return createTwoFilesPatch(filePath, filePath, "", content)
}

function syntheticEditDiff(input: Record<string, unknown>) {
  const oldText = stringValue(input.oldString) ?? stringValue(input.old_string)
  const newText = stringValue(input.newString) ?? stringValue(input.new_string)
  const filePath = filePathValue(input)
  if (oldText === undefined || newText === undefined || !filePath) return undefined
  const diff = createTwoFilesPatch(filePath, filePath, oldText, newText)
  const startLine = locateSyntheticEditStart(filePath, oldText, newText)
  return startLine === undefined ? diff : offsetUnifiedDiffHunks(diff, startLine - 1)
}

function toolContentOutput(content?: Array<ToolTextContent | ToolFileContent>) {
  if (!content) return undefined
  const output = content
    .map((item) => {
      if (item.type === "text") return item.text.trim()
      return `[file ${item.name ?? item.uri}]`
    })
    .filter(Boolean)
    .join("\n")
  return output || undefined
}

function filePathValue(input: Record<string, unknown>) {
  return stringValue(input.filePath) ?? stringValue(input.path) ?? stringValue(input.file_path)
}

function isListTool(name: string) {
  return name === "ls" || name === "list" || name === "list_directory"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function locateSyntheticEditStart(filePath: string, oldText: string, newText: string) {
  if (!path.isAbsolute(filePath)) return undefined
  try {
    const current = normalizeLineEndings(readFileSync(filePath, "utf8"))
    const currentText = normalizeLineEndings(newText) || normalizeLineEndings(oldText)
    const index = currentText ? current.indexOf(currentText) : -1
    if (index < 0) return undefined
    return current.slice(0, index).split("\n").length
  } catch {
    return undefined
  }
}

function offsetUnifiedDiffHunks(diff: string, offset: number) {
  if (offset <= 0) return diff
  return diff.replace(
    /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm,
    (_, oldStart, oldCount = "", newStart, newCount = "") => {
      return `@@ -${Number(oldStart) + offset}${oldCount} +${Number(newStart) + offset}${newCount} @@`
    },
  )
}

function normalizeLineEndings(input: string) {
  return input.replace(/\r\n|\r/g, "\n")
}
