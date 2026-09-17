import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compileIntentContract, parseJsonBytes } from "@jevyr/core";
import { assertCaseSubmission, digestJson, validateAirlockChoices, type AirlockChoices, type CaseSubmission, type JsonValue, type SealReceipt } from "@jevyr/protocol";

const MAX_BYTES = 1_048_576;
const MAX_DRAFTS = 128;
const MAX_REVISIONS = 32;
export class AirlockError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface AirlockDraft {
  readonly protocol: "jevyr.airlock-draft/1";
  readonly draftId: string;
  readonly revision: number;
  readonly state: "DRAFT" | "SEALING" | "SEALED" | "FAILED";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submission: CaseSubmission;
  readonly submissionDigest: string;
  readonly preview: ReturnType<typeof compileIntentContract>;
  readonly choices: AirlockChoices;
  readonly choicesDigest: string;
  readonly receipt?: SealReceipt;
}
function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new AirlockError(400, `Expected exactly ${fields.join(", ")}`);
}
function submission(value: unknown): CaseSubmission {
  assertCaseSubmission(value);
  if (value.case.seed !== undefined && !/^[a-f0-9]{64}$/u.test(value.case.seed)) throw new AirlockError(400, "A locked Airlock seed must contain 256 bits as 64 lowercase hexadecimal characters");
  // Defaults belong to the editable draft and are visible before sealing.
  // Bare Cast retains its existing transport-neutral deterministic semantics.
  const normalized: CaseSubmission = { ...value, case: { ...value.case,
    control: value.case.control ?? "juggler", privacy: value.case.privacy ?? "local_only", seed: value.case.seed ?? randomBytes(32).toString("hex") } };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BYTES - 16_384) throw new AirlockError(413, "Draft exceeds its storage bound");
  return structuredClone(normalized);
}
async function readOwned(path: string): Promise<unknown | undefined> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("Unsafe Airlock file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_BYTES || stats.ino !== entry.ino || stats.dev !== entry.dev) throw new Error("Unsafe Airlock file");
    return parseJsonBytes(await handle.readFile(), "Airlock state");
  } finally { await handle.close(); }
}
async function createOnce(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new AirlockError(413, "Draft exceeds its storage bound");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Append-only draft revisions; a durable seal claim permanently closes editing.
 * An interrupted seal remains SEALING: replaying a submission could create a
 * second Case, so uncertain admission is never automatically retried.
 */
export class AirlockDraftStore {
  private readonly root: string;
  constructor(dataDir: string) { this.root = resolve(dataDir, "drafts"); }
  private async directory(id?: string): Promise<string> {
    if (id !== undefined && !/^draft_[a-f0-9]{32}$/u.test(id)) throw new AirlockError(400, "Invalid draft identifier");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    if ((await lstat(this.root)).isSymbolicLink() || root.toLowerCase() !== this.root.toLowerCase()) throw new Error("Airlock root must be an owned directory");
    if (!id) return root;
    const directory = join(root, id);
    const stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new AirlockError(404, "Draft not found");
      throw error;
    });
    if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("Unsafe Airlock directory");
    return directory;
  }
  private async exclusive<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const lock = join(directory, "mutation.lock");
    const handle = await open(lock, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new AirlockError(409, "Draft is being modified or an interrupted mutation needs inspection");
      throw error;
    });
    try { return await operation(); }
    finally { await handle.close(); await unlink(lock); }
  }
  private async load(directory: string): Promise<AirlockDraft> {
    const files = (await readdir(directory)).filter((name) => /^revision-\d{2}\.json$/u.test(name)).sort();
    if (files.length < 1 || files.length > MAX_REVISIONS
      || files.some((name, index) => name !== `revision-${String(index + 1).padStart(2, "0")}.json`)) throw new Error("Draft revision sequence is damaged");
    const stored = await readOwned(join(directory, files.at(-1)!)) as AirlockDraft;
    if (!stored || stored.revision !== files.length || stored.state !== "DRAFT"
      || stored.submissionDigest !== digestJson(stored.submission as unknown as JsonValue)) throw new Error("Draft revision is damaged");
    assertCaseSubmission(stored.submission);
    validateAirlockChoices(stored.choices);
    if (stored.choicesDigest !== digestJson(stored.choices as JsonValue)) throw new Error("Draft execution choices are damaged");
    const claim = await readOwned(join(directory, "seal-claim.json"));
    if (!claim) return stored;
    const receipt = await readOwned(join(directory, "seal-receipt.json")) as SealReceipt | undefined;
    if (receipt) {
      if (receipt.submissionDigest !== stored.submissionDigest) throw new Error("Draft receipt belongs to a different submission");
      return { ...stored, state: "SEALED", receipt };
    }
    return { ...stored, state: await readOwned(join(directory, "seal-failed.json")) ? "FAILED" : "SEALING" };
  }
  private draft(id: string, revision: number, value: CaseSubmission, choices: AirlockChoices, createdAt = new Date().toISOString()): AirlockDraft {
    return { protocol: "jevyr.airlock-draft/1", draftId: id, revision, state: "DRAFT", createdAt,
      updatedAt: new Date().toISOString(), submission: value, submissionDigest: digestJson(value as unknown as JsonValue),
      choices, choicesDigest: digestJson(choices as JsonValue),
      preview: compileIntentContract({ impulse: value.case.impulse, ...(value.case.constraints ? { constraints: value.case.constraints } : {}),
        ...(value.case.requestedAssays ? { requestedAssays: value.case.requestedAssays } : {}), subjectIds: value.case.subjects?.map((entry) => entry.id) ?? [] }) };
  }
  async create(value: unknown): Promise<AirlockDraft> {
    const normalized = submission(value);
    const root = await this.directory();
    return await this.exclusive(root, async () => {
    if ((await readdir(root)).filter((name) => name.startsWith("draft_")).length >= MAX_DRAFTS) throw new AirlockError(429, "Airlock draft capacity reached; archive completed drafts locally");
    const id = `draft_${randomBytes(16).toString("hex")}`;
    const directory = join(root, id);
    await mkdir(directory, { mode: 0o700 });
    const draft = this.draft(id, 1, normalized, {});
    await createOnce(join(directory, "revision-01.json"), draft);
    return draft;
    });
  }
  async read(id: string): Promise<AirlockDraft> {
    const directory = await this.directory(id);
    return await this.exclusive(directory, async () => await this.load(directory));
  }
  async replace(id: string, value: unknown): Promise<AirlockDraft> {
    exact(value, ["revision", "submission", ...(value && typeof value === "object" && Object.hasOwn(value, "choices") ? ["choices"] : [])]);
    const normalized = submission(value.submission);
    const directory = await this.directory(id);
    return await this.exclusive(directory, async () => {
      const current = await this.load(directory);
      if (current.state !== "DRAFT") throw new AirlockError(409, "This draft has entered sealing and is immutable");
      if (value.revision !== current.revision) throw new AirlockError(409, "Draft revision changed; reload before editing");
      if (current.revision >= MAX_REVISIONS) throw new AirlockError(409, "Draft revision limit reached; create a new draft");
      const choices = value.choices === undefined ? current.choices : validateAirlockChoices(value.choices);
      const next = this.draft(id, current.revision + 1, normalized, choices, current.createdAt);
      await createOnce(join(directory, `revision-${String(next.revision).padStart(2, "0")}.json`), next);
      return next;
    });
  }
  async seal(id: string, value: unknown, cast: (submission: CaseSubmission, choices: AirlockChoices) => Promise<{ receipt: SealReceipt }>): Promise<AirlockDraft> {
    exact(value, ["revision"]);
    const directory = await this.directory(id);
    return await this.exclusive(directory, async () => {
      const current = await this.load(directory);
      if (current.state !== "DRAFT" || current.revision !== value.revision) throw new AirlockError(409, "Only the exact current DRAFT revision can be sealed once");
      await createOnce(join(directory, "seal-claim.json"), { revision: current.revision, submissionDigest: current.submissionDigest, choicesDigest: current.choicesDigest, claimedAt: new Date().toISOString() });
      try {
        const { receipt } = await cast(current.submission, current.choices);
        if (receipt.submissionDigest !== current.submissionDigest) throw new Error("Seal changed the approved draft submission");
        await createOnce(join(directory, "seal-receipt.json"), receipt);
        return { ...current, state: "SEALED", receipt };
      } catch (error) {
        await createOnce(join(directory, "seal-failed.json"), { admission: "uncertain", retryAllowed: false }).catch(() => undefined);
        throw error;
      }
    });
  }
}
