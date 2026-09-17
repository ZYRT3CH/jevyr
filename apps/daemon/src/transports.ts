import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseJsonBytes } from "@jevyr/core";
import { assertCaseSubmission, type CaseSubmission } from "@jevyr/protocol";
import { readMcpInputFrames } from "./mcp.js";
import type { DaemonRuntime } from "./runtime.js";

export const MAX_CAST_TRANSPORT_BYTES = 1_048_576;

export class TransportError extends TypeError {
  constructor(readonly status: number, message: string) { super(message); }
}

export function transportObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function transportKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError(`${label} contains an unknown field`);
}

function utf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} must be valid UTF-8`); }
}

/** One complete Cast, transported as a JSON file and optional named UTF-8 subjects. */
export function parseMultipartCast(bytes: Uint8Array, contentType: string): CaseSubmission {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))\s*$/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.endsWith(" ")) throw new TypeError("Multipart Cast requires one valid boundary");
  const body = Buffer.from(bytes);
  const first = Buffer.from(`--${boundary}\r\n`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, first.length).equals(first)) throw new TypeError("Multipart preambles are not accepted");
  const parts = new Map<string, Buffer>();
  let cursor = first.length;
  while (true) {
    const headerEnd = body.indexOf("\r\n\r\n", cursor, "ascii");
    if (headerEnd < cursor || headerEnd - cursor > 8_192) throw new TypeError("Multipart headers are missing or too large");
    const headers = new Map<string, string>();
    for (const line of utf8(body.subarray(cursor, headerEnd), "Multipart headers").split("\r\n")) {
      const header = /^([A-Za-z-]+):[ \t]*([^\r\n]*)$/u.exec(line);
      if (!header) throw new TypeError("Malformed multipart header");
      const key = header[1]!.toLowerCase();
      if (!["content-disposition", "content-type"].includes(key) || headers.has(key)) throw new TypeError("Unknown or duplicate multipart header");
      headers.set(key, header[2]!);
    }
    const disposition = /^form-data;\s*name="([A-Za-z0-9_.:-]{1,128})"(?:;\s*filename="([^"\\/\x00-\x1f]{1,255})")?$/u.exec(headers.get("content-disposition") ?? "");
    if (!disposition) throw new TypeError("Multipart parts require a safe form-data name and optional basename");
    const name = disposition[1]!;
    if (name !== "case" && !/^subject:[A-Za-z0-9_.-]+$/u.test(name)) throw new TypeError("Only case and subject:<id> parts are accepted");
    if (parts.has(name) || parts.size >= 65) throw new TypeError("Duplicate or excessive multipart parts");
    const start = headerEnd + 4;
    const end = body.indexOf(separator, start);
    if (end < start) throw new TypeError("Multipart closing boundary is missing");
    parts.set(name, body.subarray(start, end));
    cursor = end + separator.length;
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "--") {
      const tail = body.subarray(cursor + 2);
      if (tail.length !== 0 && !(tail.length === 2 && tail.toString("ascii") === "\r\n")) throw new TypeError("Multipart epilogues are not accepted");
      break;
    }
    if (body.subarray(cursor, cursor + 2).toString("ascii") !== "\r\n") throw new TypeError("Malformed multipart boundary");
    cursor += 2;
  }
  const manifest = parts.get("case");
  if (!manifest) throw new TypeError("Multipart Cast requires exactly one case JSON part");
  const value = parseJsonBytes(manifest, "Multipart Cast");
  assertCaseSubmission(value);
  const submission = structuredClone(value);
  parts.delete("case");
  // Expansion happens before Cast. The sealed intent is exactly the equivalent
  // JSON Case with these UTF-8 strings inline; no transport path enters its hash.
  for (const subject of submission.case.subjects ?? []) {
    const name = `subject:${subject.id}`;
    const attachment = parts.get(name);
    if (!attachment) {
      if (subject.locator === `upload:${subject.id}`) throw new TypeError(`Missing multipart subject ${subject.id}`);
      continue;
    }
    if (subject.kind !== "text" || subject.locator !== `upload:${subject.id}`) throw new TypeError("Uploaded subjects must be text with locator upload:<id>");
    subject.locator = utf8(attachment, `Uploaded subject ${subject.id}`);
    parts.delete(name);
  }
  if (parts.size !== 0) throw new TypeError("Multipart contains an undeclared subject");
  assertCaseSubmission(submission);
  return submission;
}

export interface JsonlTransport {
  readonly input: AsyncIterable<Uint8Array>;
  /** Awaiting send provides backpressure on stdout and embedded transports. */
  send(line: string): Promise<void> | void;
}

/** Case deadlines belong to the sealed runtime, not a 30-second client poll. */
export async function waitForTransportClosure(runtime: DaemonRuntime, caseId: string): Promise<void> {
  while (true) {
    const status = await runtime.status(caseId);
    if (!status) throw new Error("Accepted Case disappeared before transport closure");
    if ((status.lifecycle === "terminated" || status.lifecycle === "invalid") && await runtime.repository.terminalReceipt(caseId)) return;
    await runtime.events.wait(caseId, status.lastSequence, 1_000);
  }
}

/** LF-delimited request/response, sequential and bounded; stdout is protocol only. */
export async function serveJsonl(runtime: DaemonRuntime, transport: JsonlTransport): Promise<void> {
  await runtime.ready();
  const pending = new Set<Promise<void>>();
  let closureFailure: unknown;
  for await (const frame of readMcpInputFrames(transport.input, MAX_CAST_TRANSPORT_BYTES)) {
    let id: string | number | null = null;
    try {
      if (frame.error) throw new TypeError("JSONL request exceeds its byte limit");
      const value = transportObject(parseJsonBytes(frame.bytes!, "JSONL request"), "JSONL request");
      transportKeys(value, ["protocol", "id", "operation", "submission", "caseId", "after", "limit"], "JSONL request");
      if (value.protocol !== "jevyr.jsonl/1") throw new TypeError("JSONL protocol must equal jevyr.jsonl/1");
      if (!(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256)
        && !(typeof value.id === "number" && Number.isSafeInteger(value.id))) throw new TypeError("JSONL id must be a bounded string or safe integer");
      id = value.id as string | number;
      let result: unknown;
      if (value.operation === "cast") {
        transportKeys(value, ["protocol", "id", "operation", "submission"], "JSONL Cast");
        assertCaseSubmission(value.submission);
        if (pending.size >= 32) await Promise.race(pending);
        if (closureFailure) throw new Error("An accepted Case failed to close safely");
        const cast = await runtime.orchestrator.cast(value.submission);
        const completed = waitForTransportClosure(runtime, cast.caseId)
          .catch((error: unknown) => { closureFailure = error; })
          .finally(() => pending.delete(completed));
        pending.add(completed);
        result = cast.receipt;
      } else if (value.operation === "trust") {
        transportKeys(value, ["protocol", "id", "operation"], "JSONL trust read");
        result = await runtime.repository.publicTrustBundle();
      } else {
        transportKeys(value, ["protocol", "id", "operation", "caseId", ...(value.operation === "events" ? ["after", "limit"] : [])], "JSONL read");
        if (typeof value.caseId !== "string" || !/^case_[a-f0-9]{16}$/u.test(value.caseId)) throw new TypeError("JSONL reads require a canonical caseId");
        if (!await runtime.status(value.caseId)) throw new TypeError("Case not found");
        switch (value.operation) {
          case "status": result = await runtime.status(value.caseId); break;
          case "record": result = await runtime.repository.record(value.caseId) ?? null; break;
          case "terminal": result = await runtime.repository.terminalReceipt(value.caseId) ?? null; break;
          case "seal": result = await runtime.repository.receipt(value.caseId) ?? null; break;
          case "seal-envelope": result = await runtime.repository.sealEnvelope(value.caseId) ?? null; break;
          case "record-envelope": result = await runtime.repository.recordEnvelope(value.caseId) ?? null; break;
          case "terminal-envelope": result = await runtime.repository.terminalEnvelope(value.caseId) ?? null; break;
          case "artifacts": result = await runtime.repository.artifacts(value.caseId); break;
          case "events": {
            const after = value.after ?? 0;
            const limit = value.limit ?? 500;
            if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0
              || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new TypeError("Invalid JSONL event cursor or limit");
            if (after > await runtime.events.lastSequence(value.caseId)) throw new TypeError("JSONL cursor is beyond the ledger");
            result = await runtime.events.list(value.caseId, after, limit);
            break;
          }
          default: throw new TypeError("Unknown operation; sealed Cases have no continuation, approval, or verdict input");
        }
      }
      await transport.send(JSON.stringify({ protocol: "jevyr.jsonl/1", id, result }));
    } catch (error) {
      await transport.send(JSON.stringify({ protocol: "jevyr.jsonl/1", id, error: error instanceof TypeError || error instanceof SyntaxError ? error.message : "JSONL operation failed" }));
    }
  }
  // Closing stdin closes the input surface, not an already sealed lifecycle.
  await Promise.all(pending);
  if (closureFailure) throw closureFailure;
}

async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, join(directory, name));
}

/** Reads a claimed immutable bundle without following links or accepting mutation. */
async function readBundle(path: string): Promise<CaseSubmission> {
  const parent = await lstat(path, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new TypeError("Drop bundle must be a real directory");
  const entries = await readdir(path);
  if (entries.length !== 1 || entries[0] !== "case.json") throw new TypeError("Drop bundle must contain exactly case.json");
  const file = join(path, "case.json");
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CAST_TRANSPORT_BYTES)) throw new TypeError("Drop case.json must be a bounded regular file with one link");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new TypeError("Drop bundle changed while opening");
    // Read at most the admitted size, plus one byte to detect concurrent growth.
    bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    bytes = bytes.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(bytes.length) !== before.size) throw new TypeError("Drop bundle changed during capture");
  } finally { await handle.close(); }
  const end = await lstat(file, { bigint: true });
  const endingParent = await lstat(path, { bigint: true });
  if (end.isSymbolicLink() || end.dev !== before.dev || end.ino !== before.ino
    || endingParent.isSymbolicLink() || endingParent.dev !== parent.dev || endingParent.ino !== parent.ino) throw new TypeError("Drop bundle path changed during capture");
  const submission = parseJsonBytes(bytes, "Drop Cast");
  assertCaseSubmission(submission);
  return submission;
}

export interface DropFolderResult { readonly bundle: string; readonly state: "done" | "failed"; readonly caseId?: string }

/** Atomically claims up to 256 ready bundles. Interrupted claims are never recast. */
export async function processDropFolder(runtime: DaemonRuntime, directory: string, signal?: AbortSignal): Promise<readonly DropFolderResult[]> {
  await runtime.ready();
  const requestedRoot = resolve(directory);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new TypeError("Drop folder cannot be a symbolic link");
  const root = await realpath(requestedRoot);
  const rootIdentity = await lstat(root, { bigint: true });
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.ready$/u.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256);
  const results: DropFolderResult[] = [];
  for (const entry of entries) {
    if (signal?.aborted) break;
    const currentRoot = await lstat(root, { bigint: true });
    if (currentRoot.isSymbolicLink() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) throw new TypeError("Drop folder identity changed");
    // A name supplied by a submitter is never used as an output basename.
    const ticket = randomUUID();
    const claim = join(root, `${ticket}.processing`);
    try { await rename(join(root, entry.name), claim); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let caseId: string | undefined;
    let state: "done" | "failed" = "failed";
    try {
      const submission = await readBundle(claim);
      const cast = await runtime.orchestrator.cast(submission);
      caseId = cast.caseId;
      await atomicJson(claim, "seal.json", cast.receipt);
      await atomicJson(claim, "seal-envelope.json", await runtime.repository.sealEnvelope(caseId));
      await atomicJson(claim, "trust.json", await runtime.repository.publicTrustBundle());
      await waitForTransportClosure(runtime, caseId);
      await atomicJson(claim, "record.json", await runtime.repository.record(caseId) ?? null);
      await atomicJson(claim, "record-envelope.json", await runtime.repository.recordEnvelope(caseId) ?? null);
      await atomicJson(claim, "terminal.json", await runtime.repository.terminalReceipt(caseId) ?? null);
      await atomicJson(claim, "terminal-envelope.json", await runtime.repository.terminalEnvelope(caseId) ?? null);
      await atomicJson(claim, "artifacts.json", await runtime.repository.artifacts(caseId));
      state = "done";
    } catch (error) {
      // Do not write through a rejected bundle symlink or special file.
      const identity = await lstat(claim);
      if (identity.isDirectory() && !identity.isSymbolicLink()) {
        await atomicJson(claim, "error.json", { protocol: "jevyr.drop-error/1", error: error instanceof TypeError || error instanceof SyntaxError ? error.message : "Drop Cast failed", ...(caseId ? { caseId } : {}) });
      }
    }
    const destination = `${ticket}.${state}`;
    await rename(claim, join(root, destination));
    results.push({ bundle: destination, state, ...(caseId ? { caseId } : {}) });
  }
  return results;
}
