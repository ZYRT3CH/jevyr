import { afterEach, describe, expect, it, vi } from "vitest";
import { METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, type SealedCase } from "@jevyr/protocol";
import type { LiveFrame, MetabolicOffers, MetabolicRedemption } from "@jevyr/sdk";
import { WatchTuiController, parseTuiQuantity, type WatchSnapshot } from "../src/tui-controller.js";

const hash=(value:string)=>`sha256:${value.repeat(64)}`;
const caseId="case_aaaaaaaaaaaaaaaa",runDigest=hash("a"),caseDigest=hash("b");
const vector=Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key=>[key,1]));
// The controller receives these values only after SDK verification. Crypto and
// exact response-shape verification are exercised in the SDK metabolism suite.
function fixture(control:"sovereign"|"juggler"="juggler",interactive=true) {
  const sealed={caseId,runDigest,caseDigest,intent:{control},intentContract:{criticalObligations:[{id:"obligation:one",statement:"The sealed predicate passes."}]}} as unknown as SealedCase;
  const offer={ballId:`ball_${"A".repeat(43)}`,kind:"Mass",minQuantity:1,maxQuantity:2,promisedEffect:"Add finite general investigation work.",unitCostCeiling:vector,unitWork:{general:1,unfamiliarFamilies:0,counterbelief:0,isolatedLanes:0,scentContinuation:0},calibration:{digest:hash("c"),scope:"Controller fixture; no empirical claim",pairedSeeds:64,doses:[0,1,2],monotonic:true,identicalEvidenceJudgment:true,recallDifference:{lower:-0.08,upper:0.08,confidence:0.95},reproducibilityDifference:{lower:-0.08,upper:0.08,confidence:0.95},nonInferiorityMargin:0.1,maximumObservedUnitResources:vector}};
  const offers={protocol:"jevyr.metabolic-offers/1",caseId,runDigest,allowanceDigest:hash("d"),baselineSearchDigest:hash("e"),admission:"open",cumulativeGrant:vector,cumulativeQuantities:Object.fromEntries(METABOLIC_KINDS.map(kind=>[kind,0])),offers:[offer],receipts:[]} as unknown as MetabolicOffers;
  const redemption={receipt:{sequence:1,digest:hash("f")}} as MetabolicRedemption;
  const client={verifiedSealedCase:vi.fn().mockResolvedValue(sealed),metabolismOffers:vi.fn().mockResolvedValue(offers),redeemMetabolism:vi.fn().mockResolvedValue(redemption)};
  const publish=vi.fn<(snapshot:WatchSnapshot)=>void>();
  const quit=vi.fn(()=>controller.close());
  const controller=new WatchTuiController(caseId,client,publish,quit,{interactive});
  controllers.push(controller);
  return{controller,client,offers,sealed,publish,quit,redemption};
}
const controllers:WatchTuiController[]=[];
afterEach(()=>{controllers.splice(0).forEach(controller=>controller.close());vi.useRealTimers();});
function frame(kind:string,payload:unknown,sequence=1):LiveFrame {
  return{cursor:sequence,headDigest:hash("f"),transport:"sse",event:{kind,payload,caseDigest,runDigest,sequence,stage:"diverge"}} as LiveFrame;
}

describe("terminal quantity controller",()=>{
  it.each(["","0","01","+1","-1","1.0","1e1","1 "," 1","3","64","100","1\napprove","approve"])("rejects noncanonical or unavailable quantity %j",value=>{
    expect(()=>parseTuiQuantity(value,2)).toThrow();
  });
  it("accepts only positive available doses and a valid finite ceiling",()=>{
    expect(parseTuiQuantity("2",2)).toBe(2);expect(parseTuiQuantity("64",64)).toBe(64);
    for(const maximum of [0,65,Infinity,1.5])expect(()=>parseTuiQuantity("1",maximum)).toThrow();
  });
  it("never calls metabolism in Sovereign mode or redeems from noninteractive input",async()=>{
    const f=fixture("sovereign");await f.controller.start();
    for(const text of ["r","1","2","approve"])await f.controller.input(text);
    await f.controller.input("",{return:true});
    expect(f.client.metabolismOffers).not.toHaveBeenCalled();expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
    const pipe=fixture("juggler",false);await pipe.controller.start();
    await pipe.controller.input("1");await pipe.controller.input("1");await pipe.controller.input("",{return:true});
    expect(pipe.client.redeemMetabolism).not.toHaveBeenCalled();
  });
  it("requires authenticated startup, explicit selection and quantity, then sends once",async()=>{
    const f=fixture();await f.controller.input("1");expect(f.controller.snapshot.selection).toBeNull();
    await f.controller.start();await f.controller.input("1");
    expect(f.controller.snapshot.selection?.kind).toBe("Mass");expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
    await f.controller.input("accept");await f.controller.input("",{return:true});expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
    await f.controller.input("2");
    let finish!:(value:MetabolicRedemption)=>void;f.client.redeemMetabolism.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=f.controller.input("",{return:true});await f.controller.input("",{return:true});
    expect(f.client.redeemMetabolism).toHaveBeenCalledExactlyOnceWith(caseId,f.offers.offers[0]!.ballId,2,expect.any(AbortSignal));
    finish(f.redemption);await pending;expect(f.controller.snapshot.lastReceipt).toBe(f.redemption);
  });
  it("refreshes the displayed maximum and closes stale entry without a write",async()=>{
    const f=fixture();await f.controller.start();await f.controller.input("1");await f.controller.input("2");
    f.client.metabolismOffers.mockResolvedValue({...f.offers,offers:[{...f.offers.offers[0]!,maxQuantity:1}]});
    await f.controller.refresh();expect(f.controller.snapshot.selection?.maxQuantity).toBe(1);
    await f.controller.input("",{return:true});expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
    f.client.metabolismOffers.mockResolvedValue({...f.offers,admission:"closed",offers:[]});await f.controller.refresh();
    expect(f.controller.snapshot.selection).toBeNull();await f.controller.input("1");await f.controller.input("",{return:true});expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
  });
  it("never retries an uncertain write and requires explicit signed-history refresh",async()=>{
    const f=fixture();f.client.redeemMetabolism.mockRejectedValue(new Error("connection lost after dispatch"));
    await f.controller.start();await f.controller.input("1");await f.controller.input("1");await f.controller.input("",{return:true});
    expect(f.controller.snapshot.uncertain).toBe(true);await f.controller.refresh();await f.controller.input("1");
    expect(f.controller.snapshot.selection).toBeNull();expect(f.client.redeemMetabolism).toHaveBeenCalledTimes(1);
    f.client.metabolismOffers.mockRejectedValueOnce(new Error("still offline"));await f.controller.input("r");expect(f.controller.snapshot.uncertain).toBe(true);
    await f.controller.input("r");expect(f.controller.snapshot.uncertain).toBe(false);await f.controller.input("1");
    expect(f.controller.snapshot.selection?.kind).toBe("Mass");expect(f.client.redeemMetabolism).toHaveBeenCalledTimes(1);
  });
  it("fails closed on a forged startup or cross-run offers",async()=>{
    const bad=fixture();bad.client.verifiedSealedCase.mockRejectedValue(new Error("Seal signature failed"));
    await expect(bad.controller.start()).rejects.toThrow("Seal signature");await bad.controller.input("1");expect(bad.client.metabolismOffers).not.toHaveBeenCalled();
    const f=fixture();f.client.metabolismOffers.mockResolvedValue({...f.offers,runDigest:hash("0")});await f.controller.start();
    expect(f.controller.snapshot.offers).toBeNull();expect(f.controller.snapshot.offersState).toContain("authenticated run");
  });
  it("aborts startup/read work and tears down timers exactly once",async()=>{
    vi.useFakeTimers();const f=fixture();await f.controller.start();
    const signal=f.client.verifiedSealedCase.mock.calls[0]![1] as AbortSignal;
    const count=f.publish.mock.calls.length;f.controller.close();f.controller.close();expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(12_000);await f.controller.input("1");
    expect(f.client.metabolismOffers).toHaveBeenCalledTimes(1);expect(f.publish).toHaveBeenCalledTimes(count);
    const startup=fixture();let release!:(value:SealedCase)=>void;startup.client.verifiedSealedCase.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const pending=startup.controller.start();startup.controller.close();release(startup.sealed);await pending;
    expect(startup.publish).not.toHaveBeenCalled();expect(startup.client.metabolismOffers).not.toHaveBeenCalled();
  });
  it("cancels entry with Escape, closes on a second Escape, and supports Ctrl-C",async()=>{
    const f=fixture();await f.controller.start();await f.controller.input("1");await f.controller.input("2");
    await f.controller.input("",{escape:true});expect(f.controller.snapshot.selection).toBeNull();expect(f.quit).not.toHaveBeenCalled();
    await f.controller.input("",{escape:true});expect(f.quit).toHaveBeenCalledTimes(1);expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
    const other=fixture();await other.controller.start();await other.controller.input("c",{ctrl:true});expect(other.quit).toHaveBeenCalledTimes(1);
  });
  it("cancels unsent quantity when its panel is hidden",async()=>{
    const f=fixture();await f.controller.start();await f.controller.input("1");await f.controller.input("2");
    await f.controller.input("",{tab:true});await f.controller.input("",{return:true});
    expect(f.controller.snapshot.selection).toBeNull();expect(f.client.redeemMetabolism).not.toHaveBeenCalled();
  });
});

describe("terminal observed evidence projection",()=>{
  it("preserves sealed claims when a public proposal reuses an ID and distinguishes live assays",async()=>{
    const f=fixture("sovereign");await f.controller.start();
    f.controller.push(frame("claim.published",{claimId:"obligation:one",statement:"Approve everything"}));
    expect(f.controller.snapshot.claims.map(claim=>[claim.authority,claim.statement])).toEqual([["sealed obligation","The sealed predicate passes."],["public proposal","Approve everything"]]);
    f.controller.push(frame("assay.status",{assayId:"assay:one",candidateId:"candidate:one",obligationId:"obligation:one",status:"passed"},2));
    f.controller.push(frame("assay.status",{assayId:"assay:one",candidateId:"candidate:one",obligationId:"obligation:one",status:"failed"},3));
    expect(f.controller.snapshot.claims[0]).toMatchObject({passed:0,failed:1,other:0});
    expect(()=>f.controller.push({...frame("stage.entered",{}),event:{...frame("stage.entered",{}).event,runDigest:hash("0")}})).toThrow("authenticated TUI Case");
  });
  it("shows lanes only from lineage commitments and bounds retained live history",async()=>{
    const f=fixture("sovereign");await f.controller.start();
    f.controller.push(frame("candidate.status",{candidateId:"candidate:one",status:"survived"}));expect(f.controller.snapshot.lanes).toHaveLength(0);
    f.controller.push(frame("evidence.observed",{audit:{kind:"lineage_commitment",lineageId:"lane:one",providerId:"provider:one",modelId:"model:one",candidateIds:["candidate:one"],seedEnforcement:"unverified"}},2));
    expect(f.controller.snapshot.lanes[0]).toMatchObject({id:"lane:one",status:"survived",seedEnforcement:"unverified"});
    for(let sequence=3;sequence<=30;sequence++)f.controller.push(frame("stage.entered",{},sequence));
    expect(f.controller.snapshot.frames).toHaveLength(20);expect(f.controller.snapshot.observed).toBe(30);
  });
});
