import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";

export type EvidenceNodeKind = "claim" | "observation" | "artifact" | "action" | "assay" | "candidate" | "subject_snapshot";
export type EvidenceAuthority = "memory_hint" | "model_report" | "peer_report" | "artifact_inspection" | "deterministic_tool" | "subject_snapshot" | "sandbox_execution" | "original_subject_assertions";
export type EvidenceEdgeKind = "supports" | "refutes" | "derived_from" | "observes" | "produced_by" | "tests" | "contradicts" | "duplicates";

export const AUTHORITY_WEIGHT: Readonly<Record<EvidenceAuthority, number>> = Object.freeze({
  memory_hint: 0,
  model_report: 0,
  peer_report: 0,
  artifact_inspection: 0,
  deterministic_tool: 0,
  subject_snapshot: 0,
  sandbox_execution: 5,
  original_subject_assertions: 5,
});

/**
 * Only a sandbox execution has a durable, typed oracle substrate that the
 * runtime can independently replay before crystallization. Other node kinds
 * remain useful public facts, but an edge attached to one is never verdict
 * authority merely because an event or caller assigned it a persuasive label.
 */
function hasVerdictEdgeAuthority(node: EvidenceNode | undefined): boolean {
  return node?.authority === "sandbox_execution";
}

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  authority: EvidenceAuthority;
  summary: string;
  contentDigest: string;
  candidateId?: string;
  obligationId?: string;
  metadata?: JsonValue;
}

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  kind: EvidenceEdgeKind;
  summary?: string;
}

export interface EvidenceSnapshot {
  nodes: readonly EvidenceNode[];
  edges: readonly EvidenceEdge[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class EvidenceGraph {
  readonly #nodes = new Map<string, EvidenceNode>();
  readonly #edges = new Map<string, EvidenceEdge>();
  // This ephemeral admission is reconstructed from authenticated event tuples.
  // Loading a serialized graph or assigning a node label cannot restore it.
  readonly #originalSubjectEdges = new Set<string>();

  addNode(node: EvidenceNode): void {
    if (!node.id.trim()) throw new TypeError("Evidence node id is required");
    if (!isSha256Digest(node.contentDigest)) throw new TypeError(`Evidence node ${node.id} lacks a content digest`);
    if (this.#nodes.has(node.id)) throw new Error(`Evidence node ${node.id} is append-only and already exists`);
    this.#nodes.set(node.id, Object.freeze(clone(node)));
  }

  addEdge(edge: EvidenceEdge): void {
    if (this.#edges.has(edge.id)) throw new Error(`Evidence edge ${edge.id} is append-only and already exists`);
    if (!this.#nodes.has(edge.from)) throw new Error(`Evidence edge ${edge.id} has unknown source ${edge.from}`);
    if (!this.#nodes.has(edge.to)) throw new Error(`Evidence edge ${edge.id} has unknown target ${edge.to}`);
    this.#edges.set(edge.id, Object.freeze(clone(edge)));
  }

  /** Projection-only authority boundary, after an exact independent tuple match. */
  addVerifiedOriginalSubjectEdge(edge: EvidenceEdge): void {
    if (this.#nodes.get(edge.from)?.authority !== "original_subject_assertions" || !["supports", "refutes"].includes(edge.kind)) throw new TypeError("Original-subject edge has the wrong substrate");
    this.addEdge(edge); this.#originalSubjectEdges.add(edge.id);
  }

  node(id: string): EvidenceNode | undefined {
    const value = this.#nodes.get(id);
    return value === undefined ? undefined : clone(value);
  }

  incoming(id: string, kind?: EvidenceEdgeKind): readonly EvidenceEdge[] {
    return [...this.#edges.values()]
      .filter((edge) => edge.to === id && (kind === undefined || edge.kind === kind))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  outgoing(id: string, kind?: EvidenceEdgeKind): readonly EvidenceEdge[] {
    return [...this.#edges.values()]
      .filter((edge) => edge.from === id && (kind === undefined || edge.kind === kind))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  strongestSupport(targetId: string, originalSubject = false): { weight: number; evidenceIds: readonly string[] } {
    const supports = this.incoming(targetId, "supports")
      .filter(edge => originalSubject ? this.#nodes.get(edge.from)?.authority === "original_subject_assertions" && this.#originalSubjectEdges.has(edge.id) : this.#nodes.get(edge.from)?.authority !== "original_subject_assertions")
      .map((edge) => this.#nodes.get(edge.from))
      .filter((node): node is EvidenceNode => originalSubject ? node?.authority === "original_subject_assertions" : hasVerdictEdgeAuthority(node));
    const weight = supports.reduce((maximum, node) => Math.max(maximum, AUTHORITY_WEIGHT[node.authority]), 0);
    return { weight, evidenceIds: supports.filter((node) => AUTHORITY_WEIGHT[node.authority] === weight).map((node) => node.id).sort() };
  }

  strongestRefutation(targetId: string, originalSubject = false): { weight: number; evidenceIds: readonly string[] } {
    const refutes = this.incoming(targetId, "refutes")
      .filter(edge => originalSubject ? this.#nodes.get(edge.from)?.authority === "original_subject_assertions" && this.#originalSubjectEdges.has(edge.id) : this.#nodes.get(edge.from)?.authority !== "original_subject_assertions")
      .map((edge) => this.#nodes.get(edge.from))
      .filter((node): node is EvidenceNode => originalSubject ? node?.authority === "original_subject_assertions" : hasVerdictEdgeAuthority(node));
    const weight = refutes.reduce((maximum, node) => Math.max(maximum, AUTHORITY_WEIGHT[node.authority]), 0);
    return { weight, evidenceIds: refutes.filter((node) => AUTHORITY_WEIGHT[node.authority] === weight).map((node) => node.id).sort() };
  }

  snapshot(): EvidenceSnapshot {
    return {
      nodes: [...this.#nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone),
      edges: [...this.#edges.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone),
    };
  }

  /** Preserve existing admission while perturbing display prose only. An
   * unauthenticated serialized graph cannot acquire authority through this. */
  withDisplaySummaries(summaries: ReadonlyMap<string, string>): EvidenceGraph {
    for (const [id, summary] of summaries) if (!this.#nodes.has(id) || typeof summary !== "string") throw new TypeError("Display summary refers to an unknown node or non-text value");
    const graph = new EvidenceGraph();
    for (const node of this.#nodes.values()) graph.addNode({ ...node, summary: summaries.get(node.id) ?? node.summary });
    for (const edge of this.#edges.values()) {
      if (this.#originalSubjectEdges.has(edge.id)) graph.addVerifiedOriginalSubjectEdge(edge); else graph.addEdge(edge);
    }
    return graph;
  }

  digest(): string {
    return digestJson(this.snapshot() as unknown as JsonValue);
  }

  static from(snapshot: EvidenceSnapshot): EvidenceGraph {
    const graph = new EvidenceGraph();
    for (const node of snapshot.nodes) graph.addNode(node);
    for (const edge of snapshot.edges) graph.addEdge(edge);
    return graph;
  }
}
