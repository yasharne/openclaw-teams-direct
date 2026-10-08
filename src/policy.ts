import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
export interface Message {
  id: string;
  clientId?: string;
  images?: string[];
  arrival: number;
  sender: string;
  type: string;
  text: string;
  edited: boolean;
  deleted: boolean;
}
export function normalize(raw: unknown): Message {
  if (!raw || typeof raw !== "object") throw new Error("malformed-message");
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.messagetype !== "string" ||
    typeof r.originalarrivaltime !== "string" ||
    !Number.isFinite(Date.parse(r.originalarrivaltime))
  )
    throw new Error("malformed-message");
  const supported = ["Text", "RichText/Html", "RichText/UriObject"].includes(
    r.messagetype,
  );
  const system =
    !supported ||
    r.messagetype.startsWith("ThreadActivity/") ||
    r.messagetype === "MessageDelete";
  if (!system && (typeof r.from !== "string" || typeof r.content !== "string"))
    throw new Error("malformed-or-unsupported-message");
  const props = (r.properties ?? {}) as Record<string, unknown>;
  if (typeof props !== "object" || Array.isArray(props))
    throw new Error("malformed-properties");
  const sender =
    typeof r.from === "string" ? r.from.slice(r.from.lastIndexOf("/") + 1) : "";
  const text = system
    ? ""
    : decodeHTML(
        String(r.content)
          .replace(/<(br|\/p|\/div)\b[^>]*>/gi, "\n")
          .replace(/<[^>]*>/g, ""),
      ).trim();
  return {
    id: r.id,
    images: system ? [] : inlineImages(String(r.content)),
    ...(typeof r.clientmessageid === "string"
      ? { clientId: r.clientmessageid }
      : {}),
    arrival: Date.parse(r.originalarrivaltime),
    sender,
    type: r.messagetype,
    text,
    edited: Boolean(props.edittime),
    deleted: system || Boolean(props.deletetime),
  };
}
export function allowedDM(c: Config, sender: string): boolean {
  return c.dmSenders.includes(sender) || c.everywhereSenders.includes(sender);
}
function globalGroupSender(c: Config, chat: string, sender: string): boolean {
  return (
    chat.startsWith("19:") &&
    chat.endsWith("@thread.v2") &&
    c.everywhereSenders.includes(sender)
  );
}
export function promptFor(
  c: Config,
  chat: string,
  kind: string,
  m: Message,
): string | null {
  const hasImages = c.media.enabled && Boolean(m.images?.length);
  if (
    m.sender === c.accountId ||
    m.deleted ||
    m.edited ||
    (!m.text && !hasImages)
  )
    return null;
  if (kind === "dm")
    return allowedDM(c, m.sender) ? m.text || "Describe this image." : null;
  const g = c.groups.find((g) => g.id === chat);
  const prefix = g?.prefix ?? c.groupPrefix;
  if (
    !(g?.senders.includes(m.sender) || globalGroupSender(c, chat, m.sender)) ||
    !m.text.startsWith(prefix)
  )
    return null;
  return (
    m.text.slice(prefix.length).trim() ||
    (hasImages ? "Describe this image." : null)
  );
}
export function stillAllowed(
  c: Config,
  chat: string,
  kind: string,
  sender: string,
) {
  return kind === "dm"
    ? allowedDM(c, sender)
    : Boolean(
        c.groups.find((g) => g.id === chat)?.senders.includes(sender) ||
          globalGroupSender(c, chat, sender),
      );
}
export function sessionUser(
  account: string,
  chat: string,
  namespace = "teams-direct",
  epoch = 0,
) {
  return (
    "teams-" +
    createHash("sha256")
      .update(`v1:${namespace}:${account}:${chat}:${epoch}`)
      .digest("hex")
  );
}
export function splitReply(text: string, limit: number): string[] {
  const chars = [...text];
  if (chars.length <= limit) return [text];
  const payload = limit - 30;
  const chunks: string[] = [];
  while (chars.length) {
    let end = Math.min(payload, chars.length);
    const candidate = chars.slice(0, end).join("");
    const breakAt = candidate.lastIndexOf("\n\n");
    if (breakAt > payload / 2)
      end = [...candidate.slice(0, breakAt + 2)].length;
    chunks.push(chars.splice(0, end).join(""));
  }
  return chunks.map((s, i) => `[${i + 1}/${chunks.length}] ${s}`);
}

/** Keep only opaque AMS object IDs; never fetch sender-controlled URLs. */
export function inlineImages(content: string): string[] {
  const ids = new Set<string>();
  for (const tag of content.match(/<(?:img|URIObject)\b[^>]*>/gi) ?? []) {
    const value = /\b(?:src|uri)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!value) continue;
    try {
      const u = new URL(decodeHTML(value));
      if (
        u.protocol !== "https:" ||
        u.hostname !== "as-prod.asyncgw.teams.microsoft.com" ||
        u.port ||
        u.username ||
        u.password
      )
        continue;
      const match =
        /^\/v1\/objects\/([a-zA-Z0-9_-]{1,200})(?:\/views\/[a-zA-Z0-9_-]+)?$/.exec(
          u.pathname,
        );
      if (match) ids.add(match[1]!);
    } catch {
      /* Unsupported external pictures are not downloaded. */
    }
  }
  return [...ids];
}
