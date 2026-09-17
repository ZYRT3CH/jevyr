import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCalibrationSnapshot, publishCalibrationSnapshot } from "../scripts/calibration-snapshot.mjs";

test("installation writes only the captured verified bytes even if source is replaced before copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-calibration-snapshot-"));
  try {
    const source = join(root, "source"), destination = join(root, "installed");
    await mkdir(join(source, "artifacts"), { recursive: true });
    await writeFile(join(source, "Mass.json"), '{"measured":true}');
    await writeFile(join(source, "artifacts", "one.json"), '{"observation":1}');
    const snapshot = await captureCalibrationSnapshot(source);
    await writeFile(join(source, "Mass.json"), '{"unverified":true}');
    await writeFile(join(source, "artifacts", "one.json"), '{"observation":999}');
    let validated;
    const installed = await publishCalibrationSnapshot(snapshot, destination, { protocol: "fixture-installation/1" }, async path => { validated = path; });
    assert.equal(validated, destination);
    assert.equal(await readFile(join(destination, "Mass.json"), "utf8"), '{"measured":true}');
    assert.equal(await readFile(join(destination, "artifacts", "one.json"), "utf8"), '{"observation":1}');
    assert.equal(installed.snapshot.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(destination, "installation.json"), "utf8")), installed);
    await assert.rejects(publishCalibrationSnapshot(snapshot, destination, {}, async () => {}), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("snapshot refuses linked files and publication refuses path traversal before creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-calibration-path-"));
  try {
    const source = join(root, "source"), destination = join(root, "installed"); await mkdir(source);
    await writeFile(join(source, "one.json"), '{}'); await link(join(source, "one.json"), join(source, "two.json"));
    await assert.rejects(captureCalibrationSnapshot(source), /singly-linked/u);
    await assert.rejects(publishCalibrationSnapshot(new Map([["../escape.json", Buffer.from('{}')]]), destination, {}, async () => {}), /unsafe/u);
    await assert.rejects(readFile(join(destination, "installation.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication refuses failed raw verification and any destination mutation before its completion marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-calibration-publish-"));
  try {
    const snapshot = new Map([["Mass.json", Buffer.from('{"measured":true}')]]);
    const failed = join(root, "failed"), changed = join(root, "changed"), omitted = join(root, "omitted");
    await assert.rejects(publishCalibrationSnapshot(snapshot, omitted, {}), /requires independent/u);
    await assert.rejects(publishCalibrationSnapshot(snapshot, failed, {}, async () => { throw new Error("raw observation mismatch"); }), /raw observation mismatch/u);
    await assert.rejects(publishCalibrationSnapshot(snapshot, changed, {}, async path => { await writeFile(join(path, "Mass.json"), '{"unverified":true}'); }), /differs from the verified/u);
    for (const directory of [failed, changed, omitted]) await assert.rejects(readFile(join(directory, "installation.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
