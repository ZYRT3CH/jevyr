'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  deriveEventMorphology,
  type ChamberMorphology,
  type EvidenceAuthority,
  type ObligationMorphology,
} from '@/lib/event-morphology';

export type JevyrPublicEvent = {
  protocol?: 'jevyr.event/1';
  caseDigest?: string;
  runDigest?: string;
  sequence: number;
  priorDigest?: string | null;
  kind: string;
  stage?: string;
  summary: string;
  eventDigest?: string;
  observedAt?: string;
  actor?: {
    id?: string;
    kind?: string;
    instance?: string;
  };
  payload?: Record<string, unknown>;
  status?: 'started' | 'progress' | 'completed' | 'failed';
};

type JevyrSubstrateProps = {
  events: JevyrPublicEvent[];
  sealed: boolean;
  /** Retained for the public component contract. It never drives appearance. */
  activeIndex: number;
  focusSequence?: number;
  stopped?: boolean;
  morphology?: ChamberMorphology;
};

type Point = { x: number; y: number };
type CandidatePoint = Point & {
  id: string;
  radius: number;
  status: ChamberMorphology['candidates'][number]['currentStatus'];
};

const VOID = '#020203';
const CARBON = '#09090b';
const BONE = '#d8d7cf';
const WOUND = '#9c1f19';
const BRUISE = '#311219';
const MERCURY = '#829da1';
const WET_RIM = 'rgba(218, 221, 216, 0.18)';
const GLASS = 'rgba(157, 170, 171, 0.20)';

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function unit(value: string) {
  return hashString(value) / 4294967295;
}

function pointOnCubic(
  start: Point,
  controlOne: Point,
  controlTwo: Point,
  end: Point,
  t: number,
): Point {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * controlOne.x +
      3 * inverse * t ** 2 * controlTwo.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * controlOne.y +
      3 * inverse * t ** 2 * controlTwo.y +
      t ** 3 * end.y,
  };
}

function curve(
  context: CanvasRenderingContext2D,
  start: Point,
  controlOne: Point,
  controlTwo: Point,
  end: Point,
) {
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.bezierCurveTo(
    controlOne.x,
    controlOne.y,
    controlTwo.x,
    controlTwo.y,
    end.x,
    end.y,
  );
}

function drawVoid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  seed: string,
) {
  context.fillStyle = VOID;
  context.fillRect(0, 0, width, height);
  const random = randomFrom(hashString(`void:${seed}`));
  context.save();
  context.strokeStyle = 'rgba(216, 215, 207, 0.055)';
  context.lineWidth = 0.5;
  for (let index = 0; index < 17; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const length = 8 + random() * Math.min(70, width * 0.05);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(
      x + length * (random() - 0.6),
      y + length * (random() - 0.4),
    );
    context.stroke();
  }
  context.restore();
}

function drawIncision(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  sealed: boolean,
) {
  const x = width * (width < 760 ? 0.5 : 0.44);
  const top = height * 0.27;
  const bottom = height * 0.74;
  context.save();
  context.lineCap = 'round';
  context.strokeStyle = sealed ? 'rgba(216, 215, 207, 0.42)' : WET_RIM;
  context.lineWidth = sealed ? 1.1 : 0.7;
  curve(
    context,
    { x, y: top },
    { x: x - 11, y: height * 0.42 },
    { x: x + 9, y: height * 0.59 },
    { x: x - 2, y: bottom },
  );
  context.stroke();
  if (!sealed) {
    context.fillStyle = WOUND;
    context.beginPath();
    context.ellipse(x, height * 0.505, 1.5, 4.8, -0.12, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function candidateLayout(
  morphology: ChamberMorphology,
  width: number,
  height: number,
): Map<string, CandidatePoint> {
  const result = new Map<string, CandidatePoint>();
  const usableLeft = width < 760 ? width * 0.16 : width * 0.27;
  const usableRight = width < 760 ? width * 0.88 : width * 0.73;
  const usableTop = height * 0.2;
  const usableBottom = height * 0.79;
  const lineages =
    morphology.lineages.length > 0
      ? morphology.lineages
      : morphology.candidates.map((candidate) => ({
          id: `orphan:${candidate.id}`,
          candidateIds: [candidate.id] as readonly string[],
        }));

  lineages.forEach((lineage, lineageIndex) => {
    const lane = (lineageIndex + 1) / (lineages.length + 1);
    const axisX = usableLeft + (usableRight - usableLeft) * lane;
    const candidates = lineage.candidateIds
      .map((id) =>
        morphology.candidates.find((candidate) => candidate.id === id),
      )
      .filter(
        (candidate): candidate is ChamberMorphology['candidates'][number] =>
          candidate !== undefined,
      )
      .sort(
        (left, right) =>
          (left.generation ?? 0) - (right.generation ?? 0) ||
          left.id.localeCompare(right.id),
      );
    candidates.forEach((candidate, index) => {
      const generation = candidate.generation ?? index;
      const vertical = clamp(
        (generation + 0.7 + unit(`${candidate.id}:depth`) * 0.42) /
          Math.max(2, candidates.length + 0.4),
      );
      const spread = Math.min(
        90,
        (usableRight - usableLeft) / Math.max(4, lineages.length),
      );
      result.set(candidate.id, {
        id: candidate.id,
        x: axisX + (unit(`${candidate.id}:x`) - 0.5) * spread,
        y: usableTop + (usableBottom - usableTop) * vertical,
        radius: 10 + unit(`${candidate.id}:mass`) * 9,
        status: candidate.currentStatus,
      });
    });
  });
  return result;
}

function drawPressureBody(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  width: number,
  height: number,
  phase: number,
) {
  const known = morphology.resourcePressure.maximumKnownPressure;
  const resources = morphology.resourcePressure.resources;
  const declared = resources.filter(
    (resource) => resource.measurement === 'DECLARED_ONLY',
  );
  if (known === null) {
    if (declared.length === 0) return;
    const x = width * 0.18;
    const y = height * 0.52;
    context.save();
    context.strokeStyle = 'rgba(216, 215, 207, 0.18)';
    context.lineWidth = 0.8;
    context.setLineDash([13, 9]);
    context.beginPath();
    context.moveTo(x + 18, y - height * 0.16);
    context.lineTo(x, y - height * 0.16);
    context.lineTo(x, y + height * 0.16);
    context.lineTo(x + 18, y + height * 0.16);
    context.stroke();
    context.restore();
    return;
  }

  const pressure = clamp(known);
  const spineStart = { x: width * 0.32, y: height * 0.18 };
  const spineControlOne = { x: width * 0.7, y: height * 0.3 };
  const spineControlTwo = { x: width * 0.22, y: height * 0.68 };
  const spineEnd = { x: width * 0.68, y: height * 0.82 };
  const scale = Math.min(width, height);
  const random = randomFrom(
    hashString(`pressure:${morphology.continuity.caseDigest ?? 'case'}`),
  );
  const leftEdge: Point[] = [];
  const rightEdge: Point[] = [];
  for (let index = 0; index <= 48; index += 1) {
    const t = index / 48;
    const point = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      t,
    );
    const before = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      Math.max(0, t - 0.006),
    );
    const after = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      Math.min(1, t + 0.006),
    );
    const tangent = Math.atan2(after.y - before.y, after.x - before.x);
    const normal = tangent + Math.PI / 2;
    const middle = Math.sin(Math.PI * t) ** 0.72;
    const constriction =
      1 - pressure * Math.exp(-((t - 0.53) ** 2) / 0.018) * 0.68;
    const lobe = 1 + Math.sin(t * Math.PI * 5.4 + 0.7) * 0.12;
    const restless =
      Math.sin(t * Math.PI * 8 + phase * 0.45) * (1 - pressure) * 0.018;
    const fixed = (random() - 0.5) * 0.022;
    const halfWidth =
      scale * (0.018 + middle * (0.145 - pressure * 0.045)) * constriction;
    leftEdge.push({
      x: point.x + Math.cos(normal) * halfWidth * (lobe + restless + fixed),
      y: point.y + Math.sin(normal) * halfWidth * (lobe + restless + fixed),
    });
    rightEdge.push({
      x: point.x - Math.cos(normal) * halfWidth * (1.07 - restless - fixed),
      y: point.y - Math.sin(normal) * halfWidth * (1.07 - restless - fixed),
    });
  }
  context.save();
  context.beginPath();
  [...leftEdge, ...rightEdge.reverse()].forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.fillStyle =
    pressure > 0.88 ? 'rgba(49, 18, 25, 0.34)' : 'rgba(9, 9, 11, 0.84)';
  context.fill();
  context.strokeStyle = pressure > 0.88 ? 'rgba(156, 31, 25, 0.68)' : WET_RIM;
  context.lineWidth = 0.8 + pressure * 1.3;
  context.stroke();

  for (const resource of resources.filter((item) => item.pressure !== null)) {
    const t = 0.12 + unit(resource.name) * 0.76;
    const point = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      t,
    );
    const before = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      Math.max(0, t - 0.008),
    );
    const after = pointOnCubic(
      spineStart,
      spineControlOne,
      spineControlTwo,
      spineEnd,
      Math.min(1, t + 0.008),
    );
    const normal =
      Math.atan2(after.y - before.y, after.x - before.x) +
      (unit(`${resource.name}:side`) > 0.5 ? Math.PI / 2 : -Math.PI / 2);
    const depth = clamp(resource.pressure ?? 0);
    const start = {
      x: point.x + Math.cos(normal) * scale * (0.008 + depth * 0.022),
      y: point.y + Math.sin(normal) * scale * (0.008 + depth * 0.022),
    };
    const end = {
      x: point.x + Math.cos(normal) * scale * (0.04 + depth * 0.1),
      y: point.y + Math.sin(normal) * scale * (0.04 + depth * 0.1),
    };
    context.strokeStyle = resource.overrun
      ? WOUND
      : resource.measurement === 'UPPER_BOUND'
        ? 'rgba(130, 157, 161, 0.32)'
        : 'rgba(216, 215, 207, 0.17)';
    context.lineWidth = resource.overrun ? 2.2 : 0.65;
    context.setLineDash(resource.measurement === 'UPPER_BOUND' ? [2, 4] : []);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    if (resource.overrun) {
      context.lineTo(
        end.x + Math.cos(normal + 1.8) * 15,
        end.y + Math.sin(normal + 1.8) * 15,
      );
    }
    context.stroke();
  }
  context.restore();
}

function tubeGeometry(start: Point, end: Point, key: string) {
  const bend = (unit(`${key}:bend`) - 0.5) * 90;
  return {
    controlOne: { x: start.x + bend, y: start.y + (end.y - start.y) * 0.34 },
    controlTwo: {
      x: end.x - bend * 0.55,
      y: start.y + (end.y - start.y) * 0.69,
    },
  };
}

function drawLineages(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  phase: number,
  focusedIds: Set<string>,
) {
  const pressure = morphology.resourcePressure.maximumKnownPressure ?? 0;
  const age = morphology.novelty.exactContent.yieldAge ?? 0;
  const flowSpeed = (0.16 * (1 - clamp(pressure) * 0.72)) / (1 + age * 0.12);
  for (const lineage of morphology.lineages) {
    const root =
      candidates.get(lineage.rootId) ??
      candidates.get(lineage.candidateIds[0] ?? '');
    if (!root) continue;
    const start = {
      x: root.x + (unit(`${lineage.id}:entry-x`) - 0.5) * 190,
      y: Math.max(38, root.y - 125 - unit(`${lineage.id}:entry-y`) * 85),
    };
    const controls = tubeGeometry(start, root, `entry:${lineage.id}`);
    const focused = lineage.candidateIds.some((id) => focusedIds.has(id));
    context.save();
    context.lineCap = 'round';
    curve(context, start, controls.controlOne, controls.controlTwo, root);
    context.strokeStyle =
      lineage.rootCertainty === 'declared'
        ? GLASS
        : 'rgba(216, 215, 207, 0.10)';
    context.lineWidth = focused ? 3.8 : 2.4;
    if (lineage.rootCertainty !== 'declared') context.setLineDash([3, 7]);
    context.stroke();
    context.setLineDash([]);
    curve(context, start, controls.controlOne, controls.controlTwo, root);
    context.strokeStyle =
      lineage.scarredCandidateIds.length > 0
        ? 'rgba(156, 31, 25, 0.36)'
        : 'rgba(130, 157, 161, 0.24)';
    context.lineWidth = 0.65;
    context.stroke();
    const travel =
      (((phase * flowSpeed + unit(`${lineage.id}:entry-meniscus`)) % 1) + 1) %
      1;
    const meniscus = pointOnCubic(
      start,
      controls.controlOne,
      controls.controlTwo,
      root,
      travel,
    );
    context.fillStyle =
      lineage.scarredCandidateIds.length > 0 ? WOUND : MERCURY;
    context.beginPath();
    context.ellipse(
      meniscus.x,
      meniscus.y,
      focused ? 2.5 : 1.5,
      0.8,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  }
  for (const edge of morphology.genealogy) {
    const child = candidates.get(edge.childId);
    if (!child) continue;
    const parent = candidates.get(edge.parentId) ?? {
      x: child.x + (unit(edge.parentId) - 0.5) * 120,
      y: child.y - 100,
    };
    const controls = tubeGeometry(
      parent,
      child,
      `${edge.parentId}:${edge.childId}`,
    );
    const focused =
      focusedIds.has(edge.parentId) || focusedIds.has(edge.childId);
    context.save();
    context.lineCap = 'round';
    curve(context, parent, controls.controlOne, controls.controlTwo, child);
    context.strokeStyle = edge.parentKnown
      ? GLASS
      : 'rgba(216, 215, 207, 0.11)';
    context.lineWidth = focused ? 4.4 : 3;
    if (!edge.parentKnown) context.setLineDash([5, 8]);
    context.stroke();
    context.setLineDash([]);
    curve(context, parent, controls.controlOne, controls.controlTwo, child);
    context.strokeStyle = focused
      ? 'rgba(216, 215, 207, 0.50)'
      : 'rgba(130, 157, 161, 0.25)';
    context.lineWidth = 0.7;
    context.stroke();
    const travel =
      (((phase * flowSpeed + unit(`${edge.childId}:meniscus`)) % 1) + 1) % 1;
    const meniscus = pointOnCubic(
      parent,
      controls.controlOne,
      controls.controlTwo,
      child,
      travel,
    );
    context.fillStyle = MERCURY;
    context.beginPath();
    context.ellipse(
      meniscus.x,
      meniscus.y,
      focused ? 2.7 : 1.7,
      0.9,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  }
}

function organPath(
  context: CanvasRenderingContext2D,
  candidate: CandidatePoint,
  seed: string,
) {
  const random = randomFrom(hashString(seed));
  context.beginPath();
  for (let index = 0; index <= 22; index += 1) {
    const angle = (index / 22) * Math.PI * 2;
    const distortion = 0.82 + random() * 0.32;
    const x = candidate.x + Math.cos(angle) * candidate.radius * distortion;
    const y =
      candidate.y + Math.sin(angle) * candidate.radius * distortion * 0.72;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

function drawCandidates(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  focusedIds: Set<string>,
) {
  for (const model of morphology.candidates) {
    const point = candidates.get(model.id);
    if (!point) continue;
    const focused = focusedIds.has(model.id);
    context.save();
    organPath(context, point, `organ:${model.id}`);
    if (model.currentStatus === 'invalidated') {
      context.fillStyle = 'rgba(49, 18, 25, 0.74)';
      context.fill();
      context.strokeStyle = WOUND;
      context.lineWidth = focused ? 2.7 : 1.5;
      context.stroke();
      context.beginPath();
      context.moveTo(
        point.x - point.radius * 0.8,
        point.y - point.radius * 0.5,
      );
      context.lineTo(
        point.x + point.radius * 0.65,
        point.y + point.radius * 0.56,
      );
      context.stroke();
    } else if (model.currentStatus === 'survived') {
      context.fillStyle = CARBON;
      context.fill();
      context.strokeStyle = BONE;
      context.lineWidth = focused ? 2.3 : 1.1;
      context.stroke();
    } else if (model.currentStatus === 'embodied') {
      context.fillStyle = 'rgba(130, 157, 161, 0.19)';
      context.fill();
      context.strokeStyle = focused ? BONE : 'rgba(130, 157, 161, 0.56)';
      context.lineWidth = focused ? 2 : 1;
      context.stroke();
    } else if (model.currentStatus === 'selected') {
      context.strokeStyle = BONE;
      context.lineWidth = focused ? 2.1 : 1.25;
      context.stroke();
      context.beginPath();
      context.moveTo(point.x, point.y - point.radius * 1.2);
      context.lineTo(point.x - 1, point.y + point.radius * 1.18);
      context.stroke();
    } else {
      context.fillStyle = 'rgba(9, 9, 11, 0.52)';
      context.fill();
      context.strokeStyle = focused ? 'rgba(216, 215, 207, 0.53)' : WET_RIM;
      context.lineWidth = focused ? 1.5 : 0.65;
      context.stroke();
    }
    context.restore();
  }
}

function obligationAnchor(
  obligation: ObligationMorphology,
  width: number,
  height: number,
): Point {
  const side = unit(`${obligation.id}:side`) > 0.5 ? 1 : -1;
  return {
    x:
      width * 0.5 +
      side * width * (0.29 + unit(`${obligation.id}:offset`) * 0.08),
    y: height * (0.25 + unit(`${obligation.id}:height`) * 0.52),
  };
}

function obligationTarget(
  obligation: ObligationMorphology,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  width: number,
  height: number,
): Point {
  const claimant = morphology.candidates.find((candidate) =>
    candidate.claimIds.includes(obligation.id),
  );
  if (claimant) {
    const point = candidates.get(claimant.id);
    if (point) return point;
  }
  const assay = morphology.assays.find(
    (item) => item.obligationId === obligation.id && item.candidateId,
  );
  if (assay?.candidateId) {
    const point = candidates.get(assay.candidateId);
    if (point) return point;
  }
  return { x: width * 0.5, y: height * 0.51 };
}

function drawObligations(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  width: number,
  height: number,
  focusedIds: Set<string>,
) {
  for (const obligation of morphology.obligations) {
    const anchor = obligationAnchor(obligation, width, height);
    const target = obligationTarget(
      obligation,
      morphology,
      candidates,
      width,
      height,
    );
    const midpoint = {
      x: (anchor.x + target.x) / 2,
      y: (anchor.y + target.y) / 2,
    };
    const tension = obligation.unresolved ? 0 : 16;
    const controlOne = { x: midpoint.x, y: anchor.y + tension };
    const controlTwo = { x: midpoint.x, y: target.y - tension };
    const focused = focusedIds.has(obligation.id);
    context.save();
    context.lineCap = 'round';
    curve(context, anchor, controlOne, controlTwo, target);
    context.strokeStyle =
      obligation.resolution === 'failed' ||
      obligation.resolution === 'contested'
        ? WOUND
        : obligation.resolution === 'passed'
          ? 'rgba(216, 215, 207, 0.62)'
          : 'rgba(216, 215, 207, 0.25)';
    context.lineWidth = focused ? 2.4 : obligation.critical ? 1.25 : 0.75;
    if (['blocked', 'inconclusive'].includes(obligation.resolution))
      context.setLineDash([2, 6]);
    context.stroke();
    context.setLineDash([]);
    context.translate(anchor.x, anchor.y);
    context.rotate(unit(obligation.id) * Math.PI);
    context.strokeStyle =
      obligation.resolution === 'failed'
        ? WOUND
        : obligation.unresolved
          ? WET_RIM
          : BONE;
    context.lineWidth = focused ? 2 : 1;
    context.beginPath();
    context.moveTo(-5, -4);
    context.lineTo(0, 4);
    context.lineTo(5, -4);
    context.stroke();
    context.restore();
  }
}

function authorityStyle(authority: EvidenceAuthority) {
  switch (authority) {
    case 'subject_snapshot':
      return { color: BONE, width: 1.5, dash: [] as number[], alpha: 0.82 };
    case 'deterministic_tool':
      return { color: MERCURY, width: 1.4, dash: [] as number[], alpha: 0.78 };
    case 'sandbox_execution':
      return { color: BONE, width: 1.9, dash: [] as number[], alpha: 0.92 };
    case 'artifact_inspection':
      return { color: MERCURY, width: 1.1, dash: [] as number[], alpha: 0.68 };
    case 'model_report':
    case 'peer_report':
      return { color: MERCURY, width: 0.7, dash: [2, 5], alpha: 0.4 };
    case 'memory_hint':
      return { color: BRUISE, width: 0.8, dash: [1, 7], alpha: 0.52 };
    default:
      return { color: GLASS, width: 0.6, dash: [1, 6], alpha: 0.34 };
  }
}

function evidenceSource(id: string, width: number, height: number): Point {
  const top = unit(`${id}:edge`) > 0.5;
  return top
    ? { x: width * (0.2 + unit(`${id}:x`) * 0.6), y: height * 0.12 }
    : {
        x: width * (unit(`${id}:side`) > 0.5 ? 0.88 : 0.12),
        y: height * (0.2 + unit(`${id}:y`) * 0.6),
      };
}

function targetPoint(
  id: string,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  width: number,
  height: number,
): Point | null {
  const candidate = candidates.get(id);
  if (candidate) return candidate;
  const obligation = morphology.obligations.find((item) => item.id === id);
  if (obligation) return obligationAnchor(obligation, width, height);
  return null;
}

function drawEvidence(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  width: number,
  height: number,
  focusedIds: Set<string>,
) {
  const linkedEvidence = new Set(
    morphology.evidenceRelations.map((relation) => relation.evidenceId),
  );
  for (const evidence of morphology.evidence) {
    const source = evidenceSource(evidence.id, width, height);
    const relations = morphology.evidenceRelations.filter(
      (relation) => relation.evidenceId === evidence.id,
    );
    const style = authorityStyle(evidence.authority);
    if (relations.length === 0 || !linkedEvidence.has(evidence.id)) {
      context.save();
      context.translate(source.x, source.y);
      context.strokeStyle = style.color;
      context.globalAlpha = style.alpha;
      context.lineWidth = style.width;
      context.beginPath();
      context.ellipse(0, 0, 4, 10, unit(evidence.id) - 0.5, 0, Math.PI * 2);
      context.stroke();
      context.restore();
      continue;
    }
    for (const relation of relations) {
      const target = targetPoint(
        relation.targetId,
        morphology,
        candidates,
        width,
        height,
      );
      if (!target) continue;
      const focused =
        focusedIds.has(evidence.id) || focusedIds.has(relation.targetId);
      context.save();
      context.strokeStyle = relation.kind === 'refutes' ? WOUND : style.color;
      context.globalAlpha = focused ? 1 : style.alpha;
      context.lineWidth = focused ? style.width + 1 : style.width;
      context.setLineDash(style.dash);
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.stroke();
      context.setLineDash([]);
      const angle = Math.atan2(target.y - source.y, target.x - source.x);
      context.fillStyle = relation.kind === 'refutes' ? WOUND : style.color;
      context.beginPath();
      context.moveTo(target.x, target.y);
      context.lineTo(
        target.x - Math.cos(angle - 0.35) * 8,
        target.y - Math.sin(angle - 0.35) * 8,
      );
      context.lineTo(
        target.x - Math.cos(angle + 0.35) * 8,
        target.y - Math.sin(angle + 0.35) * 8,
      );
      context.closePath();
      context.fill();
      context.restore();
    }
  }
}

function drawScars(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  candidates: Map<string, CandidatePoint>,
  width: number,
  height: number,
) {
  for (const scar of morphology.scars) {
    const subject = candidates.get(scar.subjectId) ?? {
      x: width * (0.32 + unit(`${scar.id}:x`) * 0.36),
      y: height * (0.3 + unit(`${scar.id}:y`) * 0.42),
    };
    const angle = (unit(`${scar.id}:angle`) - 0.5) * 2.4;
    const length = 11 + unit(`${scar.id}:length`) * 18;
    context.save();
    context.translate(subject.x, subject.y);
    context.rotate(angle);
    context.strokeStyle = WOUND;
    context.lineWidth = 1.15;
    context.beginPath();
    context.moveTo(-length / 2, 0);
    context.lineTo(-length * 0.12, -2);
    context.lineTo(length * 0.08, 2.8);
    context.lineTo(length / 2, -1);
    context.stroke();
    context.restore();
  }
  if (morphology.scarBurden.anonymousNurseryCount > 0) {
    const burden = Math.log2(morphology.scarBurden.anonymousNurseryCount + 1);
    context.save();
    context.fillStyle = `rgba(49, 18, 25, ${clamp(0.12 + burden * 0.055, 0.12, 0.48)})`;
    context.beginPath();
    context.ellipse(
      width * 0.52,
      height * 0.83,
      45 + burden * 11,
      5 + burden * 2.5,
      -0.08,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
  }
}

function drawNovelty(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  width: number,
  height: number,
) {
  const exact = morphology.novelty.exactContent;
  const archive = morphology.novelty.assayArchive;
  if (exact.distinctHypotheses !== null) {
    const count = Math.min(12, exact.distinctHypotheses);
    const age = exact.yieldAge ?? 0;
    context.save();
    for (let index = 0; index < count; index += 1) {
      const angle =
        -Math.PI * 0.9 + (index / Math.max(1, count - 1)) * Math.PI * 0.8;
      const radius = 42 + index * 3.4;
      const x = width * 0.16 + Math.cos(angle) * radius;
      const y = height * 0.82 + Math.sin(angle) * radius * 0.55;
      context.fillStyle =
        age === 0 ? 'rgba(216, 215, 207, 0.42)' : 'rgba(216, 215, 207, 0.18)';
      context.beginPath();
      context.ellipse(
        x,
        y,
        1.2 + unit(`exact:${index}`) * 2,
        4 + unit(`exact-y:${index}`) * 5,
        angle,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.restore();
  }
  if (archive.measuredEntries !== null) {
    const facets = Math.min(9, archive.occupiedNiches ?? 0);
    const center = { x: width * 0.84, y: height * 0.82 };
    context.save();
    context.strokeStyle =
      archive.state === 'novel' ? 'rgba(130, 157, 161, 0.55)' : GLASS;
    context.lineWidth = 0.75;
    for (let index = 0; index < facets; index += 1) {
      const angle =
        (index / Math.max(1, facets)) * Math.PI * 2 +
        unit(`archive:${index}`) * 0.22;
      const radius = 13 + index * 4;
      context.beginPath();
      context.moveTo(center.x, center.y);
      context.lineTo(
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius * 0.48,
      );
      context.stroke();
    }
    context.restore();
  }
}

function drawIntegrity(
  context: CanvasRenderingContext2D,
  morphology: ChamberMorphology,
  width: number,
  height: number,
) {
  if (morphology.continuity.state === 'broken') {
    const offset =
      unit(`shear:${morphology.continuity.acceptedThrough}`) * width * 0.15;
    context.save();
    context.strokeStyle = VOID;
    context.lineWidth = 13;
    context.beginPath();
    context.moveTo(width * 0.2 + offset, height * 0.08);
    context.lineTo(width * 0.64 + offset, height * 0.92);
    context.stroke();
    context.strokeStyle = WOUND;
    context.lineWidth = 1.6;
    context.stroke();
    context.restore();
  }
  if (morphology.stillness.signedBeforeTermination) {
    const y = height * 0.885;
    const start = { x: width * 0.405, y: y + 3 };
    const controlOne = { x: width * 0.455, y: y - 10 };
    const controlTwo = { x: width * 0.54, y: y + 12 };
    const end = { x: width * 0.595, y: y - 2 };
    context.save();
    context.strokeStyle = BONE;
    context.lineWidth = 1.2;
    curve(context, start, controlOne, controlTwo, end);
    context.stroke();
    for (let index = 0; index < 9; index += 1) {
      const t = (index + 0.5) / 9;
      const point = pointOnCubic(start, controlOne, controlTwo, end, t);
      context.beginPath();
      context.moveTo(point.x - 3, point.y - 5);
      context.lineTo(point.x + 3, point.y + 5);
      context.stroke();
    }
    context.restore();
  }
}

function focusEntities(morphology: ChamberMorphology, sequence?: number) {
  if (sequence === undefined) return new Set<string>();
  return new Set(
    morphology.signals
      .filter((signal) => signal.sequence === sequence)
      .flatMap((signal) => signal.entityIds),
  );
}

function accessibilityLabel(morphology: ChamberMorphology, sealed: boolean) {
  if (!sealed) return 'Jevyr is dormant. One incision waits for a sealed Cast.';
  const unresolved = morphology.unresolvedObligationIds.length;
  const scars = morphology.scarBurden.minimumDistinctCount;
  const pressure = morphology.resourcePressure.maximumKnownPressure;
  const pressureText =
    pressure === null
      ? 'resource pressure unmeasured'
      : `maximum measured resource pressure ${Math.round(pressure * 100)} percent`;
  return [
    `Jevyr causal chamber at public cursor ${morphology.cursor}.`,
    `${morphology.candidates.length} candidates in ${morphology.lineages.length} lineages.`,
    `${morphology.evidence.length} evidence observations and ${unresolved} unresolved obligations.`,
    `${scars} minimum scars; ${pressureText}.`,
    `Continuity ${morphology.continuity.state}; motion ${morphology.stillness.motion}.`,
  ].join(' ');
}

function render(
  canvas: HTMLCanvasElement,
  morphology: ChamberMorphology,
  sealed: boolean,
  focusSequence: number | undefined,
  phase: number,
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const requiredWidth = Math.max(1, Math.round(width * ratio));
  const requiredHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== requiredWidth || canvas.height !== requiredHeight) {
    canvas.width = requiredWidth;
    canvas.height = requiredHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const identity = `${morphology.continuity.caseDigest ?? 'uncast'}:${morphology.continuity.runDigest ?? 'no-run'}`;
  drawVoid(context, width, height, identity);
  if (!sealed) {
    drawIncision(context, width, height, false);
    return;
  }

  drawPressureBody(context, morphology, width, height, phase);
  const candidates = candidateLayout(morphology, width, height);
  const focusedIds = focusEntities(morphology, focusSequence);
  drawLineages(context, morphology, candidates, phase, focusedIds);
  drawCandidates(context, morphology, candidates, focusedIds);
  if (morphology.candidates.length === 0)
    drawIncision(context, width, height, true);
  drawObligations(context, morphology, candidates, width, height, focusedIds);
  drawEvidence(context, morphology, candidates, width, height, focusedIds);
  drawScars(context, morphology, candidates, width, height);
  drawNovelty(context, morphology, width, height);
  drawIntegrity(context, morphology, width, height);
}

export function JevyrSubstrate(props: JevyrSubstrateProps) {
  const { events, sealed, focusSequence, stopped = false, morphology } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const causal = useMemo(
    () => morphology ?? deriveEventMorphology(events),
    [events, morphology],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const arrested =
      stopped ||
      causal.stillness.motion === 'arrested' ||
      reducedMotion.matches;
    const terminalSeed = `${causal.continuity.caseDigest ?? 'case'}:${causal.continuity.runDigest ?? 'run'}:${causal.stillness.terminalSequence ?? causal.cursor}`;
    const staticPhase = unit(terminalSeed) * Math.PI * 2;
    let frame = 0;

    const drawStatic = () =>
      render(canvas, causal, sealed, focusSequence, staticPhase);
    const drawLive = (time: number) => {
      render(canvas, causal, sealed, focusSequence, time / 1000);
      frame = window.requestAnimationFrame(drawLive);
    };
    if (arrested) drawStatic();
    else frame = window.requestAnimationFrame(drawLive);

    const observer = new ResizeObserver(() => {
      if (arrested) drawStatic();
    });
    observer.observe(canvas);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [causal, focusSequence, sealed, stopped]);

  return (
    <canvas
      ref={canvasRef}
      className="jevyr-substrate"
      aria-label={accessibilityLabel(causal, sealed)}
    >
      {accessibilityLabel(causal, sealed)}
    </canvas>
  );
}
