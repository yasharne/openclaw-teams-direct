import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { fixture, enqueue, self } from "./helpers.js";
import { Store } from "../src/store.js";
for (const boundary of ["invoking", "sending", "response_ready"])
  test(`process death after ${boundary} preserves documented restart state`, async () => {
    const f = fixture();
    const id = enqueue(f);
    f.s.close();
    const module = new URL("../src/store.js", import.meta.url).href;
    // commit -> SIGKILL -> reopen. This exercises actual SQLite/WAL persistence.
    const code = `import {Store} from ${JSON.stringify(module)}; const s=new Store(${JSON.stringify(f.file)},${JSON.stringify(self)});s.lease();s.start(${id},'invoking');${boundary !== "invoking" ? `s.response(${id},['saved']);` : ""}${boundary === "sending" ? `s.startPart(${id},0,'synthetic-client');` : ""}process.kill(process.pid,'SIGKILL');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: "ignore",
    });
    await once(child, "exit");
    const s = new Store(f.file, self);
    try {
      s.lease();
      s.recover();
      assert.equal(
        s.get("SELECT status FROM jobs WHERE id=?", id)?.status,
        boundary === "response_ready" ? "response_ready" : "uncertain",
      );
      if (boundary !== "invoking")
        assert.equal(
          s.get("SELECT body FROM parts WHERE job=?", id)?.body,
          "saved",
        );
      s.release();
    } finally {
      s.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
