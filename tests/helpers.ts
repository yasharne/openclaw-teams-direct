import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Message } from "../src/policy.js";
process.umask(0o077);
export const self = "8:orgid:00000000-0000-4000-8000-000000000001",
  sender = "8:orgid:00000000-0000-4000-8000-000000000002",
  other = "8:orgid:00000000-0000-4000-8000-000000000003",
  group = "19:synthetic@thread.v2";
export function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "teams-direct-"));
  const c = validateConfig({
    version: 1,
    accountId: self,
    stateDir: dir,
    openclaw: {
      url: "http://127.0.0.1:18790/v1/chat/completions",
      agent: "synthetic-agent",
      secretFile: join(dir, "secret.local.json"),
    },
    dmSenders: [sender],
    groups: [{ id: group, senders: [sender], prefix: "!claw" }],
  });
  const file = join(dir, "bridge.sqlite");
  const s = new Store(file, self);
  return {
    dir,
    file,
    c,
    s,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export const message = (
  id = "m1",
  arrival = 1000,
  text = "hello",
  from = sender,
): Message => ({
  id,
  arrival,
  text,
  sender: from,
  type: "Text",
  edited: false,
  deleted: false,
});
export function enqueue(
  f: ReturnType<typeof fixture>,
  chat = "dm",
  kind = "dm",
  m = message(),
) {
  f.s.addChat(chat, kind, 1000);
  const existing = f.s
    .all(
      "SELECT id,arrival FROM seen WHERE chat=? AND arrival=(SELECT cursor FROM chats WHERE id=?)",
      chat,
      chat,
    )
    .map((r) => message(String(r.id), Number(r.arrival), "previous"));
  f.s.page(chat, [m, ...existing], null, f.c, "first-page");
  return Number(
    f.s.get("SELECT id FROM jobs WHERE chat=? ORDER BY id DESC LIMIT 1", chat)
      ?.id,
  );
}
