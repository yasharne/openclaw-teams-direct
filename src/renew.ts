import { chromium, type Request } from "playwright-core";
import { join, isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";
import type { Config } from "./config.js";
import { protectedRead, protectedWrite, safeDirectory } from "./credentials.js";
import {
  inspectHeaders,
  captureMediaToken,
  verifyMediaAccount,
} from "./login.js";
import { Teams, Scheduler, TransportError, type Token } from "./http.js";
/** Unverified JWT expiry is only a scheduling hint; server identity is authoritative. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    return Number.isSafeInteger(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}
export function renewalDue(token: Token, modified: number, now = Date.now()) {
  const expiry = tokenExpiry(token.skypeToken);
  return expiry === null
    ? now - modified >= 6 * 3600000
    : expiry - now <= 30 * 60000;
}
export async function captureSavedSession(
  profile: string,
  executable: string,
): Promise<Token> {
  if (!isAbsolute(profile) || !isAbsolute(executable))
    throw Error("renewal-paths-must-be-absolute");
  await safeDirectory(profile);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    headless: true,
    timeout: 30000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: ((request: Request) => void) | undefined;
  try {
    // Avoid restored duplicate tabs and attach the observer before navigation.
    const page = await context.newPage();
    for (const old of context.pages()) if (old !== page) await old.close();
    const captured = new Promise<Token>((resolve, reject) => {
      const fields: Partial<Token> = {};
      timer = setTimeout(
        () => reject(Error("interactive-login-required-or-renewal-timeout")),
        90000,
      );
      handler = (request) => {
        void request
          .allHeaders()
          .then((headers) => {
            Object.assign(fields, inspectHeaders(request.url(), headers));
            if (fields.skypeToken && fields.region)
              resolve({ skypeToken: fields.skypeToken, region: fields.region });
          })
          .catch(() => {});
      };
      context.on("request", handler);
    });
    void page
      .goto("https://teams.cloud.microsoft/", {
        timeout: 90000,
        waitUntil: "domcontentloaded",
      })
      .catch(() => {});
    const token = await captured;
    const amsToken = await captureMediaToken(page).catch(() => undefined);
    return { ...token, ...(amsToken ? { amsToken } : {}) };
  } finally {
    clearTimeout(timer);
    if (handler) context.off("request", handler);
    await context.close();
  }
}
export async function renewCredentials(
  c: Config,
  profile: string,
  executable: string,
  force = false,
  dependencies = {
    capture: () => captureSavedSession(profile, executable),
    identity: async (token: Token) =>
      new Teams(token, new Scheduler(6, 1), c.requestTimeoutMs).identity(),
  },
) {
  const file = join(c.stateDir, "credentials.json");
  const old = (await protectedRead(file)) as Token;
  let due =
    force ||
    renewalDue(old, (await lstat(file)).mtimeMs) ||
    (c.media.enabled &&
      (!old.amsToken ||
        (tokenExpiry(old.amsToken) ?? 0) - Date.now() <= 30 * 60000));
  if (!due) {
    try {
      if ((await dependencies.identity(old)).id !== c.accountId)
        throw Error("login-account-mismatch");
      return { event: "renewal-not-needed" };
    } catch (e) {
      if (!(e instanceof TransportError) || e.category !== "needs-login")
        throw e;
      due = true;
    }
  }
  const token = await dependencies.capture();
  if ((await dependencies.identity(token)).id !== c.accountId)
    throw Error("login-account-mismatch");
  verifyMediaAccount(token, c.accountId);
  await protectedWrite(file, {
    skypeToken: token.skypeToken,
    region: token.region,
    ...(token.amsToken ? { amsToken: token.amsToken } : {}),
  });
  return {
    event: "credentials-renewed",
    mediaReady: !c.media.enabled || Boolean(token.amsToken),
  };
}
