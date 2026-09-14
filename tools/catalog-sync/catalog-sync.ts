import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"

// Syncs catalog providers with their live /models endpoints and builds a
// price/score Pareto report from the real-api-pricing dataset. Providers come
// from a tracked registry (providers.json) merged with a per-machine override
// (~/.config/opencode/catalog-sync.json). Report-only by default; --apply
// writes the opencode config (after a backup) and never removes entries.

const configPath = process.env.OPENCODE_CONFIG_PATH ?? path.join(os.homedir(), ".config/opencode/opencode.json")
const registryPath = process.env.OPENCODE_SYNC_REGISTRY ?? path.join(import.meta.dir, "providers.json")
const overridePath = process.env.OPENCODE_SYNC_OVERRIDE ?? path.join(os.homedir(), ".config/opencode/catalog-sync.json")
const authstorePath = path.join(os.homedir(), ".local/share/opencode/auth.json")
const apply = process.argv.includes("--apply")
const jsonOut = process.argv.includes("--json")
const providerFilter = process.argv
  .flatMap((arg, i) => (arg === "--provider" ? [process.argv[i + 1]] : []))
  .filter((name): name is string => Boolean(name))
// Runtime artifacts are per-machine state, not part of the tracked tool. The
// seed ships with the tool so the first run works offline or before any fetch.
const stateDir = path.join(os.homedir(), ".local/state/opencode/catalog-sync")
const pointsCache = path.join(stateDir, "points-cache.json")
const reportPath = path.join(stateDir, "CATALOG-PARETO.md")
const seedPath = path.join(import.meta.dir, "points-seed.json")
const now = new Date()

type ConfigModel = Record<string, unknown>
type ConfigProvider = { name?: string; npm?: string; env?: string[]; options?: Record<string, unknown>; models?: Record<string, ConfigModel> }
type Config = { provider?: Record<string, ConfigProvider> }
type EndpointModel = { id: string; name?: unknown; context_length?: unknown }
type AuthMode = "none" | "config" | "authstore" | `env:${string}`
type ManagedMode = "config" | "report" | "override"
type RegistryProvider = { id: string; baseURL: string | null; auth: AuthMode; managed: ManagedMode }
type ModelCost = { input: number; output: number }

type FetchResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; error: string }

type MissingModel = { id: string; name: string; toolCall: boolean }
type SyncResult = {
  provider: string
  managed: ManagedMode
  baseURL: string | null
  reachable: boolean
  status: number | null
  error: string | null
  note: string | null
  localCount: number
  remoteCount: number
  missing: MissingModel[]
  stale: string[]
  toolCallUnknown: boolean
}

type Point = {
  id: string
  plan: string
  billing: string
  model: string
  model_display: string
  label: string
  real_usd_per_mtok: number | null
  list_blended_usd_per_mtok: number | null
  confidence: string
}

type ModelRow = {
  key: string
  providers: string[]
  model: string
  kind: "exact" | "suffix" | "substring" | "unmatched"
  plan: string
  billing: string
  real: number | null
  list: number | null
  confidence: string
  scores: Record<string, number>
  priceSource: "real-api-pricing" | "models.dev list"
  costInput: number | null
  costOutput: number | null
}

type PointsFile = { generatedAt: string; boards: Record<string, { name: string; metric: string }>; points: Point[] }

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: text.slice(0, 160) }
    return { ok: true, status: response.status, data: JSON.parse(text) }
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function humanize(id: string) {
  const tail = id.slice(id.lastIndexOf("/") + 1).replace(/[-:](free|paid)$/i, "")
  return tail.split(/[-_:]+/).filter(Boolean)
    .map((word) => word.length <= 3 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
}

function advertisesTools(entry: Record<string, unknown>): boolean {
  if (entry.tool_call === true || entry.tools === true || entry.function_calling === true) return true
  if (entry.capabilities && typeof entry.capabilities === "object") {
    const capabilities = entry.capabilities as Record<string, unknown>
    if (capabilities.tools === true) return true
  }
  if (Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools")) return true
  return false
}

// Normalize a model id for matching: lowercase, strip vendor path prefixes
// (meta/, deepseek/, google/, ...) and free/paid tier suffixes.
function normalize(id: string) {
  let normalized = id.toLowerCase()
  const slash = normalized.indexOf("/")
  if (slash !== -1) normalized = normalized.slice(slash + 1)
  return normalized.replace(/[-:](free|paid)$/, "")
}

function matchKind(a: string, b: string): "exact" | "suffix" | "substring" | null {
  if (a === b) return "exact"
  if (a.endsWith(`-${b}`) || b.endsWith(`-${a}`)) return "suffix"
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return "substring"
  return null
}

function authHeaders(provider: ConfigProvider): Record<string, string> {
  const headers: Record<string, string> = {}
  const options = provider.options ?? {}
  const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : null
  const envKey = provider.env?.map((name) => process.env[name]).find((value) => value)
  const key = apiKey ?? envKey ?? null
  if (key) headers.Authorization = `Bearer ${key}`
  if (options.headers && typeof options.headers === "object") {
    for (const [name, value] of Object.entries(options.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[name] = value
    }
  }
  return headers
}

let authStoreData: Promise<Record<string, Record<string, unknown>> | null> | null = null
function authStore() {
  authStoreData ??= Bun.file(authstorePath).json()
    .then((data) => data as Record<string, Record<string, unknown>>)
    .catch(() => null)
  return authStoreData
}

async function authHeadersFor(entry: RegistryProvider): Promise<{ headers: Record<string, string>; note: string | null; skip: string | null }> {
  if (entry.auth === "none") return { headers: {}, note: null, skip: null }
  if (entry.auth === "config") {
    const provider = config.provider?.[entry.id]
    if (!provider) return { headers: {}, note: null, skip: null }
    return { headers: authHeaders(provider), note: null, skip: null }
  }
  if (entry.auth === "authstore") {
    const store = await authStore()
    const entryData = store?.[entry.id]
    if (!entryData) return { headers: {}, note: null, skip: "no authstore entry" }
    const key = typeof entryData.key === "string" && entryData.key.length > 0
      ? entryData.key
      : typeof entryData.access === "string" && entryData.access.length > 0 ? entryData.access : null
    if (!key) return { headers: {}, note: null, skip: "authstore entry has no key/access token" }
    return { headers: { Authorization: `Bearer ${key}` }, note: "authenticated via authstore", skip: null }
  }
  const envName = entry.auth.slice("env:".length)
  const value = process.env[envName]
  if (!value) return { headers: {}, note: null, skip: `env ${envName} not set` }
  return { headers: { Authorization: `Bearer ${value}` }, note: null, skip: null }
}

function parseModelList(data: unknown): EndpointModel[] | null {
  if (Array.isArray(data)) return data.filter(isEndpointModel)
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return ((data as { data: unknown[] }).data).filter(isEndpointModel)
  }
  return null
}

function isEndpointModel(value: unknown): value is EndpointModel {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
}

function baseURLOf(provider: ConfigProvider): string | null {
  const baseURL = provider.options?.baseURL
  return typeof baseURL === "string" && baseURL.length > 0 ? baseURL : null
}

function isAuthMode(value: unknown): value is AuthMode {
  if (value === "none" || value === "config" || value === "authstore") return true
  return typeof value === "string" && value.startsWith("env:") && value.length > "env:".length
}

function isManagedMode(value: unknown): value is ManagedMode {
  return value === "config" || value === "report" || value === "override"
}

function parseRegistry(data: unknown, source: string): { entries: RegistryProvider[]; warnings: string[] } {
  const warnings: string[] = []
  const providers = (data as { providers?: unknown } | null)?.providers
  if (!Array.isArray(providers)) return { entries: [], warnings: [`${source}: no "providers" array`] }
  const entries: RegistryProvider[] = []
  for (const raw of providers) {
    const entry = raw as Record<string, unknown> | null
    const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : null
    const baseURL = typeof entry?.baseURL === "string" && entry.baseURL.length > 0 ? entry.baseURL : null
    const auth = entry?.auth
    const managed = entry?.managed
    if (!id || !isAuthMode(auth) || !isManagedMode(managed)) {
      warnings.push(`${source}: skipped invalid provider entry${id ? ` (${id})` : ""}`)
      continue
    }
    entries.push({ id, baseURL, auth, managed })
  }
  return { entries, warnings }
}

async function loadRegistryFile(p: string): Promise<{ entries: RegistryProvider[]; warnings: string[] } | null> {
  let data: unknown
  try {
    data = await Bun.file(p).json()
  } catch {
    return null
  }
  return parseRegistry(data, p)
}

// models.dev is only used for the report/override diff base, the pricing
// fallback, and (offline) the auto-discovery fallback. Unreachable means
// report/override diffs degrade to config overrides only; unreachable
// endpoints report and skip anyway.
function modelsDevProvider(id: string): Record<string, unknown> | null {
  const entry = modelsDev[id]
  return entry && typeof entry === "object" ? entry as Record<string, unknown> : null
}

// models.dev cost fields are USD per MTok already (e.g. gpt-4o input: 5 =
// $5/MTok), so no per-token conversion is applied.
function modelsDevCost(providerId: string, modelId: string): ModelCost | null {
  const models = modelsDevProvider(providerId)?.models
  if (!models || typeof models !== "object") return null
  const model = (models as Record<string, unknown>)[modelId]
  const cost = model && typeof model === "object" ? (model as Record<string, unknown>).cost : null
  if (!cost || typeof cost !== "object") return null
  const input = (cost as Record<string, unknown>).input
  const output = (cost as Record<string, unknown>).output
  if (typeof input !== "number" || typeof output !== "number") return null
  return { input, output }
}

// Local catalog view for drift diffs and pricing: config-pinned models for
// `config` mode; the models.dev catalog merged with any config override block
// for `report`/`override` mode (opencode merges config over models.dev data).
function localCatalog(id: string, managed: ManagedMode): string[] {
  if (managed === "config") return Object.keys(config.provider?.[id]?.models ?? {})
  const devModels = modelsDevProvider(id)?.models
  const dev = devModels && typeof devModels === "object" ? Object.keys(devModels as Record<string, unknown>) : []
  return [...new Set([...dev, ...Object.keys(config.provider?.[id]?.models ?? {})])]
}

async function syncEntry(entry: RegistryProvider): Promise<SyncResult> {
  const local = localCatalog(entry.id, entry.managed)
  const base: SyncResult = {
    provider: entry.id,
    managed: entry.managed,
    baseURL: entry.baseURL,
    reachable: false,
    status: null,
    error: null,
    note: null,
    localCount: local.length,
    remoteCount: 0,
    missing: [],
    stale: [],
    toolCallUnknown: false,
  }
  if (!entry.baseURL) return { ...base, error: "no baseURL configured" }
  const auth = await authHeadersFor(entry)
  if (auth.skip) return { ...base, error: auth.skip, note: auth.note }
  const response = await fetchJson(`${entry.baseURL.replace(/\/$/, "")}/models`, auth.headers)
  if (!response.ok) return { ...base, status: response.status, error: response.error, note: auth.note }
  const models = parseModelList(response.data)
  if (!models) return { ...base, status: response.status, error: "unrecognized /models response shape", note: auth.note }
  const remoteIds = models.map((model) => model.id)
  const missing = remoteIds.filter((remote) => !local.includes(remote)).map((remote) => {
    const endpointEntry = models.find((model) => model.id === remote)
    const named = typeof endpointEntry?.name === "string" && endpointEntry.name.length > 0 ? endpointEntry.name : humanize(remote)
    const toolCall = endpointEntry ? advertisesTools(endpointEntry as unknown as Record<string, unknown>) : false
    return { id: remote, name: named, toolCall }
  })
  const toolCallUnknown = missing.length > 0 && !models.some((model) => advertisesTools(model as unknown as Record<string, unknown>))
  return {
    ...base,
    reachable: true,
    status: response.status,
    remoteCount: remoteIds.length,
    missing,
    stale: local.filter((name) => !remoteIds.includes(name)),
    toolCallUnknown,
    note: auth.note,
  }
}

async function loadPoints(): Promise<{ data: PointsFile | null; fetched: boolean; error: string | null }> {
  const response = await fetchJson("https://raw.githubusercontent.com/FeiZhuLulu/real-api-pricing/main/derived/points.json")
  if (response.ok && response.data && typeof response.data === "object") {
    const data = response.data as PointsFile
    await mkdir(stateDir, { recursive: true })
    await Bun.write(pointsCache, JSON.stringify({ fetchedAt: now.toISOString(), data }))
    return { data, fetched: true, error: null }
  }
  const reason = `fetch failed (${response.ok ? "bad shape" : response.error})`
  const sources: Array<[string, () => Promise<{ fetchedAt: string; data: PointsFile }>]> = [
    ["runtime cache", async () => await Bun.file(pointsCache).json()],
    ["bundled seed", async () => {
      const seed = await Bun.file(seedPath).json() as { generatedAt: string; points: unknown }
      return { fetchedAt: seed.generatedAt, data: seed as unknown as PointsFile }
    }],
  ]
  for (const [name, read] of sources) {
    try {
      const cached = await read()
      return { data: cached.data, fetched: false, error: `${reason}; using ${name} from ${cached.fetchedAt}` }
    } catch {
      // fall through to the next source
    }
  }
  return { data: null, fetched: false, error: `${reason} and no cache or seed exists` }
}

// Per-model pricing row: the cheapest matched point supplies price/plan, and
// per-board scores take the best value across all matched points for the model.
// Models with no real-api-pricing match fall back to models.dev list pricing;
// those rows carry priceSource "models.dev list" and are excluded from
// frontier computation.
function buildRows(reachable: string[], points: Point[], boards: string[], costs: Map<string, ModelCost>): { rows: ModelRow[]; unmatched: string[] } {
  const byKey = new Map<string, ModelRow>()
  const fallbackRows: ModelRow[] = []
  const unmatched: string[] = []
  const rank = { exact: 0, suffix: 1, substring: 2 } as const
  for (const reachableId of reachable) {
    const normalizedReachable = normalize(reachableId)
    const matched = points.flatMap((point) => {
      const kind = matchKind(normalizedReachable, normalize(point.model))
      if (!kind || point.real_usd_per_mtok === null) return []
      const scores: Record<string, number> = {}
      for (const board of boards) {
        const score = (point as unknown as Record<string, unknown>)[`${board}__score`]
        if (typeof score === "number") scores[board] = score
      }
      return [{ point, kind, scores }]
    })
    if (matched.length === 0) {
      unmatched.push(reachableId)
      const cost = costs.get(reachableId)
      if (cost) {
        fallbackRows.push({
          key: normalizedReachable,
          providers: [providerOf(reachableId)],
          model: reachableId,
          kind: "unmatched",
          plan: "—",
          billing: "—",
          real: null,
          list: null,
          confidence: "—",
          scores: {},
          priceSource: "models.dev list",
          costInput: cost.input,
          costOutput: cost.output,
        })
      }
      continue
    }
    const best = matched.toSorted((a, b) => rank[a.kind] - rank[b.kind] || a.point.real_usd_per_mtok! - b.point.real_usd_per_mtok!)[0]!
    const scores: Record<string, number> = {}
    for (const board of boards) {
      const values = matched.map((entry) => entry.scores[board]).filter((value): value is number => typeof value === "number")
      if (values.length > 0) scores[board] = Math.max(...values)
    }
    const key = normalizedReachable
    const row: ModelRow = {
      key,
      providers: [providerOf(reachableId)],
      model: reachableId,
      kind: best.kind,
      plan: best.point.plan,
      billing: best.point.billing,
      real: best.point.real_usd_per_mtok!,
      list: best.point.list_blended_usd_per_mtok,
      confidence: best.point.confidence,
      scores,
      priceSource: "real-api-pricing",
      costInput: null,
      costOutput: null,
    }
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, row)
      continue
    }
    existing.providers.push(row.providers[0]!)
    if (row.real < existing.real!) {
      byKey.set(key, { ...row, providers: existing.providers, scores: mergeScores(existing.scores, row.scores) })
    } else {
      existing.scores = mergeScores(existing.scores, row.scores)
    }
  }
  const rows = new Map([...byKey.values()].toSorted((a, b) => a.real! - b.real!).map((row) => [row.key, row]))
  for (const row of fallbackRows) {
    const existing = rows.get(row.key)
    if (!existing) {
      rows.set(row.key, row)
      continue
    }
    existing.providers.push(...row.providers)
    if (existing.priceSource === "models.dev list") {
      existing.costInput = Math.min(existing.costInput ?? Infinity, row.costInput ?? Infinity)
      existing.costOutput = Math.min(existing.costOutput ?? Infinity, row.costOutput ?? Infinity)
    }
  }
  return { rows: [...rows.values()], unmatched }
}

function providerOf(id: string) {
  const slash = id.indexOf("/")
  return slash === -1 ? id : id.slice(0, slash)
}

function mergeScores(a: Record<string, number>, b: Record<string, number>) {
  const merged = { ...a }
  for (const [board, score] of Object.entries(b)) merged[board] = Math.max(merged[board] ?? -Infinity, score)
  return merged
}

// Non-dominated set: minimize real_usd_per_mtok, maximize the board score.
// Ties on price keep only the highest score; ties on score keep the cheapest.
// models.dev-list-priced rows never participate (their price is not real).
function pareto(rows: ModelRow[], board: string): ModelRow[] {
  const candidates = rows.filter((row) => row.priceSource === "real-api-pricing" && typeof row.scores[board] === "number")
    .toSorted((a, b) => a.real! - b.real! || b.scores[board] - a.scores[board])
  const frontier: ModelRow[] = []
  let best = -Infinity
  for (const row of candidates) {
    if (row.scores[board] > best) {
      frontier.push(row)
      best = row.scores[board]
    }
  }
  return frontier
}

const money = (value: number | null) => value === null ? "—" : `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`

function priceSourceCell(row: ModelRow) {
  if (row.priceSource === "real-api-pricing") return "real-api-pricing"
  return `models.dev list — in ${money(row.costInput)} / out ${money(row.costOutput)}`
}

function markdown(
  syncResults: SyncResult[],
  pointsData: PointsFile,
  pointsError: string | null,
  rows: ModelRow[],
  unpriced: string[],
  boardsWithScores: string[],
  priceCounts: { realApi: number; fallback: number },
): string {
  const lines: string[] = [
    "# Catalog Sync & Pricing Pareto",
    "",
    `Last updated: ${now.toISOString()}`,
    "",
    `Source: real-api-pricing points.json (${pointsData.points.length} points, generated ${pointsData.generatedAt})${pointsError ? ` — ${pointsError}` : ""}`,
    "",
    `Pricing coverage: ${priceCounts.realApi} real-api-pricing + ${priceCounts.fallback} models.dev list fallback (fallback rows excluded from frontiers).`,
    "",
    "## Catalog sync",
    "",
    "Registry-driven. Managed modes: `config` = pinned in opencode.json (`--apply` adds missing models); `report` = models.dev-managed, drift is informational only; `override` = models.dev-managed, `--apply` writes missing models into the opencode config.",
    "",
    "| Provider | Managed | Reachable | Local | Remote | Missing | Stale (kept) |",
    "|---|---|---|---|---|---|---|",
  ]
  for (const result of syncResults) {
    lines.push(`| ${result.provider} | ${result.managed} | ${result.reachable ? `yes (${result.status})` : `no — ${result.error ?? "unknown error"}`} | ${result.localCount} | ${result.reachable ? result.remoteCount : "—"} | ${result.missing.length} | ${result.stale.length} |`)
  }
  for (const result of syncResults.filter((entry) => entry.missing.length > 0)) {
    lines.push("", `### ${result.provider} — remote-only models (local catalog doesn't have them)`, "")
    if (result.managed !== "config") lines.push("> models.dev-managed provider: drift between the live endpoint and the local catalog view.", "")
    if (result.toolCallUnknown) lines.push("> The endpoint does not advertise tool support per model; added entries will need `tool_call`/limits set manually.", "")
    for (const model of result.missing) {
      lines.push(`- \`${model.id}\` — ${model.name}${model.toolCall ? " (tools advertised)" : ""}`)
    }
  }
  for (const result of syncResults.filter((entry) => entry.stale.length > 0 && entry.managed !== "config")) {
    lines.push("", `### ${result.provider} — local-only models (remote doesn't list them)`, "", ...result.stale.map((id) => `- \`${id}\``))
  }
  lines.push("", "## Per-board Pareto frontiers (reachable models only)", "",
    "Price = best matched plan's real USD per 1M tokens (ascending). Score = best across plan rows. A row is on the frontier if no other reachable row is both cheaper and higher-scored. models.dev-list-priced rows are excluded.", "")
  for (const board of boardsWithScores) {
    lines.push(`### ${pointsData.boards[board]?.name ?? board} (${pointsData.boards[board]?.metric ?? "score"})`, "",
      "| Model | Providers | Match | Plan | Real $/Mtok | List $/Mtok | Score |", "|---|---|---|---|---|---|---|")
    for (const row of pareto(rows, board)) {
      lines.push(`| ${row.model} | ${row.providers.join(", ")} | ${row.kind} | ${row.plan} | ${money(row.real)} | ${money(row.list)} | ${row.scores[board]!.toFixed(2)} |`)
    }
    lines.push("")
  }
  lines.push("## Per-model detail", "",
    "| Model | Providers | Match | Plan | Billing | Real $/Mtok | List $/Mtok | Price source | Confidence | Scores |",
    "|---|---|---|---|---|---|---|---|---|---|")
  for (const row of rows) {
    const scores = boardsWithScores.map((board) => `${board}=${row.scores[board]?.toFixed(2) ?? "—"}`).join(", ")
    lines.push(`| ${row.model} | ${row.providers.join(", ")} | ${row.kind} | ${row.plan} | ${row.billing} | ${money(row.real)} | ${money(row.list)} | ${priceSourceCell(row)} | ${row.confidence} | ${scores} |`)
  }
  if (unpriced.length > 0) {
    lines.push("", "### Reachable models with no pricing match", "", ...unpriced.map((model) => `- \`${model}\``))
  }
  lines.push("")
  return lines.join("\n")
}

// --- main -------------------------------------------------------------------

const modelsDevResponse = await fetchJson("https://models.dev/api.json")
const modelsDev = (modelsDevResponse.ok ? modelsDevResponse.data : {}) as Record<string, unknown>
const modelsDevError = modelsDevResponse.ok ? null : modelsDevResponse.error

const config = await Bun.file(configPath).json() as Config

const defaultRegistry = await loadRegistryFile(registryPath)
const overrideRegistry = await loadRegistryFile(overridePath)
const registryWarnings = [...(defaultRegistry?.warnings ?? []), ...(overrideRegistry?.warnings ?? [])]
// Registry entries (default + machine override, override wins per id) merged
// with auto-discovered config providers not managed by models.dev, so
// subscriptions never silently drop out of reports. Registry takes precedence
// for an id both sides know; discovery defaults to auth/managed "config".
const byId = new Map<string, RegistryProvider>()
for (const entry of defaultRegistry?.entries ?? []) byId.set(entry.id, entry)
for (const entry of overrideRegistry?.entries ?? []) byId.set(entry.id, entry)
const registryCount = byId.size
const discovered: string[] = []
for (const [id, provider] of Object.entries(config.provider ?? {})) {
  if (id in modelsDev || byId.has(id)) continue
  byId.set(id, { id, baseURL: baseURLOf(provider), auth: "config", managed: "config" })
  discovered.push(id)
}
const registry = [...byId.values()]
const selected = registry.filter((entry) => providerFilter.length === 0 || providerFilter.includes(entry.id))

const syncResults: SyncResult[] = []
for (const entry of selected) {
  syncResults.push(await syncEntry(entry))
}

const applied = { backup: null as string | null, added: 0 }
const additions = syncResults.filter((result) =>
  result.reachable && result.missing.length > 0 &&
  (result.managed === "override" || (result.managed === "config" && config.provider?.[result.provider] !== undefined)))
if (apply && additions.length > 0) {
  const backupDir = path.join(path.dirname(configPath), "backups")
  await mkdir(backupDir, { recursive: true })
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-")
  const backupPath = path.join(backupDir, `opencode.catalog-sync-${stamp}.json`)
  await Bun.write(backupPath, await Bun.file(configPath).text())
  applied.backup = backupPath
  config.provider ??= {}
  for (const result of additions) {
    const block = config.provider[result.provider] ??= {}
    const models = block.models ??= {}
    for (const model of result.missing) {
      const entry: ConfigModel = { name: model.name }
      if (model.toolCall) entry.tool_call = true
      models[model.id] = entry
      applied.added += 1
    }
  }
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n")
}

const pointsLoad = await loadPoints()
let rows: ModelRow[] = []
let unmatched: string[] = []
let unpriced: string[] = []
let boardsWithScores: string[] = []
const priceCounts = { realApi: 0, fallback: 0 }
if (pointsLoad.data) {
  const reachable = syncResults.filter((result) => result.reachable)
    .flatMap((result) => localCatalog(result.provider, result.managed).map((model) => `${result.provider}/${model}`))
  boardsWithScores = Object.keys(pointsLoad.data.boards ?? {}).filter((board) =>
    pointsLoad.data!.points.some((point) => typeof (point as unknown as Record<string, unknown>)[`${board}__score`] === "number"))
  const costs = new Map<string, ModelCost>()
  for (const id of reachable) {
    const cost = modelsDevCost(providerOf(id), id.slice(providerOf(id).length + 1))
    if (cost) costs.set(id, cost)
  }
  const built = buildRows(reachable, pointsLoad.data.points, boardsWithScores, costs)
  rows = built.rows
  unmatched = built.unmatched
  unpriced = unmatched.filter((id) => !costs.has(id))
  priceCounts.realApi = rows.filter((row) => row.priceSource === "real-api-pricing").length
  priceCounts.fallback = rows.length - priceCounts.realApi
}

if (pointsLoad.data) {
  await mkdir(stateDir, { recursive: true })
  const summary = markdown(syncResults, pointsLoad.data, pointsLoad.error, rows, unpriced, boardsWithScores, priceCounts)
  const header = modelsDevError ? `Warning: models.dev unavailable (${modelsDevError}); report/override diffs run against config overrides only.\n\n` : ""
  await Bun.write(reportPath, header + summary)
}

if (jsonOut) {
  console.log(JSON.stringify({
    generatedAt: now.toISOString(),
    configPath,
    registry: { path: registryPath, override: overridePath, registryCount, discovered, warnings: registryWarnings },
    apply,
    applied,
    sync: syncResults,
    pricing: { ...priceCounts, unpriced },
    pareto: {
      pointsError: pointsLoad.error,
      pointsMatched: rows.length,
      unmatched,
      boards: Object.fromEntries(boardsWithScores.map((board) => [board, pareto(rows, board)])),
      rows,
    },
  }, null, 2))
} else {
  console.log(`Catalog sync (${apply ? "APPLY" : "report-only"}): config ${configPath}`)
  console.log(registryCount === 0
    ? `Registry: none found (${registryPath}, ${overridePath}) — discovered ${discovered.length} config providers not in models.dev`
    : `Registry: ${registryCount} entries${discovered.length > 0 ? `; discovery added ${discovered.length} config providers` : ""} (${registryPath} + ${overridePath})`)
  for (const warning of registryWarnings) console.log(`  warning: ${warning}`)
  const unmatchedFilters = providerFilter.filter((name) => !selected.some((entry) => entry.id === name))
  if (unmatchedFilters.length > 0) console.log(`  warning: --provider ${unmatchedFilters.join(", ")} matched no registry entries`)
  for (const result of syncResults) {
    const label = `${result.provider} (${result.managed})`
    const note = result.note ? ` [${result.note}]` : ""
    if (!result.reachable) {
      console.log(`  ${label}: unreachable — ${result.error}${note}`)
      continue
    }
    const missing = result.missing.length > 0 ? ` missing: ${result.missing.map((model) => model.id).join(", ")}` : ""
    const stale = result.stale.length > 0 ? ` stale(kept): ${result.stale.join(", ")}` : ""
    console.log(`  ${label}: ${result.localCount} local / ${result.remoteCount} remote${missing}${stale}${note}`)
  }
  if (apply) {
    console.log(applied.added > 0 ? `  applied: ${applied.added} models added; backup: ${applied.backup}` : "  applied: nothing to add")
  }
  if (!pointsLoad.data) {
    console.log(`Pareto: unavailable — ${pointsLoad.error}`)
  } else {
    console.log(`Pareto: ${rows.length} priced models (${priceCounts.realApi} real-api-pricing, ${priceCounts.fallback} models.dev list; ${unpriced.length} unpriced) from ${pointsLoad.data.points.length} points`)
    for (const board of boardsWithScores) {
      const frontier = pareto(rows, board)
      const top = frontier.slice(0, 6).map((row) => `${row.model}(${money(row.real)}, ${row.scores[board]!.toFixed(1)})`).join(" > ")
      console.log(`  ${pointsLoad.data.boards[board]?.name ?? board}: ${frontier.length} on frontier; best: ${top}`)
    }
  }
  if (pointsLoad.data) console.log(`Report: ${reportPath}`)
}
