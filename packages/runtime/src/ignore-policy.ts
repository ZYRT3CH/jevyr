import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const JEVYR_IGNORE_FILE = ".jevyrignore";
export const MAX_JEVYR_IGNORE_BYTES = 64 * 1024;

const BUILT_IN_DIRECTORIES = new Set([
  ".git",
  ".jevyr",
  "node_modules",
]);

const BUILT_IN_CREDENTIAL_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
]);

const BUILT_IN_CREDENTIAL_FILES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "_netrc",
  "application_default_credentials.json",
  "auth.json",
  "credentials",
  "credentials.ini",
  "credentials.json",
  "credentials.toml",
  "credentials.yaml",
  "credentials.yml",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const PRIVATE_KEY_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
] as const;

export type IgnoreReason =
  | "built-in-directory"
  | "built-in-credential-directory"
  | "built-in-secret-name"
  | "built-in-private-key-content"
  | "jevyrignore";

export interface IgnoreDecision {
  readonly ignored: boolean;
  readonly reason?: IgnoreReason;
  readonly ruleLine?: number;
}

interface IgnoreRule {
  readonly line: number;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

export interface JevyrIgnorePolicy {
  readonly root: string;
  readonly sourceDigest: string;
  readonly sourceBytes: number;
  readonly rules: readonly IgnoreRule[];
  decide(relativePath: string, directory: boolean): IgnoreDecision;
}

export interface SanitizedDirectoryResult {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly copiedFiles: number;
  readonly copiedBytes: number;
  readonly excluded: readonly {
    readonly path: string;
    readonly reason: IgnoreReason | "file-too-large";
    readonly ruleLine?: number;
  }[];
  readonly ignoreDigest: string;
}

function sha256(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * Converts an OS-relative path to Jevyr's one unambiguous portable form.
 * Ambiguous names are rejected instead of being silently rewritten.
 */
export function normalizeJevyrRelativePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) throw new TypeError(`Unsafe relative path: ${path}`);
  const portable = path.split(sep).join("/");
  if (portable.includes("\\")) throw new TypeError(`Backslashes are not portable path characters: ${path}`);
  const parts = portable.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Unsafe relative path segments: ${path}`);
  }
  return portable;
}

export function jevyrRelativePath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (!within(root, candidate) || !path) throw new TypeError(`Path escaped its declared root: ${candidate}`);
  return normalizeJevyrRelativePath(path);
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function globRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

function compileRule(line: string, lineNumber: number): IgnoreRule | undefined {
  let value = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!value || value.startsWith("#")) return undefined;
  if (value.startsWith("\\#") || value.startsWith("\\!")) value = value.slice(1);
  let negated = false;
  if (value.startsWith("!")) {
    negated = true;
    value = value.slice(1);
  }
  if (!value || value.includes("\0") || value.includes("\\")) {
    throw new TypeError(`${JEVYR_IGNORE_FILE}:${lineNumber} contains an unsafe or unsupported pattern`);
  }
  const directoryOnly = value.endsWith("/");
  if (directoryOnly) value = value.slice(0, -1);
  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  if (!value || value.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new TypeError(`${JEVYR_IGNORE_FILE}:${lineNumber} contains an unsafe path pattern`);
  }
  const hasSlash = value.includes("/");
  const source = globRegexSource(value);
  return {
    line: lineNumber,
    negated,
    directoryOnly,
    regex: new RegExp(hasSlash || anchored ? `^${source}$` : `(?:^|/)${source}$`, "u"),
  };
}

function builtInPathReason(path: string, directory: boolean): IgnoreReason | undefined {
  const parts = path.toLowerCase().split("/");
  if (parts.some((part) => BUILT_IN_DIRECTORIES.has(part))) return "built-in-directory";
  if (parts.some((part) => BUILT_IN_CREDENTIAL_DIRECTORIES.has(part))) return "built-in-credential-directory";
  const name = parts.at(-1) as string;
  if (name === ".env" || name.startsWith(".env.")) return "built-in-secret-name";
  if (directory) return undefined;
  if (
    BUILT_IN_CREDENTIAL_FILES.has(name) ||
    name.endsWith(".key") ||
    name.endsWith(".pem") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    /^(?:\.?(?:credential|credentials|secret|secrets)|private[-_]?key|service[-_]?account)(?:[._-][a-z0-9_-]+)*$/u.test(name)
  ) {
    return "built-in-secret-name";
  }
  return undefined;
}

export function privateKeyContentReason(data: Uint8Array): IgnoreReason | undefined {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker, 0, "ascii"))
    ? "built-in-private-key-content"
    : undefined;
}

async function readStableFile(path: string, maxBytes?: number, expectedRoot?: string): Promise<{ data: Buffer; mode: number }> {
  const first = await lstat(path);
  if (first.isSymbolicLink() || !first.isFile()) throw new TypeError(`Jevyr refuses linked or special files: ${path}`);
  if (maxBytes !== undefined && first.size > maxBytes) throw new Error(`${path} exceeds ${maxBytes} bytes`);
  const resolved = await realpath(path);
  if (expectedRoot && !within(expectedRoot, resolved)) throw new TypeError(`File resolved outside its declared root: ${path}`);
  const second = await lstat(path);
  if (second.isSymbolicLink() || !second.isFile() || first.dev !== second.dev || first.ino !== second.ino) {
    throw new Error(`File changed while Jevyr was resolving it: ${path}`);
  }
  const handle = await open(resolved, "r");
  try {
    const before = await handle.stat();
    const data = await handle.readFile();
    const after = await handle.stat();
    if (
      !before.isFile() ||
      !after.isFile() ||
      before.dev !== second.dev ||
      before.ino !== second.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      data.byteLength !== after.size
    ) {
      throw new Error(`File changed while Jevyr was reading it: ${path}`);
    }
    return { data, mode: after.mode };
  } finally {
    await handle.close();
  }
}

export async function loadJevyrIgnorePolicy(
  rootInput: string,
  maxBytes = MAX_JEVYR_IGNORE_BYTES,
): Promise<JevyrIgnorePolicy> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("max ignore bytes must be a positive safe integer");
  const root = await realpath(resolve(rootInput));
  const source = join(root, JEVYR_IGNORE_FILE);
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    data = (await readStableFile(source, maxBytes, root)).data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return compileJevyrIgnorePolicy(root, data, maxBytes);
}

/**
 * Compiles caller-verified policy bytes. This pure boundary lets a synchronous
 * daemon bootstrap bind the exact output policy before any Case can be cast.
 */
export function compileJevyrIgnorePolicy(
  rootInput: string,
  sourceBytes: Uint8Array,
  maxBytes = MAX_JEVYR_IGNORE_BYTES,
): JevyrIgnorePolicy {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("max ignore bytes must be a positive safe integer");
  const root = resolve(rootInput);
  const data = Buffer.from(sourceBytes);
  if (data.byteLength > maxBytes) throw new Error(`${JEVYR_IGNORE_FILE} exceeds ${maxBytes} bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new TypeError(`${JEVYR_IGNORE_FILE} must be valid UTF-8`);
  }
  const rules = Object.freeze(
    text.split("\n")
      .map((line, index) => compileRule(line, index + 1))
      .filter((rule): rule is IgnoreRule => rule !== undefined),
  );
  return Object.freeze({
    root,
    sourceDigest: sha256(data),
    sourceBytes: data.byteLength,
    rules,
    decide(relativePath: string, directory: boolean): IgnoreDecision {
      const path = normalizeJevyrRelativePath(relativePath);
      // The control file is always copied and hashed so the effective policy is
      // itself bound to the sanitized tree.
      if (path === JEVYR_IGNORE_FILE) return { ignored: false };
      const protectedReason = builtInPathReason(path, directory);
      if (protectedReason) return { ignored: true, reason: protectedReason };
      let ignored = false;
      let matching: IgnoreRule | undefined;
      for (const rule of rules) {
        if (rule.directoryOnly && !directory) continue;
        if (!rule.regex.test(path)) continue;
        ignored = !rule.negated;
        matching = rule;
      }
      return ignored
        ? { ignored: true, reason: "jevyrignore", ...(matching ? { ruleLine: matching.line } : {}) }
        : { ignored: false };
    },
  });
}

/**
 * Copies only policy-visible regular files into a new directory. It never
 * follows a link, crosses a filesystem boundary, or copies secret key bytes.
 */
export async function copySanitizedDirectory(
  sourceInput: string,
  destinationInput: string,
  limits: { readonly maxFiles: number; readonly maxFileBytes: number },
): Promise<SanitizedDirectoryResult> {
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) throw new TypeError("maxFiles must be a positive safe integer");
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1) throw new TypeError("maxFileBytes must be a positive safe integer");
  const sourceRoot = await realpath(resolve(sourceInput));
  const sourceInfo = await lstat(sourceRoot);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new TypeError("Sanitized-copy source must be a real directory");
  const destinationRoot = resolve(destinationInput);
  if (within(sourceRoot, destinationRoot)) throw new TypeError("Sanitized-copy destination must be outside the source tree");
  const destinationParent = await realpath(dirname(destinationRoot));
  if (within(sourceRoot, destinationParent)) throw new TypeError("Sanitized-copy destination parent must be outside the source tree");
  const policy = await loadJevyrIgnorePolicy(sourceRoot);
  const excluded: Array<{ path: string; reason: IgnoreReason | "file-too-large"; ruleLine?: number }> = [];
  let copiedFiles = 0;
  let copiedBytes = 0;
  await mkdir(destinationRoot, { recursive: false });

  const walk = async (sourceDirectory: string): Promise<void> => {
    const directoryInfo = await lstat(sourceDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new TypeError(`Jevyr refuses linked or special directories: ${sourceDirectory}`);
    }
    if (directoryInfo.dev !== sourceInfo.dev) throw new TypeError(`Jevyr refuses filesystem boundary crossings: ${sourceDirectory}`);
    const resolvedDirectory = await realpath(sourceDirectory);
    if (!within(sourceRoot, resolvedDirectory)) throw new TypeError(`Directory resolved outside its source root: ${sourceDirectory}`);
    const resolvedInfo = await lstat(resolvedDirectory);
    if (!resolvedInfo.isDirectory() || resolvedInfo.dev !== directoryInfo.dev || resolvedInfo.ino !== directoryInfo.ino) {
      throw new Error(`Directory changed while Jevyr was resolving it: ${sourceDirectory}`);
    }
    const children = (await readdir(resolvedDirectory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const source = resolve(resolvedDirectory, child.name);
      if (!within(sourceRoot, source)) throw new TypeError(`Copy entry escaped its source root: ${source}`);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new TypeError(`Forge refuses symbolic links or junctions: ${source}`);
      const path = jevyrRelativePath(sourceRoot, source);
      const directory = info.isDirectory();
      const decision = policy.decide(path, directory);
      if (decision.ignored) {
        excluded.push({ path, reason: decision.reason as IgnoreReason, ...(decision.ruleLine ? { ruleLine: decision.ruleLine } : {}) });
        continue;
      }
      const destination = resolve(destinationRoot, ...path.split("/"));
      if (!within(destinationRoot, destination)) throw new TypeError(`Copy destination escaped its root: ${destination}`);
      if (directory) {
        if (info.dev !== sourceInfo.dev) throw new TypeError(`Forge refuses filesystem boundary crossings: ${source}`);
        await mkdir(destination, { recursive: false, mode: info.mode & 0o777 });
        await walk(source);
      } else if (info.isFile()) {
        if (path !== JEVYR_IGNORE_FILE && info.size > limits.maxFileBytes) {
          excluded.push({ path, reason: "file-too-large" });
          continue;
        }
        const stable = await readStableFile(
          source,
          path === JEVYR_IGNORE_FILE ? MAX_JEVYR_IGNORE_BYTES : limits.maxFileBytes,
          sourceRoot,
        );
        const contentReason = privateKeyContentReason(stable.data);
        if (contentReason) {
          excluded.push({ path, reason: contentReason });
          continue;
        }
        if (copiedFiles >= limits.maxFiles) throw new Error(`Forge source exceeds ${limits.maxFiles} files`);
        await writeFile(destination, stable.data, { flag: "wx", mode: stable.mode & 0o777 });
        copiedFiles += 1;
        copiedBytes += stable.data.byteLength;
      } else {
        throw new TypeError(`Forge refuses special filesystem entries: ${source}`);
      }
    }
  };

  await walk(sourceRoot);
  const endingPolicy = await loadJevyrIgnorePolicy(sourceRoot);
  if (endingPolicy.sourceDigest !== policy.sourceDigest) throw new Error(`${JEVYR_IGNORE_FILE} changed during the sanitized copy`);
  excluded.sort((left, right) => compareText(left.path, right.path) || compareText(left.reason, right.reason));
  return Object.freeze({
    sourceRoot,
    destinationRoot,
    copiedFiles,
    copiedBytes,
    excluded: Object.freeze(excluded.map((entry) => Object.freeze(entry))),
    ignoreDigest: policy.sourceDigest,
  });
}
