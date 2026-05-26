import { diffWordsWithSpace, parsePatch } from "diff"

const MAX_INLINE_DIFF_CHARS = 20_000
const MAX_INLINE_DIFF_EDIT_LENGTH = 2_000

export type SplitDiffLineType = "context" | "remove" | "add" | "empty"

export type SplitDiffSegment = {
  text: string
  changed: boolean
}

export type SplitDiffSide = {
  lineNumber?: number
  type: SplitDiffLineType
  segments: SplitDiffSegment[]
}

export type SplitDiffRow = {
  left: SplitDiffSide
  right: SplitDiffSide
}

type DiffLine = {
  content: string
  lineNumber: number
}

export function buildInlineSplitDiffRows(diff: string | undefined): SplitDiffRow[] {
  if (!diff) return []

  let patches: ReturnType<typeof parsePatch>
  try {
    patches = parsePatch(diff)
  } catch {
    return []
  }

  const rows: SplitDiffRow[] = []
  for (const patch of patches) {
    for (const hunk of patch.hunks) {
      let oldLineNumber = hunk.oldStart
      let newLineNumber = hunk.newStart
      let index = 0

      while (index < hunk.lines.length) {
        const line = hunk.lines[index] ?? ""
        const marker = line[0]

        if (marker === " ") {
          const content = line.slice(1)
          rows.push({
            left: lineSide("context", oldLineNumber, plainSegments(content)),
            right: lineSide("context", newLineNumber, plainSegments(content)),
          })
          oldLineNumber++
          newLineNumber++
          index++
          continue
        }

        if (marker === "\\") {
          index++
          continue
        }

        const removes: DiffLine[] = []
        const adds: DiffLine[] = []
        while (index < hunk.lines.length) {
          const changedLine = hunk.lines[index] ?? ""
          const changedMarker = changedLine[0]
          if (changedMarker === " " || changedMarker === "\\") break

          const content = changedLine.slice(1)
          if (changedMarker === "-") {
            removes.push({ content, lineNumber: oldLineNumber })
            oldLineNumber++
          } else if (changedMarker === "+") {
            adds.push({ content, lineNumber: newLineNumber })
            newLineNumber++
          }
          index++
        }

        const maxLines = Math.max(removes.length, adds.length)
        for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
          const removed = removes[lineIndex]
          const added = adds[lineIndex]
          if (removed && added && removed.content === added.content) {
            rows.push({
              left: lineSide("context", removed.lineNumber, plainSegments(removed.content)),
              right: lineSide("context", added.lineNumber, plainSegments(added.content)),
            })
            continue
          }
          const pair = removed && added ? inlineChangedSegments(removed.content, added.content) : undefined

          rows.push({
            left: removed
              ? lineSide("remove", removed.lineNumber, pair?.left ?? plainSegments(removed.content))
              : emptySide(),
            right: added ? lineSide("add", added.lineNumber, pair?.right ?? plainSegments(added.content)) : emptySide(),
          })
        }
      }
    }
  }

  return rows
}

const MAX_WORD_HIGHLIGHT_FRACTION = 0.85

export function wordHighlightRanges(segments: SplitDiffSegment[]) {
  const hasMixed = segments.some((segment) => segment.changed) && segments.some((segment) => !segment.changed)
  if (!hasMixed) return []

  const text = segments.map((segment) => segment.text).join("")
  const changedChars = segments
    .filter((segment) => segment.changed)
    .reduce((total, segment) => total + segment.text.length, 0)
  if (text.length > 0 && changedChars / text.length > MAX_WORD_HIGHLIGHT_FRACTION) return []

  const ranges: [number, number][] = []
  let offset = 0
  for (const segment of segments) {
    if (segment.changed) ranges.push([offset, offset + segment.text.length])
    offset += segment.text.length
  }
  return mergeAdjacentHighlightRanges(text, ranges)
}

function mergeAdjacentHighlightRanges(text: string, ranges: [number, number][]) {
  if (ranges.length <= 1) return ranges

  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: [number, number][] = [sorted[0]!]
  for (let index = 1; index < sorted.length; index++) {
    const [start, end] = sorted[index]!
    const last = merged[merged.length - 1]!
    const gap = text.slice(last[1], start)
    if (/^\s*$/.test(gap)) merged[merged.length - 1] = [last[0], end]
    else merged.push([start, end])
  }
  return merged
}

export function splitDiffLineNumberWidth(rows: SplitDiffRow[]) {
  let maxLineNumber = 0
  for (const row of rows) {
    maxLineNumber = Math.max(maxLineNumber, row.left.lineNumber ?? 0, row.right.lineNumber ?? 0)
  }
  return Math.max(2, String(maxLineNumber).length)
}

function inlineChangedSegments(oldText: string, newText: string) {
  if (oldText.length + newText.length > MAX_INLINE_DIFF_CHARS) {
    return { left: changedSegments(oldText), right: changedSegments(newText) }
  }

  const changes = diffWordsWithSpace(oldText, newText, { maxEditLength: MAX_INLINE_DIFF_EDIT_LENGTH })
  if (!changes) return { left: changedSegments(oldText), right: changedSegments(newText) }

  const left: SplitDiffSegment[] = []
  const right: SplitDiffSegment[] = []
  for (const change of changes) {
    if (change.removed) {
      left.push({ text: change.value, changed: true })
    } else if (change.added) {
      right.push({ text: change.value, changed: true })
    } else {
      left.push({ text: change.value, changed: false })
      right.push({ text: change.value, changed: false })
    }
  }

  const leftHasChange = left.some((segment) => segment.changed)
  const rightHasChange = right.some((segment) => segment.changed)
  if (!leftHasChange && !rightHasChange) {
    left.forEach((segment) => (segment.changed = true))
    right.forEach((segment) => (segment.changed = true))
  }

  return {
    left: mergeChangedAcrossWhitespace(normalizeChangedWhitespace(left)),
    right: mergeChangedAcrossWhitespace(normalizeChangedWhitespace(right)),
  }
}

function plainSegments(text: string): SplitDiffSegment[] {
  return [{ text, changed: false }]
}

function changedSegments(text: string): SplitDiffSegment[] {
  return [{ text, changed: true }]
}

function mergeChangedAcrossWhitespace(segments: SplitDiffSegment[]) {
  const merged: SplitDiffSegment[] = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const previous = merged[merged.length - 1]
    const next = segments[index + 1]
    if (!segment.changed && /^\s*$/.test(segment.text) && previous?.changed && next?.changed) {
      previous.text += segment.text
      continue
    }
    if (previous?.changed === segment.changed) previous.text += segment.text
    else merged.push({ text: segment.text, changed: segment.changed })
  }
  return merged
}

function normalizeChangedWhitespace(segments: SplitDiffSegment[]) {
  return segments.flatMap((segment) => {
    if (!segment.changed) return [segment]
    const match = /^(\s*)(.*?)(\s*)$/s.exec(segment.text)
    if (!match?.[2]) return [segment]

    const [, leading, core, trailing] = match
    return [
      leading ? { text: leading, changed: false } : undefined,
      { text: core, changed: true },
      trailing ? { text: trailing, changed: false } : undefined,
    ].filter((item): item is SplitDiffSegment => item !== undefined)
  })
}

function lineSide(type: SplitDiffLineType, lineNumber: number, segments: SplitDiffSegment[]): SplitDiffSide {
  return { type, lineNumber, segments }
}

function emptySide(): SplitDiffSide {
  return { type: "empty", segments: [{ text: " ", changed: false }] }
}
