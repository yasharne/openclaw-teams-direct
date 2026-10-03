import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { loadConfig, type Config } from "./config.js";
import { safeDirectory, protectedRead } from "./credentials.js";
import { Scheduler, Teams, TransportError, type Token } from "./http.js";
import { Store } from "./store.js";
import { normalize, allowedDM } from "./policy.js";
import { verifyGateway } from "./openclaw.js";
import { work } from "./worker.js";
const event = (name: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event: name, ...extra }));
export async function openStore(c: Config) {
  process.umask(0o077);
  await safeDirectory(c.stateDir, true);
  const file = join(c.stateDir, "bridge.sqlite");
  try {
    const s = await lstat(file);
    if (
      s.isSymbolicLink() ||
      !s.isFile() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid?.()
    )
      throw new Error("unsafe-database");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const store = new Store(file, c.accountId);
  const connection = JSON.stringify({
    namespace: c.namespace,
    url: c.openclaw.url,
    agent: c.openclaw.agent,
  });
  const existing = store.get(
    "SELECT value FROM meta WHERE key=?",
    "connection",
  );
  if (existing && existing.value !== connection) {
    store.close();
    throw new Error("connection-changed-use-new-state-directory");
  }
  store.meta("connection", connection);
  return store;
}
export async function run(file: string) {
  let c = await loadConfig(file, true);
  const store = await openStore(c);
  store.lease();
  store.recover();
  const scheduler = new Scheduler(c.requestsPerMinute, c.maxInFlight);
  let stop = false;
  const shutdown = () => {
    stop = true;
    scheduler.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const failures = new Map<string, number>();
  let pollIndex = 0,
    nextDiscovery = 0,
    lastCleanup = 0;
  try {
    const token = (await protectedRead(
      join(c.stateDir, "credentials.json"),
    )) as Token;
    const teams = new Teams(token, scheduler, c.requestTimeoutMs);
    const identity = await teams.identity();
    if (identity.id !== c.accountId) throw new Error("login-account-mismatch");
    const cutoff = Date.parse(identity.date ?? "");
    if (!Number.isFinite(cutoff)) throw new Error("missing-service-clock");
    store.meta("auth", "ready");
    for (const g of c.groups) {
      store.addChat(g.id, "group", cutoff);
      try {
        if (!(await teams.members(g.id)).some((m) => m.id === c.accountId))
          store.pause(g.id, "access-denied");
      } catch (e) {
        if (e instanceof TransportError && e.category === "needs-login")
          throw e;
        store.pause(g.id, "group-access-check");
      }
    }
    await verifyGateway(c);
    event("ready", {
      groups: c.groups.length,
      dmSenders: c.dmSenders.length,
      everywhereSenders: c.everywhereSenders.length,
    });
    while (!stop) {
      const fresh = await loadConfig(file, true);
      if (
        fresh.namespace !== c.namespace ||
        fresh.accountId !== c.accountId ||
        fresh.stateDir !== c.stateDir ||
        fresh.requestsPerMinute !== c.requestsPerMinute ||
        fresh.maxInFlight !== c.maxInFlight ||
        fresh.requestTimeoutMs !== c.requestTimeoutMs ||
        JSON.stringify(fresh.openclaw) !== JSON.stringify(c.openclaw)
      )
        throw new Error("restart-required-for-connection-change");
      const added = fresh.groups.filter(
        (g) => !store.get("SELECT id FROM chats WHERE id=?", g.id),
      );
      for (const g of added) {
        const clock = await teams.identity();
        const at = Date.parse(clock.date ?? "");
        if (clock.id !== fresh.accountId || !Number.isFinite(at))
          throw new TransportError("invalid-identity");
        store.addChat(g.id, "group", at);
        if (!(await teams.members(g.id)).some((m) => m.id === fresh.accountId))
          store.pause(g.id, "access-denied");
      }
      c = fresh;
      if (Date.now() >= nextDiscovery && store.pending() < c.maxQueue) {
        try {
          const link = String(
            store.get("SELECT value FROM meta WHERE key=?", "discovery-link")
              ?.value ?? "",
          );
          let discoveryCutoff = store.get(
            "SELECT value FROM meta WHERE key=?",
            "discovery-cutoff",
          )?.value;
          if (!discoveryCutoff) {
            const clock = await teams.identity();
            const at = Date.parse(clock.date ?? "");
            if (clock.id !== c.accountId || !Number.isFinite(at))
              throw new TransportError("invalid-identity");
            discoveryCutoff = String(at);
            store.meta("discovery-cutoff", discoveryCutoff);
          }
          const visited = JSON.parse(
            String(
              store.get(
                "SELECT value FROM meta WHERE key=?",
                "discovery-visited",
              )?.value ?? "[]",
            ),
          ) as string[];
          if (visited.includes(link || "first-page") || visited.length >= 100)
            throw new TransportError("discovery-history-gap");
          const page = await teams.conversations(link || undefined);
          for (const chat of page.conversations) {
            if (typeof chat.id !== "string" || !chat.id.startsWith("19:"))
              throw new TransportError("malformed-conversation");
            if (store.get("SELECT id FROM chats WHERE id=?", chat.id)) continue;
            const isGroup = chat.id.endsWith("@thread.v2");
            if (
              !chat.id.endsWith("@unq.gbl.spaces") &&
              !(isGroup && c.everywhereSenders.length)
            )
              continue;
            const members = await teams.members(chat.id);
            if (isGroup) {
              if (
                members.some((m) => m.id === c.accountId) &&
                members.some((m) => c.everywhereSenders.includes(m.id))
              )
                store.addChat(chat.id, "group", Number(discoveryCutoff));
              continue;
            }
            if (
              members.length !== 2 ||
              !members.some((m) => m.id === c.accountId) ||
              !members.some((m) => allowedDM(c, m.id))
            )
              continue;
            store.addChat(chat.id, "dm", Number(discoveryCutoff));
          }
          if (page.next) {
            if (page.next === link)
              throw new TransportError("pagination-cycle");
            teams.url(page.next);
            store.meta(
              "discovery-visited",
              JSON.stringify([...visited, link || "first-page"]),
            );
            store.meta("discovery-link", page.next);
            nextDiscovery = Date.now() + 1000;
          } else {
            store.run(
              "DELETE FROM meta WHERE key IN ('discovery-link','discovery-visited','discovery-cutoff')",
            );
            nextDiscovery = Date.now() + c.discoveryMs;
          }
        } catch (e) {
          if (e instanceof TransportError && e.category === "needs-login")
            throw e;
          event("discovery-deferred");
          nextDiscovery = Date.now() + c.discoveryMs;
        }
      }
      const eligible = store
        .all("SELECT * FROM chats WHERE reason IS NULL ORDER BY id")
        .filter(
          (r) =>
            r.kind === "dm" ||
            c.groups.some((g) => g.id === r.id) ||
            (c.everywhereSenders.length > 0 &&
              String(r.id).endsWith("@thread.v2")),
        );
      if (eligible.length && store.pending() < c.maxQueue) {
        const chat = eligible[pollIndex++ % eligible.length]!;
        const id = String(chat.id);
        if (Date.now() - Number(chat.last_poll ?? 0) >= c.pollMs) {
          try {
            if (chat.scan_done) store.finish(id, c);
            else
              for (let n = 0; n < c.maxPagesPerTurn; n++) {
                const current = store.get(
                  "SELECT * FROM chats WHERE id=?",
                  id,
                )!;
                const link = current.link ? String(current.link) : undefined;
                const page = await teams.messages(id, link);
                const messages = page.messages.map(normalize);
                store.page(id, messages, page.next, c, link ?? "first-page");
                const after = store.get("SELECT * FROM chats WHERE id=?", id)!;
                if (!after.link) break;
              }
            failures.delete(id);
          } catch (e) {
            if (e instanceof TransportError && e.category === "needs-login")
              throw e;
            if (
              e instanceof TransportError &&
              ["throttled", "transient-read", "stopped"].includes(e.category)
            ) {
              const attempts = (failures.get(id) ?? 0) + 1;
              failures.set(id, attempts);
              store.run(
                "UPDATE chats SET last_poll=? WHERE id=?",
                Date.now() + Math.min(60000, 1000 * 2 ** attempts),
                id,
              );
              if (attempts >= 5) store.pause(id, "read-retries-exhausted");
            } else {
              store.pause(
                id,
                e instanceof TransportError
                  ? e.category
                  : e instanceof Error && /^[a-z][a-z0-9-]+$/.test(e.message)
                    ? e.message
                    : "storage-error",
              );
              event("chat-paused");
            }
          }
        }
      }
      await work(c, store, teams);
      if (
        store.get("SELECT value FROM meta WHERE key=?", "auth")?.value ===
        "needs-login"
      )
        throw new TransportError("needs-login");
      if (Date.now() - lastCleanup >= 60000) {
        store.cleanup(c);
        lastCleanup = Date.now();
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    if (e instanceof TransportError && e.category === "needs-login") {
      store.meta("auth", "needs-login");
      event("needs-login");
      process.exitCode = 42;
    } else if (!stop) {
      event("stopped", { category: "configuration-storage-or-transport" });
      process.exitCode = 1;
    }
  } finally {
    store.release();
    store.close();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}
