'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  JevyrClient,
  JevyrContinuityError,
  JevyrHttpError,
  type AuthenticatedTerminalRecord,
} from '@jevyr/sdk';
import {
  JevyrSubstrate,
  type JevyrPublicEvent,
} from '@/components/jevyr-substrate';
import {
  ChamberWorkspace,
  type CastOptions,
} from '@/components/chamber-workspace';
import { deriveEventMorphology } from '@/lib/event-morphology';
import { defaultDaemonOrigin } from '@/lib/daemon-origin';

type StreamMode =
  | 'quiet'
  | 'connecting'
  | 'live'
  | 'polling'
  | 'specimen'
  | 'ended';

type AuthenticityState =
  | 'unbound'
  | 'verifying-seal'
  | 'seal-verified'
  | 'verifying-closure'
  | 'closure-authenticated'
  | 'refused'
  | 'specimen';

type WebToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input: unknown): unknown;
};

type ModelDocument = Document & {
  modelContext?: {
    registerTool(
      tool: WebToolDefinition,
      options?: { signal?: AbortSignal },
    ): void | Promise<void>;
  };
};

const API_BASE = defaultDaemonOrigin();

const JEVYR = new JevyrClient({ baseUrl: API_BASE });
const OBSERVER_RETRY_BASE_MS = 1500;
const OBSERVER_RETRY_CEILING_MS = 15_000;

function retryableObserverError(error: unknown, recordMayBePending = false) {
  if (error instanceof JevyrContinuityError) return false;
  if (!(error instanceof JevyrHttpError)) return true;
  if (recordMayBePending && error.status === 409) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function observerBackoff(failures: number) {
  return Math.min(
    OBSERVER_RETRY_CEILING_MS,
    OBSERVER_RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, failures - 1)),
  );
}

function observerDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(finish, milliseconds);
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

const STAGES = [
  ['CAST', 'Cast'],
  ['SNAPSHOT', 'Snapshot'],
  ['SEAL', 'Seal'],
  ['SELF_SCAN', 'Self-scan'],
  ['INTERPRET', 'Interpret'],
  ['DIVERGE', 'Diverge'],
  ['RECOMBINE', 'Recombine'],
  ['EMBODY', 'Embody'],
  ['CHALLENGE', 'Challenge'],
  ['ASSAY', 'Assay'],
  ['REFLEX', 'Reflex'],
  ['CRYSTALLIZE', 'Crystallize'],
  ['SIGN', 'Sign'],
  ['MEMORY_TRIBUNAL', 'Memory tribunal'],
  ['TERMINATE', 'Terminate'],
] as const;

const SPECIMEN_DIGEST_A = `sha256:${'a'.repeat(64)}`;
const SPECIMEN_DIGEST_B = `sha256:${'b'.repeat(64)}`;
const SPECIMEN_DIGEST_C = `sha256:${'c'.repeat(64)}`;

const SPECIMEN_EVENTS: Omit<JevyrPublicEvent, 'sequence'>[] = [
  {
    kind: 'stage.status',
    stage: 'CAST',
    summary: 'One sentence entered. Nothing can revise it.',
    status: 'completed',
    payload: {
      stage: 'CAST',
      status: 'completed',
      summary: 'One sentence entered. Nothing can revise it.',
    },
  },
  {
    kind: 'stage.status',
    stage: 'SNAPSHOT',
    summary: 'The subject became immutable material.',
    status: 'completed',
    payload: {
      stage: 'SNAPSHOT',
      status: 'completed',
      summary: 'The subject became immutable material.',
    },
  },
  {
    kind: 'claim.published',
    stage: 'SEAL',
    summary: 'The result must survive its own adversarial assay.',
    status: 'completed',
    payload: {
      claimId: 'obligation:self-opposition',
      claimType: 'requirement',
      statement: 'The result must survive its own adversarial assay.',
      summary: 'The result must survive its own adversarial assay.',
    },
  },
  {
    kind: 'stage.status',
    stage: 'SEAL',
    summary: 'Ingress closed; watching cannot steer the Case.',
    status: 'completed',
    payload: {
      stage: 'SEAL',
      status: 'completed',
      summary: 'Ingress closed; watching cannot steer the Case.',
    },
  },
  {
    kind: 'stage.status',
    stage: 'SELF_SCAN',
    summary: 'Its available senses and absent senses were counted.',
    status: 'completed',
    payload: {
      stage: 'SELF_SCAN',
      status: 'completed',
      summary: 'Its available senses and absent senses were counted.',
    },
  },
  {
    kind: 'search.status',
    stage: 'DIVERGE',
    summary: 'Three exact hypotheses entered two incompatible mechanisms.',
    status: 'progress',
    payload: {
      status: 'exploring',
      attempted: 9,
      attemptSafetyCeiling: '1500000000000000000000',
      resources: [
        {
          name: 'mindInvocations',
          used: 5,
          ceiling: 80,
          measurement: 'MEASURED',
        },
        {
          name: 'generatedBytes',
          used: 91000,
          ceiling: 900000,
          measurement: 'MEASURED',
        },
        {
          name: 'forgeWallMillis',
          used: 0,
          ceiling: 90000,
          measurement: 'MEASURED',
        },
        {
          name: 'memorySeconds',
          used: null,
          ceiling: 420,
          measurement: 'DECLARED_ONLY',
        },
      ],
      hypothesisNursery: {
        exactDistinctHypotheses: 3,
        scars: 0,
        exactYieldAge: 0,
        declaredMechanismLabels: [
          'reciprocal-validator',
          'sealed-counterworld',
        ],
      },
      assayArchive: {
        measuredEntries: 0,
        occupiedNiches: 0,
      },
    },
  },
  {
    kind: 'candidate.status',
    stage: 'DIVERGE',
    summary: 'A validator that can rewrite its own test boundary.',
    status: 'started',
    actor: { id: 'mind:basalt', kind: 'mind' },
    payload: {
      candidateId: 'candidate:basalt',
      status: 'proposed',
      parentIds: [],
      summary: 'A validator that can rewrite its own test boundary.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'DIVERGE',
    summary: 'A consensus mirror failed: agreement could impersonate truth.',
    status: 'failed',
    actor: { id: 'mind:silt', kind: 'mind' },
    payload: {
      candidateId: 'candidate:mirror',
      status: 'invalidated',
      parentIds: [],
      summary: 'A consensus mirror failed: agreement could impersonate truth.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'RECOMBINE',
    summary: 'A child inherited the boundary, not the answer.',
    status: 'started',
    actor: { id: 'mind:weir', kind: 'mind' },
    payload: {
      candidateId: 'candidate:weir',
      status: 'proposed',
      parentIds: ['candidate:basalt'],
      summary: 'A child inherited the boundary, not the answer.',
    },
  },
  {
    kind: 'search.status',
    stage: 'RECOMBINE',
    summary: 'The nursery grew while its first failure remained a wound.',
    status: 'progress',
    payload: {
      status: 'hypothesis_admitted',
      attempted: 41,
      attemptSafetyCeiling: '1500000000000000000000',
      resources: [
        {
          name: 'mindInvocations',
          used: 17,
          ceiling: 80,
          measurement: 'MEASURED',
        },
        {
          name: 'generatedBytes',
          used: 318000,
          ceiling: 900000,
          measurement: 'MEASURED',
        },
        {
          name: 'forgeWallMillis',
          used: 0,
          ceiling: 90000,
          measurement: 'MEASURED',
        },
        {
          name: 'memorySeconds',
          used: null,
          ceiling: 420,
          measurement: 'DECLARED_ONLY',
        },
      ],
      hypothesisNursery: {
        exactDistinctHypotheses: 4,
        scars: 1,
        exactYieldAge: 0,
        declaredMechanismLabels: [
          'reciprocal-validator',
          'sealed-counterworld',
          'boundary-inheritance',
        ],
      },
      assayArchive: {
        measuredEntries: 0,
        occupiedNiches: 0,
      },
    },
  },
  {
    kind: 'candidate.status',
    stage: 'EMBODY',
    summary: 'The parent acquired mass in its own disposable Forge root.',
    status: 'completed',
    payload: {
      candidateId: 'candidate:basalt',
      status: 'embodied',
      parentIds: [],
      artifactDigests: [SPECIMEN_DIGEST_B],
      summary: 'The parent acquired mass in its own disposable Forge root.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'EMBODY',
    summary: 'A disposable artifact acquired mass inside the Forge.',
    status: 'completed',
    payload: {
      candidateId: 'candidate:weir',
      status: 'embodied',
      parentIds: ['candidate:basalt'],
      artifactDigests: [SPECIMEN_DIGEST_A],
      summary: 'A disposable artifact acquired mass inside the Forge.',
    },
  },
  {
    kind: 'evidence.observed',
    stage: 'CHALLENGE',
    summary: 'The sealed subject contradicted one inherited assumption.',
    status: 'completed',
    payload: {
      evidenceId: 'evidence:snapshot-contradiction',
      evidenceType: 'subject_snapshot',
      contentDigest: SPECIMEN_DIGEST_B,
      supports: [],
      refutes: ['candidate:basalt'],
      summary: 'The sealed subject contradicted one inherited assumption.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: 'The parent entered the same sealed opposition assay.',
    status: 'started',
    payload: {
      assayId: 'assay:basalt:self-opposition',
      candidateId: 'candidate:basalt',
      obligationId: 'obligation:self-opposition',
      critical: false,
      status: 'planned',
      evidenceIds: [],
      summary: 'The parent entered the same sealed opposition assay.',
    },
  },
  {
    kind: 'evidence.observed',
    stage: 'ASSAY',
    summary: 'Its isolated execution exposed a boundary it could rewrite.',
    status: 'completed',
    payload: {
      evidenceId: 'evidence:basalt-forge',
      evidenceType: 'sandbox_execution',
      contentDigest: SPECIMEN_DIGEST_B,
      candidateId: 'candidate:basalt',
      assayId: 'assay:basalt:self-opposition',
      supports: [],
      refutes: [],
      summary: 'Its isolated execution exposed a boundary it could rewrite.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: 'The parent failed comparative archive admission.',
    status: 'failed',
    payload: {
      assayId: 'assay:basalt:self-opposition',
      candidateId: 'candidate:basalt',
      obligationId: 'obligation:self-opposition',
      critical: false,
      status: 'failed',
      evidenceIds: ['evidence:basalt-forge'],
      summary: 'The parent failed comparative archive admission.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'ASSAY',
    summary:
      'The closed archive retained the failure as a scar, not a survivor.',
    status: 'failed',
    payload: {
      candidateId: 'candidate:basalt',
      status: 'invalidated',
      parentIds: [],
      feasibility: 'CONTRADICTED',
      summary:
        'The closed archive retained the failure as a scar, not a survivor.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: 'A deterministic assay was attached to the sealed obligation.',
    status: 'started',
    payload: {
      assayId: 'assay:weir:self-opposition',
      candidateId: 'candidate:weir',
      obligationId: 'obligation:self-opposition',
      critical: false,
      status: 'planned',
      evidenceIds: [],
      summary: 'A deterministic assay was attached to the sealed obligation.',
    },
  },
  {
    kind: 'evidence.observed',
    stage: 'ASSAY',
    summary: 'A mind reported confidence; it remained non-authoritative.',
    status: 'completed',
    payload: {
      evidenceId: 'evidence:model-confidence',
      evidenceType: 'model_report',
      contentDigest: SPECIMEN_DIGEST_C,
      candidateId: 'candidate:weir',
      assayId: 'assay:weir:self-opposition',
      supports: [],
      refutes: [],
      summary: 'A mind reported confidence; it remained non-authoritative.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: "The Forge began the assay without accepting the model's vote.",
    status: 'progress',
    payload: {
      assayId: 'assay:weir:self-opposition',
      candidateId: 'candidate:weir',
      obligationId: 'obligation:self-opposition',
      critical: false,
      status: 'running',
      evidenceIds: ['evidence:model-confidence'],
      summary: "The Forge began the assay without accepting the model's vote.",
    },
  },
  {
    kind: 'evidence.observed',
    stage: 'ASSAY',
    summary: 'Sandbox execution supplied the first verdict-capable evidence.',
    status: 'completed',
    payload: {
      evidenceId: 'evidence:forge-execution',
      evidenceType: 'sandbox_execution',
      contentDigest: SPECIMEN_DIGEST_A,
      candidateId: 'candidate:weir',
      assayId: 'assay:weir:self-opposition',
      supports: [],
      refutes: [],
      summary: 'Sandbox execution supplied the first verdict-capable evidence.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: 'The child passed comparison; the obligation remained untouched.',
    status: 'completed',
    payload: {
      assayId: 'assay:weir:self-opposition',
      candidateId: 'candidate:weir',
      obligationId: 'obligation:self-opposition',
      critical: false,
      status: 'passed',
      evidenceIds: ['evidence:forge-execution'],
      summary:
        'The child passed comparison; the obligation remained untouched.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'ASSAY',
    summary: 'The closed measured archive retained the embodied child.',
    status: 'completed',
    payload: {
      candidateId: 'candidate:weir',
      status: 'survived',
      parentIds: ['candidate:basalt'],
      artifactDigests: [SPECIMEN_DIGEST_A],
      summary: 'The closed measured archive retained the embodied child.',
    },
  },
  {
    kind: 'candidate.status',
    stage: 'ASSAY',
    summary: 'Only now did the Pareto order name the child as flagship.',
    status: 'completed',
    payload: {
      candidateId: 'candidate:weir',
      status: 'selected',
      parentIds: ['candidate:basalt'],
      artifactDigests: [SPECIMEN_DIGEST_A],
      summary: 'Only now did the Pareto order name the child as flagship.',
    },
  },
  {
    kind: 'evidence.observed',
    stage: 'ASSAY',
    summary:
      'Selected-candidate evidence was finally allowed to touch the obligation.',
    status: 'completed',
    payload: {
      evidenceId: 'evidence:weir-adjudicative',
      evidenceType: 'sandbox_execution',
      contentDigest: SPECIMEN_DIGEST_A,
      candidateId: 'candidate:weir',
      assayId: 'assay:weir:self-opposition',
      supports: ['obligation:self-opposition'],
      refutes: [],
      summary:
        'Selected-candidate evidence was finally allowed to touch the obligation.',
    },
  },
  {
    kind: 'assay.status',
    stage: 'ASSAY',
    summary: 'The selected obligation passed on typed Forge evidence.',
    status: 'completed',
    payload: {
      assayId: 'assay:weir:self-opposition',
      candidateId: 'candidate:weir',
      obligationId: 'obligation:self-opposition',
      critical: true,
      status: 'passed',
      evidenceIds: ['evidence:weir-adjudicative'],
      summary: 'The selected obligation passed on typed Forge evidence.',
    },
  },
  {
    kind: 'stage.status',
    stage: 'REFLEX',
    summary:
      'The judge attacked its evidence boundary and found no leaked vote.',
    status: 'completed',
    payload: {
      stage: 'REFLEX',
      status: 'completed',
      summary:
        'The judge attacked its evidence boundary and found no leaked vote.',
    },
  },
  {
    kind: 'search.status',
    stage: 'CRYSTALLIZE',
    summary: 'Search stopped from saturation, not from the attempt guard.',
    status: 'completed',
    payload: {
      status: 'terminated',
      attempted: 144,
      attemptSafetyCeiling: '1500000000000000000000',
      termination: 'HYPOTHESIS_SATURATED',
      resources: [
        {
          name: 'mindInvocations',
          used: 63,
          ceiling: 80,
          measurement: 'MEASURED',
        },
        {
          name: 'generatedBytes',
          used: 801000,
          ceiling: 900000,
          measurement: 'MEASURED',
        },
        {
          name: 'forgeWallMillis',
          used: 68000,
          ceiling: 90000,
          measurement: 'MEASURED',
        },
        {
          name: 'memorySeconds',
          used: null,
          ceiling: 420,
          measurement: 'DECLARED_ONLY',
        },
      ],
      hypothesisNursery: {
        exactDistinctHypotheses: 4,
        scars: 1,
        exactYieldAge: 7,
        declaredMechanismLabels: [
          'reciprocal-validator',
          'sealed-counterworld',
          'boundary-inheritance',
        ],
      },
      assayArchive: {
        measuredEntries: 1,
        occupiedNiches: 1,
        lastMeasuredNovelty: 0.43,
      },
    },
  },
  {
    kind: 'kernel.status',
    stage: 'SIGN',
    summary: 'A local signature fused the Record to this run.',
    status: 'completed',
    payload: {
      operation: 'signed',
      status: 'completed',
      summary: 'A local signature fused the Record to this run.',
    },
  },
  {
    kind: 'kernel.status',
    stage: 'TERMINATE',
    summary: 'Termination was announced; the final event had not yet arrived.',
    status: 'progress',
    payload: {
      operation: 'terminated',
      status: 'announced',
      summary:
        'Termination was announced; the final event had not yet arrived.',
    },
  },
  {
    kind: 'stage.status',
    stage: 'TERMINATE',
    summary: 'The Record left. This session can receive nothing else.',
    status: 'completed',
    payload: {
      stage: 'TERMINATE',
      status: 'completed',
      summary: 'The Record left. This session can receive nothing else.',
    },
  },
];

function normalizedStage(value?: string) {
  return value?.toUpperCase().replaceAll('-', '_').replaceAll('.', '_') ?? '';
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Value is not canonical JSON');
}

async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return (
    'sha256:' +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  );
}

function eventStatus(
  kind: string,
  payload: Record<string, unknown>,
): JevyrPublicEvent['status'] {
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (kind === 'stage.status') {
    if (status === 'entered') return 'started';
    if (status === 'working') return 'progress';
    if (status === 'failed') return 'failed';
    return 'completed';
  }
  if (kind === 'action.status') {
    if (status === 'requested' || status === 'started') return 'progress';
    if (status === 'failed' || status === 'denied') return 'failed';
    return 'completed';
  }
  if (kind === 'candidate.status') {
    if (status === 'proposed') return 'started';
    if (status === 'invalidated') return 'failed';
    return 'completed';
  }
  if (kind === 'assay.status') {
    if (status === 'planned') return 'started';
    if (status === 'running') return 'progress';
    if (status === 'failed' || status === 'blocked') return 'failed';
    return 'completed';
  }
  if (kind === 'search.status') {
    if (status === 'started') return 'started';
    if (
      status === 'exploring' ||
      status === 'hypothesis_admitted' ||
      status === 'archive_changed'
    )
      return 'progress';
    if (status === 'failed') return 'failed';
    return 'completed';
  }
  return 'completed';
}

async function normalizeEvent(
  value: unknown,
): Promise<JevyrPublicEvent | null> {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const eventFields = new Set([
    'protocol',
    'caseDigest',
    'runDigest',
    'sequence',
    'priorDigest',
    'eventDigest',
    'observedAt',
    'stage',
    'kind',
    'actor',
    'payload',
  ]);
  const payload =
    source.payload && typeof source.payload === 'object'
      ? (source.payload as Record<string, unknown>)
      : null;
  const actor =
    source.actor &&
    typeof source.actor === 'object' &&
    !Array.isArray(source.actor)
      ? (source.actor as Record<string, unknown>)
      : null;
  if (
    source.protocol !== 'jevyr.event/1' ||
    !Number.isSafeInteger(source.sequence) ||
    (source.sequence as number) < 1 ||
    typeof source.caseDigest !== 'string' ||
    typeof source.runDigest !== 'string' ||
    typeof source.eventDigest !== 'string' ||
    typeof source.observedAt !== 'string' ||
    typeof source.stage !== 'string' ||
    typeof source.kind !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.caseDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.runDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.eventDigest) ||
    Object.keys(source).some((key) => !eventFields.has(key)) ||
    !payload ||
    !actor ||
    typeof actor.id !== 'string' ||
    typeof actor.kind !== 'string'
  )
    return null;
  const { eventDigest, ...unsigned } = source;
  if ((await canonicalDigest(unsigned)) !== eventDigest) return null;
  const summary =
    typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.statement === 'string'
        ? payload.statement
        : source.kind;
  return {
    protocol: 'jevyr.event/1',
    caseDigest: source.caseDigest,
    runDigest: source.runDigest,
    sequence: source.sequence as number,
    priorDigest:
      source.priorDigest === null || typeof source.priorDigest === 'string'
        ? source.priorDigest
        : undefined,
    kind: source.kind,
    summary,
    stage: source.stage,
    eventDigest: source.eventDigest,
    observedAt: source.observedAt,
    payload,
    actor: {
      id: actor.id,
      kind: actor.kind,
      ...(typeof actor.instance === 'string'
        ? { instance: actor.instance }
        : {}),
    },
    status: eventStatus(source.kind, payload),
  };
}

function digestFragment(value?: string) {
  return value ? value.replace(/^sha256:/, '').slice(0, 14) : 'unbound';
}

function authenticityLabel(state: AuthenticityState, keyId?: string) {
  if (state === 'closure-authenticated')
    return `closure authenticated ${digestFragment(keyId)}`;
  if (state === 'seal-verified') return 'seal verified';
  if (state === 'verifying-closure') return 'verifying closure';
  if (state === 'verifying-seal') return 'verifying seal';
  if (state === 'refused') return 'trust refused';
  if (state === 'specimen') return 'unclaimed specimen';
  return 'not authenticated';
}

function terminalEvent(event: JevyrPublicEvent): boolean {
  const payload = event.payload;
  const payloadStage =
    typeof payload?.stage === 'string' ? payload.stage : (event.stage ?? '');
  return (
    (event.kind === 'stage.status' &&
      normalizedStage(payloadStage) === 'TERMINATE' &&
      payload?.status === 'completed') ||
    (event.kind === 'action.status' &&
      payload?.actionType === 'runtime.recovery.terminate-existing-record' &&
      payload?.status === 'completed')
  );
}

export default function JevyrChamber() {
  const [impulse, setImpulse] = useState('');
  const [sealed, setSealed] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [, setReceiptDigest] = useState<string>();
  const [outcome, setOutcome] = useState<AuthenticatedTerminalRecord>();
  const [events, setEvents] = useState<JevyrPublicEvent[]>([]);
  const [streamMode, setStreamMode] = useState<StreamMode>('quiet');
  const [authenticity, setAuthenticity] =
    useState<AuthenticityState>('unbound');
  const [verificationKeyId, setVerificationKeyId] = useState<string>();
  const [notice, setNotice] = useState('One thought may enter.');
  const [focusSequence, setFocusSequence] = useState<number>();
  const sequenceRef = useRef(0);
  const headDigestRef = useRef<string | null>(null);
  const caseDigestRef = useRef<string | undefined>(undefined);
  const runDigestRef = useRef<string | undefined>(undefined);
  const digestBySequenceRef = useRef(new Map<number, string | undefined>());
  const specimenTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const castClosedRef = useRef(false);
  const terminalRef = useRef(false);
  const authenticatedCaseDigestRef = useRef<string | undefined>(undefined);
  const closureAuthenticationStartedRef = useRef(false);
  const authenticationRefusedRef = useRef(false);

  const appendEvents = useCallback((incoming: JevyrPublicEvent[]) => {
    const accepted: JevyrPublicEvent[] = [];
    for (const event of [...incoming].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (event.sequence <= sequenceRef.current) {
        const known = digestBySequenceRef.current.get(event.sequence);
        if (known !== event.eventDigest)
          setNotice('A conflicting event was refused at the accepted cursor');
        continue;
      }
      if (event.sequence !== sequenceRef.current + 1) {
        setNotice('An event gap was refused · continuity waits at the cursor');
        break;
      }
      if (event.protocol === 'jevyr.event/1') {
        if (
          !event.caseDigest ||
          !event.runDigest ||
          !event.eventDigest ||
          (caseDigestRef.current &&
            event.caseDigest !== caseDigestRef.current) ||
          (runDigestRef.current && event.runDigest !== runDigestRef.current) ||
          (authenticatedCaseDigestRef.current &&
            event.caseDigest !== authenticatedCaseDigestRef.current) ||
          event.priorDigest !== headDigestRef.current
        ) {
          setNotice('A broken digest lineage was refused');
          break;
        }
        if (!caseDigestRef.current) {
          caseDigestRef.current = event.caseDigest;
          setReceiptDigest(event.caseDigest);
        }
        runDigestRef.current ??= event.runDigest;
        headDigestRef.current = event.eventDigest ?? null;
      }
      digestBySequenceRef.current.set(event.sequence, event.eventDigest);
      sequenceRef.current = event.sequence;
      accepted.push(event);
    }
    if (accepted.length === 0) return;
    if (accepted.some(terminalEvent)) {
      setNotice('Terminal event received · closing the exact ledger');
    }
    setEvents((current) => {
      const ledger = new Map(current.map((event) => [event.sequence, event]));
      for (const event of accepted) ledger.set(event.sequence, event);
      const ordered = [...ledger.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
      return ordered;
    });
  }, []);

  const beginSpecimen = useCallback(() => {
    if (specimenTimer.current) clearInterval(specimenTimer.current);
    castClosedRef.current = true;
    setStreamMode('specimen');
    setNotice('Anatomy specimen · the daemon is absent');
    setReceiptDigest(undefined);
    setAuthenticity('specimen');
    setVerificationKeyId(undefined);
    setEvents([]);
    terminalRef.current = false;
    authenticatedCaseDigestRef.current = undefined;
    closureAuthenticationStartedRef.current = false;
    sequenceRef.current = 0;
    headDigestRef.current = null;
    caseDigestRef.current = undefined;
    runDigestRef.current = undefined;
    digestBySequenceRef.current.clear();
    let cursor = 0;
    specimenTimer.current = setInterval(() => {
      const next = SPECIMEN_EVENTS[cursor];
      if (!next) {
        if (specimenTimer.current) clearInterval(specimenTimer.current);
        specimenTimer.current = null;
        setStreamMode('ended');
        setNotice('Specimen complete · no execution was claimed');
        return;
      }
      appendEvents([{ ...next, sequence: cursor + 1 }]);
      cursor += 1;
    }, 1500);
  }, [appendEvents]);

  const castImpulse = useCallback(
    async (text: string, options?: CastOptions) => {
      const trimmed = text.trim();
      if (!trimmed) throw new Error('The Cast cannot be empty.');
      if (sealed || castClosedRef.current)
        throw new Error('This Case is already sealed.');
      castClosedRef.current = true;
      setImpulse(trimmed);
      setSealed(true);
      setStreamMode('connecting');
      setNotice('The airlock is closing');
      try {
        const payload = await JEVYR.cast({
          protocol: 'jevyr.case/1',
          case: { impulse: trimmed, control: 'sovereign', ...options },
        });
        const nextCaseId = payload.caseId;
        setReceiptDigest(undefined);
        setAuthenticity('verifying-seal');
        setVerificationKeyId(undefined);
        authenticatedCaseDigestRef.current = undefined;
        closureAuthenticationStartedRef.current = false;
        setCaseId(nextCaseId);
        return nextCaseId;
      } catch (error) {
        // A lost response may follow successful acceptance. Never silently re-open
        // semantic input or claim non-execution on an ambiguous transport failure.
        const rejected =
          error instanceof JevyrHttpError &&
          [400, 413, 415, 422].includes(error.status);
        if (rejected) {
          castClosedRef.current = false;
          setSealed(false);
        }
        setStreamMode('quiet');
        setAuthenticity('unbound');
        setNotice(
          rejected
            ? 'The daemon rejected this input before sealing.'
            : 'Cast acknowledgement was lost. Acceptance is unknown; this page will not resubmit. Inspect the daemon before starting another case.',
        );
        throw error;
      }
    },
    [sealed],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parameters = new URLSearchParams(window.location.search);
    const requestedCase = parameters.get('case')?.trim();
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      if (parameters.get('specimen') === '1') {
        setImpulse(
          'Design a self-validating machine that refuses inherited answers.',
        );
        setSealed(true);
        beginSpecimen();
      } else if (requestedCase) {
        castClosedRef.current = true;
        setSealed(true);
        setAuthenticity('verifying-seal');
        setCaseId(requestedCase);
        setNotice('Reattaching at cursor zero');
      }
    });
    return () => {
      disposed = true;
    };
  }, [beginSpecimen]);

  useEffect(() => {
    return () => {
      if (specimenTimer.current) clearInterval(specimenTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    let disposed = false;

    async function observe() {
      setStreamMode('connecting');
      setNotice('Opening the digest-linked public live vessel');
      let failures = 0;
      while (!disposed && !terminalRef.current) {
        try {
          const cursor = sequenceRef.current;
          const cursorDigest = headDigestRef.current ?? undefined;
          for await (const frame of JEVYR.liveEvents(caseId as string, {
            cursor,
            ...(cursorDigest === undefined ? {} : { cursorDigest }),
            signal: controller.signal,
            preferSse: true,
            pollWaitMs: 15_000,
            maxSseFailures: 3,
          })) {
            if (disposed) return;
            failures = 0;
            const normalized = await normalizeEvent(frame.event);
            if (!normalized) {
              throw new JevyrContinuityError(
                'The SDK-verified event failed Chamber normalization',
              );
            }
            setStreamMode(frame.transport === 'sse' ? 'live' : 'polling');
            setNotice(
              frame.transport === 'sse'
                ? 'Digest-linked events are live'
                : 'Canonical cursor polling is live',
            );
            appendEvents([normalized]);
          }
          if (!disposed) {
            terminalRef.current = true;
            setStreamMode('ended');
            setAuthenticity((current) =>
              current === 'specimen' ? current : 'verifying-closure',
            );
            setNotice(
              'Terminal ledger received · authenticating exact closure',
            );
          }
          return;
        } catch (error) {
          if (disposed || controller.signal.aborted) return;
          if (error instanceof JevyrContinuityError) {
            authenticationRefusedRef.current = true;
            setAuthenticity('refused');
            setStreamMode('ended');
            setNotice(`Continuity refused · ${error.message}`);
            return;
          }
          if (!retryableObserverError(error)) {
            authenticationRefusedRef.current = true;
            setAuthenticity('refused');
            setStreamMode('ended');
            setNotice(
              `Observation refused · ${error instanceof Error ? error.message : 'non-retryable transport failure'}`,
            );
            return;
          }
          failures += 1;
          setStreamMode('polling');
          setNotice(
            `Transport interrupted · retrying from verified cursor ${String(sequenceRef.current).padStart(4, '0')}`,
          );
          await observerDelay(observerBackoff(failures), controller.signal);
        }
      }
    }

    void observe();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [appendEvents, caseId]);

  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    let disposed = false;
    async function authenticateSeal() {
      let failures = 0;
      while (!disposed && !controller.signal.aborted) {
        try {
          return await Promise.all([
            JEVYR.verifiedSealReceipt(caseId as string, controller.signal),
            JEVYR.verifiedIntentContract(caseId as string, controller.signal),
          ]);
        } catch (error) {
          if (!retryableObserverError(error)) throw error;
          failures += 1;
          if (!disposed)
            setNotice('Seal transport interrupted · retrying authentication');
          await observerDelay(observerBackoff(failures), controller.signal);
        }
      }
      throw (
        controller.signal.reason ?? new Error('Seal authentication stopped')
      );
    }
    void authenticateSeal()
      .then(([verified, contract]) => {
        if (disposed || authenticationRefusedRef.current) return;
        setImpulse(contract.originalImpulse);
        const digest = verified.payload.caseDigest;
        if (caseDigestRef.current && caseDigestRef.current !== digest) {
          throw new JevyrContinuityError(
            'Accepted Blood does not belong to the authenticated Seal',
          );
        }
        authenticatedCaseDigestRef.current = digest;
        setReceiptDigest(digest);
        setVerificationKeyId(verified.keyId);
        setAuthenticity((current) =>
          current === 'verifying-seal' || current === 'unbound'
            ? 'seal-verified'
            : current,
        );
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        authenticationRefusedRef.current = true;
        setAuthenticity('refused');
        setNotice(
          `Seal authentication refused · ${error instanceof Error ? error.message : 'unknown verification failure'}`,
        );
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [caseId]);

  useEffect(() => {
    if (
      !caseId ||
      streamMode !== 'ended' ||
      authenticationRefusedRef.current ||
      closureAuthenticationStartedRef.current
    ) {
      return;
    }
    closureAuthenticationStartedRef.current = true;
    const controller = new AbortController();
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) setAuthenticity('verifying-closure');
    });
    async function authenticateTerminal() {
      let failures = 0;
      while (!disposed && !controller.signal.aborted) {
        try {
          return await Promise.all([
            JEVYR.waitForAuthenticatedRecord(caseId as string, {
              cursor: sequenceRef.current,
              ...(headDigestRef.current === null
                ? {}
                : { cursorDigest: headDigestRef.current }),
              signal: controller.signal,
              preferSse: false,
              pollWaitMs: 15_000,
              reconnectDelayMs: OBSERVER_RETRY_BASE_MS,
              maxReconnectDelayMs: OBSERVER_RETRY_CEILING_MS,
            }),
            JEVYR.verifiedIntentContract(caseId as string, controller.signal),
          ]);
        } catch (error) {
          if (!retryableObserverError(error, true)) throw error;
          failures += 1;
          if (!disposed) {
            setNotice(
              error instanceof JevyrHttpError && error.status === 409
                ? 'Terminal ledger closed · awaiting the signed closure'
                : 'Closure transport interrupted · retrying authentication',
            );
          }
          await observerDelay(observerBackoff(failures), controller.signal);
        }
      }
      throw (
        controller.signal.reason ?? new Error('Closure authentication stopped')
      );
    }
    void authenticateTerminal()
      .then(([verified, contract]) => {
        if (disposed || authenticationRefusedRef.current) return;
        const record = verified.payload;
        const closure = verified.terminal.payload;
        if (
          record.caseDigest !== caseDigestRef.current ||
          record.runDigest !== runDigestRef.current ||
          record.intentContractDigest !== contract.digest ||
          closure.caseDigest !== caseDigestRef.current ||
          closure.runDigest !== runDigestRef.current ||
          closure.lastSequence !== sequenceRef.current ||
          closure.eventHeadDigest !== headDigestRef.current ||
          ![...digestBySequenceRef.current.values()].includes(
            record.eventHeadDigest,
          )
        ) {
          throw new JevyrContinuityError(
            'Authenticated closure does not bind the accepted complete Blood and Record',
          );
        }
        setVerificationKeyId(verified.keyId);
        setAuthenticity('closure-authenticated');
        setOutcome(verified);
        setNotice(
          `Closure authenticated · ${digestFragment(verified.keyId)} · exact artifacts sealed · no further input exists`,
        );
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        authenticationRefusedRef.current = true;
        setAuthenticity('refused');
        setNotice(
          `Closure authentication refused · ${error instanceof Error ? error.message : 'unknown verification failure'}`,
        );
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [caseId, streamMode]);

  const projectedEvents = useMemo(
    () =>
      focusSequence === undefined
        ? events
        : events.filter((event) => event.sequence <= focusSequence),
    [events, focusSequence],
  );

  const activeIndex = useMemo(() => {
    let found = sealed ? 0 : -1;
    for (const event of projectedEvents) {
      const candidate = normalizedStage(event.stage ?? event.kind);
      const index = STAGES.findIndex(
        ([id]) => candidate === id || candidate.includes(id),
      );
      if (index >= 0) found = Math.max(found, index);
    }
    return found;
  }, [projectedEvents, sealed]);

  const activeStage = STAGES[Math.max(0, activeIndex)] ?? STAGES[0];
  const latestEvent = projectedEvents.at(-1);
  const liveMorphology = useMemo(() => deriveEventMorphology(events), [events]);
  const morphology = useMemo(
    () => deriveEventMorphology(projectedEvents),
    [projectedEvents],
  );
  const stopped =
    (focusSequence === undefined && streamMode === 'ended') ||
    morphology.stillness.motion === 'arrested' ||
    (latestEvent !== undefined && terminalEvent(latestEvent));
  const projectionNotice =
    focusSequence === undefined
      ? notice
      : `Projection at Blood ${String(morphology.cursor).padStart(4, '0')} · the observed Case remains at ${String(liveMorphology.cursor).padStart(4, '0')}`;

  useEffect(() => {
    const context = (document as ModelDocument).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const options = { signal: lifecycle.signal };

    void Promise.resolve(
      context.registerTool(
        {
          name: 'jevyr_cast_and_seal_case',
          title: 'Cast and seal a Jevyr Case',
          description:
            'Irreversibly submit the sole semantic impulse for a new Jevyr Case. No later semantic input is accepted.',
          inputSchema: {
            type: 'object',
            properties: {
              impulse: {
                type: 'string',
                minLength: 1,
                maxLength: 4000,
                description:
                  'The one-to-few-sentence impulse Jevyr must create and judge.',
              },
            },
            required: ['impulse'],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          async execute(input) {
            if (
              !input ||
              typeof input !== 'object' ||
              typeof (input as { impulse?: unknown }).impulse !== 'string'
            )
              throw new Error('impulse must be a string');
            const nextCaseId = await castImpulse(
              (input as { impulse: string }).impulse,
            );
            return {
              state: nextCaseId ? 'sealed' : 'specimen',
              caseId: nextCaseId,
            };
          },
        },
        options,
      ),
    ).catch(() => undefined);

    void Promise.resolve(
      context.registerTool(
        {
          name: 'jevyr_read_visible_case_state',
          title: 'Read visible Jevyr Case state',
          description:
            'Read the same public event cursor, transport state, and latest observation visible in the Chamber.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute() {
            return {
              caseId,
              sealed,
              transport: streamMode,
              authenticity,
              cursor: morphology.cursor,
              liveCursor: liveMorphology.cursor,
              projectionActive: focusSequence !== undefined,
              stage: activeStage[0],
              latest: latestEvent?.summary ?? null,
              continuity: morphology.continuity.state,
              candidates: morphology.candidates.length,
              lineages: morphology.lineages.length,
              evidence: morphology.evidence.length,
              unresolvedObligations: morphology.unresolvedObligationIds.length,
              maximumKnownResourcePressure:
                morphology.resourcePressure.maximumKnownPressure,
              stillness: morphology.stillness.state,
            };
          },
        },
        options,
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, [
    activeStage,
    authenticity,
    caseId,
    castImpulse,
    latestEvent?.summary,
    focusSequence,
    liveMorphology.cursor,
    morphology,
    sealed,
    streamMode,
  ]);

  return (
    <ChamberWorkspace
      client={JEVYR}
      impulse={impulse}
      onImpulse={setImpulse}
      sealed={sealed}
      specimen={authenticity === 'specimen'}
      caseId={caseId}
      cast={castImpulse}
      events={events}
      model={morphology}
      liveCursor={liveMorphology.cursor}
      focusSequence={focusSequence}
      onFocus={setFocusSequence}
      stage={activeStage[1]}
      transport={streamMode}
      authenticity={authenticityLabel(authenticity, verificationKeyId)}
      notice={projectionNotice}
      outcome={outcome}
      anatomy={
        <JevyrSubstrate
          events={projectedEvents}
          sealed={sealed}
          activeIndex={activeIndex}
          focusSequence={focusSequence}
          stopped={stopped}
          morphology={morphology}
        />
      }
    />
  );
}
