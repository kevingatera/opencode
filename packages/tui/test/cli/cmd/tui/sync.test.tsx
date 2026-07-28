/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent, Message, Part, Session } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function session(id: string, updated: number): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory: "/tmp/opencode/packages/opencode",
    title: id,
    version: "test",
    time: {
      created: updated,
      updated,
    },
  }
}

function message(id: string, created: number): Message {
  return {
    id,
    sessionID: "ses_test",
    role: "user",
    time: { created },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
  }
}

function part(id: string, messageID: string): Part {
  return {
    id,
    sessionID: "ses_test",
    messageID,
    type: "text",
    text: id,
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("loads older session pages with the scoped cursor", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const {
      app,
      sync,
      session: calls,
    } = await mount((url) => {
      if (url.pathname !== "/session") return
      if (url.searchParams.get("cursor") === "next-page") return json([session("older", 1)])
      return json([session("newer", 2)], { headers: { "x-next-cursor": "next-page" } })
    }, tmp.path)

    try {
      expect(sync.data.session.map((item) => item.id)).toEqual(["newer"])
      expect(sync.session.page.more()).toBe(true)

      await sync.session.page.loadMore()

      expect(calls.at(-1)?.searchParams.get("cursor")).toBe("next-page")
      expect(calls.at(-1)?.searchParams.get("path")).toBe("packages/tui")
      expect(sync.data.session.map((item) => item.id)).toEqual(["newer", "older"].sort())
      expect(sync.session.page.more()).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("loads the oldest session page directly with the scoped query", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const {
      app,
      sync,
      session: calls,
    } = await mount((url) => {
      if (url.pathname !== "/session") return
      if (url.searchParams.get("order") === "asc") return json([session("oldest", 1)])
      if (url.searchParams.get("cursor")) throw new Error("oldest page should not walk intermediate cursors")
      return json([session("newest", 3)], { headers: { "x-next-cursor": "next-page" } })
    }, tmp.path)

    try {
      expect(sync.session.page.more()).toBe(true)

      await sync.session.page.loadOldest()

      expect(calls.at(-1)?.searchParams.get("order")).toBe("asc")
      expect(calls.at(-1)?.searchParams.get("path")).toBe("packages/tui")
      expect(sync.data.session.map((item) => item.id)).toEqual(["newest", "oldest"].sort())
      expect(sync.session.page.more()).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("fills newer pages from the oldest side without walking from the newest page", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const {
      app,
      sync,
      session: calls,
    } = await mount((url) => {
      if (url.pathname !== "/session") return
      if (url.searchParams.get("order") === "asc" && !url.searchParams.get("cursor")) {
        return json([session("oldest", 1), session("oldest-top", 2)], {
          headers: { "x-next-cursor": "from-oldest" },
        })
      }
      if (url.searchParams.get("order") === "asc" && url.searchParams.get("cursor") === "from-oldest") {
        return json([session("middle", 3), session("middle-top", 4)])
      }
      if (url.searchParams.get("cursor")) throw new Error("oldest-side fill should not use the newest cursor")
      return json([session("newest", 5)], { headers: { "x-next-cursor": "from-newest" } })
    }, tmp.path)

    try {
      await sync.session.page.loadOldest()

      expect(sync.session.page.oldestMore()).toBe(true)
      expect(sync.session.page.oldestTop()).toBe("oldest-top")

      await sync.session.page.loadFromOldest()

      expect(calls.at(-1)?.searchParams.get("order")).toBe("asc")
      expect(calls.at(-1)?.searchParams.get("cursor")).toBe("from-oldest")
      expect(sync.session.page.oldestMore()).toBe(false)
      expect(sync.session.page.oldestTop()).toBe("middle-top")
      expect(sync.data.session.map((item) => item.id)).toEqual(
        ["newest", "middle", "middle-top", "oldest", "oldest-top"].sort(),
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("fills large oldest-side gaps without walking from the newest page", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const all = Array.from({ length: 250 }, (_, i) => session(`session-${String(i).padStart(3, "0")}`, i))
    const pageSize = 50
    const page = (items: Session[], cursor?: string) =>
      json(items, cursor ? { headers: { "x-next-cursor": cursor } } : undefined)
    const {
      app,
      sync,
      session: calls,
    } = await mount((url) => {
      if (url.pathname !== "/session") return
      const order = url.searchParams.get("order") ?? "desc"
      const cursor = url.searchParams.get("cursor")
      if (order !== "asc" && cursor) throw new Error("oldest-side fill should not use the newest cursor")
      if (order === "asc") {
        const start = cursor ? Number(cursor.replace("asc:", "")) + 1 : 0
        const next = all.slice(start, start + pageSize)
        const nextCursor = start + pageSize < all.length ? `asc:${start + pageSize - 1}` : undefined
        return page(next, nextCursor)
      }

      return page(all.toReversed().slice(0, pageSize), `desc:${all.length - pageSize}`)
    }, tmp.path)

    try {
      await sync.session.page.loadOldest()
      while (sync.session.page.oldestMore()) {
        await sync.session.page.loadFromOldest()
      }

      const ids = sync.data.session.map((item) => item.id)
      expect(ids).toHaveLength(250)
      expect(new Set(ids).size).toBe(250)
      expect(calls.filter((url) => url.searchParams.get("order") === "asc")).toHaveLength(5)
      expect(sync.session.page.oldestMore()).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("loads older session messages when scrolling up", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_scroll"
    const session = {
      id: sessionID,
      title: "scroll",
      time: { created: 0, updated: 0 },
      version: "1.15.13",
      directory: "/tmp/opencode/packages/opencode",
    }
    const message = (id: string, created: number) => ({
      info: {
        id,
        sessionID,
        role: "user" as const,
        time: { created },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        tools: {},
      },
      parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text" as const, text: id }],
    })

    let calls = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        calls++
        if (calls === 1) {
          return json([message("msg_002", 2), message("msg_003", 3)], {
            headers: { "x-next-cursor": "older-page" },
          })
        }
        return json([message("msg_000", 0), message("msg_001", 1)])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync(sessionID)
      expect(sync.data.message[sessionID]?.map((item) => item.id)).toEqual(["msg_002", "msg_003"])
      expect(sync.session.messages.page(sessionID)?.olderComplete).toBe(false)

      const loaded = await sync.session.messages.loadOlder(sessionID)
      expect(loaded).toBe(true)
      expect(sync.data.message[sessionID]?.map((item) => item.id)).toEqual([
        "msg_000",
        "msg_001",
        "msg_002",
        "msg_003",
      ])
      expect(sync.session.messages.page(sessionID)?.olderComplete).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("does not trim live messages while browsing older history", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_follow"
    const { app, sync } = await mount(undefined, tmp.path)

    try {
      const base = Array.from({ length: 100 }, (_, index) => {
        const info = message(`msg_${String(index).padStart(3, "0")}`, index)
        return { info, parts: [part(`prt_${info.id}`, info.id)] }
      })
      sync.session.mergeMessages(sessionID, base)
      sync.session.messages.setFollowing(sessionID, false)
      sync.session.mergeMessages(sessionID, [
        { info: message("msg_100", 100), parts: [part("prt_msg_100", "msg_100")] },
      ])

      expect(sync.data.message[sessionID]).toHaveLength(101)
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_100")
    } finally {
      app.renderer.destroy()
    }
  })

  test("trims the message window while following the bottom", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_trim"
    const { app, sync } = await mount(undefined, tmp.path)

    try {
      const base = Array.from({ length: 100 }, (_, index) => {
        const info = message(`msg_${String(index).padStart(3, "0")}`, index)
        return { info, parts: [part(`prt_${info.id}`, info.id)] }
      })
      sync.session.mergeMessages(sessionID, base)
      sync.session.mergeMessages(sessionID, [
        { info: message("msg_100", 100), parts: [part("prt_msg_100", "msg_100")] },
      ])
      sync.session.messages.setFollowing(sessionID, true)
      sync.session.messages.trimToWindow(sessionID)

      expect(sync.data.message[sessionID]).toHaveLength(100)
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_100")
      expect(sync.data.part.msg_000).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("merges paged messages into the synced transcript in chronological order", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount(undefined, tmp.path)

    try {
      sync.session.mergeMessages("ses_test", [
        { info: message("msg_new", 3), parts: [part("part_new", "msg_new")] },
        { info: message("msg_old", 1), parts: [part("part_old", "msg_old")] },
      ])
      sync.session.mergeMessages("ses_test", [{ info: message("msg_mid", 2), parts: [part("part_mid", "msg_mid")] }])

      expect(sync.data.message.ses_test.map((item) => item.id)).toEqual(["msg_old", "msg_mid", "msg_new"])
      expect(sync.data.part.msg_old.map((item) => item.id)).toEqual(["part_old"])
      expect(sync.data.part.msg_mid.map((item) => item.id)).toEqual(["part_mid"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})
