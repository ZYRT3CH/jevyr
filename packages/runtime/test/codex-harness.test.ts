import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { runCodexContextHarness } from "../src/adapters/codex-harness.js";
import { CodexAppServerMindAdapter, configuredCodexAppServer } from "../src/adapters/codex-app-server.js";
import { CodexCliMindAdapter } from "../src/adapters/command-minds.js";
import { codexBoundaryConfig, codexChildEnvironment, assertCodexConfiguration, assertCodexThreadBoundary, CODEX_PERMISSION_PROFILE } from "../src/adapters/codex-boundary.js";
import { INVESTIGATOR_TOOL_DEFINITIONS } from "../src/investigator-tools.js";
import type { MindRequest } from "../src/contracts.js";
import { MindMeteredFailure } from "../src/mind-metering.js";
const hash=(value:string)=>sha256Digest(value),cwd=resolve("fixture-context"),model="fixture-model";
function request():MindRequest {
  return{stage:"interpret",role:"interpreter",seed:"fixture-seed",constraints:[],publicFacts:[],investigationTools:true,preparedPublicPrompt:"Only the bounded projection is provider input",signal:new AbortController().signal,maxInputTokens:100000,maxOutputTokens:4096,
    sealed:{caseId:"case_1234567812345678",caseDigest:hash("case"),runDigest:hash("run"),searchEnvelope:{profile:{seedDerivation:"sha256-case-seed-frontier-v2"}},intent:{privacy:"provider_scoped",impulse:"PRIVATE ORIGINAL",constraints:[],subjects:[{locator:"C:/private.txt"}]},intentContract:{criticalObligations:[]}}} as unknown as MindRequest;
}
function harness(action:(call:(method:string,params:Record<string,unknown>)=>Promise<any>,emit:(method:string,params:Record<string,unknown>)=>void)=>Promise<void>,options:{forgedBoundary?:boolean;omitUsage?:boolean;final?:string}={}) {
  let listener:(message:any)=>void=()=>{},handler:(method:string,params:Record<string,unknown>)=>Promise<any>=async()=>{},closed=false;
  const requests:unknown[]=[];
  const emit=(method:string,params:Record<string,unknown>)=>listener({method,params:{threadId:"thread-1",turnId:"turn-1",...params}});
  const rpc={onRequest(value:typeof handler){handler=value;},onNotification(value:typeof listener){listener=value;return()=>{listener=()=>{};};},close:async()=>{closed=true;},outputBytes:()=>1000,
    async request(method:string,params:Record<string,unknown>){requests.push({method,params});
      if(method==="thread/start")return{thread:{id:"thread-1"},cwd,model,modelProvider:"openai",activePermissionProfile:{id:options.forgedBoundary?":read-only":CODEX_PERMISSION_PROFILE},approvalPolicy:"never",instructionSources:[],runtimeWorkspaceRoots:[]};
      if(method==="turn/start"){setImmediate(async()=>{try{await action(handler,emit);}catch(error){emit("turn/completed",{turn:{id:"turn-1",status:"failed"}});return;}
        if(!options.omitUsage)emit("thread/tokenUsage/updated",{tokenUsage:{total:{inputTokens:100,outputTokens:40}}});
        emit("item/completed",{item:{type:"agentMessage",text:options.final??JSON.stringify({contributions:[{kind:"claim",summary:"Finite public claim."}]})}});
        emit("turn/completed",{turnId:undefined,turn:{id:"turn-1",status:"completed"}});
      });return{turn:{id:"turn-1"}};}throw new Error("Unrecognized fixture method");}}
  return{rpc:rpc as never,requests,closed:()=>closed};
}
const tool=(name:string,args:unknown,callId="call-1")=>({threadId:"thread-1",turnId:"turn-1",callId,tool:name,arguments:args});
test("Codex dynamic tools inspect only sealed context and never inherit a host resolver",async()=>{
  const f=harness(async(call)=>{
    const result=await call("item/tool/call",tool("list_subject_files",{}));assert.equal(JSON.parse(result.contentItems[0].text).availability,"WITHHELD_BY_PRIVACY_SCOPE");
    await assert.rejects(call("item/tool/call",tool("exec_command",{cmd:"read-host"},"bad")));
    await assert.rejects(call("item/commandExecution/requestApproval",{}));
    await assert.rejects(call("item/tool/call",{...tool("list_subject_files",{},"foreign"),threadId:"foreign"}));
  });
  const result=await runCodexContextHarness(f.rpc,request(),cwd,model,new AbortController().signal);
  assert.equal(result.investigation?.tools.length,1);assert.equal(result.investigation?.tools[0]?.authority,"context-only");assert.equal(result.investigation?.providerRounds,1);
  assert.equal(JSON.stringify(f.requests).includes("PRIVATE ORIGINAL"),false);assert.equal(JSON.stringify(f.requests).includes("C:/private.txt"),false);
  const started=(f.requests[0] as any).params;assert.equal(started.dynamicTools.length,INVESTIGATOR_TOOL_DEFINITIONS.length);assert.deepEqual(started.environments,[]);assert.deepEqual(started.selectedCapabilityRoots,[]);
});
test("native agent prompt uses its supplied tool channel without an HTTP batch envelope or round schedule",async()=>{
  const {preparedPublicPrompt:_prepared,...base}=request(),text="export const inspected = true;",sourceDigest=hash(text);
  const file={subjectId:"sealed-source",path:"checked.mjs",text,sourceDigest,sourceByteLength:Buffer.byteLength(text)};
  const projection={protocol:"jevyr.subject-text-projection/1",files:[file],omissions:[],manifestDigests:[],includedBytes:file.sourceByteLength,limits:{maxFileBytes:96000,maxTotalBytes:512000,maxFiles:256}};
  const input={...base,sealed:{...base.sealed,intent:{...base.sealed.intent,impulse:"Read checked.mjs completely.",subjects:[]}},subjectProjection:{...projection,projectionDigest:digestJson(projection as unknown as JsonValue)}} as MindRequest;
  const fileId=digestJson({subjectId:file.subjectId,path:file.path,sourceDigest});
  const f=harness(async call=>{
    const result=await call("item/tool/call",tool("read_subject_lines",{fileId,startLine:1,endLine:1}));
    assert.equal(JSON.parse(result.contentItems[0].text).text,text);
  });
  const result=await runCodexContextHarness(f.rpc,input,cwd,model,new AbortController().signal);
  const prompt=(f.requests.find(value=>(value as any).method==="turn/start") as any).params.input[0].text;
  assert.match(prompt,/Exact IDs require no prior listing/u);
  assert.match(prompt,/Use the supplied tool channel and batch multiple reads when that channel supports batching/u);
  assert.doesNotMatch(prompt,/jevyr\.context-tools\/1|three inspection rounds|native tools/u);
  assert.equal(result.investigation?.tools[0]?.sourceRead?.completeFile,true);
  assert.equal(result.investigation?.tools[0]?.requestFormat,undefined,"the native harness executed its real dynamic channel, not an HTTP envelope");
});
test("Codex refuses a broadened acknowledged profile, unmetered finals and unstructured prose",async()=>{
  const bad=harness(async()=>{},{forgedBoundary:true});await assert.rejects(runCodexContextHarness(bad.rpc,request(),cwd,model,new AbortController().signal),MindMeteredFailure);assert.equal(bad.requests.length,1);
  for(const options of [{omitUsage:true},{final:"I approve"}]){const f=harness(async()=>{},options);await assert.rejects(runCodexContextHarness(f.rpc,request(),cwd,model,new AbortController().signal));}
});
test("Codex rejects context floods and evidence-free claims of source inspection",async()=>{
  const flood=harness(async call=>{for(let index=0;index<13;index++)await call("item/tool/call",tool("list_subject_files",{},`call-${index}`));});
  await assert.rejects(runCodexContextHarness(flood.rpc,request(),cwd,model,new AbortController().signal),MindMeteredFailure);assert.equal(flood.closed(),true);
  const data={files:[{subjectId:"source",path:"source.txt",text:"finite source",sourceByteLength:13,sourceDigest:hash("finite source")}],omissions:[]};
  const input={...request(),subjectProjection:{...data,projectionDigest:digestJson(data as unknown as JsonValue)}} as unknown as MindRequest;
  const f=harness(async()=>{});await assert.rejects(runCodexContextHarness(f.rpc,input,cwd,model,new AbortController().signal),MindMeteredFailure);
});

test("Codex failed turns retain conservative repeated source-tool input accounting without diagnostics",async()=>{
  const source="finite source PRIVATE_SOURCE_MARKER", data={files:[{subjectId:"source",path:"source.txt",text:source,sourceByteLength:Buffer.byteLength(source),sourceDigest:hash(source)}],omissions:[]};
  const input={...request(),subjectProjection:{...data,projectionDigest:digestJson(data as unknown as JsonValue)}} as unknown as MindRequest;
  let resultBytes=0;
  const f=harness(async(call,emit)=>{
    const result=await call("item/tool/call",tool("search_subject",{query:"finite",maxResults:2}));
    resultBytes=Buffer.byteLength(result.contentItems[0].text);assert.ok(result.contentItems[0].text.includes("PRIVATE_SOURCE_MARKER"));
    emit("thread/tokenUsage/updated",{tokenUsage:{total:{inputTokens:9000,outputTokens:40}}});
    throw new Error("Provider diagnostic SECRET_MUST_NOT_ESCAPE");
  });
  await assert.rejects(runCodexContextHarness(f.rpc,input,cwd,model,new AbortController().signal),(error:unknown)=>{
    assert.ok(error instanceof MindMeteredFailure);
    assert.ok(error.transmittedInputBytes>=(Buffer.byteLength(input.preparedPublicPrompt!)+resultBytes)*4);
    assert.ok(error.transmittedInputBytes>=9000);assert.equal(error.message.includes("SECRET"),false);assert.equal(error.message.includes(source),false);return true;
  });
});
test("Codex replacement environment and effective config refuse ambient credentials and widened reads",()=>{
  const env=codexChildEnvironment("isolated-home",cwd,{PATH:"trusted-path",OPENAI_API_KEY:"MUST_NOT_CROSS",NODE_OPTIONS:"MUST_NOT_EXECUTE",HOME:"ambient-home",CODEX_HOME:"ambient-codex",HTTP_PROXY:"ambient-proxy"});
  assert.equal(env.HOME,"isolated-home");assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.HTTP_PROXY,undefined);
  const config=codexBoundaryConfig(cwd);assert.doesNotThrow(()=>assertCodexConfiguration({config},cwd));
  for(const field of ["shell_tool","plugins","browser_use"]){const changed=structuredClone(config);(changed.features as any)[field]=true;assert.throws(()=>assertCodexConfiguration({config:changed},cwd));}
  const widened=structuredClone(config);(widened.permissions as any)[CODEX_PERMISSION_PROFILE].filesystem[resolve("outside")]="read";assert.throws(()=>assertCodexConfiguration({config:widened},cwd));
});
test("Codex requires explicit broker auth and legacy CLI cannot bypass the new boundary",async()=>{
  await assert.rejects(new CodexAppServerMindAdapter({model}).runMetered(request()),/credential broker/u);
  await assert.rejects(new CodexCliMindAdapter().runMetered(request()),/inference is closed/u);
  assert.throws(()=>configuredCodexAppServer({JEVYR_CODEX_MODEL:model,JEVYR_CODEX_API_KEY_REF:"literal-secret"}),/env:VARIABLE/u);
});
