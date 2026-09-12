export * as ConfigModelRouting from "./model-routing"

import { Schema } from "effect"

export const Scope = Schema.Literals(["same", "curated"])
export type Scope = typeof Scope.Type

export const Info = Schema.Struct({
  scope: Scope,
  roles: Schema.Record(Schema.String, Schema.Array(Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^\s]+$/)))),
}).annotate({
  description: "Opt-in legacy SessionPrompt role routing. Not enforced by the V2 session runner.",
})
export type Info = typeof Info.Type
