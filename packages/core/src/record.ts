import { RECORD_PROTOCOL, isSha256Digest, type MemoryInfluencePayload, type SignedRecord, type SealedCase } from "@jevyr/protocol";
import type { JevyrVerdict, ReflexPayload } from "@jevyr/protocol";
import { assertReflexComplete } from "./reflex.js";

export interface CrystallizeOptions {
  sealed: SealedCase;
  eventHeadDigest: string;
  verdict: JevyrVerdict;
  reflexReports: readonly ReflexPayload[];
  memoryInfluences?: readonly MemoryInfluencePayload[];
  crystallizedAt: string;
}

export function crystallizeRecord(options: CrystallizeOptions): SignedRecord {
  if (!isSha256Digest(options.eventHeadDigest)) throw new TypeError("A record requires a valid event head digest");
  if (Number.isNaN(Date.parse(options.crystallizedAt))) throw new TypeError("crystallizedAt must be an ISO timestamp");
  if (options.verdict.policyVersion !== options.sealed.policyVersion) {
    throw new TypeError("Record verdict policyVersion does not match the sealed policy");
  }
  if (options.verdict.intentContractDigest !== options.sealed.intentContractDigest) {
    throw new TypeError("Record verdict intentContractDigest does not match the sealed intent contract");
  }
  const reflex = assertReflexComplete(options.verdict, options.reflexReports);
  return Object.freeze({
    protocol: RECORD_PROTOCOL,
    caseDigest: options.sealed.caseDigest,
    runDigest: options.sealed.runDigest,
    policyDigest: options.sealed.policyDigest,
    genomeDigest: options.sealed.genomeDigest,
    searchDigest: options.sealed.searchEnvelope.digest,
    intentContractDigest: options.sealed.intentContractDigest,
    eventHeadDigest: options.eventHeadDigest,
    verdict: options.verdict,
    reflex,
    memoryInfluences: Object.freeze(structuredClone(options.memoryInfluences ?? [])),
    crystallizedAt: options.crystallizedAt,
  });
}
