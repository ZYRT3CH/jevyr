import { assertCaseSubmission, validateAirlockChoices, type AirlockChoices, type CaseSubmission, type IntentContract, type SealReceipt, type SearchEnvelope, type JsonValue } from "@jevyr/protocol";
export type { AirlockChoices } from "@jevyr/protocol";
import { canonicalJson, sha256Digest } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import { assertIntentContractPayload, assertSealReceipt } from "./verify.js";

export interface AirlockDraft {
  readonly protocol: "jevyr.airlock-draft/1";
  readonly draftId: string;
  readonly revision: number;
  readonly state: "DRAFT" | "SEALING" | "SEALED" | "FAILED";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submission: CaseSubmission;
  readonly submissionDigest: string;
  readonly preview: IntentContract;
  readonly choices: AirlockChoices;
  readonly choicesDigest: string;
  readonly receipt?: SealReceipt;
  readonly startup: {
    readonly policyDigest: string; readonly genomeDigest: string; readonly genomeVersion: string;
    readonly searchEnvelope: SearchEnvelope;
    readonly capabilities: readonly { readonly id: string; readonly displayName: string; readonly network: string; readonly canExecuteTools: boolean }[];
    readonly availableCapabilities?: AirlockDraft["startup"]["capabilities"];
    readonly resourceMaximum?: SearchEnvelope["profile"]["resources"];
    readonly policy: JsonValue;
    readonly subjectCapture: string;
  };
}
export function assertDraftId(id: string): void {
  if (!/^draft_[a-f0-9]{32}$/u.test(id)) throw new TypeError("Invalid draft identifier");
}
/** Integrity checks for an editable preview; authenticity starts at its signed Seal. */
export async function validateAirlockDraft(raw: unknown): Promise<AirlockDraft> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new JevyrContinuityError("Invalid Airlock draft");
  const draft = raw as AirlockDraft;
  assertDraftId(draft.draftId);
  if (draft.protocol !== "jevyr.airlock-draft/1" || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || draft.revision > 32
    || !["DRAFT", "SEALING", "SEALED", "FAILED"].includes(draft.state)) throw new JevyrContinuityError("Invalid Airlock state");
  assertCaseSubmission(draft.submission);
  validateAirlockChoices(draft.choices);
  if (await sha256Digest(canonicalJson(draft.choices)) !== draft.choicesDigest) throw new JevyrContinuityError("Airlock execution choices digest mismatch");
  if (await sha256Digest(canonicalJson(draft.submission)) !== draft.submissionDigest) throw new JevyrContinuityError("Airlock submission digest mismatch");
  assertIntentContractPayload(draft.preview);
  if (draft.preview.originalImpulse !== draft.submission.case.impulse
    || draft.preview.originalImpulseDigest !== await sha256Digest(draft.submission.case.impulse)) throw new JevyrContinuityError("Airlock preview describes a different impulse");
  const { digest, ...contract } = draft.preview;
  if (await sha256Digest(canonicalJson(contract)) !== digest) throw new JevyrContinuityError("Airlock preview digest mismatch");
  if (!draft.startup || !Array.isArray(draft.startup.capabilities)
    || await sha256Digest(canonicalJson(draft.startup.policy)) !== draft.startup.policyDigest) throw new JevyrContinuityError("Airlock startup policy digest mismatch");
  const body = (draft.startup.policy as { policy?: { airlockChoicesDigest?: string } }).policy;
  if (Object.keys(draft.choices).length && body?.airlockChoicesDigest !== draft.choicesDigest) throw new JevyrContinuityError("Airlock policy describes different execution choices");
  if (draft.state === "SEALED") {
    const receipt = assertSealReceipt(draft.receipt);
    if (receipt.submissionDigest !== draft.submissionDigest || receipt.policyDigest !== draft.startup.policyDigest) throw new JevyrContinuityError("Airlock Seal changed the previewed submission or policy");
  } else if (draft.receipt !== undefined) throw new JevyrContinuityError("Unsealed Airlock contains a Seal receipt");
  return draft;
}
