import { parseJsonBytes } from "@jevyr/core";
import { canonicalize, digestJson, sha256Digest, METABOLIC_RESOURCE_KEYS, type CaseEvent, type JsonValue, type MetabolicReceipt, type MetabolicRedemption, type MetabolicResourceVector } from "@jevyr/protocol";
import { assertSignedMetabolicRedemption, metabolicAllowanceFromPolicyDescriptor } from "./juggler-live.js";

export interface MetabolicReplayProblem { readonly sequence: number; readonly message: string }
export interface MetabolicReplay {
  readonly admitted: readonly { readonly sequence: number; readonly receipt: MetabolicReceipt }[];
  readonly problems: readonly MetabolicReplayProblem[];
  additionsAt(sequence: number): MetabolicResourceVector;
}
const ZERO = Object.freeze(Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, 0])) as unknown as MetabolicResourceVector);

/** A signature grants a ceiling; only its later scheduler admission changes the execution meter. */
export async function replayMetabolicGrants(events: readonly CaseEvent[], policyDescriptor: unknown, resolve: (digest: string) => Promise<Uint8Array | undefined>): Promise<MetabolicReplay> {
  const problems: MetabolicReplayProblem[] = [];
  const admitted: { sequence: number; receipt: MetabolicReceipt }[] = [];
  const committed = new Map<string, { sequence: number; receipt: MetabolicReceipt }>();
  const actions = events.filter((event): event is CaseEvent<"action.status"> => event.kind === "action.status" && ["metabolism.grant", "metabolism.admitted"].includes(event.payload.actionType));
  let previous: MetabolicReceipt | undefined;
  try {
    const allowance = metabolicAllowanceFromPolicyDescriptor(policyDescriptor);
    if (actions.length > 0 && !allowance) throw new Error("Metabolic work has no exact presealed allowance");
    const policyDigest = digestJson(policyDescriptor as JsonValue);
    for (const event of actions) {
      try {
        if (event.actor.id !== "jevyr.bone" || event.actor.kind !== "kernel" || event.payload.status !== "completed") throw new Error("Metabolic authority must be a completed Bone action");
        if (event.payload.actionType === "metabolism.grant") {
          const digest = event.payload.artifactDigests?.length === 1 ? event.payload.artifactDigests[0] : undefined;
          if (!digest || !allowance) throw new Error("Metabolic grant lacks its exact signed wrapper");
          const bytes = await resolve(digest);
          if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== digest) throw new Error("Metabolic wrapper bytes are absent or changed");
          const value = parseJsonBytes(bytes, "metabolic redemption") as unknown as MetabolicRedemption;
          if (canonicalize(value as unknown as JsonValue) !== Buffer.from(bytes).toString("utf8")) throw new Error("Metabolic wrapper is not canonical");
          assertSignedMetabolicRedemption(value, allowance, previous);
          const receipt = value.receipt;
          if (receipt.digest !== event.payload.actionId || receipt.caseDigest !== event.caseDigest || receipt.runDigest !== event.runDigest || receipt.policyDigest !== policyDigest || committed.has(receipt.digest)) throw new Error("Metabolic grant substituted or repeated its sealed identity");
          committed.set(receipt.digest, { sequence: event.sequence, receipt });
          previous = receipt;
        } else {
          const grant = committed.get(event.payload.actionId);
          if (!grant || grant.sequence >= event.sequence || grant.receipt.caseDigest !== event.caseDigest || grant.receipt.runDigest !== event.runDigest || admitted.some(entry => entry.receipt.digest === grant.receipt.digest) || grant.receipt.sequence !== admitted.length + 1) throw new Error("Metabolic admission is missing, duplicated, reordered, cross-case, or precedes its signed grant");
          admitted.push({ sequence: event.sequence, receipt: grant.receipt });
        }
      } catch { problems.push({ sequence: event.sequence, message: "A metabolic grant or admission fails exact signature, allowance, resource, identity, or sequence verification." }); }
    }
  } catch { problems.push({ sequence: actions[0]?.sequence ?? 0, message: "The sealed metabolic allowance cannot be verified." }); }
  return Object.freeze({ admitted: Object.freeze(admitted), problems: Object.freeze(problems), additionsAt: (sequence: number) => [...admitted].reverse().find(entry => entry.sequence < sequence)?.receipt.cumulativeGrant ?? ZERO });
}
