import path from "path"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import * as Tool from "./tool"
import DESCRIPTION from "./models.txt"

export const Parameters = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description: "Case-insensitive substring filter on provider/model ID (e.g. opus, copilot).",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({ description: "Maximum models to return. Defaults to 30, capped at 100." }),
  ),
})

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

function clampLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT)
}

// Best-effort recents from local state: missing files, malformed JSON, and
// unexpected shapes all degrade to an empty list, never an error.
function readRecentIDs(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.recent)) return []
  return value.recent.flatMap((item) => {
    if (!isRecord(item)) return []
    if (typeof item.providerID !== "string" || typeof item.modelID !== "string") return []
    return [`${item.providerID}/${item.modelID}`]
  })
}

export const ModelsTool = Tool.define(
  "models",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const available = yield* provider.list()
          const raw = yield* fs
            .readJson(path.join(global.state, "model.json"))
            .pipe(Effect.catch(() => Effect.succeed([] as unknown)))
          const catalogHas = (id: string) => {
            const parsed = Provider.parseModel(id)
            return Boolean(available[parsed.providerID]?.models[parsed.modelID])
          }
          const permittedProvider = (providerID: string) =>
            !cfg.disabled_providers?.includes(ProviderV2.ID.make(providerID)) &&
            (!cfg.enabled_providers || cfg.enabled_providers.includes(ProviderV2.ID.make(providerID)))

          const ids: string[] = []
          for (const [providerID, info] of Object.entries(available)) {
            if (!permittedProvider(providerID)) continue
            for (const modelID of Object.keys(info.models)) ids.push(`${providerID}/${modelID}`)
          }
          const recentFirst = new Set(readRecentIDs(raw).filter(catalogHas))
          const ordered = [
            ...recentFirst,
            ...ids.filter((id) => !recentFirst.has(id)).toSorted((left, right) => left.localeCompare(right)),
          ]
          const needle = params.query?.trim().toLowerCase()
          const matching = needle ? ordered.filter((id) => id.toLowerCase().includes(needle)) : ordered
          const limit = clampLimit(params.limit)
          const shown = matching.slice(0, limit)
          const lines = [
            `Available models (${shown.length} shown of ${matching.length} matching, ${ids.length} in catalog):`,
            ...shown,
          ]
          if (matching.length > shown.length)
            lines.push(`... and ${matching.length - shown.length} more omitted; narrow with query or raise limit.`)
          lines.push(
            "Catalog availability does not prove access or entitlement; Task model overrides still enforce routing policy and fail closed.",
          )
          return {
            title: "Available models",
            output: lines.join("\n"),
            metadata: { count: shown.length, total: matching.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
