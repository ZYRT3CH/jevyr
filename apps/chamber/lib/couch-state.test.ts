import { describe, expect, it } from 'vitest';
import { deriveEventMorphology } from './event-morphology';
import {
  canonicalJson,
  couchState,
  ideaTitle,
  publicIdeaText,
  textDigest,
} from './couch-state';
import type { JevyrPublicEvent } from '@/components/jevyr-substrate';

const digest = (number: number) =>
  `sha256:${number.toString(16).padStart(64, '0')}`;
function events(
  definitions: {
    kind: string;
    stage: string;
    payload: Record<string, unknown>;
  }[],
): JevyrPublicEvent[] {
  return definitions.map((definition, index) => ({
    ...definition,
    protocol: 'jevyr.event/1',
    caseDigest: digest(98),
    runDigest: digest(99),
    sequence: index + 1,
    priorDigest: index ? digest(index) : null,
    eventDigest: digest(index + 1),
    summary: typeof definition.payload.summary === 'string' ? definition.payload.summary : '',
  }));
}

describe('Couch mode public-state projection', () => {
  it('distinguishes proposals, compiled code, and execution after interruption', () => {
    const trace = events([
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'a',
          status: 'proposed',
          summary: 'An idea [untrusted nursery hypothesis; not assayed]',
        },
      },
      {
        kind: 'action.status',
        stage: 'diverge',
        payload: {
          actionId: 'compile-a',
          actionType: 'candidate.blueprint.compile',
          status: 'completed',
          summary: 'Saved a blueprint',
        },
      },
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'a',
          status: 'proposed',
          summary: 'An idea [finite blueprint; still unassayed]',
        },
      },
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'b',
          status: 'proposed',
          summary: 'Another idea',
        },
      },
      {
        kind: 'stage.status',
        stage: 'recombine',
        payload: {
          stage: 'recombine',
          status: 'failed',
          summary: 'The model connection closed',
        },
      },
    ]);
    const state = couchState(deriveEventMorphology(trace), trace, 'ended');
    expect(state).toMatchObject({
      count: 2,
      compiled: 1,
      executed: 0,
      interrupted: true,
    });
    expect(state.title).toBe('The run stopped. The ideas remain.');
    expect(state.detail).toContain('There is no completed judgment');
  });
  it('does not mark future execution or interruption while reading an earlier prefix', () => {
    const trace = events([
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: { candidateId: 'a', status: 'proposed', summary: 'An idea' },
      },
      {
        kind: 'candidate.status',
        stage: 'embody',
        payload: {
          candidateId: 'a',
          status: 'embodied',
          summary: 'A prototype ran',
        },
      },
      {
        kind: 'stage.status',
        stage: 'assay',
        payload: { stage: 'assay', status: 'failed', summary: 'Interrupted' },
      },
    ]);
    const state = couchState(
      deriveEventMorphology(trace.slice(0, 1)),
      trace,
      'ended',
      undefined,
      true,
    );
    expect(state).toMatchObject({
      count: 1,
      executed: 0,
      interrupted: false,
      ended: false,
      connection: 'Replay · event 1',
    });
  });
  it('does not manufacture ideas while loading', () => {
    expect(
      couchState(deriveEventMorphology([]), [], 'connecting'),
    ).toMatchObject({
      count: 0,
      compiled: 0,
      executed: 0,
      title: 'Connecting to this run',
    });
  });
  it('keeps terminal-without-authentication distinct from a finished answer', () => {
    expect(couchState(deriveEventMorphology([]), [], 'ended').title).toBe(
      'Verifying how the run ended',
    );
  });
  it('retains literal public text without executing markup or admitting hidden fields', () => {
    expect(
      publicIdeaText(
        {
          summary: '<script>alert(1)</script>',
          body: 'A public proposal',
          chainOfThought: 'private',
        },
        digest(1),
      ),
    ).toEqual({
      summary: '<script>alert(1)</script>',
      body: 'A public proposal',
      digest: digest(1),
      recovered: false,
    });
    expect(
      publicIdeaText({ summary: 'x', body: 'x'.repeat(200001) }, digest(1)),
    ).toBeUndefined();
  });
  it('removes runtime suffixes without erasing ordinary brackets inside idea names', () => {
    expect(
      ideaTitle('An idea [finite blueprint sha256:abc; still unassayed]'),
    ).toBe('An idea');
    expect(ideaTitle('An idea [about missing data]')).toBe(
      'An idea [about missing data]',
    );
  });
  it('verifies exact response bytes, not a reparsed approximation', async () => {
    expect(await textDigest('{"x":1}')).not.toBe(await textDigest('{ "x":1 }'));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
