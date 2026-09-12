export * as ConfigModelRouting from "./model-routing"

import { Schema } from "effect"

export const Scope = Schema.Literals(["same", "curated"])
export type Scope = typeof Scope.Type

export const Info = Schema.Struct({
  scope: Scope,
  // Opt-in: in same scope, a configured role with no candidate on the anchor
  // provider runs the anchor model instead of failing. Default keeps the
  // fail-closed contract for deliberate model choices.
  anchor_fallback: Schema.optional(Schema.Boolean),
  roles: Schema.Record(Schema.String, Schema.Array(Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^\s]+$/)))),
}).annotate({
  description: "Opt-in legacy SessionPrompt role routing. Not enforced by the V2 session runner.",
})
export type Info = typeof Info.Type
