import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  constants as fsConstants,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalize,
  digestJson,
  isSha256Digest,
  sha256Digest,
  type JsonValue,
  type SubjectReference,
  type SubjectSnapshot,
} from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import {
  jevyrRelativePath,
  loadJevyrIgnorePolicy,
  normalizeJevyrRelativePath,
  privateKeyContentReason,
  type IgnoreReason,
} from "./ignore-policy.js";
import {
  normalizeSubjectSnapshotPolicy,
  resolveSubjectSnapshots,
  type NormalizedSubjectSnapshotPolicy,
  type SubjectSnapshotDependencies,
  type SubjectSnapshotPolicy,
} from "./subjects.js";

export const SUBJECT_MATERIAL_PROTOCOL = "jevyr.subject-material/1" as const;
export const SUBJECT_MATERIAL_CAPTURE_PROTOCOL = "jevyr.subject-material-capture/1" as const;
export const SUBJECT_TEXT_PROJECTION_PROTOCOL = "jevyr.subject-text-projection/1" as const;
export const SUBJECT_MATERIALIZATION_PROTOCOL = "jevyr.subject-materialization/1" as const;

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROJECTION_FILE_BYTES = 96 * 1024;
const DEFAULT_PROJECTION_TOTAL_BYTES = 512 * 1024;
const DEFAULT_PROJECTION_FILES = 256;
const STREAM_CHUNK_BYTES = 64 * 1024;

export type SubjectMaterialAvailability = "MATERIALIZED" | "DECLARATION_ONLY";

export type SubjectMaterialOmissionReason =
  | IgnoreReason
  | "REMOTE_DECLARATION"
  | "URL_FETCH_DISABLED"
  | "DIRECT_SUBJECT_EXCLUDED"
  | "GIT_PATH_EXCLUDED"
  | "GIT_DELETION_REQUIRES_BASE_OBJECTS"
  | "GIT_LINK_OR_SPECIAL_ENTRY"
  | "GIT_FILESYSTEM_BOUNDARY"
  | "GIT_STATE_CHANGED";

export interface SubjectMaterialEntry {
  readonly path: string;
  readonly blobDigest: string;
  readonly byteLength: number;
  /** Original regular-file permission bits, stripped to rwx bits on output. */
  readonly mode: number;
  readonly mediaType?: string;
}

export interface SubjectMaterialOmission {
  /** Subject-relative only. Original locators are never persisted in material manifests. */
  readonly path?: string;
  readonly reason: SubjectMaterialOmissionReason;
  readonly ruleLine?: number;
}

export interface SubjectMaterialManifest {
  readonly protocol: typeof SUBJECT_MATERIAL_PROTOCOL;
  readonly subjectId: string;
  readonly subjectKind: SubjectReference["kind"];
  readonly subjectDigest: string;
  readonly availability: SubjectMaterialAvailability;
  readonly byteLength: number;
  readonly entries: readonly SubjectMaterialEntry[];
  readonly directories: readonly string[];
  readonly omissions: readonly SubjectMaterialOmission[];
  readonly revision?: string;
  readonly mediaType?: string;
  readonly ignorePolicyDigest?: string;
  readonly declarationReason?: SubjectMaterialOmissionReason;
}

export interface SubjectMaterialBinding {
  readonly subjectId: string;
  readonly subjectKind: SubjectReference["kind"];
  readonly subjectDigest: string;
  readonly availability: SubjectMaterialAvailability;
  readonly manifestDigest: string;
  readonly byteLength: number;
}

export interface SubjectMaterialCaptureResult {
  readonly protocol: typeof SUBJECT_MATERIAL_CAPTURE_PROTOCOL;
  readonly snapshots: readonly SubjectSnapshot[];
  readonly bindings: readonly SubjectMaterialBinding[];
  readonly captureDigest: string;
}

export interface SubjectMaterialCapturePolicy {
  /** Hard ceiling for any one captured source file or in-memory byte subject. */
  readonly maxFileBytes?: number;
  /** Hard ceiling across the subject bytes inspected in one capture call. */
  readonly maxTotalBytes?: number;
  /** Bounds persisted material metadata as well as metadata reads. */
  readonly maxManifestBytes?: number;
}

export interface SubjectTextProjectionOptions {
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
}

export type SubjectTextOmissionReason =
  | "DECLARATION_ONLY"
  | "POLICY_EXCLUDED"
  | "INVALID_UTF8"
  | "BINARY_CONTROL_BYTES"
  | "PER_FILE_LIMIT"
  | "TOTAL_LIMIT"
  | "FILE_COUNT_LIMIT";

export interface SubjectTextFile {
  readonly subjectId: string;
  readonly path: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly text: string;
  readonly mediaType?: string;
}

export interface SubjectTextOmission {
  readonly subjectId: string;
  readonly path?: string;
  readonly reason: SubjectTextOmissionReason;
  readonly sourceDigest?: string;
  readonly sourceByteLength?: number;
  readonly policyReason?: SubjectMaterialOmissionReason;
  readonly omissionDigest: string;
}

export interface SubjectTextProjection {
  readonly protocol: typeof SUBJECT_TEXT_PROJECTION_PROTOCOL;
  readonly files: readonly SubjectTextFile[];
  readonly omissions: readonly SubjectTextOmission[];
  readonly manifestDigests: readonly string[];
  readonly includedBytes: number;
  readonly limits: {
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly maxFiles: number;
  };
  readonly projectionDigest: string;
}

export interface MaterializedSubject {
  readonly subjectId: string;
  readonly availability: SubjectMaterialAvailability;
  /** Synthetic, destination-relative root. It is unrelated to the source locator. */
  readonly relativeRoot?: string;
  readonly manifestDigest: string;
  readonly files: number;
  readonly byteLength: number;
}

export interface SubjectMaterializationResult {
  readonly protocol: typeof SUBJECT_MATERIALIZATION_PROTOCOL;
  readonly subjects: readonly MaterializedSubject[];
  readonly materializationDigest: string;
}

interface NormalizedMaterialPolicy {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
}

interface StoredFileInspection {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly privateKey: boolean;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mode: number;
}

interface CapturedSubject {
  readonly snapshot: SubjectSnapshot;
  readonly manifest: SubjectMaterialManifest;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isSafeInteger(resolvedValue) || resolvedValue < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolvedValue;
}

function normalizeMaterialPolicy(policy: SubjectMaterialCapturePolicy): NormalizedMaterialPolicy {
  return Object.freeze({
    maxFileBytes: positiveInteger(policy.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxTotalBytes: positiveInteger(policy.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes"),
    maxManifestBytes: positiveInteger(policy.maxManifestBytes, DEFAULT_MAX_MANIFEST_BYTES, "maxManifestBytes"),
  });
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function digestHex(digest: string): string {
  if (!isSha256Digest(digest)) throw new TypeError(`Invalid SHA-256 digest: ${digest}`);
  return digest.slice("sha256:".length);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function statsIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    mode: stats.mode,
  };
}

async function resolveStableFilesystemEntry(
  input: string,
  expected: "file" | "directory",
  expectedRoot?: string,
  expectedDevice?: number,
  expectedIdentity?: FileIdentity,
): Promise<{ readonly input: string; readonly resolved: string; readonly identity: FileIdentity }> {
  const absolute = resolve(input);
  const first = await lstat(absolute);
  const validFirst = expected === "file" ? first.isFile() : first.isDirectory();
  if (first.isSymbolicLink() || !validFirst) throw new TypeError(`Subject material refuses linked or special ${expected}: ${absolute}`);
  const firstIdentity = statsIdentity(first);
  if (expectedIdentity !== undefined && !sameIdentity(firstIdentity, expectedIdentity)) {
    throw new Error(`Subject material ${expected} changed before resolution: ${absolute}`);
  }
  if (expectedDevice !== undefined && first.dev !== expectedDevice) {
    throw new TypeError(`Subject material refuses filesystem boundary crossings: ${absolute}`);
  }
  const resolvedEntry = await realpath(absolute);
  if (expectedRoot !== undefined && !within(expectedRoot, resolvedEntry)) {
    throw new TypeError(`Subject material ${expected} resolved outside its declared root: ${absolute}`);
  }
  const [second, resolvedInfo] = await Promise.all([lstat(absolute), lstat(resolvedEntry)]);
  const validSecond = expected === "file" ? second.isFile() : second.isDirectory();
  const validResolved = expected === "file" ? resolvedInfo.isFile() : resolvedInfo.isDirectory();
  if (second.isSymbolicLink() || resolvedInfo.isSymbolicLink() || !validSecond || !validResolved
    || !sameIdentity(statsIdentity(second), firstIdentity)
    || !sameIdentity(statsIdentity(resolvedInfo), firstIdentity)) {
    throw new Error(`Subject material ${expected} changed while being resolved: ${absolute}`);
  }
  return { input: absolute, resolved: resolvedEntry, identity: firstIdentity };
}

function assertExpectedDigest(subject: SubjectReference, observed: string): void {
  if (subject.revision !== undefined && isSha256Digest(subject.revision) && subject.revision !== observed) {
    throw new Error(`Subject ${subject.id} content does not match its declared revision digest`);
  }
}

class CaptureBudget {
  private used = 0;

  public constructor(private readonly ceiling: number) {}

  public add(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Capture byte accounting received an invalid size");
    if (this.used + bytes > this.ceiling) throw new Error(`Subject material capture exceeds ${this.ceiling} total bytes`);
    this.used += bytes;
  }
}

class ContentAddressedMaterialStore {
  private root: string | undefined;

  public constructor(
    private readonly rootInput: string,
    private readonly maxManifestBytes: number,
  ) {}

  public async initialize(): Promise<string> {
    if (this.root) return this.root;
    const requested = resolve(this.rootInput);
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const requestedInfo = await lstat(requested);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) {
      throw new TypeError("Subject material store root must be a real directory");
    }
    const root = await realpath(requested);
    await chmod(root, 0o700);
    for (const child of ["blobs", "manifests", "tmp"]) {
      const path = join(root, child);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      const resolvedPath = await realpath(path);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(root, resolvedPath)) {
        throw new TypeError(`Unsafe subject material store directory: ${child}`);
      }
      await chmod(resolvedPath, 0o700);
    }
    this.root = root;
    return root;
  }

  private async address(kind: "blobs" | "manifests", digest: string): Promise<string> {
    const root = await this.initialize();
    return join(root, kind, digestHex(digest));
  }

  private async temporaryPath(): Promise<string> {
    return join(await this.initialize(), "tmp", `capture-${randomUUID()}.tmp`);
  }

  private async verifyAddress(path: string, expectedDigest: string, expectedBytes: number): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`CAS address ${expectedDigest} is not a regular file`);
    if (info.size !== expectedBytes) throw new Error(`CAS address ${expectedDigest} contains mismatched bytes`);
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const hash = createHash("sha256");
    let total = 0;
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    try {
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (!after.isFile() || after.size !== expectedBytes || total !== expectedBytes) {
        throw new Error(`CAS address ${expectedDigest} changed while it was verified`);
      }
    } finally {
      await handle.close();
    }
    if (`sha256:${hash.digest("hex")}` !== expectedDigest) {
      throw new Error(`CAS address ${expectedDigest} contains mismatched bytes`);
    }
  }

  private async readAddressVerified(
    path: string,
    expectedDigest: string,
    expectedBytes: number,
    readCeiling: number,
  ): Promise<Buffer> {
    if (expectedBytes > readCeiling) throw new Error(`CAS read exceeds ${readCeiling} bytes`);
    const initial = await lstat(path);
    if (initial.isSymbolicLink() || !initial.isFile() || initial.size !== expectedBytes) {
      throw new Error(`CAS address ${expectedDigest} contains mismatched bytes`);
    }
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const output = Buffer.allocUnsafe(expectedBytes);
    const hash = createHash("sha256");
    let offset = 0;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size !== expectedBytes) {
        throw new Error(`CAS address ${expectedDigest} changed before it was read`);
      }
      while (offset < expectedBytes) {
        const { bytesRead } = await handle.read(output, offset, Math.min(STREAM_CHUNK_BYTES, expectedBytes - offset), null);
        if (bytesRead === 0) break;
        hash.update(output.subarray(offset, offset + bytesRead));
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      const trailing = await handle.read(extra, 0, 1, null);
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || offset !== expectedBytes || trailing.bytesRead !== 0
        || `sha256:${hash.digest("hex")}` !== expectedDigest) {
        throw new Error(`CAS address ${expectedDigest} contains mismatched bytes`);
      }
    } finally {
      await handle.close();
    }
    return output;
  }

  private async publishTemporary(
    temporaryPath: string,
    kind: "blobs" | "manifests",
    digest: string,
    byteLength: number,
  ): Promise<void> {
    const target = await this.address(kind, digest);
    try {
      await link(temporaryPath, target);
      await unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      try {
        await this.verifyAddress(target, digest, byteLength);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  public async putBytes(data: Uint8Array, kind: "blobs" | "manifests" = "blobs"): Promise<string> {
    if (kind === "manifests" && data.byteLength > this.maxManifestBytes) {
      throw new Error(`Subject material manifest exceeds ${this.maxManifestBytes} bytes`);
    }
    const digest = sha256Digest(data);
    const target = await this.address(kind, digest);
    try {
      await this.verifyAddress(target, digest, data.byteLength);
      return digest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = await this.temporaryPath();
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
        if (bytesWritten < 1) throw new Error("CAS write made no progress");
        offset += bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await this.publishTemporary(temporary, kind, digest, data.byteLength);
    return digest;
  }

  public async storeInspectedFile(inspection: StoredFileInspection): Promise<void> {
    const target = await this.address("blobs", inspection.digest);
    try {
      await this.verifyAddress(target, inspection.digest, inspection.byteLength);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const currentPathInfo = await lstat(inspection.path);
    if (currentPathInfo.isSymbolicLink() || !currentPathInfo.isFile()
      || !sameIdentity(statsIdentity(currentPathInfo), inspection.identity)) {
      throw new Error(`Source file changed before material storage: ${inspection.path}`);
    }
    const temporary = await this.temporaryPath();
    const source = await open(inspection.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const destination = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let total = 0;
    try {
      const before = await source.stat();
      if (!before.isFile() || !sameIdentity(statsIdentity(before), inspection.identity)) {
        throw new Error(`Source file changed before material storage: ${inspection.path}`);
      }
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await destination.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten < 1) throw new Error("CAS write made no progress");
          offset += bytesWritten;
        }
        total += bytesRead;
      }
      const after = await source.stat();
      if (!after.isFile() || !sameIdentity(statsIdentity(after), inspection.identity)
        || total !== inspection.byteLength || `sha256:${hash.digest("hex")}` !== inspection.digest) {
        throw new Error(`Source file changed during material storage: ${inspection.path}`);
      }
      await destination.sync();
    } catch (error) {
      await source.close().catch(() => undefined);
      await destination.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await source.close();
    await destination.close();
    await this.publishTemporary(temporary, "blobs", inspection.digest, inspection.byteLength);
  }

  public async putManifest(manifest: SubjectMaterialManifest): Promise<string> {
    const bytes = Buffer.from(canonicalize(manifest as unknown as JsonValue), "utf8");
    return await this.putBytes(bytes, "manifests");
  }

  public async readBlob(digest: string, expectedBytes: number): Promise<Buffer> {
    if (expectedBytes > Number.MAX_SAFE_INTEGER || expectedBytes < 0) throw new TypeError("Invalid material byte length");
    const path = await this.address("blobs", digest);
    return await this.readAddressVerified(path, digest, expectedBytes, expectedBytes);
  }

  public async verifyBlob(digest: string, expectedBytes: number): Promise<void> {
    await this.verifyAddress(await this.address("blobs", digest), digest, expectedBytes);
  }

  public async materializeBlob(
    digest: string,
    expectedBytes: number,
    destination: string,
    mode: number,
  ): Promise<void> {
    const sourcePath = await this.address("blobs", digest);
    const initial = await lstat(sourcePath);
    if (initial.isSymbolicLink() || !initial.isFile() || initial.size !== expectedBytes) {
      throw new Error(`CAS address ${digest} is not a valid regular blob`);
    }
    const source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let output: Awaited<ReturnType<typeof open>> | undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let total = 0;
    try {
      output = await open(
        destination,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        mode & 0o777,
      );
      const before = await source.stat();
      if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size !== expectedBytes) {
        throw new Error(`CAS address ${digest} changed before materialization`);
      }
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten < 1) throw new Error("Materialization write made no progress");
          offset += bytesWritten;
        }
        total += bytesRead;
      }
      const after = await source.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== expectedBytes
        || `sha256:${hash.digest("hex")}` !== digest) {
        throw new Error(`CAS address ${digest} failed verification during materialization`);
      }
      await output.sync();
    } catch (error) {
      await output?.close().catch(() => undefined);
      await source.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    await output.close();
    await source.close();
  }

  public async readManifest(binding: SubjectMaterialBinding): Promise<SubjectMaterialManifest> {
    const path = await this.address("manifests", binding.manifestDigest);
    const info = await lstat(path);
    if (info.size > this.maxManifestBytes) throw new Error(`Subject material manifest exceeds ${this.maxManifestBytes} bytes`);
    const bytes = await this.readAddressVerified(
      path,
      binding.manifestDigest,
      info.size,
      this.maxManifestBytes,
    );
    let parsed: unknown;
    try {
      parsed = parseJsonBytes(bytes, `Subject material manifest ${binding.manifestDigest}`);
    } catch {
      throw new Error(`Subject material manifest ${binding.manifestDigest} is malformed JSON`);
    }
    return validateManifest(parsed, binding);
  }
}

async function inspectStableFile(
  sourceInput: string,
  maxBytes: number,
  budget: CaptureBudget,
  expectedRoot?: string,
  expectedDevice?: number,
  expectedIdentity?: FileIdentity,
): Promise<StoredFileInspection> {
  const stable = await resolveStableFilesystemEntry(sourceInput, "file", expectedRoot, expectedDevice, expectedIdentity);
  const source = stable.input;
  if (stable.identity.size > maxBytes) throw new Error(`Subject material file exceeds ${maxBytes} bytes: ${source}`);
  budget.add(stable.identity.size);
  const identity = stable.identity;
  const handle = await open(stable.resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const markerTailBytes = 64;
  let tail = Buffer.alloc(0);
  let privateKey = false;
  let total = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(statsIdentity(before), identity)) {
      throw new Error(`Subject material file changed before reading: ${source}`);
    }
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (!privateKey) {
        const scan = tail.byteLength === 0 ? chunk : Buffer.concat([tail, chunk]);
        privateKey = privateKeyContentReason(scan) !== undefined;
        tail = Buffer.from(scan.subarray(Math.max(0, scan.byteLength - markerTailBytes)));
      }
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Subject material file exceeds ${maxBytes} bytes: ${source}`);
    }
    const after = await handle.stat();
    if (!after.isFile() || !sameIdentity(statsIdentity(after), identity) || total !== identity.size) {
      throw new Error(`Subject material file changed while being read: ${source}`);
    }
  } finally {
    await handle.close();
  }
  return {
    path: stable.resolved,
    digest: `sha256:${hash.digest("hex")}`,
    byteLength: total,
    privateKey,
    identity,
  };
}

function materialEntry(
  path: string,
  inspection: Pick<StoredFileInspection, "digest" | "byteLength"> & Partial<Pick<StoredFileInspection, "identity">>,
  mediaType?: string,
): SubjectMaterialEntry {
  return Object.freeze({
    path,
    blobDigest: inspection.digest,
    byteLength: inspection.byteLength,
    mode: inspection.identity?.mode === undefined ? 0o600 : inspection.identity.mode & 0o777,
    ...(mediaType === undefined ? {} : { mediaType }),
  });
}

function declarationManifest(
  subject: SubjectReference,
  snapshot: SubjectSnapshot,
  reason: SubjectMaterialOmissionReason,
): SubjectMaterialManifest {
  return Object.freeze({
    protocol: SUBJECT_MATERIAL_PROTOCOL,
    subjectId: subject.id,
    subjectKind: subject.kind,
    subjectDigest: snapshot.digest,
    availability: "DECLARATION_ONLY",
    byteLength: 0,
    entries: Object.freeze([]),
    directories: Object.freeze([]),
    omissions: Object.freeze([{ reason }]),
    ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
    ...(snapshot.mediaType === undefined ? {} : { mediaType: snapshot.mediaType }),
    declarationReason: reason,
  });
}

async function captureFileSubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  policy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
): Promise<CapturedSubject> {
  const absolute = resolve(subject.locator);
  const stableRoot = await resolveStableFilesystemEntry(absolute, "file");
  const resolvedFile = stableRoot.resolved;
  if (within(await store.initialize(), resolvedFile)) {
    throw new TypeError("A subject file cannot be read from Jevyr's private material CAS");
  }
  const parentPolicy = await loadJevyrIgnorePolicy(dirname(resolvedFile));
  const nameDecision = parentPolicy.decide(normalizeJevyrRelativePath(basename(resolvedFile)), false);
  const inspection = await inspectStableFile(resolvedFile, policy.maxFileBytes, budget, undefined, undefined, stableRoot.identity);
  assertExpectedDigest(subject, inspection.digest);
  const snapshot: SubjectSnapshot = {
    subjectId: subject.id,
    digest: inspection.digest,
    resolvedLocator: resolvedFile,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: inspection.byteLength,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
  if (nameDecision.ignored || inspection.privateKey) {
    const endingRoot = await lstat(absolute);
    if (endingRoot.isSymbolicLink() || !endingRoot.isFile()
      || !sameIdentity(statsIdentity(endingRoot), stableRoot.identity)) {
      throw new Error(`File subject changed during material capture: ${absolute}`);
    }
    return {
      snapshot,
      manifest: declarationManifest(subject, snapshot, "DIRECT_SUBJECT_EXCLUDED"),
    };
  }
  await store.storeInspectedFile(inspection);
  const endingRoot = await lstat(absolute);
  if (endingRoot.isSymbolicLink() || !endingRoot.isFile() || !sameIdentity(statsIdentity(endingRoot), stableRoot.identity)) {
    throw new Error(`File subject changed during material capture: ${absolute}`);
  }
  return {
    snapshot,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: snapshot.digest,
      availability: "MATERIALIZED",
      byteLength: inspection.byteLength,
      entries: [materialEntry("content", inspection, subject.mediaType)],
      directories: [],
      omissions: [],
      ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
      ...(snapshot.mediaType === undefined ? {} : { mediaType: snapshot.mediaType }),
    },
  };
}

async function captureTextSubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  policy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
): Promise<CapturedSubject> {
  const bytes = Buffer.from(subject.locator, "utf8");
  if (bytes.byteLength > policy.maxFileBytes) throw new Error(`Text subject exceeds ${policy.maxFileBytes} bytes`);
  budget.add(bytes.byteLength);
  const digest = sha256Digest(bytes);
  assertExpectedDigest(subject, digest);
  const snapshot: SubjectSnapshot = {
    subjectId: subject.id,
    digest,
    resolvedLocator: `inline:${subject.id}`,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: bytes.byteLength,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
  if (privateKeyContentReason(bytes)) {
    return { snapshot, manifest: declarationManifest(subject, snapshot, "DIRECT_SUBJECT_EXCLUDED") };
  }
  await store.putBytes(bytes);
  return {
    snapshot,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: digest,
      availability: "MATERIALIZED",
      byteLength: bytes.byteLength,
      entries: [materialEntry("content.txt", { digest, byteLength: bytes.byteLength }, subject.mediaType ?? "text/plain; charset=utf-8")],
      directories: [],
      omissions: [],
      ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
      mediaType: snapshot.mediaType ?? "text/plain; charset=utf-8",
    },
  };
}

interface DirectoryCapture {
  readonly snapshotEntries: readonly ({ readonly path: string; readonly type: "directory" } | {
    readonly path: string;
    readonly type: "file";
    readonly digest: string;
    readonly byteLength: number;
  })[];
  readonly materialEntries: readonly SubjectMaterialEntry[];
  readonly directories: readonly string[];
  readonly omissions: readonly SubjectMaterialOmission[];
  readonly byteLength: number;
  readonly ignorePolicyDigest: string;
  readonly resolvedRoot: string;
}

async function captureDirectoryTree(
  rootInput: string,
  store: ContentAddressedMaterialStore,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
  materialPolicy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
): Promise<DirectoryCapture> {
  const stableRoot = await resolveStableFilesystemEntry(rootInput, "directory");
  const absolute = stableRoot.input;
  const root = stableRoot.resolved;
  const rootDevice = stableRoot.identity.dev;
  const ignorePolicy = await loadJevyrIgnorePolicy(root);
  const materialStoreRoot = await store.initialize();
  if (within(root, materialStoreRoot)) {
    if (root === materialStoreRoot) throw new TypeError("Subject material store cannot be the captured tree");
    const relativeStore = jevyrRelativePath(root, materialStoreRoot);
    if (!ignorePolicy.decide(relativeStore, true).ignored) {
      throw new TypeError("Subject material store must be outside the captured tree or inside a policy-excluded directory");
    }
  }
  const snapshotEntries: Array<DirectoryCapture["snapshotEntries"][number]> = [];
  const materialEntries: SubjectMaterialEntry[] = [];
  const directories: string[] = [];
  const omissions: SubjectMaterialOmission[] = [];
  const inspections = new Map<string, StoredFileInspection>();
  const directoryChecks: Array<{ path: string; identity: FileIdentity; children: string }> = [];
  let files = 0;
  let bytes = 0;

  const walk = async (directory: string): Promise<void> => {
    if (!within(root, directory)) throw new TypeError(`Directory traversal escaped its root: ${directory}`);
    const stableDirectory = await resolveStableFilesystemEntry(directory, "directory", root, rootDevice);
    const before = await lstat(stableDirectory.resolved);
    const resolvedDirectory = stableDirectory.resolved;
    const children = (await readdir(resolvedDirectory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    const childSignature = children.map((child) => child.name).join("\0");
    directoryChecks.push({ path: resolvedDirectory, identity: statsIdentity(before), children: childSignature });
    for (const child of children) {
      const source = resolve(resolvedDirectory, child.name);
      if (!within(root, source)) throw new TypeError(`Directory entry escaped its subject root: ${source}`);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new TypeError(`Subject material refuses symbolic links or junctions: ${source}`);
      if (info.dev !== rootDevice) throw new TypeError(`Subject material refuses filesystem boundary crossings: ${source}`);
      const path = jevyrRelativePath(root, source);
      const decision = ignorePolicy.decide(path, info.isDirectory());
      if (decision.ignored) {
        omissions.push({ path, reason: decision.reason as IgnoreReason, ...(decision.ruleLine === undefined ? {} : { ruleLine: decision.ruleLine }) });
        continue;
      }
      if (info.isDirectory()) {
        const resolvedChild = (await resolveStableFilesystemEntry(
          source,
          "directory",
          root,
          rootDevice,
          statsIdentity(info),
        )).resolved;
        directories.push(path);
        snapshotEntries.push({ path, type: "directory" });
        await walk(resolvedChild);
      } else if (info.isFile()) {
        const inspection = await inspectStableFile(
          source,
          Math.min(materialPolicy.maxFileBytes, snapshotPolicy.maxDirectoryBytes),
          budget,
          root,
          rootDevice,
          statsIdentity(info),
        );
        if (inspection.privateKey) {
          omissions.push({ path, reason: "built-in-private-key-content" });
          continue;
        }
        files += 1;
        if (files > snapshotPolicy.maxDirectoryFiles) {
          throw new Error(`Directory subject exceeds ${snapshotPolicy.maxDirectoryFiles} files`);
        }
        bytes += inspection.byteLength;
        if (bytes > snapshotPolicy.maxDirectoryBytes) {
          throw new Error(`Directory subject exceeds ${snapshotPolicy.maxDirectoryBytes} bytes`);
        }
        await store.storeInspectedFile(inspection);
        inspections.set(path, inspection);
        snapshotEntries.push({ path, type: "file", digest: inspection.digest, byteLength: inspection.byteLength });
        materialEntries.push(materialEntry(path, inspection));
      } else {
        throw new TypeError(`Subject material refuses special filesystem entries: ${source}`);
      }
    }
    const after = await lstat(resolvedDirectory);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(statsIdentity(after), statsIdentity(before))) {
      throw new Error(`Directory changed while its subject material was captured: ${directory}`);
    }
  };

  await walk(root);
  snapshotEntries.sort((left, right) => compareText(left.path, right.path) || compareText(left.type, right.type));
  materialEntries.sort((left, right) => compareText(left.path, right.path));
  directories.sort(compareText);
  omissions.sort((left, right) => compareText(left.path ?? "", right.path ?? "") || compareText(left.reason, right.reason));

  for (const [path, original] of [...inspections.entries()].sort(([left], [right]) => compareText(left, right))) {
    const observed = await inspectStableFile(
      resolve(root, ...path.split("/")),
      materialPolicy.maxFileBytes,
      // Verification reads do not consume the sealed content-byte budget a second time.
      new CaptureBudget(materialPolicy.maxFileBytes),
      root,
      rootDevice,
      original.identity,
    );
    if (observed.digest !== original.digest || !sameIdentity(observed.identity, original.identity)) {
      throw new Error(`Directory file changed during material capture: ${path}`);
    }
  }
  for (const check of directoryChecks) {
    const info = await lstat(check.path);
    const children = (await readdir(check.path, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    if (!sameIdentity(statsIdentity(info), check.identity) || children.map((child) => child.name).join("\0") !== check.children) {
      throw new Error(`Directory changed during material capture: ${check.path}`);
    }
  }
  const endingIgnorePolicy = await loadJevyrIgnorePolicy(root);
  if (endingIgnorePolicy.sourceDigest !== ignorePolicy.sourceDigest) {
    throw new Error(".jevyrignore changed during subject material capture");
  }
  const endingRoot = await lstat(absolute);
  if (endingRoot.isSymbolicLink() || !endingRoot.isDirectory()
    || !sameIdentity(statsIdentity(endingRoot), stableRoot.identity)) {
    throw new Error(`Directory subject root changed during material capture: ${absolute}`);
  }
  return {
    snapshotEntries,
    materialEntries,
    directories,
    omissions,
    byteLength: bytes,
    ignorePolicyDigest: ignorePolicy.sourceDigest,
    resolvedRoot: root,
  };
}

async function captureDirectorySubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
  materialPolicy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
): Promise<CapturedSubject> {
  const tree = await captureDirectoryTree(subject.locator, store, snapshotPolicy, materialPolicy, budget);
  const digest = digestJson({ protocol: "jevyr.directory-manifest/1", entries: tree.snapshotEntries } as unknown as JsonValue);
  assertExpectedDigest(subject, digest);
  const snapshot: SubjectSnapshot = {
    subjectId: subject.id,
    digest,
    resolvedLocator: tree.resolvedRoot,
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    capturedAt,
    byteLength: tree.byteLength,
    ...(subject.mediaType === undefined ? {} : { mediaType: subject.mediaType }),
  };
  return {
    snapshot,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: digest,
      availability: "MATERIALIZED",
      byteLength: tree.byteLength,
      entries: tree.materialEntries,
      directories: tree.directories,
      omissions: tree.omissions,
      ignorePolicyDigest: tree.ignorePolicyDigest,
      ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
      ...(snapshot.mediaType === undefined ? {} : { mediaType: snapshot.mediaType }),
    },
  };
}

function canonicalUrl(locator: string): URL {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new TypeError(`Invalid URL subject locator: ${locator}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("URL subjects must use HTTP or HTTPS");
  if (url.username || url.password) throw new TypeError("URL subjects may not contain embedded credentials");
  return url;
}

async function boundedResponseBytes(response: Response, maxBytes: number, budget: CaptureBudget): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`URL subject exceeds ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
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
  budget.add(total);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function captureFetchedUrlSubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
  materialPolicy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
  fetchImpl: typeof globalThis.fetch,
): Promise<CapturedSubject> {
  const allowed = new Set(snapshotPolicy.url.allowedOrigins);
  let current = canonicalUrl(subject.locator);
  current.hash = "";
  let response: Response | undefined;
  for (let redirects = 0; redirects <= snapshotPolicy.url.maxRedirects; redirects += 1) {
    if (!allowed.has(current.origin)) throw new Error(`URL subject origin is not explicitly allowed: ${current.origin}`);
    response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(snapshotPolicy.url.timeoutMs),
      headers: { accept: "*/*", "cache-control": "no-cache" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("URL subject redirect omitted Location");
    if (redirects === snapshotPolicy.url.maxRedirects) throw new Error("URL subject exceeded its redirect limit");
    current = canonicalUrl(new URL(location, current).toString());
    current.hash = "";
  }
  if (!response || !response.ok) throw new Error(`URL subject fetch failed with HTTP ${response?.status ?? "unknown"}`);
  const maxBytes = Math.min(snapshotPolicy.url.maxBytes, materialPolicy.maxFileBytes);
  const data = await boundedResponseBytes(response, maxBytes, budget);
  const digest = sha256Digest(data);
  const etag = response.headers.get("etag") ?? undefined;
  if (subject.revision !== undefined) {
    const matches = isSha256Digest(subject.revision) ? subject.revision === digest : subject.revision === etag;
    if (!matches) throw new Error(`URL subject ${subject.id} does not match its declared revision`);
  }
  const mediaType = subject.mediaType ?? response.headers.get("content-type") ?? "application/octet-stream";
  const snapshot: SubjectSnapshot = {
    subjectId: subject.id,
    digest,
    resolvedLocator: current.toString(),
    ...(subject.revision === undefined && etag === undefined ? {} : { revision: subject.revision ?? etag as string }),
    capturedAt,
    byteLength: data.byteLength,
    mediaType,
  };
  if (privateKeyContentReason(data)) {
    return { snapshot, manifest: declarationManifest(subject, snapshot, "DIRECT_SUBJECT_EXCLUDED") };
  }
  await store.putBytes(data);
  return {
    snapshot,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: digest,
      availability: "MATERIALIZED",
      byteLength: data.byteLength,
      entries: [materialEntry("response", { digest, byteLength: data.byteLength }, mediaType)],
      directories: [],
      omissions: [],
      ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
      mediaType,
    },
  };
}

function parseArtifactLocator(locator: string): { caseId: string; artifactId: string } {
  const match = locator.match(/^((?:case|jvr)_[A-Za-z0-9_-]{8,128})\/(artifact_[a-f0-9]{24})$/u);
  if (!match?.[1] || !match[2]) throw new TypeError("Artifact subject locator must be caseId/artifactId");
  return { caseId: match[1], artifactId: match[2] };
}

async function captureArtifactSubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  policy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
  resolveArtifact: SubjectSnapshotDependencies["resolveArtifact"],
): Promise<CapturedSubject> {
  const address = parseArtifactLocator(subject.locator);
  const artifact = await resolveArtifact(address.caseId, address.artifactId);
  if (!artifact) throw new Error(`Artifact subject does not exist: ${subject.locator}`);
  if (artifact.caseId !== address.caseId || artifact.id !== address.artifactId) throw new Error("Artifact metadata identity does not match its address");
  if (artifact.data.byteLength > policy.maxFileBytes) throw new Error(`Artifact subject exceeds ${policy.maxFileBytes} bytes`);
  budget.add(artifact.data.byteLength);
  const observedDigest = sha256Digest(artifact.data);
  if (artifact.digest !== observedDigest || artifact.size !== artifact.data.byteLength) {
    throw new Error(`Artifact ${subject.locator} failed content-address verification`);
  }
  if (subject.revision !== undefined && subject.revision !== artifact.digest) {
    throw new Error(`Artifact subject ${subject.id} does not match its declared revision`);
  }
  const mediaType = subject.mediaType ?? artifact.mediaType;
  const snapshot: SubjectSnapshot = {
    subjectId: subject.id,
    digest: artifact.digest,
    resolvedLocator: `jevyr:artifact:${address.caseId}/${address.artifactId}`,
    revision: artifact.digest,
    capturedAt,
    byteLength: artifact.size,
    mediaType,
  };
  if (privateKeyContentReason(artifact.data)) {
    return { snapshot, manifest: declarationManifest(subject, snapshot, "DIRECT_SUBJECT_EXCLUDED") };
  }
  await store.putBytes(artifact.data);
  return {
    snapshot,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: artifact.digest,
      availability: "MATERIALIZED",
      byteLength: artifact.size,
      entries: [materialEntry("artifact", { digest: artifact.digest, byteLength: artifact.size }, mediaType)],
      directories: [],
      omissions: [],
      revision: artifact.digest,
      mediaType,
    },
  };
}

function looksRemoteGit(locator: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^/@\s]+@[^:\s]+:)/iu.test(locator);
}

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function runGit(
  command: string,
  root: string,
  args: readonly string[],
  maxBytes: number,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(command, ["-c", "core.fsmonitor=false", "-C", root, ...args], {
      cwd: root,
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
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Git materialization timed out")), 30_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) return fail(new Error(`Git materialization exceeded ${maxBytes} output bytes`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > Math.min(maxBytes, 2_000_000)) return fail(new Error("Git materialization produced excessive diagnostics"));
      stderr.push(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
      if (code !== 0) return reject(new Error(`git exited ${code}: ${diagnostic || "no diagnostic"}`));
      resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function parseNulPaths(data: Buffer): readonly string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new TypeError("Git returned a path that is not unambiguous UTF-8");
  }
  const paths = text.split("\0").filter(Boolean).map(normalizeJevyrRelativePath).sort(compareText);
  if (new Set(paths).size !== paths.length) throw new Error("Git returned duplicate material paths");
  return paths;
}

async function gitMaterialPaths(
  subject: SubjectReference,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
): Promise<readonly string[]> {
  const root = (await resolveStableFilesystemEntry(subject.locator, "directory")).resolved;
  return parseNulPaths((await runGit(
    snapshotPolicy.gitCommand,
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    snapshotPolicy.maxGitOutputBytes,
  )).stdout);
}

async function captureLocalGitSubject(
  subject: SubjectReference,
  capturedAt: string,
  store: ContentAddressedMaterialStore,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
  materialPolicy: NormalizedMaterialPolicy,
  budget: CaptureBudget,
  dependencies: SubjectSnapshotDependencies,
): Promise<CapturedSubject> {
  const first = (await resolveSubjectSnapshots([subject], capturedAt, snapshotPolicy, dependencies))[0] as SubjectSnapshot;
  const stableRoot = await resolveStableFilesystemEntry(subject.locator, "directory");
  const root = stableRoot.resolved;
  const rootInfo = await lstat(root);
  const ignorePolicy = await loadJevyrIgnorePolicy(root);
  const materialStoreRoot = await store.initialize();
  if (within(root, materialStoreRoot)) {
    if (root === materialStoreRoot) return { snapshot: first, manifest: declarationManifest(subject, first, "GIT_PATH_EXCLUDED") };
    const relativeStore = jevyrRelativePath(root, materialStoreRoot);
    if (!ignorePolicy.decide(relativeStore, true).ignored) {
      return { snapshot: first, manifest: declarationManifest(subject, first, "GIT_PATH_EXCLUDED") };
    }
  }
  const initialPaths = await gitMaterialPaths(subject, snapshotPolicy);
  const entries: SubjectMaterialEntry[] = [];
  let byteLength = 0;
  let declarationReason: SubjectMaterialOmissionReason | undefined;

  for (const path of initialPaths) {
    const source = resolve(root, ...path.split("/"));
    if (!within(root, source)) throw new TypeError(`Git material path escaped its root: ${path}`);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        declarationReason = "GIT_DELETION_REQUIRES_BASE_OBJECTS";
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      declarationReason = "GIT_LINK_OR_SPECIAL_ENTRY";
      break;
    }
    if (info.dev !== rootInfo.dev) {
      declarationReason = "GIT_FILESYSTEM_BOUNDARY";
      break;
    }
    const decision = ignorePolicy.decide(path, false);
    if (decision.ignored) {
      declarationReason = "GIT_PATH_EXCLUDED";
      break;
    }
    const inspection = await inspectStableFile(
      source,
      materialPolicy.maxFileBytes,
      budget,
      root,
      rootInfo.dev,
      statsIdentity(info),
    );
    if (inspection.privateKey) {
      declarationReason = "GIT_PATH_EXCLUDED";
      break;
    }
    await store.storeInspectedFile(inspection);
    entries.push(materialEntry(path, inspection));
    byteLength += inspection.byteLength;
  }

  const endingPaths = await gitMaterialPaths(subject, snapshotPolicy);
  const endingIgnorePolicy = await loadJevyrIgnorePolicy(root);
  const second = (await resolveSubjectSnapshots([subject], capturedAt, snapshotPolicy, dependencies))[0] as SubjectSnapshot;
  const endingRoot = await lstat(stableRoot.input);
  if (JSON.stringify(initialPaths) !== JSON.stringify(endingPaths)
    || endingIgnorePolicy.sourceDigest !== ignorePolicy.sourceDigest
    || first.digest !== second.digest
    || first.revision !== second.revision
    || endingRoot.isSymbolicLink() || !endingRoot.isDirectory()
    || !sameIdentity(statsIdentity(endingRoot), stableRoot.identity)) {
    declarationReason = "GIT_STATE_CHANGED";
  }
  if (declarationReason) return { snapshot: second, manifest: declarationManifest(subject, second, declarationReason) };
  entries.sort((left, right) => compareText(left.path, right.path));
  return {
    snapshot: second,
    manifest: {
      protocol: SUBJECT_MATERIAL_PROTOCOL,
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: second.digest,
      availability: "MATERIALIZED",
      byteLength,
      entries,
      directories: [],
      omissions: [],
      ignorePolicyDigest: ignorePolicy.sourceDigest,
      ...(second.revision === undefined ? {} : { revision: second.revision }),
      ...(second.mediaType === undefined ? {} : { mediaType: second.mediaType }),
    },
  };
}

async function captureDeclaration(
  subject: SubjectReference,
  capturedAt: string,
  snapshotPolicy: NormalizedSubjectSnapshotPolicy,
  dependencies: SubjectSnapshotDependencies,
  reason: SubjectMaterialOmissionReason,
): Promise<CapturedSubject> {
  const snapshot = (await resolveSubjectSnapshots([subject], capturedAt, snapshotPolicy, dependencies))[0] as SubjectSnapshot;
  return { snapshot, manifest: declarationManifest(subject, snapshot, reason) };
}

/**
 * Captures snapshots and their private material in one sealed operation. The
 * returned bindings contain no original locator. CAS blobs may be reused, but
 * an existing address is accepted only after its bytes are rehashed.
 */
export async function captureSubjectMaterials(
  storeRoot: string,
  subjects: readonly SubjectReference[],
  capturedAt: string,
  snapshotPolicyInput: SubjectSnapshotPolicy,
  dependencies: SubjectSnapshotDependencies,
  materialPolicyInput: SubjectMaterialCapturePolicy = {},
): Promise<SubjectMaterialCaptureResult> {
  if (Number.isNaN(Date.parse(capturedAt))) throw new TypeError("capturedAt must be an ISO timestamp");
  const snapshotPolicy = normalizeSubjectSnapshotPolicy(snapshotPolicyInput);
  const materialPolicy = normalizeMaterialPolicy(materialPolicyInput);
  const store = new ContentAddressedMaterialStore(storeRoot, materialPolicy.maxManifestBytes);
  await store.initialize();
  const budget = new CaptureBudget(materialPolicy.maxTotalBytes);
  const ordered = [...subjects].sort((left, right) => compareText(left.id, right.id));
  if (new Set(ordered.map((subject) => subject.id)).size !== ordered.length) throw new TypeError("Subject ids must be unique");
  const snapshots: SubjectSnapshot[] = [];
  const bindings: SubjectMaterialBinding[] = [];

  for (const subject of ordered) {
    let captured: CapturedSubject;
    switch (subject.kind) {
      case "file":
        captured = await captureFileSubject(subject, capturedAt, store, materialPolicy, budget);
        break;
      case "text":
        captured = await captureTextSubject(subject, capturedAt, store, materialPolicy, budget);
        break;
      case "directory":
        captured = await captureDirectorySubject(subject, capturedAt, store, snapshotPolicy, materialPolicy, budget);
        break;
      case "url":
        captured = snapshotPolicy.url.mode === "fetch"
          ? await captureFetchedUrlSubject(subject, capturedAt, store, snapshotPolicy, materialPolicy, budget, dependencies.fetch ?? globalThis.fetch)
          : await captureDeclaration(subject, capturedAt, snapshotPolicy, dependencies, "URL_FETCH_DISABLED");
        break;
      case "artifact":
        captured = await captureArtifactSubject(subject, capturedAt, store, materialPolicy, budget, dependencies.resolveArtifact);
        break;
      case "git":
        captured = looksRemoteGit(subject.locator)
          ? await captureDeclaration(subject, capturedAt, snapshotPolicy, dependencies, "REMOTE_DECLARATION")
          : await captureLocalGitSubject(subject, capturedAt, store, snapshotPolicy, materialPolicy, budget, dependencies);
        break;
    }
    const manifestDigest = await store.putManifest(captured.manifest);
    snapshots.push(Object.freeze(captured.snapshot));
    bindings.push(Object.freeze({
      subjectId: subject.id,
      subjectKind: subject.kind,
      subjectDigest: captured.snapshot.digest,
      availability: captured.manifest.availability,
      manifestDigest,
      byteLength: captured.manifest.byteLength,
    }));
  }
  const frozenBindings = Object.freeze(bindings);
  const captureDigest = digestJson({
    protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
    bindings: frozenBindings,
  } as unknown as JsonValue);
  return Object.freeze({
    protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
    snapshots: Object.freeze(snapshots),
    bindings: frozenBindings,
    captureDigest,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown, binding: SubjectMaterialBinding): SubjectMaterialManifest {
  if (!record(value) || value.protocol !== SUBJECT_MATERIAL_PROTOCOL) throw new Error("Invalid subject material manifest protocol");
  if (value.subjectId !== binding.subjectId || value.subjectKind !== binding.subjectKind
    || value.subjectDigest !== binding.subjectDigest || value.availability !== binding.availability) {
    throw new Error("Subject material manifest does not match its binding");
  }
  if (!isSha256Digest(value.subjectDigest)) throw new Error("Subject material manifest has an invalid subject digest");
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0 || value.byteLength !== binding.byteLength) {
    throw new Error("Subject material manifest has an invalid byte length");
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.directories) || !Array.isArray(value.omissions)) {
    throw new Error("Subject material manifest arrays are malformed");
  }
  let priorPath = "";
  let total = 0;
  for (const [index, entry] of value.entries.entries()) {
    if (!record(entry) || typeof entry.path !== "string" || !isSha256Digest(entry.blobDigest)
      || !Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 0
      || !Number.isSafeInteger(entry.mode) || (entry.mode as number) < 0 || (entry.mode as number) > 0o777) {
      throw new Error("Subject material manifest entry is malformed");
    }
    normalizeJevyrRelativePath(entry.path);
    if (index > 0 && compareText(priorPath, entry.path) >= 0) throw new Error("Subject material manifest entries are not strictly sorted");
    priorPath = entry.path;
    total += entry.byteLength as number;
    if (!Number.isSafeInteger(total)) throw new Error("Subject material manifest byte length overflow");
  }
  if (value.availability === "MATERIALIZED" && total !== value.byteLength) {
    throw new Error("Subject material manifest entry bytes do not match its total");
  }
  if (value.availability === "DECLARATION_ONLY" && (value.entries.length !== 0 || value.byteLength !== 0)) {
    throw new Error("Declaration-only subject material contains bytes");
  }
  let priorDirectory = "";
  for (const [index, path] of value.directories.entries()) {
    if (typeof path !== "string") throw new Error("Subject material manifest directory is malformed");
    normalizeJevyrRelativePath(path);
    if (index > 0 && compareText(priorDirectory, path) >= 0) {
      throw new Error("Subject material manifest directories are not strictly sorted");
    }
    priorDirectory = path;
  }
  let priorOmission = "";
  for (const [index, omission] of value.omissions.entries()) {
    if (!record(omission) || typeof omission.reason !== "string") throw new Error("Subject material omission is malformed");
    if (omission.path !== undefined) {
      if (typeof omission.path !== "string") throw new Error("Subject material omission path is malformed");
      normalizeJevyrRelativePath(omission.path);
    }
    const key = `${omission.path ?? ""}\0${omission.reason}`;
    if (index > 0 && compareText(priorOmission, key) > 0) {
      throw new Error("Subject material omissions are not sorted");
    }
    priorOmission = key;
  }
  return value as unknown as SubjectMaterialManifest;
}

function projectionOmission(
  value: Omit<SubjectTextOmission, "omissionDigest">,
): SubjectTextOmission {
  return Object.freeze({
    ...value,
    omissionDigest: digestJson(value as unknown as JsonValue),
  });
}

function hasBinaryControlBytes(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

/** A read-only capability over the private CAS; no capture, write or live-path method is exposed. */
export function capturedSubjectMaterialReader(storeRoot: string) {
  const store = new ContentAddressedMaterialStore(storeRoot, normalizeMaterialPolicy({}).maxManifestBytes);
  return Object.freeze({
    readManifest: async (binding: SubjectMaterialBinding) => await store.readManifest(binding),
    readBlob: async (digest: string, expectedBytes: number) => await store.readBlob(digest, expectedBytes),
  });
}

/**
 * Produces a bounded initial view intended for minds. It reads only verified CAS
 * bytes, orders by subject id then subject-relative path, and never emits an
 * original locator. Files are whole or omitted; truncation is never silent.
 */
export async function projectSubjectText(
  storeRoot: string,
  bindingsInput: readonly SubjectMaterialBinding[],
  options: SubjectTextProjectionOptions = {},
  materialPolicyInput: SubjectMaterialCapturePolicy = {},
): Promise<SubjectTextProjection> {
  const materialPolicy = normalizeMaterialPolicy(materialPolicyInput);
  const limits = Object.freeze({
    maxFileBytes: positiveInteger(options.maxFileBytes, DEFAULT_PROJECTION_FILE_BYTES, "projection.maxFileBytes"),
    maxTotalBytes: positiveInteger(options.maxTotalBytes, DEFAULT_PROJECTION_TOTAL_BYTES, "projection.maxTotalBytes"),
    maxFiles: positiveInteger(options.maxFiles, DEFAULT_PROJECTION_FILES, "projection.maxFiles"),
  });
  const store = new ContentAddressedMaterialStore(storeRoot, materialPolicy.maxManifestBytes);
  const bindings = [...bindingsInput].sort((left, right) => compareText(left.subjectId, right.subjectId));
  if (new Set(bindings.map((binding) => binding.subjectId)).size !== bindings.length) {
    throw new TypeError("Subject material bindings must have unique subject ids");
  }
  const files: SubjectTextFile[] = [];
  const omissions: SubjectTextOmission[] = [];
  const manifestDigests: string[] = [];
  let includedBytes = 0;

  for (const binding of bindings) {
    if (!isSha256Digest(binding.subjectDigest) || !isSha256Digest(binding.manifestDigest)) {
      throw new TypeError("Subject material binding contains an invalid digest");
    }
    const manifest = await store.readManifest(binding);
    manifestDigests.push(binding.manifestDigest);
    if (manifest.availability === "DECLARATION_ONLY") {
      omissions.push(projectionOmission({
        subjectId: binding.subjectId,
        reason: "DECLARATION_ONLY",
        ...(manifest.declarationReason === undefined ? {} : { policyReason: manifest.declarationReason }),
      }));
      continue;
    }
    for (const excluded of manifest.omissions) {
      omissions.push(projectionOmission({
        subjectId: binding.subjectId,
        ...(excluded.path === undefined ? {} : { path: excluded.path }),
        reason: "POLICY_EXCLUDED",
        policyReason: excluded.reason,
      }));
    }
    for (const entry of manifest.entries) {
      if (entry.byteLength > limits.maxFileBytes) {
        omissions.push(projectionOmission({
          subjectId: binding.subjectId,
          path: entry.path,
          reason: "PER_FILE_LIMIT",
          sourceDigest: entry.blobDigest,
          sourceByteLength: entry.byteLength,
        }));
        continue;
      }
      if (files.length >= limits.maxFiles) {
        omissions.push(projectionOmission({
          subjectId: binding.subjectId,
          path: entry.path,
          reason: "FILE_COUNT_LIMIT",
          sourceDigest: entry.blobDigest,
          sourceByteLength: entry.byteLength,
        }));
        continue;
      }
      if (includedBytes + entry.byteLength > limits.maxTotalBytes) {
        omissions.push(projectionOmission({
          subjectId: binding.subjectId,
          path: entry.path,
          reason: "TOTAL_LIMIT",
          sourceDigest: entry.blobDigest,
          sourceByteLength: entry.byteLength,
        }));
        continue;
      }
      const bytes = await store.readBlob(entry.blobDigest, entry.byteLength);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        omissions.push(projectionOmission({
          subjectId: binding.subjectId,
          path: entry.path,
          reason: "INVALID_UTF8",
          sourceDigest: entry.blobDigest,
          sourceByteLength: entry.byteLength,
        }));
        continue;
      }
      if (hasBinaryControlBytes(decoded)) {
        omissions.push(projectionOmission({
          subjectId: binding.subjectId,
          path: entry.path,
          reason: "BINARY_CONTROL_BYTES",
          sourceDigest: entry.blobDigest,
          sourceByteLength: entry.byteLength,
        }));
        continue;
      }
      files.push(Object.freeze({
        subjectId: binding.subjectId,
        path: entry.path,
        sourceDigest: entry.blobDigest,
        sourceByteLength: entry.byteLength,
        text: decoded,
        ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
      }));
      includedBytes += entry.byteLength;
    }
  }
  omissions.sort((left, right) => compareText(left.subjectId, right.subjectId)
    || compareText(left.path ?? "", right.path ?? "")
    || compareText(left.reason, right.reason));
  const unsigned = {
    protocol: SUBJECT_TEXT_PROJECTION_PROTOCOL,
    files,
    omissions,
    manifestDigests,
    includedBytes,
    limits,
  };
  return Object.freeze({
    ...unsigned,
    projectionDigest: digestJson(unsigned as unknown as JsonValue),
  });
}

/** Rehashes a manifest and every referenced blob without projecting content. */
export async function verifySubjectMaterialBinding(
  storeRoot: string,
  binding: SubjectMaterialBinding,
  materialPolicyInput: SubjectMaterialCapturePolicy = {},
): Promise<SubjectMaterialManifest> {
  const policy = normalizeMaterialPolicy(materialPolicyInput);
  const store = new ContentAddressedMaterialStore(storeRoot, policy.maxManifestBytes);
  const manifest = await store.readManifest(binding);
  for (const entry of manifest.entries) await store.verifyBlob(entry.blobDigest, entry.byteLength);
  return manifest;
}

async function ensureMaterializedParent(root: string, relativePath: string): Promise<string> {
  const path = normalizeJevyrRelativePath(relativePath);
  const parts = path.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!within(root, current)) throw new TypeError("Materialized path escaped its destination root");
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Materialized parent is not a safe directory: ${relativePath}`);
    }
  }
  const destination = join(root, ...path.split("/"));
  if (!within(root, destination)) throw new TypeError("Materialized path escaped its destination root");
  return destination;
}

/**
 * Reconstructs verified material into a newly-created destination. Each
 * subject receives a synthetic ordinal root, so source locators cannot leak to
 * Forge. Declaration-only subjects remain explicit and produce no directory.
 */
export async function materializeSubjectMaterials(
  storeRoot: string,
  bindingsInput: readonly SubjectMaterialBinding[],
  destinationInput: string,
  materialPolicyInput: SubjectMaterialCapturePolicy = {},
): Promise<SubjectMaterializationResult> {
  const policy = normalizeMaterialPolicy(materialPolicyInput);
  const store = new ContentAddressedMaterialStore(storeRoot, policy.maxManifestBytes);
  const storeResolved = await store.initialize();
  const destination = resolve(destinationInput);
  const parent = await realpath(dirname(destination));
  if (within(storeResolved, destination) || within(storeResolved, parent)) {
    throw new TypeError("Materialization destination must be outside the private CAS");
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const destinationInfo = await lstat(destination);
  const destinationResolved = await realpath(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory() || destinationResolved !== destination) {
    throw new TypeError("Materialization destination must be a newly-created real directory");
  }
  const bindings = [...bindingsInput].sort((left, right) => compareText(left.subjectId, right.subjectId));
  if (new Set(bindings.map((binding) => binding.subjectId)).size !== bindings.length) {
    throw new TypeError("Subject material bindings must have unique subject ids");
  }
  const subjects: MaterializedSubject[] = [];
  for (const [index, binding] of bindings.entries()) {
    const manifest = await store.readManifest(binding);
    if (manifest.availability === "DECLARATION_ONLY") {
      subjects.push(Object.freeze({
        subjectId: binding.subjectId,
        availability: "DECLARATION_ONLY",
        manifestDigest: binding.manifestDigest,
        files: 0,
        byteLength: 0,
      }));
      continue;
    }
    const relativeRoot = `subject-${index.toString().padStart(4, "0")}`;
    const subjectRoot = join(destinationResolved, relativeRoot);
    await mkdir(subjectRoot, { recursive: false, mode: 0o700 });
    for (const directoryPath of manifest.directories) {
      const directory = await ensureMaterializedParent(subjectRoot, `${directoryPath}/.jevyr-directory-sentinel`);
      const target = dirname(directory);
      try {
        await mkdir(target, { recursive: false, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Materialized directory conflicts with a file: ${directoryPath}`);
      }
    }
    for (const entry of manifest.entries) {
      const target = await ensureMaterializedParent(subjectRoot, entry.path);
      await store.materializeBlob(entry.blobDigest, entry.byteLength, target, entry.mode);
    }
    subjects.push(Object.freeze({
      subjectId: binding.subjectId,
      availability: "MATERIALIZED",
      relativeRoot,
      manifestDigest: binding.manifestDigest,
      files: manifest.entries.length,
      byteLength: manifest.byteLength,
    }));
  }
  const frozenSubjects = Object.freeze(subjects);
  return Object.freeze({
    protocol: SUBJECT_MATERIALIZATION_PROTOCOL,
    subjects: frozenSubjects,
    materializationDigest: digestJson({
      protocol: SUBJECT_MATERIALIZATION_PROTOCOL,
      subjects: frozenSubjects,
    } as unknown as JsonValue),
  });
}
