import { assertCaseSubmission, type CaseSubmission, type LiveCaseStatus } from "@jevyr/protocol";
import type { DaemonRuntime } from "./runtime.js";
import { TransportError, transportKeys, transportObject } from "./transports.js";

export const A2A_PREFIX = "/a2a";
export const A2A_VERSION = "1.0";

export function a2aAgentCard(baseUrl: string): unknown {
  return {
    name: "Jevyr", description: "Cast once. A world answers. One sealed Case per task; no continuation, approval, cancellation, or verdict input.",
    version: "0.1.0",
    supportedInterfaces: [{ url: `${baseUrl}${A2A_PREFIX}`, protocolBinding: "HTTP+JSON", protocolVersion: A2A_VERSION }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json", "text/plain"], defaultOutputModes: ["application/json"],
    skills: [{ id: "cast", name: "Cast", description: "Submit one complete jevyr.case/1 object as a data part, or one text impulse. Existing taskId and contextId input is refused.", tags: ["sealed-case", "create", "judge"] }],
  };
}

export function parseA2aCast(value: unknown): { submission: CaseSubmission; returnImmediately: boolean } {
  const request = transportObject(value, "A2A SendMessage");
  transportKeys(request, ["message", "configuration"], "A2A SendMessage");
  const message = transportObject(request.message, "A2A message");
  if (Object.hasOwn(message, "taskId") || Object.hasOwn(message, "contextId")) throw new TransportError(405, "Sealed Cases have no A2A continuation or context input");
  transportKeys(message, ["messageId", "role", "parts"], "A2A message");
  if (message.role !== "ROLE_USER" || typeof message.messageId !== "string" || message.messageId.length < 1 || message.messageId.length > 256) throw new TypeError("A2A message requires ROLE_USER and a bounded messageId");
  if (!Array.isArray(message.parts) || message.parts.length !== 1) throw new TypeError("A2A Cast requires exactly one complete data or text part");
  const part = transportObject(message.parts[0], "A2A part");
  transportKeys(part, ["data", "text", "mediaType"], "A2A part");
  if (Object.hasOwn(part, "data") === Object.hasOwn(part, "text")) throw new TypeError("A2A Cast requires exactly one of data and text");
  if (part.mediaType !== undefined && part.mediaType !== (Object.hasOwn(part, "data") ? "application/json" : "text/plain")) throw new TypeError("A2A part mediaType does not match its content");
  const submission = Object.hasOwn(part, "data") ? part.data : { protocol: "jevyr.case/1", case: { impulse: part.text } };
  assertCaseSubmission(submission);
  let returnImmediately = false;
  if (request.configuration !== undefined) {
    const config = transportObject(request.configuration, "A2A configuration");
    transportKeys(config, ["returnImmediately", "historyLength", "acceptedOutputModes"], "A2A configuration");
    if (config.returnImmediately !== undefined && typeof config.returnImmediately !== "boolean") throw new TypeError("A2A returnImmediately must be boolean");
    if (config.historyLength !== undefined && (!Number.isSafeInteger(config.historyLength) || Number(config.historyLength) < 0)) throw new TypeError("A2A historyLength must be a nonnegative integer");
    if (config.acceptedOutputModes !== undefined && (!Array.isArray(config.acceptedOutputModes) || config.acceptedOutputModes.length > 16 || !config.acceptedOutputModes.includes("application/json") || config.acceptedOutputModes.some((mode) => typeof mode !== "string" || mode.length > 128))) throw new TypeError("A2A acceptedOutputModes must include application/json");
    returnImmediately = config.returnImmediately === true;
  }
  return { submission, returnImmediately };
}

function taskState(status: LiveCaseStatus): string {
  return status.lifecycle === "invalid" ? "TASK_STATE_FAILED" : status.lifecycle === "terminated" ? "TASK_STATE_COMPLETED" : status.lifecycle === "queued" ? "TASK_STATE_SUBMITTED" : "TASK_STATE_WORKING";
}

export async function a2aTask(runtime: DaemonRuntime, caseId: string): Promise<Record<string, unknown>> {
  const status = await runtime.status(caseId);
  if (!status) throw new TransportError(404, "A2A task not found");
  const receipt = await runtime.repository.receipt(caseId);
  const stopping = status.lifecycle === "terminated" || status.lifecycle === "invalid";
  const [terminalReceipt, terminalEnvelope] = stopping
    ? await Promise.all([runtime.repository.terminalReceipt(caseId), runtime.repository.terminalEnvelope(caseId)]) : [undefined, undefined];
  const terminal = stopping && terminalReceipt !== undefined && terminalEnvelope !== undefined;
  const record = terminal ? await runtime.repository.record(caseId) : undefined;
  return {
    id: caseId, contextId: caseId,
    status: { state: stopping && !terminal ? "TASK_STATE_WORKING" : taskState(status) },
    ...(record ? { artifacts: [{ artifactId: `record_${caseId}`, name: "Signed Record", parts: [{ data: record, mediaType: "application/json" }] }] } : {}),
    metadata: {
      caseDigest: status.caseDigest, runDigest: status.runDigest, semanticContinuation: false, seal: receipt, sealEnvelope: await runtime.repository.sealEnvelope(caseId),
      ...(terminal ? { terminal: terminalReceipt, recordEnvelope: await runtime.repository.recordEnvelope(caseId), terminalEnvelope } : {}),
    },
  };
}

/** A2A progress is a projection of the immutable ledger, never an input channel. */
export async function streamA2aTask(
  runtime: DaemonRuntime,
  caseId: string,
  after: number,
  signal: AbortSignal,
  send: (value: unknown, sequence?: number) => Promise<boolean>,
): Promise<void> {
  const initial = await runtime.status(caseId);
  if (!initial) throw new TransportError(404, "A2A task not found");
  const initialTask = await a2aTask(runtime, caseId);
  if (!await send({ task: initialTask })) return;
  const initialState = (initialTask.status as { state: string }).state;
  if (initialState === "TASK_STATE_COMPLETED" || initialState === "TASK_STATE_FAILED") return;
  let cursor = after;
  while (!signal.aborted) {
    const status = await runtime.status(caseId);
    if (!status) throw new Error("A2A task disappeared");
    if (status.caseDigest !== initial.caseDigest || status.runDigest !== initial.runDigest) throw new Error("A2A task binding changed");
    const terminal = status.lifecycle === "terminated" || status.lifecycle === "invalid";
    if (terminal && cursor >= status.lastSequence && await runtime.repository.terminalReceipt(caseId) && await runtime.repository.terminalEnvelope(caseId)) {
      const task = await a2aTask(runtime, caseId);
      if (Array.isArray(task.artifacts)) for (const artifact of task.artifacts) {
        if (!await send({ artifactUpdate: { taskId: caseId, contextId: caseId, artifact, append: false, lastChunk: true } })) return;
      }
      await send({ statusUpdate: { taskId: caseId, contextId: caseId, status: task.status, metadata: task.metadata } });
      return;
    }
    const page = await runtime.events.wait(caseId, cursor, 1_000, signal);
    for (const event of page.events) {
      if (event.caseDigest !== initial.caseDigest || event.runDigest !== initial.runDigest) throw new Error("A2A event crossed the sealed Case boundary");
      const value = { statusUpdate: { taskId: caseId, contextId: caseId, status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", messageId: `${caseId}:${event.sequence}`, parts: [{ data: event, mediaType: "application/json" }] } } } };
      if (!await send(value, event.sequence)) return;
      cursor = event.sequence;
    }
  }
}
