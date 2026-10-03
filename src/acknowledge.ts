import type { Config } from "./config.js";
import { Store } from "./store.js";
import { Teams, TransportError } from "./http.js";
/** Cosmetic acknowledgement failures must never imply a failed agent turn. */
export async function acknowledge(
  c: Config,
  store: Store,
  teams: Teams,
  job: Record<string, string | number | null>,
): Promise<boolean> {
  if (!c.markRead && !c.acknowledgementReaction) return true;
  const id = Number(job.id),
    chat = String(job.chat),
    message = String(job.message_id);
  store.run(
    "INSERT OR IGNORE INTO acknowledgements(job,client_id) VALUES(?,?)",
    id,
    message,
  );
  for (const field of ["reaction_state", "read_state"] as const) {
    if (field === "reaction_state" ? !c.acknowledgementReaction : !c.markRead)
      continue;
    const row = store.get("SELECT * FROM acknowledgements WHERE job=?", id)!;
    if (row[field] !== "pending") continue;
    store.run(`UPDATE acknowledgements SET ${field}='sending' WHERE job=?`, id);
    try {
      if (field === "reaction_state")
        await teams.react(chat, message, c.acknowledgementReaction);
      else
        await teams.markRead(chat, message, String(row.client_id ?? message));
      store.run(`UPDATE acknowledgements SET ${field}='done' WHERE job=?`, id);
    } catch (e) {
      if (e instanceof TransportError && e.category === "needs-login") {
        store.run(
          `UPDATE acknowledgements SET ${field}='pending' WHERE job=?`,
          id,
        );
        store.meta("auth", "needs-login");
        return false;
      }
      if (
        e instanceof TransportError &&
        e.category === "throttled" &&
        Number(job.attempts) < 5
      ) {
        store.run(
          `UPDATE acknowledgements SET ${field}='pending' WHERE job=?`,
          id,
        );
        store.defer(
          id,
          "queued",
          Math.max(
            e.retryAfterMs,
            Math.min(60000, 1000 * 2 ** Number(job.attempts)),
          ),
        );
        return false;
      }
      const state =
        e instanceof TransportError && e.uncertain ? "uncertain" : "failed";
      store.run(
        `UPDATE acknowledgements SET ${field}=? WHERE job=?`,
        state,
        id,
      );
      console.log(
        JSON.stringify({
          event: "acknowledgement-unconfirmed",
          operation: field,
          state,
        }),
      );
    }
  }
  return true;
}
