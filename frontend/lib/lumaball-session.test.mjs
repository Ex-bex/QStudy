import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GameSessionQueue,
  requestGameSession,
} from "./lumaball/session-queue.ts";

const { Response } = globalThis;

test("parallel first-entry requests reuse the cookie but receive separate one-use tickets", async () => {
  const queue = new GameSessionQueue();
  let cookie = "";
  let releaseFirst;
  const firstResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let creates = 0;
  let tickets = 0;
  const entry = async () => {
    const supplied = cookie;
    if (!supplied) {
      creates++;
      await firstResponse;
      cookie = "guest-credential";
    }
    return { identity: supplied || cookie, ws_ticket: `ticket-${++tickets}` };
  };
  const first = queue.run(entry);
  const second = queue.run(entry);
  await Promise.resolve();
  assert.equal(creates, 1);
  releaseFirst();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(
    creates,
    1,
    "StrictMode/remount must not create two guests before cookies settle",
  );
  assert.equal(a.identity, b.identity);
  assert.notEqual(
    a.ws_ticket,
    b.ws_ticket,
    "WebSocket tickets cannot be single-flighted",
  );
});

test("expired guest reset retries once, but bans and QStudy authentication errors never become guests", async () => {
  for (const [status, marker, callsExpected] of [
    [401, "1", 2],
    [401, null, 1],
    [403, "1", 1],
  ]) {
    let calls = 0;
    const transport = async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ detail: "Denied" }), {
            status,
            headers: marker ? { "X-QBall-Guest-Reset": marker } : {},
          })
        : Response.json({ identity: { kind: "guest" }, ws_ticket: "fresh" });
    };
    if (callsExpected === 2) {
      assert.equal((await requestGameSession(transport)).ws_ticket, "fresh");
    } else await assert.rejects(requestGameSession(transport), /Denied/);
    assert.equal(calls, callsExpected);
  }
  let retries = 0;
  await assert.rejects(
    requestGameSession(async () => {
      retries++;
      return new Response(JSON.stringify({ detail: "Still expired" }), {
        status: 401,
        headers: { "X-QBall-Guest-Reset": "1" },
      });
    }),
    /Still expired/,
  );
  assert.equal(retries, 2, "a broken guest reset cannot loop indefinitely");
  const next = await requestGameSession(async () =>
    Response.json({ ws_ticket: "next" }),
  );
  assert.equal(
    next.ws_ticket,
    "next",
    "a rejected entry cannot block later requests",
  );
});
