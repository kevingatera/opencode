import { describe, expect, test } from "bun:test"
import { CommandFamily } from "../../src/tool/shell/command-family"

describe("CommandFamily.classify", () => {
  test.each([
    ["cat big.txt", "dump"],
    ["nl -ba src/a.ts", "dump"],
    ["head -n 50 log.txt", "dump"],
    ["tail -f app.log", "dump"],
    ["ls -la", "dump"],
    ["find . -name '*.ts'", "dump"],
    ["tree src", "dump"],
    ["rg needle .", "dump"],
    ["grep -r needle .", "dump"],
    ["bat README.md", "dump"],
    ["sed -n 1,40p file.ts", "dump"],
    ["git show HEAD~3", "dump"],
    ["git diff --stat", "dump"],
    ["git log --oneline -50", "dump"],
  ] as const)("%s is dump", (command, family) => {
    expect(CommandFamily.classify(command)).toBe(family)
  })

  test.each([
    ["bun test", "check"],
    ["bun test test/tool/shell.test.ts", "check"],
    ["bun typecheck", "check"],
    ["tsgo --noEmit", "check"],
    ["tsc -p .", "check"],
    ["pytest -q", "check"],
    ["npm test", "check"],
    ["npm run test", "check"],
    ["vitest run", "check"],
    ["jest --ci", "check"],
    ["go test ./...", "check"],
    ["cargo test", "check"],
  ] as const)("%s is check", (command, family) => {
    expect(CommandFamily.classify(command)).toBe(family)
  })

  test.each([
    ["echo hi", "other"],
    ["npm install", "other"],
    ["bun run build", "other"],
    ["go build ./...", "other"],
    ["git status --short", "other"],
    ["git commit -m x", "other"],
    ["sed -i s/a/b/ file.txt", "other"],
    ["sed -n -i 1p file.txt", "other"],
    ["", "other"],
  ] as const)("%j is other-or-named family %s", (command, family) => {
    expect(CommandFamily.classify(command)).toBe(family)
  })

  test("skips a leading cd and classifies the next sub-command", () => {
    expect(CommandFamily.classify("cd packages/opencode && git log -20")).toBe("dump")
    expect(CommandFamily.classify("cd packages/opencode; bun test")).toBe("check")
    expect(CommandFamily.classify("cd /tmp && cd sub && cat a.txt")).toBe("dump")
  })

  test("uses the first sub-command, not a later one", () => {
    expect(CommandFamily.classify("echo start && cat big.txt")).toBe("other")
    expect(CommandFamily.classify("bun install && bun test")).toBe("other")
    expect(CommandFamily.classify("cat a.txt || bun test")).toBe("dump")
  })

  test("strips git global options before reading the subcommand", () => {
    expect(CommandFamily.classify("git -C packages/opencode log -5")).toBe("dump")
    expect(CommandFamily.classify("git -c color.ui=always show HEAD")).toBe("dump")
    expect(CommandFamily.classify("git --no-pager diff")).toBe("dump")
    expect(CommandFamily.classify("git -C dir --no-pager log")).toBe("dump")
    expect(CommandFamily.classify("git -C dir commit -m x")).toBe("other")
  })

  test("treats a cd-only command as other", () => {
    expect(CommandFamily.classify("cd .")).toBe("other")
  })

  test("a pipeline is dump only when every later stage is a filter", () => {
    expect(CommandFamily.classify("cat f | wc -l")).toBe("dump")
    expect(CommandFamily.classify("cat f | sort | uniq -c")).toBe("dump")
    expect(CommandFamily.classify("cat f | python x.py")).toBe("other")
    expect(CommandFamily.classify("rg needle | jq .")).toBe("dump")
  })

  test("quoted separators do not split the command", () => {
    expect(CommandFamily.classify(`echo "a && b"`)).toBe("other")
    expect(CommandFamily.classify(`cat "a;b.txt"`)).toBe("dump")
    expect(CommandFamily.classify(`cat 'x | y'`)).toBe("dump")
  })

  test("an unterminated quote is other", () => {
    expect(CommandFamily.classify(`cat "unterminated`)).toBe("other")
  })

  test("heredocs and output redirects are other", () => {
    expect(CommandFamily.classify("cat <<EOF\nhi\nEOF")).toBe("other")
    expect(CommandFamily.classify("git log > out.txt")).toBe("other")
    expect(CommandFamily.classify("cat a.txt >> out.txt")).toBe("other")
    expect(CommandFamily.classify("cat a.txt | tee out.txt")).toBe("other")
  })
})
