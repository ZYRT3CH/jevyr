import type { JevyrRecord, LiveFrame, SealReceipt } from "@jevyr/sdk";

const enabled = Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
const paint = (code: number, value: string): string => (enabled ? `\u001b[${code}m${value}\u001b[0m` : value);

export function renderFrame(frame: LiveFrame): string {
  const event = frame.event;
  const cursor = String(frame.cursor).padStart(4, "0");
  const stage = event.stage.padEnd(15);
  const trace = frame.headDigest.slice(7, 19);
  const transport = frame.transport === "sse" ? "LIVE" : "POLL";
  const summary = "summary" in event.payload && typeof event.payload.summary === "string"
    ? event.payload.summary
    : event.kind === "reflex.completed"
      ? `Reflex ${event.payload.decision}; ${event.payload.materialFindings.length} material finding(s).`
      : event.kind;
  return `${paint(2, cursor)} ${paint(36, stage)} ${paint(35, event.kind.padEnd(20))} ${summary} ${paint(2, `[${transport} ${trace}]`)}`;
}

export function renderRecord(record: JevyrRecord): string {
  const axes = record.verdict;
  return [
    `Record ${record.caseDigest}`,
    `recorded-verdict integrity=${axes.integrity} creation=${axes.creation} embodiment=${axes.embodiment} judgment=${axes.judgment}`,
    `case=${record.caseDigest}`,
    `run=${record.runDigest}`,
    `trace=${record.eventHeadDigest}`,
    `policy=${record.verdict.policyVersion}`,
  ].join("\n");
}

export function renderSealReceipt(receipt: SealReceipt): string {
  return [
    receipt.caseId,
    `sealed ${receipt.caseDigest}`,
    `subjectMaterialCaptureDigest=${receipt.subjectMaterialCaptureDigest}`,
    `watch: jevyr watch ${receipt.caseId}`,
  ].join("\n");
}

export function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
