import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { fixture, group } from "./helpers.js";
import { enqueueOutbound, listenOutbound } from "../src/outbound.js";
import { submitOutbound } from "../src/send.js";
import { work } from "../src/worker.js";
import { TransportError, type Teams } from "../src/http.js";
import { validateConfig } from "../src/config.js";
function setup() {
  const f = fixture();
  f.c.outbound = {
    enabled: true,
    socketPath: join(f.dir, "outbound.sock"),
    targets: { report: group },
  };
  return f;
}
test("outbound socket queues formatted results once with no agent invocation or acknowledgement", async () => {
  const f = setup();
  const server = await listenOutbound(() => f.c, f.s);
  let sends = 0;
  try {
    assert.equal((await stat(f.c.outbound.socketPath)).mode & 0o777, 0o660);
    const body = {
      target: "report",
      id: "cron:1:run:1",
      text: "**Scheduled report**\nAll green",
    };
    const first = await submitOutbound(f.c.outbound.socketPath, body);
    const second = await submitOutbound(f.c.outbound.socketPath, body);
    assert.equal(first.job, second.job);
    assert.equal(second.duplicate, true);
    const teams = {
      send: async (_chat: string, text: string) => {
        assert.match(text, /Scheduled report/);
        sends++;
        return "confirmed";
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams, async () => {
      throw Error("must-not-invoke");
    });
    await work(f.c, f.s, teams, async () => {
      throw Error("must-not-invoke");
    });
    assert.equal(sends, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "sent");
    assert.equal(f.s.get("SELECT COUNT(*) AS n FROM acknowledgements")?.n, 0);
    assert.equal(
      (await submitOutbound(f.c.outbound.socketPath, body)).status,
      "sent",
    );
  } finally {
    await server?.close();
    f.close();
  }
});
test("outbound denies arbitrary targets, transport markers and disabled access; revocation cancels queued result", async () => {
  const f = setup();
  try {
    await assert.rejects(
      enqueueOutbound(f.c, f.s, { target: "other", id: "1", text: "hi" }),
      /not-allowed/,
    );
    await assert.rejects(
      enqueueOutbound(f.c, f.s, {
        target: "report",
        id: "1",
        text: "TEAMS_IMAGE:/etc/passwd",
      }),
      /image-option/,
    );
    f.c.outbound.enabled = false;
    await assert.rejects(
      enqueueOutbound(f.c, f.s, { target: "report", id: "1", text: "hi" }),
      /disabled/,
    );
    f.c.outbound.enabled = true;
    await enqueueOutbound(f.c, f.s, { target: "report", id: "1", text: "hi" });
    f.c.outbound.targets = {};
    await work(f.c, f.s, {} as Teams, async () => {
      throw Error("must-not-invoke");
    });
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "canceled");
  } finally {
    f.close();
  }
});
test("outbound ambiguous send pauses without replay; saved result survives recovery before sending", async () => {
  const f = setup();
  let sends = 0;
  try {
    await enqueueOutbound(f.c, f.s, {
      target: "report",
      id: "event",
      text: "Result",
    });
    f.s.recover();
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "response_ready");
    const teams = {
      send: async () => {
        sends++;
        throw new TransportError("uncertain", 0, true);
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams);
    f.s.recover();
    await work(f.c, f.s, teams);
    assert.equal(sends, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "uncertain");
  } finally {
    f.close();
  }
});
test("outbound images save export bytes before return and invalid paths enqueue nothing", async () => {
  const f = setup();
  try {
    f.c.media.enabled = true;
    f.c.media.outboundRoots = [f.dir];
    const file = join(f.dir, "image.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(file, png);
    await enqueueOutbound(f.c, f.s, {
      target: "report",
      id: "image",
      text: "Chart",
      images: [file],
    });
    await writeFile(file, "changed");
    assert.equal(
      JSON.parse(
        String(f.s.get("SELECT body FROM parts WHERE kind='image'")?.body),
      ).image,
      png.toString("base64"),
    );
    await assert.rejects(
      enqueueOutbound(f.c, f.s, {
        target: "report",
        id: "bad",
        text: "Chart",
        images: ["/etc/passwd"],
      }),
      /unavailable/,
    );
    assert.equal(f.s.get("SELECT COUNT(*) AS n FROM jobs")?.n, 1);
  } finally {
    f.close();
  }
});
test("outbound configuration requires explicit aliases and local socket; channel targets are explicit only", () => {
  const f = setup();
  try {
    for (const outbound of [
      { ...f.c.outbound, socketPath: "relative" },
      { ...f.c.outbound, targets: { bad: "https://evil.invalid" } },
      { ...f.c.outbound, unexpected: true },
    ])
      assert.throws(() => validateConfig({ ...f.c, outbound }));
    assert.equal(
      validateConfig({
        ...f.c,
        outbound: {
          ...f.c.outbound,
          targets: { channel: "19:synthetic@thread.tacv2" },
        },
      }).outbound.targets.channel,
      "19:synthetic@thread.tacv2",
    );
  } finally {
    f.close();
  }
});

test("outbound-only destinations can become incoming chats without replaying earlier history", async () => {
  const f = setup();
  try {
    await enqueueOutbound(f.c, f.s, {
      target: "report",
      id: "event",
      text: "Result",
    });
    assert.equal(f.s.get("SELECT kind FROM chats")?.kind, "outbound");
    f.s.addChat(group, "group", 999999);
    assert.equal(f.s.get("SELECT kind FROM chats")?.kind, "group");
    assert.equal(f.s.get("SELECT cursor FROM chats")?.cursor, 999999);
    f.s.addChat(group, "outbound", 1);
    assert.equal(f.s.get("SELECT kind FROM chats")?.kind, "group");
    assert.equal(f.s.get("SELECT cursor FROM chats")?.cursor, 999999);
  } finally {
    f.close();
  }
});
