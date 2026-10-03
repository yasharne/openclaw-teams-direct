import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import {
  jsonRequest,
  TransportError,
  Teams,
  Scheduler,
  retryAfter,
} from "../src/http.js";
async function server(handler: RequestListener) {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const address = s.address() as { port: number };
  return {
    s,
    url: new URL(`http://127.0.0.1:${address.port}/`),
    async close() {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
test("request deadlines cancel reads; interrupted writes remain uncertain", async () => {
  const h = await server((_q, _r) => {});
  try {
    await assert.rejects(
      () => jsonRequest(h.url, {}, 30),
      (e) => e instanceof TransportError && e.category === "transient-read",
    );
    await assert.rejects(
      () => jsonRequest(h.url, {}, 30, { test: true }),
      (e) => e instanceof TransportError && e.uncertain,
    );
  } finally {
    await h.close();
  }
});
test("redirects never forward credentials to a second endpoint", async () => {
  let leaked = 0;
  const b = await server((_q, r) => {
    leaked++;
    r.end("{}");
  });
  const a = await server((_q, r) => {
    r.writeHead(302, { Location: b.url.href });
    r.end();
  });
  try {
    await assert.rejects(() =>
      jsonRequest(a.url, { Authentication: "synthetic" }, 1000),
    );
    assert.equal(leaked, 0);
  } finally {
    await a.close();
    await b.close();
  }
});
test("429 uses numeric and HTTP-date Retry-After; no implicit retries", async () => {
  let calls = 0;
  const h = await server((_q, r) => {
    calls++;
    r.writeHead(429, { "Retry-After": "2" });
    r.end("{}");
  });
  try {
    await assert.rejects(
      () => jsonRequest(h.url, {}, 1000, { test: true }),
      (e) =>
        e instanceof TransportError &&
        e.category === "throttled" &&
        !e.uncertain &&
        e.retryAfterMs === 2000,
    );
    assert.equal(calls, 1);
    assert.equal(retryAfter(new Date(20000).toUTCString(), 10000), 10000);
  } finally {
    await h.close();
  }
});
test("successful malformed or oversized write responses remain uncertain", async () => {
  const h = await server((_q, r) => r.end("not JSON"));
  try {
    await assert.rejects(
      () => jsonRequest(h.url, {}, 1000, {}),
      (e) => e instanceof TransportError && e.uncertain,
    );
    await assert.rejects(
      () => jsonRequest(h.url, {}, 1000, {}, 2),
      (e) => e instanceof TransportError && e.uncertain,
    );
  } finally {
    await h.close();
  }
});
test("paging enforces origin, account/chat path and no credentials or fragments", () => {
  const t = new Teams(
    { region: "apac", skypeToken: "synthetic" },
    new Scheduler(60, 2),
    1000,
  );
  for (const u of [
    "https://attacker.invalid/v1/",
    "https://user@apac.ng.msg.teams.microsoft.com/v1/",
    "/v1/users/OTHER/conversations",
    "/v1/users/ME/conversations#token",
  ])
    assert.throws(() => t.url(u, "/v1/users/ME/conversations"));
  assert.equal(
    t.url(
      "/v1/users/ME/conversations?pageSize=10",
      "/v1/users/ME/conversations",
    ).origin,
    t.base.origin,
  );
});
test("scheduler enforces account-wide budget and throttle with a controllable clock", async () => {
  let time = 0;
  const start: number[] = [];
  const s = new Scheduler(
    2,
    1,
    () => time,
    async (ms) => {
      time += ms;
    },
  );
  await s.run(async () => {
    start.push(time);
  });
  await s.run(async () => {
    start.push(time);
  });
  await s.run(async () => {
    start.push(time);
  });
  assert.ok(start[2]! >= 60000);
  s.throttle(5000);
  await s.run(async () => {
    start.push(time);
  });
  assert.ok(start[3]! >= 65000);
});
test("scheduler bounds concurrent requests and releases capacity on errors", async () => {
  let active = 0,
    peak = 0;
  const s = new Scheduler(100, 2);
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      s
        .run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          if (i === 0) throw new Error("synthetic");
        })
        .catch(() => {}),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(s.state.inFlight, 0);
});
