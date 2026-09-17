import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseJsonBytes } from "../packages/core/src/index.js";
import { canonicalJson } from "../packages/sdk/src/index.js";
import { verifyLocalProof } from "../apps/cli/src/local-proof.js";

const args = process.argv.slice(2);
const paths: string[] = [];
let output = "artifacts/lifecycle-evidence.json";
let keyId: string | undefined;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--output") output = args[++index]!;
  else if (args[index] === "--trusted-key-id") keyId = args[++index];
  else if (args[index] === "--report") paths.push(args[++index]!);
  else throw new TypeError(`Unknown lifecycle collector argument ${args[index]}`);
}
if (!paths.length || paths.some((path) => !path)) throw new TypeError("Use --report PATH once per lifecycle report to verify");
const reports = [];
for (const path of paths) {
  try {
    const reportPath = resolve(path);
    const bytes = await readFile(reportPath);
    if (bytes.byteLength > 64 * 1_048_576) throw new TypeError("Lifecycle report is too large");
    const value = parseJsonBytes(bytes, "Lifecycle report") as Record<string, unknown>;
    if (value.protocol !== "jevyr.lifecycle-proof/1" || typeof value.caseId !== "string") throw new TypeError("Not a lifecycle proof report");
    const proofRoot = join(dirname(reportPath), "proof");
    if (value.proofDirectory !== undefined && resolve(String(value.proofDirectory)) !== proofRoot) throw new TypeError("Proof must be the report's sibling proof directory");
    const verification = await verifyLocalProof(proofRoot, keyId);
    const reportMatches = verification.valid && verification.caseId === value.caseId && canonicalJson(verification.verdict) === canonicalJson(value.verdict);
    reports.push({ reportPath, reportDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, declaredMode: value.mode, declaredModelProduced: value.modelProduced, reportMatches, verification });
  } catch (error) { reports.push({ reportPath: path, reportMatches: false, error: error instanceof Error ? error.message : String(error) }); }
}
const document = {
  protocol: "jevyr.lifecycle-evidence-collection/1", observedAt: new Date().toISOString(),
  releaseReady: false,
  scope: "offline-signature-terminal-inventory-and-persisted-evidence-verification",
  note: "Local key consistency proves signed provenance within each proof. Model flags are declarations; benchmark outcomes and missing release experiments remain separate. External signer trust requires --trusted-key-id.",
  reports,
};
const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${reports.filter((entry) => entry.reportMatches).length}/${reports.length} lifecycle reports independently verified: ${target}\n`);
process.exitCode = reports.every((entry) => entry.reportMatches) ? 0 : 1;
