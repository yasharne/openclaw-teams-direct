import { createServer } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { replyParts } from "./media.js";
import { splitReply } from "./policy.js";

export async function enqueueOutbound(c: Config, s: Store, raw: unknown) {
  if (!c.outbound.enabled) throw Error("outbound-disabled");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("invalid-outbound-request");
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) => !["target", "text", "images", "id"].includes(k),
    ) ||
    typeof r.target !== "string" ||
    typeof r.id !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(r.id) ||
    typeof r.text !== "string" ||
    r.text.length > 100000 ||
    (r.images !== undefined &&
      (!Array.isArray(r.images) ||
        r.images.length > c.media.maxImages ||
        r.images.some(
          (p) =>
            typeof p !== "string" || !p.startsWith("/") || /[\r\n]/.test(p),
        ))) ||
    (!r.text.trim() && !(r.images as unknown[] | undefined)?.length)
  )
    throw Error("invalid-outbound-request");
  const chat = Object.hasOwn(c.outbound.targets, r.target)
    ? c.outbound.targets[r.target]!
    : undefined;
  if (!chat) throw Error("outbound-target-not-allowed");
  const messageId = `outbound:${r.target}:${r.id}`;
  const existing = s.get(
    "SELECT id,status FROM jobs WHERE chat=? AND message_id=?",
    chat,
    messageId,
  );
  if (existing)
    return {
      job: Number(existing.id),
      status: String(existing.status),
      duplicate: true,
    };
  if (s.pending() >= c.maxQueue) throw Error("outbound-queue-full");
  const images = (r.images ?? []) as string[];
  if (images.length && !c.media.enabled)
    throw Error("outbound-images-disabled");
  // Callers cannot smuggle transport markers in text. Only explicit image paths are accepted.
  if (/^TEAMS_IMAGE:/m.test(r.text)) throw Error("outbound-use-image-option");
  const parts = await replyParts(
    r.text + images.map((p) => `\nTEAMS_IMAGE:${p}`).join(""),
    c,
    splitReply,
  );
  if (
    images.length &&
    parts.filter((p) => typeof p !== "string").length !== images.length
  )
    throw Error("outbound-image-unavailable");
  return s.tx(() => {
    const duplicate = s.get(
      "SELECT id,status FROM jobs WHERE chat=? AND message_id=?",
      chat,
      messageId,
    );
    if (duplicate)
      return {
        job: Number(duplicate.id),
        status: String(duplicate.status),
        duplicate: true,
      };
    if (s.pending() >= c.maxQueue) throw Error("outbound-queue-full");
    s.addChat(chat, "outbound", Date.now());
    s.run(
      "INSERT INTO jobs(chat,kind,message_id,sender,body,status,created,updated) VALUES(?,'outbound',?,?,?,'response_ready',?,?)",
      chat,
      messageId,
      r.target as string,
      r.text as string,
      Date.now(),
      Date.now(),
    );
    const id = Number(
      s.get(
        "SELECT id FROM jobs WHERE chat=? AND message_id=?",
        chat,
        messageId,
      )!.id,
    );
    s.response(id, parts);
    return { job: id, status: "response_ready", duplicate: false };
  });
}

export async function listenOutbound(config: () => Config, store: Store) {
  const c = config(),
    path = c.outbound.socketPath;
  if (!c.outbound.enabled) return undefined;
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o022
  )
    throw Error("unsafe-outbound-socket-directory");
  try {
    const old = await lstat(path);
    if (!old.isSocket() || old.uid !== process.getuid?.())
      throw Error("unsafe-outbound-socket");
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    try {
      if (req.method !== "POST" || req.url !== "/send") {
        res.writeHead(404).end("{}");
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 524288) {
          res.writeHead(413).end("{}");
          req.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const result = await enqueueOutbound(
        config(),
        store,
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      res.writeHead(202).end(JSON.stringify(result));
    } catch (e) {
      const category =
        e instanceof Error && /^[a-z-]+$/.test(e.message)
          ? e.message
          : "outbound-request-failed";
      res.writeHead(400).end(JSON.stringify({ error: category }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o660);
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}
