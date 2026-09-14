# Catalog Sync + Pareto Tracker

Last updated: 2026-09-14

Keeps catalog providers current against their live `/models` endpoints and
tracks model price/quality on the Pareto frontier. Providers come from a
config-file registry — adding a new provider needs no code changes. Portable:
the only machine-specific value is `~`, resolved at runtime. Syncs via the
`homelab` branch; run `install.sh` once per computer.

## Why

opencode auto-fetches catalogs for models.dev-based providers only. Custom
providers (commandcode, cliproxy, kimi-coding, …) are frozen at whatever was
typed into the config — this was why `muse-spark-1.3` was missing from
commandcode for days. Even models.dev-managed providers drift (the live
endpoint sometimes lists models the catalog doesn't, and vice versa). The
pricing/board data comes from
[real-api-pricing](https://github.com/FeiZhuLulu/real-api-pricing)
(`derived/points.json`, snapshot-driven).

## Provider registry

Two JSON files with the same schema, merged per provider id (the machine
override wins entirely for any provider id it declares):

1. **Tracked default**: `providers.json` next to the tool.
2. **Per-machine override**: `~/.config/opencode/catalog-sync.json` (may not
   exist).

The effective provider list is the registry **merged with auto-discovery**:
config provider ids not managed by models.dev and not mentioned by either
registry file are discovered automatically with `auth: "config"` and
`managed: "config"` — so subscriptions stay tracked with zero maintenance, and
registry entries always take precedence for an id both sides know.

```json
{
  "providers": [
    {
      "id": "commandcode",
      "baseURL": "https://api.commandcode.ai/provider/v1",
      "auth": "none",
      "managed": "config"
    }
  ]
}
```

Paths can be overridden for testing: `OPENCODE_SYNC_REGISTRY` (default
registry path) and `OPENCODE_SYNC_OVERRIDE` (override path).

### `auth`

- `"none"` — no auth headers.
- `"config"` — use the opencode config provider block's `apiKey`/`env`
  resolution (same as opencode itself).
- `"env:NAME"` — bearer token from environment variable `NAME`.
- `"authstore"` — read the provider's entry from
  `~/.local/share/opencode/auth.json` at runtime: the `key` field, or the
  `access` token if `key` is absent. Token values are never printed; the
  report only says "authenticated via authstore". If the entry is missing the
  provider is skipped with "no authstore entry".

### `managed`

- `"config"` — provider is pinned in `opencode.json`. The tool diffs live
  vs config; `--apply` adds missing models to `provider.<id>.models` with a
  timestamped backup (never removes).
- `"report"` — models.dev-managed (opencode auto-updates these). The tool
  fetches live `/models`, diffs against the models.dev catalog view (models.dev
  entries plus any config override block for that id), and **reports drift both
  directions** — "remote has X, local catalog doesn't" and "local has X, remote
  doesn't list" — but never writes.
- `"override"` — models.dev-managed but the drift should be fixed: same diff
  as `report`, and `--apply` writes missing models into
  `provider.<id>.models` in the opencode config (opencode merges config
  overrides over models.dev data).

If both registry files are missing entirely, everything is auto-discovered
from the config (providers not in models.dev, auth from config) so the tool
still works bare. Unknown or unreachable endpoints produce a report line,
never a crash.

## Pricing coverage

Prices come from real-api-pricing points matched to reachable catalog models.
Reachable models with **no** real-api-pricing match fall back to the models.dev
api.json `cost` field (input/output USD per MTok — models.dev already publishes
per-MTok values, so no conversion). Fallback rows are marked
`models.dev list` in the report's Price source column (vs `real-api-pricing`),
are excluded from frontier computation (only real fetched prices participate),
and appear in the per-model table so coverage is complete. The report header
and console output state both counts.

## Usage

```sh
# report only (never writes config)
bun run catalog-sync.ts

# add missing models (never removes; timestamped backup first)
bun run catalog-sync.ts --apply

# restrict to one provider (also filters registry entries not in the config)
bun run catalog-sync.ts --apply --provider commandcode

# one-time per-machine scheduled job (daily 08:00 + at login)
./install.sh
```

On macOS the LaunchAgent applies daily and logs to
`~/Library/Logs/opencode-catalog-sync.log`.

## Data flow

1. Live fetch of `points.json` → cached to
   `~/.local/state/opencode/catalog-sync/points-cache.json`.
2. If the fetch fails (offline, repo down), falls back to the runtime cache,
   then to the bundled `points-seed.json` — so the **first run on a new machine
   works from the seeded cache**, and every later run uses fresh data.
3. Providers come from the registry (default + machine override); each is
   queried at `{baseURL}/models` with the auth its registry entry selects.
4. Report: `~/.local/state/opencode/catalog-sync/CATALOG-PARETO.md` — sync/drift
   table plus per-board Pareto frontiers restricted to models actually
   reachable from this machine's catalog.

## Files

- `catalog-sync.ts` — the tool (bun, no dependencies)
- `providers.json` — tracked default provider registry
- `points-seed.json` — slim bundled pricing snapshot (~100 KB, fields the tool
  reads only); refresh it occasionally by committing a new seed
- `install.sh` — per-machine LaunchAgent installer

Machine-local (not tracked): `~/.config/opencode/catalog-sync.json` (registry
override) and `~/.local/state/opencode/catalog-sync/` (cache + report).
