---
description: git commit and push
model: opencode/kimi-k2.5
subtask: true
---

commit and push

make sure it includes a prefix like
docs:
tui:
core:
ci:
ignore:
wip:

For anything in the packages/web use the docs: prefix.

prefer to explain WHY something was done from an end user perspective instead of
WHAT was done.

do not do generic messages like "improved agent experience" be very specific
about what user facing changes were made

if there are conflicts DO NOT FIX THEM. notify me and I will fix them

Inspect the changes with targeted commands, never a bare `git diff`:
use `git status --short` to see what changed, `git diff --stat` for a summary,
and `git diff -- <path>` for only the files you need to understand. A full diff
on a large tree is too big to load.

## GIT STATUS --short

!`git status --short`

## GIT DIFF --stat

!`git diff --stat`

## GIT DIFF --cached --stat

!`git diff --cached --stat`
