import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { digestJson, sha256Digest } from "@jevyr/protocol";

/** Exact loaded source identities for investigation methods, separate from verdict authority. */
function captureInvestigationImplementation() {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const growthEntry = pathToFileURL(createRequire(import.meta.url).resolve("@jevyr/growth"));
  const growthExtension = growthEntry.pathname.endsWith(".ts") ? ".ts" : ".js";
  const names = ["investigation-identity", "phenotype", "challenge-routing", "evidence-scheduler", "adaptive-search", "model-tool-loop", "investigator-tools", "mind-metering", "memory-reproduction", "revision-investigation", "metabolic-reproduction", "inertia-scent", "search-budget", "orchestrator", "secret-broker", "adapters/prompt", "adapters/openai-compatible", "adapters/codex-app-server", "adapters/codex-boundary", "adapters/codex-harness", "adapters/codex-rpc", "adapters/claude-agent-sdk", "adapters/agent-context", "adapters/process-quarantine", "adapters/provider-launcher"];
  const files = [...names, "baseline-revision", "subject-context", "subject-materials", "repository-evaluation-plan", "repository-evaluation-observer", "repository-evaluation-closure", "repository-test-controller", "repository-observer-replay", "task-source-inspection",
    "original-subject-certificate", "repository-pure-assertions", "repository-pure-producer", "repository-pure-producer-data", "repository-pure-producer-runner", "repository-pure-execution", "repository-pure-assets-pin"]
    .map(name => ({ name: `${name}.js`, digest: sha256Digest(readFileSync(new URL(`./${name}${extension}`, import.meta.url))) }));
  files.push({ name: "repository-test-controller-runner.mjs", digest: sha256Digest(readFileSync(new URL("./repository-test-controller-runner.mjs", import.meta.url))) });
  const body = {
    protocol: "jevyr.investigation-implementation/1" as const,
    authority: "method-only" as const,
    files,
    growthNurseryDigest: sha256Digest(readFileSync(new URL(`./nursery${growthExtension}`, growthEntry))),
  };
  return Object.freeze({ ...body, files: Object.freeze(files.map(file => Object.freeze(file))), digest: digestJson(body) });
}

// Imports bind one implementation per process; later edits cannot silently relabel it.
const implementation = captureInvestigationImplementation();
export function investigationImplementationDescriptor() { return implementation; }
