import type { AuthenticatedTerminalRecord } from '@jevyr/sdk';
import type { JevyrPublicEvent } from '@/components/jevyr-substrate';
import type { ChamberMorphology } from './event-morphology';

export function ideaTitle(summary: string) {
  return summary
    .replace(
      /\s*\[(?:untrusted nursery|finite blueprint|genealogy disclosed).*$/,
      '',
    )
    .trim();
}

/** An observer projection, never an additional Mind or a source of verdicts. */
export function couchState(
  model: ChamberMorphology,
  events: readonly JevyrPublicEvent[],
  transport: string,
  outcome?: AuthenticatedTerminalRecord,
  replay = false,
) {
  const visible = events.filter((event) => event.sequence <= model.cursor);
  const last = visible.at(-1);
  const failed = visible.findLast(
    (event) =>
      event.kind === 'stage.status' && event.payload?.status === 'failed',
  );
  const interrupted =
    Boolean(failed) ||
    (!replay && outcome?.terminal.payload.lifecycle === 'invalid');
  const ended = !replay && transport === 'ended';
  const executed = model.candidates.filter((idea) =>
    idea.statusHistory.some((moment) => moment.status === 'embodied'),
  ).length;
  const compiled = new Set(
    visible
      .filter(
        (event) =>
          event.kind === 'action.status' &&
          event.payload?.actionType === 'candidate.blueprint.compile' &&
          event.payload?.status === 'completed',
      )
      .map((event) => event.payload?.actionId),
  ).size;
  const count = model.candidates.length;
  const stage = last?.stage?.toLowerCase() ?? 'cast';
  const phases: Record<string, [string, string]> = {
    cast: ['Receiving the task', 'One request begins this run.'],
    snapshot: [
      'Holding the starting point',
      'Jevyr is capturing the material it was given.',
    ],
    seal: ['The task is set', 'From here, this screen only observes.'],
    self_scan: [
      'Checking what is available',
      'Jevyr is checking its model and testing tools.',
    ],
    interpret: [
      'Finding possible meanings',
      'The request is being interpreted before ideas are proposed.',
    ],
    diverge: [
      'Exploring possibilities',
      'New proposals will appear here as they are saved.',
    ],
    recombine: [
      'Connecting the ideas',
      'Jevyr is comparing mechanisms and possible combinations.',
    ],
    embody: [
      'Running the prototypes',
      'Code is being tried in an isolated environment.',
    ],
    challenge: [
      'Looking for weaknesses',
      'The proposals are being challenged, not approved.',
    ],
    assay: [
      'Checking the evidence',
      'Jevyr is distinguishing measured results from claims.',
    ],
    reflex: [
      'Checking its own judgment',
      'Jevyr is auditing the basis of its conclusions.',
    ],
    crystallize: [
      'Preparing the result',
      'The available evidence is being assembled.',
    ],
    sign: [
      'Sealing the result',
      'Jevyr is signing the result and its evidence references.',
    ],
    memory_tribunal: [
      'Closing the run',
      'The result is complete; memory is being reviewed.',
    ],
    terminate: ['Run finished', 'The saved result is ready to inspect.'],
  };
  let [title, detail] = phases[stage] ?? [
    'Observing Jevyr',
    'Waiting for the next public event.',
  ];
  if (!visible.length) {
    title =
      transport === 'connecting'
        ? 'Connecting to this run'
        : 'Waiting for the first update';
    detail = 'No work is shown until its events have arrived.';
  }
  if (interrupted) {
    title = 'The run stopped. The ideas remain.';
    detail = `${count} ${count === 1 ? 'proposal is' : 'proposals are'} saved. ${executed === 0 ? 'Testing had not started.' : `${executed} prototypes had run.`} There is no completed judgment from this run.`;
  } else if (ended) {
    title = outcome ? 'The result is ready' : 'Verifying how the run ended';
    detail = outcome
      ? outcome.payload.verdict.selectedCandidateId
        ? 'Jevyr selected a proposal. Read its judgment and the limits of the evidence.'
        : `${count} proposals were recorded. Jevyr did not select one; this does not mean no ideas were produced.`
      : 'The event stream has closed. Its final result is still being authenticated.';
  }
  return {
    title,
    detail,
    interrupted,
    ended,
    count,
    executed,
    compiled,
    stage,
    failure: failed?.summary ?? '',
    connection: replay
      ? `Replay · event ${model.cursor}`
      : interrupted
        ? 'Run stopped'
        : ended
        ? 'Run closed'
        : transport === 'polling'
          ? 'Live · polling'
          : transport === 'live'
            ? 'Live'
            : 'Connecting',
    meaningful: visible
      .filter(
        (event) =>
          event.kind === 'candidate.status' ||
          event.kind === 'stage.status' ||
          (event.kind === 'action.status' &&
            event.payload?.status === 'failed'),
      )
      .slice(-5)
      .reverse(),
  };
}

export function jsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function textDigest(text: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

export interface PublicIdeaText {
  candidateId?: string;
  summary: string;
  body?: string;
  digest: string;
  recovered: boolean;
}

/** Inert, bounded public text only. No HTML, prompts, private reasoning or source execution. */
export function publicIdeaText(
  value: unknown,
  digest: string,
  recovered = false,
): PublicIdeaText | undefined {
  const item = jsonObject(value);
  if (
    !item ||
    typeof item.summary !== 'string' ||
    item.summary.length > 16_000 ||
    (item.body !== undefined &&
      (typeof item.body !== 'string' || item.body.length > 200_000))
  )
    return undefined;
  return {
    ...(typeof item.candidateId === 'string'
      ? { candidateId: item.candidateId }
      : {}),
    summary: item.summary,
    ...(typeof item.body === 'string' ? { body: item.body } : {}),
    digest,
    recovered,
  };
}
