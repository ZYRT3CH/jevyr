import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { keyIdFor, parseJsonBytes } from "@jevyr/core";
import { assertArtifactList, assertSealReceipt, assertTerminalReceipt, JevyrClient } from "@jevyr/sdk";
import { type CaseStatus } from "@jevyr/runtime";
import { exportLocalProof } from "../../src/local-proof.js";

/** Test-only read surface over a closed retained store. No daemon constructor,
 * private key, CAS source reader, execution, or filesystem mutation is used. */
export async function createRetainedStoreProofClient(dataDirectory: string, caseId: string) {
  if (!/^case_[a-f0-9]{16}$/u.test(caseId)) throw new TypeError("Invalid retained fixture Case identifier");
  const root = resolve(dataDirectory), directory = join(root, "cases", caseId);
  const read = async (path: string, maximum = 64 * 1_048_576) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new TypeError("Retained fixture entry is not an ordinary bounded file");
    const bytes = await readFile(path); if (bytes.length !== stat.size) throw new Error("Retained fixture changed while reading"); return bytes;
  };
  const json = async (path: string) => parseJsonBytes(await read(path));
  const status = await json(join(directory, "status.json")) as unknown as CaseStatus;
  if (!status || !["terminated", "invalid"].includes(status.lifecycle)) throw new Error("Retained fixture must already be closed");
  const seal = assertSealReceipt(await json(join(directory, "seal.json")));
  if (seal.caseId !== caseId || status.caseId !== caseId) throw new Error("Retained fixture crosses a Case boundary");
  const publicKeyPem = (await read(join(root, "keys", "jevyr-ed25519-public.pem"), 16_384)).toString("utf8");
  const trust = { protocol: "jevyr.trust-bundle/1", keys: [{ keyId: keyIdFor(publicKeyPem), algorithm: "Ed25519", publicKeyPem,
    payloadTypes: ["application/vnd.jevyr.seal+json", "application/vnd.jevyr.record+json", "application/vnd.jevyr.terminal+json"] }] };
  const eventBytes = await read(join(directory, "events.ndjson"));
  if (eventBytes.length && eventBytes.at(-1) !== 10) throw new Error("Retained fixture ledger is torn");
  const events = eventBytes.toString("utf8").trimEnd().split("\n").filter(Boolean).map(line => parseJsonBytes(Buffer.from(line))) as unknown as { sequence: number }[];
  const artifactRoot = join(directory, "artifacts");
  const artifactNames = (await readdir(artifactRoot)).filter(name => /^artifact_[a-f0-9]{24}\.json$/u.test(name)).sort();
  const index = assertArtifactList({ protocol: "jevyr.artifacts/1", caseId,
    artifacts: await Promise.all(artifactNames.map(name => json(join(artifactRoot, name)))) }, caseId);
  if (index.artifacts.length > 10_000 || index.artifacts.reduce((sum, meta) => sum + meta.size, 0) > 512 * 1_048_576) throw new Error("Retained fixture artifact budget exceeded");
  const files = await readdir(directory), recordBase = files.includes("record.json") ? "record" : "recovery-record";
  const descriptor = await json(join(root, "descriptors", `${seal.policyDigest.slice(7)}.json`));
  const terminal = assertTerminalReceipt(await json(join(directory, "terminal.json")));
  // Match daemon runtime.status: closed public status is derived from the
  // terminal receipt. The SDK independently authenticates that receipt below.
  const publicStatus = { protocol: "jevyr.status/1", caseDigest: terminal.caseDigest, runDigest: terminal.runDigest,
    lifecycle: terminal.lifecycle, stage: terminal.stage, stageStatus: terminal.stageStatus,
    lastSequence: terminal.lastSequence, headDigest: terminal.eventHeadDigest, updatedAt: terminal.closedAt };
  const documents = new Map<string, unknown>([
    ["", publicStatus], ["/seal", seal], ["/seal/envelope", await json(join(directory, "seal.dsse.json"))],
    ["/sealed-case", status.sealed], ["/intent-contract", status.sealed.intentContract],
    ["/policy-descriptor", { protocol: "jevyr.case-policy-descriptor/1", caseId, caseDigest: seal.caseDigest, runDigest: seal.runDigest, policyDigest: seal.policyDigest, artifact: descriptor }],
    ["/record", await json(join(directory, `${recordBase}.json`))], ["/record/envelope", await json(join(directory, `${recordBase}.dsse.json`))],
    ["/terminal", terminal], ["/terminal/envelope", await json(join(directory, "terminal.dsse.json"))], ["/artifacts", index],
  ]);
  if (files.includes("run-attestations.json")) documents.set("/attestations", await json(join(directory, "run-attestations.json")));
  const requests: string[] = [], origin = "http://retained-proof.invalid", prefix = `/v1/cases/${caseId}`;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || (init?.method ?? "GET") !== "GET") throw new TypeError("Retained proof transport supports only its fixed read-only origin");
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v1/trust" && !url.search) return Response.json(trust);
    if (!url.pathname.startsWith(prefix)) return Response.json({ error: "Case not found" }, { status: 404 });
    const route = url.pathname.slice(prefix.length);
    if (route === "/events") {
      if ([...url.searchParams.keys()].some(key => !["after", "waitMs", "limit"].includes(key))) throw new TypeError("Unexpected retained event query");
      const after = Number(url.searchParams.get("after") ?? "0"), limit = Number(url.searchParams.get("limit") ?? "500");
      if (!Number.isSafeInteger(after) || after < 0 || after > events.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new TypeError("Invalid retained event cursor");
      const selected = events.filter(event => event.sequence > after).slice(0, limit), throughSequence = selected.at(-1)?.sequence ?? after;
      return Response.json({ protocol: "jevyr.live/1", caseDigest: seal.caseDigest, runDigest: seal.runDigest, afterSequence: after,
        throughSequence, headDigest: status.headDigest, caughtUp: throughSequence >= events.length, events: selected, polledAt: new Date().toISOString() });
    }
    if (url.search) throw new TypeError("Unexpected retained proof query");
    if (documents.has(route)) return Response.json(documents.get(route));
    if (/^\/artifacts\/artifact_[a-f0-9]{24}$/u.test(route)) {
      const meta = index.artifacts.find(meta => route === `/artifacts/${meta.id}`);
      if (meta) return new Response(await read(join(artifactRoot, `${meta.id}.blob`), meta.size), {
        headers: { "content-type": meta.mediaType, "content-length": String(meta.size), "x-jevyr-digest": meta.digest, "cache-control": "private, immutable" },
      });
    }
    return Response.json({ error: "Retained fixture resource not found" }, { status: 404 });
  };
  return { client: new JevyrClient({ baseUrl: origin, fetch: fetcher }), requests, publicKeyId: trust.keys[0]!.keyId };
}

/** Exercises the ordinary exporter and its mandatory DSSE/terminal checks. */
export async function exportRetainedStoreProof(dataDirectory: string, caseId: string, destination: string) {
  const fixture = await createRetainedStoreProofClient(dataDirectory, caseId);
  const verification = await exportLocalProof(fixture.client, caseId, destination);
  return { protocol: "jevyr.retained-store-proof-export/1", scope: "ordinary JevyrClient exporter over a read-only retained-store fetch seam; no network server or execution",
    verification, requests: fixture.requests, publicKeyId: fixture.publicKeyId };
}
