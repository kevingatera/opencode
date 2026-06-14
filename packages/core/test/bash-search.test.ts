import { describe, expect, test } from "bun:test"
import { warning } from "../src/tool/bash-search"

const warn = (command: string) => warning(command) !== undefined

describe("bash search warning", () => {
  test("warns for unbounded repo search", () => {
    expect(warn("rg needle .")).toBe(true)
    expect(warn("rg owner_id .")).toBe(true)
    expect(warn("grep -r needle .")).toBe(true)
    expect(warn("cd /repo && rg needle .")).toBe(true)
  })

  test("does not warn for count-bounded search", () => {
    expect(warn("rg --count needle .")).toBe(false)
    expect(warn("grep -cE '^ARG' /tmp/arg_remaining.txt")).toBe(false)
  })

  test("does not warn when output is limited with head", () => {
    expect(warn("grep -rn 'foo' --include='*.py' . | head -30")).toBe(false)
    expect(warn("rg pattern . | head -20")).toBe(false)
  })

  test("does not warn for explicit file or directory operands", () => {
    expect(warn('grep -n "def foo" compaction/search_output.py compaction/search_content.py')).toBe(false)
    expect(warn("grep -rn 'foo' --include='*.py' flows fastapi")).toBe(false)
    expect(warn("rg pattern file.txt")).toBe(false)
    expect(warn("rg -n 'def' packages/core/src/tool/bash-search.ts")).toBe(false)
    expect(warn('grep pattern "$f"')).toBe(false)
    expect(warn('grep -n \'"title": "foo | bar"\' tests/file.py')).toBe(false)
    expect(warn(`grep -n "runtime_turn_sources,\\"" /tmp/tests/file.py`)).toBe(false)
  })

  test("does not warn for glob include or exclude narrowing", () => {
    expect(warn("grep -rn '_source_key' --include='*.py' chat_runtime")).toBe(false)
    expect(warn('grep -rln "adaptiveThinking" --include="*.ts"')).toBe(false)
    expect(warn("rg --glob '*.ts' pattern")).toBe(false)
  })

  test("does not warn for clustered short flags that bound search", () => {
    expect(warn("grep -cE '^ARG' /tmp/arg_remaining.txt")).toBe(false)
    expect(warn('grep -rln "foo" --include="*.ts" | head')).toBe(false)
  })

  test("does not warn for piped stdout filters", () => {
    expect(warn('uv run python scripts/red_team_hard.py 2>&1 | grep -E "^(✅|❌|TOTAL)"')).toBe(false)
    expect(warn('cat fastapi/pyproject.toml | grep -A5 "[project.scripts]"')).toBe(false)
    expect(warn("find . -name foo -exec ls -lO {} \\; 2>/dev/null | grep uchg")).toBe(false)
    expect(warn('ls flows/chat_ottawa_ca/tests/ | rg -i "responses|stream"')).toBe(false)
  })

  test("does not warn for git diff and log pipelines", () => {
    expect(warn("git diff | rg pattern")).toBe(false)
    expect(warn("git show HEAD:file.ts | grep foo")).toBe(false)
    expect(warn("git log --oneline | grep fix")).toBe(false)
  })

  test("still warns when an earlier pipe stage does unbounded repo search", () => {
    expect(warn("rg needle . | grep import")).toBe(true)
  })
})
