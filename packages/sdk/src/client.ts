import { JevyrContinuityError, JevyrHttpError } from "./errors.js";
import { canonicalJson, sha256BytesDigest, sha256Digest } from "./digest.js";
import { LIFECYCLE_STAGES, validateSealedCase, type SealedCase } from "@jevyr/protocol";
import { parseUnambiguousJsonBytes, parseUnambiguousJsonText } from "./json.js";
import { parseSse } from "./sse.js";
import { assertDraftId, validateAirlockDraft, type AirlockDraft } from "./airlock.js";
import { assertJugglerCaseId, assertJugglerToken, assertJugglerOffers, verifyJugglerReceipt, type JugglerOffers, type JugglerReceipt } from "./juggler.js";
import { assertBallId, assertMetabolismQuantity, metabolicAllowance, verifyMetabolicOffers, verifyMetabolicRedemption, type MetabolicOffers, type MetabolicRedemption } from "./metabolism.js";
import { verifyRunAttestations, type RunAttestations, type VerifiedRunAttestations } from "./run-attestations.js";
import { assertRunAttestations } from "@jevyr/protocol";
import {
  MAX_CONNECTION_ENDPOINT_BYTES, assertConnectionId, assertConnectionRevision, assertConnectionsView,
  assertConnectionModelList, assertConnectionMcpTest, normalizeConnectionProfile, normalizeModelConnection,
  type ConnectionProfile, type ModelConnection, type ConnectionsView, type ConnectionModelList, type ConnectionMcpTest,
} from "./connections.js";
import type {
  AuthenticatedRecord,
  AuthenticatedTerminalRecord,
  ArtifactList,
  ArtifactMeta,
  CasePolicyDescriptor,
  CaseStatus,
  CastAccepted,
  CastSubmission,
  EventPage,
  DsseEnvelope,
  IntentContract,
  JevyrClientOptions,
  JevyrReadiness,
  GenomeLab,
  JevyrRecord,
  LiveFrame,
  LiveOptions,
  PublicTrustBundle,
  SealReceipt,
  TerminalReceipt,
  VerifiedDssePayload,
  VerifiedArtifact,
  VerifiedCasePolicyDescriptor,
} from "./types.js";
import {
  assertArtifactList,
  assertCasePolicyDescriptor,
  assertCaseEvent,
  assertCaseStatus,
  assertIntentContractPayload,
  assertLiveEventBatch,
  assertReadiness,
  assertRecordPayload,
  assertSealReceipt,
  assertTerminalReceipt,
  assertPolicyDescriptorRecordBinding,
} from "./verify.js";
import {
  assertDsseEnvelope,
  assertPublicTrustBundle,
  verifyRecordEnvelope,
  verifySealEnvelope,
  verifyTerminalEnvelope,
} from "./trust.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DEFAULT_RECONNECT_DELAY_MS = 1_500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_JSON_ENDPOINT_BYTES = 32 * 1_048_576;
const MAX_JSON_ERROR_BYTES = 1_048_576;
const MAX_ARTIFACT_ENDPOINT_BYTES = 512 * 1_048_576;

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      throw new JevyrContinuityError(`${label} has a malformed content-length`);
    }
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maximumBytes) {
      throw new JevyrContinuityError(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new JevyrContinuityError(`${label} yielded a non-byte transport chunk`);
      }
      total += part.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        throw new JevyrContinuityError(`${label} exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function terminal(status: CaseStatus): boolean {
  return status.lifecycle === "terminated" || status.lifecycle === "invalid";
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function nonNegativeInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

function reconnectBackoff(base: number, ceiling: number, failures: number): number {
  if (base === 0) return 0;
  return Math.min(ceiling, base * (2 ** Math.min(16, Math.max(0, failures - 1))));
}

function retryableTransportError(error: unknown): boolean {
  if (error instanceof JevyrContinuityError) return false;
  if (!(error instanceof JevyrHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function retryBounds(options: LiveOptions): { readonly base: number; readonly ceiling: number } {
  const base = nonNegativeInteger(
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    "reconnectDelayMs",
    60_000,
  );
  const ceiling = nonNegativeInteger(
    options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    "maxReconnectDelayMs",
    300_000,
  );
  if (ceiling < base) throw new RangeError("maxReconnectDelayMs cannot be less than reconnectDelayMs");
  return { base, ceiling };
}

export class JevyrClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: JevyrClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4317").replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
  }

  async cast(submission: CastSubmission, signal?: AbortSignal): Promise<CastAccepted> {
    const raw = await this.json<unknown>("/v1/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...submission, protocol: submission.protocol ?? "jevyr.case/1" }),
      ...(signal ? { signal } : {}),
    });
    return assertSealReceipt(raw);
  }

  async status(caseId: string, signal?: AbortSignal): Promise<CaseStatus> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}`, signal ? { signal } : {});
    return assertCaseStatus(raw);
  }

  /** Reveal the exact normalized Case, seed and subjects, authenticated by its Seal. */
  async verifiedSealedCase(caseId: string, signal?: AbortSignal): Promise<SealedCase> {
    if (!/^case_[a-f0-9]{16}$/u.test(caseId)) throw new TypeError("Invalid Case identifier");
    const [raw, authenticated] = await Promise.all([this.json<unknown>(`/v1/cases/${caseId}/sealed-case`, signal ? { signal } : {}), this.verifiedSealReceipt(caseId, signal)]);
    const result = validateSealedCase(raw);
    if (!result.ok || !result.value) throw new JevyrContinuityError("Sealed Case specification failed identity validation");
    const sealed = result.value, receipt = authenticated.payload;
    for (const key of ["caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "intentContractDigest"] as const) {
      if (sealed[key] !== receipt[key]) throw new JevyrContinuityError(`Sealed Case ${key} differs from its authenticated Seal`);
    }
    if (sealed.searchEnvelope.digest !== receipt.searchDigest) throw new JevyrContinuityError("Sealed Case search physics differ from its authenticated Seal");
    return sealed;
  }

  async runAttestations(caseId: string, signal?: AbortSignal): Promise<RunAttestations> {
    if (!/^case_[a-f0-9]{16}$/u.test(caseId)) throw new TypeError("Invalid Case identifier");
    const raw = await this.json<unknown>(`/v1/cases/${caseId}/attestations`, signal ? { signal } : {});
    assertRunAttestations(raw);
    if (raw.caseId !== caseId) throw new JevyrContinuityError("Attestations belong to a different Case");
    return raw;
  }

  async verifiedRunAttestations(caseId: string, signal?: AbortSignal): Promise<VerifiedRunAttestations> {
    const [raw, seal, record, terminal, sealEnvelope, recordEnvelope, terminalEnvelope, trust] = await Promise.all([
      this.runAttestations(caseId, signal), this.sealReceipt(caseId, signal), this.record(caseId, signal), this.terminalReceipt(caseId, signal),
      this.sealEnvelope(caseId, signal), this.recordEnvelope(caseId, signal), this.terminalEnvelope(caseId, signal), this.trustBundle(signal),
    ]);
    return await verifyRunAttestations(raw, { seal, record, terminal, sealEnvelope, recordEnvelope, terminalEnvelope, trust });
  }

  async createDraft(submission: CastSubmission, signal?: AbortSignal): Promise<AirlockDraft> {
    return await validateAirlockDraft(await this.json("/v1/drafts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...submission, protocol: submission.protocol ?? "jevyr.case/1" }), ...(signal ? { signal } : {}) }));
  }
  /** Cast a new Sovereign Case from authenticated stored bytes, never recapture locators. */
  async reproduceCase(sourceCaseId: string, seed: "same" | "new", signal?: AbortSignal): Promise<SealReceipt> {
    if (!/^case_[a-f0-9]{16}$/u.test(sourceCaseId) || !["same", "new"].includes(seed)) throw new TypeError("Invalid reproduction request");
    const source = (await this.verifiedSealReceipt(sourceCaseId, signal)).payload;
    const receipt = assertSealReceipt(await this.json("/v1/reproductions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceCaseId, seed }), ...(signal ? { signal } : {}) }));
    if (receipt.caseId === sourceCaseId || receipt.subjectMaterialCaptureDigest !== source.subjectMaterialCaptureDigest
      || receipt.policyDigest !== source.policyDigest || receipt.genomeDigest !== source.genomeDigest || receipt.searchDigest !== source.searchDigest
      || seed === "same" && receipt.caseDigest !== source.caseDigest) throw new JevyrContinuityError("Reproduction changed its controlled input bindings");
    const authenticated = await this.verifiedSealReceipt(receipt.caseId, signal);
    if (canonicalJson(authenticated.payload) !== canonicalJson(receipt)) throw new JevyrContinuityError("Reproduction response differs from its authenticated Seal");
    return receipt;
  }
  async draft(draftId: string, signal?: AbortSignal): Promise<AirlockDraft> {
    assertDraftId(draftId);
    return await validateAirlockDraft(await this.json(`/v1/drafts/${draftId}`, signal ? { signal } : {}));
  }
  async replaceDraft(draftId: string, revision: number, submission: CastSubmission, signal?: AbortSignal, choices?: import("@jevyr/protocol").AirlockChoices): Promise<AirlockDraft> {
    assertDraftId(draftId);
    return await validateAirlockDraft(await this.json(`/v1/drafts/${draftId}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, submission: { ...submission, protocol: submission.protocol ?? "jevyr.case/1" }, ...(choices ? { choices } : {}) }), ...(signal ? { signal } : {}) }));
  }
  async sealDraft(draftId: string, revision: number, policyDigest: string, signal?: AbortSignal): Promise<AirlockDraft> {
    assertDraftId(draftId);
    return await validateAirlockDraft(await this.json(`/v1/drafts/${draftId}/seal`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, policyDigest }), ...(signal ? { signal } : {}) }));
  }
  /** Emergency stop only. Accepted stops become INVALID; terminal signing cannot be reopened. */
  async abort(caseId: string, signal?: AbortSignal): Promise<{ protocol: "jevyr.abort-accepted/1"; caseId: string; runDigest: string; outcome: "INVALID"; resumable: false }> {
    if (!/^case_[a-f0-9]{16}$/u.test(caseId)) throw new TypeError("Invalid Case identifier");
    const raw = await this.json<unknown>(`/v1/cases/${caseId}/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", ...(signal ? { signal } : {}) });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new JevyrContinuityError("Invalid abort receipt");
    const receipt = raw as { protocol: "jevyr.abort-accepted/1"; caseId: string; runDigest: string; outcome: "INVALID"; resumable: false };
    if (receipt.protocol !== "jevyr.abort-accepted/1" || receipt.caseId !== caseId || !DIGEST.test(receipt.runDigest) || receipt.outcome !== "INVALID" || receipt.resumable !== false) throw new JevyrContinuityError("Invalid abort receipt");
    return receipt;
  }

  async trustBundle(signal?: AbortSignal): Promise<PublicTrustBundle> {
    const raw = await this.json<unknown>("/v1/trust", signal ? { signal } : {});
    return await assertPublicTrustBundle(raw);
  }

  /** Live, sanitized infrastructure readiness. This never authenticates or judges a Case. */
  async readiness(signal?: AbortSignal): Promise<JevyrReadiness> {
    const raw = await this.json<unknown>("/v1/readiness", signal ? { signal } : {});
    return assertReadiness(raw);
  }

  /** Live connection settings and startup selection; not a signed readiness or quality claim. */
  async connections(signal?: AbortSignal): Promise<ConnectionsView> {
    return await assertConnectionsView(await this.json("/v1/settings/connections", signal ? { signal } : {}, MAX_CONNECTION_ENDPOINT_BYTES));
  }

  /** Save a secret-free startup profile against the visible revision. Never changes a sealed Case. */
  async saveConnections(revision: number, profile: ConnectionProfile, signal?: AbortSignal): Promise<ConnectionsView> {
    assertConnectionRevision(revision);
    const normalized = normalizeConnectionProfile(profile);
    const result = await assertConnectionsView(await this.json("/v1/settings/connections", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, profile: normalized }), ...(signal ? { signal } : {}),
    }, MAX_CONNECTION_ENDPOINT_BYTES));
    if (result.revision !== revision + 1 || canonicalJson(result.saved) !== canonicalJson(normalized)) throw new JevyrContinuityError("Saved connection profile or revision differs from the submitted selection");
    return result;
  }

  /** Bounded model discovery only. This sends no Case or inference request. */
  async connectionModels(connection: ModelConnection, signal?: AbortSignal): Promise<ConnectionModelList> {
    const normalized = normalizeModelConnection(connection);
    return assertConnectionModelList(await this.json("/v1/settings/connections/models", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connection: normalized }), ...(signal ? { signal } : {}),
    }, MAX_CONNECTION_ENDPOINT_BYTES), normalized.model);
  }

  /** Discover one operator-registered MCP witness. No arbitrary tool call or executable is accepted. */
  async testMcpConnection(serverId: string, signal?: AbortSignal): Promise<ConnectionMcpTest> {
    assertConnectionId(serverId);
    return assertConnectionMcpTest(await this.json("/v1/settings/connections/mcp-test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serverId }), ...(signal ? { signal } : {}),
    }, MAX_CONNECTION_ENDPOINT_BYTES), serverId);
  }

  /** Read-only startup selection and quarantined offspring; never a promotion capability. */
  async genomeLab(signal?: AbortSignal): Promise<GenomeLab> {
    const raw = await this.json<unknown>("/v1/genome-lab", signal ? { signal } : {});
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new JevyrContinuityError("Invalid Genome Lab response");
    const value = raw as GenomeLab;
    if (value.protocol !== "jevyr.genome-lab/1" || !value.active || typeof value.active.version !== "string"
      || !DIGEST.test(value.active.digest) || !DIGEST.test(value.active.selectionDigest)
      || !["baseline", "governance-promotion", "benchmark-experiment"].includes(value.active.source)
      || value.governance?.startupBound !== true || value.governance.requiresBenchmarkEvidence !== true
      || value.governance.requiresGovernanceSignature !== true || value.governance.semanticPromotion !== false
      || !Array.isArray(value.offspring) || value.offspring.length > 256 || typeof value.truncated !== "boolean") throw new JevyrContinuityError("Invalid Genome Lab response");
    if (value.active.descriptor === undefined || await sha256Digest(canonicalJson(value.active.descriptor)) !== value.active.selectionDigest) throw new JevyrContinuityError("Genome Lab selection descriptor digest mismatch");
    if (value.preset && (!["preset", "wild"].includes(value.preset.mode) || value.preset.applies !== "next-runtime-startup" || await sha256Digest(canonicalJson(value.preset.descriptor)) !== value.preset.selectionDigest)) throw new JevyrContinuityError("Genome Lab preset provenance mismatch");
    if (value.selfJudgmentRequests !== undefined) {
      if (!Array.isArray(value.selfJudgmentRequests) || value.selfJudgmentRequests.length > 256) throw new JevyrContinuityError("Invalid self-judgment intake");
      for (const request of value.selfJudgmentRequests) {
        if (!request || request.protocol !== "jevyr.self-judge-offspring-request/1" || !DIGEST.test(request.digest)
          || !request.source || !/^case_[a-f0-9]{16}$/u.test(request.source.caseId) || !DIGEST.test(request.source.runDigest)
          || !DIGEST.test(request.candidateGenomeDigest) || !["REJECTED_PENDING_BENCHMARKS", "REQUESTED_NO_GOVERNED_PARENT"].includes(request.decision)
          || typeof request.proposedChange !== "string" || request.proposedChange.length > 8_192
          || request.activeGenomeChanged !== false || request.governanceSignature !== null || !Array.isArray(request.failures) || request.failures.length > 64
          || request.failures.some((failure: { code: string; evidenceDigest: string }) => !failure || typeof failure.code !== "string" || !DIGEST.test(failure.evidenceDigest))) throw new JevyrContinuityError("Invalid self-judgment intake");
        const { digest, ...body } = request;
        if (await sha256Digest(canonicalJson(body)) !== digest) throw new JevyrContinuityError("Self-judgment intake digest mismatch");
      }
    }
    for (const proposal of value.offspring) {
      if (!proposal || !DIGEST.test(proposal.proposalDigest) || !DIGEST.test(proposal.parentDigest) || !DIGEST.test(proposal.genomeDigest)
        || typeof proposal.decision !== "string" || !Array.isArray(proposal.reasons) || proposal.reasons.some((reason: unknown) => typeof reason !== "string")
        || !Array.isArray(proposal.benchmarkEvidence) || !Array.isArray(proposal.damageEvidence)
        || proposal.benchmarkEvidence.some((entry: GenomeLab["offspring"][number]["benchmarkEvidence"][number]) => !entry || typeof entry.suite !== "string" || typeof entry.heldOut !== "boolean" || typeof entry.invariant !== "boolean" || typeof entry.passed !== "boolean" || !Number.isFinite(entry.score) || !Number.isFinite(entry.parentScore) || !DIGEST.test(entry.evidenceDigest))
        || proposal.damageEvidence.some((entry: GenomeLab["offspring"][number]["damageEvidence"][number]) => !entry || typeof entry.id !== "string" || typeof entry.kind !== "string" || typeof entry.passed !== "boolean" || typeof entry.recoveredToBone !== "boolean" || !DIGEST.test(entry.evidenceDigest))) throw new JevyrContinuityError("Invalid Genome Lab offspring evidence");
    }
    return value;
  }

  /** Current finite scheduling offers, bound to the authenticated Seal; not a continuation channel. */
  async metabolismOffers(caseId: string, signal?: AbortSignal): Promise<MetabolicOffers> {
    return (await this.metabolismContext(caseId, signal)).offers;
  }

  /** Sends exactly a current opaque ball identity and its finite quantity; never retries a POST. */
  async redeemMetabolism(caseId: string, ballId: string, quantity: number, signal?: AbortSignal): Promise<MetabolicRedemption> {
    assertBallId(ballId); assertMetabolismQuantity(quantity);
    const { seal, allowance, offers } = await this.metabolismContext(caseId, signal);
    const offered = offers.offers.find(entry => entry.ballId === ballId);
    if (offers.admission !== "open" || !offered || quantity > offered.maxQuantity) throw new JevyrContinuityError("Metabolic quantity is not currently offered");
    const raw = await this.json<unknown>(`/v1/cases/${caseId}/metabolism/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ballId, quantity }), ...(signal ? { signal } : {}) });
    const redemption = await verifyMetabolicRedemption(raw, allowance, seal, offers.receipts.at(-1)?.receipt);
    if (redemption.receipt.ballId !== ballId || redemption.receipt.quantity !== quantity || redemption.receipt.kind !== offered.kind || redemption.receipt.calibrationDigest !== offered.calibration.digest) throw new JevyrContinuityError("Metabolic redemption differs from the exact offered ball and requested quantity");
    return redemption;
  }

  private async metabolismContext(caseId: string, signal?: AbortSignal) {
    assertJugglerCaseId(caseId);
    const [verifiedSeal, policy, raw] = await Promise.all([this.verifiedSealReceipt(caseId, signal), this.policyDescriptor(caseId, signal), this.json<unknown>(`/v1/cases/${caseId}/metabolism`, signal ? { signal } : {})]);
    const seal = verifiedSeal.payload, allowance = metabolicAllowance(policy, seal);
    const offers = await verifyMetabolicOffers(raw, allowance, seal);
    return { seal, allowance, offers };
  }

  /** Legacy v1 server compatibility only; current runtimes refuse this uncalibrated interface. */
  async jugglerOffers(caseId: string, signal?: AbortSignal): Promise<JugglerOffers> {
    return (await this.jugglerContext(caseId, signal)).offers;
  }

  /** Sends exactly one currently offered opaque token. No automatic POST retry occurs. */
  async redeemVoucher(caseId: string, token: string, signal?: AbortSignal): Promise<JugglerReceipt> {
    assertJugglerCaseId(caseId); assertJugglerToken(token);
    const { offers, seal } = await this.jugglerContext(caseId, signal);
    const offered = offers.offers.find(offer => offer.token === token);
    if (!offered) throw new JevyrContinuityError("Voucher is not currently offered for this Case; it may be spent or its checkpoint closed");
    const raw = await this.json<unknown>(`/v1/cases/${caseId}/vouchers/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voucher: token }), ...(signal ? { signal } : {}),
    });
    return await verifyJugglerReceipt(raw, seal, offered);
  }

  private async jugglerContext(caseId: string, signal?: AbortSignal): Promise<{ offers: JugglerOffers; seal: SealReceipt }> {
    assertJugglerCaseId(caseId);
    const [verifiedSeal, raw] = await Promise.all([
      this.verifiedSealReceipt(caseId, signal),
      this.json<unknown>(`/v1/cases/${caseId}/vouchers`, signal ? { signal } : {}),
    ]);
    return { offers: assertJugglerOffers(raw, verifiedSeal.payload), seal: verifiedSeal.payload };
  }

  async sealReceipt(caseId: string, signal?: AbortSignal): Promise<SealReceipt> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/seal`, signal ? { signal } : {});
    return assertSealReceipt(raw);
  }

  async sealEnvelope(caseId: string, signal?: AbortSignal): Promise<DsseEnvelope> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/seal/envelope`, signal ? { signal } : {});
    return assertDsseEnvelope(raw);
  }

  /** Fetches and fully validates the deterministic replay contract. */
  async intentContract(caseId: string, signal?: AbortSignal): Promise<IntentContract> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/intent-contract`, signal ? { signal } : {});
    return assertIntentContractPayload(raw);
  }

  async recordEnvelope(caseId: string, signal?: AbortSignal): Promise<DsseEnvelope> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/record/envelope`, signal ? { signal } : {});
    return assertDsseEnvelope(raw);
  }

  async terminalReceipt(caseId: string, signal?: AbortSignal): Promise<TerminalReceipt> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/terminal`, signal ? { signal } : {});
    const receipt = assertTerminalReceipt(raw);
    if (receipt.caseId !== caseId) {
      throw new JevyrContinuityError("TerminalReceipt caseId does not match the requested case");
    }
    return receipt;
  }

  async terminalEnvelope(caseId: string, signal?: AbortSignal): Promise<DsseEnvelope> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/terminal/envelope`, signal ? { signal } : {});
    return assertDsseEnvelope(raw);
  }

  /** Fetches and content-verifies the policy descriptor selected by one Case. */
  async policyDescriptor(caseId: string, signal?: AbortSignal): Promise<CasePolicyDescriptor> {
    const raw = await this.json<unknown>(
      `/v1/cases/${encodeURIComponent(caseId)}/policy-descriptor`,
      signal ? { signal } : {},
    );
    return await assertCasePolicyDescriptor(raw, caseId);
  }

  /**
   * Authenticates the crystallized Record, rehashes the policy descriptor, and
   * requires the Case, run, and policy identities to agree exactly.
   */
  async verifiedPolicyDescriptor(
    caseId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedCasePolicyDescriptor> {
    const [record, binding] = await Promise.all([
      this.authenticatedRecord(caseId, signal),
      this.policyDescriptor(caseId, signal),
    ]);
    assertPolicyDescriptorRecordBinding(binding, record.payload);
    return Object.freeze({
      binding,
      record,
      verification: "sha256+dsse-record-binding" as const,
    });
  }

  /** Fetches and strictly validates the complete artifact-index envelope. */
  async artifactList(caseId: string, signal?: AbortSignal): Promise<ArtifactList> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/artifacts`, signal ? { signal } : {});
    return assertArtifactList(raw, caseId);
  }

  /** Lists only metadata that passed content-address and Case-boundary checks. */
  async listArtifacts(caseId: string, signal?: AbortSignal): Promise<readonly ArtifactMeta[]> {
    return (await this.artifactList(caseId, signal)).artifacts;
  }

  /**
   * Retrieves an artifact through its validated Case index, then verifies the
   * response headers, byte length, and SHA-256 content before returning bytes.
   */
  async fetchArtifact(caseId: string, artifactId: string, signal?: AbortSignal): Promise<VerifiedArtifact> {
    if (!/^artifact_[a-f0-9]{24}$/u.test(artifactId)) {
      throw new RangeError("Artifact identifier must be canonical");
    }
    const meta = (await this.listArtifacts(caseId, signal)).find((entry) => entry.id === artifactId);
    if (!meta) throw new JevyrContinuityError("Artifact index does not contain the requested artifact");
    if (meta.size > MAX_ARTIFACT_ENDPOINT_BYTES) {
      throw new JevyrContinuityError(
        `Artifact exceeds the SDK's ${MAX_ARTIFACT_ENDPOINT_BYTES}-byte materialization limit`,
      );
    }

    return await this.fetchIndexedArtifact(caseId, meta, signal);
  }

  /** Resolves one exact digest through the validated Case index, if present. */
  async artifactByDigest(caseId: string, digest: string, signal?: AbortSignal): Promise<VerifiedArtifact | undefined> {
    if (!DIGEST.test(digest)) throw new RangeError("Artifact digest must be canonical SHA-256");
    const meta = (await this.listArtifacts(caseId, signal)).find((entry) => entry.digest === digest);
    return meta === undefined ? undefined : await this.fetchIndexedArtifact(caseId, meta, signal);
  }

  private async fetchIndexedArtifact(
    caseId: string,
    meta: ArtifactMeta,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    if (meta.mediaType === "application/vnd.jevyr.original-subject-assertion-certificate+json" && meta.size > 8 * 1_048_576) {
      throw new JevyrContinuityError("Original-subject certificate exceeds its 8388608-byte materialization limit");
    }
    const response = await this.fetcher(
      `${this.baseUrl}/v1/cases/${encodeURIComponent(caseId)}/artifacts/${encodeURIComponent(meta.id)}`,
      {
        headers: { ...this.headers, accept: meta.mediaType },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw await this.responseError(response);

    const headerDigest = response.headers.get("x-jevyr-digest");
    if (headerDigest === null || !DIGEST.test(headerDigest)) {
      throw new JevyrContinuityError("Artifact response has a missing or malformed x-jevyr-digest header");
    }
    if (headerDigest !== meta.digest) {
      throw new JevyrContinuityError("Artifact response digest does not match its indexed metadata");
    }

    const headerLength = response.headers.get("content-length");
    if (headerLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(headerLength)) {
      throw new JevyrContinuityError("Artifact response has a missing or malformed content-length header");
    }
    const advertisedLength = Number(headerLength);
    if (!Number.isSafeInteger(advertisedLength) || advertisedLength !== meta.size) {
      throw new JevyrContinuityError("Artifact response length does not match its indexed metadata");
    }

    const mediaType = response.headers.get("content-type");
    if (mediaType === null || mediaType !== meta.mediaType) {
      throw new JevyrContinuityError("Artifact response media type does not match its indexed metadata");
    }

    let data: Uint8Array;
    try {
      data = await boundedResponseBytes(response, meta.size, "Artifact response body");
    } catch (error) {
      throw new JevyrContinuityError(
        `Artifact response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (data.byteLength !== meta.size) {
      throw new JevyrContinuityError("Artifact response byte length does not match its indexed metadata");
    }
    if (await sha256BytesDigest(data) !== meta.digest) {
      throw new JevyrContinuityError("Artifact response bytes do not match their indexed SHA-256 digest");
    }
    return { meta, data, verification: "sha256" };
  }

  /** Concise alias for fetchArtifact. */
  async artifact(caseId: string, artifactId: string, signal?: AbortSignal): Promise<VerifiedArtifact> {
    return await this.fetchArtifact(caseId, artifactId, signal);
  }

  async verifiedSealReceipt(caseId: string, signal?: AbortSignal): Promise<VerifiedDssePayload<SealReceipt>> {
    const [trust, receipt, envelope] = await Promise.all([
      this.trustBundle(signal),
      this.sealReceipt(caseId, signal),
      this.sealEnvelope(caseId, signal),
    ]);
    if (receipt.caseId !== caseId) throw new JevyrContinuityError("SealReceipt caseId does not match the requested case");
    return await verifySealEnvelope(envelope, trust, receipt);
  }

  /**
   * Returns a replay contract only after its digest has been bound to a
   * cryptographically authenticated SealReceipt for this exact case.
   */
  async verifiedIntentContract(caseId: string, signal?: AbortSignal): Promise<IntentContract> {
    const [verifiedSeal, contract] = await Promise.all([
      this.verifiedSealReceipt(caseId, signal),
      this.intentContract(caseId, signal),
    ]);
    if (contract.digest !== verifiedSeal.payload.intentContractDigest) {
      throw new JevyrContinuityError("IntentContract digest does not match its authenticated SealReceipt");
    }
    return contract;
  }

  /**
   * Authenticates the Record signature, canonical payload, and Seal-linked
   * provenance. This does not replay or validate persisted evidence artifacts.
   */
  async authenticatedRecord(caseId: string, signal?: AbortSignal): Promise<AuthenticatedRecord> {
    const [trust, receipt, sealEnvelope, record, recordEnvelope] = await Promise.all([
      this.trustBundle(signal),
      this.sealReceipt(caseId, signal),
      this.sealEnvelope(caseId, signal),
      this.record(caseId, signal),
      this.recordEnvelope(caseId, signal),
    ]);
    if (receipt.caseId !== caseId) throw new JevyrContinuityError("SealReceipt caseId does not match the requested case");
    const verifiedSeal = await verifySealEnvelope(sealEnvelope, trust, receipt);
    const verified = await verifyRecordEnvelope(recordEnvelope, trust, record);
    if (verifiedSeal.keyId !== verified.keyId) {
      throw new JevyrContinuityError("Seal and Record were authenticated by different keys");
    }
    if (
      record.caseDigest !== receipt.caseDigest ||
      record.runDigest !== receipt.runDigest ||
      record.policyDigest !== receipt.policyDigest ||
      record.genomeDigest !== receipt.genomeDigest ||
      record.searchDigest !== receipt.searchDigest ||
      record.intentContractDigest !== receipt.intentContractDigest ||
      record.verdict.intentContractDigest !== receipt.intentContractDigest
    ) {
      throw new JevyrContinuityError("Record provenance identity does not match its authenticated SealReceipt");
    }
    return Object.freeze({
      ...verified,
      verificationScope: "dsse-signature+seal-provenance" as const,
      persistedEvidence: "not-replayed" as const,
    });
  }

  /** Authenticates the write-once terminal ledger, status, Record, and artifact-index commitment. */
  async authenticatedTerminalReceipt(
    caseId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedDssePayload<TerminalReceipt>> {
    const [trust, receipt, envelope] = await Promise.all([
      this.trustBundle(signal),
      this.terminalReceipt(caseId, signal),
      this.terminalEnvelope(caseId, signal),
    ]);
    return await verifyTerminalEnvelope(envelope, trust, receipt);
  }

  /**
   * @deprecated Prefer authenticatedRecord; this compatibility alias does not
   * independently replay persisted evidence.
   */
  async verifiedRecord(caseId: string, signal?: AbortSignal): Promise<AuthenticatedRecord> {
    return await this.authenticatedRecord(caseId, signal);
  }

  async pollEvents(
    caseId: string,
    cursor = 0,
    options: { waitMs?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<EventPage> {
    nonNegativeInteger(cursor, "Event cursor");
    const waitMs = nonNegativeInteger(options.waitMs ?? 0, "Event poll waitMs", 30_000);
    const limit = nonNegativeInteger(options.limit ?? 500, "Event poll limit", 2_000);
    if (limit < 1) throw new RangeError("Event poll limit must be at least one");
    const query = new URLSearchParams({
      after: String(cursor),
      waitMs: String(waitMs),
      limit: String(limit),
    });
    const raw = await this.json<unknown>(
      `/v1/cases/${encodeURIComponent(caseId)}/events?${query}`,
      options.signal ? { signal: options.signal } : {},
    );
    return await assertLiveEventBatch(raw, cursor);
  }

  /**
   * Resumable public trace. SSE is attempted first and reconnects with numeric
   * Last-Event-ID; canonical cursor polling is the durable fallback.
   */
  async *liveEvents(caseId: string, options: LiveOptions = {}): AsyncGenerator<LiveFrame> {
    let cursor = options.cursor ?? 0;
    nonNegativeInteger(cursor, "Event cursor");
    const maxFailures = nonNegativeInteger(options.maxSseFailures ?? 3, "maxSseFailures");
    if (maxFailures < 1) throw new RangeError("maxSseFailures must be at least one");
    const retry = retryBounds(options);
    const initial = await this.retryTransportRead(
      async () => await this.status(caseId, options.signal),
      options.signal,
      retry.base,
      retry.ceiling,
    );
    if (cursor > initial.lastSequence) throw new JevyrContinuityError(`Cursor ${cursor} is beyond ledger sequence ${initial.lastSequence}`);
    const caseDigest = initial.caseDigest;
    const runDigest = initial.runDigest;
    let priorDigest = await this.retryTransportRead(
      async () => await this.resolveCursorDigest(caseId, cursor, options.cursorDigest, initial, options.signal),
      options.signal,
      retry.base,
      retry.ceiling,
    );
    let useSse = options.preferSse ?? true;
    let failures = 0;
    let lastStageIndex = -1;
    const assertForwardStage = (stage: (typeof LIFECYCLE_STAGES)[number]): void => {
      const stageIndex = LIFECYCLE_STAGES.indexOf(stage);
      if (stageIndex < lastStageIndex) {
        throw new JevyrContinuityError("Live event stream regressed to an earlier lifecycle stage");
      }
      lastStageIndex = Math.max(lastStageIndex, stageIndex);
    };
    if (terminal(initial) && cursor === initial.lastSequence) {
      if (initial.headDigest !== priorDigest) throw new JevyrContinuityError("Terminal status head does not match the requested cursor");
      return;
    }

    while (!options.signal?.aborted) {
      if (useSse) {
        try {
          const url = `${this.baseUrl}/v1/cases/${encodeURIComponent(caseId)}/events/stream?after=${cursor}`;
          const response = await this.fetcher(url, {
            headers: { ...this.headers, accept: "text/event-stream", "last-event-id": String(cursor) },
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (!response.ok || !response.body) throw await this.responseError(response);
          const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
          if (mediaType !== "text/event-stream") throw new Error("SSE endpoint returned a non-event-stream response");
          for await (const message of parseSse(response.body, options.signal)) {
            if (message.event !== undefined) {
              throw new JevyrContinuityError("SSE emitted a named event outside the canonical default-message stream");
            }
            let raw: unknown;
            try {
              raw = parseUnambiguousJsonText(message.data, "SSE event data");
            } catch {
              throw new JevyrContinuityError("SSE emitted invalid or ambiguous JSON event data");
            }
            const event = await assertCaseEvent(raw, { sequence: cursor + 1, priorDigest, caseDigest, runDigest });
            assertForwardStage(event.stage);
            if (message.id !== String(event.sequence)) {
              throw new JevyrContinuityError("SSE id is missing or does not match CaseEvent.sequence");
            }
            cursor = event.sequence;
            priorDigest = event.eventDigest;
            failures = 0;
            yield {
              event,
              cursor,
              headDigest: priorDigest,
              segmentDigest: priorDigest,
              verificationScope: "event-hash-chain",
              continuity: "verified",
              transport: "sse",
            };
          }
          const current = await this.status(caseId, options.signal);
          this.assertObservedStatus(initial, current, cursor, priorDigest);
          if (terminal(current)) {
            if (cursor !== current.lastSequence) throw new JevyrContinuityError("SSE closed before the terminal event cursor was consumed");
            return;
          }
          failures += 1;
          if (failures >= maxFailures) useSse = false;
          else await delay(reconnectBackoff(retry.base, retry.ceiling, failures), options.signal);
          continue;
        } catch (error) {
          if (options.signal?.aborted) return;
          if (!retryableTransportError(error)) throw error;
          failures += 1;
          if (failures >= maxFailures) useSse = false;
          else await delay(reconnectBackoff(retry.base, retry.ceiling, failures), options.signal);
          continue;
        }
      }

      try {
        const page = await this.pollEvents(caseId, cursor, {
          waitMs: options.pollWaitMs ?? 15_000,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (page.caseDigest !== caseDigest || page.runDigest !== runDigest) throw new JevyrContinuityError("Event batch crossed a case or run boundary");
        if (!page.caughtUp && page.events.length === 0) {
          throw new JevyrContinuityError("Event polling made no cursor progress before claiming more events exist");
        }
        for (const raw of page.events) {
          const event = await assertCaseEvent(raw, { sequence: cursor + 1, priorDigest, caseDigest, runDigest });
          assertForwardStage(event.stage);
          cursor = event.sequence;
          priorDigest = event.eventDigest;
          failures = 0;
          yield {
            event,
            cursor,
            headDigest: priorDigest,
            segmentDigest: priorDigest,
            verificationScope: "event-hash-chain",
            continuity: "verified",
            transport: "poll",
          };
        }
        if (page.caughtUp) {
          if (page.headDigest !== priorDigest) throw new JevyrContinuityError("Caught-up page head does not match the consumed stream");
          const current = await this.status(caseId, options.signal);
          this.assertObservedStatus(initial, current, cursor, priorDigest);
          if (terminal(current)) {
            if (cursor !== current.lastSequence) throw new JevyrContinuityError("Polling stopped before the terminal event cursor was consumed");
            return;
          }
        }
        failures = 0;
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!retryableTransportError(error)) throw error;
        failures += 1;
        await delay(reconnectBackoff(retry.base, retry.ceiling, failures), options.signal);
      }
    }
  }

  events(caseId: string, options: LiveOptions = {}): AsyncGenerator<LiveFrame> {
    return this.liveEvents(caseId, options);
  }

  async record(caseId: string, signal?: AbortSignal): Promise<JevyrRecord> {
    const raw = await this.json<unknown>(`/v1/cases/${encodeURIComponent(caseId)}/record`, signal ? { signal } : {});
    return assertRecordPayload(raw);
  }

  /**
   * Waits for terminal transport and requires a separately signed commitment
   * to the complete ledger, exact terminal status, canonical Record, and exact
   * canonical artifact inventory. Persisted evidence bodies are not replayed.
   */
  async waitForAuthenticatedRecord(
    caseId: string,
    options: LiveOptions = {},
  ): Promise<AuthenticatedTerminalRecord> {
    for await (const _frame of this.liveEvents(caseId, options)) {
      // Consume the terminal public hash chain. The Record deliberately binds
      // its earlier crystallization prefix, checked below.
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Record wait was aborted");
    const retry = retryBounds(options);
    const observedTerminal = await this.retryTransportRead(
      async () => await this.status(caseId, options.signal),
      options.signal,
      retry.base,
      retry.ceiling,
    );
    if (!terminal(observedTerminal)) {
      throw new JevyrContinuityError("Live observation ended before the Case reached a terminal status");
    }
    const [authenticated, closure, artifactIndex] = await Promise.all([
      this.awaitAuthenticatedRecord(caseId, options),
      this.awaitAuthenticatedTerminalReceipt(caseId, options),
      this.retryTransportRead(
        async () => await this.artifactList(caseId, options.signal),
        options.signal,
        retry.base,
        retry.ceiling,
      ),
    ]);
    const record = authenticated.payload;
    const terminalReceipt = closure.payload;
    if (authenticated.keyId !== closure.keyId) {
      throw new JevyrContinuityError("Record and terminal closure were authenticated by different keys");
    }
    if (record.caseDigest !== observedTerminal.caseDigest || record.runDigest !== observedTerminal.runDigest) {
      throw new JevyrContinuityError("Record does not belong to the observed case and run");
    }
    if (
      terminalReceipt.caseId !== caseId
      || terminalReceipt.caseDigest !== record.caseDigest
      || terminalReceipt.runDigest !== record.runDigest
      || terminalReceipt.recordDigest !== await sha256Digest(canonicalJson(record))
      || terminalReceipt.artifactIndexDigest !== await sha256Digest(canonicalJson(artifactIndex))
    ) {
      throw new JevyrContinuityError("Signed terminal closure does not bind the authenticated Record, artifact index, and Case identity");
    }
    const ledger = await this.scanRecordHead(caseId, record, options);
    if (!ledger.containsRecordHead) {
      throw new JevyrContinuityError("Record eventHeadDigest is not a verified prefix of the public trace");
    }
    const finalStatus = await this.retryTransportRead(
      async () => await this.status(caseId, options.signal),
      options.signal,
      retry.base,
      retry.ceiling,
    );
    this.assertSameRun(observedTerminal, finalStatus);
    if (
      !terminal(finalStatus)
      || finalStatus.lastSequence !== ledger.cursor
      || finalStatus.headDigest !== ledger.headDigest
      || terminalReceipt.lifecycle !== finalStatus.lifecycle
      || terminalReceipt.stage !== finalStatus.stage
      || terminalReceipt.stageStatus !== finalStatus.stageStatus
      || terminalReceipt.lastSequence !== finalStatus.lastSequence
      || terminalReceipt.eventHeadDigest !== finalStatus.headDigest
      || terminalReceipt.closedAt !== finalStatus.updatedAt
      || terminalReceipt.closedAt !== (ledger.tailObservedAt ?? finalStatus.updatedAt)
    ) {
      throw new JevyrContinuityError("Signed terminal closure does not equal the exact observed terminal ledger and status");
    }
    return Object.freeze({
      ...authenticated,
      terminal: closure,
      traceVerification: "event-hash-chain+signed-terminal-head" as const,
    });
  }

  /** Compatibility payload-only wrapper; prefer waitForAuthenticatedRecord. */
  async waitForRecord(caseId: string, options: LiveOptions = {}): Promise<JevyrRecord> {
    return (await this.waitForAuthenticatedRecord(caseId, options)).payload;
  }

  private async retryTransportRead<T>(
    read: () => Promise<T>,
    signal: AbortSignal | undefined,
    reconnectDelayMs: number,
    maxReconnectDelayMs: number,
  ): Promise<T> {
    let failures = 0;
    while (!signal?.aborted) {
      try {
        return await read();
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        failures += 1;
        await delay(reconnectBackoff(reconnectDelayMs, maxReconnectDelayMs, failures), signal);
      }
    }
    throw signal?.reason ?? new Error("Live transport read was aborted");
  }

  private async awaitAuthenticatedRecord(caseId: string, options: LiveOptions): Promise<AuthenticatedRecord> {
    const retry = retryBounds(options);
    let failures = 0;
    while (!options.signal?.aborted) {
      try {
        return await this.authenticatedRecord(caseId, options.signal);
      } catch (error) {
        const recordPending = error instanceof JevyrHttpError && error.status === 409;
        if (!recordPending && !retryableTransportError(error)) throw error;
        failures += 1;
        await delay(reconnectBackoff(retry.base, retry.ceiling, failures), options.signal);
      }
    }
    throw options.signal?.reason ?? new Error("Record authentication was aborted");
  }

  private async awaitAuthenticatedTerminalReceipt(
    caseId: string,
    options: LiveOptions,
  ): Promise<VerifiedDssePayload<TerminalReceipt>> {
    const retry = retryBounds(options);
    let failures = 0;
    while (!options.signal?.aborted) {
      try {
        return await this.authenticatedTerminalReceipt(caseId, options.signal);
      } catch (error) {
        const closurePending = error instanceof JevyrHttpError && error.status === 409;
        if (!closurePending && !retryableTransportError(error)) throw error;
        failures += 1;
        await delay(reconnectBackoff(retry.base, retry.ceiling, failures), options.signal);
      }
    }
    throw options.signal?.reason ?? new Error("Terminal closure authentication was aborted");
  }

  private async scanRecordHead(
    caseId: string,
    record: JevyrRecord,
    options: LiveOptions,
  ): Promise<{
    readonly containsRecordHead: boolean;
    readonly cursor: number;
    readonly headDigest: string | null;
    readonly tailObservedAt?: string;
  }> {
    let cursor = 0;
    let priorDigest: string | null = null;
    let containsRecordHead = false;
    let tailObservedAt: string | undefined;
    let lastStageIndex = -1;
    const retry = retryBounds(options);
    while (true) {
      const page = await this.retryTransportRead(
        async () => await this.pollEvents(caseId, cursor, {
          limit: 2_000,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        options.signal,
        retry.base,
        retry.ceiling,
      );
      if (page.caseDigest !== record.caseDigest || page.runDigest !== record.runDigest) throw new JevyrContinuityError("Record prefix lookup crossed a case or run boundary");
      for (const raw of page.events) {
        const event = await assertCaseEvent(raw, {
          sequence: cursor + 1,
          priorDigest,
          caseDigest: record.caseDigest,
          runDigest: record.runDigest,
        });
        cursor = event.sequence;
        priorDigest = event.eventDigest;
        tailObservedAt = event.observedAt;
        const stageIndex = LIFECYCLE_STAGES.indexOf(event.stage);
        if (stageIndex < lastStageIndex) {
          throw new JevyrContinuityError("Record prefix lookup found a lifecycle stage regression");
        }
        lastStageIndex = Math.max(lastStageIndex, stageIndex);
        if (event.eventDigest === record.eventHeadDigest) containsRecordHead = true;
      }
      if (page.caughtUp) {
        if (page.headDigest !== priorDigest) {
          throw new JevyrContinuityError("Record prefix lookup ended at a different public ledger head");
        }
        return {
          containsRecordHead,
          cursor,
          headDigest: priorDigest,
          ...(tailObservedAt === undefined ? {} : { tailObservedAt }),
        };
      }
      if (page.events.length === 0) throw new JevyrContinuityError("Record prefix lookup made no cursor progress");
    }
  }

  private async resolveCursorDigest(
    caseId: string,
    cursor: number,
    supplied: string | undefined,
    status: CaseStatus,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (cursor === 0) {
      if (supplied !== undefined) throw new JevyrContinuityError("cursorDigest is invalid when cursor is zero");
      return null;
    }
    if (supplied !== undefined) {
      if (!DIGEST.test(supplied)) throw new JevyrContinuityError("cursorDigest must be a canonical SHA-256 digest");
      if (cursor === status.lastSequence && status.headDigest !== supplied) throw new JevyrContinuityError("cursorDigest does not match status headDigest");
      return supplied;
    }
    if (cursor === status.lastSequence) {
      if (!status.headDigest) throw new JevyrContinuityError("Status has no digest for the requested cursor");
      return status.headDigest;
    }
    const anchor = await this.pollEvents(caseId, cursor - 1, { limit: 1, ...(signal ? { signal } : {}) });
    if (anchor.caseDigest !== status.caseDigest || anchor.runDigest !== status.runDigest || anchor.events[0]?.sequence !== cursor) {
      throw new JevyrContinuityError(`Unable to resolve digest for cursor ${cursor}`);
    }
    return anchor.events[0].eventDigest;
  }

  private assertSameRun(initial: CaseStatus, current: CaseStatus): void {
    if (current.caseDigest !== initial.caseDigest || current.runDigest !== initial.runDigest) throw new JevyrContinuityError("Status crossed a case or run boundary");
  }

  private assertObservedStatus(
    initial: CaseStatus,
    current: CaseStatus,
    cursor: number,
    headDigest: string | null,
  ): void {
    this.assertSameRun(initial, current);
    if (current.lastSequence < cursor) throw new JevyrContinuityError("Status event cursor moved backwards");
    if (current.lastSequence === cursor && current.headDigest !== headDigest) {
      throw new JevyrContinuityError("Status head does not match the consumed event cursor");
    }
  }

  private async json<T>(path: string, init: RequestInit = {}, maximumBytes = MAX_JSON_ENDPOINT_BYTES): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, accept: "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await this.responseError(response);
    try {
      return parseUnambiguousJsonBytes(
        await boundedResponseBytes(response, maximumBytes, "JSON endpoint body"),
        "JSON endpoint body",
      ) as T;
    } catch (error) {
      throw new JevyrContinuityError(
        `JSON endpoint returned a malformed body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async responseError(response: Response): Promise<JevyrHttpError> {
    const body = await boundedResponseBytes(response, MAX_JSON_ERROR_BYTES, "JSON error body")
      .then((bytes) => parseUnambiguousJsonBytes(bytes, "JSON error body"))
      .catch(() => undefined);
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `${response.status} ${response.statusText}`;
    return new JevyrHttpError(response.status, message, body);
  }
}

export { JevyrContinuityError, JevyrHttpError } from "./errors.js";
