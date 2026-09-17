import { createHash, type Hash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createCaseEvent, parseJsonText, verifyEventChain, type EventDraft as CoreEventDraft } from "@jevyr/core";
import type { CaseEvent, EventKind } from "@jevyr/protocol";

const CASE_ID = /^(?:case|jvr)_[a-zA-Z0-9_-]{8,128}$/u;
const MAX_STABLE_READ_ATTEMPTS = 3;

function assertCaseId(caseId: string): void {
  if (!CASE_ID.test(caseId)) throw new TypeError("Invalid Jevyr case identifier");
}

export type RuntimeEventDraft<K extends EventKind = EventKind> =
  Omit<CoreEventDraft<K>, "observedAt"> & {
    readonly caseId: string;
    readonly observedAt?: string;
  };

export interface EventPage {
  readonly events: readonly CaseEvent[];
  readonly nextCursor: number;
  readonly latestSequence: number;
  /** Current full-ledger head, which can be ahead of a limited page. */
  readonly headDigest: string | null;
}

export interface AppendOnlyEventHub {
  append<K extends EventKind>(draft: RuntimeEventDraft<K>): Promise<CaseEvent<K>>;
  read(caseId: string): Promise<readonly CaseEvent[]>;
  list(caseId: string, after?: number, limit?: number): Promise<EventPage>;
  wait(caseId: string, after: number, timeoutMs: number, signal?: AbortSignal, limit?: number): Promise<EventPage>;
  lastSequence(caseId: string): Promise<number>;
  subscribe(caseId: string, listener: (event: CaseEvent) => void): () => void;
}

interface FileStamp {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface VerifiedLedger {
  readonly events: CaseEvent[];
  readonly exists: boolean;
  readonly stamp: FileStamp | null;
  readonly byteLength: number;
  /** Incrementally updated digest state for the exact verified NDJSON bytes. */
  readonly rawHash: Hash;
}

interface StableLedgerRead {
  readonly bytes: Buffer;
  readonly stamp: FileStamp;
}

function stampOf(value: {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: bigint | number;
  readonly mtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  readonly mtimeMs: bigint | number;
  readonly ctimeMs: bigint | number;
}): FileStamp {
  return {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    size: BigInt(value.size),
    mtimeNs: value.mtimeNs ?? BigInt(Math.trunc(Number(value.mtimeMs) * 1_000_000)),
    ctimeNs: value.ctimeNs ?? BigInt(Math.trunc(Number(value.ctimeMs) * 1_000_000)),
  };
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function completedHash(hash: Hash): string {
  return hash.copy().digest("hex");
}

function hashBytes(bytes: Uint8Array): Hash {
  return createHash("sha256").update(bytes);
}

function ledgerError(message: string): Error {
  return new Error(`Corrupt Jevyr event ledger: ${message}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * An fsync-backed canonical CaseEvent ledger plus in-process fanout. Cursor zero
 * means before the first 1-based event. Files are append-only; status is a cache.
 *
 * A verified per-case tail makes ordinary append/list/lastSequence operations
 * constant-time with respect to ledger length (apart from the returned page).
 * Unexpected file metadata changes trigger a stable re-read, full chain check,
 * and an exact-byte comparison of the previously verified prefix. This permits
 * a valid append from another process while refusing truncation or rewriting.
 */
export class FileEventHub implements AppendOnlyEventHub {
  private readonly emitter = new EventEmitter();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly verified = new Map<string, VerifiedLedger>();

  constructor(private readonly dataDir: string) {
    this.emitter.setMaxListeners(0);
  }

  private path(caseId: string): string {
    assertCaseId(caseId);
    return join(this.dataDir, "cases", caseId, "events.ndjson");
  }

  async append<K extends EventKind>(draft: RuntimeEventDraft<K>): Promise<CaseEvent<K>> {
    assertCaseId(draft.caseId);
    let emitted: CaseEvent<K> | undefined;
    const previous = this.queues.get(draft.caseId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const durable = await this.readAll(draft.caseId);
      const previousEvent = durable.at(-1);
      if (previousEvent && (previousEvent.caseDigest !== draft.caseDigest || previousEvent.runDigest !== draft.runDigest)) {
        throw new Error("Refusing to append an event for a different sealed run");
      }
      const { caseId: _caseId, observedAt, ...coreDraft } = draft;
      emitted = createCaseEvent(
        { ...coreDraft, observedAt: observedAt ?? new Date().toISOString() } as CoreEventDraft<K>,
        (previousEvent?.sequence ?? 0) + 1,
        previousEvent?.eventDigest ?? null,
      );

      const directory = join(this.dataDir, "cases", draft.caseId);
      await mkdir(directory, { recursive: true });
      const eventPath = this.path(draft.caseId);
      const line = Buffer.from(`${JSON.stringify(emitted)}\n`, "utf8");
      const cached = this.verified.get(draft.caseId);
      if (!cached) throw new Error("Verified event ledger cache was unexpectedly absent");

      const handle = await open(eventPath, "a+", 0o600);
      let postStamp: FileStamp | undefined;
      try {
        const preStamp = stampOf(await handle.stat({ bigint: true }));
        if (cached.exists) {
          if (!cached.stamp || !sameStamp(preStamp, cached.stamp)) {
            throw ledgerError("file changed while preparing an append");
          }
        } else if (preStamp.size !== 0n) {
          throw ledgerError("file appeared with content while preparing an append");
        }

        await handle.appendFile(line);
        await handle.sync();
        postStamp = stampOf(await handle.stat({ bigint: true }));
        const expectedSize = preStamp.size + BigInt(line.byteLength);
        if (postStamp.size !== expectedSize) {
          throw ledgerError("file changed concurrently during append");
        }
      } finally {
        await handle.close();
      }

      if (!postStamp) throw new Error("Event append did not produce durable file metadata");
      cached.events.push(emitted as CaseEvent);
      const nextHash = cached.rawHash.copy().update(line);
      this.verified.set(draft.caseId, {
        events: cached.events,
        exists: true,
        stamp: postStamp,
        byteLength: cached.byteLength + line.byteLength,
        rawHash: nextHash,
      });
      this.emitter.emit(draft.caseId, emitted);
    });
    this.queues.set(draft.caseId, operation);
    try {
      await operation;
    } finally {
      if (this.queues.get(draft.caseId) === operation) this.queues.delete(draft.caseId);
    }
    if (!emitted) throw new Error("Event append did not produce an event");
    return emitted;
  }

  async list(caseId: string, after = 0, limit = 500): Promise<EventPage> {
    assertCaseId(caseId);
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Event cursor must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
      throw new TypeError("Event page limit must be an integer from 1 through 2000");
    }
    const boundedLimit = limit;
    const queue = this.queues.get(caseId);
    if (queue) await queue;
    const all = await this.readAll(caseId);
    // Canonical sequences are contiguous and 1-based, so cursor N is array index N.
    const events = structuredClone(all.slice(after, after + boundedLimit));
    return {
      events,
      nextCursor: events.at(-1)?.sequence ?? after,
      latestSequence: all.length,
      headDigest: all.at(-1)?.eventDigest ?? null,
    };
  }

  async read(caseId: string): Promise<readonly CaseEvent[]> {
    assertCaseId(caseId);
    const queue = this.queues.get(caseId);
    if (queue) await queue;
    return structuredClone(await this.readAll(caseId));
  }

  async wait(caseId: string, after: number, timeoutMs: number, signal?: AbortSignal, limit = 500): Promise<EventPage> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new TypeError("Event wait timeout must be an integer from 0 through 30000 milliseconds");
    }
    const immediate = await this.list(caseId, after, limit);
    if (immediate.events.length > 0 || timeoutMs <= 0) return immediate;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.emitter.removeListener(caseId, onEvent);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => finish();
      const onEvent = (event: CaseEvent): void => {
        if (event.sequence > after) finish();
      };
      timer = setTimeout(finish, timeoutMs);
      this.emitter.on(caseId, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        finish();
        return;
      }
      void this.list(caseId, after, limit).then((page) => {
        if (page.events.length > 0) finish();
      }, finish);
    });
    return await this.list(caseId, after, limit);
  }

  async lastSequence(caseId: string): Promise<number> {
    const queue = this.queues.get(caseId);
    if (queue) await queue;
    return (await this.readAll(caseId)).length;
  }

  subscribe(caseId: string, listener: (event: CaseEvent) => void): () => void {
    assertCaseId(caseId);
    this.emitter.on(caseId, listener);
    return () => this.emitter.removeListener(caseId, listener);
  }

  private async readAll(caseId: string): Promise<readonly CaseEvent[]> {
    const cached = this.verified.get(caseId);
    let currentStamp: FileStamp;
    try {
      currentStamp = stampOf(await stat(this.path(caseId), { bigint: true }));
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (cached?.exists) throw ledgerError("verified file was removed");
      if (cached) return cached.events;
      const empty: VerifiedLedger = {
        events: [],
        exists: false,
        stamp: null,
        byteLength: 0,
        rawHash: hashBytes(Buffer.alloc(0)),
      };
      this.verified.set(caseId, empty);
      return empty.events;
    }

    if (cached?.exists && cached.stamp && sameStamp(currentStamp, cached.stamp)) return cached.events;

    const loaded = await this.readStable(caseId);
    const parsed = this.parseAndVerify(loaded.bytes);

    if (cached?.exists) {
      if (loaded.bytes.byteLength < cached.byteLength) {
        throw ledgerError(`file was truncated from ${cached.byteLength} to ${loaded.bytes.byteLength} bytes`);
      }
      const priorBytes = loaded.bytes.subarray(0, cached.byteLength);
      if (completedHash(hashBytes(priorBytes)) !== completedHash(cached.rawHash)) {
        throw ledgerError("previously verified bytes were externally rewritten");
      }
      if (parsed.length < cached.events.length) {
        throw ledgerError(`event sequence was truncated from ${cached.events.length} to ${parsed.length}`);
      }
      for (let index = 0; index < cached.events.length; index += 1) {
        if (parsed[index]?.eventDigest !== cached.events[index]?.eventDigest) {
          throw ledgerError(`previously verified event ${index + 1} was externally rewritten`);
        }
      }
    }

    const verified: VerifiedLedger = {
      events: parsed,
      exists: true,
      stamp: loaded.stamp,
      byteLength: loaded.bytes.byteLength,
      rawHash: hashBytes(loaded.bytes),
    };
    this.verified.set(caseId, verified);
    return verified.events;
  }

  private async readStable(caseId: string): Promise<StableLedgerRead> {
    const eventPath = this.path(caseId);
    for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      let before: FileStamp;
      let bytes: Buffer;
      let after: FileStamp;
      try {
        before = stampOf(await stat(eventPath, { bigint: true }));
        bytes = await readFile(eventPath);
        after = stampOf(await stat(eventPath, { bigint: true }));
      } catch (error) {
        if (isMissing(error)) throw ledgerError("file disappeared during verification");
        throw error;
      }
      if (sameStamp(before, after) && after.size === BigInt(bytes.byteLength)) return { bytes, stamp: after };
    }
    throw ledgerError("file kept changing during verification");
  }

  private parseAndVerify(bytes: Buffer): CaseEvent[] {
    if (bytes.byteLength === 0) return [];
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw ledgerError("event ledger is not valid UTF-8");
    }
    if (!content.endsWith("\n")) throw ledgerError("truncated or torn final line");

    const lines = content.split("\n");
    lines.pop();
    const result: CaseEvent[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) throw ledgerError(`malformed blank line at ${index + 1}`);
      try {
        const value = parseJsonText(line, `Event ledger line ${index + 1}`);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("event must be a JSON object");
        }
        result.push(value as CaseEvent);
      } catch (error) {
        throw ledgerError(`malformed JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let verification;
    try {
      verification = verifyEventChain(result);
    } catch (error) {
      throw ledgerError(`invalid event shape: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!verification.valid) {
      throw ledgerError(verification.problems.map((problem) => `${problem.code}@${problem.sequence}`).join(", "));
    }
    return result;
  }
}
