import { chromium, type Request } from "playwright-core";
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
    // no interception that pauses requests, no keyring or cache fallback.
    void pages[0]!
      .reload({ waitUntil: "domcontentloaded", timeout })
      .catch(() => {});
    return await captured;
  } finally {
    if (timer) clearTimeout(timer);
    context.off("request", handler);
    await browser.close();
  }
}
