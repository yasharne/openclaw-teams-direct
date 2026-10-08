import type { ImagePart } from "./media.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { Config } from "./config.js";
import { promptFor, type Message } from "./policy.js";
function processIdentity(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return {
      boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    };
  } catch {
    return { boot: undefined, start: undefined };
  }
}
type Row = Record<string, string | number | null>;
export class Store {
  db: DatabaseSync;
  private depth = 0;
  constructor(file: string, account: string) {
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,kind TEXT NOT NULL,cursor INTEGER NOT NULL,link TEXT,scan_done INTEGER NOT NULL DEFAULT 0,reason TEXT,last_poll INTEGER,generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS scan(chat TEXT NOT NULL,id TEXT NOT NULL,arrival INTEGER NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(chat,id));
      CREATE TABLE IF NOT EXISTS scan_links(chat TEXT NOT NULL,link TEXT NOT NULL,PRIMARY KEY(chat,link));
      CREATE TABLE IF NOT EXISTS seen(chat TEXT NOT NULL,id TEXT NOT NULL,arrival INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(chat,id));
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,chat TEXT NOT NULL,kind TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,body TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(chat,message_id));
      CREATE TABLE IF NOT EXISTS acknowledgements(job INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,client_id TEXT,read_state TEXT NOT NULL DEFAULT 'pending',reaction_state TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS jobs_chat_order ON jobs(chat,id,status);
      CREATE INDEX IF NOT EXISTS jobs_work ON jobs(status,next_at,chat,id);
      CREATE TABLE IF NOT EXISTS parts(job INTEGER NOT NULL REFERENCES jobs(id),part INTEGER NOT NULL,body TEXT,status TEXT NOT NULL,client_id TEXT,message_id TEXT,PRIMARY KEY(job,part));`);
    for (const [table, column, definition] of [
      ["jobs", "image_refs", "TEXT"],
      ["parts", "kind", "TEXT NOT NULL DEFAULT 'text'"],
      ["parts", "ams_id", "TEXT"],
    ]) {
      if (
        !this.all(`PRAGMA table_info(${table})`).some((r) => r.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
    );
    if (version > 1) throw new Error("unsupported-state-version");
    this.db.exec("PRAGMA user_version=1");
    const old = this.get("SELECT value FROM meta WHERE key=?", "account");
    if (old && old.value !== account) throw new Error("state-account-mismatch");
    this.meta("account", account);
  }
  private bindings(p: (string | number | null | undefined)[]) {
    return p.map((v) => {
      if (v === undefined) throw new Error("missing-sql-binding");
      return v;
    });
  }
  get(sql: string, ...p: (string | number | null | undefined)[]) {
    return this.db.prepare(sql).get(...this.bindings(p)) as Row | undefined;
  }
  all(sql: string, ...p: (string | number | null | undefined)[]) {
    return this.db.prepare(sql).all(...this.bindings(p)) as Row[];
  }
  run(sql: string, ...p: (string | number | null | undefined)[]) {
    return this.db.prepare(sql).run(...this.bindings(p));
  }
  tx<T>(f: () => T) {
    if (this.depth) return f();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = f();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  meta(key: string, value: string) {
    this.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  lease() {
    this.tx(() => {
      const row = this.get("SELECT value FROM meta WHERE key=?", "lease");
      if (row) {
        const l = JSON.parse(String(row.value)) as {
          pid: number;
          host: string;
          boot?: string;
          start?: string;
        };
        if (l.host !== hostname()) throw new Error("state-host-mismatch");
        const current = processIdentity(l.pid);
        const reused =
          Boolean(l.boot && current.boot && l.boot !== current.boot) ||
          Boolean(l.start && current.start && l.start !== current.start);
        try {
          if (reused)
            throw Object.assign(new Error("stale-process"), { code: "ESRCH" });
          process.kill(l.pid, 0);
          throw new Error("already-running");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
      this.meta(
        "lease",
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          ...processIdentity(process.pid),
        }),
      );
    });
  }
  release() {
    const row = this.get("SELECT value FROM meta WHERE key=?", "lease");
    if (row && JSON.parse(String(row.value)).pid === process.pid)
      this.run("DELETE FROM meta WHERE key=?", "lease");
  }
  recover() {
    this.tx(() => {
      this.run(
        "UPDATE acknowledgements SET read_state='uncertain' WHERE read_state='sending'",
      );
      this.run(
        "UPDATE acknowledgements SET reaction_state='uncertain' WHERE reaction_state='sending'",
      );
      this.run(
        "UPDATE chats SET reason='uncertain' WHERE id IN (SELECT chat FROM jobs WHERE status IN ('invoking','sending'))",
      );
      this.run(
        "UPDATE jobs SET status='uncertain',updated=? WHERE status IN ('invoking','sending')",
        Date.now(),
      );
    });
  }
  addChat(id: string, kind: string, cutoff: number) {
    this.run(
      "INSERT OR IGNORE INTO chats(id,kind,cursor) VALUES(?,?,?)",
      id,
      kind,
      cutoff,
    );
  }
  pause(chat: string, reason: string) {
    this.run("UPDATE chats SET reason=? WHERE id=?", reason, chat);
  }
  page(
    chat: string,
    messages: Message[],
    next: string | null,
    c: Config,
    fetchedLink: string,
  ) {
    // Newest-first pages accumulate durably. Only a complete scan commits jobs
    // and advances the processing boundary; partial pages never advance it.
    this.tx(() => {
      const row = this.get("SELECT * FROM chats WHERE id=?", chat);
      if (!row) throw new Error("missing-chat");
      if (
        this.get(
          "SELECT link FROM scan_links WHERE chat=? AND link=?",
          chat,
          fetchedLink,
        )
      )
        throw new Error("pagination-cycle");
      this.run("INSERT INTO scan_links VALUES(?,?)", chat, fetchedLink);
      if (
        Number(
          this.get("SELECT COUNT(*) AS count FROM scan WHERE chat=?", chat)
            ?.count,
        ) +
          messages.length >
        c.maxScanMessages
      )
        throw new Error("scan-limit");
      let boundary = false;
      for (const m of messages) {
        if (m.arrival < Number(row.cursor)) {
          boundary = true;
          continue;
        }
        this.run(
          "INSERT OR IGNORE INTO scan VALUES(?,?,?,?,?)",
          chat,
          m.id,
          m.arrival,
          JSON.stringify(m),
          Date.now(),
        );
      }
      if (!next && !boundary) {
        const known = this.get(
          "SELECT id FROM seen WHERE chat=? AND arrival=? LIMIT 1",
          chat,
          row.cursor,
        );
        const found = this.get(
          "SELECT s.id FROM scan s JOIN seen d ON d.chat=s.chat AND d.id=s.id WHERE s.chat=? AND s.arrival=? LIMIT 1",
          chat,
          row.cursor,
        );
        if (known && !found) throw new Error("history-gap");
      }
      this.run(
        "UPDATE chats SET link=?,scan_done=?,last_poll=? WHERE id=?",
        boundary ? null : next,
        boundary || !next ? 1 : 0,
        Date.now(),
        chat,
      );
    });
    this.finish(chat, c);
  }
  finish(chat: string, c: Config) {
    this.tx(() => {
      const row = this.get("SELECT * FROM chats WHERE id=?", chat);
      if (!row?.scan_done) return;
      const records = this.all(
        "SELECT * FROM scan WHERE chat=? ORDER BY arrival,id",
        chat,
      );
      const fresh = records.filter(
        (r) =>
          !this.get("SELECT id FROM seen WHERE chat=? AND id=?", chat, r.id),
      );
      const accepted = fresh
        .map((r) => ({ r, m: JSON.parse(String(r.message)) as Message }))
        .map((x) => ({
          ...x,
          prompt: promptFor(c, chat, String(row.kind), x.m),
        }))
        .filter((x) => x.prompt !== null);
      if (this.pending() + accepted.length > c.maxQueue) return;
      const now = Date.now();
      for (const { m, prompt } of accepted) {
        this.run(
          "INSERT OR IGNORE INTO jobs(chat,kind,message_id,sender,body,status,created,updated) VALUES(?,?,?,?,?,'queued',?,?)",
          chat,
          String(row.kind),
          m.id,
          m.sender,
          prompt,
          now,
          now,
        );
        this.run(
          "UPDATE jobs SET image_refs=? WHERE chat=? AND message_id=?",
          JSON.stringify(c.media.enabled ? (m.images ?? []) : []),
          chat,
          m.id,
        );
        this.run(
          "INSERT OR IGNORE INTO acknowledgements(job,client_id,read_state,reaction_state) SELECT id,?,?,? FROM jobs WHERE chat=? AND message_id=?",
          m.clientId ?? m.id,
          c.markRead ? "pending" : "disabled",
          c.acknowledgementReaction ? "pending" : "disabled",
          chat,
          m.id,
        );
      }
      for (const r of fresh)
        this.run(
          "INSERT OR IGNORE INTO seen VALUES(?,?,?,?)",
          chat,
          r.id,
          r.arrival,
          now,
        );
      const cursor = Math.max(
        Number(row.cursor),
        ...records.map((r) => Number(r.arrival)),
      );
      this.run(
        "UPDATE chats SET cursor=?,link=NULL,scan_done=0 WHERE id=?",
        cursor,
        chat,
      );
      this.run("DELETE FROM scan WHERE chat=?", chat);
      this.run("DELETE FROM scan_links WHERE chat=?", chat);
    });
  }
  pending() {
    return Number(
      this.get(
        "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','invoking','response_ready','sending','uncertain')",
      )?.count ?? 0,
    );
  }
  job() {
    const candidates = this.all(
      "SELECT j.* FROM jobs j JOIN chats c ON c.id=j.chat WHERE c.reason IS NULL AND j.status IN ('queued','response_ready') AND j.next_at<=? AND j.id=(SELECT MIN(id) FROM jobs WHERE chat=j.chat AND status IN ('queued','invoking','response_ready','sending','uncertain','failed','expired')) ORDER BY j.chat",
      Date.now(),
    );
    const last = String(
      this.get("SELECT value FROM meta WHERE key=?", "last-worker-chat")
        ?.value ?? "",
    );
    return candidates.find((r) => String(r.chat) > last) ?? candidates[0];
  }
  state(id: number, status: string) {
    this.run(
      "UPDATE jobs SET status=?,updated=? WHERE id=?",
      status,
      Date.now(),
      id,
    );
  }
  start(id: number, status: string) {
    this.tx(() => {
      this.state(id, status);
      const j = this.get("SELECT chat FROM jobs WHERE id=?", id);
      this.meta("last-worker-chat", String(j?.chat));
    });
  }
  response(id: number, parts: (string | ImagePart)[]) {
    this.tx(() => {
      parts.forEach((p, i) =>
        this.run(
          "INSERT INTO parts(job,part,body,kind,status) VALUES(?,?,?,?,'ready')",
          id,
          i,
          typeof p === "string" ? p : JSON.stringify(p),
          typeof p === "string" ? "text" : "image",
        ),
      );
      this.state(id, "response_ready");
    });
  }
  nextPart(id: number) {
    return this.get(
      "SELECT * FROM parts WHERE job=? AND status!='sent' ORDER BY part LIMIT 1",
      id,
    );
  }
  startPart(id: number, part: number, client: string) {
    this.tx(() => {
      this.start(id, "sending");
      this.run(
        "UPDATE parts SET status='sending',client_id=? WHERE job=? AND part=?",
        client,
        id,
        part,
      );
    });
  }
  sentPart(id: number, part: number, message: string) {
    this.tx(() => {
      this.run(
        "UPDATE parts SET status='sent',message_id=? WHERE job=? AND part=?",
        message,
        id,
        part,
      );
      this.state(id, this.nextPart(id) ? "response_ready" : "sent");
    });
  }
  fail(id: number, chat: string, status: string) {
    this.tx(() => {
      this.state(id, status);
      this.pause(chat, status);
    });
  }
  defer(id: number, status: string, delay: number) {
    this.run(
      "UPDATE jobs SET status=?,attempts=attempts+1,next_at=?,updated=? WHERE id=?",
      status,
      Date.now() + delay,
      Date.now(),
      id,
    );
  }
  resolve(id: number, action: string, acceptRisk: boolean) {
    this.tx(() => {
      const j = this.get("SELECT * FROM jobs WHERE id=?", id);
      if (!j || !["uncertain", "failed", "expired"].includes(String(j.status)))
        throw new Error("job-not-resolvable");
      if (action === "retry") {
        if (!acceptRisk) throw new Error("explicit-duplicate-risk-required");
        if (j.status === "expired")
          throw new Error("expired-payload-cannot-retry");
        const hasParts = this.get(
          "SELECT part FROM parts WHERE job=? LIMIT 1",
          id,
        );
        if (
          (!hasParts && typeof j.body !== "string") ||
          this.get(
            "SELECT part FROM parts WHERE job=? AND status!='sent' AND body IS NULL LIMIT 1",
            id,
          )
        )
          throw new Error("expired-payload-cannot-retry");
        this.run(
          "UPDATE parts SET status='ready' WHERE job=? AND status='sending'",
          id,
        );
        this.state(id, hasParts ? "response_ready" : "queued");
        this.run("UPDATE jobs SET attempts=0,next_at=0 WHERE id=?", id);
      } else if (["complete", "cancel"].includes(action))
        this.state(id, action === "complete" ? "sent" : "canceled");
      else throw new Error("invalid-resolution");
      if (
        !this.get(
          "SELECT id FROM jobs WHERE chat=? AND status IN ('uncertain','failed','expired')",
          j.chat,
        )
      )
        this.run("UPDATE chats SET reason=NULL WHERE id=?", j.chat);
    });
  }
  cleanup(c: Config, now = Date.now()) {
    this.tx(() => {
      const pending = now - c.pendingRetentionDays * 86400000;
      const exp = this.all(
        "SELECT id,chat FROM jobs WHERE status IN ('queued','response_ready','uncertain') AND created<? LIMIT 100",
        pending,
      );
      for (const j of exp) {
        this.fail(Number(j.id), String(j.chat), "expired");
        this.run("UPDATE jobs SET body=NULL,image_refs=NULL WHERE id=?", j.id);
        this.run("UPDATE parts SET body=NULL WHERE job=?", j.id);
      }
      const completed = now - c.completedRetentionHours * 3600000;
      const done = this.all(
        "SELECT id FROM jobs WHERE status IN ('sent','failed','canceled','expired') AND updated<? AND body IS NOT NULL LIMIT 100",
        completed,
      );
      for (const j of done) {
        this.run("UPDATE jobs SET body=NULL,image_refs=NULL WHERE id=?", j.id);
        this.run("UPDATE parts SET body=NULL WHERE job=?", j.id);
      }
      this.run(
        "DELETE FROM seen WHERE rowid IN (SELECT s.rowid FROM seen s JOIN chats c ON c.id=s.chat WHERE s.created<? AND s.arrival<c.cursor LIMIT 1000)",
        now - c.dedupRetentionDays * 86400000,
      );
      for (const j of this.all(
        "SELECT id FROM jobs j WHERE status IN ('sent','canceled') AND created<? AND NOT EXISTS(SELECT 1 FROM seen s WHERE s.chat=j.chat AND s.id=j.message_id) LIMIT 100",
        now - c.dedupRetentionDays * 86400000,
      )) {
        this.run("DELETE FROM parts WHERE job=?", j.id);
        this.run("DELETE FROM jobs WHERE id=?", j.id);
      }
      for (const r of this.all(
        "SELECT DISTINCT chat FROM scan WHERE created<? LIMIT 100",
        pending,
      )) {
        this.pause(String(r.chat), "expired-scan");
        this.run("DELETE FROM scan WHERE chat=?", r.chat);
        this.run("DELETE FROM scan_links WHERE chat=?", r.chat);
        this.run("UPDATE chats SET link=NULL,scan_done=0 WHERE id=?", r.chat);
      }
    });
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  status() {
    return {
      authentication:
        this.get("SELECT value FROM meta WHERE key=?", "auth")?.value ??
        "unknown",
      acknowledgements: this.all(
        "SELECT read_state,reaction_state,COUNT(*) AS count FROM acknowledgements WHERE read_state!='disabled' OR reaction_state!='disabled' GROUP BY read_state,reaction_state",
      ),
      queue: this.all(
        "SELECT status,COUNT(*) AS count,MIN(created) AS oldest FROM jobs GROUP BY status",
      ),
      chats: this.all("SELECT id,kind,cursor,reason,last_poll FROM chats"),
      unresolved: this.all(
        "SELECT id,chat,status FROM jobs WHERE status IN ('uncertain','failed','expired')",
      ),
    };
  }
  close() {
    this.db.close();
  }
}
