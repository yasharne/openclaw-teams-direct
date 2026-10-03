import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";
import {
  normalize,
  promptFor,
  stillAllowed,
  splitReply,
  sessionUser,
} from "../src/policy.js";
import { fixture, message, self, sender, other, group } from "./helpers.js";
test("configuration rejects unknown fields, nonlocal Gateway, self authorization and invalid limits", () => {
  const f = fixture();
  try {
    for (const c of [
      { ...f.c, surprise: true },
      {
        ...f.c,
        openclaw: {
          ...f.c.openclaw,
          url: "http://example.com/v1/chat/completions",
        },
      },
      { ...f.c, dmSenders: [self] },
      { ...f.c, maxInFlight: 3 },
      { ...f.c, requestsPerMinute: 0 },
    ])
      assert.throws(() => validateConfig(c));
    assert.equal(f.c.openclaw.timeoutMs, 90000);
  } finally {
    f.close();
  }
});
test("DM and prefix group policies ignore self, denied senders, edits, deletes and untriggered traffic", () => {
  const f = fixture();
  try {
    assert.equal(promptFor(f.c, "dm", "dm", message()), "hello");
    for (const m of [
      message("a", 1000, "x", self),
      message("b", 1000, "x", other),
      { ...message(), edited: true },
      { ...message(), deleted: true },
    ])
      assert.equal(promptFor(f.c, "dm", "dm", m), null);
    assert.equal(promptFor(f.c, group, "group", message()), null);
    assert.equal(
      promptFor(f.c, group, "group", message("c", 1000, "!claw hi")),
      "hi",
    );
    assert.equal(
      promptFor(f.c, "unlisted", "group", message("c", 1000, "!claw hi")),
      null,
    );
  } finally {
    f.close();
  }
});
test("malformed transport records fail rather than normalize to empty IDs", () => {
  for (const r of [
    {},
    {
      id: "",
      messagetype: "Text",
      originalarrivaltime: new Date().toISOString(),
    },
    { id: "1", messagetype: "Text", originalarrivaltime: "invalid" },
    {
      id: "1",
      messagetype: "Text",
      originalarrivaltime: new Date().toISOString(),
      from: sender,
    },
  ])
    assert.throws(() => normalize(r));
  const m = normalize({
    id: "1",
    messagetype: "RichText/Html",
    originalarrivaltime: new Date(1000).toISOString(),
    from: "https://example/contacts/" + sender,
    content: "<p>A &amp; B</p><p>hello</p>",
  });
  assert.equal(m.sender, sender);
  assert.equal(m.text, "A & B\nhello");
});
test("Unicode split preserves payload, labels every part and respects character limit", () => {
  const text = "😀 café\n\n".repeat(500);
  const parts = splitReply(text, 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => [...p].length <= 300));
  assert.equal(
    parts.map((p) => p.replace(/^\[\d+\/\d+\] /, "")).join(""),
    text,
  );
});
test("session IDs separate accounts, conversations, deployments and explicit resets", () => {
  const a = sessionUser(self, "a");
  assert.equal(a, sessionUser(self, "a"));
  for (const b of [
    sessionUser(self, "b"),
    sessionUser(sender, "a"),
    sessionUser(self, "a", "other"),
    sessionUser(self, "a", "teams-direct", 1),
  ])
    assert.notEqual(a, b);
});

test("everywhere access applies only to named sender in DMs and group chats, with revocation and prefix enforcement", () => {
  const f = fixture();
  try {
    const chat = "19:new@thread.v2";
    f.c.everywhereSenders = [other];
    assert.equal(
      promptFor(f.c, "dm", "dm", message("x", 1000, "hello", other)),
      "hello",
    );
    assert.equal(
      promptFor(f.c, chat, "group", message("x", 1000, "!claw hi", other)),
      "hi",
    );
    assert.equal(
      promptFor(f.c, chat, "group", message("x", 1000, "hi", other)),
      null,
    );
    assert.equal(
      promptFor(f.c, chat, "group", message("x", 1000, "!claw hi", sender)),
      null,
    );
    assert.equal(
      promptFor(
        f.c,
        "19:channel@thread.tacv2",
        "group",
        message("x", 1000, "!claw hi", other),
      ),
      null,
    );
    assert.equal(stillAllowed(f.c, chat, "group", other), true);
    f.c.everywhereSenders = [];
    assert.equal(stillAllowed(f.c, chat, "group", other), false);
    assert.throws(() => validateConfig({ ...f.c, everywhereSenders: [self] }));
    assert.throws(() => validateConfig({ ...f.c, everywhereSenders: ["*"] }));
  } finally {
    f.close();
  }
});
