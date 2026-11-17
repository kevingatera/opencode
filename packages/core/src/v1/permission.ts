export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID, Rule } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  // Full filtered ruleset, kept for UI and debugging. Not included in `message`.
  ruleset: Schema.Any,
  // The deny rule that matched the request. Only this appears in `message`.
  rule: Schema.optional(Rule),
  // Optional extra guidance shown to the model after the matched rule.
  hint: Schema.optional(Schema.String),
}) {
  override get message() {
    const base = "The user has specified a rule which prevents you from using this specific tool call."
    if (!this.rule) return base
    const matched = `Matching rule: permission "${this.rule.permission}", pattern "${this.rule.pattern}", action "${this.rule.action}".`
    return [base, matched, this.hint].filter(Boolean).join(" ")
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
