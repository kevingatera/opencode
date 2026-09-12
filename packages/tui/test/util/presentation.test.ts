import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode -s ses_123")
})

test("omits continue line when session id is missing", () => {
  const epilogue = sessionEpilogue({ title: "A session" })
  expect(epilogue).toContain("A session")
  expect(epilogue).not.toContain("undefined")
  expect(epilogue).not.toContain("opencode -s")
})
