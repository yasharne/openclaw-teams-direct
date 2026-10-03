export class TransportError extends Error {
  constructor(
    public category: string,
    public retryAfterMs = 0,
    public uncertain = false,
  ) {
    super(category);
  }
}
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, 3600000);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(Math.max(date - now, 0), 3600000)
    : 1000;
}
export class Scheduler {
  private closed = false;
  close() {
    this.closed = true;
  }
  private active = 0;
  private timestamps: number[] = [];
  private blockedUntil = 0;
  constructor(
    private budget: number,
    private concurrency: number,
    private now = () => Date.now(),
    private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}
  throttle(ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
  get state() {
    return {
      inFlight: this.active,
      throttledUntil: this.blockedUntil,
      requestsLastMinute: this.timestamps.filter((t) => t > this.now() - 60000)
        .length,
    };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    while (true) {
      if (this.closed) throw new TransportError("stopped");
      const now = this.now();
      this.timestamps = this.timestamps.filter((t) => t > now - 60000);
      const delay = Math.max(
        this.blockedUntil - now,
        this.timestamps.length >= this.budget
          ? (this.timestamps[0] ?? now) + 60000 - now
          : 0,
      );
      if (this.active < this.concurrency && delay <= 0) break;
      await this.sleep(Math.min(Math.max(delay, 25), 1000));
    }
    this.active++;
    this.timestamps.push(this.now());
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}
export async function jsonRequest(
  url: URL,
  headers: Record<string, string>,
  timeout: number,
  body?: unknown,
  maxBytes = 2 * 1024 * 1024,
  method: "GET" | "POST" | "PUT" = body ? "POST" : "GET",
  allowEmpty = false,
): Promise<{ data: unknown; date: string | null }> {
  let submitted = false;
  try {
    submitted = method !== "GET";
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      if (response.status === 429)
        throw new TransportError(
          "throttled",
          retryAfter(response.headers.get("retry-after")),
        );
      if (response.status === 401) throw new TransportError("needs-login");
      if (response.status === 403 || response.status === 404)
        throw new TransportError("access-denied");
      const ambiguous =
        submitted && (response.status >= 500 || response.status === 408);
      throw new TransportError(
        ambiguous
          ? "uncertain"
          : response.status >= 500
            ? "transient-read"
            : "rejected",
        0,
        ambiguous,
      );
    }
    if (allowEmpty && response.status === 204)
      return { data: null, date: response.headers.get("date") };
    const reader = response.body?.getReader();
    if (!reader) throw new TransportError("invalid-response", 0, submitted);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new TransportError("response-too-large", 0, submitted);
      }
      chunks.push(value);
    }
    if (allowEmpty && size === 0)
      return { data: null, date: response.headers.get("date") };
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { data, date: response.headers.get("date") };
  } catch (e) {
    if (e instanceof TransportError) throw e;
    throw new TransportError(
      submitted ? "uncertain" : "transient-read",
      0,
      submitted,
    );
  }
}
export interface Token {
  skypeToken: string;
  region: string;
  bearerToken?: string;
}
export class Teams {
  readonly base: URL;
  private selfId = "";
  private displayName = "Teams bridge";
  constructor(
    private token: Token,
    public scheduler: Scheduler,
    private timeout: number,
  ) {
    if (
      !token ||
      typeof token.skypeToken !== "string" ||
      !token.skypeToken ||
      !/^[a-z0-9-]+$/.test(token.region)
    )
      throw new Error("invalid-credentials");
    this.base = new URL(
      `https://${token.region}.ng.msg.teams.microsoft.com/v1/`,
    );
  }
  url(relative: string, pathPrefix = this.base.pathname) {
    const u = new URL(relative, this.base);
    if (
      u.origin !== this.base.origin ||
      !u.pathname.startsWith(this.base.pathname) ||
      (pathPrefix !== this.base.pathname &&
        decodeURIComponent(u.pathname).replace(/\/$/, "") !==
          decodeURIComponent(pathPrefix).replace(/\/$/, "")) ||
      u.username ||
      u.password ||
      u.hash
    )
      throw new TransportError("unsafe-pagination");
    return u;
  }
  async request(
    relative: string,
    body?: unknown,
    pathPrefix?: string,
    method: "GET" | "POST" | "PUT" = body ? "POST" : "GET",
    allowEmpty = false,
  ) {
    const url = this.url(relative, pathPrefix);
    return this.scheduler.run(async () => {
      try {
        return await jsonRequest(
          url,
          { Authentication: `skypetoken=${this.token.skypeToken}` },
          this.timeout,
          body,
          undefined,
          method,
          allowEmpty,
        );
      } catch (e) {
        if (e instanceof TransportError && e.category === "throttled")
          this.scheduler.throttle(e.retryAfterMs);
        throw e;
      }
    });
  }
  async identity() {
    const r = await this.request("users/ME/properties");
    const d = r.data as { skypeName?: unknown };
    if (typeof d?.skypeName !== "string")
      throw new TransportError("invalid-identity");
    this.selfId = `8:${d.skypeName}`;
    return { id: this.selfId, date: r.date };
  }
  async conversations(
    link = "users/ME/conversations?view=mychats&pageSize=100",
  ) {
    const r = await this.request(
      link,
      undefined,
      this.base.pathname + "users/ME/conversations",
    );
    const d = r.data as {
      conversations?: unknown;
      _metadata?: { backwardLink?: string };
    };
    if (!Array.isArray(d?.conversations))
      throw new TransportError("malformed-page");
    return {
      conversations: d.conversations as {
        id: string;
        threadProperties?: { topic?: string };
      }[],
      next: metadataNext(d),
    };
  }
  async members(chat: string) {
    const r = await this.request(`threads/${encodeURIComponent(chat)}/members`);
    const d = r.data as {
      members?: { id: string; userDisplayName?: string }[];
    };
    if (
      !Array.isArray(d?.members) ||
      d.members.some((m) => typeof m.id !== "string")
    )
      throw new TransportError("malformed-members");
    const own = d.members.find((m) => m.id === this.selfId);
    if (own?.userDisplayName) this.displayName = own.userDisplayName;
    return d.members;
  }
  async messages(chat: string, link?: string) {
    const path = `users/ME/conversations/${encodeURIComponent(chat)}/messages`;
    const r = await this.request(
      link ?? `${path}?pageSize=100`,
      undefined,
      this.base.pathname + path,
    );
    const d = r.data as {
      messages?: unknown;
      _metadata?: { backwardLink?: string };
    };
    if (!Array.isArray(d?.messages)) throw new TransportError("malformed-page");
    const next = metadataNext(d);
    if (next !== null && typeof next !== "string")
      throw new TransportError("malformed-page");
    if (next) this.url(next, this.base.pathname + path);
    return { messages: d.messages, next };
  }
  async react(chat: string, message: string, reaction: string) {
    await this.request(
      `users/ME/conversations/${encodeURIComponent(chat)}/messages/${encodeURIComponent(message)}/properties?name=emotions`,
      { emotions: { key: reaction, value: message } },
      undefined,
      "PUT",
      true,
    );
  }
  async markRead(chat: string, message: string, clientId: string) {
    if (/[;\r\n]/.test(message + clientId))
      throw new TransportError("invalid-read-target");
    const current = await this.request(
      `users/ME/conversations/${encodeURIComponent(chat)}`,
    );
    const horizon = (
      current.data as { properties?: { consumptionhorizon?: unknown } }
    )?.properties?.consumptionhorizon;
    const previous = typeof horizon === "string" ? horizon.split(";")[0] : "";
    if (
      /^\d{1,20}$/.test(previous ?? "") &&
      /^\d{1,20}$/.test(message) &&
      BigInt(previous!) >= BigInt(message)
    )
      return;

    await this.request(
      `users/ME/conversations/${encodeURIComponent(chat)}/properties?name=consumptionhorizon&readReceipt=true`,
      { consumptionhorizon: `${message};${Date.now()};${clientId}` },
      undefined,
      "PUT",
      true,
    );
  }
  async typing(chat: string, active: boolean) {
    await this.request(
      `users/ME/conversations/${encodeURIComponent(chat)}/messages`,
      {
        content: null,
        contenttype: "text",
        messagetype: active ? "Control/Typing" : "Control/ClearTyping",
        imdisplayname: this.displayName,
      },
      undefined,
      "POST",
      true,
    );
  }
  async send(chat: string, text: string, clientId: string) {
    const r = await this.request(
      `users/ME/conversations/${encodeURIComponent(chat)}/messages`,
      {
        content: formatReply(text),
        messagetype: "RichText/Html",
        contenttype: "text",
        clientmessageid: clientId,
        imdisplayname: this.displayName,
        properties: { importance: "", subject: null },
      },
    );
    const d = r.data as { OriginalArrivalTime?: string | number };
    if (!d?.OriginalArrivalTime) throw new TransportError("uncertain", 0, true);
    return String(d.OriginalArrivalTime);
  }
}

function metadataNext(data: unknown): string | null {
  const d = data as { _metadata?: unknown };
  const m = d._metadata;
  if (m === undefined || m === null) return null;
  if (typeof m !== "object" || Array.isArray(m))
    throw new TransportError("malformed-page");
  const next = (m as { backwardLink?: unknown }).backwardLink;
  if (next === undefined || next === null) return null;
  if (typeof next !== "string" || !next.trim())
    throw new TransportError("malformed-page");
  return next;
}
import { formatReply } from "./format.js";
