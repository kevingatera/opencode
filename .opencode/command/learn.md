---
description: Extract session learnings into AGENTS.md, repo docs, and skills/commands
---

Analyze this session and extract non-obvious learnings into AGENTS.md, repo docs, and skills/commands.

Scope — route each learning first:

- (a) codebase understanding → nearest AGENTS.md (project-wide → root, package → packages/foo/AGENTS.md, feature → src/auth/AGENTS.md)
- (b) user-facing behavior/API/config that docs describe → repo docs (README, docs/, package READMEs — never generated dirs like src/generated)
- (c) repeated manual instructions / harness friction → skills or commands under .opencode/skills|command or user config
- If the request is harness-only tuning with no codebase learning, say so and still handle via (c)

AGENTS.md files can exist at any directory level, not just the project root. When an agent reads a file, any AGENTS.md in parent directories are automatically loaded into the context of the tool read. Place learnings as close to the relevant code as possible.

What counts as a learning (non-obvious discoveries only):

- Hidden relationships between files or modules
- Execution paths that differ from how code appears
- Non-obvious configuration, env vars, or flags
- Debugging breakthroughs when error messages were misleading
- API/tool quirks and workarounds
- Build/test commands not in README
- Architectural decisions and constraints
- Files that must change together
- Verification gaps: repeated "try again" / "can you fix" / hand-typed git diff, status, typecheck, test, or rebuild steps signal missing AGENTS.md guidance — propose the check as default behavior, not post-hoc narration

What NOT to include:

- Obvious facts from documentation
- Standard language/framework behavior
- Things already in an AGENTS.md
- Verbose explanations
- Session-specific details
- Secrets, tokens, keys, auth material, env values, emails, absolute home paths

Genericization rules:

- Use repo-relative paths, never absolute home paths
- Prefer reusable mechanisms over session narration ("always run X before Y" beats "in this session we...")
- One finding = one entry, 1-3 lines each; omit filler

Stale-line check (before adding anything):

- Re-read the target AGENTS.md first
- Fix or refresh lines that contradict current config, scripts, or code; trust executable sources over memory
- Use surgical search-replace; never overwrite the whole file; preserve verified guidance

Docs rules:

- Re-read the target doc first; make surgical edits, never rewrites
- Trust executable sources (code, config, scripts) over memory or stale prose
- One insight = 1-3 lines; skip anything already stated; no duplicates

Skills/commands rules:

- Create = new SKILL.md or command file matching sibling location, with frontmatter (name, description with triggers; user-invocable for skills)
- Edit = surgical search-replace on the existing file
- Protected/bundled/plugin/git-tracked files = never edit in place; write an override of the same name under user/project config or a patch file
- Deletes/disables only with an explicit pick plus a referrer check; a narrow window proves nothing

Process:

1. Review session for discoveries, errors that took multiple attempts, unexpected connections
2. Route each learning via Scope (a)/(b)/(c) and determine the target file
3. Re-read existing targets at relevant levels and run the stale-line check
4. Report first, then stop: present a short grouped report — (a) AGENTS.md entries, (b) docs updates, (c) skills/commands creates+updates, (d) deletes/disables, (e) gaps for discussion — and end the turn without a picker
5. Edit only after the user picks ids; free-text is not consent; unpicked entries are deferred, an explicit no is rejected; one group's answer never authorizes another group
6. Apply picked edits surgically

After updating, list all files created/updated by path, counts per file, and how to undo each (what to delete or revert).

$ARGUMENTS
