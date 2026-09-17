import { decodeDsseJson, formalProofReplayOptions, replayCase, verifyDsse, verifyEventChain, JEVYR_BONE_DIGEST, SEAL_DSSE_PAYLOAD_TYPE, RECORD_DSSE_PAYLOAD_TYPE, TERMINAL_DSSE_PAYLOAD_TYPE } from "@jevyr/core";
import { canonicalize, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { verifyPersistedAssayEvidence, type AssayFrontier } from "@jevyr/runtime";
import { RepositorySelfJudge, selfJudgeOptions, type SelfJudgeFailure } from "./self-judge.js";
import { createSelfJudgeProposalRecorder } from "./self-judge-proposals.js";
import type { DaemonRuntime } from "./runtime.js";
import { selectedStartupBone } from "./genome-startup.js";

const json = (value: unknown) => value as JsonValue;
/** Ordinary signed Cases plus independent evidence replay. No special self-verdict. */
export function createRuntimeSelfJudge(runtime: DaemonRuntime, env: NodeJS.ProcessEnv): RepositorySelfJudge {
  const records = new Map<string, string>();
  const recordProposal = createSelfJudgeProposalRecorder({ registryRoot: runtime.genome.registryRoot, boneDigest: selectedStartupBone(runtime.genome).boneDigest,
    sourceGenomeDigest: runtime.repository.genomeDigest, ...(runtime.genome.active ? { activeGenome: runtime.genome.active.genome } : {}) });
  return new RepositorySelfJudge(selfJudgeOptions(env, runtime.projectRoot), {
    async runCase({ submission, signal }) {
      signal.throwIfAborted();
      const created = await runtime.orchestrator.cast(submission);
      const stop = () => { runtime.orchestrator.abort(created.caseId); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      try {
        await runtime.orchestrator.waitForTerminal(created.caseId, created.sealed.searchEnvelope.profile.resources.maxWallMillis + 60_000);
        const [record, recordEnvelope, sealEnvelope, terminal, terminalEnvelope, events, trust, artifacts] = await Promise.all([
          runtime.repository.record(created.caseId), runtime.repository.recordEnvelope(created.caseId), runtime.repository.sealEnvelope(created.caseId),
          runtime.repository.terminalReceipt(created.caseId), runtime.repository.terminalEnvelope(created.caseId), runtime.events.read(created.caseId),
          runtime.repository.publicTrustBundle(), runtime.repository.artifacts(created.caseId),
        ]);
        if (!record || !recordEnvelope || !sealEnvelope || !terminal || !terminalEnvelope) throw new Error("Self-judgment did not close with all three authoritative signatures");
        const keys = new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem]));
        for (const [payload, envelope, purpose] of [[created.receipt, sealEnvelope, SEAL_DSSE_PAYLOAD_TYPE], [record, recordEnvelope, RECORD_DSSE_PAYLOAD_TYPE], [terminal, terminalEnvelope, TERMINAL_DSSE_PAYLOAD_TYPE]] as const) {
          if (envelope.payloadType !== purpose || !verifyDsse(envelope, keys) || canonicalize(json(decodeDsseJson(envelope))) !== canonicalize(json(payload))) throw new Error("Self-judgment signature or payload mismatch");
        }
        const chain = verifyEventChain(events), anchor = events.findIndex(event => event.eventDigest === record.eventHeadDigest);
        if (!chain.valid || anchor < 0 || events.at(-1)?.eventDigest !== terminal.eventHeadDigest || record.caseDigest !== created.sealed.caseDigest || record.runDigest !== created.sealed.runDigest)
          throw new Error("Self-judgment ledger or closure binding failed");
        const policy = (await runtime.repository.descriptor(created.sealed.policyDigest))?.descriptor;
        if (!policy || digestJson(policy) !== created.sealed.policyDigest) throw new Error("Self-judgment policy descriptor is unavailable");
        const frontier = (policy as any).policy.assayFrontier as AssayFrontier;
        const prefix = events.slice(0, anchor + 1);
        const evidence = await verifyPersistedAssayEvidence(prefix, created.sealed.intentContract, frontier, policy, async digest => {
          const meta = artifacts.find(item => item.digest === digest);
          if (!meta) return undefined;
          const value = await runtime.repository.artifact(created.caseId, meta.id);
          if (!value || sha256Digest(value.data) !== digest) throw new Error("Self-judgment evidence artifact changed");
          return value.data;
        }, { trustedRecordKeys: keys, originalSubject: { sealedCase: created.sealed, sealEnvelope, trustedCaseKeys: keys } });
        const replay = replayCase(prefix, { policyVersion: record.verdict.policyVersion, intentContract: created.sealed.intentContract,
          verifiedEvidenceEdges: evidence.verifiedAuthorityEdges, verifiedOriginalSubjectEdges: evidence.verifiedOriginalSubjectEdges,
          ...(evidence.originalSubjectContext ? { originalSubjectContext: evidence.originalSubjectContext } : {}), ...formalProofReplayOptions(policy) });
        const proofVerified = evidence.replayComplete && replay.crystallizable && canonicalize(json(replay.verdict)) === canonicalize(json(record.verdict));
        const failures = (onlyCritical: boolean): SelfJudgeFailure[] => {
          if (!proofVerified) return [];
          const critical = new Set(created.sealed.intentContract.criticalObligations.map(obligation => obligation.id));
          const rows: SelfJudgeFailure[] = [];
          for (const basis of record.verdict.basis) for (const edge of [...evidence.verifiedAuthorityEdges, ...evidence.verifiedOriginalSubjectEdges]) {
            if (edge.kind !== "refutes" || !basis.evidenceIds.includes(edge.evidenceId) || onlyCritical && !critical.has(edge.targetId)) continue;
            rows.push({ code: basis.code, evidenceDigest: edge.contentDigest });
          }
          // Before a flagship is selected, failed candidate assays have no global
          // obligation-authority edge. The independently replayed closed-population
          // basis can still cite their exact sealed, critical, decisive observations.
          for (const basis of record.verdict.basis) {
            if (basis.code !== "ADMITTED_POPULATION_EXHAUSTED") continue;
            for (const entry of evidence.evidence) {
              if (entry.status !== "VERIFIED" || entry.aggregateAdmissible !== true || entry.recordedTypedStatus !== "FAILED"
                || entry.evaluation?.status !== "FAILED" || !entry.evaluation.decisive || !entry.obligationId || !critical.has(entry.obligationId)
                || entry.evaluation.obligationId !== entry.obligationId || !entry.candidateId || !basis.candidateIds?.includes(entry.candidateId)
                || !basis.evidenceIds.includes(entry.evidenceId) || !entry.contentDigest) continue;
              rows.push({ code: basis.code, evidenceDigest: entry.contentDigest });
            }
          }
          if (!onlyCritical) for (const event of prefix) {
            if (event.actor.kind !== "kernel" || event.actor.id !== "jevyr.bone" || event.kind !== "action.status" || event.payload.status !== "failed"
              || !["integrity.sandbox_failure", "integrity.provider_failure", "integrity.capability_loss"].includes(event.payload.actionType)) continue;
            const code = `INTEGRITY_${event.payload.actionType.slice("integrity.".length).toUpperCase()}`;
            if (record.verdict.basis.some(basis => basis.code === code && basis.summary === event.payload.summary)) rows.push({ code, evidenceDigest: event.eventDigest });
          }
          return [...new Map(rows.map(row => [`${row.code}:${row.evidenceDigest}`, row])).values()].slice(0, 64);
        };
        records.set(created.caseId, digestJson(json(record)));
        return { caseId: created.caseId, runDigest: created.sealed.runDigest, proofVerified, integrity: record.verdict.integrity,
          ...(record.verdict.judgment !== "NOT_APPLICABLE" ? { judgment: record.verdict.judgment } : {}),
          bindingFailures: record.verdict.integrity === "INVALID" ? failures(false) : [],
          reproducedDefects: record.verdict.judgment === "REJECT" ? failures(true) : [] };
      } finally { signal.removeEventListener("abort", stop); }
    },
    async proposeOffspring(input) { const recordDigest = records.get(input.caseId); await recordProposal({ ...input, ...(recordDigest ? { recordDigest } : {}) }); },
    onActivity(event) { if (event.caseId) records.delete(event.caseId); process.stderr.write(`${JSON.stringify({ protocol: "jevyr.self-judgment-activity/1", ...event })}\n`); },
  });
}
