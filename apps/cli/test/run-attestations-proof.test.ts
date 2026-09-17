import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaemonRuntime, createJevyrHttpService } from "@jevyr/daemon";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { canonicalRecordText, sha256Digest } from "@jevyr/protocol";
import { JevyrClient } from "@jevyr/sdk";
import { exportLocalProof, verifyLocalProof } from "../src/local-proof.js";

describe("offline production/advisory proof export",()=>{
  it("exports the exact attested canonical bytes and refuses missing or altered required sidecars",async()=>{
    const root=await mkdtemp(join(tmpdir(),"jevyr-production-proof-"));
    const runtime=createDaemonRuntime({projectRoot:root,dataDir:join(root,"store"),env:{},minds:[new RuleMindAdapter()],forge:new SealedForgeAdapter({mode:"observe-only"})});
    const service=createJevyrHttpService({runtime,env:{}});
    try {
      const {url}=await service.listen(0),client=new JevyrClient({baseUrl:url});
      const receipt=await client.cast({case:{impulse:"Preserve reviewable production provenance",seed:"ab".repeat(32)}});
      const proof=join(root,"proof"),verified=await exportLocalProof(client,receipt.caseId,proof);
      expect(verified.valid).toBe(true);
      const attested=await client.verifiedRunAttestations(receipt.caseId),canonical=await readFile(join(proof,"canonical-record.json"));
      expect(sha256Digest(canonical).slice(7)).toBe(attested.statements.production.subject[0]!.digest.sha256);
      const record=await client.record(receipt.caseId);
      expect(canonical.toString()).toBe(canonicalRecordText(record));
      const sidecar=await readFile(join(proof,"run-attestations.json"));
      await unlink(join(proof,"run-attestations.json"));
      expect(await verifyLocalProof(proof)).toMatchObject({valid:false});
      await writeFile(join(proof,"run-attestations.json"),sidecar);
      await writeFile(join(proof,"canonical-record.json"),Buffer.concat([canonical,Buffer.from("\n")]));
      expect(await verifyLocalProof(proof)).toMatchObject({valid:false});
      await unlink(join(proof,"canonical-record.json"));await unlink(join(proof,"run-attestations.json"));
      expect(await verifyLocalProof(proof)).toMatchObject({valid:false});
    } finally {await service.close();await rm(root,{recursive:true,force:true});}
  },15_000);
});
