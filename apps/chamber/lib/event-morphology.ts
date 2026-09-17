/**
 * Jevyr Chamber causal read model.
 *
 * This module deliberately contains no coordinates, colors, animation curves, or
 * aesthetic defaults. It maps an already-verified public event ledger into facts
 * a renderer may express. Every visible mutation can therefore name the event
 * sequence that caused it.
 *
 * Causal mapping:
 * - candidate.status -> candidate history, explicit genealogy, lineage membership
 * - evidence.observed -> authority-preserving evidence nodes and directed relations
 * - requirement claims + assays -> obligation resolution and unresolved pressure
 * - failed/invalidated events + nursery scar counters -> attributed/anonymous scars
 * - search.status -> metered resource pressure and two non-interchangeable novelty views
 * - digest links + terminal stage completion -> continuity and irreversible stillness
 *
 * Attempt count is retained only as last-resort safety-guard telemetry. It is
 * never normalized into pressure, novelty, quality, depth, or intelligence.
 */

export const MORPHOLOGY_PROTOCOL = 'jevyr.chamber-morphology/1' as const;

export const SEARCH_RESOURCE_NAMES = [
  'mindInvocations',
  'inputTokens',
  'outputTokens',
  'wallMillis',
  'singleInvocationMillis',
  'generatedBytes',
  'forgeCpuMillis',
  'forgeWallMillis',
  'memorySeconds',
  'writableBytes',
  'writableInodes',
  'artifactBytes',
  'networkBytes',
  'concurrentLineages',
  'totalAssayCost',
] as const;

export type SearchResourceName = (typeof SEARCH_RESOURCE_NAMES)[number];
export type ResourceMeasurement =
  | 'MEASURED'
  | 'UPPER_BOUND'
  | 'DECLARED_ONLY'
  | 'MISSING';

export interface MorphologyEvent {
  readonly protocol?: string;
  readonly caseDigest?: string;
  readonly runDigest?: string;
  readonly sequence: number;
  readonly priorDigest?: string | null;
  readonly eventDigest?: string;
  readonly observedAt?: string;
  readonly stage?: string;
  readonly kind: string;
  readonly actor?: {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly instance?: unknown;
  };
  readonly payload?: unknown;
  readonly status?: string;
  readonly summary?: string;
}

export interface MorphologyDiagnostic {
  readonly code:
    | 'INVALID_SEQUENCE'
    | 'EVENT_CONFLICT'
    | 'EVENT_GAP'
    | 'DIGEST_ENVELOPE_INVALID'
    | 'DIGEST_LINK_BROKEN'
    | 'CASE_IDENTITY_DRIFT'
    | 'RUN_IDENTITY_DRIFT'
    | 'POST_TERMINAL_EVENT'
    | 'PAYLOAD_INVALID'
    | 'IDENTIFIER_INVALID'
    | 'STATUS_INVALID'
    | 'RELATION_INVALID'
    | 'GENEALOGY_CONFLICT'
    | 'GENEALOGY_CYCLE'
    | 'COUNTER_REGRESSION'
    | 'RESOURCE_INVALID'
    | 'RESOURCE_CEILING_DRIFT'
    | 'TERMINATION_CONFLICT';
  readonly sequence?: number;
  readonly field?: string;
}

export interface ContinuityModel {
  readonly state: 'empty' | 'continuous' | 'unverifiable' | 'broken';
  readonly acceptedThrough: number;
  readonly acceptedEventCount: number;
  readonly duplicateEventCount: number;
  readonly ignoredEventCount: number;
  readonly headDigest: string | null;
  readonly caseDigest: string | null;
  readonly runDigest: string | null;
  readonly cryptographicLinksPresent: boolean;
  readonly postTerminalSequences: readonly number[];
}

export type CandidateStatus =
  | 'proposed'
  | 'selected'
  | 'embodied'
  | 'survived'
  | 'invalidated';

export interface CandidateStatusMoment {
  readonly sequence: number;
  readonly stage: string | null;
  readonly status: CandidateStatus;
  readonly summary: string;
}

export interface CandidateMorphology {
  readonly id: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly currentStatus: CandidateStatus | 'referenced';
  readonly statusHistory: readonly CandidateStatusMoment[];
  readonly parentIds: readonly string[];
  readonly parentDisclosure: 'undisclosed' | 'declared' | 'conflicted';
  readonly generation: number | null;
  readonly genealogyState:
    | 'root'
    | 'descendant'
    | 'partial'
    | 'cyclic'
    | 'undisclosed';
  readonly actorIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly assayIds: readonly string[];
  readonly artifactDigests: readonly string[];
  readonly feasibility: string | null;
}

export interface GenealogyEdge {
  readonly parentId: string;
  readonly childId: string;
  readonly declaredAtSequence: number;
  readonly parentKnown: boolean;
}

export interface CandidateLineage {
  /** Stable while the lineage root remains the same. */
  readonly id: string;
  readonly rootId: string;
  readonly rootKind: 'candidate' | 'external' | 'cycle';
  readonly rootCertainty: 'declared' | 'undisclosed' | 'partial' | 'cyclic';
  readonly candidateIds: readonly string[];
  readonly terminalCandidateIds: readonly string[];
  readonly scarredCandidateIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export type EvidenceAuthority =
  | 'subject_snapshot'
  | 'deterministic_tool'
  | 'sandbox_execution'
  | 'artifact_inspection'
  | 'model_report'
  | 'peer_report'
  | 'memory_hint'
  | 'unknown';

export interface EvidenceMorphology {
  readonly id: string;
  readonly sequence: number;
  readonly evidenceType: string;
  readonly authority: EvidenceAuthority;
  readonly summary: string;
  readonly contentDigest: string | null;
  readonly supports: readonly string[];
  readonly refutes: readonly string[];
}

export interface EvidenceRelation {
  readonly kind: 'supports' | 'refutes';
  readonly evidenceId: string;
  readonly targetId: string;
  readonly sequence: number;
  readonly authority: EvidenceAuthority;
  readonly targetKnown: boolean;
}

export type ObligationResolution =
  | 'unassayed'
  | 'planned'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'inconclusive'
  | 'contested';

export interface ObligationMorphology {
  readonly id: string;
  readonly statement: string | null;
  readonly source: 'sealed_requirement' | 'assay_reference';
  readonly critical: boolean;
  readonly resolution: ObligationResolution;
  readonly unresolved: boolean;
  readonly assayIds: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
  readonly refutingEvidenceIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface AssayMorphology {
  readonly id: string;
  readonly candidateId: string | null;
  readonly obligationId: string | null;
  readonly critical: boolean;
  readonly status:
    | 'planned'
    | 'running'
    | 'passed'
    | 'failed'
    | 'inconclusive'
    | 'blocked';
  readonly evidenceIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly summary: string;
}

export interface ScarMorphology {
  readonly id: string;
  readonly sequence: number;
  readonly kind:
    | 'candidate_invalidation'
    | 'assay_failure'
    | 'action_failure'
    | 'stage_failure';
  readonly subjectId: string;
  readonly summary: string;
}

export interface ScarBurden {
  /** Individually attributable failures visible in the ledger. */
  readonly attributedCount: number;
  /** Latest cumulative nursery count; individual identities are not public. */
  readonly anonymousNurseryCount: number;
  /** Safe lower bound because anonymous and attributed scars may overlap. */
  readonly minimumDistinctCount: number;
}

export interface ResourcePressure {
  readonly name: SearchResourceName;
  readonly used: number | null;
  readonly ceiling: number | null;
  readonly measurement: ResourceMeasurement;
  /** Null when no meter exists; capped at one and never used as a quality score. */
  readonly pressure: number | null;
  readonly overrun: boolean;
  readonly observedAtSequence: number | null;
}

export interface ResourcePressureModel {
  readonly resources: readonly ResourcePressure[];
  readonly maximumKnownPressure: number | null;
  readonly maximumKnownPressureMeasurement:
    | 'MEASURED'
    | 'UPPER_BOUND'
    | 'MIXED'
    | null;
  readonly dominantResourceNames: readonly SearchResourceName[];
  readonly unmeteredResourceNames: readonly SearchResourceName[];
  readonly hasOverrun: boolean;
}

export interface SearchGuardTelemetry {
  readonly attempted: number | null;
  readonly attemptSafetyCeiling: string | null;
  readonly reached: boolean | null;
  readonly safetyGuardOnly: true;
}

export interface NoveltySample {
  readonly sequence: number;
  readonly exactDistinctHypotheses: number | null;
  readonly exactYieldAge: number | null;
  readonly measuredEntries: number | null;
  readonly occupiedNiches: number | null;
  readonly lastMeasuredNovelty: number | null;
}

export interface NoveltyModel {
  readonly exactContent: {
    readonly distinctHypotheses: number | null;
    readonly yieldAge: number | null;
    readonly declaredMechanismLabels: readonly string[];
    readonly state: 'unavailable' | 'empty' | 'yielding' | 'aging';
  };
  readonly assayArchive: {
    readonly measuredEntries: number | null;
    readonly occupiedNiches: number | null;
    readonly lastMeasuredNovelty: number | null;
    readonly state:
      | 'unavailable'
      | 'empty'
      | 'admitted_unscored'
      | 'novel'
      | 'not_novel';
  };
  /** Exact content inequality is intentionally not promoted to semantic novelty. */
  readonly semanticInferenceFromExactCounts: 'forbidden';
  readonly samples: readonly NoveltySample[];
}

export interface TerminationModel {
  readonly searchCause:
    | 'HYPOTHESIS_SATURATED'
    | 'RESOURCE_EXHAUSTED'
    | 'ATTEMPT_CEILING'
    | null;
  readonly searchCauseSequence: number | null;
  readonly searchCauseConflicted: boolean;
  readonly announcedSequence: number | null;
  readonly completedSequence: number | null;
}

export interface StillnessModel {
  readonly state:
    | 'dormant'
    | 'live'
    | 'termination_announced'
    | 'terminal'
    | 'ruptured';
  readonly motion: 'none' | 'event_driven' | 'arrested';
  readonly terminal: boolean;
  readonly terminalSequence: number | null;
  readonly signed: boolean;
  readonly signedSequence: number | null;
  readonly signedBeforeTermination: boolean;
  readonly integrity: 'intact' | 'unverifiable' | 'violated';
}

export type MorphologySignalChannel =
  | 'candidate'
  | 'lineage'
  | 'scar'
  | 'evidence'
  | 'obligation'
  | 'resource'
  | 'novelty'
  | 'termination';

export interface MorphologySignal {
  readonly sequence: number;
  readonly channel: MorphologySignalChannel;
  readonly entityIds: readonly string[];
}

export interface ChamberMorphology {
  readonly protocol: typeof MORPHOLOGY_PROTOCOL;
  readonly cursor: number;
  readonly continuity: ContinuityModel;
  readonly candidates: readonly CandidateMorphology[];
  readonly genealogy: readonly GenealogyEdge[];
  readonly lineages: readonly CandidateLineage[];
  readonly evidence: readonly EvidenceMorphology[];
  readonly evidenceRelations: readonly EvidenceRelation[];
  readonly assays: readonly AssayMorphology[];
  readonly obligations: readonly ObligationMorphology[];
  readonly unresolvedObligationIds: readonly string[];
  readonly scars: readonly ScarMorphology[];
  readonly scarBurden: ScarBurden;
  readonly resourcePressure: ResourcePressureModel;
  readonly searchGuard: SearchGuardTelemetry;
  readonly novelty: NoveltyModel;
  readonly termination: TerminationModel;
  readonly stillness: StillnessModel;
  readonly signals: readonly MorphologySignal[];
  readonly diagnostics: readonly MorphologyDiagnostic[];
}

type UnknownRecord = Record<string, unknown>;

type MutableCandidate = {
  id: string;
  firstSequence: number;
  lastSequence: number;
  statusHistory: CandidateStatusMoment[];
  parents?: string[];
  parentDeclarationSequence?: number;
  parentConflict: boolean;
  actors: Set<string>;
  claims: Set<string>;
  assays: Set<string>;
  artifacts: Set<string>;
  feasibility: string | null;
};

type MutableAssay = {
  id: string;
  candidateId: string | null;
  obligationId: string | null;
  critical: boolean;
  status: AssayMorphology['status'];
  evidenceIds: Set<string>;
  firstSequence: number;
  lastSequence: number;
  summary: string;
};

type MutableObligation = {
  id: string;
  statement: string | null;
  source: ObligationMorphology['source'];
  critical: boolean;
  assays: Set<string>;
  supports: Set<string>;
  refutes: Set<string>;
  firstSequence: number;
  lastSequence: number;
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  'proposed',
  'selected',
  'embodied',
  'survived',
  'invalidated',
]);
const ASSAY_STATUSES = new Set<AssayMorphology['status']>([
  'planned',
  'running',
  'passed',
  'failed',
  'inconclusive',
  'blocked',
]);
const SEARCH_TERMINATIONS = new Set<
  NonNullable<TerminationModel['searchCause']>
>(['HYPOTHESIS_SATURATED', 'RESOURCE_EXHAUSTED', 'ATTEMPT_CEILING']);
const RESOURCE_NAME_SET = new Set<string>(SEARCH_RESOURCE_NAMES);

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function safeCounter(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizedStage(value: unknown): string | null {
  const stage = text(value);
  return stage === null
    ? null
    : stage.toLowerCase().replaceAll('-', '_').replaceAll('.', '_');
}

function strictStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const output: string[] = [];
  for (const item of value) {
    const parsed = text(item);
    if (parsed === null) return null;
    output.push(parsed);
  }
  return [...new Set(output)].sort();
}

function stableSerialize(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? JSON.stringify(value) : '"[non-finite]"';
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '"[circular]"';
    const next = new Set(ancestors).add(value);
    return `[${value.map((item) => stableSerialize(item, next)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) return '"[circular]"';
    const next = new Set(ancestors).add(value);
    const source = value as UnknownRecord;
    return `{${Object.keys(source)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableSerialize(source[key], next)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(`[${typeof value}]`);
}

function eventIdentity(event: MorphologyEvent): string {
  // Include the complete public object even when a digest is present. Ingress is
  // responsible for recomputing that digest, but this layer must still refuse two
  // non-identical objects that claim the same sequence and digest.
  return stableSerialize(event);
}

function actorId(event: MorphologyEvent): string | null {
  return text(event.actor?.id);
}

function eventSummary(event: MorphologyEvent, payload: UnknownRecord): string {
  return (
    text(payload.summary) ??
    text(payload.statement) ??
    text(event.summary) ??
    event.kind
  );
}

function isCompletedTerminalEvent(event: MorphologyEvent): boolean {
  const payload = record(event.payload);
  if (!payload) return false;
  if (
    event.kind === 'stage.status' &&
    normalizedStage(payload.stage ?? event.stage) === 'terminate' &&
    payload.status === 'completed'
  )
    return true;
  return (
    event.kind === 'action.status' &&
    payload.actionType === 'runtime.recovery.terminate-existing-record' &&
    payload.status === 'completed'
  );
}

function isTerminationAnnouncement(event: MorphologyEvent): boolean {
  const payload = record(event.payload);
  return event.kind === 'kernel.status' && payload?.operation === 'terminated';
}

function preparePrefix(
  events: readonly MorphologyEvent[],
  diagnostics: MorphologyDiagnostic[],
): {
  accepted: MorphologyEvent[];
  continuity: ContinuityModel;
} {
  const groups = new Map<number, MorphologyEvent[]>();
  let invalidSequenceCount = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      invalidSequenceCount += 1;
      diagnostics.push({ code: 'INVALID_SEQUENCE' });
      continue;
    }
    const group = groups.get(event.sequence) ?? [];
    group.push(event);
    groups.set(event.sequence, group);
  }

  const accepted: MorphologyEvent[] = [];
  const postTerminalSequences: number[] = [];
  let expected = 1;
  let duplicateEventCount = 0;
  let broken = invalidSequenceCount > 0;
  let headDigest: string | null = null;
  let caseDigest: string | null = null;
  let runDigest: string | null = null;
  let linkedCount = 0;
  let unlinkedCount = 0;
  let terminalSequence: number | null = null;

  for (const sequence of [...groups.keys()].sort(
    (left, right) => left - right,
  )) {
    const group = groups.get(sequence) ?? [];
    if (terminalSequence !== null) {
      postTerminalSequences.push(sequence);
      diagnostics.push({ code: 'POST_TERMINAL_EVENT', sequence });
      broken = true;
      continue;
    }
    if (sequence !== expected) {
      diagnostics.push({
        code: 'EVENT_GAP',
        sequence,
        field: `expected:${expected}`,
      });
      broken = true;
      break;
    }
    const byIdentity = new Map(
      group.map((event) => [eventIdentity(event), event]),
    );
    if (byIdentity.size !== 1) {
      diagnostics.push({ code: 'EVENT_CONFLICT', sequence });
      broken = true;
      break;
    }
    duplicateEventCount += group.length - 1;
    const event = [...byIdentity.values()][0] as MorphologyEvent;

    if (event.protocol === 'jevyr.event/1') {
      if (unlinkedCount > 0) {
        diagnostics.push({ code: 'DIGEST_ENVELOPE_INVALID', sequence });
        broken = true;
        break;
      }
      if (
        !DIGEST_PATTERN.test(event.eventDigest ?? '') ||
        !DIGEST_PATTERN.test(event.caseDigest ?? '') ||
        !DIGEST_PATTERN.test(event.runDigest ?? '') ||
        !(
          event.priorDigest === null ||
          DIGEST_PATTERN.test(event.priorDigest ?? '')
        )
      ) {
        diagnostics.push({ code: 'DIGEST_ENVELOPE_INVALID', sequence });
        broken = true;
        break;
      }
      if (event.priorDigest !== headDigest) {
        diagnostics.push({ code: 'DIGEST_LINK_BROKEN', sequence });
        broken = true;
        break;
      }
      if (caseDigest !== null && event.caseDigest !== caseDigest) {
        diagnostics.push({ code: 'CASE_IDENTITY_DRIFT', sequence });
        broken = true;
        break;
      }
      if (runDigest !== null && event.runDigest !== runDigest) {
        diagnostics.push({ code: 'RUN_IDENTITY_DRIFT', sequence });
        broken = true;
        break;
      }
      caseDigest ??= event.caseDigest as string;
      runDigest ??= event.runDigest as string;
      headDigest = event.eventDigest as string;
      linkedCount += 1;
    } else {
      if (linkedCount > 0) {
        diagnostics.push({ code: 'DIGEST_ENVELOPE_INVALID', sequence });
        broken = true;
        break;
      }
      unlinkedCount += 1;
      headDigest = null;
    }

    accepted.push(event);
    expected += 1;
    if (isCompletedTerminalEvent(event)) terminalSequence = sequence;
  }

  const ignoredEventCount =
    events.length - accepted.length - duplicateEventCount;
  const state: ContinuityModel['state'] = broken
    ? 'broken'
    : accepted.length === 0
      ? 'empty'
      : linkedCount === accepted.length && unlinkedCount === 0
        ? 'continuous'
        : 'unverifiable';
  return {
    accepted,
    continuity: {
      state,
      acceptedThrough: accepted.at(-1)?.sequence ?? 0,
      acceptedEventCount: accepted.length,
      duplicateEventCount,
      ignoredEventCount: Math.max(0, ignoredEventCount),
      headDigest,
      caseDigest,
      runDigest,
      cryptographicLinksPresent: linkedCount > 0,
      postTerminalSequences,
    },
  };
}

function evidenceAuthority(evidenceType: string): EvidenceAuthority {
  switch (evidenceType) {
    case 'subject_snapshot':
      return 'subject_snapshot';
    case 'tool_observation':
      return 'deterministic_tool';
    case 'sandbox_execution':
      return 'sandbox_execution';
    case 'artifact':
      return 'artifact_inspection';
    case 'model_report':
      return 'model_report';
    case 'peer_report':
      return 'peer_report';
    case 'memory_hint':
      return 'memory_hint';
    default:
      return 'unknown';
  }
}

function obligationResolution(
  assays: readonly MutableAssay[],
): ObligationResolution {
  if (assays.length === 0) return 'unassayed';
  const statuses = new Set(assays.map((assay) => assay.status));
  if (statuses.has('passed') && statuses.has('failed')) return 'contested';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('passed')) return 'passed';
  const latest = [...assays]
    .sort((left, right) => left.lastSequence - right.lastSequence)
    .at(-1);
  return latest?.status ?? 'unassayed';
}

function resourceSample(
  entry: unknown,
  sequence: number,
  diagnostics: MorphologyDiagnostic[],
): {
  name: SearchResourceName;
  used: number | null;
  ceiling: number;
  measurement: Exclude<ResourceMeasurement, 'MISSING'>;
  sequence: number;
} | null {
  const source = record(entry);
  if (!source || !RESOURCE_NAME_SET.has(source.name as string)) {
    diagnostics.push({
      code: 'RESOURCE_INVALID',
      sequence,
      field: 'resources',
    });
    return null;
  }
  const name = source.name as SearchResourceName;
  const ceiling = safeCounter(source.ceiling);
  if (
    ceiling === null ||
    !['MEASURED', 'UPPER_BOUND', 'DECLARED_ONLY'].includes(
      source.measurement as string,
    )
  ) {
    diagnostics.push({
      code: 'RESOURCE_INVALID',
      sequence,
      field: `resources.${name}`,
    });
    return null;
  }
  const measurement = source.measurement as Exclude<
    ResourceMeasurement,
    'MISSING'
  >;
  if (measurement === 'DECLARED_ONLY') {
    if (source.used !== null) {
      diagnostics.push({
        code: 'RESOURCE_INVALID',
        sequence,
        field: `resources.${name}.used`,
      });
      return null;
    }
    return { name, used: null, ceiling, measurement, sequence };
  }
  const used = finiteNonNegative(source.used);
  if (used === null) {
    diagnostics.push({
      code: 'RESOURCE_INVALID',
      sequence,
      field: `resources.${name}.used`,
    });
    return null;
  }
  return { name, used, ceiling, measurement, sequence };
}

function generationFor(
  id: string,
  candidates: ReadonlyMap<string, MutableCandidate>,
  cyclic: ReadonlySet<string>,
  memo: Map<string, number | null>,
  visiting = new Set<string>(),
): number | null {
  if (memo.has(id)) return memo.get(id) ?? null;
  if (cyclic.has(id) || visiting.has(id)) return null;
  const candidate = candidates.get(id);
  if (
    !candidate ||
    candidate.parents === undefined ||
    candidate.parents.length === 0
  ) {
    memo.set(id, 0);
    return 0;
  }
  const nextVisiting = new Set(visiting).add(id);
  const parentGenerations = candidate.parents.map((parent) =>
    candidates.has(parent)
      ? generationFor(parent, candidates, cyclic, memo, nextVisiting)
      : 0,
  );
  if (parentGenerations.some((value) => value === null)) return null;
  const generation = Math.max(...(parentGenerations as number[])) + 1;
  memo.set(id, generation);
  return generation;
}

function cyclicCandidateIds(
  candidates: ReadonlyMap<string, MutableCandidate>,
): Set<string> {
  const cyclic = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (state.get(id) === 'done') return;
    const existingIndex = stack.indexOf(id);
    if (existingIndex >= 0) {
      for (const member of stack.slice(existingIndex)) cyclic.add(member);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const parent of candidates.get(id)?.parents ?? []) {
      if (candidates.has(parent)) visit(parent);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of [...candidates.keys()].sort()) visit(id);
  return cyclic;
}

function cycleRepresentatives(
  candidates: ReadonlyMap<string, MutableCandidate>,
  cyclic: ReadonlySet<string>,
): Map<string, string> {
  const neighbors = new Map<string, Set<string>>();
  for (const id of cyclic) neighbors.set(id, new Set());
  for (const id of cyclic) {
    for (const parent of candidates.get(id)?.parents ?? []) {
      if (!cyclic.has(parent)) continue;
      neighbors.get(id)?.add(parent);
      neighbors.get(parent)?.add(id);
    }
  }
  const representatives = new Map<string, string>();
  const unseen = new Set([...cyclic].sort());
  while (unseen.size > 0) {
    const seed = [...unseen].sort()[0] as string;
    const component = new Set<string>();
    const frontier = [seed];
    while (frontier.length > 0) {
      const current = frontier.shift() as string;
      if (component.has(current)) continue;
      component.add(current);
      unseen.delete(current);
      frontier.push(...[...(neighbors.get(current) ?? [])].sort());
    }
    const representative = [...component].sort()[0] as string;
    for (const id of component) representatives.set(id, representative);
  }
  return representatives;
}

function lineageRootsFor(
  id: string,
  candidates: ReadonlyMap<string, MutableCandidate>,
  cyclic: ReadonlySet<string>,
  cycleRootByCandidate: ReadonlyMap<string, string>,
  memo: Map<string, Set<string>>,
  visiting = new Set<string>(),
): Set<string> {
  const cached = memo.get(id);
  if (cached) return new Set(cached);
  if (cyclic.has(id) || visiting.has(id)) {
    return new Set([`cycle:${cycleRootByCandidate.get(id) ?? id}`]);
  }
  const candidate = candidates.get(id);
  if (
    !candidate ||
    candidate.parents === undefined ||
    candidate.parents.length === 0
  ) {
    const roots = new Set([`candidate:${id}`]);
    memo.set(id, roots);
    return new Set(roots);
  }
  const roots = new Set<string>();
  const nextVisiting = new Set(visiting).add(id);
  for (const parent of candidate.parents) {
    if (candidates.has(parent)) {
      for (const root of lineageRootsFor(
        parent,
        candidates,
        cyclic,
        cycleRootByCandidate,
        memo,
        nextVisiting,
      ))
        roots.add(root);
    } else {
      roots.add(`external:${parent}`);
    }
  }
  memo.set(id, roots);
  return new Set(roots);
}

function signal(
  signals: MorphologySignal[],
  sequence: number,
  channel: MorphologySignalChannel,
  ids: readonly string[],
): void {
  const entityIds = [...new Set(ids.filter((id) => id.length > 0))].sort();
  signals.push({ sequence, channel, entityIds });
}

/**
 * Derive renderer-ready causal morphology from a complete public event prefix.
 * Inputs may arrive in any order; ordering is canonicalized by sequence. Conflicts,
 * gaps, and malformed fields reduce claims rather than being guessed through.
 *
 * Cryptographic event digests are assumed to have been checked by the Chamber's
 * ingress normalizer. This function verifies linkage/identity continuity only.
 */
export function deriveEventMorphology(
  inputEvents: readonly MorphologyEvent[],
): ChamberMorphology {
  const diagnostics: MorphologyDiagnostic[] = [];
  const { accepted, continuity } = preparePrefix(inputEvents, diagnostics);
  const candidates = new Map<string, MutableCandidate>();
  const evidence = new Map<string, EvidenceMorphology>();
  const assays = new Map<string, MutableAssay>();
  const obligations = new Map<string, MutableObligation>();
  const claimIds = new Set<string>();
  const scars: ScarMorphology[] = [];
  const signals: MorphologySignal[] = [];
  const resourceSamples = new Map<
    SearchResourceName,
    ReturnType<typeof resourceSample> & {}
  >();
  const resourceCeilings = new Map<SearchResourceName, number>();
  const noveltySamples: NoveltySample[] = [];
  let latestAttempted: number | null = null;
  let latestAttemptCeiling: string | null = null;
  let latestNursery: {
    distinct: number;
    scars: number;
    labels: readonly string[];
    yieldAge: number;
    sequence: number;
  } | null = null;
  let latestArchive: {
    entries: number;
    niches: number;
    novelty: number | null;
    sequence: number;
  } | null = null;
  const searchTerminations: {
    cause: NonNullable<TerminationModel['searchCause']>;
    sequence: number;
  }[] = [];
  let announcedSequence: number | null = null;
  let completedSequence: number | null = null;
  let signedSequence: number | null = null;

  const ensureCandidate = (id: string, sequence: number): MutableCandidate => {
    const existing = candidates.get(id);
    if (existing) return existing;
    const created: MutableCandidate = {
      id,
      firstSequence: sequence,
      lastSequence: sequence,
      statusHistory: [],
      parentConflict: false,
      actors: new Set(),
      claims: new Set(),
      assays: new Set(),
      artifacts: new Set(),
      feasibility: null,
    };
    candidates.set(id, created);
    return created;
  };

  const ensureObligation = (
    id: string,
    sequence: number,
    source: ObligationMorphology['source'],
  ): MutableObligation => {
    const existing = obligations.get(id);
    if (existing) {
      existing.firstSequence = Math.min(existing.firstSequence, sequence);
      existing.lastSequence = Math.max(existing.lastSequence, sequence);
      if (source === 'sealed_requirement') existing.source = source;
      return existing;
    }
    const created: MutableObligation = {
      id,
      statement: null,
      source,
      critical: false,
      assays: new Set(),
      supports: new Set(),
      refutes: new Set(),
      firstSequence: sequence,
      lastSequence: sequence,
    };
    obligations.set(id, created);
    return created;
  };

  for (const event of accepted) {
    const payload = record(event.payload);
    if (!payload) {
      diagnostics.push({
        code: 'PAYLOAD_INVALID',
        sequence: event.sequence,
        field: 'payload',
      });
      continue;
    }
    const summary = eventSummary(event, payload);

    if (event.kind === 'candidate.status') {
      const id = text(payload.candidateId);
      const status = text(payload.status) as CandidateStatus | null;
      if (id === null) {
        diagnostics.push({
          code: 'IDENTIFIER_INVALID',
          sequence: event.sequence,
          field: 'candidateId',
        });
        continue;
      }
      if (status === null || !CANDIDATE_STATUSES.has(status)) {
        diagnostics.push({
          code: 'STATUS_INVALID',
          sequence: event.sequence,
          field: 'candidate.status',
        });
        continue;
      }
      const candidate = ensureCandidate(id, event.sequence);
      candidate.lastSequence = event.sequence;
      candidate.statusHistory.push({
        sequence: event.sequence,
        stage: normalizedStage(event.stage),
        status,
        summary,
      });
      const actor = actorId(event);
      if (actor !== null) candidate.actors.add(actor);
      const artifacts =
        payload.artifactDigests === undefined
          ? []
          : strictStringArray(payload.artifactDigests);
      if (artifacts === null) {
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: 'artifactDigests',
        });
      } else {
        for (const digest of artifacts) candidate.artifacts.add(digest);
      }
      if (text(payload.feasibility) !== null)
        candidate.feasibility = payload.feasibility as string;

      if (payload.parentIds !== undefined) {
        const parents = strictStringArray(payload.parentIds);
        if (parents === null) {
          diagnostics.push({
            code: 'RELATION_INVALID',
            sequence: event.sequence,
            field: 'parentIds',
          });
        } else if (candidate.parents === undefined) {
          candidate.parents = [...parents];
          candidate.parentDeclarationSequence = event.sequence;
        } else if (
          stableSerialize(candidate.parents) !== stableSerialize(parents)
        ) {
          candidate.parentConflict = true;
          diagnostics.push({
            code: 'GENEALOGY_CONFLICT',
            sequence: event.sequence,
            field: id,
          });
        }
      }
      signal(signals, event.sequence, 'candidate', [id]);
      signal(signals, event.sequence, 'lineage', [
        id,
        ...(candidate.parents ?? []),
      ]);
      if (status === 'invalidated') {
        scars.push({
          id: `candidate:${id}:${event.sequence}`,
          sequence: event.sequence,
          kind: 'candidate_invalidation',
          subjectId: id,
          summary,
        });
        signal(signals, event.sequence, 'scar', [id]);
      }
      continue;
    }

    if (event.kind === 'claim.published') {
      const claimId = text(payload.claimId);
      if (claimId === null) {
        diagnostics.push({
          code: 'IDENTIFIER_INVALID',
          sequence: event.sequence,
          field: 'claimId',
        });
        continue;
      }
      claimIds.add(claimId);
      const claimType = text(payload.claimType);
      if (claimType === 'requirement') {
        const obligation = ensureObligation(
          claimId,
          event.sequence,
          'sealed_requirement',
        );
        obligation.critical = true;
        const statement = text(payload.statement);
        if (statement === null) {
          diagnostics.push({
            code: 'PAYLOAD_INVALID',
            sequence: event.sequence,
            field: 'statement',
          });
        } else if (obligation.statement === null) {
          obligation.statement = statement;
        } else if (obligation.statement !== statement) {
          diagnostics.push({
            code: 'PAYLOAD_INVALID',
            sequence: event.sequence,
            field: `requirement:${claimId}`,
          });
        }
        signal(signals, event.sequence, 'obligation', [claimId]);
      }
      const candidateId = text(payload.candidateId);
      if (candidateId !== null) {
        ensureCandidate(candidateId, event.sequence).claims.add(claimId);
        signal(signals, event.sequence, 'candidate', [candidateId]);
      }
      continue;
    }

    if (event.kind === 'evidence.observed') {
      const id = text(payload.evidenceId);
      const evidenceType = text(payload.evidenceType);
      if (id === null || evidenceType === null) {
        diagnostics.push({
          code: 'IDENTIFIER_INVALID',
          sequence: event.sequence,
          field: 'evidence',
        });
        continue;
      }
      const supports =
        payload.supports === undefined
          ? []
          : strictStringArray(payload.supports);
      const refutes =
        payload.refutes === undefined ? [] : strictStringArray(payload.refutes);
      if (supports === null || refutes === null) {
        diagnostics.push({
          code: 'RELATION_INVALID',
          sequence: event.sequence,
          field: 'evidence relations',
        });
      }
      const node: EvidenceMorphology = {
        id,
        sequence: event.sequence,
        evidenceType,
        authority: evidenceAuthority(evidenceType),
        summary,
        contentDigest: DIGEST_PATTERN.test(payload.contentDigest as string)
          ? (payload.contentDigest as string)
          : null,
        supports: supports ?? [],
        refutes: refutes ?? [],
      };
      if (node.contentDigest === null) {
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: 'contentDigest',
        });
      }
      if (!evidence.has(id)) evidence.set(id, node);
      else
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: `duplicate-evidence:${id}`,
        });
      signal(signals, event.sequence, 'evidence', [
        id,
        ...node.supports,
        ...node.refutes,
      ]);
      const obligationTargets = [...node.supports, ...node.refutes].filter(
        (target) => obligations.has(target),
      );
      if (obligationTargets.length > 0) {
        signal(signals, event.sequence, 'obligation', obligationTargets);
      }
      continue;
    }

    if (event.kind === 'assay.status') {
      const id = text(payload.assayId);
      const status = text(payload.status) as AssayMorphology['status'] | null;
      if (id === null) {
        diagnostics.push({
          code: 'IDENTIFIER_INVALID',
          sequence: event.sequence,
          field: 'assayId',
        });
        continue;
      }
      if (status === null || !ASSAY_STATUSES.has(status)) {
        diagnostics.push({
          code: 'STATUS_INVALID',
          sequence: event.sequence,
          field: 'assay.status',
        });
        continue;
      }
      const candidateId = text(payload.candidateId);
      const obligationId = text(payload.obligationId);
      const evidenceIds =
        payload.evidenceIds === undefined
          ? []
          : strictStringArray(payload.evidenceIds);
      if (evidenceIds === null)
        diagnostics.push({
          code: 'RELATION_INVALID',
          sequence: event.sequence,
          field: 'evidenceIds',
        });
      if (typeof payload.critical !== 'boolean') {
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: 'critical',
        });
      }
      const existing = assays.get(id);
      if (
        existing &&
        ((candidateId !== null &&
          existing.candidateId !== null &&
          candidateId !== existing.candidateId) ||
          (obligationId !== null &&
            existing.obligationId !== null &&
            obligationId !== existing.obligationId))
      )
        diagnostics.push({
          code: 'RELATION_INVALID',
          sequence: event.sequence,
          field: `assay:${id}`,
        });
      const assay: MutableAssay = existing ?? {
        id,
        candidateId,
        obligationId,
        critical: payload.critical === true,
        status,
        evidenceIds: new Set(),
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        summary,
      };
      assay.candidateId ??= candidateId;
      assay.obligationId ??= obligationId;
      assay.critical ||= payload.critical === true;
      assay.status = status;
      assay.lastSequence = event.sequence;
      assay.summary = summary;
      for (const evidenceId of evidenceIds ?? [])
        assay.evidenceIds.add(evidenceId);
      assays.set(id, assay);
      if (assay.candidateId !== null)
        ensureCandidate(assay.candidateId, event.sequence).assays.add(id);
      if (assay.obligationId !== null) {
        const obligation = ensureObligation(
          assay.obligationId,
          event.sequence,
          'assay_reference',
        );
        obligation.critical ||= assay.critical;
        obligation.assays.add(id);
      }
      signal(signals, event.sequence, 'obligation', [
        id,
        ...(assay.obligationId ? [assay.obligationId] : []),
      ]);
      if (status === 'failed') {
        scars.push({
          id: `assay:${id}:${event.sequence}`,
          sequence: event.sequence,
          kind: 'assay_failure',
          subjectId: id,
          summary,
        });
        signal(signals, event.sequence, 'scar', [
          id,
          ...(assay.candidateId ? [assay.candidateId] : []),
        ]);
      }
      continue;
    }

    if (event.kind === 'action.status' || event.kind === 'stage.status') {
      const status = text(payload.status);
      if (status === 'failed') {
        const id =
          text(
            event.kind === 'action.status' ? payload.actionId : payload.stage,
          ) ?? `${event.kind}:${event.sequence}`;
        scars.push({
          id: `${event.kind}:${id}:${event.sequence}`,
          sequence: event.sequence,
          kind:
            event.kind === 'action.status' ? 'action_failure' : 'stage_failure',
          subjectId: id,
          summary,
        });
        signal(signals, event.sequence, 'scar', [id]);
      }
    }

    if (event.kind === 'search.status') {
      const attempted = safeCounter(payload.attempted);
      const ceiling = text(payload.attemptSafetyCeiling);
      if (attempted === null) {
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: 'attempted',
        });
      } else if (latestAttempted !== null && attempted < latestAttempted) {
        diagnostics.push({
          code: 'COUNTER_REGRESSION',
          sequence: event.sequence,
          field: 'attempted',
        });
      } else {
        latestAttempted = attempted;
      }
      if (
        ceiling === null ||
        ceiling.length > 128 ||
        !/^[1-9][0-9]*$/u.test(ceiling)
      ) {
        diagnostics.push({
          code: 'PAYLOAD_INVALID',
          sequence: event.sequence,
          field: 'attemptSafetyCeiling',
        });
      } else if (
        latestAttemptCeiling !== null &&
        ceiling !== latestAttemptCeiling
      ) {
        diagnostics.push({
          code: 'RESOURCE_CEILING_DRIFT',
          sequence: event.sequence,
          field: 'attemptSafetyCeiling',
        });
      } else {
        latestAttemptCeiling = ceiling;
      }

      const validResourceNames: SearchResourceName[] = [];
      if (!Array.isArray(payload.resources)) {
        diagnostics.push({
          code: 'RESOURCE_INVALID',
          sequence: event.sequence,
          field: 'resources',
        });
      } else {
        const seen = new Set<SearchResourceName>();
        for (const item of payload.resources) {
          const sample = resourceSample(item, event.sequence, diagnostics);
          if (!sample) continue;
          if (seen.has(sample.name)) {
            diagnostics.push({
              code: 'RESOURCE_INVALID',
              sequence: event.sequence,
              field: `duplicate:${sample.name}`,
            });
            continue;
          }
          seen.add(sample.name);
          const originalCeiling = resourceCeilings.get(sample.name);
          if (
            originalCeiling !== undefined &&
            originalCeiling !== sample.ceiling
          ) {
            diagnostics.push({
              code: 'RESOURCE_CEILING_DRIFT',
              sequence: event.sequence,
              field: sample.name,
            });
            continue;
          }
          resourceCeilings.set(sample.name, sample.ceiling);
          const previous = resourceSamples.get(sample.name);
          if (
            previous !== undefined &&
            previous.used !== null &&
            sample.used !== null &&
            sample.used < previous.used
          ) {
            diagnostics.push({
              code: 'COUNTER_REGRESSION',
              sequence: event.sequence,
              field: sample.name,
            });
            continue;
          }
          resourceSamples.set(sample.name, sample);
          validResourceNames.push(sample.name);
        }
      }

      let nurseryDistinct: number | null = null;
      let nurseryYieldAge: number | null = null;
      let archiveEntries: number | null = null;
      let archiveNiches: number | null = null;
      let archiveNovelty: number | null = null;
      const nursery = record(payload.hypothesisNursery);
      if (nursery) {
        const previousScarCount = latestNursery?.scars ?? 0;
        const distinct = safeCounter(nursery.exactDistinctHypotheses);
        const scarCount = safeCounter(nursery.scars);
        const yieldAge = safeCounter(nursery.exactYieldAge);
        const labels = strictStringArray(nursery.declaredMechanismLabels);
        if (
          distinct === null ||
          scarCount === null ||
          yieldAge === null ||
          labels === null
        ) {
          diagnostics.push({
            code: 'PAYLOAD_INVALID',
            sequence: event.sequence,
            field: 'hypothesisNursery',
          });
        } else if (
          latestNursery &&
          (distinct < latestNursery.distinct || scarCount < latestNursery.scars)
        ) {
          diagnostics.push({
            code: 'COUNTER_REGRESSION',
            sequence: event.sequence,
            field: 'hypothesisNursery',
          });
        } else {
          latestNursery = {
            distinct,
            scars: scarCount,
            labels,
            yieldAge,
            sequence: event.sequence,
          };
          nurseryDistinct = distinct;
          nurseryYieldAge = yieldAge;
          signal(signals, event.sequence, 'novelty', labels);
          if (scarCount > previousScarCount) {
            signal(signals, event.sequence, 'scar', [
              `anonymous-nursery:+${scarCount - previousScarCount}`,
            ]);
          }
        }
      }
      const archive = record(payload.assayArchive);
      if (archive) {
        const entries = safeCounter(archive.measuredEntries);
        const niches = safeCounter(archive.occupiedNiches);
        const novelty =
          archive.lastMeasuredNovelty === undefined
            ? null
            : finiteNonNegative(archive.lastMeasuredNovelty);
        if (
          entries === null ||
          niches === null ||
          (novelty !== null && novelty > 1)
        ) {
          diagnostics.push({
            code: 'PAYLOAD_INVALID',
            sequence: event.sequence,
            field: 'assayArchive',
          });
        } else if (
          latestArchive &&
          (entries < latestArchive.entries || niches < latestArchive.niches)
        ) {
          diagnostics.push({
            code: 'COUNTER_REGRESSION',
            sequence: event.sequence,
            field: 'assayArchive',
          });
        } else {
          latestArchive = {
            entries,
            niches,
            novelty,
            sequence: event.sequence,
          };
          archiveEntries = entries;
          archiveNiches = niches;
          archiveNovelty = novelty;
          signal(signals, event.sequence, 'novelty', ['assay-archive']);
        }
      }
      noveltySamples.push({
        sequence: event.sequence,
        exactDistinctHypotheses: nurseryDistinct,
        exactYieldAge: nurseryYieldAge,
        measuredEntries: archiveEntries,
        occupiedNiches: archiveNiches,
        lastMeasuredNovelty: archiveNovelty,
      });
      const termination = text(payload.termination) as NonNullable<
        TerminationModel['searchCause']
      > | null;
      if (termination !== null) {
        if (SEARCH_TERMINATIONS.has(termination)) {
          searchTerminations.push({
            cause: termination,
            sequence: event.sequence,
          });
          signal(signals, event.sequence, 'termination', [termination]);
        } else {
          diagnostics.push({
            code: 'PAYLOAD_INVALID',
            sequence: event.sequence,
            field: 'termination',
          });
        }
      }
      signal(signals, event.sequence, 'resource', validResourceNames);
    }

    if (isTerminationAnnouncement(event)) {
      announcedSequence ??= event.sequence;
      signal(signals, event.sequence, 'termination', ['announced']);
    }
    if (isCompletedTerminalEvent(event)) {
      completedSequence ??= event.sequence;
      signal(signals, event.sequence, 'termination', ['completed']);
    }
    if (event.kind === 'kernel.status' && payload.operation === 'signed') {
      signedSequence ??= event.sequence;
      signal(signals, event.sequence, 'termination', ['signed']);
    }
  }

  const cyclic = cyclicCandidateIds(candidates);
  for (const id of [...cyclic].sort())
    diagnostics.push({ code: 'GENEALOGY_CYCLE', field: id });
  const generationMemo = new Map<string, number | null>();
  const genealogy: GenealogyEdge[] = [];
  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    for (const parentId of candidate.parents ?? []) {
      genealogy.push({
        parentId,
        childId: candidate.id,
        declaredAtSequence:
          candidate.parentDeclarationSequence ?? candidate.firstSequence,
        parentKnown: candidates.has(parentId),
      });
    }
  }
  genealogy.sort(
    (left, right) =>
      left.parentId.localeCompare(right.parentId) ||
      left.childId.localeCompare(right.childId) ||
      left.declaredAtSequence - right.declaredAtSequence,
  );

  const assayList = [...assays.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const candidateList: CandidateMorphology[] = [...candidates.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => {
      const parentDisclosure = candidate.parentConflict
        ? 'conflicted'
        : candidate.parents === undefined
          ? 'undisclosed'
          : 'declared';
      const hasMissingParent =
        candidate.parents?.some((parent) => !candidates.has(parent)) ?? false;
      const genealogyState: CandidateMorphology['genealogyState'] = cyclic.has(
        candidate.id,
      )
        ? 'cyclic'
        : candidate.parentConflict || hasMissingParent
          ? 'partial'
          : candidate.parents === undefined
            ? 'undisclosed'
            : candidate.parents.length === 0
              ? 'root'
              : 'descendant';
      return {
        id: candidate.id,
        firstSequence: candidate.firstSequence,
        lastSequence: candidate.lastSequence,
        currentStatus: candidate.statusHistory.at(-1)?.status ?? 'referenced',
        statusHistory: candidate.statusHistory,
        parentIds: candidate.parents ?? [],
        parentDisclosure,
        generation: generationFor(
          candidate.id,
          candidates,
          cyclic,
          generationMemo,
        ),
        genealogyState,
        actorIds: [...candidate.actors].sort(),
        claimIds: [...candidate.claims].sort(),
        assayIds: [...candidate.assays].sort(),
        artifactDigests: [...candidate.artifacts].sort(),
        feasibility: candidate.feasibility,
      };
    });

  const lineageRoots = new Map<string, Set<string>>();
  const cycleRootByCandidate = cycleRepresentatives(candidates, cyclic);
  const rootsMemo = new Map<string, Set<string>>();
  for (const candidate of candidateList) {
    for (const root of lineageRootsFor(
      candidate.id,
      candidates,
      cyclic,
      cycleRootByCandidate,
      rootsMemo,
    )) {
      const members = lineageRoots.get(root) ?? new Set<string>();
      members.add(candidate.id);
      lineageRoots.set(root, members);
    }
  }
  const candidateById = new Map(
    candidateList.map((candidate) => [candidate.id, candidate]),
  );
  const lineages: CandidateLineage[] = [...lineageRoots.entries()]
    .map(([encodedRoot, memberSet]) => {
      const separator = encodedRoot.indexOf(':');
      const rootKind = encodedRoot.slice(
        0,
        separator,
      ) as CandidateLineage['rootKind'];
      const rootId = encodedRoot.slice(separator + 1);
      const members = [...memberSet].sort();
      const memberModels = members
        .map((id) => candidateById.get(id))
        .filter((item): item is CandidateMorphology => item !== undefined);
      const root = candidateById.get(rootId);
      const rootCertainty: CandidateLineage['rootCertainty'] =
        rootKind === 'cycle'
          ? 'cyclic'
          : rootKind === 'external'
            ? 'partial'
            : root?.parentDisclosure === 'undisclosed'
              ? 'undisclosed'
              : 'declared';
      return {
        id: `lineage:${encodedRoot}`,
        rootId,
        rootKind,
        rootCertainty,
        candidateIds: members,
        terminalCandidateIds: memberModels
          .filter((candidate) =>
            ['survived', 'invalidated'].includes(candidate.currentStatus),
          )
          .map((candidate) => candidate.id)
          .sort(),
        scarredCandidateIds: memberModels
          .filter((candidate) => candidate.currentStatus === 'invalidated')
          .map((candidate) => candidate.id)
          .sort(),
        firstSequence: Math.min(
          ...memberModels.map((candidate) => candidate.firstSequence),
        ),
        lastSequence: Math.max(
          ...memberModels.map((candidate) => candidate.lastSequence),
        ),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const evidenceList = [...evidence.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const knownTargets = new Set<string>([
    ...claimIds,
    ...obligations.keys(),
    ...candidates.keys(),
  ]);
  const evidenceRelations: EvidenceRelation[] = evidenceList
    .flatMap((node) => [
      ...node.supports.map((targetId) => ({
        kind: 'supports' as const,
        evidenceId: node.id,
        targetId,
        sequence: node.sequence,
        authority: node.authority,
        targetKnown: knownTargets.has(targetId),
      })),
      ...node.refutes.map((targetId) => ({
        kind: 'refutes' as const,
        evidenceId: node.id,
        targetId,
        sequence: node.sequence,
        authority: node.authority,
        targetKnown: knownTargets.has(targetId),
      })),
    ])
    .sort(
      (left, right) =>
        left.evidenceId.localeCompare(right.evidenceId) ||
        left.kind.localeCompare(right.kind) ||
        left.targetId.localeCompare(right.targetId),
    );
  for (const relation of evidenceRelations) {
    const obligation = obligations.get(relation.targetId);
    if (!obligation) continue;
    if (relation.kind === 'supports')
      obligation.supports.add(relation.evidenceId);
    else obligation.refutes.add(relation.evidenceId);
    obligation.lastSequence = Math.max(
      obligation.lastSequence,
      relation.sequence,
    );
  }

  const assayModels: AssayMorphology[] = assayList.map((assay) => ({
    id: assay.id,
    candidateId: assay.candidateId,
    obligationId: assay.obligationId,
    critical: assay.critical,
    status: assay.status,
    evidenceIds: [...assay.evidenceIds].sort(),
    firstSequence: assay.firstSequence,
    lastSequence: assay.lastSequence,
    summary: assay.summary,
  }));
  const obligationModels: ObligationMorphology[] = [...obligations.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((obligation) => {
      const linkedAssays = [...obligation.assays]
        .map((id) => assays.get(id))
        .filter((assay): assay is MutableAssay => assay !== undefined);
      const resolution = obligationResolution(linkedAssays);
      return {
        id: obligation.id,
        statement: obligation.statement,
        source: obligation.source,
        critical: obligation.critical,
        resolution,
        unresolved: !['passed', 'failed'].includes(resolution),
        assayIds: [...obligation.assays].sort(),
        supportingEvidenceIds: [...obligation.supports].sort(),
        refutingEvidenceIds: [...obligation.refutes].sort(),
        firstSequence: obligation.firstSequence,
        lastSequence: obligation.lastSequence,
      };
    });

  const pressures: ResourcePressure[] = SEARCH_RESOURCE_NAMES.map((name) => {
    const sample = resourceSamples.get(name);
    if (!sample) {
      return {
        name,
        used: null,
        ceiling: null,
        measurement: 'MISSING',
        pressure: null,
        overrun: false,
        observedAtSequence: null,
      };
    }
    const overrun = sample.used !== null && sample.used > sample.ceiling;
    const pressure =
      sample.used === null
        ? null
        : sample.ceiling === 0
          ? sample.used === 0
            ? 0
            : 1
          : Math.min(1, sample.used / sample.ceiling);
    return {
      name,
      used: sample.used,
      ceiling: sample.ceiling,
      measurement: sample.measurement,
      pressure,
      overrun,
      observedAtSequence: sample.sequence,
    };
  });
  const maximumKnownPressure = pressures.reduce<number | null>(
    (maximum, resource) =>
      resource.pressure === null
        ? maximum
        : maximum === null
          ? resource.pressure
          : Math.max(maximum, resource.pressure),
    null,
  );
  const dominantResourceNames =
    maximumKnownPressure === null
      ? []
      : pressures
          .filter((resource) => resource.pressure === maximumKnownPressure)
          .map((resource) => resource.name)
          .sort();
  const dominantMeasurements = new Set(
    pressures
      .filter((resource) => dominantResourceNames.includes(resource.name))
      .map((resource) => resource.measurement)
      .filter(
        (measurement): measurement is 'MEASURED' | 'UPPER_BOUND' =>
          measurement === 'MEASURED' || measurement === 'UPPER_BOUND',
      ),
  );
  const maximumKnownPressureMeasurement =
    dominantMeasurements.size === 0
      ? null
      : dominantMeasurements.size > 1
        ? 'MIXED'
        : ([...dominantMeasurements][0] ?? null);

  let guardReached: boolean | null = null;
  if (latestAttempted !== null && latestAttemptCeiling !== null) {
    try {
      guardReached = BigInt(latestAttempted) >= BigInt(latestAttemptCeiling);
    } catch {
      guardReached = null;
    }
  }

  const uniqueTerminationCauses = [
    ...new Set(searchTerminations.map((entry) => entry.cause)),
  ];
  if (uniqueTerminationCauses.length > 1)
    diagnostics.push({ code: 'TERMINATION_CONFLICT' });
  const lastTermination = searchTerminations.at(-1);
  const termination: TerminationModel = {
    searchCause:
      uniqueTerminationCauses.length <= 1
        ? (lastTermination?.cause ?? null)
        : null,
    searchCauseSequence:
      uniqueTerminationCauses.length <= 1
        ? (lastTermination?.sequence ?? null)
        : null,
    searchCauseConflicted: uniqueTerminationCauses.length > 1,
    announcedSequence,
    completedSequence,
  };

  const terminal = completedSequence !== null;
  const continuityIntegrity =
    continuity.state === 'broken'
      ? 'violated'
      : continuity.state === 'continuous'
        ? 'intact'
        : 'unverifiable';
  const stillnessState: StillnessModel['state'] = terminal
    ? 'terminal'
    : continuity.state === 'broken'
      ? 'ruptured'
      : announcedSequence !== null
        ? 'termination_announced'
        : accepted.length === 0
          ? 'dormant'
          : 'live';

  const diagnosticsSorted = diagnostics.sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.code.localeCompare(right.code) ||
      (left.field ?? '').localeCompare(right.field ?? ''),
  );
  const signalsSorted = signals.sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.channel.localeCompare(right.channel) ||
      stableSerialize(left.entityIds).localeCompare(
        stableSerialize(right.entityIds),
      ),
  );

  return {
    protocol: MORPHOLOGY_PROTOCOL,
    cursor: continuity.acceptedThrough,
    continuity,
    candidates: candidateList,
    genealogy,
    lineages,
    evidence: evidenceList,
    evidenceRelations,
    assays: assayModels,
    obligations: obligationModels,
    unresolvedObligationIds: obligationModels
      .filter((obligation) => obligation.unresolved)
      .map((obligation) => obligation.id),
    scars: scars.sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    ),
    scarBurden: {
      attributedCount: scars.length,
      anonymousNurseryCount: latestNursery?.scars ?? 0,
      minimumDistinctCount: Math.max(scars.length, latestNursery?.scars ?? 0),
    },
    resourcePressure: {
      resources: pressures,
      maximumKnownPressure,
      maximumKnownPressureMeasurement,
      dominantResourceNames,
      unmeteredResourceNames: pressures
        .filter(
          (resource) =>
            resource.measurement === 'DECLARED_ONLY' ||
            resource.measurement === 'MISSING',
        )
        .map((resource) => resource.name),
      hasOverrun: pressures.some((resource) => resource.overrun),
    },
    searchGuard: {
      attempted: latestAttempted,
      attemptSafetyCeiling: latestAttemptCeiling,
      reached: guardReached,
      safetyGuardOnly: true,
    },
    novelty: {
      exactContent: {
        distinctHypotheses: latestNursery?.distinct ?? null,
        yieldAge: latestNursery?.yieldAge ?? null,
        declaredMechanismLabels: latestNursery?.labels ?? [],
        state:
          latestNursery === null
            ? 'unavailable'
            : latestNursery.distinct === 0
              ? 'empty'
              : latestNursery.yieldAge === 0
                ? 'yielding'
                : 'aging',
      },
      assayArchive: {
        measuredEntries: latestArchive?.entries ?? null,
        occupiedNiches: latestArchive?.niches ?? null,
        lastMeasuredNovelty: latestArchive?.novelty ?? null,
        state:
          latestArchive === null
            ? 'unavailable'
            : latestArchive.entries === 0
              ? 'empty'
              : latestArchive.novelty === null
                ? 'admitted_unscored'
                : latestArchive.novelty > 0
                  ? 'novel'
                  : 'not_novel',
      },
      semanticInferenceFromExactCounts: 'forbidden',
      samples: noveltySamples,
    },
    termination,
    stillness: {
      state: stillnessState,
      motion: terminal
        ? 'arrested'
        : accepted.length === 0
          ? 'none'
          : 'event_driven',
      terminal,
      terminalSequence: completedSequence,
      signed: signedSequence !== null,
      signedSequence,
      signedBeforeTermination:
        signedSequence !== null &&
        completedSequence !== null &&
        signedSequence < completedSequence,
      integrity: continuityIntegrity,
    },
    signals: signalsSorted,
    diagnostics: diagnosticsSorted,
  };
}
