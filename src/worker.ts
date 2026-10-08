import { replyParts, type ImagePart } from "./media.js";
import { withTyping } from "./typing.js";
import { acknowledge } from "./acknowledge.js";
import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Teams, TransportError } from "./http.js";
import { invoke } from "./openclaw.js";
import { stillAllowed, splitReply } from "./policy.js";
export async function work(
  c: Config,
  store: Store,
  teams: Teams,
  invokeFn = invoke,
) {
  const job = store.job();
  if (!job) return;
  const id = Number(job.id),
    chat = String(job.chat),
    kind = String(job.kind),
    sender = String(job.sender);
  if (
    !(kind === "outbound"
      ? c.outbound.enabled && c.outbound.targets[sender] === chat
      : stillAllowed(c, chat, kind, sender))
  ) {
    store.state(id, "canceled");
    return;
  }
  let phase = String(job.status);
  try {
    if (phase === "queued") {
      if (!(await acknowledge(c, store, teams, job))) return;
      const refs = JSON.parse(String(job.image_refs ?? "[]")) as string[];
      if (refs.length && !c.media.enabled) {
        store.response(id, ["Image support is currently disabled."]);
        return;
      }
      const images: string[] = [];
      if (refs.length > c.media.maxImages) {
        store.response(id, ["Please send fewer images in one message."]);
        return;
      }
      let imageBytes = 0;
      for (const ref of refs) {
        const image = await teams.media(c.media.maxImageBytes).download(ref);
        imageBytes += Buffer.from(image.split(",")[1]!, "base64").length;
        if (imageBytes > 10485760) {
          store.response(id, [
            "Please send smaller images (10 MB total maximum).",
          ]);
          return;
        }
        images.push(image);
      }
      store.start(id, "invoking");
      phase = "invoking";
      const response = await withTyping(c.typingIndicator, teams, chat, () =>
        invokeFn(
          c,
          chat,
          kind,
          sender,
          String(job.body),
          Number(
            store.get("SELECT generation FROM chats WHERE id=?", chat)
              ?.generation ?? 0,
          ),
          images,
        ),
      );
      store.response(id, await replyParts(response, c, splitReply, images));
      return;
    }
    const part = store.nextPart(id);
    if (!part) {
      store.state(id, "sent");
      return;
    }
    if (typeof part.body !== "string")
      throw new TransportError("expired-payload");
    // Persist sending before submission. Crash/timeout cannot imply cancellation.
    store.startPart(id, Number(part.part), String(Date.now()));
    phase = "sending";
    let confirmed: string;
    if (part.kind === "image") {
      if (!c.media.enabled) {
        store.state(id, "canceled");
        return;
      }
      const image = JSON.parse(part.body) as ImagePart;
      const media = teams.media(c.media.maxImageBytes);
      let object = typeof part.ams_id === "string" ? part.ams_id : undefined;
      if (!object) {
        object = await media.create(chat, image.mime);
        store.run(
          "UPDATE parts SET ams_id=? WHERE job=? AND part=?",
          object,
          id,
          Number(part.part),
        );
      }
      await media.upload(object, image);
      confirmed = await teams.sendImage(
        chat,
        object,
        String(store.nextPart(id)?.client_id),
        image.caption,
      );
    } else
      confirmed = await teams.send(
        chat,
        part.body,
        String(store.nextPart(id)?.client_id),
      );
    store.sentPart(id, Number(part.part), confirmed);
  } catch (e) {
    if (e instanceof TransportError && !e.uncertain) {
      if (
        e.category === "needs-login" &&
        ["sending", "queued"].includes(phase)
      ) {
        store.meta("auth", "needs-login");
        store.run(
          "UPDATE parts SET status='ready' WHERE job=? AND status='sending'",
          id,
        );
        store.state(id, phase === "sending" ? "response_ready" : "queued");
        return;
      }
      if (
        (e.category === "throttled" ||
          (phase === "queued" && e.category === "transient-read")) &&
        Number(job.attempts) < 5
      ) {
        if (phase === "sending")
          store.run(
            "UPDATE parts SET status='ready' WHERE job=? AND status='sending'",
            id,
          );
        store.defer(
          id,
          phase === "sending" ? "response_ready" : "queued",
          Math.max(
            e.retryAfterMs,
            Math.min(60000, 1000 * 2 ** Number(job.attempts)),
          ),
        );
        return;
      }
      if (
        phase === "queued" &&
        [
          "image-too-large",
          "image-unavailable",
          "unsupported-image-format",
        ].includes(e.category)
      ) {
        store.response(id, [
          "I could not read the image. Please send a PNG, JPEG, GIF or WebP image under the configured size limit.",
        ]);
        return;
      }
      store.fail(id, chat, "failed");
      return;
    }
    store.fail(
      id,
      chat,
      ["invoking", "sending"].includes(phase) ? "uncertain" : "failed",
    );
  }
}
