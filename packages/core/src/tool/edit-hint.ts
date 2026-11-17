export * as EditHint from "./edit-hint"

const MAX_LINES = 15
const MAX_CHARS = 1500

const words = (text: string) => new Set(text.split(/\s+/).filter((word) => word.length > 0))

/**
 * Returns the best fuzzy-matching region of `content` for a failed exact search,
 * formatted with line numbers so the model can correct `oldString` without a re-read.
 *
 * Cost is bounded: scoring uses at most MAX_LINES search lines, each file line's word
 * set is built once, and windows are scored only around lines that contain the search's
 * rarest word. Output is whole lines only and capped at MAX_CHARS including the header.
 */
export const nearestRegion = (content: string, search: string) => {
  const lines = content.replaceAll("\r\n", "\n").split("\n")
  const searchLines = search.split("\n").filter((line) => line.trim().length > 0)
  const size = Math.min(searchLines.length, MAX_LINES, lines.length)
  const target = words(searchLines.slice(0, size).join("\n"))
  if (size === 0 || target.size === 0) return undefined

  const lineWords = lines.map((line) => words(line))
  const anchor = rarestPresentWord(target, lineWords)
  const starts = anchor === undefined ? allStarts(lines.length, size) : anchoredStarts(lineWords, anchor, size)

  let best = -1
  let bestScore = 0
  for (const start of starts) {
    const candidate = new Set<string>()
    for (let offset = 0; offset < size; offset++) for (const word of lineWords[start + offset]) candidate.add(word)
    const shared = [...candidate].filter((word) => target.has(word)).length
    const score = shared / (candidate.size + target.size - shared)
    if (score > bestScore) {
      best = start
      bestScore = score
    }
  }
  if (best === -1) return undefined
  return formatRegion(lines, best, size)
}

// The search word that appears in the fewest file lines. It is the cheapest anchor
// because only windows that contain it can share distinctive text with the search.
function rarestPresentWord(target: Set<string>, lineWords: Array<Set<string>>) {
  const counts = new Map<string, number>()
  for (const set of lineWords) {
    for (const word of set) {
      if (target.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  let anchor: string | undefined
  let fewest = Infinity
  for (const [word, count] of counts) {
    if (count < fewest) {
      anchor = word
      fewest = count
    }
  }
  return anchor
}

function anchoredStarts(lineWords: Array<Set<string>>, anchor: string, size: number) {
  const starts = new Set<number>()
  lineWords.forEach((set, index) => {
    if (!set.has(anchor)) return
    for (let start = Math.max(0, index - size + 1); start <= index; start++) starts.add(start)
  })
  return [...starts].filter((start) => start + size <= lineWords.length)
}

function allStarts(total: number, size: number) {
  return Array.from({ length: Math.max(0, total - size + 1) }, (_, start) => start)
}

// Whole lines only: rows are added until the header plus rows would exceed MAX_CHARS.
// The header reports the range actually shown. If even the first matching line is too long
// for the budget, no part of it is shown; the model is pointed at the line to read instead.
const ROW_BUDGET = MAX_CHARS - 60

function formatRegion(lines: string[], start: number, size: number) {
  const rows: string[] = []
  let used = 0
  for (let index = start; index < start + size && index < lines.length; index++) {
    const row = `${index + 1}: ${lines[index]}`
    if (rows.length === 0 && row.length > ROW_BUDGET) {
      const line = index + 1
      return `Closest match is line ${line} (${lines[index].length} chars, too long to show). Read it with offset=${line} limit=1.`
    }
    if (used + row.length + 1 > ROW_BUDGET) break
    rows.push(row)
    used += row.length + 1
  }
  const header = `Closest match (lines ${start + 1}-${start + rows.length}):`
  return [header, ...rows].join("\n")
}
