/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2"

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

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("loads older session pages with the scoped cursor", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const {
      app,
      sync,
      session: calls,
    } = await mount((url) => {
      if (url.pathname !== "/session") return
      if (url.searchParams.get("cursor") === "next-page") return json([session("older", 1)])
      return json([session("newer", 2)], { headers: { "x-next-cursor": "next-page" } })
    })

    try {
      expect(sync.data.session.map((item) => item.id)).toEqual(["newer"])
      expect(sync.session.page.more()).toBe(true)

      await sync.session.page.loadMore()

      expect(calls.at(-1)?.searchParams.get("cursor")).toBe("next-page")
      expect(calls.at(-1)?.searchParams.get("path")).toBe("packages/opencode")
      expect(sync.data.session.map((item) => item.id)).toEqual(["newer", "older"].sort())
      expect(sync.session.page.more()).toBe(false)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("loads the oldest session page directly with the scoped query", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
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
    })

    try {
      expect(sync.session.page.more()).toBe(true)

      await sync.session.page.loadOldest()

      expect(calls.at(-1)?.searchParams.get("order")).toBe("asc")
      expect(calls.at(-1)?.searchParams.get("path")).toBe("packages/opencode")
      expect(sync.data.session.map((item) => item.id)).toEqual(["newest", "oldest"].sort())
      expect(sync.session.page.more()).toBe(true)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("fills newer pages from the oldest side without walking from the newest page", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
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
    })

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
      Global.Path.state = previous
    }
  })

  test("fills large oldest-side gaps without walking from the newest page", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
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
    })

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
      Global.Path.state = previous
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

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
      Global.Path.state = previous
    }
  })
})
