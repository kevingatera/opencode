import { expect, test } from "bun:test"
import type { Message, TextPart } from "@opencode-ai/sdk/v2"
import { routingScope } from "../../src/feature-plugins/session/routing-scope"

const user = (id: string): Message => ({
  id,
  sessionID: "ses",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude" },
})

const assistant = (id: string, created: number): Message => ({
  id,
  sessionID: "ses",
  role: "assistant",
  time: { created },
  parentID: "user",
  modelID: "claude",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const payload = (scope: string) => ({
  scope,
  rootSessionID: "ses",
  anchor: { providerID: "anthropic", modelID: "claude" },
})

const control = (messageID: string, text: string, routing?: unknown): TextPart => ({
  id: "part-" + messageID,
  sessionID: "ses",
  messageID,
  type: "text",
  text,
  synthetic: true,
  metadata: {
    "opencode.control": "routing",
    ...(routing === undefined ? {} : { "opencode.routing": routing }),
  },
})

const plain = (messageID: string, text: string): TextPart => ({
  id: "part-" + messageID,
  sessionID: "ses",
  messageID,
  type: "text",
  text,
})

function partsByMessage(parts: TextPart[]) {
  return (messageID: string) => parts.filter((part) => part.messageID === messageID)
}

test("no routing control messages yields no scope", () => {
  const messages = [user("u1"), assistant("a1", 2)]
  expect(routingScope(messages, partsByMessage([plain("a1", "hello")]))).toBeUndefined()
})

test("structured payload yields its scope", () => {
  const messages = [assistant("a1", 2)]
  const parts = partsByMessage([control("a1", "Legacy model routing: same", payload("same"))])
  expect(routingScope(messages, parts)).toBe("same")
})

test("newest routing control message wins", () => {
  const messages = [user("u1"), assistant("a1", 2), user("u2"), assistant("a2", 3)]
  const parts = partsByMessage([
    control("a1", "Legacy model routing: same", payload("same")),
    control("a2", "Legacy model routing: curated", payload("curated")),
  ])
  expect(routingScope(messages, parts)).toBe("curated")
})

test("text-only control message without structured payload yields no scope", () => {
  const messages = [assistant("a1", 2)]
  const parts = partsByMessage([control("a1", "Legacy model routing: curated")])
  expect(routingScope(messages, parts)).toBeUndefined()
})

test("plain non-control parts are ignored", () => {
  const messages = [assistant("a1", 2)]
  const parts = partsByMessage([
    { ...control("a1", "hello", payload("curated")), metadata: { "opencode.routing": payload("curated") } },
  ])
  expect(routingScope(messages, parts)).toBeUndefined()
})

test("malformed payload yields no scope instead of throwing", () => {
  const messages = [assistant("a1", 2)]
  const parts = partsByMessage([
    control("a1", "Legacy model routing: same", { scope: "everything", rootSessionID: 42 }),
  ])
  expect(() => routingScope(messages, parts)).not.toThrow()
  expect(routingScope(messages, parts)).toBeUndefined()
})

test("synthetic user /routing part does not determine scope", () => {
  const messages = [user("u1"), assistant("a1", 2)]
  const parts = partsByMessage([control("u1", "/routing curated", payload("curated"))])
  expect(routingScope(messages, parts)).toBeUndefined()
})
