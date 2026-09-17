import { describe, expect, it } from 'vitest';
import {
  SEARCH_RESOURCE_NAMES,
  deriveEventMorphology,
  type MorphologyEvent,
} from './event-morphology';

const digest = (value: number) =>
  `sha256:${value.toString(16).padStart(64, '0')}`;
const CASE_DIGEST = digest(9001);
const RUN_DIGEST = digest(9002);

function linkedEvents(
  definitions: readonly Pick<
    MorphologyEvent,
    'kind' | 'stage' | 'payload' | 'actor'
  >[],
): MorphologyEvent[] {
  return definitions.map((definition, index) => ({
    protocol: 'jevyr.event/1',
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    sequence: index + 1,
    priorDigest: index === 0 ? null : digest(index),
    eventDigest: digest(index + 1),
    kind: definition.kind,
    stage: definition.stage,
    actor: definition.actor,
    payload: definition.payload,
  }));
}

function resources() {
  return SEARCH_RESOURCE_NAMES.map((name) => {
    if (name === 'mindInvocations') {
      return { name, used: 75, ceiling: 100, measurement: 'MEASURED' };
    }
    if (name === 'inputTokens') {
      return { name, used: 80, ceiling: 100, measurement: 'UPPER_BOUND' };
    }
    if (name === 'networkBytes') {
      return { name, used: null, ceiling: 0, measurement: 'DECLARED_ONLY' };
    }
    return { name, used: 0, ceiling: 100, measurement: 'MEASURED' };
  });
}

describe('deriveEventMorphology', () => {
  it('derives causal genealogy, proof relations, obligations, pressure, scars, and terminal stillness', () => {
    const events = linkedEvents([
      {
        kind: 'claim.published',
        stage: 'interpret',
        payload: {
          claimId: 'req-a',
          statement: 'Output must parse',
          claimType: 'requirement',
        },
      },
      {
        kind: 'claim.published',
        stage: 'interpret',
        payload: {
          claimId: 'req-b',
          statement: 'Boundary must hold',
          claimType: 'requirement',
        },
      },
      {
        kind: 'candidate.status',
        stage: 'diverge',
        actor: { id: 'mind-a', kind: 'mind' },
        payload: {
          candidateId: 'root',
          status: 'proposed',
          summary: 'Root mechanism',
          parentIds: [],
        },
      },
      {
        kind: 'candidate.status',
        stage: 'recombine',
        actor: { id: 'mind-b', kind: 'mind' },
        payload: {
          candidateId: 'child',
          status: 'proposed',
          summary: 'Crossed mechanism',
          parentIds: ['root'],
        },
      },
      {
        kind: 'candidate.status',
        stage: 'recombine',
        payload: {
          candidateId: 'child',
          status: 'selected',
          summary: 'Assay subject',
        },
      },
      {
        kind: 'evidence.observed',
        stage: 'embody',
        payload: {
          evidenceId: 'execution-1',
          evidenceType: 'sandbox_execution',
          summary: 'Typed oracle passed',
          contentDigest: digest(77),
          supports: ['req-a'],
        },
      },
      {
        kind: 'assay.status',
        stage: 'assay',
        payload: {
          assayId: 'assay-a',
          candidateId: 'child',
          obligationId: 'req-a',
          status: 'passed',
          critical: true,
          summary: 'Executable oracle passed',
          evidenceIds: ['execution-1'],
        },
      },
      {
        kind: 'assay.status',
        stage: 'assay',
        payload: {
          assayId: 'assay-b',
          candidateId: 'child',
          obligationId: 'req-b',
          status: 'blocked',
          critical: true,
          summary: 'No bounded oracle',
        },
      },
      {
        kind: 'candidate.status',
        stage: 'assay',
        payload: {
          candidateId: 'root',
          status: 'invalidated',
          summary: 'Boundary broke',
        },
      },
      {
        kind: 'search.status',
        stage: 'assay',
        payload: {
          layer: 'ASSAY_ARCHIVE',
          status: 'archive_changed',
          attempted: 7,
          attemptSafetyCeiling: '1500000000000000000000',
          resources: resources(),
          hypothesisNursery: {
            exactDistinctHypotheses: 4,
            scars: 2,
            declaredMechanismLabels: ['water', 'fracture'],
            exactYieldAge: 2,
          },
          assayArchive: {
            measuredEntries: 1,
            occupiedNiches: 1,
            lastMeasuredNovelty: 0.42,
          },
          termination: 'RESOURCE_EXHAUSTED',
          summary: 'The sealed resource envelope ended search',
        },
      },
      {
        kind: 'kernel.status',
        stage: 'sign',
        payload: { operation: 'signed', summary: 'Record signed' },
      },
      {
        kind: 'kernel.status',
        stage: 'terminate',
        payload: { operation: 'terminated', summary: 'Termination announced' },
      },
      {
        kind: 'stage.status',
        stage: 'terminate',
        payload: {
          stage: 'terminate',
          status: 'completed',
          summary: 'Termination complete',
          progress: 1,
        },
      },
    ]);

    const morphology = deriveEventMorphology(events);

    expect(morphology.continuity.state).toBe('continuous');
    expect(morphology.genealogy).toEqual([
      {
        parentId: 'root',
        childId: 'child',
        declaredAtSequence: 4,
        parentKnown: true,
      },
    ]);
    expect(
      morphology.candidates.find((candidate) => candidate.id === 'child'),
    ).toMatchObject({
      generation: 1,
      genealogyState: 'descendant',
      parentIds: ['root'],
      currentStatus: 'selected',
      assayIds: ['assay-a', 'assay-b'],
    });
    expect(morphology.lineages).toHaveLength(1);
    expect(morphology.lineages[0]).toMatchObject({
      rootId: 'root',
      rootCertainty: 'declared',
      candidateIds: ['child', 'root'],
      scarredCandidateIds: ['root'],
    });
    expect(morphology.evidence[0]).toMatchObject({
      id: 'execution-1',
      authority: 'sandbox_execution',
      supports: ['req-a'],
    });
    expect(morphology.evidenceRelations).toEqual([
      {
        kind: 'supports',
        evidenceId: 'execution-1',
        targetId: 'req-a',
        sequence: 6,
        authority: 'sandbox_execution',
        targetKnown: true,
      },
    ]);
    expect(
      morphology.obligations.find((obligation) => obligation.id === 'req-a'),
    ).toMatchObject({
      resolution: 'passed',
      unresolved: false,
      supportingEvidenceIds: ['execution-1'],
    });
    expect(morphology.unresolvedObligationIds).toEqual(['req-b']);
    expect(morphology.scarBurden).toEqual({
      attributedCount: 1,
      anonymousNurseryCount: 2,
      minimumDistinctCount: 2,
    });
    expect(morphology.resourcePressure.maximumKnownPressure).toBe(0.8);
    expect(morphology.resourcePressure.dominantResourceNames).toEqual([
      'inputTokens',
    ]);
    expect(
      morphology.resourcePressure.resources.find(
        (item) => item.name === 'networkBytes',
      ),
    ).toMatchObject({
      measurement: 'DECLARED_ONLY',
      pressure: null,
    });
    expect(morphology.searchGuard).toEqual({
      attempted: 7,
      attemptSafetyCeiling: '1500000000000000000000',
      reached: false,
      safetyGuardOnly: true,
    });
    expect(morphology.novelty).toMatchObject({
      exactContent: { distinctHypotheses: 4, yieldAge: 2, state: 'aging' },
      assayArchive: {
        measuredEntries: 1,
        lastMeasuredNovelty: 0.42,
        state: 'novel',
      },
      semanticInferenceFromExactCounts: 'forbidden',
    });
    expect(morphology.termination).toMatchObject({
      searchCause: 'RESOURCE_EXHAUSTED',
      announcedSequence: 12,
      completedSequence: 13,
    });
    expect(morphology.stillness).toEqual({
      state: 'terminal',
      motion: 'arrested',
      terminal: true,
      terminalSequence: 13,
      signed: true,
      signedSequence: 11,
      signedBeforeTermination: true,
      integrity: 'intact',
    });
  });

  it('is deterministic under delivery-order permutations', () => {
    const ordered = linkedEvents([
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'a',
          status: 'proposed',
          summary: 'A',
          parentIds: [],
        },
      },
      {
        kind: 'candidate.status',
        stage: 'recombine',
        payload: {
          candidateId: 'b',
          status: 'proposed',
          summary: 'B',
          parentIds: ['a'],
        },
      },
      {
        kind: 'stage.status',
        stage: 'assay',
        payload: {
          stage: 'assay',
          status: 'completed',
          summary: 'Assay complete',
        },
      },
    ]);
    const permuted = [ordered[2]!, ordered[0]!, ordered[1]!];
    expect(deriveEventMorphology(permuted)).toEqual(
      deriveEventMorphology(ordered),
    );
    expect(ordered.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('refuses conflicting sequence identities and stops at the intact prefix', () => {
    const events = linkedEvents([
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: { candidateId: 'a', status: 'proposed', summary: 'A' },
      },
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: { candidateId: 'b', status: 'proposed', summary: 'B' },
      },
    ]);
    const conflict: MorphologyEvent = {
      ...events[1]!,
      payload: {
        candidateId: 'intruder',
        status: 'selected',
        summary: 'Conflicting body',
      },
    };
    const morphology = deriveEventMorphology([
      events[0]!,
      events[1]!,
      conflict,
    ]);
    expect(morphology.continuity).toMatchObject({
      state: 'broken',
      acceptedThrough: 1,
    });
    expect(morphology.candidates.map((candidate) => candidate.id)).toEqual([
      'a',
    ]);
    expect(morphology.diagnostics).toContainEqual({
      code: 'EVENT_CONFLICT',
      sequence: 2,
    });
  });

  it('does not invent genealogy, evidence relations, or resource measurements from malformed fields', () => {
    const events = linkedEvents([
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'orphan',
          status: 'proposed',
          summary: 'Unknown ancestry',
          parentIds: 'not-an-array',
        },
      },
      {
        kind: 'evidence.observed',
        stage: 'embody',
        payload: {
          evidenceId: 'report',
          evidenceType: 'model_report',
          summary: 'A report',
          contentDigest: 'not-a-digest',
          supports: ['req', 7],
        },
      },
      {
        kind: 'search.status',
        stage: 'diverge',
        payload: {
          layer: 'HYPOTHESIS_NURSERY',
          status: 'exploring',
          attempted: 2,
          attemptSafetyCeiling: '999999999999999999999',
          resources: [
            {
              name: 'mindInvocations',
              used: 'many',
              ceiling: 10,
              measurement: 'MEASURED',
            },
          ],
          summary: 'Malformed telemetry',
        },
      },
    ]);
    const morphology = deriveEventMorphology(events);
    const orphan = morphology.candidates.find(
      (candidate) => candidate.id === 'orphan',
    );
    expect(orphan).toMatchObject({
      parentIds: [],
      parentDisclosure: 'undisclosed',
      genealogyState: 'undisclosed',
    });
    expect(morphology.evidence[0]).toMatchObject({
      contentDigest: null,
      supports: [],
      refutes: [],
    });
    expect(morphology.evidenceRelations).toEqual([]);
    expect(morphology.obligations).toEqual([]);
    expect(
      morphology.resourcePressure.resources.every(
        (resource) => resource.measurement === 'MISSING',
      ),
    ).toBe(true);
    expect(morphology.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['RELATION_INVALID', 'RESOURCE_INVALID']),
    );
  });

  it('refuses to visualize an attempt guard beyond the protocol 128-digit bound', () => {
    const morphology = deriveEventMorphology(
      linkedEvents([
        {
          kind: 'search.status',
          stage: 'diverge',
          payload: {
            layer: 'HYPOTHESIS_NURSERY',
            status: 'exploring',
            attempted: 2,
            attemptSafetyCeiling: '9'.repeat(129),
            resources: resources(),
            hypothesisNursery: {
              exactDistinctHypotheses: 2,
              scars: 0,
              declaredMechanismLabels: ['inversion'],
              exactYieldAge: 1,
            },
            summary: 'Overlong telemetry must not become visual authority.',
          },
        },
      ]),
    );

    expect(morphology.searchGuard.attemptSafetyCeiling).toBeNull();
    expect(morphology.diagnostics).toContainEqual({
      code: 'PAYLOAD_INVALID',
      sequence: 1,
      field: 'attemptSafetyCeiling',
    });
  });

  it('distinguishes termination announcement from completed stillness and arrests after completion', () => {
    const announced = linkedEvents([
      {
        kind: 'kernel.status',
        stage: 'terminate',
        payload: { operation: 'terminated', summary: 'Announced' },
      },
    ]);
    expect(deriveEventMorphology(announced).stillness).toMatchObject({
      state: 'termination_announced',
      motion: 'event_driven',
      terminal: false,
    });

    const completed = linkedEvents([
      {
        kind: 'kernel.status',
        stage: 'terminate',
        payload: { operation: 'terminated', summary: 'Announced' },
      },
      {
        kind: 'stage.status',
        stage: 'terminate',
        payload: {
          stage: 'terminate',
          status: 'completed',
          summary: 'Complete',
        },
      },
      {
        kind: 'candidate.status',
        stage: 'diverge',
        payload: {
          candidateId: 'too-late',
          status: 'proposed',
          summary: 'Impossible continuation',
        },
      },
    ]);
    const morphology = deriveEventMorphology(completed);
    expect(morphology.stillness).toMatchObject({
      state: 'terminal',
      motion: 'arrested',
      integrity: 'violated',
    });
    expect(morphology.candidates).toEqual([]);
    expect(morphology.continuity.postTerminalSequences).toEqual([3]);
  });
});
