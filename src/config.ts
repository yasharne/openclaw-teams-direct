import { readFile } from "node:fs/promises";
import { protectedRead } from "./credentials.js";
import { isAbsolute } from "node:path";
export interface Config {
  version: 1;
  namespace: string;
  accountId: string;
  stateDir: string;
  openclaw: {
    url: string;
    agent: string;
    secretFile: string;
    timeoutMs: number;
  };
  dmSenders: string[];
  everywhereSenders: string[];
  groupPrefix: string;
  groups: { id: string; senders: string[]; prefix: string }[];
  pollMs: number;
  discoveryMs: number;
  requestTimeoutMs: number;
  requestsPerMinute: number;
  maxInFlight: number;
  maxPagesPerTurn: number;
  maxQueue: number;
  maxScanMessages: number;
  replyCharacters: number;
  completedRetentionHours: number;
  pendingRetentionDays: number;
  dedupRetentionDays: number;
}
const defaults = {
  pollMs: 5000,
  discoveryMs: 60000,
  requestTimeoutMs: 20000,
  requestsPerMinute: 60,
  maxInFlight: 2,
  maxPagesPerTurn: 2,
  maxQueue: 1000,
  maxScanMessages: 10000,
  replyCharacters: 3000,
  completedRetentionHours: 24,
  pendingRetentionDays: 7,
  dedupRetentionDays: 30,
};
const known = new Set([
  "version",
  "namespace",
  "accountId",
  "stateDir",
  "openclaw",
  "dmSenders",
  "everywhereSenders",
  "groupPrefix",
  "groups",
  ...Object.keys(defaults),
]);
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("config-object");
  return v as Record<string, unknown>;
};
const keys = (o: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw new Error("config-unknown-field");
};
const mri = (v: unknown): v is string =>
  typeof v === "string" &&
  /^8:orgid:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    v,
  );
const senders = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(mri) && new Set(v).size === v.length;
export function validateConfig(raw: unknown): Config {
  const v = object(raw);
  keys(v, [...known]);
  const c = {
    namespace: "teams-direct",
    everywhereSenders: [],
    groupPrefix: "!claw",
    ...defaults,
    ...v,
  } as unknown as Config;
  if (typeof c.namespace !== "string" || !/^[-a-z0-9]{1,64}$/.test(c.namespace))
    throw new Error("config-namespace");
  if (c.version !== 1 || !mri(c.accountId) || !isAbsolute(c.stateDir ?? ""))
    throw new Error("config-account-or-path");
  if (
    !senders(c.dmSenders) ||
    !senders(c.everywhereSenders) ||
    typeof c.groupPrefix !== "string" ||
    !c.groupPrefix.trim() ||
    !Array.isArray(c.groups)
  )
    throw new Error("config-policy");
  const groupIds = new Set();
  for (const g of c.groups) {
    keys(object(g), ["id", "senders", "prefix"]);
    if (
      typeof g.id !== "string" ||
      !g.id.startsWith("19:") ||
      !senders(g.senders) ||
      typeof g.prefix !== "string" ||
      !g.prefix.trim() ||
      groupIds.has(g.id)
    )
      throw new Error("config-group");
    groupIds.add(g.id);
  }
  const o = object(c.openclaw);
  keys(o, ["url", "agent", "secretFile", "timeoutMs"]);
  c.openclaw.timeoutMs ??= 90000;
  const u = new URL(c.openclaw.url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.protocol !== "http:" ||
    u.username ||
    u.password ||
    u.pathname !== "/v1/chat/completions" ||
    u.search ||
    u.hash
  )
    throw new Error("config-gateway-must-be-loopback");
  if (
    !/^[a-z0-9][a-z0-9-]+$/.test(c.openclaw.agent) ||
    !isAbsolute(c.openclaw.secretFile)
  )
    throw new Error("config-agent-or-secret");
  for (const k of Object.keys(defaults) as (keyof typeof defaults)[]) {
    if (!Number.isSafeInteger(c[k]) || c[k] <= 0)
      throw new Error("config-positive-integer");
  }
  if (
    c.maxInFlight > 2 ||
    c.replyCharacters < 100 ||
    c.replyCharacters > 3000 ||
    c.maxPagesPerTurn > 20 ||
    c.pollMs < 1000 ||
    c.requestTimeoutMs > 120000 ||
    c.openclaw.timeoutMs < 1000 ||
    c.openclaw.timeoutMs > 300000
  )
    throw new Error("config-range");
  if (
    c.dmSenders.includes(c.accountId) ||
    c.everywhereSenders.includes(c.accountId) ||
    c.groups.some((g) => g.senders.includes(c.accountId))
  )
    throw new Error("config-self-sender");
  return c;
}
export async function loadConfig(file: string, secure = false) {
  return validateConfig(
    secure
      ? await protectedRead(file)
      : JSON.parse(await readFile(file, "utf8")),
  );
}
