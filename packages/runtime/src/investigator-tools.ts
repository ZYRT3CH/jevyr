import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { parseJsonText } from "@jevyr/core";
import type { MindRequest } from "./contracts.js";
import { indexSealedCode } from "./code-index.js";
import { safeSourceReadReceipt, TASK_SOURCE_INSPECTION_POLICY, type SourceReadReceipt } from "./task-source-inspection.js";
import { SubjectContextRefusal } from "./subject-context.js";

export const INVESTIGATOR_TOOL_POLICY = Object.freeze({ protocol: "jevyr.investigator-tools/1", maximumRounds: 4, maximumCallsPerRound: 4, maximumResultBytes: 32_000, sourceInspectionRequiredWhenAvailable: true, requiredTaskReferences: TASK_SOURCE_INSPECTION_POLICY, requestFormats: Object.freeze(["native-functions", "jevyr.context-tools/1"]), authority: "context-only", permittedInputs: "authorized-sealed-source-catalog-initial-projection-and-public-facts" });
export interface InvestigatorToolReceipt {
  readonly protocol: "jevyr.investigator-tool-receipt/1";
  readonly name: string;
  readonly argumentsDigest: string;
  readonly resultDigest: string;
  readonly sourceDigests: readonly string[];
  readonly resultBytes: number;
  readonly status: "observed" | "denied";
  readonly authority: "context-only";
  readonly requestFormat?: "native-functions" | "jevyr.context-tools/1";
  readonly sourceRead?: SourceReadReceipt;
}

const schema = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: "object", properties, required, additionalProperties: false });
const directoryPageSchema = () => schema({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 128 } }, []);
export const INVESTIGATOR_TOOL_DEFINITIONS = Object.freeze([
  { name: "list_subject_files", description: "Page only captured files permitted for this provider, with opaque IDs. Optional offset defaults to 0 and limit to 64 (maximum 128); the byte budget may shorten a page. Continue at nextOffset until null. This does not read live files or count as source inspection.", parameters: directoryPageSchema() },
  { name: "read_subject_lines", description: "Read at most 80 lines of one sealed file by the opaque ID returned by list_subject_files.", parameters: schema({ fileId: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["fileId", "startLine", "endLine"]) },
  { name: "search_subject", description: "Search captured source with literal text, returning at most 30 digest-bound excerpts. With a sealed catalog, optional offset/startLine resume at the returned file-and-line cursor; inspect truncation metadata.", parameters: schema({ query: { type: "string", minLength: 1, maxLength: 256 }, offset: { type: "integer", minimum: 0 }, startLine: { type: "integer", minimum: 1 } }, ["query"]) },
  { name: "find_symbols", description: "Find syntax-tree symbol locations in captured source; syntax attribution does not establish behavior.", parameters: schema({ query: { type: "string", maxLength: 256 } }, ["query"]) },
  { name: "list_revision_files", description: "Page digest-bound generated parent files available for this feedback round. Optional offset defaults to 0 and limit to 64 (maximum 128); continue at nextOffset until null. These are proposals, not sealed original subjects or source inspection.", parameters: directoryPageSchema() },
  { name: "read_revision_lines", description: "Read at most 80 lines of a permitted committed parent file using its opaque revision file ID.", parameters: schema({ fileId: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["fileId", "startLine", "endLine"]) },
  { name: "inspect_public_evidence", description: "Inspect one already-public contribution. All model and peer statements remain untrusted testimony.", parameters: schema({ id: { type: "string" } }, ["id"]) },
  { name: "list_experiment_templates", description: "List the exact presealed experiment sockets. This cannot create an assay, choose a command, or execute work.", parameters: schema({}, []) },
  { name: "list_critical_obligations", description: "Read the immutable critical proof obligations and their sealed oracle bindings.", parameters: schema({}, []) },
  { name: "list_repository_tests", description: "Page tests discovered in the permitted sealed repository and inspect dependency or evaluator refusals. This is context-only discovery, never test execution, an admitted new assay, or proof that tests pass.", parameters: directoryPageSchema() },
].map(definition => Object.freeze({ type: "function", function: Object.freeze(definition) })));

const fileIdentity = (subjectId: string, path: string, sourceDigest: string) => digestJson({ subjectId, path, sourceDigest });
const denialCodes=["UNKNOWN_TOOL","INVALID_ARGUMENTS","UNKNOWN_FILE","INVALID_RANGE","EMPTY_RANGE","RESULT_LIMIT","UNAVAILABLE_CONTEXT"] as const;
type ToolDenialCode=typeof denialCodes[number];
class ToolRefusal extends TypeError { constructor(readonly denialCode:ToolDenialCode){super("Context request refused");} }

/** Pagination changes only how the same provider-visible manifest is displayed.
 * Its actual encoded result, including cursor metadata, fits the existing cap. */
function directoryPage<T>(metadata: Readonly<Record<string, unknown>>, entries: readonly T[], parameters: Readonly<Record<string, unknown>>): unknown {
  const offset = Object.hasOwn(parameters, "offset") ? parameters.offset : 0;
  const limit = Object.hasOwn(parameters, "limit") ? parameters.limit : 64;
  if (!Number.isSafeInteger(offset) || typeof offset !== "number" || offset < 0 || offset > entries.length
    || !Number.isSafeInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 128) throw new TypeError("Invalid bounded directory page");
  const selected: T[] = [];
  const result = (files: readonly T[]) => ({ ...metadata, files, offset, limit, total: entries.length, nextOffset: offset + files.length < entries.length ? offset + files.length : null });
  for (const entry of entries.slice(offset, offset + limit)) {
    const next = [...selected, entry];
    if (Buffer.byteLength(JSON.stringify(result(next)), "utf8") > INVESTIGATOR_TOOL_POLICY.maximumResultBytes) break;
    selected.push(entry);
  }
  // Never skip an oversized identity or return a cursor that cannot advance.
  if (selected.length === 0 && offset < entries.length) throw new TypeError("One directory entry exceeds the result budget");
  return result(selected);
}

/** There is no filesystem, URL, shell, process, or external-tool resolver in this membrane. */
export async function executeInvestigatorTool(request: MindRequest, name: string, rawArguments: string): Promise<{ readonly content: string; readonly receipt: InvestigatorToolReceipt }> {
  const sourceDigests = new Set<string>();
  let status: InvestigatorToolReceipt["status"] = "observed";
  let result: unknown;
  let sourceRead: SourceReadReceipt | undefined;
  try {
    if (rawArguments.length > 4_096) throw new ToolRefusal("INVALID_ARGUMENTS");
    const args = parseJsonText(rawArguments, "investigator tool arguments");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolRefusal("INVALID_ARGUMENTS");
    const parameters = args as Record<string, unknown>;
    const definition = INVESTIGATOR_TOOL_DEFINITIONS.find(tool => tool.function.name === name);
    if (!definition) throw new ToolRefusal("UNKNOWN_TOOL");
    const allowed = definition.function.parameters.properties;
    if (Object.keys(parameters).some(key => !Object.hasOwn(allowed, key)) || definition.function.parameters.required.some(key => !Object.hasOwn(parameters, key))) throw new ToolRefusal("INVALID_ARGUMENTS");
    const projection = request.subjectProjection;
    if (projection) {
      const { projectionDigest, ...body } = projection;
      if (digestJson(body as unknown as JsonValue) !== projectionDigest) throw new TypeError("Sealed projection digest mismatch");
      for (const file of projection.files) if (sha256Digest(file.text) !== file.sourceDigest || Buffer.byteLength(file.text) !== file.sourceByteLength) throw new TypeError("Sealed source bytes mismatch");
    }
    const files = projection?.files ?? [];
    const context = request.subjectContext;
    if (context && context.descriptor.captureDigest !== request.sealed.subjectMaterialCaptureDigest) throw new TypeError("Subject context differs from the sealed Case capture");
    if (context && ["list_subject_files", "read_subject_lines", "search_subject"].includes(name)) {
      const observed = name === "list_subject_files"
        ? await context.listFiles(parameters as { offset?: number; limit?: number })
        : name === "read_subject_lines"
          ? await context.readLines(parameters as { fileId: string; startLine: number; endLine: number })
          : await context.search(parameters as { query: string; offset?: number; startLine?: number });
      result = observed.value;
      for (const digest of observed.sourceDigests) sourceDigests.add(digest);
      if (observed.sourceRead) {
        sourceRead = safeSourceReadReceipt(observed.sourceRead);
        if (name !== "read_subject_lines" || sourceRead.catalogDigest !== context.descriptor.catalogDigest || !sourceDigests.has(sourceRead.sourceDigest)) throw new TypeError("Source read lost its catalog binding");
      }
    } else if (name === "list_subject_files") result = directoryPage({ availability: projection ? "CAPTURED" : "WITHHELD_BY_PRIVACY_SCOPE", omissions: projection?.omissions.length ?? 0 }, files.map(file => ({ fileId: fileIdentity(file.subjectId, file.path, file.sourceDigest), subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest, lines: file.text.split(/\r?\n/u).length })), parameters);
    else if (name === "read_subject_lines") {
      if (typeof parameters.fileId !== "string" || !Number.isSafeInteger(parameters.startLine) || !Number.isSafeInteger(parameters.endLine)) throw new ToolRefusal("INVALID_RANGE");
      const start = parameters.startLine as number, end = parameters.endLine as number;
      if (start < 1 || end < start || end - start >= 80) throw new ToolRefusal("INVALID_RANGE");
      const file = files.find(entry => fileIdentity(entry.subjectId, entry.path, entry.sourceDigest) === parameters.fileId);
      if (!file) throw new ToolRefusal("UNKNOWN_FILE");
      const lines = file.text.split(/\r?\n/u), text = lines.slice(start - 1, end).join("\n");
      if (start > lines.length || Buffer.byteLength(text, "utf8") === 0) throw new ToolRefusal("EMPTY_RANGE");
      sourceDigests.add(file.sourceDigest);
      const endLine = Math.min(end, lines.length), completeFile = start === 1 && endLine === lines.length;
      sourceRead = safeSourceReadReceipt({ catalogDigest: projection!.projectionDigest, fileId: fileIdentity(file.subjectId, file.path, file.sourceDigest), sourceDigest: file.sourceDigest, sourceByteLength: file.sourceByteLength, textDigest: sha256Digest(text), startLine: start, endLine, totalLines: lines.length, completeFile });
      result = { sourceDigest: file.sourceDigest, sourceByteLength:file.sourceByteLength,startLine: start, endLine, totalLines: lines.length, completeFile, text,
        textDigest:sourceRead.textDigest,textByteLength:Buffer.byteLength(text),textNormalization:"CRLF_TO_LF",textNormalized:text!==file.text.split("\n").slice(start-1,end).join("\n"),textMatchesSourceBytes:completeFile&&sourceRead.textDigest===file.sourceDigest };
    } else if (name === "search_subject") {
      if (typeof parameters.query !== "string" || parameters.query.length < 1 || parameters.query.length > 256) throw new TypeError("A bounded literal query is required");
      if (parameters.offset !== undefined && parameters.offset !== 0) throw new TypeError("Paged search requires a sealed subject catalog");
      if (parameters.startLine !== undefined && parameters.startLine !== 1) throw new TypeError("Paged search requires a sealed subject catalog");
      const matches = [];
      for (const file of files) {
        const lines = file.text.split(/\r?\n/u);
        for (let index = 0; index < lines.length && matches.length < 30; index++) if (lines[index]!.includes(parameters.query)) {
          sourceDigests.add(file.sourceDigest);
          matches.push({ fileId: fileIdentity(file.subjectId, file.path, file.sourceDigest), sourceDigest: file.sourceDigest, line: index + 1, text: lines[index]!.slice(0, 512) });
        }
        if (matches.length >= 30) break;
      }
      result = { matches, truncated: matches.length === 30 };
    } else if (name === "find_symbols") {
      if (typeof parameters.query !== "string" || parameters.query.length > 256) throw new TypeError("A bounded literal symbol query is required");
      if (!projection) throw new TypeError("Source is withheld from this provider");
      const index = await indexSealedCode(projection);
      const nodes = index.nodes.filter(node => node.name.includes(parameters.query as string)).slice(0, 30);
      nodes.forEach(node => sourceDigests.add(node.sourceDigest));
      result = { indexDigest: index.digest, attribution: "syntax-only", scope: "initial-text-projection", nodes, omissions: index.omissions.length, ...(context ? { broaderSourceSearch: "Use search_subject and read_subject_lines for files beyond the initial syntax index." } : {}) };
    } else if (name === "list_revision_files" || name === "read_revision_lines") {
      const sources = request.revisionSources ?? [];
      for (const source of sources) {
        if (!request.revision?.parentCandidateIds.includes(source.candidateId) || source.files.some(file => sha256Digest(file.content) !== file.digest)) throw new TypeError("Revision parent bytes lost their bound identity");
      }
      const files = sources.flatMap(source => source.files.map(file => ({ ...file, candidateId: source.candidateId, fileId: fileIdentity(source.candidateId, file.path, file.digest) })));
      if (name === "list_revision_files") result = directoryPage({ availability: sources.length ? "COMMITTED_PARENT" : "UNAVAILABLE_OR_WITHHELD" }, files.map(({ candidateId, fileId, path, digest, content }) => ({ candidateId, fileId, path, sourceDigest: digest, lines: content.split(/\r?\n/u).length })), parameters);
      else {
        const start = parameters.startLine as number, end = parameters.endLine as number;
        if (typeof parameters.fileId !== "string" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 80) throw new ToolRefusal("INVALID_RANGE");
        const file = files.find(file => file.fileId === parameters.fileId);
        if (!file) throw new ToolRefusal("UNKNOWN_FILE");
        const lines = file.content.split(/\r?\n/u), text = lines.slice(start - 1, end).join("\n");
        if (start > lines.length || Buffer.byteLength(text, "utf8") === 0) throw new ToolRefusal("EMPTY_RANGE");
        sourceDigests.add(file.digest);
        result = { candidateId: file.candidateId, sourceDigest: file.digest, startLine: start, endLine: Math.min(end, lines.length), text };
      }
    } else if (name === "inspect_public_evidence") {
      if (typeof parameters.id !== "string") throw new TypeError("Contribution ID is required");
      const fact = request.publicFacts.find(entry => entry.id === parameters.id);
      if (!fact) throw new TypeError("Contribution is absent from this lane's visible public facts");
      result = { id: fact.id, kind: fact.kind, summary: fact.summary, body: fact.body?.slice(0, 8_000) ?? null, evidenceRefs: fact.evidenceRefs ?? [], authority: "untrusted-contribution" };
    } else if (name === "list_repository_tests") {
      const plan = context?.repositoryEvaluationPlan;
      if (plan && (plan.captureDigest !== request.sealed.subjectMaterialCaptureDigest || plan.intentContractDigest !== request.sealed.intentContractDigest)) throw new TypeError("Repository discovery differs from the sealed task");
      result = directoryPage({ availability: plan ? "DISCOVERY_INVENTORY" : "UNAVAILABLE_OR_WITHHELD", authority: "context-only", planDigest: plan?.digest ?? null,
        scope: plan?.scope ?? null, target: plan?.target ?? null, coverage: plan?.coverage ?? null },
      plan?.subjects.flatMap(subject => subject.testFiles.map(file => ({ subjectId: subject.subjectId, fileId: fileIdentity(subject.subjectId, file.path, file.digest), path: file.path,
        sourceDigest: file.digest, sourceByteLength: file.bytes, suiteDigest: subject.suiteDigest, executionStatus: "NOT_ESTABLISHED_BY_DISCOVERY",
        refusals: [...new Set(subject.refusals.map(refusal => refusal.code))].slice(0, 12).map(code => ({ code })), refusalCount: subject.refusals.length }))) ?? [], parameters);
    } else if (name === "list_experiment_templates") result = { capability: request.experimentCapability ?? null, authority: "sealed-template-inspection-only" };
    else result = { intentContractDigest: request.sealed.intentContractDigest, obligations: request.sealed.intentContract.criticalObligations };
    if (Buffer.byteLength(JSON.stringify(result)) > INVESTIGATOR_TOOL_POLICY.maximumResultBytes) throw new ToolRefusal("RESULT_LIMIT");
  } catch(error) {
    status = "denied";
    sourceDigests.clear();
    sourceRead = undefined;
    // No raw argument, source text, or parser exception crosses the denial boundary.
    const denialCode=(error instanceof ToolRefusal||error instanceof SubjectContextRefusal)&&denialCodes.includes(error.denialCode as ToolDenialCode)?error.denialCode:"UNAVAILABLE_CONTEXT";
    result = { denied: true, denialCode, reason: "Malformed, unavailable, or oversized context request" };
  }
  const content = JSON.stringify(result);
  return { content, receipt: Object.freeze({ protocol: "jevyr.investigator-tool-receipt/1", name, argumentsDigest: sha256Digest(rawArguments), resultDigest: sha256Digest(content), sourceDigests: Object.freeze([...sourceDigests].sort()), resultBytes: Buffer.byteLength(content), status, authority: "context-only", ...(sourceRead ? { sourceRead } : {}) }) };
}
