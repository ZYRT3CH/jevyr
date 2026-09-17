import type { JevyrClient, LiveFrame, MetabolicOffer, MetabolicOffers, MetabolicRedemption } from "@jevyr/sdk";
import type { SealedCase } from "@jevyr/protocol";

export type TuiPanel = "overview" | "claims" | "lanes" | "balls";
export interface TuiClaim { readonly id:string; readonly statement:string; readonly authority:"sealed obligation"|"public proposal"; readonly passed:number; readonly failed:number; readonly other:number }
export interface TuiLane { readonly id:string; readonly provider:string; readonly model:string; readonly candidateIds:readonly string[]; readonly status:string; readonly seedEnforcement:string }
export interface WatchSnapshot {
  readonly caseId:string; readonly runDigest:string|null; readonly frames:readonly LiveFrame[]; readonly observed:number; readonly fromCursor:number;
  readonly authentication:"loading"|"seal-verified"|"failed"; readonly control:"unknown"|"sovereign"|"juggler"; readonly interactive:boolean;
  readonly claims:readonly TuiClaim[]; readonly lanes:readonly TuiLane[]; readonly offers:MetabolicOffers|null; readonly offersState:string;
  readonly panel:TuiPanel; readonly offset:number; readonly selection:MetabolicOffer|null; readonly quantity:string; readonly submitting:boolean;
  readonly uncertain:boolean; readonly message:string; readonly lastReceipt:MetabolicRedemption|null;
}
type WatchClient = Pick<JevyrClient,"verifiedSealedCase"|"metabolismOffers"|"redeemMetabolism">;
export interface TuiKey { readonly ctrl?:boolean; readonly escape?:boolean; readonly return?:boolean; readonly backspace?:boolean; readonly delete?:boolean; readonly tab?:boolean; readonly upArrow?:boolean; readonly downArrow?:boolean }

/** Only canonical positive decimal quantities are meaningful terminal input. */
export function parseTuiQuantity(text:string, maximum:number):number {
  if (!/^[1-9][0-9]?$/u.test(text) || !Number.isSafeInteger(maximum) || maximum<1 || maximum>64 || Number(text)>maximum) throw new TypeError(`Quantity must be an integer from 1 through ${maximum}`);
  return Number(text);
}

/** Receives only fixed read APIs and opaque quantity redemption, never Cast or a message API. */
export class WatchTuiController {
  readonly #client:WatchClient;
  readonly #abort=new AbortController();
  readonly #publish:(snapshot:WatchSnapshot)=>void;
  readonly #quit:()=>void;
  #snapshot:WatchSnapshot;
  #sealed:SealedCase|undefined;
  #refreshing=false;
  #closed=false;
  #timer:ReturnType<typeof setTimeout>|undefined;
  readonly #assays=new Map<string,{obligationId:string;status:string}>();
  readonly #candidates=new Map<string,string>();

  constructor(caseId:string,client:WatchClient,publish:(snapshot:WatchSnapshot)=>void,quit:()=>void,options:{interactive:boolean;cursor?:number}) {
    this.#client=client;this.#publish=publish;this.#quit=quit;
    this.#snapshot={caseId,runDigest:null,frames:[],observed:0,fromCursor:options.cursor??0,authentication:"loading",control:"unknown",interactive:options.interactive,claims:[],lanes:[],offers:null,offersState:"Authenticate the Seal first",panel:"overview",offset:0,selection:null,quantity:"",submitting:false,uncertain:false,message:"",lastReceipt:null};
  }
  get snapshot():WatchSnapshot {return this.#snapshot;}
  #update(patch:Partial<WatchSnapshot>):void {if(this.#closed)return;this.#snapshot={...this.#snapshot,...patch};this.#publish(this.#snapshot);}
  async start():Promise<void> {
    try {
      const sealed=await this.#client.verifiedSealedCase(this.#snapshot.caseId,this.#abort.signal);
      if(this.#closed)return;
      if(sealed.caseId!==this.#snapshot.caseId)throw new Error("TUI received a different authenticated Case");
      this.#sealed=sealed;
      this.#update({authentication:"seal-verified",runDigest:sealed.runDigest,control:sealed.intent.control,
        claims:sealed.intentContract.criticalObligations.map(claim=>({id:claim.id,statement:claim.statement,authority:"sealed obligation",passed:0,failed:0,other:0})),
        offersState:sealed.intent.control==="sovereign"?"Sovereign: no live additions":"Checking calibrated offers"});
      if(sealed.intent.control==="juggler") {await this.refresh();this.#scheduleRefresh();}
    } catch(error) {this.#update({authentication:"failed",offers:null,offersState:"Seal verification failed"});throw error;}
  }
  #scheduleRefresh():void {
    if(this.#closed||this.#snapshot.control!=="juggler")return;
    this.#timer=setTimeout(()=>{void this.refresh().finally(()=>this.#scheduleRefresh());},3_000);
    this.#timer.unref?.();
  }
  async refresh(explicit=false):Promise<void> {
    if(this.#closed||this.#refreshing||this.#snapshot.control!=="juggler"||this.#snapshot.authentication!=="seal-verified"||this.#snapshot.submitting)return;
    this.#refreshing=true;
    try {
      const offers=await this.#client.metabolismOffers(this.#snapshot.caseId,this.#abort.signal);
      if(offers.caseId!==this.#snapshot.caseId||offers.runDigest!==this.#snapshot.runDigest)throw new Error("Offers cross the authenticated run");
      const selected=this.#snapshot.selection;
      const stillOffered=selected&&offers.admission==="open"?offers.offers.find(offer=>offer.ballId===selected.ballId):undefined;
      this.#update({offers,offersState:offers.admission==="closed"?"Admission closed":offers.offers.length?"Calibrated offers verified":"No calibrated offers for this Case",
        ...(stillOffered?{selection:stillOffered}:{selection:null,quantity:""}),...(explicit?{uncertain:false,message:`Signed history refreshed: ${offers.receipts.length} receipts. Choose an offered quantity explicitly.`}:{})});
    } catch(error) {
      this.#update({offers:null,selection:null,quantity:"",offersState:`Offers unavailable: ${error instanceof Error?error.message:String(error)}`});
    } finally {this.#refreshing=false;}
  }
  push(frame:LiveFrame):void {
    if(this.#closed)return;
    const event=frame.event;
    if(!this.#sealed||event.caseDigest!==this.#sealed.caseDigest||event.runDigest!==this.#sealed.runDigest)throw new Error("Live frame differs from the authenticated TUI Case");
    let claims=[...this.#snapshot.claims],lanes=[...this.#snapshot.lanes];
    if(event.kind==="claim.published") {
      const row:TuiClaim={id:event.payload.claimId,statement:event.payload.statement,authority:"public proposal",passed:0,failed:0,other:0};
      claims=[...claims.filter(claim=>claim.authority==="sealed obligation"||claim.id!==row.id),row];
      const sealed=claims.filter(claim=>claim.authority==="sealed obligation"),proposals=claims.filter(claim=>claim.authority==="public proposal").slice(-128);claims=[...sealed,...proposals];
    }
    if(event.kind==="assay.status"&&event.payload.obligationId) {
      const payload=event.payload;
      const key=`${payload.candidateId??"none"}/${payload.assayId}`;
      if(this.#assays.size<4096||this.#assays.has(key))this.#assays.set(key,{obligationId:payload.obligationId!,status:payload.status});
      claims=claims.map(claim=>{const rows=[...this.#assays.values()].filter(assay=>assay.obligationId===claim.id);return{...claim,passed:rows.filter(row=>row.status==="passed").length,failed:rows.filter(row=>row.status==="failed").length,other:rows.filter(row=>!["passed","failed"].includes(row.status)).length};});
    }
    if(event.kind==="candidate.status") {
      if(this.#candidates.size<4096||this.#candidates.has(event.payload.candidateId))this.#candidates.set(event.payload.candidateId,event.payload.status);
      lanes=lanes.map(lane=>({...lane,status:this.#laneStatus(lane.candidateIds)}));
    }
    if(event.kind==="evidence.observed"&&event.payload.audit?.kind==="lineage_commitment") {
      const audit=event.payload.audit;
      const lane:TuiLane={id:audit.lineageId,provider:audit.providerId,model:audit.modelId,candidateIds:audit.candidateIds,status:this.#laneStatus(audit.candidateIds),seedEnforcement:audit.seedEnforcement};
      lanes=[...lanes.filter(row=>row.id!==lane.id),lane].slice(-256);
    }
    this.#update({claims,lanes,frames:[...this.#snapshot.frames,frame].slice(-20),observed:this.#snapshot.observed+1});
  }
  #laneStatus(ids:readonly string[]):string {return ids.length?ids.map(id=>this.#candidates.get(id)??"committed").join(", "):"no candidate committed";}
  async input(text:string,key:TuiKey={}):Promise<void> {
    if(this.#closed)return;
    if(text==="q"||text==="c"&&key.ctrl){this.#quit();return;}
    if(key.escape){if(this.#snapshot.selection&&!this.#snapshot.submitting)this.#update({selection:null,quantity:"",message:"Quantity entry cancelled"});else this.#quit();return;}
    if(!this.#snapshot.interactive)return;
    if(key.tab){const panels:TuiPanel[]=["overview","claims","lanes","balls"];this.#update({panel:panels[(panels.indexOf(this.#snapshot.panel)+1)%panels.length]!,offset:0,...(this.#snapshot.selection&&!this.#snapshot.submitting?{selection:null,quantity:"",message:"Quantity entry cancelled when changing panels"}:{})});return;}
    if(key.upArrow||key.downArrow){const length=this.#snapshot.panel==="claims"?this.#snapshot.claims.length:this.#snapshot.panel==="lanes"?this.#snapshot.lanes.length:0;this.#update({offset:Math.max(0,Math.min(Math.max(0,length-1),this.#snapshot.offset+(key.downArrow?1:-1)))});return;}
    if(this.#snapshot.submitting)return;
    if(text==="r"){await this.refresh(true);return;}
    const selected=this.#snapshot.selection;
    if(selected) {
      if(key.backspace||key.delete){this.#update({quantity:this.#snapshot.quantity.slice(0,-1)});return;}
      if(key.return){await this.#redeem(selected);return;}
      if(text&&/^[0-9]+$/u.test(text)&&this.#snapshot.quantity.length+text.length<=2)this.#update({quantity:this.#snapshot.quantity+text});
      else if(text)this.#update({message:"Only a finite decimal quantity is accepted"});
      return;
    }
    if(!/^[1-5]$/u.test(text)||this.#snapshot.control!=="juggler"||this.#snapshot.uncertain||this.#snapshot.offers?.admission!=="open")return;
    const offer=this.#snapshot.offers.offers[Number(text)-1];
    if(offer)this.#update({panel:"balls",offset:0,selection:offer,quantity:"",message:`Enter quantity 1–${offer.maxQuantity}; Enter redeems this opaque offer.`});
  }
  async #redeem(selected:MetabolicOffer):Promise<void> {
    if(this.#snapshot.control!=="juggler"||this.#snapshot.authentication!=="seal-verified"||this.#snapshot.uncertain||this.#snapshot.submitting||this.#snapshot.offers?.admission!=="open")return;
    const current=this.#snapshot.offers.offers.find(offer=>offer.ballId===selected.ballId);
    if(!current){this.#update({selection:null,quantity:"",message:"That offer expired; refresh current offers"});return;}
    let quantity:number;
    try{quantity=parseTuiQuantity(this.#snapshot.quantity,current.maxQuantity);}catch(error){this.#update({message:(error as Error).message});return;}
    this.#update({submitting:true,message:`Submitting ${quantity} ${current.kind} once…`});
    try {
      const receipt=await this.#client.redeemMetabolism(this.#snapshot.caseId,current.ballId,quantity,this.#abort.signal);
      this.#update({lastReceipt:receipt,selection:null,quantity:"",offers:null,submitting:false,message:`Signed receipt ${receipt.receipt.sequence}: +${quantity} ${current.kind} · ${receipt.receipt.digest}`});
      await this.refresh();
    } catch(error) {
      this.#update({submitting:false,selection:null,quantity:"",offers:null,uncertain:true,message:`Redemption not confirmed: ${error instanceof Error?error.message:String(error)}. No retry was sent. Press r to inspect signed history.`});
    }
  }
  close():void {if(this.#closed)return;this.#closed=true;this.#abort.abort();if(this.#timer)clearTimeout(this.#timer);}
}
