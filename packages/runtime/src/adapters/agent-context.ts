import type { MindRequest } from "../contracts.js";
import type { InvestigatorToolReceipt } from "../investigator-tools.js";
import { missingTaskSourceReferences, taskSourceInspectionPlan } from "../task-source-inspection.js";

/** Provider claims of inspection cannot substitute the context handler's receipt. */
export function assertAgentContextInspected(request:MindRequest,receipts:readonly InvestigatorToolReceipt[]):void {
  if(request.investigationTools!==true)return;
  if(missingTaskSourceReferences(taskSourceInspectionPlan(request),receipts).length>0)throw new Error("Agent final lacks complete reads for required task references");
  const readableSourceAvailable=request.subjectContext?request.subjectContext.descriptor.readableFiles>0:(request.subjectProjection?.files.some(file=>file.sourceByteLength>0&&file.text.length>0)??false);
  if(readableSourceAvailable&&!receipts.some(receipt=>receipt.status==="observed"&&["read_subject_lines","search_subject"].includes(receipt.name)&&receipt.sourceDigests.length>0))throw new Error("Agent final lacks a receipt for sealed source inspection");
  if((request.revisionSources?.length??0)>0&&!receipts.some(receipt=>receipt.status==="observed"&&receipt.name==="read_revision_lines"&&receipt.sourceDigests.length>0))throw new Error("Agent final lacks a receipt for committed parent source inspection");
}
