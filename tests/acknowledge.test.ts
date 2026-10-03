import test from "node:test";
import assert from "node:assert/strict";
import { fixture, enqueue, message, other } from "./helpers.js";
import { work } from "../src/worker.js";
import { Teams, TransportError, Scheduler } from "../src/http.js";
test("accepted message gets one reaction and read receipt before invocation; saved client ID survives", async () => {
  const f = fixture(),
    calls: string[] = [];
  try {
    f.c.markRead = true;
    f.c.acknowledgementReaction = "think";
    enqueue(f, "dm", "dm", { ...message(), clientId: "client-original" });
    const teams = {
      react: async () => {
        calls.push("reaction");
      },
      markRead: async (_c: string, _m: string, client: string) => {
        assert.equal(client, "client-original");
        calls.push("read");
      },
      send: async () => {
        calls.push("send");
        return "confirmed";
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams, async () => {
      calls.push("invoke");
      return "reply";
    });
    await work(f.c, f.s, teams);
    assert.deepEqual(calls, ["reaction", "read", "invoke", "send"]);
    f.s.recover();
    await work(f.c, f.s, teams);
    assert.equal(calls.length, 4);
  } finally {
    f.close();
  }
});
test("uncertain reaction is not repeated and does not repeat or block an agent invocation", async () => {
  const f = fixture();
  try {
    f.c.acknowledgementReaction = "think";
    enqueue(f);
    let reactions = 0,
      invocations = 0;
    const teams = {
      react: async () => {
        reactions++;
        throw new TransportError("uncertain", 0, true);
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams, async () => {
      invocations++;
      return "reply";
    });
    assert.equal(
      f.s.get("SELECT reaction_state FROM acknowledgements")?.reaction_state,
      "uncertain",
    );
    assert.equal(reactions, 1);
    assert.equal(invocations, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "response_ready");
  } finally {
    f.close();
  }
});
test("crash during cosmetic acknowledgement preserves queued work without replaying the write", async () => {
  const f = fixture();
  try {
    f.c.acknowledgementReaction = "think";
    enqueue(f);
    f.s.run("UPDATE acknowledgements SET reaction_state='sending'");
    f.s.recover();
    let calls = 0;
    await work(
      f.c,
      f.s,
      {
        react: async () => {
          calls++;
        },
      } as unknown as Teams,
      async () => "reply",
    );
    assert.equal(calls, 0);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "response_ready");
  } finally {
    f.close();
  }
});
test("ack auth expiry preserves queued turn; denial causes zero acknowledgement calls", async () => {
  const f = fixture();
  try {
    f.c.acknowledgementReaction = "think";
    enqueue(f);
    let invoked = 0,
      reacted = 0;
    const teams = {
      react: async () => {
        reacted++;
        throw new TransportError("needs-login");
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams, async () => {
      invoked++;
      return "reply";
    });
    assert.equal(invoked, 0);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "queued");
    assert.equal(
      f.s.get("SELECT value FROM meta WHERE key='auth'")?.value,
      "needs-login",
    );
    f.c.dmSenders = [other];
    await work(f.c, f.s, teams);
    assert.equal(reacted, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "canceled");
  } finally {
    f.close();
  }
});
test("read horizon never moves backward and carries the real client message ID", async () => {
  const teams = new Teams(
    { region: "apac", skypeToken: "synthetic" },
    new Scheduler(60, 2),
    1000,
  );
  let horizon = "300;123;original",
    writes: unknown[] = [];
  teams.request = async (_path, body) => {
    if (body) writes.push(body);
    return {
      data: { properties: { consumptionhorizon: horizon } },
      date: null,
    };
  };
  await teams.markRead("chat", "200", "client-id");
  assert.equal(writes.length, 0);
  horizon = "100;123;original";
  await teams.markRead("chat", "200", "client-id");
  assert.ok(
    String(
      (writes[0] as { consumptionhorizon: string }).consumptionhorizon,
    ).startsWith("200;"),
  );
  assert.ok(
    String(
      (writes[0] as { consumptionhorizon: string }).consumptionhorizon,
    ).endsWith(";client-id"),
  );
});
