#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, isAbsolute } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { protectedRead, protectedWrite, safeDirectory } from "./credentials.js";
import { Teams, Scheduler } from "./http.js";
import { inspectHeaders } from "./login.js";
export function callTarget(raw: unknown, alias: string) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(alias))
    throw Error("invalid-call-alias");
  const c = raw as {
    accountId: string;
    profile: string;
    browser: string;
    stateDir: string;
    ringSeconds: number;
    targets: Record<string, { chat: string; name: string }>;
  };
  const t =
    c?.targets && Object.hasOwn(c.targets, alias)
      ? c.targets[alias]
      : undefined;
  if (
    !t ||
    !/^19:[a-f0-9-]+_[a-f0-9-]+@unq\.gbl\.spaces$/i.test(t.chat) ||
    !t.name?.trim() ||
    t.name.length > 100
  )
    throw Error("call-target-not-allowed");
  if (
    !/^8:orgid:[a-f0-9-]{36}$/i.test(c.accountId) ||
    ![c.profile, c.browser, c.stateDir].every(
      (p) => typeof p === "string" && isAbsolute(p),
    ) ||
    !Number.isInteger(c.ringSeconds) ||
    c.ringSeconds < 5 ||
    c.ringSeconds > 30
  )
    throw Error("invalid-call-config");
  return {
    c,
    t,
    url: `https://teams.microsoft.com/l/chat/${encodeURIComponent(t.chat)}/conversations`,
  };
}
export async function verifyRecipient(page: Page, name: string) {
  const headings = page.getByRole("heading");
  for (let i = 0; i < 60; i++) {
    try {
      const texts = await headings.allTextContents();
      if (texts.filter((t) => t.trim() === name).length === 1) return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Execution context was destroyed|Cannot find context|Frame was detached/.test(
          error.message,
        )
      )
        throw error;
    }
    await page.waitForTimeout(500);
  }
  throw Error("call-recipient-not-confirmed");
}
async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      target: { type: "string" },
      id: { type: "string" },
      check: { type: "boolean" },
    },
  });
  if (
    !values.config ||
    !values.target ||
    !values.id ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(values.id)
  )
    throw Error("call-config-target-and-stable-id-required");
  const { c, t, url } = callTarget(
    await protectedRead(values.config),
    values.target,
  );
  await safeDirectory(c.stateDir, true);
  const receipt = join(
    c.stateDir,
    `call-${values.target}-${values.id}.local.json`,
  );
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(values.target))
    throw Error("invalid-call-alias");
  try {
    const prior = await protectedRead(receipt);
    console.log(JSON.stringify({ duplicate: true, receipt: prior }));
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let context:
    | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
    | undefined;
  let attempted = false,
    hangup = false;
  try {
    context = await chromium.launchPersistentContext(c.profile, {
      headless: true,
      executablePath: c.browser,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
      timeout: 30000,
    });
    await context.grantPermissions(["microphone"]);
    await context.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (options) => {
        const stream = await original(options);
        for (const track of stream.getAudioTracks()) track.enabled = false;
        return stream;
      };
    });
    let browserToken: ReturnType<typeof inspectHeaders> = {};
    context.on("request", (r) => {
      void r
        .allHeaders()
        .then((h) => {
          Object.assign(browserToken, inspectHeaders(r.url(), h));
        })
        .catch(() => {});
    });
    const page = await context.newPage();
    for (const p of context.pages()) if (p !== page) await p.close();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await verifyRecipient(page, t.name);
    if (!browserToken.skypeToken || !browserToken.region)
      throw Error("call-browser-identity-unavailable");
    const scheduler = new Scheduler(60, 1);
    try {
      const identity = await new Teams(
        browserToken as { skypeToken: string; region: string },
        scheduler,
        20000,
      ).identity();
      if (identity.id !== c.accountId)
        throw Error("call-browser-account-mismatch");
    } finally {
      scheduler.close();
    }
    if (values.check) {
      console.log(JSON.stringify({ phase: "ready", target: values.target }));
      return;
    }
    await writeFile(
      receipt,
      JSON.stringify({ phase: "attempting", time: Date.now() }),
      { flag: "wx", mode: 0o600 },
    );
    attempted = true;
    await page
      .getByRole("button", { name: "Audio call", exact: true })
      .click({ timeout: 15000 });
    console.log(
      JSON.stringify({ phase: "call-started", target: values.target }),
    );
    await page.waitForTimeout(c.ringSeconds * 1000);
    for (const p of context.pages()) {
      const leave = p.getByRole("button", {
        name: /^(hang up|end call|leave|cancel call)/i,
      });
      if ((await leave.count()) === 1) {
        try {
          await leave.click({ timeout: 3000 });
          hangup = true;
        } catch {
          /* A remote end can remove the control before clicking. */
        }
      }
    }
  } finally {
    await context?.close();
    if (attempted)
      await protectedWrite(receipt, {
        phase: hangup ? "ended" : "browser-closed",
        time: Date.now(),
        automaticRetry: false,
      });
  }
  console.log(
    JSON.stringify({
      phase: hangup ? "ended" : "browser-closed",
      target: values.target,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        diagnostic:
          error instanceof Error
            ? error.message.split("\n")[0]?.slice(0, 400)
            : "unknown",
        error:
          error instanceof Error && /^[a-z][a-z0-9-]+$/.test(error.message)
            ? error.message
            : "call-failed-check-private-receipt-no-automatic-retry",
      }),
    );
    process.exitCode = 1;
  });
