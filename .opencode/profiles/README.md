# Role Routing
Last updated: 2026-09-11 America/Toronto

`role-routing.json` enables the local legacy TUI/CLI routing feature. The published schema does not yet include the local `model_routing` extension; this checkout validates it. The separate V2 Session runner does not enforce this policy.

Run from the repository root before installing:

```sh
OPENCODE_CONFIG="$PWD/.opencode/profiles/role-routing.json" bun dev
```

The profile preserves the main model you select. It uses Luna at medium reasoning effort for exploration, titles, and compaction; Grok 4.5 at medium effort for implementation (falling back to Grok 4.6, then DeepSeek V4.1 Flash on OpenCode Go in curated mode); Opus 5 for design and primary review; and Sol at low effort for a second review of Opus-authored changes. Measured evidence: Grok's default and medium variants produced byte-identical real-repo edits with medium costing 25 percent fewer tokens; DeepSeek produced the only approve-as-is diff on a real repository file and is the cheapest full-kill point, but its self-tests are 29 percent stub-blind and it had one silent no-response failure under a provider reasoning cap; Opus led the hardest reviewer rounds on defect coverage and valuable unplanned catches, which justifies its review role despite Grok matching it at 41 percent of the cost on earlier rounds. Shell actions in specialist roles require approval; role descriptions are not an operating-system sandbox.

## Commands

- `/routing same` restricts subsequent model calls to the root session's original provider.
- `/routing curated` permits the ordered candidates listed for each role across available, permitted providers. It does not enumerate arbitrary models or automatically retry failed provider requests.
- `/routing status` displays effective routes and unavailable candidates without a model completion.

Commands are discovered through the existing slash menu. Wait for the issuing session to be idle. The policy covers nested children and auxiliary title/compaction calls, but cannot recall requests already sent. Child providers remain pinned on resume. An incompatible candidate stops with an error rather than silently changing providers.

Unconfigured main roles honor `/models`: within the original provider in `same`, or any explicitly selected permitted model in `curated`. Unconfigured child and auxiliary roles fall back to the original root model. Candidate lists are saved when a root first uses routing; restart and start a new root to adopt profile edits. Switching back to `same` restores the original provider restriction, not the provider most recently selected in wider mode.

The wider profile currently adds OpenAI Luna/Sol alternatives. Implementation remains non-GPT and uses Copilot candidates. Add further exact provider/model routes only after checking availability; a visible catalog entry does not establish entitlement or remaining quota.

Existing global `small_model` is preserved. The routing policy overrides it for routed title calls. The profile does not change deployment authorization, existing approvals, credentials, or automatic-update settings.

## Evidence

The bounded comparison and Python readability reports are under `packages/opencode/test/model-routing-bench/`. They retain correctness tests, post-hoc audits, raw syntax metrics, and a separate identity-masked review. One small task per model is insufficient to establish a general model ranking.
