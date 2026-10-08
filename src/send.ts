#!/usr/bin/env node
import { request } from "node:http";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export async function submitOutbound(socketPath: string, body: unknown) {
  const payload = JSON.stringify(body);
  return new Promise<{ job: number; status: string; duplicate: boolean }>(
    (resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: "/send",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 8192)
              req.destroy(Error("outbound-response-too-large"));
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              const value = JSON.parse(data);
              if (res.statusCode !== 202)
                throw Error(value.error ?? "outbound-rejected");
              resolve(value);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.setTimeout(15000, () =>
        req.destroy(Error("outbound-submit-uncertain-retry-same-id")),
      );
      req.on("error", reject);
      req.end(payload);
    },
  );
}
async function main() {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      target: { type: "string" },
      text: { type: "string" },
      image: { type: "string", multiple: true },
      id: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: openclaw-teams-send --target ALIAS --id STABLE_EVENT_ID [--text TEXT] [--image /absolute/export.png] [--socket /absolute/outbound.sock]\nWithout --text, read UTF-8 text from stdin. Accepted results are queued, not yet delivered. Reuse the same --id when retrying.",
    );
    return;
  }
  if (!values.target) throw Error("outbound-target-required");
  if (!values.id) throw Error("outbound-stable-event-id-required");
  process.stdin.setEncoding("utf8");
  let text = values.text ?? "";
  if (values.text === undefined)
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 400000)
        throw Error("outbound-text-too-large");
    }
  const id = values.id;
  console.log(
    JSON.stringify({
      id,
      ...(await submitOutbound(
        values.socket ??
          process.env.OPENCLAW_TEAMS_SOCKET ??
          "/var/lib/openclaw-teams-direct/outbound.sock",
        { target: values.target, id, text, images: values.image ?? [] },
      )),
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(
      JSON.stringify({
        error: e instanceof Error ? e.message : "outbound-send-failed",
      }),
    );
    process.exitCode = 1;
  });
