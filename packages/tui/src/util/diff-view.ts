export type DiffView = "split" | "unified"

export function resolveDiffView(input: {
  diffStyle?: "auto" | "stacked"
  width: number
  minSplitWidth?: number
}): DiffView {
  if (input.diffStyle === "stacked") return "unified"
  if (input.width <= (input.minSplitWidth ?? 120)) return "unified"
  return "split"
}
