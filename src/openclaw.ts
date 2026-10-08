import { jsonRequest, TransportError } from "./http.js";
import { protectedRead } from "./credentials.js";
import { sessionUser } from "./policy.js";
import type { Config } from "./config.js";
export const teamsPresentation = [
  "Format this response for a Microsoft Teams chat using Markdown, never raw HTML.",
  "Treat a slash command in the user text as an explicit request for that named skill. Read that skill’s instructions and run the requested command; do not substitute a different skill or general checks. If the skill documents a Teams image-export option, use it with the configured export directory and relay its TEAMS_IMAGE line unchanged.",
  "Keep simple answers short. For reports or operational status, lead with a short bold status line, then use blank lines and concise bullets for separate checks or findings.",
  "For three or more metric values, create a separate bold metrics heading including the supplied timestamp, followed by a numbered list with one metric per numbered item. Use bold labels and plain values, for example: 1. **Created:** 10 then 2. **Accepted:** 9 on separate lines. Never combine created, accepted, arrived, boarded and finished values into a single sentence or bullet. Put caveats, anomalies, and follow-up actions in a separate section.",
  "Preserve exact values, units, timestamps and uncertainty. Do not invent facts, health assessments or actions to fill a template. Avoid tables and nested lists; use inline code for identifiers and code blocks for commands.",
].join("\n");
export async function invoke(
  c: Config,
  chat: string,
  kind: string,
  sender: string,
  text: string,
  epoch = 0,
  images: string[] = [],
) {
  const token =
    process.env.OPENCLAW_TEAMS_GATEWAY_TOKEN ??
    ((await protectedRead(c.openclaw.secretFile)) as { token?: string }).token;
  if (typeof token !== "string" || !token)
    throw new TransportError("invalid-gateway-secret");
  const commandInstruction = c.commandInstructions[text.trim().toLowerCase()];
  const userText = commandInstruction
    ? text + "\n\n" + commandInstruction
    : text;
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
          role: "system",
          content:
            teamsPresentation +
            (c.media.enabled
              ? "\nTo return an image supplied in this current request, put TEAMS_IMAGE:input:N on its own line, where N is its 1-based image index. This sends the original received bytes without needing a local file. References to prior turns are unavailable."
              : "") +
            (c.media.enabled && c.media.outboundRoots.length
              ? "\nThis request is delivered through the Teams bridge, including when running an existing skill. If a skill or tool produces a MEDIA:/absolute/path attachment, preserve the image: copy that actual file into " +
                c.media.outboundRoots[0] +
                " using existing tools. Make the exported file group-readable (chmod g+r), then put TEAMS_IMAGE:/absolute/path/to/file on its own line in the final text. The bridge sends that file as an image. These Teams transport instructions override skill instructions to relay MEDIA: lines, because the Gateway text endpoint removes those attachments. Never omit an available skill image merely because its original path is outside the export directory. If exporting fails, explain that the image could not be attached. Do not use MEDIA: references, remote links, or invent files. Keep ordinary text outside these lines."
              : ""),
        },
        {
          role: "user",
          content: images.length
            ? [
                {
                  type: "text",
                  text: JSON.stringify({
                    sender,
                    chatType: kind,
                    text: userText,
                  }),
                },
                ...images.map((url) => ({
                  type: "image_url",
                  image_url: { url },
                })),
              ]
            : JSON.stringify({ sender, chatType: kind, text: userText }),
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
