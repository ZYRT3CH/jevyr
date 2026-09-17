import assert from "node:assert/strict";
import { resolve } from "node:path";
import { METABOLIC_KINDS } from "../packages/protocol/dist/index.js";
import { metabolicImplementationDigest, verifyMetabolicCalibration } from "../packages/runtime/dist/index.js";
import { captureCalibrationSnapshot, publishCalibrationSnapshot } from "./calibration-snapshot.mjs";
import { verifyMetabolicExperiment } from "../benchmarks/verify-metabolic-calibration.mjs";
const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3] ?? ".jevyr/metabolic-calibrations");
const snapshot = await captureCalibrationSnapshot(source);
const readSnapshot = name => { const bytes = snapshot.get(name); assert.ok(bytes, `Calibration snapshot is missing ${name}`); return JSON.parse(bytes.toString("utf8")); };
const independent = readSnapshot("independent-verification.json");
assert.equal(independent.protocol, "jevyr.metabolic-experiment-verification/1");
assert.equal(independent.valid, true, "Independent raw-observation verification is required before installation");
assert.equal(independent.diagnostic, false, "Diagnostic measurements cannot authorize installation");
assert.deepEqual(independent.reports.map(report => report.kind).sort(), [...METABOLIC_KINDS].sort());
const method = metabolicImplementationDigest();
const calibrations = [];
for (const kind of METABOLIC_KINDS) {
  const report = readSnapshot(`${kind}.json`);
  assert.equal(report.implementationDigest, method);
  const verified = verifyMetabolicCalibration(report);
  const measured = independent.reports.find(entry => entry.kind === kind);
  assert.equal(measured.digest, report.digest, "The report changed after independent observation verification");
  assert.deepEqual(measured.summary, verified.summary, "The installed summary differs from independently verified measurements");
  calibrations.push({ kind, digest: verified.summary.digest, maximumDose: verified.maximumDose });
}
const installation = { protocol: "jevyr.metabolic-calibration-installation/1", implementationDigest: method, installedAt: new Date().toISOString(), calibrations, application: "next-daemon-startup", empiricalModelCalibration: false };
const completed = await publishCalibrationSnapshot(snapshot, destination, installation, async installed => {
  const checked = await verifyMetabolicExperiment(installed);
  assert.equal(checked.valid, true, "Installed raw observations must independently verify");
  assert.equal(checked.diagnostic, false);
  assert.deepEqual(checked.reports, independent.reports, "Destination verification differs from the captured verification report");
});
console.log(JSON.stringify({ destination, ...installation, snapshotEntries: completed.snapshot.length }));
