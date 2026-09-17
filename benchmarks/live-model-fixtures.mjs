import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const qualificationHash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
export const qualificationDigest = value => qualificationHash(canonical(value));
export const SOURCE_ASSAY_ID = "qualification.immutable-source";
export const PROBE_ASSAY_ID = "qualification.model-probe";
export const SOURCE_COMMAND = "node /subject/subject-0000/truth-oracle.mjs";
export const MAXIMUM_GENERATED_TASK_PAIRS = 60;
const inputs = [[-2, 0, 5], [0, 0, 5], [3, 0, 5], [7, 0, 5]];
const intended = [0, 0, 3, 5];

/** No candidate, provider response, or result file is consulted to create truth. */
export function liveModelCorpus() {
  const cases = [false, true].map(defect => {
    const caseKey = defect ? "clamp-missing-lower-bound" : "clamp-clean";
    const source = defect
      ? "export function clamp(value, lower, upper) { return Math.min(upper, value); }\n"
      : "export function clamp(value, lower, upper) { return Math.min(upper, Math.max(lower, value)); }\n";
    const sourceDigest = qualificationHash(source);
    const expectedObservation = { protocol: "jevyr.live-source-observation/1", sourceDigest,
      rows: inputs.map((input, index) => ({ input, actual: defect && index === 0 ? -2 : intended[index], expected: intended[index] })) };
    const specification = { protocol: "jevyr.live-source-specification/1", function: "clamp(value, lower, upper)", intendedBehavior: "Clamp to the inclusive lower and upper bounds.",
      observations: inputs.map((input, index) => ({ input, expected: intended[index] })),
      comparativeProbe: { entryFile: "jevyr.experiment.mjs", command: "node jevyr.experiment.mjs", outputProtocol: expectedObservation.protocol,
        outputShape: { sourceDigest: "SHA-256 of the exact observed clamp.mjs bytes, with sha256: prefix", rows: "one {input,actual,expected} row for each declared input, in order" },
        behavior: "Inspect the actual captured source. Reproduce or import that implementation faithfully; output its actual results, even when they differ from the intended results. Emit one JSON object, no extra output, and exit 0. The immutable truth test alone has verdict authority." } };
    const oracle = `import { readFileSync } from "node:fs";\nimport { createHash } from "node:crypto";\nimport { clamp } from "./clamp.mjs";\nconst inputs=${JSON.stringify(inputs)}, expected=${JSON.stringify(intended)};\nconst sourceDigest="sha256:"+createHash("sha256").update(readFileSync(new URL("./clamp.mjs",import.meta.url))).digest("hex");\nconst rows=inputs.map((input,index)=>({input,actual:clamp(...input),expected:expected[index]}));\nprocess.stdout.write(JSON.stringify({protocol:"jevyr.live-source-observation/1",sourceDigest,rows}));\nprocess.exit(rows.every(row=>row.actual===row.expected)?0:9);\n`;
    return { caseKey, sourceDigest, expectedJudgment: defect ? "REJECT" : "ACCEPT", expectedExitCode: defect ? 9 : 0, expectedObservation,
      files: [{ path: "clamp.mjs", content: source }, { path: "qualification.json", content: JSON.stringify(specification, null, 2) + "\n" }, { path: "truth-oracle.mjs", content: oracle }] };
  });
  const body = { protocol: "jevyr.live-model-source-corpus/1", cases,
    impulse: `\`${SOURCE_COMMAND}\` exits with code 0. Inspect the captured clamp.mjs through context tools. Construct the separate comparative jevyr.experiment.mjs probe specified in qualification.json; its output reports actual source behavior, including defects, rather than repairing the captured implementation.`,
    constraints: [], scope: "Two fixed clamp fixtures, one clean and one planted lower-bound defect. Measures this bounded live-provider investigation/lifecycle contract, not general defect discovery or broad model quality.",
    qualificationRule: "Every planned Case must terminate with complete authenticated replay and correct immutable-source judgment; actual model-origin candidates and source-inspection receipts are required. At least one model probe must execute, and every executed model probe must exactly match immutable source truth. Model/transport failures and unexecuted probes remain failures in the attempt denominator." };
  return { ...body, digest: qualificationDigest(body) };
}

export function validateQualificationConfig(raw) {
  const exact = (value, fields) => assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), "Unknown or missing qualification configuration fields");
  const generated = !!raw && typeof raw === "object" && Object.hasOwn(raw, "corpus");
  exact(raw, ["protocol", "providers", "seeds", "repeats", "dockerImage", ...(generated ? ["corpus"] : [])]);
  assert.equal(raw.protocol, "jevyr.live-model-qualification-config/1");
  assert.ok(Array.isArray(raw.providers) && raw.providers.length >= 1 && raw.providers.length <= 2);
  const seen = new Set();
  for (const provider of raw.providers) {
    exact(provider, ["id", "model", "modelFamily", "baseUrl", "modelDigest", "investigationTransport"]);
    assert.match(provider.id, /^mind\.qualification\.[a-z][a-z0-9_-]{0,39}$/u); assert.ok(!seen.has(provider.id)); seen.add(provider.id);
    assert.match(provider.model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u); assert.match(provider.modelFamily, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    assert.match(provider.modelDigest, /^sha256:[a-f0-9]{64}$/u);
    const url = new URL(provider.baseUrl);
    assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && ["/v1", "/v1/"].includes(url.pathname) && !url.username && !url.password && !url.search && !url.hash, "Qualification supports explicit local Ollama endpoints only");
    assert.ok(["native", "structured"].includes(provider.investigationTransport));
  }
  assert.ok(Array.isArray(raw.seeds) && raw.seeds.length >= 1 && raw.seeds.length <= 2 && new Set(raw.seeds).size === raw.seeds.length);
  for (const seed of raw.seeds) assert.match(seed, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(raw.repeats) && raw.repeats >= 1 && raw.repeats <= 2);
  assert.match(raw.dockerImage, /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,191}$/u);
  if (generated) {
    // Omitting corpus keeps the fixed clamp baseline; the generated family is the only configurable alternative.
    exact(raw.corpus, ["kind", "seed", "taskPairs"]);
    assert.equal(raw.corpus.kind, "generated", "Unknown qualification corpus kind");
    assert.match(raw.corpus.seed, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(raw.corpus.taskPairs) && raw.corpus.taskPairs >= 1 && raw.corpus.taskPairs <= MAXIMUM_GENERATED_TASK_PAIRS, "taskPairs must be a bounded positive integer");
  }
  return structuredClone(raw);
}

export function compareQualificationObservation(value, fixture) {
  return canonical(value) === canonical(fixture.expectedObservation);
}

export const PROBE_CLASSIFICATIONS = Object.freeze(["MATCHES_ACTUAL", "MATCHES_INTENDED", "NEITHER", "MALFORMED"]);
/** Diagnostic only: classifies the reported actual column; sourceDigest and the expected column remain the strict comparison's job. */
export function classifyProbeObservation(value, fixture) {
  const rows = fixture.expectedObservation.rows;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocol !== fixture.expectedObservation.protocol || !Array.isArray(value.rows) || value.rows.length !== rows.length
    || value.rows.some((row, index) => !row || typeof row !== "object" || Array.isArray(row) || !Object.hasOwn(row, "actual") || canonical(row.input) !== canonical(rows[index].input))) return "MALFORMED";
  const same = column => value.rows.every((row, index) => canonical(row.actual) === canonical(column[index]));
  return same(rows.map(row => row.actual)) ? "MATCHES_ACTUAL" : same(rows.map(row => row.expected)) ? "MATCHES_INTENDED" : "NEITHER";
}
