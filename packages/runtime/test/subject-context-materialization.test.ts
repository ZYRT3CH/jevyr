import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { sha256Digest } from "@jevyr/protocol";
import { createSubjectContext } from "../src/subject-context.js";
import { captureSubjectMaterials, capturedSubjectMaterialReader, materializeSubjectMaterials } from "../src/subject-materials.js";

test("advertised OCI source paths resolve to actual captured material despite declaration gaps, catalog caps and live source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-source-namespace-"));
  try {
    const source = join(root, "live"), store = join(root, "store"), target = join(root, "materialized");
    await mkdir(source);
    await writeFile(join(source, "source.mjs"), 'export const value = "sealed";\n');
    await writeFile(join(source, ".env"), "PRIVATE_FIXTURE=never_list\n");
    const captured = await captureSubjectMaterials(store, [
      { id: "z-repo", kind: "directory", locator: source },
      { id: "a-declaration", kind: "url", locator: "https://example.invalid/unfetched" },
      { id: "m-repo", kind: "directory", locator: source },
    ], new Date().toISOString(), {}, { resolveArtifact: async () => undefined });
    await writeFile(join(source, "source.mjs"), "live change after capture\n");
    const materialization = await materializeSubjectMaterials(store, captured.bindings, target);
    const makeContext = (maxFiles: number) => createSubjectContext({
      captureDigest: captured.captureDigest, bindings: captured.bindings, reader: capturedSubjectMaterialReader(store),
      privacy: "local_only", providerNetwork: "loopback", limits: { maxFiles },
    });
    const context = (await makeContext(4096))!;
    const page = (await context.listFiles({})).value as any;
    assert.equal(page.files.length, 2);
    assert.equal(JSON.stringify(page).includes(".env"), false);
    for (const file of page.files) {
      const mount = materialization.subjects.find(subject => subject.subjectId === file.subjectId)!;
      assert.equal(file.ociReadOnlyPath, `/subject/${mount.relativeRoot}/${file.path}`);
      const actual = await readFile(join(target, file.ociReadOnlyPath.slice("/subject/".length)));
      assert.equal(sha256Digest(actual), file.sourceDigest);
      assert.equal(actual.toString("utf8"), 'export const value = "sealed";\n');
      const read = (await context.readLines({ fileId: file.fileId, startLine: 1, endLine: 1 })).value as any;
      assert.equal(read.ociReadOnlyPath, file.ociReadOnlyPath);
    }
    assert.ok(page.files.every((file: any) => !file.ociReadOnlyPath.startsWith("/subject/subject-0000/")), "declaration-only mount ordinal is never reused");
    const limited = (await (await makeContext(1))!.listFiles({})).value as any;
    assert.equal(limited.files[0].ociReadOnlyPath, page.files[0].ociReadOnlyPath, "catalog caps do not change the captured mount topology");
    const found = (await context.search({ query: "sealed" })).value as any;
    assert.deepEqual(found.matches.map((match: any) => match.ociReadOnlyPath), page.files.map((file: any) => file.ociReadOnlyPath));
  } finally {
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("judge-source-namespace-"));
    await rm(root, { recursive: true, force: true });
  }
});
