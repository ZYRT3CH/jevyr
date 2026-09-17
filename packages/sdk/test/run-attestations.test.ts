import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalRecordText, deriveRunStatements, digestJson, IN_TOTO_DSSE_PAYLOAD_TYPE, type JsonValue, type RunAttestations, type SealReceipt, type SignedRecord, type TerminalReceipt } from "@jevyr/protocol";
import { verifyRunAttestations } from "../src/run-attestations.js";
import { assertDsseEnvelope, dssePae, SEAL_DSSE_PAYLOAD_TYPE, RECORD_DSSE_PAYLOAD_TYPE, TERMINAL_DSSE_PAYLOAD_TYPE } from "../src/trust.js";
const hash=(value:unknown)=>digestJson(value as JsonValue);
function fixture() {
  const keys=generateKeyPairSync("ed25519"), keyId=`sha256:${createHash("sha256").update(keys.publicKey.export({type:"spki",format:"der"})).digest("hex")}`;
  const trust={protocol:"jevyr.trust-bundle/1",keys:[{keyId,algorithm:"Ed25519",publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),payloadTypes:[SEAL_DSSE_PAYLOAD_TYPE,RECORD_DSSE_PAYLOAD_TYPE,TERMINAL_DSSE_PAYLOAD_TYPE]}]};
  const seal:SealReceipt={protocol:"jevyr.seal/1",caseId:"case_3333333333333333",runDigest:`sha256:${"3".repeat(64)}`,caseDigest:hash("case"),submissionDigest:hash("submission"),subjectMaterialCaptureDigest:hash("capture"),sealedAt:"2026-09-05T00:00:00.000Z",policyVersion:"bone-v1",policyDigest:hash("policy"),genomeVersion:"genome-v1",genomeDigest:hash("genome"),searchDigest:hash("search"),intentContractDigest:hash("intent")};
  const record:SignedRecord={protocol:"jevyr.record/1",caseDigest:seal.caseDigest,runDigest:seal.runDigest,policyDigest:seal.policyDigest,genomeDigest:seal.genomeDigest,searchDigest:seal.searchDigest,intentContractDigest:seal.intentContractDigest,eventHeadDigest:hash("head"),
    verdict:{policyVersion:seal.policyVersion,intentContractDigest:seal.intentContractDigest,evidenceDigest:hash("evidence"),integrity:"VALID",creation:"NO_SURVIVOR",embodiment:"NOT_BUILT",judgment:"NOT_APPLICABLE",feasibilityByCandidate:{},basis:[]},
    reflex:{loop:1,reviewedEvidenceDigest:hash("evidence"),intentContractDigest:seal.intentContractDigest,challengedNodeIds:[],materialFindings:[],decision:"confirm"},memoryInfluences:[],crystallizedAt:"2026-09-05T00:00:01.000Z"};
  const terminal:TerminalReceipt={protocol:"jevyr.terminal/1",caseId:seal.caseId,caseDigest:seal.caseDigest,runDigest:seal.runDigest,lifecycle:"terminated",stage:"terminate",stageStatus:"completed",lastSequence:5,eventHeadDigest:hash("terminal-head"),recordDigest:hash(record),artifactIndexDigest:hash("index"),closedAt:"2026-09-05T00:00:02.000Z"};
  const envelope=(type:string,value:unknown)=>{const bytes=Buffer.from(canonicalize(value as JsonValue));return {payloadType:type,payload:bytes.toString("base64"),signatures:[{keyid:keyId,sig:sign(null,dssePae(type,bytes),keys.privateKey).toString("base64")}]};};
  const statements=deriveRunStatements(seal,record,terminal,keyId);
  const payload:RunAttestations={protocol:"jevyr.run-attestations/1",caseId:seal.caseId,runDigest:seal.runDigest,production:envelope(IN_TOTO_DSSE_PAYLOAD_TYPE,statements.production),advisory:envelope(IN_TOTO_DSSE_PAYLOAD_TYPE,statements.advisory)};
  const material={seal,record,terminal,trust,sealEnvelope:envelope(SEAL_DSSE_PAYLOAD_TYPE,seal),recordEnvelope:envelope(RECORD_DSSE_PAYLOAD_TYPE,record),terminalEnvelope:envelope(TERMINAL_DSSE_PAYLOAD_TYPE,terminal)};
  return {payload,material,statements,envelope};
}
describe("fixed production and advisory attestation verification",()=>{
  it("binds actual canonical Record bytes and retains exactly the old three trust purposes",async()=>{
    const f=fixture(), verified=await verifyRunAttestations(f.payload,f.material);
    expect(verified.verification).toBe("dsse-ed25519+exact-derived-run-statements");
    expect(f.statements.production.subject[0]!.digest.sha256).toBe(createHash("sha256").update(canonicalRecordText(f.material.record)).digest("hex"));
    expect(f.statements.production.subject[0]!.digest.sha256).not.toBe(createHash("sha256").update(JSON.stringify(f.material.record,null,2)+"\n").digest("hex"));
    expect(()=>assertDsseEnvelope(f.payload.production)).toThrow(/unsupported/u);
    expect(f.material.trust.keys[0]!.payloadTypes).toHaveLength(3);
  });
  it("rejects tampered subjects, advisory verdicts, swapped predicates, unknown fields and signatures even with otherwise valid envelopes",async()=>{
    const f=fixture();
    for (const changed of [
      {...f.payload,production:f.envelope(IN_TOTO_DSSE_PAYLOAD_TYPE,{...f.statements.production,subject:[{name:"record.json",digest:{sha256:"f".repeat(64)}}]})},
      {...f.payload,advisory:f.envelope(IN_TOTO_DSSE_PAYLOAD_TYPE,{...f.statements.advisory,predicate:{judgment:"ACCEPT"}})},
      {...f.payload,production:f.payload.advisory,advisory:f.payload.production},
      {...f.payload,message:"promote"},
    ]) await expect(verifyRunAttestations(changed,f.material)).rejects.toThrow();
    const bad=structuredClone(f.payload);bad.production.signatures[0]!.sig=Buffer.alloc(64).toString("base64");
    await expect(verifyRunAttestations(bad,f.material)).rejects.toThrow(/signature/u);
  });
  it("refuses cross-Case material, foreign signers and a widened public trust contract",async()=>{
    const f=fixture(), other=fixture();
    await expect(verifyRunAttestations({...f.payload,advisory:other.payload.advisory},f.material)).rejects.toThrow();
    await expect(verifyRunAttestations({...f.payload,caseId:"case_4444444444444444",runDigest:`sha256:${"4".repeat(64)}`},f.material)).rejects.toThrow(/Case/u);
    const widened=structuredClone(f.material);widened.trust.keys[0]!.payloadTypes.push(IN_TOTO_DSSE_PAYLOAD_TYPE as never);
    await expect(verifyRunAttestations(f.payload,widened)).rejects.toThrow(/signing contract/u);
  });
});
