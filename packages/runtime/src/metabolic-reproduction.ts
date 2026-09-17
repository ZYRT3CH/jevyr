import { decodeDsseJson, parseJsonBytes, verifyEventChain } from "@jevyr/core";
import { canonicalize, digestJson, sha256Digest, type CaseEvent, type DsseEnvelope, type JsonValue, type MetabolicReceipt, type SignedRecord } from "@jevyr/protocol";
import { createReproductionMemoryGuard } from "./memory-reproduction.js";
import { replayMetabolicGrants } from "./metabolism-replay.js";

export const METABOLIC_CHECKPOINT_POLICY = Object.freeze({ protocol: "jevyr.metabolic-checkpoints/1", identity: "stage-and-monotonic-scheduler-drain", sameSeed: "exact-semantic-context", newSeed: "ordered-first-eligible-checkpoint-within-source-stage", redemptions: "fresh-offered-kind-quantity-only", externalDosesDuringReproduction: "refused", historicalTimingInference: false });
export const METABOLIC_CHECKPOINT_MEDIA_TYPE = "application/vnd.jevyr.metabolic-checkpoint+json";
export const METABOLIC_REPRODUCTION_MEDIA_TYPE = "application/vnd.jevyr.metabolic-reproduction+json";
export interface MetabolicCheckpoint {
  readonly protocol: "jevyr.metabolic-checkpoint/1";
  readonly ordinal: number;
  readonly stage: string;
  readonly context: JsonValue;
  readonly structuralContext: JsonValue;
  readonly admitted: readonly { readonly receiptDigest: string; readonly sequence: number; readonly kind: MetabolicReceipt["kind"]; readonly quantity: number }[];
  readonly digest: string;
}
export interface MetabolicReproductionPlan {
  readonly protocol: "jevyr.metabolic-reproduction/1";
  readonly seedMode: "same" | "new";
  readonly sourceRecordDigest: string;
  readonly sourceRecordEnvelope: DsseEnvelope;
  readonly sourcePolicyDescriptor: JsonValue;
  readonly sourceEvents: readonly CaseEvent[];
  readonly sourceArtifacts: Readonly<Record<string, string>>;
  readonly checkpoints: readonly MetabolicCheckpoint[];
  readonly digest: string;
}
export function metabolicReproductionDoses(plan: MetabolicReproductionPlan) {
  return plan.checkpoints.flatMap(checkpoint => checkpoint.admitted.map(dose => ({ ...dose, stage: checkpoint.stage })));
}
export function metabolicCheckpointsEnabled(policy: unknown): boolean {
  const value = (policy as { policy?: { metabolicCheckpoints?: unknown } } | undefined)?.policy?.metabolicCheckpoints;
  return value !== undefined && canonicalize(value as JsonValue) === canonicalize(METABOLIC_CHECKPOINT_POLICY);
}
export function createMetabolicCheckpoint(ordinal: number, stage: string, context: JsonValue, structuralContext: JsonValue, admitted: readonly MetabolicReceipt[]): MetabolicCheckpoint {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 100_000 || !["diverge", "embody", "assay"].includes(stage)) throw new TypeError("Metabolic checkpoint is outside its bounded scheduler");
  const body = { protocol: "jevyr.metabolic-checkpoint/1" as const, ordinal, stage, context, structuralContext,
    admitted: admitted.map(receipt => ({ receiptDigest: receipt.digest, sequence: receipt.sequence, kind: receipt.kind, quantity: receipt.quantity })) };
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}
export function metabolicCheckpointMatches(expected: MetabolicCheckpoint, actual: MetabolicCheckpoint, seedMode: "same" | "new"): boolean {
  const project = (value: MetabolicCheckpoint) => ({ ordinal: value.ordinal, stage: value.stage, structuralContext: value.structuralContext,
    ...(seedMode === "same" ? { context: value.context } : {}), admitted: value.admitted.map(({ receiptDigest: _physical, ...semantic }) => semantic) });
  return canonicalize(project(expected) as unknown as JsonValue) === canonicalize(project(actual) as unknown as JsonValue);
}

/** Only a Record-authenticated event prefix and exact DSSE additions can form
 * a replay plan. Historical wall-clock timings are never inferred. */
export async function createMetabolicReproductionPlan(envelope: DsseEnvelope, policy: JsonValue, events: readonly CaseEvent[], resolve: (digest: string) => Promise<Uint8Array | undefined>, keys: ReadonlyMap<string, string>, seedMode: "same" | "new"): Promise<MetabolicReproductionPlan> {
  if (!["same", "new"].includes(seedMode) || !metabolicCheckpointsEnabled(policy)) throw new TypeError("Juggler reproduction requires exact checkpoint-bearing source policy; historical timing replay is unsupported");
  const authenticated = createReproductionMemoryGuard(envelope, keys), record = decodeDsseJson<SignedRecord>(envelope);
  if (digestJson(policy) !== record.policyDigest) throw new Error("Metabolic reproduction substituted the source policy");
  const head = events.findIndex(event => event.eventDigest === record.eventHeadDigest);
  if (head < 0) throw new Error("Metabolic reproduction source lacks its signed Record prefix");
  const prefix = events.slice(0, head + 1);
  if (!verifyEventChain(prefix).valid || prefix.some(event => event.runDigest !== record.runDigest || event.caseDigest !== record.caseDigest)) throw new Error("Metabolic reproduction source event prefix does not authenticate");
  const sourceArtifacts: Record<string, string> = {};
  const read = async (digest: string) => {
    const bytes = await resolve(digest);
    if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== digest) throw new Error("Metabolic reproduction source artifact is missing or changed");
    sourceArtifacts[digest] = Buffer.from(bytes).toString("base64"); return bytes;
  };
  const metabolism = await replayMetabolicGrants(prefix, policy, read);
  if (metabolism.problems.length > 0) throw new Error("Metabolic reproduction source grants cannot be authenticated");
  const actions = prefix.filter((event): event is CaseEvent<"action.status"> => event.kind === "action.status" && event.payload.actionType === "investigation.metabolic-checkpoint");
  if (actions.length === 0 || actions.at(-1)?.stage !== "assay") throw new Error("Juggler source lacks its complete final scheduler checkpoint");
  const checkpoints: MetabolicCheckpoint[] = [];
  let previousSequence = 0;
  for (const action of actions) {
    if (action.actor.kind !== "kernel" || action.actor.id !== "jevyr.bone" || action.payload.status !== "completed" || action.payload.artifactDigests?.length !== 1) throw new Error("Malformed source metabolic checkpoint authority");
    const bytes = await read(action.payload.artifactDigests[0]!);
    const checkpoint = parseJsonBytes(bytes, "metabolic checkpoint") as unknown as MetabolicCheckpoint;
    const admitted = metabolism.admitted.filter(entry => entry.sequence > previousSequence && entry.sequence < action.sequence).map(entry => entry.receipt);
    const expected = createMetabolicCheckpoint(checkpoints.length + 1, action.stage, checkpoint.context, checkpoint.structuralContext, admitted);
    if (checkpoint.digest !== action.payload.actionId || canonicalize(expected as unknown as JsonValue) !== Buffer.from(bytes).toString("utf8")) throw new Error("Source metabolic checkpoint changed its sequence, context or admitted grant prefix");
    checkpoints.push(expected); previousSequence = action.sequence;
  }
  const grants = prefix.filter(event => event.kind === "action.status" && event.payload.actionType === "metabolism.grant");
  if (metabolism.admitted.length !== grants.length || metabolism.admitted.some(entry => entry.sequence > previousSequence)) throw new Error("Source has unaccounted or post-checkpoint metabolic work");
  const body = { protocol: "jevyr.metabolic-reproduction/1" as const, seedMode, sourceRecordDigest: authenticated.sourceRecordDigest, sourceRecordEnvelope: structuredClone(envelope), sourcePolicyDescriptor: policy, sourceEvents: prefix, sourceArtifacts, checkpoints };
  if (Buffer.byteLength(canonicalize(body as unknown as JsonValue)) > 8_000_000) throw new Error("Metabolic reproduction source exceeds its bounded proof envelope");
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}
export async function verifyMetabolicReproductionPlan(plan: MetabolicReproductionPlan, keys: ReadonlyMap<string, string>): Promise<MetabolicReproductionPlan> {
  const expected = await createMetabolicReproductionPlan(plan.sourceRecordEnvelope, plan.sourcePolicyDescriptor, plan.sourceEvents, async digest => plan.sourceArtifacts[digest] === undefined ? undefined : Buffer.from(plan.sourceArtifacts[digest], "base64"), keys, plan.seedMode);
  if (canonicalize(plan as unknown as JsonValue) !== canonicalize(expected as unknown as JsonValue)) throw new Error("Metabolic reproduction plan differs from its authenticated source proof");
  return expected;
}
