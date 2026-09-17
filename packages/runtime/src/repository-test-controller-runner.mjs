// Trusted controller entrypoint. Test modules execute only in separate Node
// children. An OCI boundary is still REQUIRED for arbitrary submitted sources.
// Node child IPC can be manipulated: this report grants NO verdict authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, posix, win32 } from "node:path";
import { run } from "node:test";
import { pathToFileURL } from "node:url";

const hash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const digest = value => hash(canonical(value));
const ordinary = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => assert.ok(ordinary(value) && Object.keys(value).sort().join() === [...keys].sort().join(), "Closed controller request shape required");
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const safePath = value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[:\\\u0000-\u001f\u007f]/u.test(value)
  && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..");
async function input() {
  let count = 0; const chunks = [];
  for await (const chunk of process.stdin) { count += chunk.length; assert.ok(count <= 1_000_000, "Controller input ceiling"); chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  exact(request, ["protocol", "target", "root", "suiteDigest", "testFiles", "sourceFiles", "configFiles", "limits"]);
  assert.equal(request.protocol, "jevyr.repository-suite-controller-request/1"); assert.equal(request.target, "sealed-original-subject");
  assert.ok(typeof request.root === "string" && isAbsolute(request.root) && request.root.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(request.root));
  assert.match(request.suiteDigest, /^sha256:[a-f0-9]{64}$/u);
  exact(request.limits, ["timeoutMs", "maxEvents", "maxEventBytes"]);
  for (const [key, min, max] of [["timeoutMs", 100, 60_000], ["maxEvents", 16, 100_000], ["maxEventBytes", 1024, 8_000_000]]) assert.ok(integer(request.limits[key], min, max));
  const inventory = new Map(); let total = 0;
  for (const [kind, maximum] of [["testFiles", 64], ["sourceFiles", 256], ["configFiles", 16]]) {
    assert.ok(Array.isArray(request[kind]) && request[kind].length <= maximum && (kind !== "testFiles" || request[kind].length > 0));
    let previous = "";
    for (const file of request[kind]) {
      exact(file, ["path", "digest", "bytes"]); assert.ok(safePath(file.path) && file.path > previous && integer(file.bytes, 0, 1_048_576)); previous = file.path;
      assert.match(file.digest, /^sha256:[a-f0-9]{64}$/u);
      if (kind === "testFiles") assert.match(file.path, /\.[cm]?js$/u);
      if (inventory.has(file.path)) assert.equal(canonical(inventory.get(file.path)), canonical(file));
      else { inventory.set(file.path, file); total += file.bytes; }
    }
  }
  assert.ok(total <= 8_388_608 && request.testFiles.every(file => request.sourceFiles.some(source => source.path === file.path)));
  return { request, inventory: [...inventory.values()].sort((a, b) => a.path < b.path ? -1 : 1) };
}
async function verifyInventory(root, inventory) {
  const initial = await lstat(root); assert.ok(initial.isDirectory() && !initial.isSymbolicLink());
  const physical = await realpath(root); assert.equal(resolve(root).toLowerCase(), physical.toLowerCase(), "Materialization root must be physical");
  const expected = new Set(inventory.map(file => file.path)), actual = new Set();
  const walk = async (directory, prefix = "", depth = 0) => {
    assert.ok(depth <= 64);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert.ok(!entry.isSymbolicLink() && safePath(name));
      if (entry.isDirectory()) { assert.ok(inventory.some(file => file.path.startsWith(`${name}/`)), "Undeclared materialized directory"); await walk(join(directory, entry.name), name, depth + 1); }
      else { assert.ok(entry.isFile() && expected.has(name), "Undeclared materialized file"); actual.add(name); }
    }
  };
  await walk(root); assert.deepEqual([...actual].sort(), [...expected].sort());
  const observed = [];
  for (const file of inventory) {
    const parts = file.path.split("/"); let path = root;
    for (const part of parts.slice(0, -1)) { path = join(path, part); const directory = await lstat(path); assert.ok(directory.isDirectory() && !directory.isSymbolicLink()); }
    path = join(path, parts.at(-1));
    const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === file.bytes);
    const final = await realpath(path), relativePath = relative(physical, final); assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
    const bytes = await readFile(path), after = await lstat(path);
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.digest); assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.nlink, 1);
    observed.push({ ...file });
  }
  return { digest: digest(observed), files: observed };
}
function eventSnapshot(event) {
  return JSON.parse(JSON.stringify(event, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message, code: value.code ?? null, failureType: value.failureType ?? null,
      cause: value.cause instanceof Error ? { name: value.cause.name, message: value.cause.message, code: value.cause.code ?? null } : typeof value.cause === "string" ? value.cause : null }
    : value));
}
async function control(request, inventory) {
  const events = [], problems = new Set(), controller = new AbortController();
  let eventBytes = 0, observedEvents = 0, before = null, after = null, streamEnded = false;
  const timeout = setTimeout(() => { problems.add("CONTROLLER_TIMEOUT"); controller.abort(); }, request.limits.timeoutMs);
  try {
    before = await verifyInventory(request.root, inventory);
    const stream = run({ cwd: request.root, files: request.testFiles.map(file => join(request.root, file.path)),
      isolation: "process", concurrency: 1, execArgv: [], argv: [], env: {}, watch: false, only: false,
      timeout: request.limits.timeoutMs, signal: controller.signal });
    for await (const event of stream) {
      observedEvents++;
      const value = eventSnapshot(event), encoded = canonical(value); eventBytes += Buffer.byteLength(encoded);
      if (observedEvents > request.limits.maxEvents || eventBytes > request.limits.maxEventBytes) { problems.add("EVENT_CAPTURE_LIMIT"); controller.abort(); continue; }
      events.push(value);
    }
    streamEnded = true;
  } catch { problems.add(before ? "NODE_CONTROLLER_ERROR" : "INVENTORY_BEFORE_MISMATCH"); }
  finally { clearTimeout(timeout); }
  try { after = await verifyInventory(request.root, inventory); } catch { problems.add("INVENTORY_AFTER_MISMATCH"); }
  const stream = { ended: streamEnded, observedEvents, retainedEvents: events.length, observedEventBytes: eventBytes, complete: !problems.has("EVENT_CAPTURE_LIMIT"),
    timedOut: problems.has("CONTROLLER_TIMEOUT"), controllerError: problems.has("NODE_CONTROLLER_ERROR") };
  const summarized = summarizeRepositoryTestEvents(events, request, stream, { before, after });
  const body = { protocol: "jevyr.repository-suite-controller-observation/1", target: request.target, authority: "none", requestDigest: digest(request),
    nodeVersion: process.version, controllerPid: process.pid, runner: "node:test.run/process", inventory: { before, after }, stream,
    events, eventDigest: digest(events), ...summarized,
    trustScope: "Controller-owned parsing and consistency only. Child runner messages can be manipulated. Independently enforced OCI, immutable controller provenance, exact target binding and authenticated capture are required for authority." };
  return { ...body, digest: digest(body) };
}

/** Pure replay of captured Node events. Consistency alone grants no authority. */
export function summarizeRepositoryTestEvents(events, request, stream, inventory) {
  const problems = new Set();
  if (stream.timedOut !== false) problems.add("CONTROLLER_TIMEOUT");
  if (stream.controllerError !== false) problems.add("NODE_CONTROLLER_ERROR");
  if (stream.complete !== true || stream.retainedEvents !== events.length || stream.observedEvents !== events.length
    || events.length > request.limits.maxEvents || stream.observedEventBytes !== events.reduce((sum, event) => sum + Buffer.byteLength(canonical(event)), 0)
    || stream.observedEventBytes > request.limits.maxEventBytes) problems.add("EVENT_CAPTURE_LIMIT");
  const declared = [...new Map([...request.testFiles, ...request.sourceFiles, ...request.configFiles].map(file => [file.path, file])).values()].sort((a, b) => a.path < b.path ? -1 : 1);
  for (const phase of ["before", "after"]) if (!inventory[phase] || canonical(inventory[phase].files) !== canonical(declared) || inventory[phase].digest !== digest(declared)) problems.add(`INVENTORY_${phase.toUpperCase()}_MISMATCH`);
  // Replay may run on Windows for an OCI event stream containing Linux paths.
  const paths = /^[A-Za-z]:[\\/]|^\\\\/u.test(request.root) ? win32 : posix;
  const key = value => typeof value === "string" ? paths.resolve(request.root, value) : null;
  const fileSet = new Set(declared.map(file => key(file.path)));
  const testSet = new Set(request.testFiles.map(file => key(file.path)));
  const report = { protocol: "jevyr.repository-suite-controller-report/1", suiteDigest: request.suiteDigest, complete: false,
    executedTests: 0, passed: 0, failed: 0, errors: 0, skipped: 0, cancelled: 0, fileOnlyPasses: 0 };
  const fileSummaries = new Map(); let globalSummary;
  for (const event of events) {
    const data = event.data;
    if (!ordinary(event) || typeof event.type !== "string" || !ordinary(data)) { problems.add("MALFORMED_NODE_EVENT"); continue; }
    if (data?.file !== undefined && !fileSet.has(key(data.file))) problems.add("EVENT_FILE_OUTSIDE_INVENTORY");
    if (data?.entryFile !== undefined && !testSet.has(key(data.entryFile))) problems.add("ENTRY_FILE_OUTSIDE_INVENTORY");
    if (event.type === "test:summary") {
      if (data.file === undefined) { if (globalSummary) problems.add("DUPLICATE_GLOBAL_SUMMARY"); globalSummary = data; }
      else { if (fileSummaries.has(key(data.file))) problems.add("DUPLICATE_FILE_SUMMARY"); fileSummaries.set(key(data.file), data); }
    }
    if (event.type === "test:pass" || event.type === "test:fail") {
      const wrapper = testSet.has(key(data.file)) && data.name === data.file && data.line === 1 && data.column === 1 && data.nesting === 0;
      if (wrapper) { if (event.type === "test:pass") report.fileOnlyPasses++; else report.errors++; continue; }
      if (data.details?.type === "suite") { if (event.type === "test:fail" && data.details.error?.failureType !== "subtestsFailed") report.errors++; continue; }
      if (data.details?.type !== "test" || typeof data.file !== "string" || !fileSet.has(key(data.file))) { problems.add("MALFORMED_TEST_EVENT"); continue; }
      report.executedTests++;
      if (Object.hasOwn(data, "skip") || Object.hasOwn(data, "todo")) report.skipped++;
      else if (event.type === "test:pass") report.passed++;
      else if (["cancelledByParent", "testTimeoutFailure", "aborted"].includes(data.details.error?.failureType)) report.cancelled++;
      else if (data.details.error?.failureType === "testCodeFailure" && data.details.error?.cause?.code === "ERR_ASSERTION") report.failed++;
      else report.errors++;
    }
  }
  if (stream.ended !== true || !globalSummary) problems.add("MISSING_COMPLETE_STREAM");
  for (const file of testSet) if (!fileSummaries.has(file)) problems.add("MISSING_TEST_FILE_SUMMARY");
  const reported = { tests: report.executedTests, passed: report.passed, failed: report.failed + report.errors, skipped: report.skipped, cancelled: report.cancelled };
  for (const summary of [globalSummary, ...fileSummaries.values()]) if (summary) {
    const counts = summary.counts;
    if (!ordinary(counts) || ["tests", "passed", "failed", "skipped", "cancelled", "todo", "suites", "topLevel"].some(key => !integer(counts[key], 0, 1_000_000))) problems.add("INVALID_NODE_SUMMARY");
  }
  if (globalSummary?.counts) {
    for (const [key, value] of Object.entries(reported)) if (globalSummary.counts[key] !== value && !(key === "skipped" && globalSummary.counts.skipped + globalSummary.counts.todo === value)) problems.add("NODE_COUNT_MISMATCH");
    for (const key of ["tests", "passed", "failed", "skipped", "cancelled", "todo", "suites", "topLevel"])
      if (globalSummary.counts[key] !== [...fileSummaries.values()].reduce((sum, summary) => sum + (summary.counts?.[key] ?? NaN), 0)) problems.add("FILE_SUMMARY_TOTAL_MISMATCH");
    if (typeof globalSummary.success !== "boolean" || globalSummary.success !== (report.failed + report.errors + report.cancelled === 0)) problems.add("NODE_SUCCESS_MISMATCH");
  }
  for (const [file, summary] of fileSummaries) if (!testSet.has(file) || summary.counts?.tests < 1) problems.add("EMPTY_OR_FOREIGN_FILE_SUMMARY");
  if (report.executedTests === 0 || report.passed + report.failed === 0) problems.add("NO_EXECUTED_TESTS");
  if (report.fileOnlyPasses) problems.add("FILE_ONLY_SYNTHETIC_PASS");
  if (report.skipped || report.errors || report.cancelled) problems.add("INCOMPLETE_TEST_EXECUTION");
  report.complete = problems.size === 0;
  return { report, problems: [...problems].sort() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) try {
  const { request, inventory } = await input();
  const report = await control(request, inventory);
  process.stdout.write(canonical(report) + "\n");
} catch {
  process.stderr.write("Repository test controller refused malformed or unsafe input\n"); process.exitCode = 2;
}
