import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture, self, sender, other, group } from "./helpers.js";
import { Store } from "../src/store.js";
test("actual service routes new DM/group once, denies history/self/other/untriggered messages and shuts down cleanly", async () => {
  const f = fixture();
  f.s.close();
  const calls: { user: string; messages: { content: string }[] }[] = [];
  const replies: string[] = [];
  const anchor = Math.floor(Date.now() / 1000) * 1000;
  let child: ReturnType<typeof spawn> | undefined;
  const raw = (id: string, text: string, from: string, at = anchor + 5000) => ({
    id,
    messagetype: "Text",
    originalarrivaltime: new Date(at).toISOString(),
    from: "https://synthetic/contacts/" + from,
    content: text,
  });
  const dm = "19:synthetic@unq.gbl.spaces";
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Date", new Date(anchor).toUTCString());
    const path = decodeURIComponent(
      new URL(req.url ?? "/", "http://localhost").pathname,
    );
    if (path === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    if (path === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      calls.push(input);
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "synthetic reply" } }],
        }),
      );
      return;
    }
    if (path.endsWith("/properties")) {
      res.end(JSON.stringify({ skypeName: self.slice(2) }));
      return;
    }
    if (path.endsWith("/members")) {
      res.end(
        JSON.stringify({
          members: [
            { id: self, userDisplayName: "Synthetic Bridge" },
            { id: sender },
          ],
        }),
      );
      return;
    }
    if (path.endsWith("/conversations")) {
      res.end(JSON.stringify({ conversations: [{ id: dm }, { id: group }] }));
      return;
    }
    if (path.endsWith("/messages") && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      assert.equal(input.content, "<p>synthetic reply</p>");
      assert.equal(input.messagetype, "RichText/Html");
      assert.ok(input.clientmessageid);
      assert.equal(input.imdisplayname, "Synthetic Bridge");
      replies.push(path);
      res.end(
        JSON.stringify({ OriginalArrivalTime: Date.now() + replies.length }),
      );
      if (replies.length === 2) setTimeout(() => child?.kill("SIGINT"), 50);
      return;
    }
    if (path.endsWith("/messages")) {
      res.end(
        JSON.stringify({
          messages: path.includes(dm)
            ? [
                raw("dm-new", "DM live", sender),
                raw("dm-old", "old", sender, anchor - 10000),
                raw("dm-denied", "denied", other),
                raw("dm-self", "self", self),
              ]
            : [
                raw("group-new", "!claw GROUP live", sender),
                raw("group-no-trigger", "ignore", sender),
                raw("group-denied", "!claw denied", other),
              ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  f.c.openclaw.url = `http://127.0.0.1:${port}/v1/chat/completions`;
  f.c.pollMs = 1000;
  const config = join(f.dir, "config.local.json");
  await writeFile(config, JSON.stringify(f.c), { mode: 0o600 });
  await writeFile(
    join(f.dir, "credentials.json"),
    JSON.stringify({ region: "apac", skypeToken: "synthetic-token" }),
    { mode: 0o600 },
  );
  await writeFile(
    f.c.openclaw.secretFile,
    JSON.stringify({ token: "synthetic-gateway-token" }),
    { mode: 0o600 },
  );
  const module = new URL("../src/runner.js", import.meta.url).href;
  // The Teams adapter validates real URLs, then the harness redirects only the
  // network destination to a real local HTTP server. Request headers/body remain.
  const code = `import {run} from ${JSON.stringify(module)};const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const u=new URL(String(input));if(u.hostname.endsWith('.ng.msg.teams.microsoft.com'))return original('http://127.0.0.1:${port}'+u.pathname+u.search,options);return original(input,options)};await run(${JSON.stringify(config)});`;
  let output = "";
  child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  const watchdog = setTimeout(() => child?.kill("SIGKILL"), 10000);
  try {
    const [exit] = await once(child, "exit");
    assert.equal(exit, 0, output);
    assert.equal(calls.length, 2);
    assert.equal(replies.length, 2);
    assert.notEqual(calls[0]?.user, calls[1]?.user);
    assert.deepEqual(
      calls.map((c) => JSON.parse(c.messages[0]!.content).text).sort(),
      ["DM live", "GROUP live"],
    );
    assert.ok(
      calls.every((c) => JSON.parse(c.messages[0]!.content).sender === sender),
    );
    assert.ok(!output.includes("synthetic-token"));
    const s = new Store(f.file, self);
    try {
      assert.equal(s.all("SELECT * FROM jobs WHERE status='sent'").length, 2);
      assert.equal(
        s.get("SELECT value FROM meta WHERE key=?", "lease"),
        undefined,
      );
    } finally {
      s.close();
    }
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(f.dir, { recursive: true, force: true });
  }
});
