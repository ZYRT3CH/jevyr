import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJsonBytes } from "@jevyr/core";
import { assertCaseSubmission, validateAirlockChoices } from "@jevyr/protocol";
import { JevyrClient, type AirlockDraft } from "@jevyr/sdk";
import { flag, option, type ParsedArguments } from "./arguments.js";

export function httpClientHeaders(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const reference = env.JEVYR_HTTP_TOKEN_REF;
  if (reference === undefined) return {};
  if (!/^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(reference)) throw new TypeError("JEVYR_HTTP_TOKEN_REF requires env:NAME");
  const value = env[reference.slice(4)];
  if (!value || value.length < 32 || value.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(value)) throw new TypeError("HTTP access broker reference is unavailable or invalid");
  return { authorization: `Bearer ${value}` };
}
async function readSubmission(base: string, path: string | undefined) {
  if (!path) throw new TypeError("A bounded Case JSON file is required with --file");
  const handle = await open(resolve(base, path), "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 1_048_576) throw new TypeError("Case input must be a regular file no larger than 1 MiB");
    const bytes = Buffer.alloc(1_048_577); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (result.bytesRead === 0) break; length += result.bytesRead; }
    const after = await handle.stat();
    if (length > 1_048_576 || length !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) throw new TypeError("Case input changed during its bounded read");
    const value = parseJsonBytes(bytes.subarray(0, length), "Case input");
    if (value && typeof value === "object" && !Array.isArray(value) && (value as any).protocol === "jevyr.airlock-input/1") {
      if (Object.keys(value).sort().join("\0") !== "choices\0protocol\0submission") throw new TypeError("Airlock input requires exactly protocol, submission, and choices");
      const wrapped = value as Record<string, unknown>;
      assertCaseSubmission(wrapped.submission);
      return { submission: wrapped.submission, choices: validateAirlockChoices(wrapped.choices) };
    }
    assertCaseSubmission(value);
    return { submission: value, choices: undefined };
  } finally { await handle.close(); }
}
function revision(args: ParsedArguments): number {
  const value = option(args, "revision");
  if (!value || !/^[1-9][0-9]?$/u.test(value) || Number(value) > 32) throw new TypeError("--revision must identify the exact visible draft revision, from 1 through 32");
  return Number(value);
}
function show(draft: AirlockDraft, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(draft, null, 2)}\n`
    : `${draft.draftId} · ${draft.state} · revision ${draft.revision}\n${draft.submission.case.impulse}\nseed ${draft.submission.case.seed}\npolicy ${draft.startup.policyDigest}\ncritical claims ${draft.preview.criticalObligations.length}\n${draft.receipt ? `case ${draft.receipt.caseId}\n` : "Edit this draft or seal its exact revision and policy digest.\n"}`);
}
export async function runAirlockCommand(args: ParsedArguments, base: string, client: JevyrClient): Promise<number> {
  if (args.command === "abort") {
    const receipt = await client.abort(args.positionals[0]!);
    process.stdout.write(flag(args, "json") ? `${JSON.stringify(receipt)}\n` : `${receipt.caseId}: abort accepted; INVALID closure will follow. This Case cannot resume.\n`);
    return 0;
  }
  if (args.command === "run") {
    const input = await readSubmission(base, option(args, "file") ?? option(args, "case"));
    let draft = await client.createDraft(input.submission);
    if (input.choices) draft = await client.replaceDraft(draft.draftId, draft.revision, draft.submission, undefined, input.choices);
    const sealed = await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest);
    const result = await client.waitForAuthenticatedRecord(sealed.receipt!.caseId);
    process.stdout.write(`${JSON.stringify(result, null, flag(args, "json") ? undefined : 2)}\n`);
    return 0;
  }
  const [action = "create", id] = args.positionals;
  let draft: AirlockDraft;
  if (action === "create") {
    const input = await readSubmission(base, option(args, "file"));
    draft = await client.createDraft(input.submission);
    if (input.choices) draft = await client.replaceDraft(draft.draftId, draft.revision, draft.submission, undefined, input.choices);
  }
  else if (action === "show") draft = await client.draft(id!);
  else if (action === "edit") {
    const input = await readSubmission(base, option(args, "file"));
    draft = await client.replaceDraft(id!, revision(args), input.submission, undefined, input.choices);
  }
  else if (action === "seal") {
    const policy = option(args, "policy-digest");
    if (!policy || !/^sha256:[a-f0-9]{64}$/u.test(policy)) throw new TypeError("Seal requires the previewed --policy-digest sha256:...");
    draft = await client.sealDraft(id!, revision(args), policy);
  } else throw new TypeError("airlock supports create, show, edit, and seal");
  show(draft, flag(args, "json"));
  return 0;
}
