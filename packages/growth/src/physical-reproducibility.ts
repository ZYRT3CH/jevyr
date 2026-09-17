import { canonicalize, digestJson, isSha256Digest, sha256Digest, type JsonValue } from "@jevyr/protocol";

export interface PhysicalReproducibility {
  readonly protocol: "jevyr.physical-reproducibility/1";
  readonly digest: string | null;
  readonly observations: number;
  readonly reason: string | null;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const json = (value: unknown) => value as JsonValue;

function exactCapture(raw: unknown): { digest: string; data: string; byteLength: number } | undefined {
  const capture = object(raw);
  if (!capture || capture.schema !== "jevyr.exact-byte-capture/1" || capture.encoding !== "base64" || capture.complete !== true
    || typeof capture.data !== "string" || capture.data.length > 16 * 1_048_576 || !Number.isSafeInteger(capture.byteLength)
    || (capture.byteLength as number) < 0 || capture.observedByteLength !== capture.byteLength || !isSha256Digest(capture.digest)) return undefined;
  const bytes = Buffer.from(capture.data, "base64");
  if (bytes.toString("base64") !== capture.data || bytes.length !== capture.byteLength || sha256Digest(bytes) !== capture.digest) return undefined;
  return { digest: capture.digest, data: capture.data, byteLength: bytes.length };
}

/**
 * Derive only after the caller has replayed the signed proof and authenticated every
 * supplied observation artifact. This measures an unordered multiset of physical
 * command results, not identical source, causal lineage, or identical receipts.
 * Duplicate executions and every output byte remain significant.
 */
export function derivePhysicalReproducibility(raw: readonly unknown[]): PhysicalReproducibility {
  const unmeasured = (reason: string, observations = 0): PhysicalReproducibility => ({ protocol: "jevyr.physical-reproducibility/1", digest: null, observations, reason });
  if (!Array.isArray(raw) || raw.length > 10_000) throw new TypeError("Physical observations must be a bounded array");
  const normalized: JsonValue[] = [];
  for (const item of raw) {
    const observation = object(item), metadata = object(observation?.metadata), oracle = object(observation?.oracle), execution = object(oracle?.execution);
    // Non-assay observations remain authenticated evidence, outside this metric.
    if (metadata?.assayId === undefined || metadata.candidateId === undefined) continue;
    if (metadata.admissible !== true || !execution || !["docker", "podman"].includes(String(execution.mode))
      || !["PASSED", "FAILED"].includes(String(metadata.typedOracleStatus)) || execution.state !== "exited" || execution.outputTruncated !== false)
      return unmeasured("One or more candidate assay results lack complete admissible physical execution", normalized.length);
    const substrate = object(execution.substrate), stdout = exactCapture(execution.stdoutCapture), stderr = exactCapture(execution.stderrCapture);
    if (!stdout || !stderr || !substrate || !isSha256Digest(substrate.executionImageId) || substrate.executionImageId !== substrate.startupResolvedImageId
      || typeof metadata.assayId !== "string" || metadata.assayId.length > 128 || typeof execution.command !== "string" || execution.command.length > 4096
      || !Array.isArray(execution.args) || execution.args.length > 256 || execution.args.some(arg => typeof arg !== "string" || arg.length > 32768)
      || !Number.isSafeInteger(execution.exitCode) || execution.shell !== false)
      return unmeasured("One or more physical command captures, arguments, or substrate identities are incomplete", normalized.length);
    normalized.push(json({ assayId: metadata.assayId, command: execution.command, args: execution.args, status: metadata.typedOracleStatus,
      state: execution.state, exitCode: execution.exitCode, shell: false, mode: execution.mode, imageId: substrate.executionImageId, stdout, stderr }));
  }
  if (!normalized.length) return unmeasured("No admissible physical candidate assays were recorded");
  normalized.sort((left, right) => { const a = canonicalize(left), b = canonicalize(right); return a < b ? -1 : a > b ? 1 : 0; });
  const body = { protocol: "jevyr.physical-reproducibility/1" as const, scope: "unordered-exact-command-results", observations: normalized };
  return { protocol: body.protocol, digest: digestJson(json(body)), observations: normalized.length, reason: null };
}
