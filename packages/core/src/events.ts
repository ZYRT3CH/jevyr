import {
  EVENT_PROTOCOL,
  LIFECYCLE_STAGES,
  canonicalize,
  digestJson,
  validateCaseEventShape,
  type CaseEvent,
  type EventKind,
  type EventPayloadByKind,
  type JsonValue,
  type LifecycleStage,
  type PublicActor,
} from "@jevyr/protocol";

export interface EventDraft<K extends EventKind = EventKind> {
  caseDigest: string;
  runDigest: string;
  observedAt: string;
  stage: LifecycleStage;
  kind: K;
  actor: PublicActor;
  payload: EventPayloadByKind[K];
}

export interface ChainProblem {
  sequence: number;
  code: string;
  message: string;
}

export interface ChainVerification {
  valid: boolean;
  headDigest: string | null;
  problems: readonly ChainProblem[];
}

const FORBIDDEN_TRACE_KEYS = new Set([
  "chainofthought",
  "chain_of_thought",
  "reasoningtrace",
  "reasoning_trace",
  "scratchpad",
  "hiddenstate",
  "hidden_state",
  "internalthoughts",
  "internal_thoughts",
]);

function containsForbiddenTraceKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenTraceKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    FORBIDDEN_TRACE_KEYS.has(key.toLowerCase()) || containsForbiddenTraceKey(child),
  );
}

function digestableEvent(event: Omit<CaseEvent, "eventDigest">): JsonValue {
  return event as unknown as JsonValue;
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotJson<T>(value: T): T {
  return JSON.parse(canonicalize(value as unknown as JsonValue)) as T;
}

export function createCaseEvent<K extends EventKind>(draft: EventDraft<K>, sequence: number, priorDigest: string | null): CaseEvent<K> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError("Event sequence must be a positive safe integer");
  const candidate = {
    protocol: EVENT_PROTOCOL,
    caseDigest: draft.caseDigest,
    runDigest: draft.runDigest,
    sequence,
    priorDigest,
    observedAt: draft.observedAt,
    stage: draft.stage,
    kind: draft.kind,
    actor: draft.actor,
    payload: draft.payload,
  } as unknown as Omit<CaseEvent<K>, "eventDigest">;

  // Canonicalize before traversing caller-owned values. This rejects accessors,
  // symbols, sparse arrays, exotic prototypes, and other active/non-JSON
  // objects without invoking their code. Parsing the canonical bytes also
  // severs every caller reference, so later mutation cannot alter the cached
  // event after its digest has been committed.
  const unsigned = snapshotJson(candidate) as Omit<CaseEvent<K>, "eventDigest">;
  if (containsForbiddenTraceKey(unsigned.payload)) throw new TypeError("Public events may not contain hidden reasoning traces");
  const eventDigest = digestJson(digestableEvent(unsigned as Omit<CaseEvent, "eventDigest">));
  const event = deepFreezeJson({ ...unsigned, eventDigest }) as CaseEvent<K>;
  const validation = validateCaseEventShape(event);
  if (!validation.ok) {
    throw new TypeError(`Invalid public event: ${validation.problems.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  }
  return event;
}

export function recomputeEventDigest(event: CaseEvent): string {
  const snapshot = snapshotJson(event);
  const { eventDigest: _ignored, ...unsigned } = snapshot;
  return digestJson(digestableEvent(unsigned as Omit<CaseEvent, "eventDigest">));
}

export function verifyEventChain(events: readonly CaseEvent[]): ChainVerification {
  const problems: ChainProblem[] = [];
  let prior: string | null = null;
  let caseDigest: string | undefined;
  let runDigest: string | undefined;
  let lastStageIndex = -1;

  events.forEach((input, index) => {
    let event: CaseEvent;
    try {
      event = snapshotJson(input);
    } catch (error) {
      problems.push({
        sequence: index + 1,
        code: "invalid_event_value",
        message: `Event is not inert canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const shape = validateCaseEventShape(event);
    for (const entry of shape.problems) problems.push({ sequence: index, code: entry.code, message: `${entry.path}: ${entry.message}` });
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) problems.push({ sequence: event.sequence, code: "sequence_gap", message: `Expected sequence ${expectedSequence}, received ${event.sequence}` });
    if (event.priorDigest !== prior) problems.push({ sequence: index, code: "prior_mismatch", message: `Event does not reference the prior event digest` });
    if (event.eventDigest !== recomputeEventDigest(event)) problems.push({ sequence: index, code: "digest_mismatch", message: "Event content does not match eventDigest" });
    if (containsForbiddenTraceKey(event.payload)) problems.push({ sequence: index, code: "private_trace_exposed", message: "Event contains a forbidden hidden-reasoning field" });
    caseDigest ??= event.caseDigest;
    runDigest ??= event.runDigest;
    if (event.caseDigest !== caseDigest) problems.push({ sequence: index, code: "case_changed", message: "caseDigest changed inside one ledger" });
    if (event.runDigest !== runDigest) problems.push({ sequence: index, code: "run_changed", message: "runDigest changed inside one ledger" });
    const stageIndex = LIFECYCLE_STAGES.indexOf(event.stage);
    if (stageIndex < lastStageIndex) problems.push({ sequence: index, code: "stage_regression", message: `Lifecycle regressed from ${LIFECYCLE_STAGES[lastStageIndex]} to ${event.stage}` });
    lastStageIndex = Math.max(lastStageIndex, stageIndex);
    prior = event.eventDigest;
  });

  return { valid: problems.length === 0, headDigest: prior, problems };
}
