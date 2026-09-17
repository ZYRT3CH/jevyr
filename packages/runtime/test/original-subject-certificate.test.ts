import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createCaseEvent, generateSigningKeyPair, JEVYR_BONE_V2_DESCRIPTOR, ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST, ORIGINAL_SUBJECT_POLICY_VERSION, sealCase, sealReceipt, signSealReceipt } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type CaseEvent, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { compileAssayFrontier } from "../src/assay-frontier.js";
import { createRepositoryPureProducerAssets } from "../src/repository-pure-producer.js";
import { createRepositoryPureExecutionPolicy, executeRepositoryPureAssertions } from "../src/repository-pure-execution.js";
import { inspectLocalDockerImage, SealedForgeAdapter, sealDockerSubstrateIdentity, type DockerSubstrateIdentity } from "../src/forge.js";
import { createOriginalSubjectCertificate, decodeOriginalSubjectCertificate, originalSubjectExecutionLimits, replayOriginalSubjectCertificates, ORIGINAL_SUBJECT_CERTIFICATE_ACTION, ORIGINAL_SUBJECT_CERTIFICATE_CHECKER, MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES, type OriginalSubjectCertificateContext } from "../src/original-subject-certificate.js";
import { verifyPersistedAssayEvidence } from "../src/evidence-replay.js";
import { replayRepositoryObservers } from "../src/repository-observer-replay.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";
const hash=(value:unknown)=>digestJson(value as JsonValue), bytes=(value:unknown)=>Buffer.from(canonicalize(value as JsonValue));
const assetsPromise=createRepositoryPureProducerAssets();
const synthetic=sealDockerSubstrateIdentity("node:24-alpine",{status:"resolved",imageId:sha256Digest("synthetic fixture image; no execution claim")},"local-docker-cli");
async function fixture(identity: DockerSubstrateIdentity=synthetic, outcome:"match"|"mismatch"|"unavailable"="match", aggregateWallMillis=60_000,impulse="Existing tests must pass.") {
  const assets=await assetsPromise, factory=createRepositoryPureExecutionPolicy(assets,identity), keys=generateSigningKeyPair();
  const resources={...DEFAULT_SEARCH_PROFILE.resources,maxWritableBytes:1_000_000,maxWritableInodes:100,maxArtifactBytes:20_000_000,maxForgeWallMillis:60_000};
  const frontier=compileAssayFrontier([],{...resources,maxForgeWallMillis:aggregateWallMillis}), selection={runtimeCompilation:{bone:JEVYR_BONE_V2_DESCRIPTOR,boneDigest:hash(JEVYR_BONE_V2_DESCRIPTOR)}};
  const policyDescriptor={protocol:"jevyr.policy-descriptor/1",version:ORIGINAL_SUBJECT_POLICY_VERSION,policy:{protocol:"jevyr.effective-policy/1",repositoryPureAssertions:factory,originalSubjectCertificateChecker:ORIGINAL_SUBJECT_CERTIFICATE_CHECKER,
    genomeSelection:selection,genomeSelectionDigest:hash(selection),assayFrontier:frontier,
    forgeSubstrateIdentity:{protocol:"jevyr.forge-substrate-binding/1",adapterBoundary:"built-in",mode:"docker",requestedReference:identity.requestedReference,status:"resolved",immutableImageId:identity.immutableImageId,resolutionAuthority:"local-docker-cli",failure:null},
    effectiveForgeConfig:{mode:"docker",dockerCommand:null,dockerImage:identity.requestedReference}}};
  const source=outcome==="unavailable"?'process.exit(0); export const add=(a,b)=>a+b;':`export const add=(a,b)=>a${outcome==="mismatch"?"-":"+"}b;`;
  const texts={"src/add.mjs":source,"tests/add.test.mjs":'import test from "node:test";import assert from "node:assert/strict";import {add} from "../src/add.mjs";test("sum",()=>assert.equal(add(2,3),5));'};
  const blobs=new Map<string,Uint8Array>(),entries=Object.entries(texts).map(([path,text])=>{const raw=Buffer.from(text),blobDigest=sha256Digest(raw);blobs.set(blobDigest,raw);return {path,blobDigest,byteLength:raw.length,mode:0o644};});
  const manifest:SubjectMaterialManifest={protocol:"jevyr.subject-material/1",subjectId:"repo",subjectKind:"directory",subjectDigest:hash(entries),availability:"MATERIALIZED",entries,directories:["src","tests"],omissions:[],byteLength:entries.reduce((n,file)=>n+file.byteLength,0)};
  const binding:SubjectMaterialBinding={subjectId:"repo",subjectKind:"directory",subjectDigest:manifest.subjectDigest,availability:"MATERIALIZED",manifestDigest:hash(manifest),byteLength:manifest.byteLength},bindings=[binding];
  const reader={readManifest:async()=>manifest,readBlob:async(digest:string)=>Buffer.from(blobs.get(digest)??[])},time="2026-09-05T12:00:00.000Z";
  const sealedCase=sealCase({protocol:"jevyr.case/1",case:{impulse,subjects:[{id:"repo",kind:"directory",locator:"C:/PRIVATE-PATH-NEVER-READ"}],privacy:"local_only",control:"sovereign",seed:"certificate-held-seed"}},
    {policyVersion:ORIGINAL_SUBJECT_POLICY_VERSION,genomeVersion:"fixture",policyDigest:hash(policyDescriptor),genomeDigest:sha256Digest("genome"),searchEnvelope:createSearchEnvelope({...DEFAULT_SEARCH_PROFILE,resources}),sealedAt:time,
      subjectMaterialCaptureDigest:hash({protocol:"jevyr.subject-material-capture/1",bindings}),subjectSnapshots:[{subjectId:"repo",digest:manifest.subjectDigest,byteLength:manifest.byteLength,resolvedLocator:"C:/PRIVATE-PATH-NEVER-READ",capturedAt:time}]});
  const context:OriginalSubjectCertificateContext={sealedCase,sealEnvelope:signSealReceipt(sealReceipt(sealedCase),keys.privateKeyPem),trustedCaseKeys:new Map([[keys.keyId,keys.publicKeyPem]]),assets};
  const ledger=(drafts:readonly any[]):CaseEvent[]=>{const events:CaseEvent[]=[];for(const draft of drafts)events.push(createCaseEvent({caseDigest:sealedCase.caseDigest,runDigest:sealedCase.runDigest,observedAt:time,stage:"self_scan",kind:"action.status",actor:{id:"jevyr.bone",kind:"kernel"},...draft},events.length+1,events.at(-1)?.eventDigest??null));return events;};
  const drafts=(certificate:ReturnType<typeof createOriginalSubjectCertificate>,withEdge=true):any[]=>[
    {payload:{actionId:"pure-case",actionType:ORIGINAL_SUBJECT_CERTIFICATE_ACTION,status:"started",summary:"Fixed original-source evaluation started"}},
    {payload:{actionId:"pure-case",actionType:ORIGINAL_SUBJECT_CERTIFICATE_ACTION,status:"completed",summary:"Fixed evaluation captured",artifactDigests:[certificate.digest],resource:{wallMillis:certificate.resources.wallMillis,bytesWritten:certificate.resources.writableBytes}}},
    ...(withEdge?[{kind:"evidence.observed",payload:{evidenceId:"original-source-proof",evidenceType:"original_subject_assertions",summary:"Reconstructed complete immutable assertions",contentDigest:certificate.digest,
      originalSubject:{protocol:"jevyr.original-subject-assertion-binding/1",subjectId:"repo",obligationId:certificate.certificate.obligationId,captureDigest:sealedCase.subjectMaterialCaptureDigest,certificateDigest:certificate.digest,executionReceiptDigest:certificate.executionReceiptDigest,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST},
      [outcome==="mismatch"?"refutes":"supports"]:[certificate.certificate.obligationId]}}]:[])];
  return {assets,policyDescriptor,frontier,context,sealedCase,bindings,reader,ledger,drafts};
}
async function fakeCertificate() {
  const f=await fixture(),r={protocol:"jevyr.repository-pure-execution-receipt/1",caseId:f.sealedCase.caseId,caseDigest:f.sealedCase.caseDigest,runDigest:f.sealedCase.runDigest,policyDigest:f.sealedCase.policyDigest,
    resources:{wallMillis:5,elapsedMeasurement:"HOST_MONOTONIC",executionAttempted:true,cpuMillis:null,cpuMeasurement:"UNMEASURED",writableBytes:0,writableInodes:5,workspaceMeasurement:"MEASURED",artifactBytes:100}};
  const artifacts=Object.fromEntries([...[...Array(7).keys()].map(i=>[`fake-${i}.json`,bytes({fabricated:true,i})] as const),["receipt.json",bytes(r)]]);
  const certificate=createOriginalSubjectCertificate({sealedCase:f.sealedCase,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST,execution:{authority:"none",receipt:r,artifacts,observation:{}} as any});return {...f,certificate};
}

test("closed certificate encoding is bounded, detached, complete and not authentication",async()=>{
  const f=await fakeCertificate(),original=f.certificate.bytes;assert.equal(decodeOriginalSubjectCertificate(original).caseId,f.sealedCase.caseId);
  f.certificate.bytes.fill(0);assert.deepEqual(f.certificate.bytes,original);assert.ok(!Buffer.from(original).includes(Buffer.from("PRIVATE-PATH-NEVER-READ")));
  assert.throws(()=>decodeOriginalSubjectCertificate(Buffer.alloc(MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES+1)));
  for(const change of [(v:any)=>{v.verified=true;},(v:any)=>{v.artifacts[0].name="../outside";},(v:any)=>{v.artifacts[0].base64+="=";},(v:any)=>{v.artifacts[0].digest=sha256Digest("fake");},(v:any)=>{v.artifacts.reverse();},(v:any)=>{v.executionReceiptDigest=sha256Digest("other");}]){
    const claimed=structuredClone(f.certificate.certificate);change(claimed);assert.throws(()=>decodeOriginalSubjectCertificate(bytes(claimed)));
  }
  assert.throws(()=>decodeOriginalSubjectCertificate(Buffer.concat([original,Buffer.from("\n")])));
});

test("no certificate, denied preflight and missing authentication cannot mint authority",async()=>{
  const f=await fakeCertificate();let resolved=0;const resolver=async()=>{resolved++;return f.certificate.bytes;};
  const empty=await replayOriginalSubjectCertificates([],{},resolver);assert.deepEqual(empty.verifiedOriginalSubjectEdges,[]);assert.equal(resolved,0);
  const denied=f.ledger([{payload:{actionId:"pure-case",actionType:ORIGINAL_SUBJECT_CERTIFICATE_ACTION,status:"denied",summary:"Unsupported preflight; no execution"}}]);
  const refused=await replayOriginalSubjectCertificates(denied,f.policyDescriptor,resolver,f.context);assert.deepEqual(refused.problems,[]);assert.equal(refused.baseline.artifactBytes,0);assert.equal(resolved,0);
  assert.deepEqual(refused.originalSubjectContext,{sealedCase:f.sealedCase,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST});assert.deepEqual(refused.verifiedOriginalSubjectEdges,[]);
  const untrustedDenial=await replayOriginalSubjectCertificates(denied,f.policyDescriptor,resolver,{...f.context,trustedCaseKeys:new Map()});assert.ok(untrustedDenial.problems.some(item=>item.message==="ORIGINAL_SEAL_AUTHENTICATION_FAILED"));assert.equal(resolved,0);assert.equal(untrustedDenial.originalSubjectContext,undefined);
  const events=f.ledger(f.drafts(f.certificate));const absent=await replayOriginalSubjectCertificates(events,f.policyDescriptor,resolver);assert.ok(absent.problems.length);assert.equal(resolved,0);
  const forged=await replayOriginalSubjectCertificates(events,f.policyDescriptor,resolver,f.context);assert.ok(forged.problems.length);assert.deepEqual(forged.verifiedOriginalSubjectEdges,[]);assert.equal(forged.baseline.artifactBytes,0);
  const deep=await verifyPersistedAssayEvidence(events,f.sealedCase.intentContract,f.frontier,f.policyDescriptor,resolver,{mode:"precompile"});
  assert.equal(deep.sandboxExecutionCount,0);assert.ok(deep.problems.some(item=>item.code==="ORIGINAL_SUBJECT_CERTIFICATE_INVALID"));assert.deepEqual(deep.verifiedOriginalSubjectEdges,[]);
  assert.ok(!deep.problems.some(item=>item.code==="FLAGSHIP_MISMATCH"),"original-source edges never enter candidate flagship accounting, even when independently refused");
});

test("one ordered pre-investigation Bone invocation and exact original reservation are required",async()=>{
  const f=await fakeCertificate(),reservation=originalSubjectExecutionLimits(f.sealedCase,f.policyDescriptor);
  assert.equal(reservation.resourceLimits.maxArtifactBytes,20_000_000);assert.equal(reservation.timeoutMs,30_000);
  const narrowed=await fixture(synthetic,"match",25_000);assert.equal(originalSubjectExecutionLimits(narrowed.sealedCase,narrowed.policyDescriptor).timeoutMs,25_000);
  const changed=structuredClone(f.policyDescriptor) as any;changed.policy.assayFrontier.aggregateLimits.maxArtifactBytes++;assert.throws(()=>originalSubjectExecutionLimits(f.sealedCase,changed));
  for(const transform of [(drafts:any[])=>drafts.slice(1),(drafts:any[])=>[...drafts,drafts[0]],(drafts:any[])=>drafts.map((d,i)=>i===0?{...d,actor:{id:"model",kind:"mind"}}:d),
    (drafts:any[])=>[{payload:{actionId:"earlier-mind",actionType:"mind.contribute",status:"started",summary:"Prior investigation"}},...drafts],
    (drafts:any[])=>drafts.map(d=>({...d,stage:"assay"}))]){
    const replay=await replayOriginalSubjectCertificates(f.ledger(transform(f.drafts(f.certificate))),f.policyDescriptor,async()=>f.certificate.bytes,f.context);assert.ok(replay.problems.length);assert.deepEqual(replay.verifiedOriginalSubjectEdges,[]);
  }
});

test("unknown Bone v2 kernels are refused even without original certificate events",async()=>{
  const f=await fixture();let resolutions=0;
  const resolver=async()=>{resolutions++;return undefined;};
  const supported=await verifyPersistedAssayEvidence([],f.sealedCase.intentContract,f.frontier,f.policyDescriptor,resolver,{mode:"precompile"});
  assert.ok(!supported.problems.some(problem=>problem.code==="UNSUPPORTED_ORIGINAL_SUBJECT_KERNEL"));
  const unknown=structuredClone(f.policyDescriptor) as any;unknown.policy.genomeSelection.runtimeCompilation.boneDigest=sha256Digest("unknown-v2");
  const refused=await verifyPersistedAssayEvidence([],f.sealedCase.intentContract,f.frontier,unknown,resolver,{mode:"precompile"});
  assert.equal(refused.replayComplete,false);assert.ok(refused.problems.some(problem=>problem.code==="UNSUPPORTED_ORIGINAL_SUBJECT_KERNEL"));assert.deepEqual(refused.verifiedOriginalSubjectEdges,[]);assert.equal(resolutions,0);
  unknown.version="jevyr.bone/1";const legacy=await verifyPersistedAssayEvidence([],f.sealedCase.intentContract,f.frontier,unknown,resolver,{mode:"precompile"});
  assert.ok(!legacy.problems.some(problem=>problem.code==="UNSUPPORTED_ORIGINAL_SUBJECT_KERNEL"));
});

test("authenticated original purpose exists before evaluation and omission cannot restore candidate authority",async()=>{
  const f=await fixture();let reads=0;const resolver=async()=>{reads++;return undefined;};
  const before=await replayOriginalSubjectCertificates([],f.policyDescriptor,resolver,f.context);assert.deepEqual(before.problems,[]);assert.deepEqual(before.originalSubjectContext,{sealedCase:f.sealedCase,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST});assert.deepEqual(before.verifiedOriginalSubjectEdges,[]);assert.equal(before.baseline.artifactBytes,0);
  const missing=await replayOriginalSubjectCertificates([],f.policyDescriptor,resolver);assert.ok(missing.problems.length);assert.equal(missing.originalSubjectContext,undefined);
  const forged=await replayOriginalSubjectCertificates([],f.policyDescriptor,resolver,{...f.context,trustedCaseKeys:new Map()});assert.ok(forged.problems.length);assert.equal(forged.originalSubjectContext,undefined);
  const downgraded=await replayOriginalSubjectCertificates([],{...f.policyDescriptor,version:"jevyr.bone/1"},resolver,f.context);assert.ok(downgraded.problems.some(problem=>problem.message==="ORIGINAL_KERNEL_POLICY_MISMATCH"));assert.equal(downgraded.originalSubjectContext,undefined);
  const later=f.ledger([{stage:"interpret",payload:{actionId:"mind-started",actionType:"mind.contribute",status:"started",summary:"Investigation already began"}}]);
  const omitted=await replayOriginalSubjectCertificates(later,f.policyDescriptor,resolver,f.context);assert.ok(omitted.problems.some(problem=>problem.message==="ORIGINAL_ACTION_MISSING"));assert.deepEqual(omitted.verifiedOriginalSubjectEdges,[]);
  const other=await fixture(synthetic,"match",60_000,"Inspect captured code.");const unrelated=await replayOriginalSubjectCertificates([],other.policyDescriptor,resolver,other.context);assert.deepEqual(unrelated.problems,[]);assert.equal(unrelated.originalSubjectContext,undefined);assert.equal(reads,0);
});

test("actual OCI certificate joins only independently authenticated exact original-source evidence and charges outer storage once",{skip:process.env.JEVYR_TEST_ORIGINAL_CERTIFICATE_DOCKER!=="1",timeout:180_000},async()=>{
  const identity=sealDockerSubstrateIdentity("node:24-alpine",inspectLocalDockerImage({dockerCommand:"docker",requestedReference:"node:24-alpine"}),"local-docker-cli");assert.equal(identity.status,"resolved");const proofs=[];
  for(const outcome of ["match","mismatch","unavailable"] as const){
    const f=await fixture(identity,outcome,outcome==="match"?25_000:60_000),execution=await executeRepositoryPureAssertions({sealedCase:f.sealedCase,policyDescriptor:f.policyDescriptor,assets:f.assets,bindings:f.bindings,reader:f.reader,forge:new SealedForgeAdapter({mode:"docker",dockerImage:identity.requestedReference,dockerSubstrateIdentity:identity}),invocationId:"pure-case",...originalSubjectExecutionLimits(f.sealedCase,f.policyDescriptor),signal:new AbortController().signal});
    const certificate=createOriginalSubjectCertificate({sealedCase:f.sealedCase,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST,execution}),drafts=f.drafts(certificate,outcome!=="unavailable"),events=f.ledger(drafts),resolver=async()=>certificate.bytes;
    const replay=await replayOriginalSubjectCertificates(events,f.policyDescriptor,resolver,f.context);assert.deepEqual(replay.problems,[]);assert.equal(replay.verifiedOriginalSubjectEdges.length,outcome==="unavailable"?0:1);assert.equal(replay.observations[0]!.outcome,outcome);
    if(outcome!=="unavailable")assert.equal(replay.verifiedOriginalSubjectEdges[0]!.kind,outcome==="match"?"supports":"refutes");
    assert.equal(replay.baseline.artifactBytes,certificate.bytes.length);assert.notEqual(replay.baseline.artifactBytes,execution.receipt.resources.artifactBytes);
    const observer=await replayRepositoryObservers(events,f.policyDescriptor,resolver,{initialBaseline:replay.baseline,initialArtifacts:[{digest:certificate.digest,byteLength:certificate.bytes.length}]});assert.equal(observer.baseline.artifactBytes,certificate.bytes.length);
    const rejected=[];
    if(outcome==="match"){
      // Rehash every affected container and exact raw storage count. The child
      // observation remains genuine; only the claimed host elapsed total grows
      // beyond the narrower frontier, while staying below the global envelope.
      const receipt=structuredClone(execution.receipt) as any;receipt.resources.wallMillis=25_001;
      const artifacts=Object.fromEntries(Object.entries(execution.artifacts).map(([name,raw])=>[name,Buffer.from(raw)]));
      for(let index=0;index<8;index++){artifacts["receipt.json"]=bytes(receipt);const used=[...new Map(Object.values(artifacts).map(raw=>[sha256Digest(raw),raw.length])).values()].reduce((a,b)=>a+b,0);if(used===receipt.resources.artifactBytes)break;receipt.resources.artifactBytes=used;}
      artifacts["receipt.json"]=bytes(receipt);
      const overshot=createOriginalSubjectCertificate({sealedCase:f.sealedCase,kernelDigest:ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST,execution:{...execution,receipt,artifacts}});
      const result=await replayOriginalSubjectCertificates(f.ledger(f.drafts(overshot)),f.policyDescriptor,async()=>overshot.bytes,f.context);
      assert.ok(result.problems.some(problem=>problem.message==="ORIGINAL_INITIAL_ENVELOPE_MISMATCH"),JSON.stringify(result.problems));assert.deepEqual(result.verifiedOriginalSubjectEdges,[]);rejected.push(result.problems);
    }
    for(const transform of [(ds:any[])=>ds.map((d,i)=>i===1?{...d,payload:{...d.payload,resource:{...d.payload.resource,wallMillis:0}}}:d),
      (ds:any[])=>[...ds,{kind:"candidate.status",stage:"diverge",payload:{candidateId:"laundered",status:"proposed",summary:"Cannot acquire certificate",artifactDigests:[certificate.digest]}}]]){
      const result=await replayOriginalSubjectCertificates(f.ledger(transform(structuredClone(drafts))),f.policyDescriptor,resolver,f.context);assert.ok(result.problems.length);assert.deepEqual(result.verifiedOriginalSubjectEdges,[]);rejected.push(result.problems);
    }
    const untrusted=await replayOriginalSubjectCertificates(events,f.policyDescriptor,resolver,{...f.context,trustedCaseKeys:new Map()});assert.ok(untrusted.problems.length);assert.deepEqual(untrusted.verifiedOriginalSubjectEdges,[]);rejected.push(untrusted.problems);
    const tampered=structuredClone(certificate.certificate),resultSidecar=tampered.artifacts.find(item=>item.name==="result.json")!;const result=JSON.parse(Buffer.from(resultSidecar.base64,"base64").toString());result.analysis.outcome=outcome==="match"?"mismatch":"match";const raw=Buffer.concat([bytes(result),Buffer.from("\n")]);Object.assign(resultSidecar,{base64:raw.toString("base64"),byteLength:raw.length,digest:sha256Digest(raw)});
    const altered=bytes(tampered),alteredDigest=sha256Digest(altered),changedDrafts=structuredClone(drafts);changedDrafts[1].payload.artifactDigests=[alteredDigest];if(changedDrafts[2]){changedDrafts[2].payload.contentDigest=alteredDigest;changedDrafts[2].payload.originalSubject.certificateDigest=alteredDigest;}
    const alteredReplay=await replayOriginalSubjectCertificates(f.ledger(changedDrafts),f.policyDescriptor,async()=>altered,f.context);assert.ok(alteredReplay.problems.length);assert.deepEqual(alteredReplay.verifiedOriginalSubjectEdges,[]);rejected.push(alteredReplay.problems);
    proofs.push({outcome,replay,rejected});
    if(process.env.JEVYR_ORIGINAL_CERTIFICATE_PROOF_DIR){const base=process.env.JEVYR_ORIGINAL_CERTIFICATE_PROOF_DIR;assert.ok(isAbsolute(base));const path=join(resolve(base),outcome);await mkdir(path,{recursive:true});
      await writeFile(join(path,"certificate.json"),certificate.bytes);await writeFile(join(path,"events.json"),bytes(events));await writeFile(join(path,"sealed-case.json"),bytes(f.sealedCase));await writeFile(join(path,"policy-descriptor.json"),bytes(f.policyDescriptor));await writeFile(join(path,"seal.dsse.json"),bytes(f.context.sealEnvelope));await writeFile(join(path,"trust.json"),bytes(Object.fromEntries(f.context.trustedCaseKeys)));}
  }
  if(process.env.JEVYR_ORIGINAL_CERTIFICATE_PROOF_DIR)await writeFile(join(process.env.JEVYR_ORIGINAL_CERTIFICATE_PROOF_DIR,"report.json"),JSON.stringify({protocol:"jevyr.original-subject-certificate-integration-proof/1",scope:"Three real fixed-OCI fixtures; authenticated Seal and exact ledger join; proof-declared local keys, no whole Record closure in this harness",proofs},null,2));
});
