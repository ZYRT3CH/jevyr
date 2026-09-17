import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAXIMUM_GENERATED_TASK_PAIRS, SOURCE_COMMAND, liveModelCorpus, qualificationDigest, qualificationHash } from "./live-model-fixtures.mjs";

/** Generated reading-and-reasoning fixtures. No candidate, provider response, or result file is consulted to create truth. */
export const GENERATED_CORPUS_PROTOCOL = "jevyr.generated-source-corpus/1";
export const GENERATED_SOURCE_FILE = "source.mjs";
export const OBSERVATION_PROTOCOL = "jevyr.live-source-observation/1";
export const SPECIFICATION_PROTOCOL = "jevyr.live-source-specification/1";
export const DECLARED_INPUTS_PER_TASK = 6;
export const MAXIMUM_TASK_PAIRS = MAXIMUM_GENERATED_TASK_PAIRS;
export const MAXIMUM_FILE_LINES = 80;
export const MAXIMUM_FILE_BYTES = 24_000;
export const MAXIMUM_INPUT_REDRAWS = 256;
// The single backticked command followed by "exits with code 0" is the only critical obligation the intent compiler
// derives; "do not / never / only ..." phrasing would add constraints, so the impulse never uses it.
export const GENERATED_IMPULSE = `\`${SOURCE_COMMAND}\` exits with code 0. Inspect the captured ${GENERATED_SOURCE_FILE} through context tools. Construct the separate comparative jevyr.experiment.mjs probe specified in qualification.json; its output reports actual source behavior, including defects, rather than repairing the captured implementation.`;

// Mirrors packages/runtime/src/canonical.ts seededUnit: thirteen hexadecimal digits span 52 bits and stay strictly below one.
export function seededUnit(seed, index) {
  const hex = createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10_0000_0000_0000;
}
const CONSONANTS = Object.freeze([..."bdfgklmnprstvz"]);
const VOWELS = Object.freeze([..."aeiou"]);
const RESERVED = new Set(["goto", "date", "node", "mode", "name", "size", "sort", "some", "keys", "list", "true", "null", "void", "case", "this", "with", "enum", "eval", "type", "byte", "long"]);
export function seededStream(label) {
  let index = 0;
  const unit = () => seededUnit(label, index++);
  const int = (low, high) => { assert.ok(Number.isSafeInteger(low) && Number.isSafeInteger(high) && low <= high); return low + Math.floor(unit() * (high - low + 1)); };
  const pick = list => { assert.ok(list.length > 0); return list[Math.floor(unit() * list.length)]; };
  const word = syllables => { let text = ""; for (let count = 0; count < syllables; count += 1) text += pick(CONSONANTS) + pick(VOWELS); return text; };
  return { unit, int, pick, word, get index() { return index; } };
}
const capitalize = text => text[0].toUpperCase() + text.slice(1);
const compare = (operator, left, right) => operator === ">" ? left > right : operator === ">=" ? left >= right : operator === "<" ? left < right : left <= right;
const FLIPPED = Object.freeze({ ">": ">=", ">=": ">", "<": "<=", "<=": "<" });
const OPERATOR_WORDS = Object.freeze({ ">": "is strictly greater than", ">=": "is greater than or equal to", "<": "is strictly less than", "<=": "is less than or equal to" });
const sumOf = values => values.reduce((sum, item) => sum + item, 0);
const weightedSum = (digits, weights, offset, reversed) => {
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) total += Number(reversed ? digits[digits.length - 1 - index] : digits[index]) * weights[(index + offset) % weights.length];
  return total;
};

/** Every template renders source text from the same parameters its reference implementation uses; the hermetic test executes the rendered oracle to prove they agree. */
export const GENERATED_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "shifted-clamp", roles: ["value", "lower", "upper"],
    draw(rng) { return { k: rng.pick([-1, 1]) * rng.int(1, 9) }; },
    reference: ({ k }) => (value, lower, upper) => Math.min(upper, Math.max(lower, value + k)),
    textbook: () => (value, lower, upper) => Math.min(upper, Math.max(lower, value)),
    defects: Object.freeze({
      "missing-lower-bound": { description: "never raises the shifted value up to the lower bound", implement: ({ k }) => (value, lower, upper) => Math.min(upper, value + k) },
      "missing-upper-bound": { description: "never lowers the shifted value down to the upper bound", implement: ({ k }) => (value, lower, upper) => Math.max(lower, value + k) },
      "shift-after-clamp": { description: "applies the shift after clamping instead of before", implement: ({ k }) => (value, lower, upper) => Math.min(upper, Math.max(lower, value)) + k },
    }),
    source({ k }, name, [value, lower, upper], defectId) {
      const shift = k < 0 ? `${value} - ${-k}` : `${value} + ${k}`, tail = k < 0 ? ` - ${-k}` : ` + ${k}`;
      const body = defectId === "missing-lower-bound" ? `Math.min(${upper}, ${shift})`
        : defectId === "missing-upper-bound" ? `Math.max(${lower}, ${shift})`
        : defectId === "shift-after-clamp" ? `Math.min(${upper}, Math.max(${lower}, ${value}))${tail}`
        : `Math.min(${upper}, Math.max(${lower}, ${shift}))`;
      return `export function ${name}(${value}, ${lower}, ${upper}) {\n  return ${body};\n}\n`;
    },
    prose({ k }, [value, lower, upper]) {
      return `${k < 0 ? `Subtract ${-k} from ${value}` : `Add ${k} to ${value}`}; the result may be negative. Then clamp that result into the inclusive range from ${lower} to ${upper}: return ${lower} when the result is less than ${lower}, return ${upper} when the result is greater than ${upper}, and otherwise return the result itself. All three arguments are integers, and ${lower} is never greater than ${upper}.`;
    },
    inputs(rng, { k }) {
      const rows = [];
      for (const role of ["below", "above", "inside", "inside", "at-lower", "at-upper"]) {
        const lower = rng.int(-10, 5), upper = lower + rng.int(2, 10);
        const target = role === "below" ? lower - rng.int(1, 5) : role === "above" ? upper + rng.int(1, 5) : role === "inside" ? rng.int(lower, upper) : role === "at-lower" ? lower : upper;
        rows.push([target - k, lower, upper]);
      }
      return rows;
    },
  }),
  Object.freeze({
    id: "tail-sum-modulo", roles: ["values"],
    draw(rng) { return { w: rng.int(2, 4), m: rng.int(5, 23) }; },
    reference: ({ w, m }) => values => sumOf(values.slice(-w)) % m,
    textbook: ({ m }) => values => sumOf(values) % m,
    defects: Object.freeze({
      "head-window": { description: "sums the first window instead of the last", implement: ({ w, m }) => values => sumOf(values.slice(0, w)) % m },
      "window-off-by-one": { description: "sums one element fewer than the declared window", implement: ({ w, m }) => values => sumOf(values.slice(-(w - 1))) % m },
      "missing-modulo": { description: "omits the final modulo", implement: ({ w }) => values => sumOf(values.slice(-w)) },
    }),
    source({ w, m }, name, [values], defectId) {
      const window = defectId === "head-window" ? `${values}.slice(0, ${w})` : defectId === "window-off-by-one" ? `${values}.slice(-${w - 1})` : `${values}.slice(-${w})`;
      return `export function ${name}(${values}) {\n  return ${window}.reduce((sum, item) => sum + item, 0)${defectId === "missing-modulo" ? "" : ` % ${m}`};\n}\n`;
    },
    prose({ w, m }, [values]) {
      return `Take the last ${w} elements of ${values}; when ${values} has fewer than ${w} elements, take all of them. Return the sum of the taken elements modulo ${m}. Every element is a non-negative integer, so the result is the ordinary non-negative remainder, and ${values} always contains at least one element.`;
    },
    inputs(rng, { w }) {
      const lengths = [w + 1, w + rng.int(2, 3), rng.int(1, w), rng.int(1, w), rng.int(w, 7), rng.int(1, 7)];
      return lengths.map(length => [Array.from({ length }, () => rng.int(0, 30))]);
    },
  }),
  Object.freeze({
    id: "threshold-count", roles: ["values", "threshold"],
    draw(rng) { return { op: rng.pick([">", ">=", "<", "<="]), c: rng.int(1, 5) }; },
    reference: ({ op, c }) => (values, threshold) => values.filter(item => compare(op, item + c, threshold)).length,
    textbook: () => (values, threshold) => values.filter(item => item > threshold).length,
    defects: Object.freeze({
      "comparator-strictness": { description: "uses the opposite strictness of the declared comparison", implement: ({ op, c }) => (values, threshold) => values.filter(item => compare(FLIPPED[op], item + c, threshold)).length },
      "missing-offset": { description: "compares the element itself instead of the element plus the offset", implement: ({ op }) => (values, threshold) => values.filter(item => compare(op, item, threshold)).length },
      "skips-first-element": { description: "never counts the first element", implement: ({ op, c }) => (values, threshold) => values.slice(1).filter(item => compare(op, item + c, threshold)).length },
    }),
    source({ op, c }, name, [values, threshold], defectId) {
      const operator = defectId === "comparator-strictness" ? FLIPPED[op] : op, left = defectId === "missing-offset" ? "item" : `item + ${c}`;
      const subject = defectId === "skips-first-element" ? `${values}.slice(1)` : values;
      return `export function ${name}(${values}, ${threshold}) {\n  return ${subject}.filter((item) => ${left} ${operator} ${threshold}).length;\n}\n`;
    },
    prose({ op, c }, [values, threshold]) {
      return `Count the elements of ${values} for which the element plus ${c} ${OPERATOR_WORDS[op]} ${threshold}, and return that count. ${values} may be empty, in which case return 0. Every element and ${threshold} are integers.`;
    },
    inputs(rng, { c }) {
      const rows = [];
      for (const role of ["boundary", "empty", "random", "random", "boundary", "random"]) {
        const threshold = rng.int(-5, 5);
        if (role === "empty") { rows.push([[], threshold]); continue; }
        const values = Array.from({ length: rng.int(1, 7) }, () => rng.int(-10, 10));
        if (role === "boundary") values[rng.int(0, values.length - 1)] = threshold - c;
        rows.push([values, threshold]);
      }
      return rows;
    },
  }),
  Object.freeze({
    id: "replace-then-truncate", roles: ["text"],
    draw(rng) {
      const letters = [..."abcdefgh"], a = rng.pick(letters), others = letters.filter(letter => letter !== a);
      return { a, r: rng.pick(others) + rng.pick(others), n: rng.int(3, 8) };
    },
    reference: ({ a, r, n }) => text => text.replaceAll(a, r).slice(0, n),
    textbook: ({ n }) => text => text.slice(0, n),
    defects: Object.freeze({
      "truncate-before-replace": { description: "truncates first and replaces afterwards", implement: ({ a, r, n }) => text => text.slice(0, n).replaceAll(a, r) },
      "replace-first-only": { description: "replaces only the first occurrence", implement: ({ a, r, n }) => text => text.replace(a, r).slice(0, n) },
      "truncate-off-by-one": { description: "keeps one character fewer than declared", implement: ({ a, r, n }) => text => text.replaceAll(a, r).slice(0, n - 1) },
    }),
    source({ a, r, n }, name, [text], defectId) {
      const pattern = `${JSON.stringify(a)}, ${JSON.stringify(r)}`;
      const body = defectId === "truncate-before-replace" ? `${text}.slice(0, ${n}).replaceAll(${pattern})`
        : defectId === "replace-first-only" ? `${text}.replace(${pattern}).slice(0, ${n})`
        : `${text}.replaceAll(${pattern}).slice(0, ${defectId === "truncate-off-by-one" ? n - 1 : n})`;
      return `export function ${name}(${text}) {\n  return ${body};\n}\n`;
    },
    prose({ a, r, n }, [text]) {
      return `Replace every occurrence of the letter "${a}" in ${text} with the two letters "${r}", then return only the first ${n} characters of that replaced string; when the replaced string has ${n} characters or fewer, return all of it. ${text} contains only lowercase letters and may be empty.`;
    },
    inputs(rng, { a, n }) {
      const others = [..."abcdefgh"].filter(letter => letter !== a).slice(0, 3), alphabet = [a, ...others];
      const random = length => Array.from({ length }, () => rng.pick(alphabet)).join("");
      const dense = () => { const chars = random(n + rng.int(1, 3)).split(""); chars[0] = a; chars[1] = a; return chars.join(""); };
      const clean = () => Array.from({ length: n + rng.int(1, 3) }, () => rng.pick(others)).join("");
      return [[dense()], [clean()], [random(rng.int(1, n - 1))], [""], [random(rng.int(0, 10))], [random(n - 1) + a]];
    },
  }),
  Object.freeze({
    id: "weighted-digit-sum", roles: ["digits"],
    draw(rng) {
      const count = rng.pick([2, 3]);
      let weights; do weights = Array.from({ length: count }, () => rng.int(1, 9)); while (weights.every(weight => weight === weights[0]));
      return { weights, m: rng.int(7, 31) };
    },
    reference: ({ weights, m }) => digits => weightedSum(digits, weights, 0, false) % m,
    textbook: ({ m }) => digits => weightedSum(digits, [1], 0, false) % m,
    defects: Object.freeze({
      "weight-offset": { description: "starts the weight cycle at the second weight", implement: ({ weights, m }) => digits => weightedSum(digits, weights, 1, false) % m },
      "missing-modulo": { description: "omits the final modulo", implement: ({ weights }) => digits => weightedSum(digits, weights, 0, false) },
      "reversed-digit-order": { description: "applies the weights from the last digit backwards", implement: ({ weights, m }) => digits => weightedSum(digits, weights, 0, true) % m },
    }),
    source({ weights, m }, name, [digits], defectId) {
      const accessor = defectId === "reversed-digit-order" ? `${digits}[${digits}.length - 1 - index]` : `${digits}[index]`;
      const weight = defectId === "weight-offset" ? `weights[(index + 1) % ${weights.length}]` : `weights[index % ${weights.length}]`;
      return `export function ${name}(${digits}) {\n  const weights = [${weights.join(", ")}];\n  let total = 0;\n  for (let index = 0; index < ${digits}.length; index += 1) total += Number(${accessor}) * ${weight};\n  return ${defectId === "missing-modulo" ? "total" : `total % ${m}`};\n}\n`;
    },
    prose({ weights, m }, [digits]) {
      return `Treat ${digits} as a string of decimal digits read from left to right. Multiply the digit at position i (counting from 0) by the weight at position i modulo ${weights.length} in the weight list [${weights.join(", ")}], so the first digit uses ${weights[0]}, the second uses ${weights[1]}, and the weights repeat in that order. Return the sum of those products modulo ${m}. ${digits} always contains between 2 and 8 characters, each a digit from 0 to 9.`;
    },
    inputs(rng) { return Array.from({ length: DECLARED_INPUTS_PER_TASK }, () => [Array.from({ length: rng.int(2, 8) }, () => String(rng.int(0, 9))).join("")]); },
  }),
]);
export function templateById(id) { const template = GENERATED_TEMPLATES.find(entry => entry.id === id); assert.ok(template, `Unknown generated template ${id}`); return template; }

const primitiveOutput = value => Number.isSafeInteger(value) || (typeof value === "string" && value.length <= 64);
const differs = (left, right) => left.some((value, index) => value !== right[index]);
export function generatedTask(seed, taskIndex, reservedNames = new Set()) {
  assert.match(String(seed), /^[a-f0-9]{64}$/u); assert.ok(Number.isSafeInteger(taskIndex) && taskIndex >= 0 && taskIndex < MAXIMUM_TASK_PAIRS);
  const rng = seededStream(`${seed}:task:${taskIndex}`), template = GENERATED_TEMPLATES[taskIndex % GENERATED_TEMPLATES.length];
  let name; do name = rng.word(2) + capitalize(rng.word(2)); while (RESERVED.has(name) || reservedNames.has(name));
  const argumentNames = [];
  while (argumentNames.length < template.roles.length) { const candidate = rng.word(2); if (!RESERVED.has(candidate) && !argumentNames.includes(candidate)) argumentNames.push(candidate); }
  const parameters = template.draw(rng), defectId = rng.pick(Object.keys(template.defects));
  const reference = template.reference(parameters), textbook = template.textbook(parameters), defective = template.defects[defectId].implement(parameters);
  let declaredInputs, intended, defectActual, textbookActual, drawAttempts = 0;
  while (true) {
    drawAttempts += 1; assert.ok(drawAttempts <= MAXIMUM_INPUT_REDRAWS, `Task ${taskIndex} could not draw discriminating inputs`);
    declaredInputs = template.inputs(rng, parameters); assert.equal(declaredInputs.length, DECLARED_INPUTS_PER_TASK);
    intended = declaredInputs.map(input => reference(...input)); defectActual = declaredInputs.map(input => defective(...input)); textbookActual = declaredInputs.map(input => textbook(...input));
    for (const value of [...intended, ...defectActual, ...textbookActual]) assert.ok(primitiveOutput(value), "Generated outputs must be safe integers or short strings");
    if (differs(defectActual, intended) && differs(textbookActual, intended)) break;
  }
  return { pairKey: `gen-${String(taskIndex).padStart(2, "0")}-${name}`, taskIndex, template: template.id, name, argumentNames, parameters,
    defect: { id: defectId, description: template.defects[defectId].description }, declaredInputs, intended, defectActual, textbookActual, drawAttempts };
}

/** Compact rendering keeps the specification a complete required read: the runtime demotes files above 80 lines to partial reads. */
export function renderSpecification(spec) {
  assert.deepEqual(Object.keys(spec), ["protocol", "function", "intendedBehavior", "observations", "comparativeProbe"]);
  const indent = text => text.split("\n").map((line, index) => index === 0 ? line : `  ${line}`).join("\n");
  const observations = spec.observations.map((row, index, rows) => `    ${JSON.stringify(row)}${index < rows.length - 1 ? "," : ""}`);
  const text = ["{", `  "protocol": ${JSON.stringify(spec.protocol)},`, `  "function": ${JSON.stringify(spec.function)},`, `  "intendedBehavior": ${JSON.stringify(spec.intendedBehavior)},`,
    `  "observations": [`, ...observations, "  ],", `  "comparativeProbe": ${indent(JSON.stringify(spec.comparativeProbe, null, 2))}`, "}", ""].join("\n");
  assert.deepEqual(JSON.parse(text), spec);
  return text;
}
const assertBoundedFile = file => {
  assert.ok(file.content.split("\n").length <= MAXIMUM_FILE_LINES && Buffer.byteLength(file.content) <= MAXIMUM_FILE_BYTES, `Generated ${file.path} exceeds the complete-read bounds`);
};
const legacyProbeBehavior = () => JSON.parse(liveModelCorpus().cases[0].files.find(file => file.path === "qualification.json").content).comparativeProbe.behavior;

export function generatedCase(task, defective) {
  const template = templateById(task.template);
  const source = template.source(task.parameters, task.name, task.argumentNames, defective ? task.defect.id : null), sourceDigest = qualificationHash(source);
  const actual = defective ? task.defectActual : task.intended;
  const expectedObservation = { protocol: OBSERVATION_PROTOCOL, sourceDigest, rows: task.declaredInputs.map((input, index) => ({ input, actual: actual[index], expected: task.intended[index] })) };
  const specification = { protocol: SPECIFICATION_PROTOCOL, function: `${task.name}(${task.argumentNames.join(", ")})`, intendedBehavior: template.prose(task.parameters, task.argumentNames),
    observations: task.declaredInputs.map((input, index) => ({ input, expected: task.intended[index] })),
    comparativeProbe: { entryFile: "jevyr.experiment.mjs", command: "node jevyr.experiment.mjs", outputProtocol: OBSERVATION_PROTOCOL,
      outputShape: { sourceDigest: `SHA-256 of the exact observed ${GENERATED_SOURCE_FILE} bytes, with sha256: prefix`, rows: "one {input,actual,expected} row for each declared input, in order" },
      behavior: legacyProbeBehavior() } };
  const oracle = `import { readFileSync } from "node:fs";\nimport { createHash } from "node:crypto";\nimport { ${task.name} } from "./${GENERATED_SOURCE_FILE}";\nconst inputs=${JSON.stringify(task.declaredInputs)}, expected=${JSON.stringify(task.intended)};\nconst sourceDigest="sha256:"+createHash("sha256").update(readFileSync(new URL("./${GENERATED_SOURCE_FILE}",import.meta.url))).digest("hex");\nconst rows=inputs.map((input,index)=>({input,actual:${task.name}(...input),expected:expected[index]}));\nprocess.stdout.write(JSON.stringify({protocol:"${OBSERVATION_PROTOCOL}",sourceDigest,rows}));\nprocess.exit(rows.every(row=>row.actual===row.expected)?0:9);\n`;
  const files = [{ path: GENERATED_SOURCE_FILE, content: source }, { path: "qualification.json", content: renderSpecification(specification) }, { path: "truth-oracle.mjs", content: oracle }];
  for (const file of files) assertBoundedFile(file);
  return { caseKey: `${task.pairKey}-${defective ? "defect" : "clean"}`, pairKey: task.pairKey, taskIndex: task.taskIndex, template: task.template, defective, defect: defective ? task.defect : null,
    parameters: task.parameters, sourceDigest, expectedJudgment: defective ? "REJECT" : "ACCEPT", expectedExitCode: defective ? 9 : 0, expectedObservation, files };
}

export function generatedSourceCorpus(seed, taskPairs) {
  assert.match(String(seed), /^[a-f0-9]{64}$/u); assert.ok(Number.isSafeInteger(taskPairs) && taskPairs >= 1 && taskPairs <= MAXIMUM_TASK_PAIRS, `taskPairs must be within 1..${MAXIMUM_TASK_PAIRS}`);
  const legacy = liveModelCorpus(), names = new Set(), tasks = [];
  for (let taskIndex = 0; taskIndex < taskPairs; taskIndex += 1) { const task = generatedTask(seed, taskIndex, names); names.add(task.name); tasks.push(task); }
  const cases = tasks.flatMap(task => [generatedCase(task, false), generatedCase(task, true)]);
  const body = { protocol: legacy.protocol, kind: "generated",
    generator: { protocol: GENERATED_CORPUS_PROTOCOL, seed, taskPairs, sourceFile: GENERATED_SOURCE_FILE, templates: GENERATED_TEMPLATES.map(template => template.id), declaredInputsPerTask: DECLARED_INPUTS_PER_TASK },
    cases, impulse: GENERATED_IMPULSE, constraints: [],
    scope: `Generated fixture family: ${taskPairs} seeded task pairs over ${GENERATED_TEMPLATES.length} templates, each pair one clean and one planted-defect source with task-specific parameters that no memorized textbook version can supply. Measures this bounded live-provider investigation/lifecycle contract on fresh tasks, not general defect discovery, customer workloads or broad model quality.`,
    qualificationRule: legacy.qualificationRule };
  return { ...body, digest: qualificationDigest(body) };
}
export function corpusForConfig(config) {
  if (config.corpus === undefined) return liveModelCorpus();
  assert.equal(config.corpus.kind, "generated"); return generatedSourceCorpus(config.corpus.seed, config.corpus.taskPairs);
}
