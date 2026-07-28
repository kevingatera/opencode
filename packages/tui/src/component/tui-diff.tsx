import { For, Show, createEffect, createMemo } from "solid-js"
import {
  type DiffRenderable,
  type OnHighlightCallback,
  type RGBA,
  type SimpleHighlight,
  type SyntaxStyle,
} from "@opentui/core"
import {
  buildInlineSplitDiffRows,
  splitDiffLineNumberWidth,
  wordHighlightRanges,
  type SplitDiffRow,
  type SplitDiffSegment,
  type SplitDiffSide,
} from "../util/inline-split-diff"
import type { DiffView } from "../util/diff-view"

type Color = string | RGBA

export type TuiDiffProps = {
  id?: string
  ref?: (element: DiffRenderable) => void
  diff?: string
  view: DiffView
  splitWidth?: number
  fg?: Color
  filetype?: string
  syntaxStyle?: SyntaxStyle
  wrapMode?: "word" | "char" | "none"
  showLineNumbers?: boolean
  width?: number | "auto" | `${number}%`
  addedBg?: Color
  removedBg?: Color
  contextBg?: Color
  addedContentBg?: Color
  removedContentBg?: Color
  contextContentBg?: Color
  highlightAddedBg?: Color
  highlightRemovedBg?: Color
  addedSignColor?: Color
  removedSignColor?: Color
  lineNumberFg?: Color
  lineNumberBg?: Color
  addedLineNumberBg?: Color
  removedLineNumberBg?: Color
}

export function TuiDiff(props: TuiDiffProps) {
  const rows = createMemo(() => buildInlineSplitDiffRows(props.diff))

  return (
    <Show when={props.view === "split" && rows().length > 0} fallback={<NativeDiff {...props} />}>
      <InlineSplitDiff {...props} rows={rows()} />
    </Show>
  )
}

function NativeDiff(props: TuiDiffProps) {
  return (
    <diff
      id={props.id}
      ref={props.ref}
      diff={props.diff}
      view={props.view}
      filetype={props.filetype}
      syntaxStyle={props.syntaxStyle}
      showLineNumbers={props.showLineNumbers}
      width={props.width}
      wrapMode={props.wrapMode}
      fg={props.fg}
      addedBg={props.addedBg}
      removedBg={props.removedBg}
      contextBg={props.contextBg}
      addedContentBg={props.addedContentBg}
      removedContentBg={props.removedContentBg}
      contextContentBg={props.contextContentBg}
      highlightAddedBg={props.highlightAddedBg}
      highlightRemovedBg={props.highlightRemovedBg}
      addedSignColor={props.addedSignColor}
      removedSignColor={props.removedSignColor}
      lineNumberFg={props.lineNumberFg}
      lineNumberBg={props.lineNumberBg}
      addedLineNumberBg={props.addedLineNumberBg}
      removedLineNumberBg={props.removedLineNumberBg}
    />
  )
}

function InlineSplitDiff(props: TuiDiffProps & { rows: SplitDiffRow[] }) {
  const lineNumberWidth = createMemo(() => splitDiffLineNumberWidth(props.rows))
  const wrapMode = createMemo(() => props.wrapMode ?? "none")
  const contentWidth = createMemo(() => splitContentWidth(props.splitWidth, lineNumberWidth()))
  const visualRows = createMemo(() => splitVisualRows(props.rows, contentWidth(), wrapMode()))

  createEffect(() => {
    const syntaxStyle = props.syntaxStyle
    if (!syntaxStyle) return
    try {
      if (props.highlightRemovedBg && syntaxStyle.resolveStyleId("diff-removed-highlight") === null) {
        syntaxStyle.registerStyle("diff-removed-highlight", { bg: props.highlightRemovedBg })
      }
      if (props.highlightAddedBg && syntaxStyle.resolveStyleId("diff-added-highlight") === null) {
        syntaxStyle.registerStyle("diff-added-highlight", { bg: props.highlightAddedBg })
      }
    } catch {}
  })

  return (
    <box flexDirection="column" width={props.width}>
      <For each={visualRows()}>
        {(row) => (
          <box flexDirection="row" width="100%" alignItems="flex-start">
            <SplitSide
              {...props}
              side={row.left}
              lineNumberWidth={lineNumberWidth()}
              contentWidth={contentWidth()}
              wrapMode={wrapMode()}
            />
            <SplitSide
              {...props}
              side={row.right}
              lineNumberWidth={lineNumberWidth()}
              contentWidth={contentWidth()}
              wrapMode={wrapMode()}
            />
          </box>
        )}
      </For>
    </box>
  )
}

function SplitSide(
  props: TuiDiffProps & {
    side: SplitDiffSide
    lineNumberWidth: number
    contentWidth: number | undefined
    wrapMode: "word" | "char" | "none"
  },
) {
  const sign = createMemo(() => {
    if (props.side.lineNumber === undefined) return " "
    if (props.side.type === "remove") return "-"
    if (props.side.type === "add") return "+"
    return " "
  })
  const signColor = createMemo(() => {
    if (props.side.type === "remove") return props.removedSignColor
    if (props.side.type === "add") return props.addedSignColor
    return props.lineNumberFg
  })
  const lineNumberBg = createMemo(() => {
    if (props.side.type === "remove") return props.removedLineNumberBg ?? props.removedBg
    if (props.side.type === "add") return props.addedLineNumberBg ?? props.addedBg
    if (props.side.type === "context") return props.lineNumberBg ?? props.contextBg
    return undefined
  })
  const rowContentBg = createMemo(() => {
    if (props.side.type === "remove") return props.removedContentBg ?? props.removedBg
    if (props.side.type === "add") return props.addedContentBg ?? props.addedBg
    if (props.side.type === "context") return props.contextContentBg ?? props.contextBg
    return undefined
  })

  return (
    <box flexDirection="row" width="50%" alignItems="flex-start">
      <Show when={props.showLineNumbers !== false}>
        <text width={props.lineNumberWidth} flexShrink={0} wrapMode="none" fg={props.lineNumberFg} bg={lineNumberBg()}>
          {formatLineNumber(props.side.lineNumber, props.lineNumberWidth)}
        </text>
      </Show>
      <text width={2} flexShrink={0} wrapMode="none" fg={signColor()} bg={lineNumberBg()}>
        {" " + sign()}
      </text>
      <box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        backgroundColor={rowContentBg()}
        shouldFill={rowContentBg() !== undefined}
      >
        <SplitSideContent {...props} contentWidth={props.contentWidth} />
      </box>
    </box>
  )
}

function SplitSideContent(props: TuiDiffProps & { side: SplitDiffSide; contentWidth: number | undefined }) {
  const content = createMemo(() => props.side.segments.map((segment) => segment.text).join(""))
  const hasContent = createMemo(() => content().trim().length > 0)
  const onHighlight = createMemo((): OnHighlightCallback | undefined => {
    const ranges = wordHighlightRanges(props.side.segments)
    if (ranges.length === 0) return undefined
    if (props.side.type !== "remove" && props.side.type !== "add") return undefined
    const styleId = props.side.type === "remove" ? "diff-removed-highlight" : "diff-added-highlight"
    return (highlights) => [
      ...highlights,
      ...ranges.map(([start, end]): SimpleHighlight => [start, end, styleId, undefined]),
    ]
  })

  return (
    <Show
      when={hasContent()}
      fallback={
        <text wrapMode="none" fg={props.fg}>
          {" "}
        </text>
      }
    >
      <Show
        when={props.filetype && props.syntaxStyle}
        fallback={
          <text wrapMode="none" width={props.contentWidth} fg={props.fg}>
            <For each={props.side.segments}>
              {(segment) => <PlainSegment {...props} segment={segment} side={props.side} />}
            </For>
          </text>
        }
      >
        <code
          content={content()}
          filetype={props.filetype}
          syntaxStyle={props.syntaxStyle!}
          fg={props.fg}
          width={props.contentWidth}
          wrapMode="none"
          conceal={false}
          drawUnstyledText={false}
          onHighlight={onHighlight()}
        />
      </Show>
    </Show>
  )
}

function PlainSegment(props: TuiDiffProps & { segment: SplitDiffSegment; side: SplitDiffSide }) {
  const wordHighlight = createMemo(() => segmentWordHighlight(props.side.segments, props.segment))
  const highlightStyle = createMemo(() => {
    if (!wordHighlight()) return { fg: props.fg }
    if (props.side.type === "remove") {
      return {
        fg: props.fg,
        bg: props.highlightRemovedBg ?? props.removedLineNumberBg ?? props.removedBg,
      }
    }
    if (props.side.type === "add") {
      return {
        fg: props.fg,
        bg: props.highlightAddedBg ?? props.addedLineNumberBg ?? props.addedBg,
      }
    }
    return { fg: props.fg }
  })

  return <span style={highlightStyle()}>{props.segment.text}</span>
}

function segmentWordHighlight(segments: SplitDiffSegment[], segment: SplitDiffSegment) {
  if (!segment.changed) return false
  const ranges = wordHighlightRanges(segments)
  if (ranges.length === 0) return false

  let offset = 0
  for (const current of segments) {
    if (current === segment) {
      const start = offset
      const end = offset + segment.text.length
      return ranges.some(([rangeStart, rangeEnd]) => rangeStart < end && rangeEnd > start)
    }
    offset += current.text.length
  }
  return false
}

function formatLineNumber(lineNumber: number | undefined, width: number) {
  if (lineNumber === undefined) return " ".repeat(width)
  return String(lineNumber).padStart(width)
}

function splitContentWidth(totalWidth: number | undefined, lineNumberWidth: number) {
  if (!totalWidth) return undefined
  return Math.max(12, Math.floor(totalWidth / 2) - lineNumberWidth - 2)
}

function splitVisualRows(rows: SplitDiffRow[], contentWidth: number | undefined, wrapMode: "word" | "char" | "none") {
  if (!contentWidth || wrapMode === "none") return rows

  const visualRows: SplitDiffRow[] = []
  for (const row of rows) {
    const left = wrapSide(row.left, contentWidth, wrapMode)
    const right = wrapSide(row.right, contentWidth, wrapMode)
    const count = Math.max(left.length, right.length, 1)

    for (let index = 0; index < count; index++) {
      visualRows.push({
        left: visualSide(row.left, left[index] ?? [], index),
        right: visualSide(row.right, right[index] ?? [], index),
      })
    }
  }

  return visualRows
}

function visualSide(side: SplitDiffSide, segments: SplitDiffSegment[], index: number): SplitDiffSide {
  return {
    type: side.type,
    lineNumber: index === 0 ? side.lineNumber : undefined,
    segments: segments.length > 0 ? segments : [{ text: " ", changed: false }],
  }
}

function wrapSide(side: SplitDiffSide, width: number, wrapMode: "word" | "char") {
  if (side.segments.length === 0) return [[]]
  return wrapSegments(side.segments, width, wrapMode)
}

function wrapSegments(segments: SplitDiffSegment[], width: number, wrapMode: "word" | "char") {
  const lines: SplitDiffSegment[][] = [[]]
  let lineWidth = 0

  const nextLine = () => {
    lines.push([])
    lineWidth = 0
  }
  const append = (text: string, changed: boolean) => {
    if (!text) return
    const line = lines[lines.length - 1]
    const previous = line[line.length - 1]
    if (previous?.changed === changed) {
      previous.text += text
    } else {
      line.push({ text, changed })
    }
    lineWidth += visualWidth(text)
  }
  const appendCharWrapped = (text: string, changed: boolean) => {
    let pending = text
    while (pending) {
      const available = Math.max(1, width - lineWidth)
      const [head, tail] = takeWidth(pending, available)
      append(head, changed)
      pending = tail
      if (pending) nextLine()
    }
  }

  for (const segment of segments) {
    const tokens = wrapMode === "word" ? (segment.text.match(/\s+|\S+/g) ?? []) : Array.from(segment.text)
    for (const token of tokens) {
      const tokenWidth = visualWidth(token)
      if (lineWidth > 0 && lineWidth + tokenWidth > width) nextLine()
      if (tokenWidth > width) {
        appendCharWrapped(token, segment.changed)
      } else {
        append(token, segment.changed)
      }
    }
  }

  return lines
}

function takeWidth(input: string, width: number): [string, string] {
  let used = 0
  let index = 0
  for (const char of input) {
    const next = used + charWidth(char)
    if (index > 0 && next > width) break
    used = next
    index += char.length
  }
  return [input.slice(0, index), input.slice(index)]
}

function visualWidth(input: string) {
  let width = 0
  for (const char of input) {
    width += charWidth(char)
  }
  return width
}

function charWidth(char: string) {
  return char === "\t" ? 4 : 1
}
