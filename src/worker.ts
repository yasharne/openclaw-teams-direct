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
  if (!stillAllowed(c, chat, kind, sender)) {
    store.state(id, "canceled");
    return;
  }
  let phase = String(job.status);
  try {
    if (phase === "queued") {
      store.start(id, "invoking");
      phase = "invoking";
      const response = await invokeFn(
        c,
        chat,
        kind,
        sender,
        String(job.body),
        Number(
          store.get("SELECT generation FROM chats WHERE id=?", chat)
            ?.generation ?? 0,
        ),
      );
      store.response(id, splitReply(response, c.replyCharacters));
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
    const confirmed = await teams.send(
      chat,
      part.body,
      String(store.nextPart(id)?.client_id),
    );
    store.sentPart(id, Number(part.part), confirmed);
  } catch (e) {
    if (e instanceof TransportError && !e.uncertain) {
      if (e.category === "needs-login" && phase === "sending") {
        store.meta("auth", "needs-login");
        store.run(
          "UPDATE parts SET status='ready' WHERE job=? AND status='sending'",
          id,
        );
        store.state(id, "response_ready");
        return;
      }
      if (e.category === "throttled" && Number(job.attempts) < 5) {
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
