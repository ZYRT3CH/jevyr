import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import type { MindRequest } from "./contracts.js";
import type { InvestigatorToolReceipt } from "./investigator-tools.js";

export const TASK_SOURCE_INSPECTION_POLICY = Object.freeze({ protocol: "jevyr.task-source-inspection/1", maximumRequiredFiles: 4, maximumReferences: 32, maximumTaskChars: 65_536, maximumLiteralChars: 512, maximumLines: 80, maximumResultBytes: 32_000, authority: "context-only", scope: "explicit-sealed-task-literals-only" });
export interface SourceInspectionFile {
  readonly fileId: string; readonly path: string; readonly sourceDigest: string; readonly sourceByteLength: number;
  readonly ociReadOnlyPath?: string; readonly totalLines: number | null;
  readonly classification: "readable" | "binary" | "empty" | "uninspected";
  readonly completeReadFits: boolean;
}
export interface SourceReadReceipt {
  readonly catalogDigest: string; readonly fileId: string; readonly sourceDigest: string; readonly sourceByteLength: number;
  readonly textDigest: string; readonly startLine: number; readonly endLine: number; readonly totalLines: number; readonly completeFile: boolean;
}
/** Keep failure diagnostics digest-only; strip extra fields rather than retaining caller objects. */
export function safeSourceReadReceipt(value: SourceReadReceipt): SourceReadReceipt {
  if (!value || [value.catalogDigest, value.fileId, value.sourceDigest, value.textDigest].some(digest => !isSha256Digest(digest))
    || [value.sourceByteLength, value.startLine, value.endLine, value.totalLines].some(count => !Number.isSafeInteger(count) || count < 1)
    || value.startLine > value.endLine || value.endLine > value.totalLines || value.endLine - value.startLine >= TASK_SOURCE_INSPECTION_POLICY.maximumLines
    || typeof value.completeFile !== "boolean" || value.completeFile !== (value.startLine === 1 && value.endLine === value.totalLines)) throw new TypeError("Invalid bounded source-read receipt");
  return Object.freeze({ catalogDigest: value.catalogDigest, fileId: value.fileId, sourceDigest: value.sourceDigest, sourceByteLength: value.sourceByteLength, textDigest: value.textDigest, startLine: value.startLine, endLine: value.endLine, totalLines: value.totalLines, completeFile: value.completeFile });
}
export interface TaskSourceReference {
  readonly literal: string; readonly field: string; readonly start: number; readonly end: number;
  readonly status: "REQUIRED" | "DUPLICATE" | "AMBIGUOUS" | "NOT_IN_PERMITTED_CATALOG" | "NOT_READABLE" | "UNCLASSIFIED" | "PARTIAL_ONLY" | "REFERENCE_CAP";
  readonly fileId?: string; readonly sourceDigest?: string; readonly sourceByteLength?: number; readonly totalLines?: number;
  readonly ociReadOnlyPath?: string;
}
export interface TaskSourceInspectionPlan {
  readonly protocol: "jevyr.task-source-inspection-plan/1"; readonly catalogDigest: string | null;
  readonly taskDigest: string; readonly policyDigest: string; readonly references: readonly TaskSourceReference[];
  readonly truncatedTask: boolean; readonly referenceLimitReached: boolean; readonly literalLimitReached: boolean; readonly digest: string;
}

function projectionCatalog(request: MindRequest): readonly SourceInspectionFile[] {
  return (request.subjectProjection?.files ?? []).map(file => {
    const totalLines = file.text.split(/\r?\n/u).length;
    // Reserve room for the fixed digest/range metadata in the actual result.
    return { fileId: digestJson({ subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest }), path: file.path,
      sourceDigest: file.sourceDigest, sourceByteLength: file.sourceByteLength, totalLines,
      classification: file.sourceByteLength > 0 ? "readable" : "empty",
      completeReadFits: totalLines <= 80 && Buffer.byteLength(JSON.stringify(file.text)) + 1024 <= 32_000 };
  });
}

/** This lexical recipe resolves metadata already permitted to this provider. It
 * never opens paths, follows URLs, reads source, or recurses into tool/model text. */
export function taskSourceInspectionPlan(request: MindRequest): TaskSourceInspectionPlan {
  const context = request.subjectContext;
  const aligned = !context || context.descriptor.captureDigest === request.sealed.subjectMaterialCaptureDigest;
  const catalog = aligned ? context?.inspectionCatalog ?? projectionCatalog(request) : [];
  const catalogDigest = aligned ? context?.descriptor.catalogDigest ?? request.subjectProjection?.projectionDigest ?? null : null;
  const task = [{ field: "impulse", text: request.sealed.intent.impulse }, ...request.sealed.intent.constraints.map((text, index) => ({ field: `constraint:${index}`, text }))];
  const references: TaskSourceReference[] = [], seen = new Set<string>(), required = new Set<string>();
  let remaining = TASK_SOURCE_INSPECTION_POLICY.maximumTaskChars, truncatedTask = false, referenceLimitReached = false, literalLimitReached = false;
  for (const input of task) {
    const text = input.text.slice(0, remaining); remaining -= text.length; truncatedTask ||= text.length < input.text.length;
    // File-like portable literals, including exact synthetic OCI paths. URLs,
    // drives, traversal and partial matches inside larger tokens are excluded.
    const pattern = /(?:\/subject\/subject-\d{4}\/|\.\/)?[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+/-]*\.[\p{L}\p{N}_+-]+/gu;
    const candidates = [...text.matchAll(pattern)].map(match => ({ literal: match[0], start: match.index!, quoted: false }));
    // Quoting can identify a portable file without an extension or with spaces.
    // A quoted command/prose span is not a file unless it resolves exactly.
    for (const match of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/gu)) {
      const literal = match[1] ?? match[2] ?? match[3]!;
      if (catalog.some(file => file.path === literal || file.ociReadOnlyPath === literal || (!literal.includes("/") && file.path.split("/").at(-1) === literal))) candidates.push({ literal, start: match.index! + 1, quoted: true });
    }
    candidates.sort((a, b) => a.start - b.start || Number(b.quoted) - Number(a.quoted));
    const quotedSpans = candidates.filter(candidate => candidate.quoted);
    for (const { literal, start, quoted } of candidates) {
      const end = start + literal.length;
      if (!quoted && quotedSpans.some(span => start >= span.start && end <= span.start + span.literal.length)) continue;
      const prefix = text.slice(0, start).match(/[^\s`"'()[\]{},;]*$/u)?.[0] ?? "";
      if (literal.length > TASK_SOURCE_INSPECTION_POLICY.maximumLiteralChars) { literalLimitReached = true; continue; }
      if ((!quoted && !/\p{L}/u.test(literal)) || /[:/\\\p{L}\p{N}_.@+-]/u.test(text[start - 1] ?? "")
        || /[:/\\\p{L}\p{N}_@+-]/u.test(text[end] ?? "") || prefix.includes("://") || literal.split("/").some(part => part === "..")) continue;
      if (seen.has(literal)) continue; seen.add(literal);
      if (references.length === TASK_SOURCE_INSPECTION_POLICY.maximumReferences) { referenceLimitReached = true; break; }
      const normalized = literal.startsWith("./") ? literal.slice(2) : literal;
      let matches = catalog.filter(file => file.path === normalized || file.ociReadOnlyPath === normalized);
      if (!matches.length && !normalized.includes("/")) matches = catalog.filter(file => file.path.split("/").at(-1) === normalized);
      const base = { literal, field: input.field, start, end };
      if (matches.length !== 1) { references.push({ ...base, status: matches.length ? "AMBIGUOUS" : "NOT_IN_PERMITTED_CATALOG" }); continue; }
      const file = matches[0]!;
      const status = required.has(file.fileId) ? "DUPLICATE" : file.classification === "uninspected" ? "UNCLASSIFIED"
        : file.classification !== "readable" ? "NOT_READABLE" : !file.completeReadFits || file.totalLines === null ? "PARTIAL_ONLY"
        : required.size >= TASK_SOURCE_INSPECTION_POLICY.maximumRequiredFiles ? "REFERENCE_CAP" : "REQUIRED";
      if (status === "REQUIRED") required.add(file.fileId);
      references.push({ ...base, status, fileId: file.fileId, sourceDigest: file.sourceDigest, sourceByteLength: file.sourceByteLength, ...(file.ociReadOnlyPath === undefined ? {} : {ociReadOnlyPath:file.ociReadOnlyPath}), ...(file.totalLines === null ? {} : { totalLines: file.totalLines }) });
    }
    if (referenceLimitReached) break;
  }
  const body = { protocol: "jevyr.task-source-inspection-plan/1" as const, catalogDigest, taskDigest: digestJson(task), policyDigest: digestJson(TASK_SOURCE_INSPECTION_POLICY), references, truncatedTask, referenceLimitReached, literalLimitReached };
  return Object.freeze({ ...body, references: Object.freeze(references.map(reference => Object.freeze(reference))), digest: digestJson(body as unknown as JsonValue) });
}

export function missingTaskSourceReferences(plan: TaskSourceInspectionPlan, receipts: readonly InvestigatorToolReceipt[]): readonly TaskSourceReference[] {
  return plan.references.filter(reference => reference.status === "REQUIRED" && !receipts.some(receipt => {
    const read = receipt.sourceRead;
    return receipt.status === "observed" && receipt.name === "read_subject_lines" && read?.completeFile === true
      && read.catalogDigest === plan.catalogDigest && read.fileId === reference.fileId && read.sourceDigest === reference.sourceDigest
      && read.sourceByteLength === reference.sourceByteLength && read.startLine === 1 && read.endLine === reference.totalLines
      && read.totalLines === reference.totalLines && receipt.sourceDigests.includes(read.sourceDigest);
  }));
}
