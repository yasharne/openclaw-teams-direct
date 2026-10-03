import test from "node:test";
import assert from "node:assert/strict";
import { fixture, enqueue, message, group, sender, other } from "./helpers.js";
import { work } from "../src/worker.js";
import { TransportError, type Teams } from "../src/http.js";
const fake = (send: Teams["send"]) => ({ send }) as unknown as Teams;
test("activation ignores older history; equal timestamps, overlap and partial pages enqueue once oldest-first", () => {
  const f = fixture();
  try {
    f.s.addChat("dm", "dm", 1000);
    f.s.page(
      "dm",
      [message("new", 3000), message("new2", 3000)],
      "next",
      f.c,
      "first-page",
    );
    assert.equal(f.s.pending(), 0);
    assert.equal(
      f.s.get("SELECT cursor FROM chats WHERE id=?", "dm")?.cursor,
      1000,
    );
    f.s.page(
      "dm",
      [message("old", 999), message("first", 1000), message("middle", 2000)],
      "older",
      f.c,
      "next",
    );
    assert.deepEqual(
      f.s
        .all("SELECT message_id FROM jobs ORDER BY id")
        .map((x) => x.message_id),
      ["first", "middle", "new", "new2"],
    );
    f.s.page(
      "dm",
      [message("new", 3000), message("new2", 3000), message("old", 999)],
      null,
      f.c,
      "first-page",
    );
    assert.equal(f.s.pending(), 4);
  } finally {
    f.close();
  }
});
test("durable page scan rejects loops and queue-full leaves cursor unchanged", () => {
  const f = fixture();
  try {
    f.c.maxQueue = 1;
    f.s.addChat("dm", "dm", 1000);
    f.s.page(
      "dm",
      [message("1", 2000), message("2", 3000)],
      null,
      f.c,
      "first-page",
    );
    assert.equal(f.s.pending(), 0);
    assert.equal(
      f.s.get("SELECT cursor FROM chats WHERE id=?", "dm")?.cursor,
      1000,
    );
    f.c.maxQueue = 2;
    f.s.finish("dm", f.c);
    assert.equal(f.s.pending(), 2);
    f.s.addChat("other", "dm", 1000);
    f.s.page("other", [message("3", 2000)], "repeat", f.c, "first-page");
    assert.throws(() => f.s.page("other", [], "repeat", f.c, "first-page"));
  } finally {
    f.close();
  }
});
test("database insertion failure rolls back cursor, dedup and enqueued jobs", () => {
  const f = fixture();
  try {
    f.s.addChat("dm", "dm", 1000);
    f.s.db.exec(
      "CREATE TRIGGER reject_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic-full'); END;",
    );
    assert.throws(() =>
      f.s.page("dm", [message("1", 2000)], null, f.c, "first-page"),
    );
    assert.equal(
      f.s.get("SELECT cursor FROM chats WHERE id=?", "dm")?.cursor,
      1000,
    );
    assert.equal(f.s.all("SELECT * FROM seen").length, 0);
    assert.equal(f.s.pending(), 0);
  } finally {
    f.close();
  }
});
test("policy revocation causes zero invocation and send calls", async () => {
  const f = fixture();
  try {
    const id = enqueue(f);
    f.c.dmSenders = [];
    let calls = 0;
    await work(
      f.c,
      f.s,
      fake(async () => {
        calls++;
        return "x";
      }),
      async () => {
        calls++;
        return "x";
      },
    );
    assert.equal(calls, 0);
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "canceled",
    );
  } finally {
    f.close();
  }
});
test("response saved before sending; confirmed parts survive restart without reinvoking", async () => {
  const f = fixture();
  try {
    const id = enqueue(f);
    f.c.replyCharacters = 100;
    let invocations = 0,
      sends = 0;
    const t = fake(async () => String(++sends));
    const invoke = async () => {
      invocations++;
      return "😀".repeat(200);
    };
    await work(f.c, f.s, t, invoke);
    assert.equal(sends, 0);
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "response_ready",
    );
    await work(f.c, f.s, t, invoke);
    f.s.recover();
    while (f.s.job()) await work(f.c, f.s, t, invoke);
    assert.equal(invocations, 1);
    assert.equal(sends, 3);
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "sent",
    );
  } finally {
    f.close();
  }
});
test("ambiguous invocation and send pause only their chat, with explicit retry required", async () => {
  const f = fixture();
  try {
    const id = enqueue(f);
    await work(
      f.c,
      f.s,
      fake(async () => ""),
      async () => {
        throw new TransportError("uncertain", 0, true);
      },
    );
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "uncertain",
    );
    assert.throws(() => f.s.resolve(id, "retry", false));
    f.s.resolve(id, "retry", true);
    await work(
      f.c,
      f.s,
      fake(async () => ""),
      async () => "ready",
    );
    await work(
      f.c,
      f.s,
      fake(async () => {
        throw new TransportError("uncertain", 0, true);
      }),
    );
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "uncertain",
    );
    enqueue(f, "other");
    assert.equal(f.s.job()?.chat, "other");
    f.s.resolve(id, "cancel", false);
    assert.equal(
      f.s.get("SELECT reason FROM chats WHERE id=?", "dm")?.reason,
      null,
    );
  } finally {
    f.close();
  }
});
test("expired Teams auth preserves saved reply and exposes needs-login", async () => {
  const f = fixture();
  try {
    const id = enqueue(f);
    await work(
      f.c,
      f.s,
      fake(async () => ""),
      async () => "reply",
    );
    await work(
      f.c,
      f.s,
      fake(async () => {
        throw new TransportError("needs-login");
      }),
    );
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
      "response_ready",
    );
    assert.equal(f.s.status().authentication, "needs-login");
  } finally {
    f.close();
  }
});
test("fair worker rotates chats; group and denied sender policies enqueue correctly", () => {
  const f = fixture();
  try {
    enqueue(f, "a");
    enqueue(f, "a", "dm", message("2"));
    enqueue(f, "b");
    const first = f.s.job()!;
    f.s.start(Number(first.id), "invoking");
    f.s.state(Number(first.id), "sent");
    assert.equal(f.s.job()?.chat, "b");
    f.s.addChat(group, "group", 1000);
    f.s.page(
      group,
      [
        message("3", 1000, "no trigger"),
        message("4", 1000, "!claw allowed"),
        message("5", 1000, "!claw denied", other),
      ],
      null,
      f.c,
      "first-page",
    );
    assert.equal(f.s.all("SELECT * FROM jobs WHERE chat=?", group).length, 1);
  } finally {
    f.close();
  }
});
test("retention purges completed and old uncertain payloads while retaining IDs and pausing expired jobs", () => {
  const f = fixture();
  try {
    const a = enqueue(f, "a");
    f.s.state(a, "sent");
    const b = enqueue(f, "b");
    f.s.fail(b, "b", "uncertain");
    f.s.run("UPDATE jobs SET created=0,updated=0");
    f.s.cleanup(f.c, 10 * 86400000);
    assert.equal(f.s.get("SELECT body FROM jobs WHERE id=?", a)?.body, null);
    assert.equal(
      f.s.get("SELECT status FROM jobs WHERE id=?", b)?.status,
      "expired",
    );
    assert.equal(f.s.get("SELECT body FROM jobs WHERE id=?", b)?.body, null);
    assert.throws(() => f.s.resolve(b, "retry", true));
    assert.equal(f.s.all("SELECT id FROM jobs").length, 2);
  } finally {
    f.close();
  }
});

test("missing saved history boundary pauses rather than silently advancing", () => {
  const f = fixture();
  try {
    enqueue(f, "dm", "dm", message("boundary", 2000));
    assert.throws(
      () => f.s.page("dm", [message("later", 3000)], null, f.c, "first-page"),
      /history-gap/,
    );
    assert.equal(
      f.s.get("SELECT cursor FROM chats WHERE id=?", "dm")?.cursor,
      2000,
    );
    assert.equal(f.s.pending(), 1);
  } finally {
    f.close();
  }
});
test("scan storage is bounded and a failed job cannot retry purged content", () => {
  const f = fixture();
  try {
    f.c.maxScanMessages = 1;
    f.s.addChat("dm", "dm", 1000);
    assert.throws(
      () =>
        f.s.page(
          "dm",
          [message("one"), message("two")],
          null,
          f.c,
          "first-page",
        ),
      /scan-limit/,
    );
    assert.equal(f.s.all("SELECT * FROM scan").length, 0);
    f.c.maxScanMessages = 10000;
    const id = enqueue(f);
    f.s.fail(id, "dm", "failed");
    f.s.run("UPDATE jobs SET updated=0");
    f.s.cleanup(f.c, 2 * 86400000);
    assert.throws(() => f.s.resolve(id, "retry", true), /expired-payload/);
  } finally {
    f.close();
  }
});
