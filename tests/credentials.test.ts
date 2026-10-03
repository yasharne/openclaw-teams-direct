import test from "node:test";
import assert from "node:assert/strict";
import { chmod, symlink, link, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  protectedRead,
  protectedWrite,
  safeDirectory,
} from "../src/credentials.js";
import { fixture } from "./helpers.js";
test("protected credential writes survive re-read and are mode 0600", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "credentials.json");
    await protectedWrite(file, { synthetic: "one" });
    await protectedWrite(file, { synthetic: "two" });
    assert.deepEqual(await protectedRead(file), { synthetic: "two" });
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    f.close();
  }
});
test("unsafe directory, symlink, hardlink and world-readable credentials are rejected", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "credentials.json");
    await protectedWrite(file, { synthetic: true });
    await chmod(file, 0o644);
    await assert.rejects(() => protectedRead(file));
    await assert.rejects(() => protectedWrite(file, { synthetic: false }));
    assert.match(await readFile(file, "utf8"), /true/);
    await chmod(file, 0o600);
    const sym = join(f.dir, "symlink");
    await symlink(file, sym);
    await assert.rejects(() => protectedRead(sym));
    await assert.rejects(() => protectedWrite(sym, {}));
    await link(file, join(f.dir, "hardlink"));
    await assert.rejects(() => protectedRead(file));
    await chmod(f.dir, 0o755);
    await assert.rejects(() => safeDirectory(f.dir));
    await chmod(f.dir, 0o700);
  } finally {
    f.close();
  }
});

test("browser capture accepts tokens only from Teams HTTPS request origins", async () => {
  const { inspectHeaders } = await import("../src/login.js");
  assert.deepEqual(
    inspectHeaders("https://attacker.invalid/api/mt/apac", {
      "x-skypetoken": "synthetic",
    }),
    {},
  );
  assert.deepEqual(
    inspectHeaders("http://teams.cloud.microsoft/api/mt/apac", {
      "x-skypetoken": "synthetic",
    }),
    {},
  );
  assert.deepEqual(
    inspectHeaders("https://apac.ng.msg.teams.microsoft.com/v1/", {
      Authentication: "skypetoken=synthetic",
    }),
    { region: "apac", skypeToken: "synthetic" },
  );
  assert.deepEqual(
    inspectHeaders("https://teams.cloud.microsoft/api/mt/emea/beta", {
      "X-SkypeToken": "synthetic",
    }),
    { region: "emea", skypeToken: "synthetic" },
  );
});
