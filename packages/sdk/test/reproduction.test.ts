import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DsseEnvelope, PublicTrustBundle, SealReceipt } from "@jevyr/protocol";
import { JevyrClient } from "../src/client.js";
import { canonicalJson } from "../src/digest.js";
import { dssePae, RECORD_DSSE_PAYLOAD_TYPE, SEAL_DSSE_PAYLOAD_TYPE, TERMINAL_DSSE_PAYLOAD_TYPE } from "../src/trust.js";

const hash=(character:string)=>`sha256:${character.repeat(64)}`;
function fixture() {
  const pair=generateKeyPairSync("ed25519"),keyId=`sha256:${createHash("sha256").update(pair.publicKey.export({type:"spki",format:"der"})).digest("hex")}`;
  const trust:PublicTrustBundle={protocol:"jevyr.trust-bundle/1",keys:[{keyId,algorithm:"Ed25519",publicKeyPem:pair.publicKey.export({type:"spki",format:"pem"}).toString(),payloadTypes:[SEAL_DSSE_PAYLOAD_TYPE,RECORD_DSSE_PAYLOAD_TYPE,TERMINAL_DSSE_PAYLOAD_TYPE]}]};
  const source:SealReceipt={protocol:"jevyr.seal/1",caseId:"case_3333333333333333",submissionDigest:hash("1"),subjectMaterialCaptureDigest:hash("0"),caseDigest:hash("2"),runDigest:hash("3"),sealedAt:"2026-09-04T00:00:00.000Z",policyVersion:"jevyr.bone/1",policyDigest:hash("4"),genomeVersion:"jevyr.genome/1",genomeDigest:hash("5"),searchDigest:hash("6"),intentContractDigest:hash("a")};
  const reproduced:SealReceipt={...source,caseId:"case_7777777777777777",runDigest:hash("7"),sealedAt:"2026-09-05T00:00:00.000Z"};
  const envelope=(receipt:SealReceipt):DsseEnvelope=>{const payload=Buffer.from(canonicalJson(receipt));return{payloadType:SEAL_DSSE_PAYLOAD_TYPE,payload:payload.toString("base64"),signatures:[{keyid:keyId,sig:sign(null,dssePae(SEAL_DSSE_PAYLOAD_TYPE,payload),pair.privateKey).toString("base64")}]};};
  const routes:Record<string,unknown>={"/v1/trust":trust,[`/v1/cases/${source.caseId}/seal`]:source,[`/v1/cases/${source.caseId}/seal/envelope`]:envelope(source),[`/v1/cases/${reproduced.caseId}/seal`]:reproduced,[`/v1/cases/${reproduced.caseId}/seal/envelope`]:envelope(reproduced),"/v1/reproductions":reproduced};
  const fetcher=vi.fn<typeof fetch>(async(url)=>{const path=new URL(String(url)).pathname;return Object.hasOwn(routes,path)?new Response(JSON.stringify(routes[path])):new Response("missing",{status:404});});
  const client=new JevyrClient({baseUrl:"http://fixture",fetch:fetcher});
  const posts=()=>fetcher.mock.calls.filter(([,init])=>init?.method==="POST");
  return{client,fetcher,routes,source,reproduced,envelope,posts};
}

describe("authenticated frozen reproduction",()=>{
  it("verifies both actual Seal signatures before returning and posts the finite request once",async()=>{
    const f=fixture();await expect(f.client.reproduceCase(f.source.caseId,"same")).resolves.toEqual(f.reproduced);
    expect(f.posts()).toHaveLength(1);expect(JSON.parse(String(f.posts()[0]![1]!.body))).toEqual({sourceCaseId:f.source.caseId,seed:"same"});
    expect(f.fetcher.mock.calls.map(([url])=>new URL(String(url)).pathname)).toContain(`/v1/cases/${f.reproduced.caseId}/seal/envelope`);
  });
  it("refuses a tampered new signature and does not retry the Cast",async()=>{
    const f=fixture();const envelope=f.envelope(f.reproduced);envelope.signatures[0]!.sig=Buffer.alloc(64).toString("base64");f.routes[`/v1/cases/${f.reproduced.caseId}/seal/envelope`]=envelope;
    await expect(f.client.reproduceCase(f.source.caseId,"same")).rejects.toThrow(/signature/u);expect(f.posts()).toHaveLength(1);
  });
  it("requires the returned receipt to equal the authenticated receipt exactly",async()=>{
    const f=fixture();f.routes["/v1/reproductions"]={...f.reproduced,submissionDigest:hash("8")};
    await expect(f.client.reproduceCase(f.source.caseId,"same")).rejects.toThrow("differs from its authenticated Seal");expect(f.posts()).toHaveLength(1);
  });
  it("does not dispatch when source authentication fails and rejects recaptured materials",async()=>{
    const bad=fixture();delete bad.routes[`/v1/cases/${bad.source.caseId}/seal/envelope`];await expect(bad.client.reproduceCase(bad.source.caseId,"same")).rejects.toThrow();expect(bad.posts()).toHaveLength(0);
    const changed=fixture();changed.routes["/v1/reproductions"]={...changed.reproduced,subjectMaterialCaptureDigest:hash("9")};
    await expect(changed.client.reproduceCase(changed.source.caseId,"new")).rejects.toThrow("controlled input");expect(changed.posts()).toHaveLength(1);
  });
});
