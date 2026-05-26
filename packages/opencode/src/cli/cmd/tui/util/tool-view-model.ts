import type { ToolFileContent, ToolTextContent } from "@opencode-ai/sdk/v2"
import { createTwoFilesPatch } from "diff"

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
  const name =
    stringValue(input.name) ??
    stringValue(input.part?.name) ??
    stringValue(input.tool) ??
    stringValue(input.part?.tool) ??
    ""
  return {
    name,
    input: toolInput,
    metadata: normalizeMetadata(name, toolInput, metadata),
    output: stringValue(input.output) ?? toolContentOutput(input.content),
    filePath: filePathValue(toolInput),
    content: stringValue(toolInput.content) ?? stringValue(toolInput.file_content),
    isList: isListTool(name),
  }
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
  if (name !== "edit") return metadata
  if (stringValue(metadata.diff)) return metadata

  const filediffPatch = isRecord(metadata.filediff) ? stringValue(metadata.filediff.patch) : undefined
  const diff = filediffPatch ?? syntheticEditDiff(input)
  if (!diff) return metadata
  return { ...metadata, diff }
}

function syntheticEditDiff(input: Record<string, unknown>) {
  const oldText = stringValue(input.oldString) ?? stringValue(input.old_string)
  const newText = stringValue(input.newString) ?? stringValue(input.new_string)
  const filePath = filePathValue(input)
  if (oldText === undefined || newText === undefined || !filePath) return undefined
  return createTwoFilesPatch(filePath, filePath, oldText, newText)
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
