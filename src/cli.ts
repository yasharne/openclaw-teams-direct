#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { safeDirectory, protectedRead, protectedWrite } from "./credentials.js";
import { Scheduler, Teams, type Token } from "./http.js";
import { openStore, run } from "./runner.js";
process.umask(0o077);
const args = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "accept-duplicate-risk": { type: "boolean" },
    profile: { type: "string" },
    browser: { type: "string" },
    force: { type: "boolean" },
    port: { type: "string", default: "9222" },
  },
});
const [command, ...rest] = args.positionals;
async function main() {
  if (!command || command === "help") {
    console.log(
      "Usage: openclaw-teams-direct <validate|identity|login|renew|run|status|chats|members|resolve|resume|purge|reset-session> --config /absolute/config.local.json\nresolve JOB_ID complete|cancel|retry [--accept-duplicate-risk]\nresume CHAT_ID: reset a failed scan without advancing its cursor\npurge: remove saved payloads and pause pending chats\nreset-session CHAT_ID: start new OpenClaw context when that chat has no pending jobs",
    );
    return;
  }
  const file = args.values.config ?? process.env.OPENCLAW_TEAMS_CONFIG;
  if (!file) throw new Error("config-path-required");
  const c = await loadConfig(file, command !== "validate");
  if (command === "validate") {
    console.log(JSON.stringify({ valid: true }));
    return;
  }
  await safeDirectory(c.stateDir, true);
  if (command === "run") {
    await run(file);
    return;
  }
  if (command === "renew") {
    if (!args.values.profile || !args.values.browser)
      throw Error("renewal-profile-and-browser-required");
    const { renewCredentials } = await import("./renew.js");
    console.log(
      JSON.stringify(
        await renewCredentials(
          c,
          args.values.profile,
          args.values.browser,
          args.values.force,
        ),
      ),
    );
    return;
  }
  if (command === "identity") {
    const { captureFromBrowser, verifyMediaAccount } = await import(
      "./login.js"
    );
    const token = await captureFromBrowser(Number(args.values.port));
    const teams = new Teams(
      token,
      new Scheduler(c.requestsPerMinute, c.maxInFlight),
      c.requestTimeoutMs,
    );
    const identity = await teams.identity();
    console.log(
      JSON.stringify({ accountId: identity.id, credentialsSaved: false }),
    );
    return;
  }
  if (command === "login") {
    const { captureFromBrowser, verifyMediaAccount } = await import(
      "./login.js"
    );
    const token = await captureFromBrowser(Number(args.values.port));
    const teams = new Teams(
      token,
      new Scheduler(c.requestsPerMinute, c.maxInFlight),
      c.requestTimeoutMs,
    );
    const identity = await teams.identity();
    if (identity.id !== c.accountId) throw new Error("login-account-mismatch");
    verifyMediaAccount(token, c.accountId);
    await protectedWrite(join(c.stateDir, "credentials.json"), {
      skypeToken: token.skypeToken,
      region: token.region,
      ...(token.amsToken ? { amsToken: token.amsToken } : {}),
    });
    const s = await openStore(c);
    try {
      s.meta("auth", "ready");
    } finally {
      s.close();
    }
    console.log(
      JSON.stringify({ status: "login-verified", restartService: true }),
    );
    return;
  }
  if (["chats", "members"].includes(command)) {
    const token = (await protectedRead(
      join(c.stateDir, "credentials.json"),
    )) as Token;
    const teams = new Teams(
      token,
      new Scheduler(c.requestsPerMinute, c.maxInFlight),
      c.requestTimeoutMs,
    );
    if ((await teams.identity()).id !== c.accountId)
      throw new Error("account-mismatch");
    if (command === "members") {
      if (!rest[0]) throw new Error("chat-id-required");
      console.log(JSON.stringify(await teams.members(rest[0])));
    } else {
      let link: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const p = await teams.conversations(link);
        console.log(
          JSON.stringify(
            p.conversations.map((c) => ({
              id: c.id,
              topic: c.threadProperties?.topic ?? "",
            })),
          ),
        );
        if (!p.next) return;
        link = p.next;
      }
      throw new Error("discovery-page-limit");
    }
    return;
  }
  const s = await openStore(c);
  try {
    if (command === "status") {
      console.log(JSON.stringify(s.status(), null, 2));
      return;
    }
    // Operator mutations are disallowed while a live service owns the state.
    s.lease();
    s.recover();
    if (command === "resolve") {
      if (!/^\d+$/.test(rest[0] ?? "")) throw new Error("job-id-required");
      s.resolve(
        Number(rest[0]),
        rest[1] ?? "",
        Boolean(args.values["accept-duplicate-risk"]),
      );
    } else if (command === "resume") {
      const id = rest[0];
      if (!id || !s.get("SELECT id FROM chats WHERE id=?", id))
        throw new Error("chat-id-required");
      if (
        s.get(
          "SELECT id FROM jobs WHERE chat=? AND status IN ('uncertain','failed','expired')",
          id,
        )
      )
        throw new Error("resolve-jobs-first");
      s.tx(() => {
        s.run("DELETE FROM scan WHERE chat=?", id);
        s.run("DELETE FROM scan_links WHERE chat=?", id);
        s.run(
          "UPDATE chats SET reason=NULL,link=NULL,scan_done=0 WHERE id=?",
          id,
        );
      });
    } else if (command === "purge") {
      s.tx(() => {
        for (const j of s.all(
          "SELECT id,chat FROM jobs WHERE status IN ('queued','response_ready','uncertain')",
        ))
          s.fail(Number(j.id), String(j.chat), "expired");
        s.run("UPDATE jobs SET body=NULL");
        s.run("UPDATE parts SET body=NULL");
        for (const row of s.all("SELECT DISTINCT chat FROM scan")) {
          s.pause(String(row.chat), "purged-scan");
          s.run("UPDATE chats SET link=NULL,scan_done=0 WHERE id=?", row.chat);
        }
        s.run("DELETE FROM scan");
        s.run("DELETE FROM scan_links");
      });
      s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } else if (command === "reset-session") {
      const id = rest[0];
      if (!id || !s.get("SELECT id FROM chats WHERE id=?", id))
        throw new Error("chat-id-required");
      if (
        s.get(
          "SELECT id FROM jobs WHERE chat=? AND status IN ('queued','invoking','response_ready','sending','uncertain')",
          id,
        )
      )
        throw new Error("resolve-pending-turns-first");
      s.run("UPDATE chats SET generation=generation+1 WHERE id=?", id);
    } else throw new Error("unknown-command");
    console.log(JSON.stringify({ status: "completed", command }));
  } finally {
    s.release();
    s.close();
  }
}
main()
  .then(() => {
    if (command !== "run") process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "command-failed",
        category:
          error instanceof Error && /^[a-z][a-z0-9-]+$/.test(error.message)
            ? error.message
            : "check-configuration-permissions-or-status",
      }),
    );
    process.exit(1);
  });
