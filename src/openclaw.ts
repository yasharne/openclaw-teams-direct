import { jsonRequest, TransportError } from "./http.js";
import { protectedRead } from "./credentials.js";
import { sessionUser } from "./policy.js";
import type { Config } from "./config.js";
export async function invoke(
  c: Config,
  chat: string,
  kind: string,
  sender: string,
  text: string,
  epoch = 0,
) {
  const token =
    process.env.OPENCLAW_TEAMS_GATEWAY_TOKEN ??
    ((await protectedRead(c.openclaw.secretFile)) as { token?: string }).token;
  if (typeof token !== "string" || !token)
    throw new TransportError("invalid-gateway-secret");
  const r = await jsonRequest(
    new URL(c.openclaw.url),
    { Authorization: `Bearer ${token}` },
    c.openclaw.timeoutMs,
    {
      model: `openclaw/${c.openclaw.agent}`,
      user: sessionUser(c.accountId, chat, c.namespace, epoch),
      stream: false,
      messages: [
        {
          role: "user",
          content: JSON.stringify({ sender, chatType: kind, text }),
        },
      ],
    },
  );
  const d = r.data as { choices?: { message?: { content?: unknown } }[] };
  const content = d?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw new TransportError("uncertain", 0, true);
  return content;
}

export async function verifyGateway(c: Config) {
  const token =
    process.env.OPENCLAW_TEAMS_GATEWAY_TOKEN ??
    ((await protectedRead(c.openclaw.secretFile)) as { token?: string }).token;
  if (!token) throw new Error("invalid-gateway-secret");
  const url = new URL(c.openclaw.url);
  url.pathname = "/v1/models";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await jsonRequest(url, { Authorization: `Bearer ${token}` }, 5000);
      return;
    } catch (e) {
      if (
        e instanceof TransportError &&
        ["needs-login", "access-denied", "rejected"].includes(e.category)
      )
        throw new Error("gateway-authentication-or-endpoint-failed");
      if (attempt === 4) throw new Error("gateway-unavailable");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
