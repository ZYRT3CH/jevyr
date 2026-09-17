import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024, MAX_ENTRIES = 65536;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ordinary = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_FILE;
const same = (before, after) => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;

async function boundedFile(path) {
  const before = await lstat(path);
  if (!ordinary(before)) throw new Error("Calibration snapshot requires bounded singly-linked regular files");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!ordinary(opened) || !same(before, opened)) throw new Error("Calibration file changed during snapshot open");
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await file.stat();
    if (count !== opened.size || !ordinary(after) || !same(opened, after)) throw new Error("Calibration file changed during bounded snapshot read");
    return Buffer.from(bytes.subarray(0, count));
  } finally { await file.close(); }
}

/** Capture once before verification. Later source replacement cannot enter an installation. */
export async function captureCalibrationSnapshot(directory) {
  const root = resolve(directory), files = new Map(); let total = 0, entries = 0;
  async function visit(path, depth = 0) {
    if (depth > 8) throw new Error("Calibration snapshot directory nesting is excessive");
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("Calibration snapshot follows a directory alias");
    const names = await readdir(path);
    entries += names.length; if (entries > MAX_ENTRIES) throw new Error("Calibration snapshot entry limit exceeded");
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9_.-]{1,200}$/u.test(name) || name === "." || name === "..") throw new Error("Calibration snapshot contains an unsafe filename");
      const child = join(path, name), childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) throw new Error("Calibration snapshot refuses symbolic links");
      if (childInfo.isDirectory()) { await visit(child, depth + 1); continue; }
      if (total + childInfo.size > MAX_TOTAL) throw new Error("Calibration snapshot exceeds its total byte bound");
      const bytes = await boundedFile(child); total += bytes.length;
      if (total > MAX_TOTAL) throw new Error("Calibration snapshot exceeds its total byte bound");
      files.set(relative(root, child).split("\\").join("/"), bytes);
    }
  }
  await visit(root);
  return files;
}

/** Reserve a fresh destination and publish only the already-verified bytes.
 * Verification happens again against destination bytes before installation.json. */
export async function publishCalibrationSnapshot(captured, directory, installation, validatePublished) {
  if (typeof validatePublished !== "function") throw new Error("Calibration publication requires independent destination validation");
  const destination = resolve(directory);
  const files = new Map([...captured].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  if (files.has("installation.json")) throw new Error("A previously installed snapshot cannot be used as fresh calibration evidence");
  let total = 0;
  for (const [name, bytes] of files) {
    if (!name || name.split("/").some(part => !/^[A-Za-z0-9_.-]{1,200}$/u.test(part) || part === "." || part === "..") || isAbsolute(name)) throw new Error("Calibration snapshot path is unsafe");
    total += bytes.length; if (bytes.length > MAX_FILE || total > MAX_TOTAL || files.size > MAX_ENTRIES) throw new Error("Calibration snapshot exceeds its publication bound");
  }
  await mkdir(dirname(destination), { recursive: true });
  // Exclusive mkdir refuses an existing target rather than merging or replacing it.
  await mkdir(destination, { mode: 0o700 });
  if (await realpath(destination) !== destination) throw new Error("Calibration destination must not be an alias");
  for (const [name, bytes] of files) {
    const path = resolve(destination, ...name.split("/")), rel = relative(destination, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Calibration destination escaped its reserved root");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  // Validate raw observations from the actual destination, then prove that this
  // validation did not replace any of the previously checked snapshot bytes.
  await validatePublished(destination);
  const installed = await captureCalibrationSnapshot(destination);
  if (installed.size !== files.size || [...files].some(([name, bytes]) => !installed.has(name) || !installed.get(name).equals(bytes))) throw new Error("Destination differs from the verified calibration snapshot; installation was not published");
  const snapshot = [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }));
  const completed = { ...installation, snapshot };
  const marker = await open(join(destination, "installation.json"), "wx", 0o600);
  try { await marker.writeFile(JSON.stringify(completed, null, 2)); await marker.sync(); } finally { await marker.close(); }
  return completed;
}
