import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  fixture,
  enqueue,
  self,
  sender,
  other,
  group,
  message,
} from "./helpers.js";
import { inlineImages, normalize, promptFor } from "../src/policy.js";
import { imageMime, readOutboundImage, replyParts, AMS } from "../src/media.js";
import { Teams, Scheduler, TransportError } from "../src/http.js";
import { work } from "../src/worker.js";
import { invoke } from "../src/openclaw.js";
import { splitReply } from "../src/policy.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
test("image parsing refuses external URLs and preserves sender/prefix policy; unsupported media does not block scanning", () => {
  const f = fixture();
  try {
    f.c.media.enabled = true;
    const html = `<img itemtype="http://schema.skype.com/AMSImage" src="${AMS}/safe-id/views/imgo"><img src="https://attacker.invalid/image"><img src="${AMS}/../evil/views/imgo">`;
    assert.deepEqual(inlineImages(html), ["safe-id"]);
    const m = { ...message(), text: "", images: ["safe-id"] };
    assert.equal(promptFor(f.c, "dm", "dm", m), "Describe this image.");
    assert.equal(promptFor(f.c, "dm", "dm", { ...m, sender: other }), null);
    assert.equal(promptFor(f.c, group, "group", m), null);
    assert.equal(
      promptFor(f.c, group, "group", { ...m, text: "!claw" }),
      "Describe this image.",
    );
    const ignored = normalize({
      id: "file",
      messagetype: "RichText/Media_GenericFile",
      originalarrivaltime: new Date().toISOString(),
      from: sender,
      content: "file",
    });
    assert.equal(promptFor(f.c, group, "group", ignored), null);
    f.c.media.enabled = false;
    assert.equal(promptFor(f.c, "dm", "dm", m), null);
  } finally {
    f.close();
  }
});
test("outbound files are restricted, bounded and signature checked; rejected references become an explanatory reply", async () => {
  const f = fixture();
  try {
    f.c.media.enabled = true;
    const root = join(f.dir, "outbox");
    await mkdir(root);
    f.c.media.outboundRoots = [root];
    const file = join(root, "test.png");
    await writeFile(file, png);
    assert.equal((await readOutboundImage(file, f.c)).mime, "image/png");
    await assert.rejects(
      readOutboundImage(join(f.dir, "outside.png"), f.c),
      /outside/,
    );
    await symlink(file, join(root, "linked.png"));
    await assert.rejects(readOutboundImage(join(root, "linked.png"), f.c));
    await writeFile(join(root, "fake.png"), "not an image");
    await assert.rejects(
      readOutboundImage(join(root, "fake.png"), f.c),
      /unsupported/,
    );
    f.c.media.maxImageBytes = 2;
    await assert.rejects(readOutboundImage(file, f.c), /too-large/);
    const parts = await replyParts(
      `Caption\nTEAMS_IMAGE:${file}`,
      f.c,
      splitReply,
    );
    assert.equal(parts[0], "Caption");
    assert.match(String(parts[1]), /could not attach/);
    assert.throws(() => imageMime(Buffer.from("<svg></svg>")), /unsupported/);
  } finally {
    f.close();
  }
});
test("image turn downloads authorized AMS bytes, passes OpenClaw image parts, persists output bytes and sends the attachment once", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let invokes = 0,
    creates = 0,
    uploads = 0,
    imageSends = 0;
  const server = createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    for await (const chunk of req) body = Buffer.concat([body, chunk]);
    if (req.method === "GET") {
      assert.equal(req.headers.authorization, "skype_token synthetic");
      res.setHeader("Content-Type", "image/png");
      res.end(png);
      return;
    }
    if (req.url === "/v1/chat/completions") {
      invokes++;
      const input = JSON.parse(body.toString());
      assert.equal(
        JSON.parse(input.messages[1].content[0].text).text,
        "/REPORT STATUS\n\nRead the report skill and export its chart for Teams.",
      );
      assert.equal(
        input.messages[1].content[1].image_url.url,
        `data:image/png;base64,${png.toString("base64")}`,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `Image reply\nTEAMS_IMAGE:${join(f.dir, "outbox", "result.png")}`,
              },
            },
          ],
        }),
      );
      return;
    }
    if (req.method === "PUT") {
      assert.equal(req.headers.authorization, "Bearer synthetic-ams");
      assert.deepEqual(body, png);
      uploads++;
      res.writeHead(204);
      res.end();
      return;
    }
    const input = JSON.parse(body.toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/objects/") {
      creates++;
      assert.equal(req.headers.authorization, "Bearer synthetic-ams");
      assert.deepEqual(input.permissions, { [group]: ["read"] });
      res.end(JSON.stringify({ id: "uploaded-id" }));
      return;
    }
    if (input.content.includes("<img")) {
      imageSends++;
      assert.match(input.content, /uploaded-id/);
    }
    res.end(JSON.stringify({ OriginalArrivalTime: Date.now() }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    globalThis.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.hostname.endsWith("teams.microsoft.com"))
        return original(
          `http://127.0.0.1:${port}${u.pathname}${u.search}`,
          init,
        );
      return original(url, init);
    };
    f.c.media.enabled = true;
    f.c.commandInstructions = {
      "/report status": "Read the report skill and export its chart for Teams.",
    };
    f.c.media.outboundRoots = [join(f.dir, "outbox")];
    await mkdir(f.c.media.outboundRoots[0]!);
    const output = join(f.dir, "outbox", "result.png");
    await writeFile(output, png);
    f.c.openclaw.url = `http://127.0.0.1:${port}/v1/chat/completions`;
    await writeFile(
      f.c.openclaw.secretFile,
      JSON.stringify({ token: "synthetic-gateway" }),
      { mode: 0o600 },
    );
    enqueue(f, group, "group", {
      ...message("image"),
      text: "!claw /REPORT STATUS",
      images: ["incoming-id"],
    });
    const teams = new Teams(
      { skypeToken: "synthetic", region: "emea", amsToken: "synthetic-ams" },
      new Scheduler(60, 1),
      2000,
    );
    await work(f.c, f.s, teams, invoke);
    assert.equal(
      f.s.get("SELECT kind FROM parts WHERE kind='image'")?.kind,
      "image",
    );
    await writeFile(output, "changed after response saved");
    while (f.s.job()) await work(f.c, f.s, teams, invoke);
    f.s.recover();
    await work(f.c, f.s, teams, invoke);
    assert.equal(invokes, 1);
    assert.equal(creates, 1);
    assert.equal(uploads, 1);
    assert.equal(imageSends, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "sent");
  } finally {
    globalThis.fetch = original;
    server.close();
    await once(server, "close");
    f.close();
  }
});
test("ambiguous image send pauses without recreating or re-invoking; missing media authentication preserves saved output", async () => {
  const f = fixture();
  try {
    f.c.media.enabled = true;
    enqueue(f);
    f.s.response(1, [{ image: png.toString("base64"), mime: "image/png" }]);
    let creates = 0,
      sends = 0;
    const teams = {
      media: () => ({
        create: async () => {
          creates++;
          return "object";
        },
        upload: async () => {},
      }),
      sendImage: async () => {
        sends++;
        throw new TransportError("uncertain", 0, true);
      },
    } as unknown as Teams;
    await work(f.c, f.s, teams);
    f.s.recover();
    await work(f.c, f.s, teams);
    assert.equal(creates, 1);
    assert.equal(sends, 1);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "uncertain");
  } finally {
    f.close();
  }
});

test("missing image-upload credentials preserve saved bytes for renewal without re-invocation", async () => {
  const f = fixture();
  try {
    f.c.media.enabled = true;
    enqueue(f);
    f.s.response(1, [{ image: png.toString("base64"), mime: "image/png" }]);
    const teams = new Teams(
      { skypeToken: "synthetic", region: "emea" },
      new Scheduler(60, 1),
      1000,
    );
    let invoked = false;
    await work(f.c, f.s, teams, async () => {
      invoked = true;
      return "unexpected";
    });
    assert.equal(invoked, false);
    assert.equal(f.s.get("SELECT status FROM jobs")?.status, "response_ready");
    assert.equal(f.s.get("SELECT status FROM parts")?.status, "ready");
    assert.equal(
      f.s.get("SELECT value FROM meta WHERE key='auth'")?.value,
      "needs-login",
    );
    assert.equal(
      JSON.parse(String(f.s.get("SELECT body FROM parts")?.body)).image,
      png.toString("base64"),
    );
  } finally {
    f.close();
  }
});

test("media download limits and redirects cannot forward Teams credentials to another host", async () => {
  const original = globalThis.fetch;
  const teams = new Teams(
    { skypeToken: "synthetic", region: "emea" },
    new Scheduler(60, 1),
    1000,
  );
  try {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(
        new URL(String(url)).hostname,
        "as-prod.asyncgw.teams.microsoft.com",
      );
      assert.equal(init?.redirect, "error");
      if (calls === 1) return new Response(png);
      throw Error("redirect disallowed");
    };
    await assert.rejects(
      teams.media(2).download("safe"),
      (e: unknown) =>
        e instanceof TransportError && e.category === "image-too-large",
    );
    await assert.rejects(
      teams.media(1024).download("safe"),
      (e: unknown) =>
        e instanceof TransportError && e.category === "transient-read",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("returning a received image uses only current-turn bytes and rejects missing input references", async () => {
  const f = fixture();
  try {
    f.c.media.enabled = true;
    const input = `data:image/png;base64,${png.toString("base64")}`;
    const parts = await replyParts(
      "Here it is.\nTEAMS_IMAGE:input:1",
      f.c,
      splitReply,
      [input],
    );
    assert.equal(parts[0], "Here it is.");
    assert.deepEqual(parts[1], {
      image: png.toString("base64"),
      mime: "image/png",
    });
    const unavailable = await replyParts(
      "TEAMS_IMAGE:input:2",
      f.c,
      splitReply,
      [input],
    );
    assert.match(String(unavailable[0]), /could not attach/);
  } finally {
    f.close();
  }
});
