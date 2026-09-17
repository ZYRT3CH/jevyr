import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { canonicalize, digestJson, type CaseSubmission, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SELF_JUDGE_MISSION, assertSelfJudgeMission, createSelfJudgeMission, loadSelfJudgeMission, type SelfJudgeMission } from "./self-judge-mission.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "artifacts", ".jevyr", ".jevyr-advisory", ".tmp", ".next", ".turbo", ".lavish", "tmp", "dist", "build", "coverage", ".venv", "venv", "__pycache__", "secrets", "credentials", "private-keys"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".yaml", ".yml", ".toml", ".py", ".rego", ".wasm", ".html", ".css", ".scss", ".sql", ".sh", ".ps1", ".rs", ".go", ".lock"]);
const SOURCE_NAMES = new Set(["Dockerfile", "Makefile", "LICENSE"]);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|(?:secrets?|credentials?|tokens?|private[-_]?key)(?:\.(?:json|ya?ml|toml|txt|env))?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore))$/iu;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export interface SelfJudgeOptions {
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly intervalMs: number;
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly mission?: SelfJudgeMission;
}
export interface SelfJudgeManifest {
  readonly protocol: "jevyr.repository-self-snapshot/2";
  readonly missionDigest: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly digest: string }[];
  readonly totalBytes: number;
  readonly digest: string;
}
export interface SelfJudgeFailure { readonly code: string; readonly evidenceDigest: string }
export interface SelfJudgeResult {
  readonly caseId: string;
  readonly runDigest: string;
  readonly proofVerified: boolean;
  readonly integrity: "VALID" | "INVALID";
  readonly judgment?: "ACCEPT" | "REJECT" | "UNPROVEN";
  /** Independently verified binding failures, not provider opinions or plain INVALID status. */
  readonly bindingFailures: readonly SelfJudgeFailure[];
  /** Independently reproduced critical defects supporting REJECT, never provider self-reports. */
  readonly reproducedDefects?: readonly SelfJudgeFailure[];
}
export interface SelfJudgeCallbacks {
  /** Must await ordinary terminal signing and proof verification; honor signal by aborting only this Case. */
  readonly runCase: (input: { submission: CaseSubmission; manifest: SelfJudgeManifest; signal: AbortSignal }) => Promise<SelfJudgeResult>;
  /** Uses the existing quarantined offspring proposal path. Never signs or promotes. */
  readonly proposeOffspring: (input: { manifestDigest: string; caseId: string; runDigest: string; failures: readonly SelfJudgeFailure[] }) => Promise<void>;
  readonly onActivity?: (event: { kind: "judged" | "failed"; manifestDigest?: string; caseId?: string; detail: string }) => void;
}
export type SelfJudgeTick = { readonly status: "disabled" | "busy" | "unchanged" | "stopped" } | { readonly status: "judged"; readonly manifestDigest: string; readonly caseId: string; readonly proposalRecorded: boolean };

export function selfJudgeOptions(env: NodeJS.ProcessEnv, projectRoot: string): SelfJudgeOptions {
  const flag = env.JEVYR_SELF_JUDGE;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw new TypeError("JEVYR_SELF_JUDGE must be explicitly 0 or 1");
  const intervalMs = env.JEVYR_SELF_JUDGE_INTERVAL_MS === undefined ? 60_000 : Number(env.JEVYR_SELF_JUDGE_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) throw new TypeError("Self-judgment interval must be between ten seconds and one hour");
  return Object.freeze({ enabled: flag === "1", projectRoot: resolve(projectRoot), intervalMs, maximumFiles: 4096, maximumFileBytes: 1024 * 1024, maximumTotalBytes: 32 * 1024 * 1024, mission: flag === "1" ? loadSelfJudgeMission(env, projectRoot) : DEFAULT_SELF_JUDGE_MISSION });
}

function bounded(value: number, low: number, high: number): void { if (!Number.isSafeInteger(value) || value < low || value > high) throw new TypeError("Self-judgment limits must be finite positive integers"); }
function within(root: string, path: string): boolean { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); }
async function cleanupSnapshot(path: string): Promise<void> {
  const target = resolve(path), temporary = resolve(tmpdir());
  if (!within(temporary, target) || !basename(target).startsWith("jevyr-self-snapshot-")) throw new Error("Self-judgment cleanup target escaped its temporary workspace");
  await rm(target, { recursive: true, force: true });
}

async function capture(options: SelfJudgeOptions, signal: AbortSignal): Promise<{ manifest: SelfJudgeManifest; contents: readonly Uint8Array[] }> {
  const root = await realpath(options.projectRoot);
  const files: { path: string; size: number; digest: string }[] = [];
  const contents: Uint8Array[] = [];
  let totalBytes = 0, entriesVisited = 0;
  async function walk(directory: string): Promise<void> {
    signal.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      signal.throwIfAborted();
      if (++entriesVisited > options.maximumFiles * 16) throw new RangeError("Self-judgment traversal exceeded its finite entry bound");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase()) || entry.name.startsWith(".") && entry.name !== ".github") continue;
        const resolved = await realpath(path); if (!within(root, resolved)) throw new Error("Self-judgment directory escaped the source root");
        await walk(path); continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".") || SENSITIVE_NAME.test(entry.name) || !(SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || SOURCE_NAMES.has(entry.name))) continue;
      if (files.length >= options.maximumFiles) throw new RangeError("Self-judgment source file bound was exceeded");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Self-judgment refuses aliased source files");
      const canonicalPath = await realpath(path);
      if (!within(root, canonicalPath)) throw new Error("Self-judgment file escaped the source root");
      if (before.size > options.maximumFileBytes || totalBytes + before.size > options.maximumTotalBytes) throw new RangeError("Self-judgment source byte bound was exceeded");
      const opened = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const actual = await opened.stat();
        if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw new Error("Self-judgment source changed before capture");
        const boundedBytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < boundedBytes.length) {
          signal.throwIfAborted();
          const read = await opened.read(boundedBytes, length, boundedBytes.length - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        bytes = boundedBytes.subarray(0, length);
        const after = await opened.stat();
        if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Self-judgment source changed during capture");
        if (await realpath(path) !== canonicalPath) throw new Error("Self-judgment source alias changed during capture");
      } finally { await opened.close(); }
      const relativePath = relative(root, path).split(sep).join("/");
      files.push({ path: relativePath, size: bytes.length, digest: sha(bytes) }); contents.push(bytes); totalBytes += bytes.length;
    }
  }
  await walk(root);
  if (files.length === 0) throw new Error("Self-judgment found no permitted source files");
  const body = { protocol: "jevyr.repository-self-snapshot/2" as const, missionDigest: (options.mission ?? DEFAULT_SELF_JUDGE_MISSION).digest, files, totalBytes };
  return { manifest: Object.freeze({ ...body, files: Object.freeze(files.map(file => Object.freeze(file))), digest: digestJson(body as unknown as JsonValue) }), contents };
}

/** Opt-in bounded watcher: one immutable source capture and ordinary Case at a time. */
export class RepositorySelfJudge {
  readonly #options: SelfJudgeOptions;
  readonly #callbacks: SelfJudgeCallbacks;
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<SelfJudgeTick> | undefined;
  #lastManifestDigest: string | undefined;
  #pendingProposal: Parameters<SelfJudgeCallbacks["proposeOffspring"]>[0] | undefined;
  #started = false;
  constructor(options: SelfJudgeOptions, callbacks: SelfJudgeCallbacks) {
    bounded(options.intervalMs, 10_000, 3_600_000); bounded(options.maximumFiles, 1, 16_384); bounded(options.maximumFileBytes, 1, 4 * 1024 * 1024); bounded(options.maximumTotalBytes, options.maximumFileBytes, 128 * 1024 * 1024);
    const suppliedMission = options.mission ?? DEFAULT_SELF_JUDGE_MISSION;
    assertSelfJudgeMission(suppliedMission);
    const { digest: _missionDigest, ...missionBody } = suppliedMission;
    this.#options = Object.freeze({ ...options, mission: createSelfJudgeMission(missionBody), projectRoot: resolve(options.projectRoot) }); this.#callbacks = callbacks;
  }
  start(): void {
    if (this.#started || !this.#options.enabled || this.#controller.signal.aborted) return;
    this.#started = true;
    const iteration = async (): Promise<void> => {
      try { await this.tick(); }
      catch (error) { if (!this.#controller.signal.aborted) this.#callbacks.onActivity?.({ kind: "failed", detail: error instanceof Error ? error.message : "Self-judgment failed" }); }
      if (!this.#controller.signal.aborted) { this.#timer = setTimeout(() => { void iteration(); }, this.#options.intervalMs); this.#timer.unref(); }
    };
    void iteration();
  }
  async tick(): Promise<SelfJudgeTick> {
    if (!this.#options.enabled) return { status: "disabled" };
    if (this.#controller.signal.aborted) return { status: "stopped" };
    if (this.#running) return { status: "busy" };
    const operation = this.#execute(); this.#running = operation;
    try { return await operation; } finally { if (this.#running === operation) this.#running = undefined; }
  }
  async stop(): Promise<void> {
    this.#controller.abort(new Error("Repository self-judgment is stopping"));
    if (this.#timer) clearTimeout(this.#timer);
    try { await this.#running; } catch { /* The interrupted Case retains its ordinary INVALID terminal proof. */ }
  }
  async #execute(): Promise<SelfJudgeTick> {
    if (this.#pendingProposal !== undefined) return await this.#flushPendingProposal();
    const signal = this.#controller.signal;
    const captured = await capture(this.#options, signal);
    if (captured.manifest.digest === this.#lastManifestDigest) return { status: "unchanged" };
    const workspace = await mkdtemp(join(tmpdir(), "jevyr-self-snapshot-"));
    try {
      const sourceRoot = join(workspace, "source"); await mkdir(sourceRoot);
      for (const [index, file] of captured.manifest.files.entries()) {
        signal.throwIfAborted(); const target = join(sourceRoot, ...file.path.split("/"));
        if (!within(sourceRoot, target)) throw new Error("Self-judgment manifest escaped its source snapshot");
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, captured.contents[index]!, { flag: "wx" });
      }
      const manifestPath = join(workspace, "manifest.json"); await writeFile(manifestPath, canonicalize(captured.manifest as unknown as JsonValue), { flag: "wx" });
      signal.throwIfAborted();
      const mission = this.#options.mission ?? DEFAULT_SELF_JUDGE_MISSION;
      const submission: CaseSubmission = { protocol: "jevyr.case/1", case: { impulse: mission.impulse, mode: "auto", subjects: [{ id: "own-repository", kind: "directory", locator: sourceRoot }, { id: "self-judge-manifest", kind: "file", locator: manifestPath }], constraints: ["The source repository is read-only. Do not change its files, policy, active Genome, or approval state.", ...mission.constraints], requestedAssays: mission.requestedAssays, privacy: "local_only", control: "sovereign", seed: captured.manifest.digest.slice(7) } };
      const result = await this.#callbacks.runCase({ submission, manifest: captured.manifest, signal });
      const failuresValid = (value: unknown): value is readonly SelfJudgeFailure[] => Array.isArray(value) && value.length <= 64 && value.every(failure => failure !== null && typeof failure === "object" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(failure.code) && SHA.test(failure.evidenceDigest));
      if (!/^case_[a-f0-9]{16}$/u.test(result.caseId) || !SHA.test(result.runDigest) || typeof result.proofVerified !== "boolean" || !["VALID", "INVALID"].includes(result.integrity) || result.judgment !== undefined && !["ACCEPT", "REJECT", "UNPROVEN"].includes(result.judgment) || !failuresValid(result.bindingFailures) || result.reproducedDefects !== undefined && !failuresValid(result.reproducedDefects)) throw new TypeError("Self-judgment callback returned an invalid ordinary Case result");
      this.#lastManifestDigest = captured.manifest.digest;
      const failures = result.integrity === "INVALID" ? result.bindingFailures : result.judgment === "REJECT" ? result.reproducedDefects ?? [] : [];
      if (result.proofVerified && failures.length > 0) {
        this.#pendingProposal = Object.freeze({ manifestDigest: captured.manifest.digest, caseId: result.caseId, runDigest: result.runDigest, failures: Object.freeze(failures.map(failure => Object.freeze({ ...failure }))) });
        return await this.#flushPendingProposal();
      }
      this.#callbacks.onActivity?.({ kind: "judged", manifestDigest: captured.manifest.digest, caseId: result.caseId, detail: "Changed source judged through an ordinary signed Case." });
      return { status: "judged", manifestDigest: captured.manifest.digest, caseId: result.caseId, proposalRecorded: false };
    } finally { await cleanupSnapshot(workspace); }
  }
  async #flushPendingProposal(): Promise<SelfJudgeTick> {
    const pending = this.#pendingProposal!;
    await this.#callbacks.proposeOffspring(pending);
    this.#pendingProposal = undefined;
    this.#callbacks.onActivity?.({ kind: "judged", manifestDigest: pending.manifestDigest, caseId: pending.caseId, detail: "Changed source judged; independently verified failure queued as a quarantined offspring proposal." });
    return { status: "judged", manifestDigest: pending.manifestDigest, caseId: pending.caseId, proposalRecorded: true };
  }
}
