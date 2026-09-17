import { spawn } from "node:child_process";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  digestJson,
  isSha256Digest,
  sha256Digest,
  type JsonValue,
  type SubjectReference,
  type SubjectSnapshot,
} from "@jevyr/protocol";
import { loadJevyrIgnorePolicy, privateKeyContentReason } from "./ignore-policy.js";

const DEFAULT_DIRECTORY_FILES = 100_000;
const DEFAULT_DIRECTORY_BYTES = 1_000_000_000;
const DEFAULT_GIT_OUTPUT_BYTES = 128_000_000;
const DEFAULT_URL_BYTES = 25_000_000;

export interface UrlSnapshotPolicy {
  /** Declaration is the safe default and performs no network I/O. */
  readonly mode?: "declaration" | "fetch";
  /** Fetch mode requires every initial and redirected origin to appear here exactly. */
  readonly allowedOrigins?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export interface SubjectSnapshotPolicy {
  readonly maxDirectoryFiles?: number;
  readonly maxDirectoryBytes?: number;
  readonly maxGitOutputBytes?: number;
  readonly gitCommand?: string;
  readonly url?: UrlSnapshotPolicy;
}

export interface ArtifactSnapshotSource {
  readonly id: string;
  readonly caseId: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: string;
  readonly data: Uint8Array;
}

export interface SubjectSnapshotDependencies {
  readonly resolveArtifact: (caseId: string, artifactId: string) => Promise<ArtifactSnapshotSource | undefined>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface NormalizedSubjectSnapshotPolicy {
  readonly maxDirectoryFiles: number;
  readonly maxDirectoryBytes: number;
  readonly maxGitOutputBytes: number;
  readonly gitCommand: string;
  readonly url: {
    readonly mode: "declaration" | "fetch";
    readonly allowedOrigins: readonly string[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly maxRedirects: number;
  };
}

interface ManifestFile {
  readonly path: string;
  readonly type: "file";
  readonly digest: string;
  readonly byteLength: number;
}

interface ManifestDirectory {
  readonly path: string;
  readonly type: "directory";
}

type ManifestEntry = ManifestFile | ManifestDirectory;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return resolved;
}

export function normalizeSubjectSnapshotPolicy(policy: SubjectSnapshotPolicy = {}): NormalizedSubjectSnapshotPolicy {
  const mode = policy.url?.mode ?? "declaration";
  const allowedOrigins = [...new Set((policy.url?.allowedOrigins ?? []).map(normalizeOrigin))].sort(compareText);
  if (mode === "fetch" && allowedOrigins.length === 0) {
    throw new TypeError("URL fetch mode requires at least one exact allowed origin");
  }
  return Object.freeze({
    maxDirectoryFiles: positiveInteger(policy.maxDirectoryFiles, DEFAULT_DIRECTORY_FILES, "maxDirectoryFiles"),
    maxDirectoryBytes: positiveInteger(policy.maxDirectoryBytes, DEFAULT_DIRECTORY_BYTES, "maxDirectoryBytes"),
    maxGitOutputBytes: positiveInteger(policy.maxGitOutputBytes, DEFAULT_GIT_OUTPUT_BYTES, "maxGitOutputBytes"),
    gitCommand: policy.gitCommand?.trim() || "git",
    url: Object.freeze({
      mode,
      allowedOrigins: Object.freeze(allowedOrigins),
      maxBytes: positiveInteger(policy.url?.maxBytes, DEFAULT_URL_BYTES, "url.maxBytes"),
      timeoutMs: positiveInteger(policy.url?.timeoutMs, 30_000, "url.timeoutMs"),
      maxRedirects: policy.url?.maxRedirects === undefined
        ? 3
        : nonNegativeInteger(policy.url.maxRedirects, "url.maxRedirects"),
    }),
  });
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid URL snapshot origin: ${value}`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError(`URL snapshot allowlist entries must be bare origins: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`URL snapshot origins must use HTTP or HTTPS: ${value}`);
  }
  return url.origin;
}

function canonicalUrl(locator: string): URL {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new TypeError(`Invalid URL subject locator: ${locator}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("URL subjects must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new TypeError("URL subjects may not contain embedded credentials");
  return url;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function portableRelative(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (!path || !within(root, candidate)) throw new TypeError(`Snapshot path escaped its declared root: ${candidate}`);
  return path.split(sep).join("/");
}

async function assertNonSymlinkRoot(locator: string, expected: "file" | "directory"): Promise<string> {
  const absolute = resolve(locator);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new TypeError(`${expected} subject roots may not be symbolic links or junctions`);
  if (expected === "file" && !info.isFile()) throw new TypeError(`File subject is not a regular file: ${absolute}`);
  if (expected === "directory" && !info.isDirectory()) throw new TypeError(`Directory subject is not a directory: ${absolute}`);
  return await realpath(absolute);
}

async function readStableFile(path: string, root?: string): Promise<{ data: Buffer; resolved: string }> {
  const first = await lstat(path);
  if (first.isSymbolicLink()) throw new TypeError(`Snapshot refuses symbolic links: ${path}`);
  if (!first.isFile()) throw new TypeError(`Snapshot refuses non-regular files: ${path}`);
  const resolved = await realpath(path);
  if (root !== undefined && !within(root, resolved)) throw new TypeError(`Snapshot path escaped its declared root: ${path}`);
  const second = await lstat(path);
  if (second.isSymbolicLink() || !second.isFile()) throw new TypeError(`Snapshot file type changed while resolving: ${path}`);

  const handle = await open(resolved, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new TypeError(`Snapshot refuses non-regular files: ${path}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      data.byteLength !== after.size
    ) {
      throw new Error(`File changed while it was being snapshotted: ${path}`);
    }
    return { data, resolved };
  } finally {
    await handle.close();
  }
}

async function fileSnapshot(subject: SubjectReference, capturedAt: string): Promise<SubjectSnapshot> {
  const root = await assertNonSymlinkRoot(subject.locator, "file");
  const { data, resolved } = await readStableFile(root);
  const digest = sha256Digest(data);
  assertExpectedDigest(subject, digest);
  return {
    subjectId: subject.id,
    digest,
    resolvedLocator: resolved,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: data.byteLength,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

function textSnapshot(subject: SubjectReference, capturedAt: string): SubjectSnapshot {
  const bytes = Buffer.from(subject.locator, "utf8");
  const digest = sha256Digest(bytes);
  assertExpectedDigest(subject, digest);
  return {
    subjectId: subject.id,
    digest,
    resolvedLocator: `inline:${subject.id}`,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: bytes.byteLength,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

function assertExpectedDigest(subject: SubjectReference, observed: string): void {
  if (subject.revision !== undefined && isSha256Digest(subject.revision) && subject.revision !== observed) {
    throw new Error(`Subject ${subject.id} content does not match its declared revision digest`);
  }
}

async function directorySnapshot(
  subject: SubjectReference,
  capturedAt: string,
  policy: NormalizedSubjectSnapshotPolicy,
): Promise<SubjectSnapshot> {
  const root = await assertNonSymlinkRoot(subject.locator, "directory");
  const ignorePolicy = await loadJevyrIgnorePolicy(root);
  const rootDevice = (await lstat(root)).dev;
  const entries: ManifestEntry[] = [];
  let files = 0;
  let bytes = 0;

  const walk = async (directory: string): Promise<void> => {
    if (!within(root, directory)) throw new TypeError(`Directory traversal escaped its root: ${directory}`);
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) throw new TypeError(`Snapshot refuses linked or special directories: ${directory}`);
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      if (!within(root, absolute)) throw new TypeError(`Directory entry escaped its root: ${absolute}`);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new TypeError(`Directory snapshots refuse symbolic links or junctions: ${absolute}`);
      if (info.dev !== rootDevice) throw new TypeError(`Directory snapshots refuse filesystem boundary crossings: ${absolute}`);
      const portablePath = portableRelative(root, absolute);
      const ignore = ignorePolicy.decide(portablePath, info.isDirectory());
      if (ignore.ignored) continue;
      if (info.isDirectory()) {
        const resolved = await realpath(absolute);
        if (!within(root, resolved)) throw new TypeError(`Directory entry resolved outside its root: ${absolute}`);
        entries.push({ path: portableRelative(root, resolved), type: "directory" });
        await walk(resolved);
      } else if (info.isFile()) {
        const stable = await readStableFile(absolute, root);
        if (privateKeyContentReason(stable.data)) continue;
        files += 1;
        if (files > policy.maxDirectoryFiles) throw new Error(`Directory subject exceeds ${policy.maxDirectoryFiles} files`);
        bytes += stable.data.byteLength;
        if (bytes > policy.maxDirectoryBytes) throw new Error(`Directory subject exceeds ${policy.maxDirectoryBytes} bytes`);
        entries.push({
          path: portableRelative(root, stable.resolved),
          type: "file",
          digest: sha256Digest(stable.data),
          byteLength: stable.data.byteLength,
        });
      } else {
        throw new TypeError(`Directory snapshots refuse special filesystem entries: ${absolute}`);
      }
    }
    const after = await lstat(directory);
    if (after.isSymbolicLink() || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Directory changed while it was being snapshotted: ${directory}`);
    }
  };

  await walk(root);
  entries.sort((left, right) => compareText(left.path, right.path) || compareText(left.type, right.type));
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const stable = await readStableFile(resolve(root, ...entry.path.split("/")), root);
    if (stable.data.byteLength !== entry.byteLength || sha256Digest(stable.data) !== entry.digest) {
      throw new Error(`Directory file changed during snapshot: ${entry.path}`);
    }
  }
  const endingIgnorePolicy = await loadJevyrIgnorePolicy(root);
  if (endingIgnorePolicy.sourceDigest !== ignorePolicy.sourceDigest) {
    throw new Error(".jevyrignore changed while the directory was being snapshotted");
  }
  const digest = digestJson({ protocol: "jevyr.directory-manifest/1", entries } as unknown as JsonValue);
  assertExpectedDigest(subject, digest);
  return {
    subjectId: subject.id,
    digest,
    resolvedLocator: root,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: bytes,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function runReadOnlyCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  maxBytes: number,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => finishError(new Error(`Read-only command timed out: ${command}`)), 30_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) return finishError(new Error(`Read-only command exceeded ${maxBytes} output bytes`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > Math.min(maxBytes, 2_000_000)) return finishError(new Error("Read-only command produced excessive diagnostic output"));
      stderr.push(chunk);
    });
    child.on("error", finishError);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const error = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
      if (code !== 0) return reject(new Error(`${command} exited ${code}: ${error || "no diagnostic"}`));
      resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function singleLine(result: CommandResult, label: string): string {
  const value = result.stdout.toString("utf8").trim();
  if (!value || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Git returned an invalid ${label}`);
  }
  return value;
}

function safeRevision(revision: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,1023}$/u.test(revision) || revision.startsWith("-")) {
    throw new TypeError("Git subject revision contains unsafe or unsupported characters");
  }
  return revision;
}

function nulPaths(output: Buffer): string[] {
  const parts = output.subarray(0, output.at(-1) === 0 ? -1 : undefined).toString("utf8").split("\0").filter(Boolean);
  for (const part of parts) {
    if (part.includes("�") || part.includes("\0")) throw new TypeError("Git path output is not unambiguous UTF-8");
  }
  return parts.sort(compareText);
}

async function gitSnapshot(
  subject: SubjectReference,
  capturedAt: string,
  policy: NormalizedSubjectSnapshotPolicy,
): Promise<SubjectSnapshot> {
  const locator = await assertNonSymlinkRoot(subject.locator, "directory");
  const git = async (args: readonly string[]) => await runReadOnlyCommand(
    policy.gitCommand,
    ["-c", "core.fsmonitor=false", "-C", locator, ...args],
    locator,
    policy.maxGitOutputBytes,
  );
  const reportedRoot = singleLine(await git(["rev-parse", "--show-toplevel"]), "repository root");
  const root = await realpath(reportedRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new TypeError("Git repository root is not a safe directory");
  if (root !== locator) throw new TypeError("Git subject locator must name the repository root, not a nested path");

  const declaredRevision = safeRevision(subject.revision ?? "HEAD");
  const commitOid = singleLine(await git(["rev-parse", "--verify", `${declaredRevision}^{commit}`]), "commit id");
  const treeOid = singleLine(await git(["rev-parse", "--verify", `${commitOid}^{tree}`]), "tree id");
  const headOid = singleLine(await git(["rev-parse", "--verify", "HEAD^{commit}"]), "HEAD commit id");
  const captureWorktree = async () => {
    const status = (await git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
    const diff = (await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", commitOid, "--"])).stdout;
    const untrackedPaths = nulPaths((await git(["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
    const untracked: ManifestFile[] = [];
    let untrackedBytes = 0;
    for (const path of untrackedPaths) {
      const absolute = resolve(root, path);
      if (!within(root, absolute)) throw new TypeError(`Untracked Git path escaped its repository: ${path}`);
      const stable = await readStableFile(absolute, root);
      untrackedBytes += stable.data.byteLength;
      if (untrackedBytes > policy.maxDirectoryBytes) throw new Error(`Untracked Git content exceeds ${policy.maxDirectoryBytes} bytes`);
      untracked.push({ path: portableRelative(root, stable.resolved), type: "file", digest: sha256Digest(stable.data), byteLength: stable.data.byteLength });
    }
    return {
      status,
      diff,
      statusDigest: sha256Digest(status),
      diffDigest: sha256Digest(diff),
      untracked,
    };
  };
  const first = await captureWorktree();
  const second = await captureWorktree();
  const firstCaptureDigest = digestJson({ statusDigest: first.statusDigest, diffDigest: first.diffDigest, untracked: first.untracked } as unknown as JsonValue);
  const secondCaptureDigest = digestJson({ statusDigest: second.statusDigest, diffDigest: second.diffDigest, untracked: second.untracked } as unknown as JsonValue);
  const endingHeadOid = singleLine(await git(["rev-parse", "--verify", "HEAD^{commit}"]), "ending HEAD commit id");
  if (firstCaptureDigest !== secondCaptureDigest || endingHeadOid !== headOid) {
    throw new Error("Git repository changed while it was being snapshotted");
  }
  const { status, diff, statusDigest, diffDigest, untracked } = second;
  const dirty = status.byteLength > 0 || diff.byteLength > 0 || headOid !== commitOid || untracked.length > 0;
  const dirtyDigest = digestJson({ statusDigest, diffDigest, untracked } as unknown as JsonValue);
  const digest = digestJson({
    protocol: "jevyr.git-snapshot/1",
    commitOid,
    treeOid,
    headOid,
    statusDigest,
    diffDigest,
    untracked,
    dirty,
  } as unknown as JsonValue);
  return {
    subjectId: subject.id,
    digest,
    resolvedLocator: root,
    revision: dirty ? `${commitOid}+dirty.${dirtyDigest.slice("sha256:".length, "sha256:".length + 16)}` : commitOid,
    capturedAt,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

function urlDeclarationSnapshot(subject: SubjectReference, capturedAt: string): SubjectSnapshot {
  const url = canonicalUrl(subject.locator);
  const normalized = url.toString();
  return {
    subjectId: subject.id,
    digest: digestJson({
      protocol: "jevyr.url-declaration/1",
      locator: normalized,
      ...(subject.revision === undefined ? {} : { revision: subject.revision }),
      ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
    }),
    resolvedLocator: `declaration:${normalized}`,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

function gitDeclarationSnapshot(subject: SubjectReference, capturedAt: string): SubjectSnapshot {
  const raw = subject.locator.trim();
  if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) throw new TypeError("Remote Git locator is empty or contains control characters");
  let normalized = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new TypeError(`Invalid remote Git locator: ${raw}`);
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      throw new TypeError(`Unsupported remote Git protocol: ${url.protocol}`);
    }
    if (url.password) throw new TypeError("Remote Git locators may not embed passwords");
    if ((url.protocol === "https:" || url.protocol === "http:") && url.username) {
      throw new TypeError("HTTP Git locators may not embed credentials");
    }
    normalized = url.toString();
  } else if (!/^[^/@\s]+@[^:\s]+:.+$/u.test(raw)) {
    throw new TypeError(`Unsupported remote Git locator: ${raw}`);
  }
  return {
    subjectId: subject.id,
    digest: digestJson({
      protocol: "jevyr.git-declaration/1",
      locator: normalized,
      ...(subject.revision === undefined ? {} : { revision: subject.revision }),
      ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
    }),
    resolvedLocator: `declaration:${normalized}`,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`URL subject exceeds ${maxBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error(`URL subject exceeds ${maxBytes} bytes`);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function urlSnapshot(
  subject: SubjectReference,
  capturedAt: string,
  policy: NormalizedSubjectSnapshotPolicy,
  fetchImpl: typeof globalThis.fetch,
): Promise<SubjectSnapshot> {
  if (policy.url.mode === "declaration") return urlDeclarationSnapshot(subject, capturedAt);
  const allowed = new Set(policy.url.allowedOrigins);
  let current = canonicalUrl(subject.locator);
  current.hash = "";
  let response: Response | undefined;
  for (let redirects = 0; redirects <= policy.url.maxRedirects; redirects += 1) {
    if (!allowed.has(current.origin)) throw new Error(`URL subject origin is not explicitly allowed: ${current.origin}`);
    response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(policy.url.timeoutMs),
      headers: { accept: "*/*", "cache-control": "no-cache" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("URL subject redirect omitted Location");
    if (redirects === policy.url.maxRedirects) throw new Error("URL subject exceeded its redirect limit");
    current = canonicalUrl(new URL(location, current).toString());
    current.hash = "";
  }
  if (!response || !response.ok) throw new Error(`URL subject fetch failed with HTTP ${response?.status ?? "unknown"}`);
  const data = await responseBytes(response, policy.url.maxBytes);
  const digest = sha256Digest(data);
  const etag = response.headers.get("etag") ?? undefined;
  if (subject.revision !== undefined) {
    const matches = isSha256Digest(subject.revision) ? subject.revision === digest : etag === subject.revision;
    if (!matches) throw new Error(`URL subject ${subject.id} does not match its declared revision`);
  }
  return {
    subjectId: subject.id,
    digest,
    resolvedLocator: current.toString(),
    ...(subject.revision === undefined && etag === undefined ? {} : { revision: subject.revision ?? etag as string }),
    capturedAt,
    byteLength: data.byteLength,
    mediaType: subject.mediaType ?? response.headers.get("content-type") ?? "application/octet-stream",
  };
}

function parseArtifactLocator(locator: string): { caseId: string; artifactId: string } {
  const match = locator.match(/^((?:case|jvr)_[A-Za-z0-9_-]{8,128})\/(artifact_[a-f0-9]{24})$/u);
  if (!match?.[1] || !match[2]) {
    throw new TypeError("Artifact subject locator must be caseId/artifactId");
  }
  return { caseId: match[1], artifactId: match[2] };
}

async function artifactSnapshot(
  subject: SubjectReference,
  capturedAt: string,
  resolveArtifact: SubjectSnapshotDependencies["resolveArtifact"],
): Promise<SubjectSnapshot> {
  const address = parseArtifactLocator(subject.locator);
  const artifact = await resolveArtifact(address.caseId, address.artifactId);
  if (!artifact) throw new Error(`Artifact subject does not exist: ${subject.locator}`);
  if (artifact.caseId !== address.caseId || artifact.id !== address.artifactId) throw new Error("Artifact metadata identity does not match its address");
  const observedDigest = sha256Digest(artifact.data);
  if (artifact.digest !== observedDigest || artifact.size !== artifact.data.byteLength) {
    throw new Error(`Artifact ${subject.locator} failed content-address verification`);
  }
  if (subject.revision !== undefined && subject.revision !== artifact.digest) {
    throw new Error(`Artifact subject ${subject.id} does not match its declared revision`);
  }
  return {
    subjectId: subject.id,
    digest: artifact.digest,
    resolvedLocator: `jevyr:artifact:${address.caseId}/${address.artifactId}`,
    revision: artifact.digest,
    capturedAt,
    byteLength: artifact.size,
    mediaType: subject.mediaType ?? artifact.mediaType,
  };
}

function looksRemoteGit(locator: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^/@\s]+@[^:\s]+:)/iu.test(locator);
}

export async function resolveSubjectSnapshots(
  subjects: readonly SubjectReference[],
  capturedAt: string,
  policyInput: SubjectSnapshotPolicy,
  dependencies: SubjectSnapshotDependencies,
): Promise<readonly SubjectSnapshot[]> {
  const policy = normalizeSubjectSnapshotPolicy(policyInput);
  const snapshots: SubjectSnapshot[] = [];
  // Resolve serially so resource ceilings and errors are deterministic by subject id.
  for (const subject of [...subjects].sort((left, right) => compareText(left.id, right.id))) {
    switch (subject.kind) {
      case "file":
        snapshots.push(await fileSnapshot(subject, capturedAt));
        break;
      case "text":
        snapshots.push(textSnapshot(subject, capturedAt));
        break;
      case "directory":
        snapshots.push(await directorySnapshot(subject, capturedAt, policy));
        break;
      case "git":
        snapshots.push(looksRemoteGit(subject.locator)
          ? gitDeclarationSnapshot(subject, capturedAt)
          : await gitSnapshot(subject, capturedAt, policy));
        break;
      case "url":
        snapshots.push(await urlSnapshot(subject, capturedAt, policy, dependencies.fetch ?? globalThis.fetch));
        break;
      case "artifact":
        snapshots.push(await artifactSnapshot(subject, capturedAt, dependencies.resolveArtifact));
        break;
    }
  }
  return snapshots;
}
