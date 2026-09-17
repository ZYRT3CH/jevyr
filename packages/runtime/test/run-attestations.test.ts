import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalRecordText, deriveRunStatements, RUN_ATTESTATIONS_PROTOCOL, sha256Digest, type RunAttestations } from "@jevyr/protocol";
import { decodeDsseJson } from "@jevyr/core";
import { CaseRepository, FileEventHub, JevyrOrchestrator, RuleMindAdapter, SealedForgeAdapter } from "../src/index.js";

test("Bone terminal commitment produces fixed dual in-toto sidecars before publication, without extending public signer authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-run-attestations-"));
  try {
    const repository = new CaseRepository(root, { runAttestations: RUN_ATTESTATIONS_PROTOCOL });
    const orchestrator = new JevyrOrchestrator({ repository, events:new FileEventHub(root), minds:[new RuleMindAdapter()], forge:new SealedForgeAdapter({mode:"observe-only"}) });
    const created = await orchestrator.cast({protocol:"jevyr.case/1",case:{impulse:"Preserve fixed production provenance"}});
    await orchestrator.waitForTerminal(created.caseId,10_000);
    const result = await repository.runAttestations(created.caseId), record = await repository.record(created.caseId), terminal = await repository.terminalReceipt(created.caseId), trust = await repository.publicTrustBundle();
    assert.ok(result && record && terminal);
    const expected = deriveRunStatements(created.receipt, record, terminal, trust.keys[0]!.keyId);
    assert.deepEqual(decodeDsseJson(result.production),expected.production);
    assert.deepEqual(decodeDsseJson(result.advisory),expected.advisory);
    assert.equal(expected.production.subject[0]!.digest.sha256, sha256Digest(canonicalRecordText(record)).slice(7));
    assert.equal(trust.keys[0]!.payloadTypes.length,3);
    assert.equal((await repository.artifacts(created.caseId)).some(entry=>entry.name.includes("attestation")),false);
    await assert.rejects(Reflect.apply(repository.writeTerminalReceipt,repository,[created.caseId,{}]),/unforgeable/u);
    assert.equal(Object.getOwnPropertyNames(CaseRepository.prototype).some(name=>/sign.*[Aa]ttestation|write.*[Aa]ttestation/u.test(name)),false);
    const path = join(root,"cases",created.caseId,"run-attestations.json"), bytes = await readFile(path);
    const forged = JSON.parse(bytes.toString()) as RunAttestations;
    forged.production.signatures[0]!.sig = Buffer.alloc(64).toString("base64");
    await writeFile(path,JSON.stringify(forged));
    await assert.rejects(repository.runAttestations(created.caseId),/signer|payload/u);
    await writeFile(path,bytes); await unlink(path);
    await assert.rejects(repository.runAttestations(created.caseId),/missing/u);
  } finally { await rm(root,{recursive:true,force:true}); }
});
