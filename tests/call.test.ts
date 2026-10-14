import test from "node:test";
import assert from "node:assert/strict";
import { callTarget, verifyRecipient, callOutcome } from "../src/call.js";
import type { Page } from "playwright-core";
const c = {
  accountId: "8:orgid:00000000-0000-4000-8000-000000000001",
  profile: "/tmp/profile",
  browser: "/tmp/chrome",
  stateDir: "/tmp/state",
  ringSeconds: 12,
  targets: {
    "person.name": {
      chat: "19:00000000-0000-4000-8000-000000000001_00000000-0000-4000-8000-000000000002@unq.gbl.spaces",
      name: "Example Person",
    },
  },
};
test("call navigation uses the approved DM ID rather than a sidebar name; groups and unapproved targets fail", () => {
  assert.match(
    callTarget(c, "person.name").url,
    /l\/chat\/19%3A.*%40unq.gbl.spaces\/conversations$/,
  );
  for (const input of [
    { ...c, ringSeconds: 60 },
    { ...c, browser: "relative" },
    {
      ...c,
      targets: { "person.name": { chat: "19:group@thread.v2", name: "Group" } },
    },
  ])
    assert.throws(() => callTarget(input, "person.name"));
  assert.throws(() => callTarget(c, "other"));
  assert.throws(() => callTarget(c, "../person"));
});
test("recipient verification uses heading text independent of accessible-name decorations and rejects duplicates", async () => {
  let reads = 0;
  const page = {
    getByRole: (role: string) => {
      assert.equal(role, "heading");
      return {
        allTextContents: async () => {
          reads++;
          if (reads === 1)
            throw Error(
              "Execution context was destroyed, most likely because of a navigation",
            );
          return reads === 2 ? ["Chat"] : ["Chat", " Example Person "];
        },
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  await verifyRecipient(page, "Example Person");
  assert.equal(reads, 3);
  const duplicate = {
    getByRole: () => ({
      allTextContents: async () => ["Example Person", "Example Person"],
    }),
    waitForTimeout: async () => {},
  } as unknown as Page;
  await assert.rejects(
    verifyRecipient(duplicate, "Example Person"),
    /not-confirmed/,
  );
});

test("failed call clicks cannot become completed receipts and UI completion never confirms ringing", () => {
  assert.equal(callOutcome(false, false).phase, "failed-before-call");
  assert.equal(callOutcome(false, true).phase, "failed-before-call");
  assert.equal(callOutcome(false, false, true).phase, "call-click-unconfirmed");
  assert.equal(callOutcome(true, true).phase, "ended");
  assert.equal(callOutcome(true, false).phase, "browser-closed");
  for (const clicked of [false, true])
    for (const left of [false, true])
      assert.equal(callOutcome(clicked, left).ringConfirmed, false);
});
