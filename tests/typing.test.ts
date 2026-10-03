import test from "node:test";
import assert from "node:assert/strict";
import { withTyping } from "../src/typing.js";
import { Teams, Scheduler } from "../src/http.js";
test("typing refreshes sequentially and clears after success with no late refresh", async () => {
  const calls: boolean[] = [];
  const teams = {
    typing: async (_: string, active: boolean) => {
      calls.push(active);
    },
  };
  const result = await withTyping(
    true,
    teams,
    "chat",
    async () => {
      await new Promise((r) => setTimeout(r, 25));
      return "reply";
    },
    5,
  );
  assert.equal(result, "reply");
  assert.ok(calls.filter(Boolean).length >= 2);
  assert.equal(calls.at(-1), false);
  const count = calls.length;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(calls.length, count);
});
test("typing errors do not lose agent results; invocation failure still clears", async () => {
  assert.equal(
    await withTyping(
      true,
      {
        typing: async () => {
          throw Error("unavailable");
        },
      },
      "chat",
      async () => "reply",
    ),
    "reply",
  );
  const calls: boolean[] = [];
  await assert.rejects(
    withTyping(
      true,
      {
        typing: async (_, active) => {
          calls.push(active);
        },
      },
      "chat",
      async () => {
        throw Error("agent-failed");
      },
    ),
    /agent-failed/,
  );
  assert.deepEqual(calls, [true, false]);
  await withTyping(
    false,
    {
      typing: async () => {
        throw Error("disabled");
      },
    },
    "chat",
    async () => "reply",
  );
});
test("Teams typing uses transient control messages and accepts empty responses", async () => {
  const teams = new Teams(
    { skypeToken: "synthetic", region: "emea" },
    new Scheduler(60, 1),
    1000,
  );
  const bodies: unknown[] = [];
  teams.request = async (_path, body, _prefix, method, empty) => {
    assert.equal(method, "POST");
    assert.equal(empty, true);
    bodies.push(body);
    return { data: null, date: null };
  };
  await teams.typing("chat", true);
  await teams.typing("chat", false);
  assert.deepEqual(
    bodies.map((b) => (b as { messagetype: string }).messagetype),
    ["Control/Typing", "Control/ClearTyping"],
  );
  assert.ok(bodies.every((b) => (b as { content: unknown }).content === null));
});
