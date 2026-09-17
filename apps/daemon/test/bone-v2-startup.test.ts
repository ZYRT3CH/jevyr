import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JEVYR_BONE_DIGEST, JEVYR_BONE_V2_DIGEST, originalSubjectKernelDigestFromPolicyDescriptor } from "@jevyr/core";
import { loadProjectPolicy } from "../src/project-policy.js";
import { loadGenomeStartupSelection, selectedStartupBone } from "../src/genome-startup.js";
import { createDaemonRuntime } from "../src/runtime.js";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";

test("explicit v2 startup binds the new immutable Bone while historical v1 stays selected by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-bone-v2-startup-"));
  try {
    const baseline = loadProjectPolicy(root);
    assert.equal(baseline.policy.policyVersion, "bone-v1");
    const first = loadGenomeStartupSelection({}, root, join(root, "data"));
    assert.equal(selectedStartupBone(first).boneDigest, JEVYR_BONE_DIGEST);
    await mkdir(join(root, ".jevyr"));
    await writeFile(join(root, ".jevyr/policy.json"), JSON.stringify({ ...baseline.policy, policyVersion: "bone-v2" }));
    const second = loadProjectPolicy(root);
    assert.equal(second.repositorySealProfile.policyVersion, "jevyr.bone/2");
    assert.ok(second.enforcement.validatedInvariants.includes("policyVersion=bone-v2"));
    assert.notEqual(second.descriptorDigest, baseline.descriptorDigest);
    const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, "data"), env: {}, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
    try {
      await runtime.ready();
      assert.equal(selectedStartupBone(runtime.genome).boneDigest, JEVYR_BONE_V2_DIGEST);
      assert.ok(originalSubjectKernelDigestFromPolicyDescriptor(runtime.repository.policyDescriptor));
      assert.equal((runtime.repository.policyDescriptor as any).policy.repositoryPureAssertions, null, "An opaque/observe-only adapter cannot acquire original certificate execution authority");
      const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "example.mjs"), "export const example=1;\n");
      const created = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign",
        subjects: [{ id: "repo", kind: "directory", locator: source }] } });
      await runtime.orchestrator.waitForTerminal(created.caseId, 60_000);
      const record = await runtime.repository.record(created.caseId), events = await runtime.events.read(created.caseId);
      assert.equal(record?.verdict.integrity, "VALID", JSON.stringify(record));
      assert.equal(record?.verdict.judgment, "UNPROVEN", "No original evaluator means no original evidence, even if a candidate was generated");
      assert.equal(events.filter(event => event.kind === "action.status" && event.payload.actionType === "repository-pure.evaluate" && event.payload.status === "denied").length, 1);
      assert.equal(events.some(event => event.kind === "evidence.observed" && event.payload.evidenceType === "original_subject_assertions"), false);
    } finally { await runtime.close(); }
    const activePath = join(root, "data/genome-registry/active.json");
    const { existsSync } = await import("node:fs"); assert.equal(existsSync(activePath), false, "Selecting runtime Bone does not fabricate a Genome promotion");
  } finally {
    const absolute = resolve(root); assert.ok(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(absolute, { recursive: true, force: true });
  }
});
