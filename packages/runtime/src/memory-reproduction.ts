import { decodeDsseJson, RECORD_DSSE_PAYLOAD_TYPE, verifyDsse } from "@jevyr/core";
import { canonicalize, digestJson, validateSignedRecord, type DsseEnvelope, type JsonValue, type MemoryInfluencePayload } from "@jevyr/protocol";
import type { RetrievedMemory } from "@jevyr/memory";

export const REPRODUCTION_MEMORY_MEDIA_TYPE = "application/vnd.jevyr.reproduction-memory+json";
export interface ReproductionMemoryGuard {
  readonly protocol: "jevyr.reproduction-memory-guard/1";
  readonly sourceRecordDigest: string;
  readonly sourceRunDigest: string;
  readonly sourceCaseDigest: string;
  readonly sourceEnvelope: DsseEnvelope;
  readonly expectedInfluences: readonly MemoryInfluencePayload[];
  readonly digest: string;
}

/** This guard can only narrow a rerun: it cannot admit, inject, or suppress memory. */
export function createReproductionMemoryGuard(envelope: DsseEnvelope, trustedKeys: ReadonlyMap<string, string>): ReproductionMemoryGuard {
  if (envelope.payloadType !== RECORD_DSSE_PAYLOAD_TYPE || !verifyDsse(envelope, trustedKeys)) throw new Error("Reproduction memory requires an authenticated source Record");
  const decoded = decodeDsseJson<unknown>(envelope);
  const validated = validateSignedRecord(decoded);
  if (!validated.ok || !validated.value || Buffer.from(envelope.payload, "base64").toString("utf8") !== canonicalize(decoded as JsonValue)) throw new Error("Reproduction memory source Record is not canonical and valid");
  const record = validated.value;
  const body = { protocol: "jevyr.reproduction-memory-guard/1" as const,
    sourceRecordDigest: digestJson(record as unknown as JsonValue), sourceRunDigest: record.runDigest, sourceCaseDigest: record.caseDigest,
    sourceEnvelope: structuredClone(envelope), expectedInfluences: structuredClone(record.memoryInfluences) };
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}

export function verifyReproductionMemoryGuard(guard: ReproductionMemoryGuard, trustedKeys: ReadonlyMap<string, string>): ReproductionMemoryGuard {
  const verified = createReproductionMemoryGuard(guard.sourceEnvelope, trustedKeys);
  if (canonicalize(guard as unknown as JsonValue) !== canonicalize(verified as unknown as JsonValue)) throw new Error("Reproduction memory guard differs from its authenticated source Record");
  return verified;
}

export function lateMemoryInfluences(recalled: readonly RetrievedMemory[], maximumWeight: number): readonly MemoryInfluencePayload[] {
  return recalled.flatMap(item => {
    const weight = Math.min(item.weight, maximumWeight);
    if (weight <= 0) return [];
    return [{ memoryDigest: item.memoryDigest, influence: item.influence, weight,
      summary: `Admitted memory hint at recorded weight ${weight.toFixed(3)} (not evidence and never verdict authority): ${item.abstractSummary}` }];
  });
}

export function reproductionMemoryMatches(guard: ReproductionMemoryGuard, actual: readonly MemoryInfluencePayload[]): boolean {
  return canonicalize(guard.expectedInfluences as unknown as JsonValue) === canonicalize(actual as unknown as JsonValue);
}
