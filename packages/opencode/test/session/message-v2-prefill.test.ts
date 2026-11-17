import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("session")

const copilotAnthropic: Provider.Model = {
  id: ModelV2.ID.make("claude-sonnet-5.5"),
  providerID: ProviderV2.ID.make("github-copilot"),
  api: {
    id: "claude-sonnet-5.5",
    url: "https://api.githubcopilot.com",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude Sonnet 5.5",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const cliproxy = { providerID: "cliproxy", modelID: "claude-sonnet-4-5" }

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: ProviderV2.ID.make("cliproxy"), modelID: ModelV2.ID.make("claude-sonnet-4-5") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(id: string, parentID: string, error?: SessionV1.Assistant["error"]): SessionV1.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: cliproxy.modelID,
    providerID: cliproxy.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
  }
}

function userMessage(id: string, text: string): SessionV1.WithParts {
  return {
    info: userInfo(id),
    parts: [{ ...basePart(id, `${id}-text`), type: "text", text }] as SessionV1.Part[],
  }
}

function completedToolTurn(id: string, parentID: string): SessionV1.WithParts {
  return {
    info: { ...assistantInfo(id, parentID), finish: "tool-calls", time: { created: 0, completed: 1 } },
    parts: [
      {
        ...basePart(id, `${id}-tool`),
        type: "tool",
        callID: `call-${id}`,
        tool: "bash",
        state: {
          status: "completed",
          input: { cmd: "ls" },
          output: "file.txt",
          title: "Bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ] as SessionV1.Part[],
  }
}

// What the failed provider turn leaves behind: an assistant message carrying
// the error, with no completed content.
function erroredTurn(id: string, parentID: string): SessionV1.WithParts {
  return {
    info: assistantInfo(id, parentID, {
      name: "APIError",
      data: { message: "auth_not_found", isRetryable: false },
    } as SessionV1.Assistant["error"]),
    parts: [{ ...basePart(id, `${id}-start`), type: "step-start" }] as SessionV1.Part[],
  }
}

describe("session.message-v2.toModelMessage prefill", () => {
  test("ends with a user message when foreign tools replay as text and the failed turn is skipped", async () => {
    const input = [
      userMessage("m-user", "run tool"),
      completedToolTurn("m-assistant-ok", "m-user"),
      erroredTurn("m-assistant-failed", "m-user"),
    ]

    const result = await MessageV2.toModelMessages(input, copilotAnthropic)

    expect(result.map((msg) => msg.role)).toStrictEqual(["user", "assistant", "user"])
    expect(JSON.stringify(result[1])).toContain("Historical output from the Bash tool")
    expect(JSON.stringify(result[1])).not.toContain("toolCallId")
    expect(result.at(-1)).toStrictEqual({
      role: "user",
      content: [{ type: "text", text: MessageV2.SYNTHETIC_CONTINUE_PROMPT }],
    })
  })

  test("does not add a continue message when no errored turn was skipped", async () => {
    // Pinned by message-v2.test.ts: a foreign replay without a failed turn is
    // left as-is. Only the skipped errored turn triggers the repair.
    const input = [userMessage("m-user", "run tool"), completedToolTurn("m-assistant-ok", "m-user")]

    const result = await MessageV2.toModelMessages(input, copilotAnthropic)

    expect(result.map((msg) => msg.role)).toStrictEqual(["user", "assistant"])
    expect(JSON.stringify(result)).not.toContain(MessageV2.SYNTHETIC_CONTINUE_PROMPT)
  })

  test("ends with a user message when the only trailing turn failed after a completed assistant text turn", async () => {
    const textTurn: SessionV1.WithParts = {
      info: { ...assistantInfo("m-assistant-text", "m-user"), finish: "stop", time: { created: 0, completed: 1 } },
      parts: [{ ...basePart("m-assistant-text", "text"), type: "text", text: "done" }] as SessionV1.Part[],
    }
    const input = [userMessage("m-user", "hello"), textTurn, erroredTurn("m-assistant-failed", "m-user")]

    const result = await MessageV2.toModelMessages(input, copilotAnthropic)

    expect(result.map((msg) => msg.role)).toStrictEqual(["user", "assistant", "user"])
  })

  test("leaves a history that already ends in a user message unchanged", async () => {
    const input = [
      userMessage("m-user-1", "run tool"),
      completedToolTurn("m-assistant-ok", "m-user-1"),
      erroredTurn("m-assistant-failed", "m-user-1"),
      userMessage("m-user-2", "try again"),
    ]

    const result = await MessageV2.toModelMessages(input, copilotAnthropic)

    expect(result.map((msg) => msg.role)).toStrictEqual(["user", "assistant", "user"])
    expect(result.at(-1)).toStrictEqual({
      role: "user",
      content: [{ type: "text", text: "try again" }],
    })
    expect(JSON.stringify(result)).not.toContain(MessageV2.SYNTHETIC_CONTINUE_PROMPT)
  })

  test("does not touch a same-model history, which keeps native tool calls ending in a tool message", async () => {
    const sameModel: Provider.Model = {
      ...copilotAnthropic,
      id: ModelV2.ID.make(cliproxy.modelID),
      providerID: ProviderV2.ID.make(cliproxy.providerID),
    }
    const input = [userMessage("m-user", "run tool"), completedToolTurn("m-assistant-ok", "m-user")]

    const result = await MessageV2.toModelMessages(input, sameModel)

    expect(result.map((msg) => msg.role)).toStrictEqual(["user", "assistant", "tool"])
    expect(JSON.stringify(result)).not.toContain(MessageV2.SYNTHETIC_CONTINUE_PROMPT)
  })
})
