import { randomUUID, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseJsonBytes } from "@jevyr/core";
import { canonicalize, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import { presetSelection, validatePresetSelection, verifyGenomePreset, type PresetSelection, type SignedGenomePreset } from "./presets.js";

const MAX_BYTES = 32 * 1048576;
type Keys = ReadonlyMap<string, KeyObject | string>;
const text = (value: unknown) => canonicalize(value as JsonValue);
function sameFile(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && b.isFile() && !b.isSymbolicLink();
}
async function readStable(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw new TypeError("Preset entry must be a bounded singly-linked regular file");
  const bytes = await readFile(path), after = await lstat(path);
  if (!sameFile(before, after) || bytes.length !== before.size) throw new Error("Preset entry changed while read");
  return parseJsonBytes(bytes, "Preset registry object");
}
function readStableSync(path: string): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw new TypeError("Preset entry must be a bounded singly-linked regular file");
  const bytes = readFileSync(path), after = lstatSync(path);
  if (!sameFile(before, after) || bytes.length !== before.size) throw new Error("Preset entry changed while read");
  return parseJsonBytes(bytes, "Preset registry object");
}

/** Local operator state, never an inbound post-seal semantic capability. */
export class PresetRegistry {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(digest: string): string {
    if (!isSha256Digest(digest)) throw new TypeError("Preset digest must be canonical");
    return join(this.root, "objects", `${digest.slice(7)}.json`);
  }
  async initialize(): Promise<void> {
    for (const path of [this.root, join(this.root, "objects")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new TypeError("Preset registry must use ordinary real directories");
    }
  }
  async save(value: unknown, keys: Keys): Promise<{ digest: string; status: "STORED" | "ALREADY_PRESENT" }> {
    const signed = verifyGenomePreset(value, keys); await this.initialize();
    const path = this.path(signed.preset.digest), bytes = Buffer.from(text(signed));
    if (bytes.length > MAX_BYTES) throw new RangeError("Signed preset exceeds storage bound");
    let handle;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(signed.preset.digest, keys);
      if (text(existing) !== text(signed)) throw new Error("Preset digest is occupied by different signed bytes");
      return { digest: signed.preset.digest, status: "ALREADY_PRESENT" };
    }
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { digest: signed.preset.digest, status: "STORED" };
  }
  async read(digest: string, keys: Keys): Promise<SignedGenomePreset> {
    await this.initialize();
    const value = verifyGenomePreset(await readStable(this.path(digest)), keys);
    if (value.preset.digest !== digest) throw new Error("Preset filename and digest differ");
    return value;
  }
  async list(keys: Keys): Promise<readonly SignedGenomePreset[]> {
    await this.initialize();
    const names = await readdir(join(this.root, "objects"));
    if (names.length > 256 || names.some(name => !/^[a-f0-9]{64}\.json$/u.test(name))) throw new TypeError("Preset registry has unexpected or excessive objects");
    return await Promise.all(names.sort().map(name => this.read(`sha256:${name.slice(0, -5)}`, keys)));
  }
  async select(digest: string | null, keys: Keys): Promise<PresetSelection> {
    await this.initialize();
    if (digest !== null) await this.read(digest, keys);
    const selection = presetSelection(digest), target = join(this.root, "selection.json"), temporary = join(this.root, `selection-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text(selection)); await handle.sync(); } finally { await handle.close(); }
    try {
      try { const before = await lstat(target); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new TypeError("Preset selection target must be an ordinary file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    return selection;
  }
  /** Reads a fresh pointer; already returned selections and sealed Cases remain immutable. */
  readSelectionSync(keys: Keys): { readonly selection: PresetSelection; readonly signed?: SignedGenomePreset } {
    let selection: PresetSelection;
    try {
      for (const path of [this.root]) {
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new TypeError("Preset registry follows an unexpected link");
      }
      selection = validatePresetSelection(readStableSync(join(this.root, "selection.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return Object.freeze({ selection: presetSelection(null) });
    }
    if (selection.presetDigest === null) return Object.freeze({ selection });
    const objects = join(this.root, "objects"), info = lstatSync(objects);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(objects) !== objects) throw new TypeError("Selected preset objects directory is not ordinary");
    const signed = verifyGenomePreset(readStableSync(this.path(selection.presetDigest)), keys);
    if (signed.preset.digest !== selection.presetDigest) throw new Error("Selected preset filename and digest differ");
    return Object.freeze({ selection, signed });
  }
}
