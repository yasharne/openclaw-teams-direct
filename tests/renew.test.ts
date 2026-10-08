import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, self, other } from "./helpers.js";
import { protectedWrite, protectedRead } from "../src/credentials.js";
import { renewCredentials, renewalDue, tokenExpiry } from "../src/renew.js";
import { TransportError } from "../src/http.js";
const jwt = (exp: number) =>
  `synthetic.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
test("expiry is a scheduling hint and opaque tokens use bounded age", () => {
  assert.equal(tokenExpiry("opaque"), null);
  assert.equal(tokenExpiry(jwt(123)), 123000);
  assert.equal(
    renewalDue({ skypeToken: jwt(7200), region: "apac" }, 0, 3600000),
    false,
  );
  assert.equal(
    renewalDue({ skypeToken: jwt(5000), region: "apac" }, 0, 3600000),
    true,
  );
  assert.equal(
    renewalDue({ skypeToken: "opaque", region: "apac" }, 1000, 10000),
    false,
  );
  assert.equal(
    renewalDue({ skypeToken: "opaque", region: "apac" }, 0, 21600000),
    true,
  );
});
test("healthy fresh credentials never open browser; expiry recovers with verified credentials", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "credentials.json");
    await protectedWrite(file, {
      skypeToken: jwt(Math.floor(Date.now() / 1000) + 7200),
      region: "apac",
    });
    let captures = 0;
    const deps = {
      capture: async () => {
        captures++;
        return { skypeToken: "new-token", region: "emea" };
      },
      identity: async () => ({ id: self, date: null }),
    };
    assert.equal(
      (await renewCredentials(f.c, "/profile", "/chrome", false, deps)).event,
      "renewal-not-needed",
    );
    assert.equal(captures, 0);
    let checks = 0;
    deps.identity = async () => {
      if (checks++ === 0) throw new TransportError("needs-login");
      return { id: self, date: null };
    };
    assert.equal(
      (await renewCredentials(f.c, "/profile", "/chrome", false, deps)).event,
      "credentials-renewed",
    );
    assert.equal(captures, 1);
    assert.deepEqual(await protectedRead(file), {
      skypeToken: "new-token",
      region: "emea",
    });
  } finally {
    f.close();
  }
});
test("wrong account, login prompts and transport errors preserve existing credentials", async () => {
  const f = fixture();
  try {
    const file = join(f.dir, "credentials.json");
    const old = { skypeToken: "original", region: "apac" };
    await protectedWrite(file, old);
    await assert.rejects(
      renewCredentials(f.c, "/profile", "/chrome", true, {
        capture: async () => ({ skypeToken: "wrong", region: "apac" }),
        identity: async () => ({ id: other, date: null }),
      }),
      /login-account-mismatch/,
    );
    await assert.rejects(
      renewCredentials(f.c, "/profile", "/chrome", true, {
        capture: async () => {
          throw Error("interactive-login-required");
        },
        identity: async () => ({ id: self, date: null }),
      }),
      /interactive-login-required/,
    );
    let captured = false;
    await assert.rejects(
      renewCredentials(f.c, "/profile", "/chrome", false, {
        capture: async () => {
          captured = true;
          return old;
        },
        identity: async () => {
          throw new TransportError("throttled");
        },
      }),
    );
    assert.equal(captured, false);
    assert.deepEqual(await protectedRead(file), old);
  } finally {
    f.close();
  }
});

test("media expiry renews independently and wrong media-account tokens cannot replace credentials", async () => {
  const f = fixture();
  const mediaJwt = (oid: string, seconds: number) =>
    `header.${Buffer.from(JSON.stringify({ oid: oid.split(":").at(-1), exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.signature`;
  try {
    f.c.media.enabled = true;
    const file = join(f.dir, "credentials.json");
    const old = {
      skypeToken: jwt(Math.floor(Date.now() / 1000) + 7200),
      region: "apac",
      amsToken: mediaJwt(self, 600),
    };
    await protectedWrite(file, old);
    await assert.rejects(
      renewCredentials(f.c, "/profile", "/chrome", false, {
        capture: async () => ({ ...old, amsToken: mediaJwt(other, 7200) }),
        identity: async () => ({ id: self, date: null }),
      }),
      /media-account-mismatch/,
    );
    assert.deepEqual(await protectedRead(file), old);
    const next = { ...old, amsToken: mediaJwt(self, 7200) };
    const result = await renewCredentials(f.c, "/profile", "/chrome", false, {
      capture: async () => next,
      identity: async () => ({ id: self, date: null }),
    });
    assert.equal(result.event, "credentials-renewed");
    assert.deepEqual(await protectedRead(file), next);
  } finally {
    f.close();
  }
});
