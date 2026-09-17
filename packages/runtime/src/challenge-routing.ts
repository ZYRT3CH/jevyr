import { digestJson, type IntentContract, type JsonValue } from "@jevyr/protocol";
import type { CapabilityCard } from "./contracts.js";

export interface InvestigatorIdentity { readonly adapterId: string; readonly providerId: string | null; readonly modelId: string | null; readonly family: string | null; readonly familyAssurance: "configured" | "unavailable" }
export function investigatorIdentity(card: CapabilityCard): InvestigatorIdentity {
  const value = (key: string): string | null => typeof card.limits?.[key] === "string" ? String(card.limits[key]) : null;
  const family = value("modelFamily");
  return Object.freeze({ adapterId: card.id, providerId: value("providerId"), modelId: value("modelId"), family, familyAssurance: family ? "configured" : "unavailable" });
}

export interface ChallengeAssignment {
  readonly adapterId: string;
  readonly obligationIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly identity: InvestigatorIdentity;
}
export interface ChallengeRouting {
  readonly protocol: "jevyr.critical-challenge-routing/1";
  readonly assignments: readonly ChallengeAssignment[];
  readonly coverage: readonly { obligationId: string; adapterIds: readonly string[]; crossFamily: boolean; crossProvider: boolean }[];
  readonly limitations: readonly string[];
  readonly authority: "investigation-assignment-only";
  readonly digest: string;
}

/** Families are configured provenance, never guessed from model marketing names or generated prose. */
export function routeCriticalChallenges(contract: IntentContract, cards: readonly CapabilityCard[], candidateOrigins: ReadonlyMap<string, string>, invocationCeiling: number): ChallengeRouting {
  const identities = cards.map(investigatorIdentity);
  const selected: InvestigatorIdentity[] = [];
  const pending = [...identities];
  while (pending.length && selected.length < invocationCeiling) {
    pending.sort((a, b) => {
      const diversity = (entry: InvestigatorIdentity) => (entry.family && !selected.some(other => other.family === entry.family) ? 4 : 0) + (entry.providerId && !selected.some(other => other.providerId === entry.providerId) ? 2 : 0) + (entry.modelId && !selected.some(other => other.modelId === entry.modelId) ? 1 : 0);
      return diversity(b) - diversity(a) || identities.indexOf(a) - identities.indexOf(b);
    });
    selected.push(pending.shift()!);
  }
  const obligations = contract.criticalObligations.map(obligation => obligation.id);
  const assignments = selected.map(identity => Object.freeze({ adapterId: identity.adapterId, obligationIds: Object.freeze([...obligations]), candidateIds: Object.freeze([...candidateOrigins].filter(([, origin]) => {
    const author = identities.find(entry => entry.adapterId === origin);
    return origin !== identity.adapterId && (!author?.family || !identity.family || author.family !== identity.family);
  }).map(([id]) => id).sort()), identity }));
  const crossFamily = new Set(selected.flatMap(identity => identity.family ? [identity.family] : [])).size >= 2;
  const crossProvider = new Set(selected.flatMap(identity => identity.providerId ? [identity.providerId] : [])).size >= 2;
  const limitations = [
    ...(selected.length < 2 ? ["Fewer than two investigators fit the remaining sealed challenge budget."] : []),
    ...(!crossFamily ? ["Two separately configured model families are unavailable; cross-family challenge is not established."] : []),
    ...(!crossProvider ? ["Two distinct provider identities are unavailable; independent-provider challenge is not established."] : []),
    "Configured identity diversity does not establish statistical independence or reproduce a finding. Only admitted executed evidence can bind a verdict.",
  ];
  const body = { protocol: "jevyr.critical-challenge-routing/1" as const, assignments: Object.freeze(assignments), coverage: Object.freeze(obligations.map(obligationId => ({ obligationId, adapterIds: Object.freeze(selected.map(identity => identity.adapterId)), crossFamily, crossProvider }))), limitations: Object.freeze(limitations), authority: "investigation-assignment-only" as const };
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}
