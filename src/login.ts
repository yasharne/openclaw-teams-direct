import { chromium, type Page, type Request } from "playwright-core";
import type { Token } from "./http.js";
export function inspectHeaders(
  url: string,
  headers: Record<string, string>,
): Partial<Token> {
  const u = new URL(url);
  if (u.protocol !== "https:") return {};
  const service = /^([a-z0-9-]+)\.ng\.msg\.teams\.microsoft\.com$/.exec(
    u.hostname,
  );
  const front = ["teams.cloud.microsoft", "teams.microsoft.com"].includes(
    u.hostname,
  );
  if (!service && !front) return {};
  const region =
    service?.[1] ?? /^\/api\/mt\/([a-z0-9-]+)(?:\/|$)/.exec(u.pathname)?.[1];
  const h = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const skypeToken =
    h["x-skypetoken"] ?? /^skypetoken=(.+)$/.exec(h.authentication ?? "")?.[1];
  return {
    ...(region ? { region } : {}),
    ...(skypeToken ? { skypeToken } : {}),
    ...(front &&
    u.pathname.startsWith("/api/mt/") &&
    h.authorization?.startsWith("Bearer ")
      ? { bearerToken: h.authorization.slice(7) }
      : {}),
  };
}
export async function captureFromBrowser(
  port = 9222,
  timeout = 45000,
): Promise<Token> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("invalid-browser-port");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: 10000,
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("missing-browser-context");
  }
  const pages = context.pages().filter((p) => {
    try {
      return ["teams.cloud.microsoft", "teams.microsoft.com"].includes(
        new URL(p.url()).hostname,
      );
    } catch {
      return false;
    }
  });
  if (pages.length !== 1) {
    await browser.close();
    throw new Error("teams-tab-must-be-unique");
  }
  let handler: (r: Request) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const captured = new Promise<Token>((resolve, reject) => {
      const fields: Partial<Token> = {};
      timer = setTimeout(
        () => reject(new Error("sign-in-required-or-capture-timeout")),
        timeout,
      );
      handler = (r) => {
        void r
          .allHeaders()
          .then((headers) => {
            const found = inspectHeaders(r.url(), headers);
            Object.assign(fields, found);
            if (fields.skypeToken && fields.region)
              resolve({ skypeToken: fields.skypeToken, region: fields.region });
          })
          .catch(() => {});
      };
      context.on("request", handler);
    });
    // Observe ordinary browser requests; no custom authentication protocol,
    // no interception that pauses requests, no operating-system keyring access.
    void pages[0]!
      .reload({ waitUntil: "domcontentloaded", timeout })
      .catch(() => {});
    const token = await captured;
    const amsToken = await captureMediaToken(pages[0]!).catch(() => undefined);
    return { ...token, ...(amsToken ? { amsToken } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
    context.off("request", handler);
    await browser.close();
  }
}

/** Read only the Teams image-upload access token from this signed-in page's MSAL store. */
export async function captureMediaToken(
  page: Page,
): Promise<string | undefined> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.includes("accesstoken")) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "");
        if (
          typeof value.target !== "string" ||
          !value.target
            .split(" ")
            .some((scope: string) =>
              scope.startsWith("https://ic3.teams.office.com/"),
            ) ||
          typeof value.secret !== "string"
        )
          continue;
        if (Number(value.expiresOn) * 1000 > Date.now() + 60000)
          return value.secret as string;
      } catch {
        /* Ignore unrelated or expired token entries. */
      }
    }
    return undefined;
  });
}

export function verifyMediaAccount(token: Token, accountId: string) {
  if (!token.amsToken) return;
  try {
    const claims = JSON.parse(
      Buffer.from(token.amsToken.split(".")[1] ?? "", "base64url").toString(),
    );
    if (
      typeof claims.oid !== "string" ||
      `8:orgid:${claims.oid}`.toLowerCase() !== accountId.toLowerCase()
    )
      throw Error("media-account-mismatch");
  } catch {
    throw Error("media-account-mismatch");
  }
}
