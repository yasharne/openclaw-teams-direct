import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import {
  TransportError,
  jsonRequest,
  type Token,
  type Scheduler,
} from "./http.js";
export const AMS = "https://as-prod.asyncgw.teams.microsoft.com/v1/objects";
const objectId = (id: string) => /^[a-zA-Z0-9_-]{1,200}$/.test(id);
export interface ImagePart {
  image: string;
  mime: string;
}
export function imageMime(data: Buffer): string {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (data.readUInt32BE(16) * data.readUInt32BE(20) > 40000000)
      throw Error("image-dimensions-too-large");
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) {
    if (data.readUInt16LE(6) * data.readUInt16LE(8) > 40000000)
      throw Error("image-dimensions-too-large");
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw Error("unsupported-image-format");
}
async function bytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new TransportError("invalid-response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new TransportError("image-too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export class MediaClient {
  constructor(
    private token: Token,
    private scheduler: Scheduler,
    private timeout: number,
    private limit: number,
  ) {}
  private async binary(path: string, method: "GET" | "PUT", data?: Buffer) {
    return this.scheduler.run(async () => {
      try {
        if (method === "PUT" && !this.token.amsToken)
          throw new TransportError("needs-login");
        const response = await fetch(AMS + path, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(this.timeout),
          headers: {
            Authorization:
              method === "GET"
                ? `skype_token ${this.token.skypeToken}`
                : `Bearer ${this.token.amsToken}`,
            "x-ms-client-version": "1415/26022704215",
            ...(data ? { "Content-Type": "application/octet-stream" } : {}),
          },
          body: data ? new Uint8Array(data) : undefined,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401) throw new TransportError("needs-login");
          if (response.status === 429) {
            this.scheduler.throttle(10000);
            throw new TransportError("throttled", 10000);
          }
          throw new TransportError(
            method === "PUT" &&
            (response.status >= 500 || response.status === 408)
              ? "uncertain"
              : "image-unavailable",
            0,
            method === "PUT" &&
              (response.status >= 500 || response.status === 408),
          );
        }
        if (method === "PUT") {
          await response.body?.cancel();
          return Buffer.alloc(0);
        }
        return await bytes(response, this.limit);
      } catch (e) {
        if (e instanceof TransportError) throw e;
        throw new TransportError(
          method === "PUT" ? "uncertain" : "transient-read",
          0,
          method === "PUT",
        );
      }
    });
  }
  async download(id: string) {
    if (!objectId(id)) throw Error("invalid-image-id");
    const data = await this.binary(`/${id}/views/imgpsh_fullsize_anim`, "GET");
    try {
      return `data:${imageMime(data)};base64,${data.toString("base64")}`;
    } catch {
      throw new TransportError("unsupported-image-format");
    }
  }
  async create(chat: string, mime: string) {
    if (!this.token.amsToken) throw new TransportError("needs-login");
    return this.scheduler.run(async () => {
      try {
        const r = await jsonRequest(
          new URL(AMS + "/"),
          {
            Authorization: `Bearer ${this.token.amsToken}`,
            "x-ms-client-version": "1415/26022704215",
          },
          this.timeout,
          {
            type: "pish/image",
            permissions: { [chat]: ["read"] },
            sharingMode: "Attached",
            filename: "image." + mime.split("/")[1],
          },
        );
        const id = (r.data as { id?: unknown })?.id;
        if (typeof id !== "string" || !objectId(id))
          throw new TransportError("uncertain", 0, true);
        return id;
      } catch (e) {
        if (e instanceof TransportError && e.category === "throttled")
          this.scheduler.throttle(e.retryAfterMs);
        throw e;
      }
    });
  }
  async upload(id: string, part: ImagePart) {
    if (!objectId(id)) throw Error("invalid-image-id");
    const data = Buffer.from(part.image, "base64");
    if (data.length > this.limit || imageMime(data) !== part.mime)
      throw Error("invalid-image-payload");
    await this.binary(`/${id}/content/imgpsh`, "PUT", data);
  }
}
export async function readOutboundImage(
  file: string,
  c: Config,
): Promise<ImagePart> {
  const path = resolve(file);
  const roots = await Promise.all(
    c.media.outboundRoots.map(async (root) => {
      if ((await realpath(root)) !== resolve(root))
        throw Error("unsafe-media-root");
      return resolve(root);
    }),
  );
  if (!roots.some((root) => path.startsWith(root + sep)))
    throw Error("image-outside-media-root");
  for (
    let parent = dirname(path);
    parent !== dirname(parent);
    parent = dirname(parent)
  )
    if ((await lstat(parent)).isSymbolicLink())
      throw Error("image-symlink-parent");
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.size > c.media.maxImageBytes)
      throw Error("image-too-large-or-not-file");
    const data = Buffer.alloc(c.media.maxImageBytes + 1);
    let size = 0;
    while (size < data.length) {
      const r = await h.read(data, size, data.length - size, null);
      if (!r.bytesRead) break;
      size += r.bytesRead;
    }
    if (size > c.media.maxImageBytes) throw Error("image-too-large");
    const content = data.subarray(0, size);
    return { image: content.toString("base64"), mime: imageMime(content) };
  } finally {
    await h.close();
  }
}
export async function replyParts(
  text: string,
  c: Config,
  split: (text: string, limit: number) => string[],
  inputs: string[] = [],
): Promise<(string | ImagePart)[]> {
  if (!c.media.enabled) return split(text, c.replyCharacters);
  const files = [
    ...text.matchAll(/^TEAMS_IMAGE:(\/[^\r\n]+|input:[1-9][0-9]*)\s*$/gm),
  ].map((m) => m[1]!.trim());
  const plain = text
    .replace(/^TEAMS_IMAGE:(?:\/[^\r\n]+|input:[1-9][0-9]*)\s*$/gm, "")
    .trim();
  const parts: (string | ImagePart)[] = plain
    ? split(plain, c.replyCharacters)
    : [];
  let total = 0;
  for (const file of files.slice(0, c.media.maxImages)) {
    try {
      let image: ImagePart;
      if (file.startsWith("input:")) {
        const source = inputs[Number(file.slice(6)) - 1];
        if (!source) throw Error("input-image-unavailable");
        const match =
          /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
            source,
          );
        if (!match) throw Error("invalid-input-image");
        const data = Buffer.from(match[2]!, "base64");
        if (data.length > c.media.maxImageBytes || imageMime(data) !== match[1])
          throw Error("invalid-input-image");
        image = { image: match[2]!, mime: match[1]! };
      } else image = await readOutboundImage(file, c);
      total += Buffer.from(image.image, "base64").length;
      if (total > 10485760) throw Error("images-too-large");
      parts.push(image);
    } catch {
      parts.push(
        "I could not attach an image: its file is unavailable, outside the configured media folder, too large, or unsupported.",
      );
    }
  }
  return parts.length ? parts : ["No response from OpenClaw."];
}
