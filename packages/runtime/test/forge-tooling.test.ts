import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestJson } from "@jevyr/protocol";
import { SealedForgeAdapter } from "../src/forge.js";
import { decodeToolObservation, encodeToolObservation } from "../src/evidence-artifacts.js";
import type { ForgeToolingInvocationMaterials, ToolInvocation } from "../src/contracts.js";

async function fixture(run: (materials: ForgeToolingInvocationMaterials) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "jevyr-forge-empty-tooling-test-"));
  const sourceRoot = join(root, "scratch"), subjectRoot = join(root, "subject");
  await mkdir(sourceRoot); await mkdir(subjectRoot);
  try {
    await run({ protocol: "jevyr.forge-invocation-materials/2", workspace: { role: "empty-tooling", sourceRoot },
      subjects: { subjectRoot, captureDigest: digestJson({ fixture: "capture" }), materializationDigest: digestJson({ fixture: "material" }) } });
  } finally {
    const resolved = await realpath(root), stat = await lstat(root);
    assert.equal(resolved, resolve(root)); assert.ok(resolved.startsWith(join(parent, "jevyr-forge-empty-tooling-test-")));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    await rm(resolved, { recursive: true, force: true });
  }
}
function execute(forgeMaterials: ToolInvocation["forgeMaterials"]) {
  return new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true }).execute({
    invocationId: "tooling_boundary_fixture", caseId: "case_tooling_boundary_fixture", tool: "forge.command",
    args: { command: process.execPath, args: ["--input-type=module", "--eval", "import{writeFileSync}from'node:fs';writeFileSync('scratch-result.txt','fixed tooling fixture');"] },
    timeoutMs: 5_000, forgeMaterials, signal: new AbortController().signal,
  });
}

test("explicit empty tooling records scratch provenance without any candidate or blueprint identity", async () => {
  await fixture(async materials => {
    const result = await execute(materials);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.oracle?.execution.mode, "trusted-host", "This unit test is not Docker authority evidence");
    assert.deepEqual(result.oracle?.toolingWorkspace, { schema: "jevyr.empty-tooling-workspace/1", initialEntries: 0,
      initialDigest: digestJson({ protocol: "jevyr.directory-manifest/1", entries: [] }) });
    assert.deepEqual(result.oracle?.workspace?.entries.map(entry => entry.path), ["scratch-result.txt"]);
    assert.equal(JSON.stringify(result.oracle).includes("blueprint"), false);
    assert.deepEqual(decodeToolObservation(encodeToolObservation(result).bytes).oracle, result.oracle);
  });
});

test("empty tooling refuses original files, ignored secrets and empty directories before launching", async () => {
  for (const name of ["subject.mjs", ".env", ".jevyrignore", "empty-directory"]) {
    await fixture(async materials => {
      if (name === "empty-directory") await mkdir(join(materials.workspace.sourceRoot, name));
      else await writeFile(join(materials.workspace.sourceRoot, name), "must never enter scratch");
      const result = await execute(materials);
      assert.equal(result.status, "failed"); assert.equal(result.oracle, undefined);
      assert.equal(result.metadata?.admissible, false);
      assert.match(String(result.metadata?.boundaryFailure), /completely empty/);
    });
  }
});

test("tooling protocol refuses role changes, candidate injection, accessors and overlapping material roots", async () => {
  await fixture(async materials => {
    let invoked = false;
    const accessor = { ...materials };
    Object.defineProperty(accessor, "workspace", { enumerable: true, get() { invoked = true; return materials.workspace; } });
    for (const changed of [
      { ...materials, workspace: { ...materials.workspace, role: "candidate" } },
      { ...materials, candidate: { sourceRoot: materials.workspace.sourceRoot } },
      { ...materials, workspace: { ...materials.workspace, blueprintDigest: digestJson({ fake: true }) } },
      { ...materials, subjects: { ...materials.subjects, subjectRoot: materials.workspace.sourceRoot } },
      { ...materials, protocol: "jevyr.forge-invocation-materials/3" }, accessor,
    ]) {
      const result = await execute(changed as ForgeToolingInvocationMaterials);
      assert.equal(result.status, "failed"); assert.equal(result.oracle, undefined); assert.equal(result.metadata?.admissible, false);
    }
    assert.equal(invoked, false, "schema validation must not evaluate accessor fields");
  });
});
