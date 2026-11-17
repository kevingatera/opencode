import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import os from "os"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { ModelsTool } from "../../src/tool/models"
import * as Tool from "../../src/tool/tool"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const stateDir = path.join(os.tmpdir(), "opencode-models-test")

afterEach(async () => {
  await disposeAllInstances()
  await import("fs/promises").then((fs) => fs.rm(stateDir, { recursive: true, force: true }))
})

const layer = LayerNode.compile(
  LayerNode.group([Agent.node, Provider.node, Config.node, Truncate.node, FSUtil.node, Global.node]),
  [[Global.node, Global.layerWith({ state: stateDir })]],
)

const it = testEffect(layer)

// Probe IDs are unique to this file so the models.dev catalog merged into
// provider.list() cannot leak into assertions; always narrow with query.
const catalog = () => ({
  provider: {
    oss: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test", baseURL: "http://127.0.0.1:1" },
      models: {
        "probe-llama": { name: "Llama", limit: { context: 100000, output: 1000 } },
        "probe-mistral": { name: "Mistral", limit: { context: 100000, output: 1000 } },
      },
    },
    "github-copilot": {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test", baseURL: "http://127.0.0.1:1" },
      models: { "probe-opus": { name: "Opus", limit: { context: 100000, output: 1000 } } },
    },
  },
})

const writeRecents = (raw: unknown) =>
  Effect.promise(() => import("fs/promises").then((fs) => fs.mkdir(stateDir, { recursive: true }))).pipe(
    Effect.andThen(() =>
      Effect.promise(() =>
        import("fs/promises").then((fs) => fs.writeFile(path.join(stateDir, "model.json"), JSON.stringify(raw))),
      ),
    ),
  )

const ctx = () => ({
  sessionID: SessionID.make("ses_models_test"),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const models = Effect.fn("ModelsToolTest.models")(function* () {
  const tool = yield* ModelsTool
  return yield* Tool.init(tool)
})

describe("tool.models", () => {
  it.instance(
    "lists catalog models with recents first",
    () =>
      Effect.gen(function* () {
        yield* writeRecents({ recent: [{ providerID: "github-copilot", modelID: "probe-opus" }] })
        const def = yield* models()
        const result = yield* def.execute({ query: "probe-" }, ctx())
        expect(result.title).toBe("Available models")
        const lines = result.output.split("\n")
        expect(lines[0]).toContain("3 shown of 3")
        expect(lines[1]).toBe("github-copilot/probe-opus")
        expect(lines.slice(2, 4)).toEqual(["oss/probe-llama", "oss/probe-mistral"])
        expect(result.metadata).toMatchObject({ count: 3, total: 3 })
      }),
    { config: catalog },
    30_000,
  )

  it.instance(
    "filters by query and honors limit",
    () =>
      Effect.gen(function* () {
        yield* writeRecents({ recent: [] })
        const def = yield* models()
        const result = yield* def.execute({ query: "probe-llama", limit: 1 }, ctx())
        expect(result.output).toContain("oss/probe-llama")
        expect(result.output).not.toContain("probe-mistral")
        expect(result.output).not.toContain("probe-opus")
        expect(result.metadata).toMatchObject({ count: 1, total: 1 })
      }),
    { config: catalog },
    30_000,
  )

  it.instance(
    "tolerates missing recents with an alphabetical catalog",
    () =>
      Effect.gen(function* () {
        const def = yield* models()
        const result = yield* def.execute({ query: "probe-" }, ctx())
        const lines = result.output.split("\n")
        expect(lines.slice(1, 4)).toEqual([
          "github-copilot/probe-opus",
          "oss/probe-llama",
          "oss/probe-mistral",
        ])
      }),
    { config: catalog },
    30_000,
  )

  it.instance(
    "tolerates malformed recents entries",
    () =>
      Effect.gen(function* () {
        yield* writeRecents({ recent: [{ providerID: "oss" }, "nope", { providerID: 42, modelID: "probe-llama" }] })
        const def = yield* models()
        const result = yield* def.execute({ query: "probe-", limit: 100 }, ctx())
        const lines = result.output.split("\n")
        expect(lines.slice(1, 4)).toEqual([
          "github-copilot/probe-opus",
          "oss/probe-llama",
          "oss/probe-mistral",
        ])
      }),
    { config: catalog },
    30_000,
  )

  it.instance(
    "excludes disabled providers",
    () =>
      Effect.gen(function* () {
        yield* writeRecents({ recent: [{ providerID: "oss", modelID: "probe-llama" }] })
        const def = yield* models()
        const result = yield* def.execute({ query: "probe-" }, ctx())
        expect(result.output).toContain("github-copilot/probe-opus")
        expect(result.output).not.toContain("oss/")
      }),
    {
      config: () => ({
        ...catalog(),
        disabled_providers: ["oss"],
      }),
    },
    30_000,
  )
})
