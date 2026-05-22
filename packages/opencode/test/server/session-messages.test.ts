import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { eq } from "drizzle-orm"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies MessageV2.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies MessageV2.TextPart)
        return id
      }),
  )
})

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, init)))
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("session messages endpoint", () => {
  it.instance(
    "returns cursor headers for older session pages",
    withoutWatcher(
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const newer = yield* sessionScoped
        const middle = yield* sessionScoped
        const older = yield* sessionScoped

        yield* Effect.sync(() => {
          Database.use((db) => {
            db.update(SessionTable).set({ time_updated: 3000 }).where(eq(SessionTable.id, newer.id)).run()
            db.update(SessionTable).set({ time_updated: 2000 }).where(eq(SessionTable.id, middle.id)).run()
            db.update(SessionTable).set({ time_updated: 1000 }).where(eq(SessionTable.id, older.id)).run()
          })
        })

        const a = yield* request("/session?limit=2", { headers })
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionNs.Info[]>(a)
        expect(aBody.map((item) => item.id)).toEqual([newer.id, middle.id])
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(a.headers.get("link")).toContain('rel="next"')
        expect(a.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-next-cursor")

        const b = yield* request(`/session?limit=2&cursor=${encodeURIComponent(cursor!)}`, { headers })
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionNs.Info[]>(b)
        expect(bBody.map((item) => item.id)).toEqual([older.id])
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns oldest session pages directly",
    withoutWatcher(
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const newer = yield* sessionScoped
        const middle = yield* sessionScoped
        const older = yield* sessionScoped

        yield* Effect.sync(() => {
          Database.use((db) => {
            db.update(SessionTable).set({ time_updated: 3000 }).where(eq(SessionTable.id, newer.id)).run()
            db.update(SessionTable).set({ time_updated: 2000 }).where(eq(SessionTable.id, middle.id)).run()
            db.update(SessionTable).set({ time_updated: 1000 }).where(eq(SessionTable.id, older.id)).run()
          })
        })

        const response = yield* request("/session?limit=2&order=asc", { headers })

        expect(response.status).toBe(200)
        const body = yield* json<SessionNs.Info[]>(response)
        expect(body.map((item) => item.id)).toEqual([older.id, middle.id])
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<MessageV2.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(a.headers.get("link")).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<MessageV2.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns oldest message pages directly",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2&order=asc`)
        expect(a.status).toBe(200)
        const aBody = yield* json<MessageV2.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()

        const b = yield* request(
          `/session/${session.id}/message?limit=2&order=asc&before=${encodeURIComponent(cursor!)}`,
        )
        expect(b.status).toBe(200)
        const bBody = yield* json<MessageV2.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(2, 4))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})
