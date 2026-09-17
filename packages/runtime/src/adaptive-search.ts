import {
  hypothesisContentDigest,
  runHypothesisNursery,
  type HypothesisSpecimen,
  type NurseryContext,
  type NurseryObservation,
  type NurseryProfile,
  type NurseryProposal,
  type NurseryResourceEnvelope,
  type NurseryResult,
} from "@jevyr/growth";
import { assertMetabolicReceipt, digestJson, sha256Digest, type InvestigationAuditReceipt, type JsonValue, type MetabolicKind, type MetabolicReceipt } from "@jevyr/protocol";
import { makePublicMindPrompt } from "./adapters/prompt.js";
import { sha256 } from "./canonical.js";
import { adapterCapabilitySnapshot, snapshotAdapterCapability } from "./capability-card.js";
import type {
  CapabilityCard,
  MindAdapter,
  MindInvocationResult,
  MindRequest,
  PublicContribution,
  SealedCaseContext,
} from "./contracts.js";
import type { SubjectTextProjection } from "./subject-materials.js";
import type { SubjectContext } from "./subject-context.js";
import type { ExperimentCapability } from "./experiment-capability.js";
import { invokeMindMetered, mindFailureInputUpperBound, mindFailureInvestigation, utf8Bytes, type ModelInvestigationFailure } from "./mind-metering.js";
import { mindInvocationOutputReservation } from "./search-budget.js";
import { applyJugglerSchedule, refractMinds, type JugglerSchedule } from "./juggler.js";
import { investigationSeed, phenotypeOrder, type InvestigationPhenotype } from "./phenotype.js";
import { assertInertiaContinuationDecision, type InertiaContinuationDecision } from "./inertia-scent.js";

/** A remote loop guard, deliberately far beyond the sealed physical budget. */
export const DEFAULT_ATTEMPT_SAFETY_CEILING = "1500000000000000000000";

export type AdaptiveSearchProfile = Omit<NurseryProfile, "seed"> & { readonly seed?: number };

export interface AdaptiveSearchInput {
  readonly sealed: SealedCaseContext;
  readonly phenotype?: InvestigationPhenotype;
  readonly minds: readonly MindAdapter[];
  /** Facts fixed before the first mutually blind lineage. */
  readonly publicFacts: readonly PublicContribution[];
  /** Candidate-facing view of the exact experiment sockets sealed before Cast. */
  readonly experimentCapability?: ExperimentCapability;
  readonly signal: AbortSignal;
  /** A monotonic remainder of the Case-wide sealed Mind envelope. */
  readonly resources?: NurseryResourceEnvelope;
  readonly sealedForMind?: (mind: MindAdapter) => SealedCaseContext;
  readonly subjectProjectionForMind?: (mind: MindAdapter) => SubjectTextProjection | undefined;
  readonly subjectContextForMind?: (mind: MindAdapter) => SubjectContext | undefined;
  readonly observe?: (observation: AdaptiveSearchObservation) => void | Promise<void>;
  readonly onProviderFailure?: (adapterId: string, investigation?: ModelInvestigationFailure) => void | Promise<void>;
  readonly onInvestigation?: (adapterId: string, investigation: NonNullable<MindInvocationResult["investigation"]>) => void | Promise<void>;
  /** Opaque voucher redemptions sampled once at the scheduler checkpoint. */
  readonly jugglerSchedule?: JugglerSchedule;
  readonly takePendingGrants?: () => Promise<readonly MetabolicReceipt[]>;
  readonly onMetabolicEligibility?: (kinds: readonly MetabolicKind[], availableQuantities?: Partial<Record<MetabolicKind, number>>) => void | Promise<void>;
  readonly closeMetabolicAdmission?: () => void | Promise<void>;
  /** The orchestrator will continue admission at physical evidence checkpoints and close it there. */
  readonly deferMetabolicClosure?: boolean;
  /** Only runSupplementalInvestigation constructs this prevalidated additive sub-envelope. */
  readonly supplemental?: { readonly receipt: MetabolicReceipt; readonly targetAssayIds?: readonly string[]; readonly inertiaDecision?: InertiaContinuationDecision };
}

export interface AdaptiveSearchObservation extends NurseryObservation {
  readonly source?: CapabilityCard;
  /** Raw public provider contribution, retained for proposer-declared telemetry. */
  readonly contribution?: PublicContribution;
  /** Canonical admitted specimen identity and genealogy, present only after nursery admission. */
  readonly admittedContribution?: PublicContribution;
  readonly audit?: InvestigationAuditReceipt;
}

export interface AdaptiveSearchOutcome {
  readonly nursery: NurseryResult;
  /** Untested prototypes. Presence here grants no evidentiary authority. */
  readonly hypotheses: readonly PublicContribution[];
}

export interface SupplementalInvestigationContext {
  readonly baselineHypotheses: readonly PublicContribution[];
  readonly baselineSaturated: boolean;
  readonly targetAssayId?: string;
  readonly targetAssayIds?: readonly string[];
  readonly inertiaDecision?: InertiaContinuationDecision;
}
class SupplementalUnavailableError extends Error {}

/** The caller has already authenticated the receipt and admitted its separate resource grant. */
export async function runSupplementalInvestigation(input: AdaptiveSearchInput, receipt: MetabolicReceipt, context: SupplementalInvestigationContext): Promise<AdaptiveSearchOutcome> {
  assertMetabolicReceipt(receipt);
  if (receipt.caseId !== input.sealed.caseId || receipt.runDigest !== input.sealed.runDigest || receipt.searchDigest !== input.sealed.searchEnvelope.digest) throw new Error("Supplemental work substituted its sealed Case");
  if (receipt.kind === "Polarity" && context.baselineHypotheses.length === 0) throw new SupplementalUnavailableError("Polarity has no committed belief to challenge");
  if (receipt.kind === "Inertia") {
    if (!context.inertiaDecision) throw new SupplementalUnavailableError("Inertia requires a below-threshold decision from physical evidence history");
    assertInertiaContinuationDecision(context.inertiaDecision, receipt, context.inertiaDecision.history, input.sealed.intentContract.criticalObligations.map(obligation => obligation.id), context.inertiaDecision.excludedCandidateIds);
  }
  const targetAssayIds = context.targetAssayIds ?? (context.targetAssayId ? [context.targetAssayId] : []);
  if (receipt.kind === "Refraction" && (targetAssayIds.length < receipt.quantity || new Set(targetAssayIds).size !== targetAssayIds.length || targetAssayIds.some(id => !input.experimentCapability?.experiments.some(experiment => experiment.assayId === id)))) throw new SupplementalUnavailableError("Refraction lacks a distinct unvisited presealed experiment template for each dose");
  const { takePendingGrants: _grants, onMetabolicEligibility: _eligible, closeMetabolicAdmission: _close, jugglerSchedule: _legacy, phenotype: _phenotype, supplemental: _nested, ...baseline } = input;
  const maxWallMillis = receipt.grant.maxWallMillis;
  const resources: NurseryResourceEnvelope = { maxMindInvocations: Math.min(receipt.quantity, receipt.grant.maxMindInvocations), maxInputTokens: receipt.grant.maxInputTokens, maxOutputTokens: receipt.grant.maxOutputTokens, maxGeneratedBytes: receipt.grant.maxGeneratedBytes, maxWallMillis, maxSingleInvocationMillis: Math.min(input.sealed.searchEnvelope.profile.resources.maxSingleInvocationMillis, maxWallMillis) };
  return await runAdaptiveSearch({ ...baseline, publicFacts: receipt.kind === "Fission" ? input.publicFacts.filter(fact => fact.kind !== "candidate" && fact.kind !== "repair" && !fact.tags?.includes("admitted-memory")) : [...input.publicFacts, ...context.baselineHypotheses], resources, supplemental: { receipt, ...(receipt.kind === "Refraction" ? { targetAssayIds } : {}), ...(context.inertiaDecision ? { inertiaDecision: context.inertiaDecision } : {}) } });
}

interface ProposalSource {
  readonly adapter: MindAdapter;
  readonly contribution: PublicContribution;
}

interface PreparedAttempt {
  readonly mind: MindAdapter;
  readonly request: MindRequest;
  readonly prompt: string;
  readonly outputTokenUpperBound: number;
  readonly lineage: string;
  readonly phase: NurseryContext["phase"];
  readonly parentIds: readonly string[];
  readonly targetAssayId?: string;
}

function redact(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 500);
}

function defaultSeed(sealed: SealedCaseContext): number {
  if (sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2") return Number.parseInt(investigationSeed(sealed, "frontier").slice(0, 8), 16) >>> 0;
  return Number.parseInt(sha256(`${sealed.runDigest}:frontier`).slice(0, 8), 16) >>> 0;
}

function supplementalEntropy(sealed: SealedCaseContext, receipt: MetabolicReceipt): string {
  return sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2"
    ? investigationSeed(sealed, "supplemental", [receipt.kind, receipt.sequence, receipt.quantity])
    : receipt.digest;
}

/**
 * Defaults spend real, observable resources. Raising the attempt guard alone
 * cannot increase work; operators must explicitly raise the sealed envelope.
 */
export function adaptiveSearchProfile(
  sealed: SealedCaseContext,
  remaining?: NurseryResourceEnvelope,
): NurseryProfile {
  const bound = sealed.searchEnvelope.profile;
  const resources = remaining ?? {
    maxMindInvocations: bound.resources.maxMindInvocations,
    maxInputTokens: bound.resources.maxInputTokens,
    maxOutputTokens: bound.resources.maxOutputTokens,
    maxWallMillis: bound.resources.maxWallMillis,
    maxGeneratedBytes: bound.resources.maxGeneratedBytes,
    maxSingleInvocationMillis: bound.resources.maxSingleInvocationMillis,
  };
  return Object.freeze({
    attemptSafetyCeiling: bound.attemptSafetyCeiling,
    minimumAttempts: bound.nursery.minimumAttempts,
    saturationWindow: bound.nursery.saturationWindow,
    independentLineages: bound.nursery.independentLineages,
    challengeInterval: bound.nursery.challengeInterval,
    resources: Object.freeze({
      maxMindInvocations: Math.min(bound.resources.maxMindInvocations, resources.maxMindInvocations),
      maxInputTokens: Math.min(bound.resources.maxInputTokens, resources.maxInputTokens),
      maxOutputTokens: Math.min(bound.resources.maxOutputTokens, resources.maxOutputTokens),
      maxWallMillis: Math.min(bound.resources.maxWallMillis, resources.maxWallMillis),
      maxGeneratedBytes: Math.min(bound.resources.maxGeneratedBytes, resources.maxGeneratedBytes),
      maxSingleInvocationMillis: Math.min(bound.resources.maxSingleInvocationMillis, resources.maxSingleInvocationMillis),
    }),
    seed: defaultSeed(sealed),
  });
}

function factsFor(
  base: readonly PublicContribution[],
  context: NurseryContext,
  sources: ReadonlyMap<string, ProposalSource>,
): readonly PublicContribution[] {
  if (context.phase === "EXILE") return Object.freeze(base.filter(fact => fact.kind !== "candidate" && fact.kind !== "repair"));
  const parents = context.parents.flatMap((parent) => {
    const source = sources.get(parent.contentDigest);
    return source ? [{ ...source.contribution, id: parent.id, parentIds: parent.parentIds }] : [];
  });
  return Object.freeze([...base, ...parents]);
}

function toProposal(contribution: PublicContribution): NurseryProposal {
  return Object.freeze({
    publicSummary: contribution.summary,
    payload: {
      body: contribution.body ?? "",
      feasibility: contribution.feasibility ?? "LAWFUL_BUT_OPEN",
      tags: contribution.tags ?? [],
      evidenceRefs: contribution.evidenceRefs ?? [],
      authority: "UNTRUSTED_HYPOTHESIS",
    } as JsonValue,
    declaredMechanisms: Object.freeze([...(contribution.tags ?? [])]),
  });
}

function admittedContribution(
  specimen: Pick<HypothesisSpecimen, "id" | "parentIds" | "lineage" | "phase">,
  source: ProposalSource,
): PublicContribution {
  return Object.freeze({
    ...source.contribution,
    id: specimen.id,
    parentIds: specimen.parentIds,
    tags: Object.freeze([
      ...(source.contribution.tags ?? []),
      `lineage:${specimen.lineage}`,
      `phase:${specimen.phase.toLowerCase()}`,
      "untrusted-hypothesis",
      "not-assay-backed",
    ]),
  });
}

function contributionFromSpecimen(specimen: HypothesisSpecimen, source: ProposalSource): PublicContribution {
  return admittedContribution(specimen, source);
}

/**
 * Populates an explicitly untrusted nursery. It performs exact-content
 * deduplication and resource accounting only. It does not manufacture quality
 * scores, behavioral descriptors, tests, evidence, survivors, or a winner.
 */
export async function runAdaptiveSearch(input: AdaptiveSearchInput): Promise<AdaptiveSearchOutcome> {
  if (input.minds.length === 0) throw new TypeError("Adaptive search requires at least one permitted mind");
  const admittedCapabilities = input.minds.map((mind) => snapshotAdapterCapability(mind));
  if (admittedCapabilities.some((capability) => capability.kind !== "mind")) {
    throw new TypeError("Adaptive search accepts only adapters with kind mind");
  }
  const ids = admittedCapabilities.map((capability) => capability.id);
  if (new Set(ids).size !== ids.length) throw new TypeError("Adaptive search Mind capability ids must be unique");
  const orderedMinds = input.phenotype
    ? phenotypeOrder(input.minds, input.phenotype.roster, mind => adapterCapabilitySnapshot(mind).id)
    : [...input.minds].sort((left, right) => adapterCapabilitySnapshot(left).id.localeCompare(adapterCapabilitySnapshot(right).id));
  const sources = new Map<string, ProposalSource>();
  const pendingGrants: MetabolicReceipt[] = [];
  const seenGrants = new Set<string>();
  const drain = async () => {
    for (const receipt of await input.takePendingGrants?.() ?? []) {
      if (seenGrants.has(receipt.digest)) throw new Error("A metabolic receipt was supplied twice");
      seenGrants.add(receipt.digest);
      pendingGrants.push(receipt);
    }
  };
  const attemptSources = new Map<number, ProposalSource>();
  const preparedAttempts = new Map<number, PreparedAttempt>();
  const minds = input.jugglerSchedule ? refractMinds(orderedMinds, input.jugglerSchedule) : orderedMinds;
  const baseProfile = input.supplemental ? {
    ...adaptiveSearchProfile(input.sealed), resources: input.resources!, minimumAttempts: 1, saturationWindow: Math.max(1, input.supplemental.receipt.quantity), independentLineages: input.supplemental.receipt.kind === "Fission" ? input.supplemental.receipt.quantity : 1,
    seed: Number.parseInt(supplementalEntropy(input.sealed, input.supplemental.receipt).slice(-8), 16),
  } : { ...adaptiveSearchProfile(input.sealed, input.resources), ...(input.phenotype ? { independentLineages: input.phenotype.isolation.blindLineages } : {}) };
  const profile = input.jugglerSchedule ? applyJugglerSchedule(baseProfile, input.jugglerSchedule, input.sealed) : baseProfile;
  const methodPhase = (fallback: NurseryContext["phase"]): NurseryContext["phase"] => input.supplemental ? input.supplemental.receipt.kind === "Fission" ? "EXILE" : input.supplemental.receipt.kind === "Polarity" ? "COEVOLVE" : "DIVERSIFY" : fallback;

  const prepareAttempt = (context: NurseryContext): PreparedAttempt => {
    const existing = preparedAttempts.get(context.ordinal);
    if (existing) return existing;
    const mind = minds[(context.ordinal - 1) % minds.length] as MindAdapter;
    const capability = adapterCapabilitySnapshot(mind);
    const supplemental = input.supplemental;
    const targetAssayId = supplemental?.targetAssayIds?.[context.ordinal - 1];
    const inertiaScent = supplemental?.inertiaDecision?.selected[context.ordinal - 1];
    const phase = methodPhase(context.phase);
    const effectiveContext = { ...context, phase };
    const recombining = phase === "RECOMBINE";
    const subjectProjection = input.subjectProjectionForMind?.(mind);
    const subjectContext = input.subjectContextForMind?.(mind);
    const outputTokenUpperBound = mindInvocationOutputReservation(context.resourcesRemaining);
    const draft: MindRequest = {
      ...(capability.limits?.adapterClass === "model" ? { investigationTools: true } : {}),
      stage: recombining ? "recombine" : "diverge",
      role: phase === "COEVOLVE" ? "challenger" : recombining ? "synthesist" : "divergent",
      sealed: input.sealedForMind?.(mind) ?? input.sealed,
      publicFacts: factsFor(input.publicFacts, effectiveContext, sources),
      ...(input.experimentCapability === undefined ? {} : { experimentCapability: input.experimentCapability }),
      seed: input.sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2"
        ? investigationSeed(input.sealed, "nursery", [context.ordinal, context.seed, capability.id, ...(supplemental ? [supplemental.receipt.kind, supplemental.receipt.sequence, supplemental.receipt.quantity] : [])])
        : sha256(`${input.sealed.runDigest}:nursery:${context.ordinal}:${context.seed}:${capability.id}${supplemental ? `:${supplemental.receipt.digest}` : ""}`),
      constraints: Object.freeze([
        ...input.sealed.intent.constraints,
        `Nursery phase ${phase}; lineage ${context.lineage}.`,
        ...(supplemental ? [`Additive ${supplemental.receipt.kind} work from ${input.sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2" ? `grant sequence ${supplemental.receipt.sequence}, quantity ${supplemental.receipt.quantity}` : `receipt ${supplemental.receipt.digest}`}; it has no verdict authority.`, ...(targetAssayId ? [`Refraction must produce a complete candidate for presealed experiment ${targetAssayId}. Other sockets do not fulfill this grant.`] : []), ...(supplemental.receipt.kind === "Polarity" ? ["Construct a finite counterexample that tries to overturn the existing leading mechanism; cite the exact parent you are challenging."] : []), ...(inertiaScent ? [`Inertia evidence-value continuation: candidate ${inertiaScent.candidateId}, sealed assay ${inertiaScent.assayId}; heuristic value ${inertiaScent.valuePerCost} is below baseline threshold ${supplemental.inertiaDecision!.baselineThreshold} and at or above added threshold ${supplemental.inertiaDecision!.loweredThreshold}. Investigate one additional finite probe or repair of that exact observed scent; this heuristic is not verdict evidence.`] : [])] : []),
        phase === "EXILE"
          ? "Invent without seeing any other divergent lineage."
          : phase === "COEVOLVE"
            ? "Attack a parent's causal assumption, then propose a mechanism that survives that attack."
            : phase === "INVERT"
              ? "Invert the direction of the parent's central causal mechanism."
              : "Use only explicit public parents; do not imitate their wording.",
        "Produce mechanisms, not audience-pleasing language.",
        "Everything produced here is an untrusted hypothesis until an external assay measures it.",
      ]),
      ...(subjectProjection === undefined ? {} : { subjectProjection }),
      ...(subjectContext === undefined ? {} : { subjectContext }),
      maxInputTokens: context.resourcesRemaining.maxInputTokens,
      maxOutputTokens: outputTokenUpperBound,
      signal: context.signal,
    };
    const prompt = makePublicMindPrompt(draft);
    const prepared = Object.freeze({
      mind,
      prompt,
      outputTokenUpperBound,
      lineage: context.lineage,
      phase,
      parentIds: Object.freeze(context.parents.map((parent) => parent.id)),
      ...(targetAssayId ? { targetAssayId } : {}),
      request: Object.freeze({ ...draft, preparedPublicPrompt: prompt }),
    });
    preparedAttempts.set(context.ordinal, prepared);
    return prepared;
  };

  await input.onMetabolicEligibility?.(["Mass", "Fission"]);
  let completedObservation: AdaptiveSearchObservation | undefined;
  const nursery = await runHypothesisNursery(
    {
      phaseForAttempt: (_ordinal, defaultPhase) => methodPhase(defaultPhase),
      inputTokenUpperBound(context) {
        return utf8Bytes(prepareAttempt(context).prompt);
      },
      outputTokenUpperBound(context) {
        return prepareAttempt(context).outputTokenUpperBound;
      },
      async propose(context) {
        const { mind, request, targetAssayId } = prepareAttempt(context);
        const proposals: NurseryProposal[] = [];
        try {
          const invocation = await invokeMindMetered(mind, request);
          if (invocation.investigation) await input.onInvestigation?.(adapterCapabilitySnapshot(mind).id, invocation.investigation);
          for (const original of invocation.contributions) {
            if (original.kind !== "candidate") continue;
            const contribution = input.supplemental ? { ...original, tags: [...(original.tags ?? []), `metabolic:${input.supplemental.receipt.kind}`, ...(input.sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2" ? [`grant-sequence:${input.supplemental.receipt.sequence}`, `grant-quantity:${input.supplemental.receipt.quantity}`] : [`grant:${input.supplemental.receipt.digest}`])] } : original;
            if (targetAssayId) {
              const target = input.experimentCapability?.experiments.find(experiment => experiment.assayId === targetAssayId);
              const blueprint = contribution.candidateBlueprintSource as { command?: { executable?: string; args?: unknown } } | undefined;
              if (!target || blueprint?.command?.executable !== target.command.executable || JSON.stringify(blueprint.command.args) !== JSON.stringify(target.command.args)) continue;
            }
            const proposal = toProposal(contribution);
            const source = { adapter: mind, contribution };
            sources.set(hypothesisContentDigest(proposal), source);
            attemptSources.set(context.ordinal, source);
            proposals.push(proposal);
          }
          return Object.freeze({ proposals: Object.freeze(proposals), tokenUsage: invocation.tokenUsage });
        } catch (error) {
          await input.onProviderFailure?.(adapterCapabilitySnapshot(mind).id, mindFailureInvestigation(error));
          return Object.freeze({
            proposals: Object.freeze([]),
            failure: `${adapterCapabilitySnapshot(mind).displayName} failed: ${redact(error)}`,
            tokenUsage: Object.freeze({
              input: Object.freeze({
                tokens: mindFailureInputUpperBound(error, utf8Bytes(request.preparedPublicPrompt ?? "")),
                measurement: "UPPER_BOUND" as const,
              }),
              output: Object.freeze({
                tokens: request.maxOutputTokens ?? context.resourcesRemaining.maxOutputTokens,
                measurement: "UPPER_BOUND" as const,
              }),
            }),
          });
        }
      },
    },
    profile,
    input.signal,
    async (observation) => {
      const source = observation.contentDigest
        ? sources.get(observation.contentDigest)
        : attemptSources.get(observation.ordinal);
      const prepared = preparedAttempts.get(observation.ordinal);
      const contribution = source !== undefined
        && prepared !== undefined
        && observation.type === "hypothesis.admitted"
        && observation.specimenId !== undefined
        ? admittedContribution({
            id: observation.specimenId,
            parentIds: prepared.parentIds,
            lineage: prepared.lineage,
            phase: prepared.phase,
          }, source)
        : source?.contribution;
      const enriched: AdaptiveSearchObservation = {
        ...observation,
        ...(source ? { source: adapterCapabilitySnapshot(source.adapter), contribution: source.contribution } : {}),
        ...(contribution === undefined || contribution === source?.contribution ? {} : { admittedContribution: contribution }),
        ...(prepared?.phase === "EXILE" && observation.ordinal <= profile.independentLineages && observation.type === "hypothesis.admitted" && observation.specimenId && preparedAttempts.has(observation.ordinal) ? {
          audit: (() => {
            const attempt = preparedAttempts.get(observation.ordinal)!;
            const capability = adapterCapabilitySnapshot(attempt.mind);
            return {
              kind: "lineage_commitment" as const,
              invocationId: `nursery_${input.supplemental ? `${input.supplemental.receipt.digest.slice(-16)}_` : ""}${observation.ordinal}`,
              providerId: String(capability.limits?.providerId ?? capability.id),
              modelId: String(capability.limits?.modelId ?? capability.version),
              lineageId: `lineage_${input.supplemental ? `${input.supplemental.receipt.digest.slice(-16)}_` : ""}${observation.ordinal}`,
              seedCommitment: sha256Digest(attempt.request.seed),
              seedEnforcement: capability.id === "mind.rule.v1" ? "honored" as const : "unverified" as const,
              promptDigest: sha256Digest(attempt.prompt),
              candidateIds: [observation.specimenId!],
              visibleCandidateIds: attempt.request.publicFacts.filter(fact => fact.kind === "candidate").map(fact => fact.id).sort(),
              memoryDigests: [],
              assumptionDigest: digestJson(input.sealed.intent.constraints as unknown as JsonValue),
            };
          })(),
        } : {}),
      };
      if (observation.type === "nursery.completed" && input.takePendingGrants) completedObservation = enriched;
      else await input.observe?.(enriched);
      if (input.takePendingGrants) {
        const eligible: MetabolicKind[] = ["Mass", "Fission"];
        if (sources.size > 0) eligible.push("Polarity");
        const used = new Set([...sources.values()].flatMap(source => {
          const proposed = source.contribution.candidateBlueprintSource as { command?: unknown } | undefined;
          return input.experimentCapability?.experiments.filter(experiment => JSON.stringify(proposed?.command) === JSON.stringify({ executable: experiment.command.executable, args: experiment.command.args })).map(experiment => experiment.assayId) ?? [];
        }));
        const unfamiliar = Math.max(0, (input.experimentCapability?.experiments.filter(experiment => !used.has(experiment.assayId)).length ?? 0) - pendingGrants.filter(receipt => receipt.kind === "Refraction").reduce((sum, receipt) => sum + receipt.quantity, 0));
        if (unfamiliar > 0) eligible.push("Refraction");
        await input.onMetabolicEligibility?.(eligible, { Refraction: unfamiliar });
        await drain();
      }
    },
  );

  const hypotheses = nursery.specimens.flatMap((specimen) => {
    const source = sources.get(specimen.contentDigest);
    return source ? [contributionFromSpecimen(specimen, source)] : [];
  });
  if (!input.takePendingGrants) return Object.freeze({ nursery, hypotheses: Object.freeze(hypotheses) });
  const supplementalOutcomes: AdaptiveSearchOutcome[] = [];
  let ordinalOffset = nursery.attempted;
  const resources = { ...nursery.resources };
  const addUsage = (target: typeof resources, extra: typeof resources) => {
    for (const key of ["mindInvocations", "inputTokens", "outputTokens", "wallMillis", "generatedBytes"] as const) target[key] += extra[key];
    if (extra.inputTokenMeasurement === "UPPER_BOUND") target.inputTokenMeasurement = "UPPER_BOUND";
    if (extra.outputTokenMeasurement === "UPPER_BOUND") target.outputTokenMeasurement = "UPPER_BOUND";
  };
  // Stop nursery-only offers before the final serial admission barrier. A later
  // physical-evidence checkpoint may expose Inertia without stranding a late
  // Mass/Fission receipt between generation and embodiment.
  if (input.deferMetabolicClosure === true) await input.onMetabolicEligibility?.([]);
  await drain();
  let admissionClosed = input.deferMetabolicClosure === true;
  for (let index = 0; index < pendingGrants.length || !admissionClosed; index++) {
    if (index >= pendingGrants.length) {
      await input.closeMetabolicAdmission?.();
      admissionClosed = true;
      await drain();
      if (index >= pendingGrants.length) break;
    }
    const receipt = pendingGrants[index]!;
    const used = new Set(hypotheses.flatMap(contribution => {
      const proposed = contribution.candidateBlueprintSource as { command?: unknown } | undefined;
      return input.experimentCapability?.experiments.filter(experiment => JSON.stringify(proposed?.command) === JSON.stringify({ executable: experiment.command.executable, args: experiment.command.args })).map(experiment => experiment.assayId) ?? [];
    }));
    const targets = input.experimentCapability?.experiments.filter(experiment => !used.has(experiment.assayId)).slice(0, receipt.quantity).map(experiment => experiment.assayId) ?? [];
    try {
      const outcome = await runSupplementalInvestigation({ ...input, observe: async observation => {
        const cumulative = { ...resources };
        addUsage(cumulative, observation.resources);
        if (observation.type !== "nursery.completed") await input.observe?.({ ...observation, ordinal: observation.ordinal + ordinalOffset, attempted: observation.attempted + ordinalOffset, resources: cumulative, publicSummary: `${receipt.kind}: ${observation.publicSummary}` });
      } }, receipt, { baselineHypotheses: hypotheses, baselineSaturated: nursery.termination === "HYPOTHESIS_SATURATED", targetAssayIds: targets });
      supplementalOutcomes.push(outcome);
      addUsage(resources, outcome.nursery.resources);
      ordinalOffset += outcome.nursery.attempted;
      hypotheses.push(...outcome.hypotheses);
    } catch (error) {
      if (!(error instanceof SupplementalUnavailableError)) throw error;
      await input.observe?.({ type: "hypothesis.scarred", ordinal: ++ordinalOffset, attempted: ordinalOffset, nurserySize: hypotheses.length, exactYieldAge: nursery.exactYieldAge, resources, publicSummary: `${receipt.kind} receipt ${receipt.digest} could not fulfill its exact offered work in the current sealed context; no different effect was substituted.` });
    }
    await drain();
  }
  const combined = Object.freeze({ ...nursery, attempted: ordinalOffset, specimens: Object.freeze([ ...nursery.specimens, ...supplementalOutcomes.flatMap(outcome => outcome.nursery.specimens) ]), resources: Object.freeze(resources), scars: Object.freeze([ ...nursery.scars, ...supplementalOutcomes.flatMap(outcome => outcome.nursery.scars) ]) });
  if (completedObservation) await input.observe?.({ ...completedObservation, ordinal: ordinalOffset, attempted: ordinalOffset, nurserySize: hypotheses.length, resources, publicSummary: `Baseline closed by ${nursery.termination}; ${supplementalOutcomes.length} authenticated additive work grants ran separately.` });
  return Object.freeze({ nursery: combined, hypotheses: Object.freeze(hypotheses) });
}
