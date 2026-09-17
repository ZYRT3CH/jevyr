import type { AgentAdapter, CapabilityCard, MindInvocationResult, MindRequest, ProbeResult, PublicContribution } from "../contracts.js";
import { MAX_MIND_RAW_OUTPUT_BYTES, MindMeteredFailure, mindFailureInputUpperBound } from "../mind-metering.js";
import { EnvironmentSecretBroker, secretReference, type SecretBroker, type SecretReference } from "../secret-broker.js";
import { withQuarantinedMindWorkspace, rejectCallerWorkingDirectory } from "./process-quarantine.js";
import { providerLauncher } from "./provider-launcher.js";
import { JsonLineRpcProcess } from "./codex-rpc.js";
import { prepareCodexBoundary, codexChildEnvironment, assertCodexConfiguration, CODEX_BOUNDARY_DIGEST, CODEX_NATIVE_VERSION } from "./codex-boundary.js";
import { runCodexContextHarness } from "./codex-harness.js";
import { makePublicMindPrompt } from "./prompt.js";
export { JsonLineRpcProcess } from "./codex-rpc.js";

export interface CodexAppServerOptions {
  readonly command?:string; readonly launcherArgs?:readonly string[]; readonly model?:string;
  readonly timeoutMs?:number; readonly shutdownGraceMs?:number; readonly maxOutputBytes?:number;
  readonly credential?:SecretReference; readonly secretBroker?:SecretBroker;
}
const AUDIENCE="https://api.openai.com";

/** Pinned native agent transport; the fixed context handlers have no host I/O. */
export class CodexAppServerMindAdapter implements AgentAdapter {
  readonly adapterClass="agent" as const;
  readonly capability:CapabilityCard;
  readonly #options:CodexAppServerOptions;
  readonly #environment:NodeJS.ProcessEnv;
  constructor(options:CodexAppServerOptions={},environment:NodeJS.ProcessEnv=process.env) {
    rejectCallerWorkingDirectory(options,"Codex app-server mind adapter");
    if(Object.keys(options).some(key=>!["command","launcherArgs","model","timeoutMs","shutdownGraceMs","maxOutputBytes","credential","secretBroker"].includes(key)))throw new TypeError("Unknown Codex app-server option");
    for(const [key,maximum] of [["shutdownGraceMs",10000],["maxOutputBytes",MAX_MIND_RAW_OUTPUT_BYTES],["timeoutMs",3600000]] as const)if(options[key]!==undefined&&(!Number.isSafeInteger(options[key])||options[key]!<1||options[key]!>maximum))throw new RangeError(`Invalid Codex ${key}`);
    if(options.model!==undefined&&(typeof options.model!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(options.model)))throw new TypeError("Codex requires a bounded model identity");
    if(options.command!==undefined&&(typeof options.command!=="string"||options.command.length<1||options.command.length>4096||/[\r\n\0]/u.test(options.command)))throw new TypeError("Invalid configured Codex executable");
    if(options.launcherArgs!==undefined&&(!Array.isArray(options.launcherArgs)||options.launcherArgs.length>128||options.launcherArgs.some(value=>typeof value!=="string"||Buffer.byteLength(value)>8192||/\0/u.test(value))))throw new TypeError("Invalid configured Codex launcher arguments");
    if(!!options.credential!==!!options.secretBroker||options.credential&&options.credential.audience!==AUDIENCE)throw new TypeError("Codex requires an audience-bound broker pair");
    this.#options=Object.freeze({...options,...options.launcherArgs?{launcherArgs:Object.freeze([...options.launcherArgs])}:{}});this.#environment=Object.freeze({...environment});
    this.capability=Object.freeze({id:"mind.codex-app-server.v1",kind:"mind",displayName:"Codex app-server",version:`${CODEX_NATIVE_VERSION}:${CODEX_BOUNDARY_DIGEST}`,transport:"process",trust:"quarantined",modalities:["text","structured-data"] as const,network:"provider",canExecuteTools:false,deterministic:false,
      limits:{adapterClass:"agent",providerId:AUDIENCE,modelId:options.model??"unconfigured",modelFamily:"openai-codex",seedEnforcement:"unverified",hostExecution:false,boundaryDigest:CODEX_BOUNDARY_DIGEST,maximumContextCalls:12,maximumRounds:4}});
  }
  async #withBoundary<T>(action:(rpc:JsonLineRpcProcess,cwd:string,signal:AbortSignal)=>Promise<T>,parentSignal?:AbortSignal,timeoutMs=5000):Promise<T> {
    return await withQuarantinedMindWorkspace(async root=>{
      const boundary=await prepareCodexBoundary(root),launcher=providerLauncher("codex",this.#options,this.#environment);
      const signal=parentSignal?AbortSignal.any([parentSignal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
      const rpc=new JsonLineRpcProcess(launcher.command,launcher.args,boundary.cwd,codexChildEnvironment(boundary.home,boundary.cwd,this.#environment),signal,this.#options.shutdownGraceMs??500,this.#options.maxOutputBytes??MAX_MIND_RAW_OUTPUT_BYTES);
      try {
        const initialized=await rpc.request("initialize",{clientInfo:{name:"jevyr",title:"Jevyr sealed investigator",version:"1"},capabilities:{experimentalApi:true,requestAttestation:false}}) as {userAgent?:string;codexHome?:string};
        if(typeof initialized.userAgent!=="string"||!initialized.userAgent.includes(`/${CODEX_NATIVE_VERSION} `)||initialized.codexHome!==boundary.home)throw new Error("Codex native version/home differs from the measured boundary");
        rpc.notify("initialized",{});assertCodexConfiguration(await rpc.request("config/read",{includeLayers:false}),boundary.cwd);
        return await action(rpc,boundary.cwd,signal);
      }finally{await rpc.close();}
    });
  }
  async probe(signal?:AbortSignal):Promise<ProbeResult> {
    const started=performance.now();let available=false;
    try{await this.#withBoundary(async()=>{},signal);available=true;}catch{/* Never expose native diagnostics containing credential material. */}
    return{available,observedAt:new Date().toISOString(),latencyMs:Math.round(performance.now()-started),...(available?{version:CODEX_NATIVE_VERSION}:{}),detail:available?"Pinned Codex app-server initialized and verified its isolated configuration without a model request; credentials and inference remain unproven.":"Codex could not verify its pinned isolated configuration; no model request was sent."};
  }
  async runMetered(request:MindRequest):Promise<MindInvocationResult> {
    if(!this.#options.model||!this.#options.credential||!this.#options.secretBroker)throw new MindMeteredFailure("Codex app-server requires an explicit model and API credential broker reference",0);
    const authorization=this.#options.secretBroker.authorization(this.#options.credential,AUDIENCE);
    if(!/^Bearer [^\r\n\0]+$/u.test(authorization))throw new MindMeteredFailure("Codex broker returned an invalid credential",0);
    let failureInputBytes=Buffer.byteLength(makePublicMindPrompt(request));
    try{return await this.#withBoundary(async(rpc,cwd,signal)=>{
      // Login is confined to the disposable provider home; no ambient login is read.
      const login=await rpc.request("account/login/start",{type:"apiKey",apiKey:authorization.slice(7)}) as {type?:string};
      if(login?.type!=="apiKey")throw new Error("Codex did not acknowledge the explicit API broker");
      try{
        const result=await runCodexContextHarness(rpc,request,cwd,this.#options.model!,signal);
        failureInputBytes=Math.max(result.tokenUsage.input.tokens,(result.transmittedInputBytes+result.receivedOutputBytes)*4);
        return result;
      }
      catch(error){failureInputBytes=mindFailureInputUpperBound(error,failureInputBytes);throw error;}
    },request.signal,this.#options.timeoutMs??180000);}catch(error){throw new MindMeteredFailure("Codex failed its isolated native harness or structured contribution contract",mindFailureInputUpperBound(error,failureInputBytes));}
  }
  async *run(request:MindRequest):AsyncIterable<PublicContribution>{yield* (await this.runMetered(request)).contributions;}
}
export function configuredCodexAppServer(env:NodeJS.ProcessEnv):CodexAppServerMindAdapter {
  const raw=env.JEVYR_CODEX_API_KEY_REF;
  if(raw!==undefined&&!/^env:[A-Z][A-Z0-9_]{0,127}$/u.test(raw))throw new TypeError("JEVYR_CODEX_API_KEY_REF must name env:VARIABLE");
  const credential=raw?secretReference(raw.slice(4),AUDIENCE):undefined;
  return new CodexAppServerMindAdapter({...env.JEVYR_CODEX_MODEL?{model:env.JEVYR_CODEX_MODEL}:{},...credential?{credential,secretBroker:new EnvironmentSecretBroker([credential],env)}:{}},env);
}
