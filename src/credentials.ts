import { constants } from "node:fs";
import { open, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
export async function safeDirectory(dir: string, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    s.uid !== process.getuid?.()
  )
    throw new Error("unsafe-state-directory");
  // Reject symlink ancestors as well, including an attacker-controlled parent.
  let p = dirname(dir);
  while (p !== dirname(p)) {
    const a = await lstat(p);
    if (a.isSymbolicLink()) throw new Error("symlink-parent");
    p = dirname(p);
  }
}
export async function protectedRead(file: string) {
  await safeDirectory(dirname(file));
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (
      !s.isFile() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid?.() ||
      s.nlink !== 1
    )
      throw new Error("unsafe-credential-file");
    return JSON.parse(await h.readFile("utf8")) as unknown;
  } finally {
    await h.close();
  }
}
export async function protectedWrite(file: string, data: unknown) {
  await safeDirectory(dirname(file));
  try {
    const s = await lstat(file);
    if (
      s.isSymbolicLink() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid?.() ||
      s.nlink !== 1
    )
      throw new Error("unsafe-existing-credential");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = join(dirname(file), `.credentials-${randomUUID()}.tmp`);
  const h = await open(tmp, "wx", 0o600);
  try {
    await h.writeFile(JSON.stringify(data));
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(tmp, file);
    const d = await open(dirname(file), "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
