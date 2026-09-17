import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import type { CapabilityCard, SealedCaseContext } from "./contracts.js";

export const PHENOTYPE_ALGORITHM = "jevyr.phenotype/1" as const;
/** Investigation entropy excludes receipt timestamps. Run identity remains unique. */
export function investigationSeed(sealed: SealedCaseContext, domain: string, parts: readonly JsonValue[] = []): string {
  return digestJson({ protocol: "jevyr.investigation-seed/2", caseDigest: sealed.caseDigest,
    genomeDigest: sealed.genomeDigest, seedCommitment: sha256Digest(sealed.intent.seed), domain, parts }).slice(7);
}
export interface InvestigationPhenotype {
  readonly protocol: typeof PHENOTYPE_ALGORITHM;
  readonly caseDigest: string;
  readonly genomeDigest: string;
  readonly seedCommitment: string;
  readonly temperament: "coverage" | "economy" | "adversarial";
  readonly roster: readonly string[];
  readonly portfolio: readonly string[];
  readonly isolation: { readonly blindLineages: number; readonly commitBeforeShare: true };
  readonly scheduler: { readonly criticalWeight: number; readonly noveltyWeight: number; readonly contradictionWeight: number; readonly costExponent: number };
  readonly digest: string;
}

/** All choices are method parameters. No verdict threshold, oracle, or permission is sampled. */
export function germinatePhenotype(sealed: SealedCaseContext, minds: readonly CapabilityCard[], families: readonly string[] = []): InvestigationPhenotype {
  const seedCommitment = sha256Digest(sealed.intent.seed);
  const entropy = digestJson({ protocol: PHENOTYPE_ALGORITHM, caseDigest: sealed.caseDigest, genomeDigest: sealed.genomeDigest, seedCommitment });
  const rank = (domain: string, value: string): string => digestJson({ entropy, domain, value });
  const temperament = (["coverage", "economy", "adversarial"] as const)[Number.parseInt(entropy.slice(-4), 16) % 3]!;
  const roster = [...new Set(minds.map(mind => mind.id))].sort((a, b) => rank("roster", a).localeCompare(rank("roster", b)) || a.localeCompare(b));
  const portfolio = [...new Set(families)].sort((a, b) => rank("portfolio", a).localeCompare(rank("portfolio", b)) || a.localeCompare(b));
  const maximum = sealed.searchEnvelope.profile.nursery.independentLineages;
  const minimum = Math.min(maximum, Math.max(1, Math.min(2, roster.length)));
  const blindLineages = minimum + Number.parseInt(entropy.slice(-8, -4), 16) % (maximum - minimum + 1);
  const scheduler = temperament === "economy"
    ? { criticalWeight: 100, noveltyWeight: 2, contradictionWeight: 30, costExponent: 1.5 }
    : temperament === "adversarial"
      ? { criticalWeight: 100, noveltyWeight: 3, contradictionWeight: 70, costExponent: 1 }
      : { criticalWeight: 100, noveltyWeight: 10, contradictionWeight: 40, costExponent: 1 };
  const body = { protocol: PHENOTYPE_ALGORITHM, caseDigest: sealed.caseDigest, genomeDigest: sealed.genomeDigest, seedCommitment, temperament, roster: Object.freeze(roster), portfolio: Object.freeze(portfolio), isolation: Object.freeze({ blindLineages, commitBeforeShare: true as const }), scheduler: Object.freeze(scheduler) };
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}

export function phenotypeOrder<T>(values: readonly T[], ids: readonly string[], identity: (value: T) => string): readonly T[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  return Object.freeze([...values].sort((a, b) => (position.get(identity(a)) ?? Number.MAX_SAFE_INTEGER) - (position.get(identity(b)) ?? Number.MAX_SAFE_INTEGER) || identity(a).localeCompare(identity(b))));
}
