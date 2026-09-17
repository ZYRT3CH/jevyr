import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import {
  captureSubjectMaterials,
  materializeSubjectMaterials,
  projectSubjectText,
  resolveSubjectSnapshots,
  verifySubjectMaterialBinding,
  type ArtifactSnapshotSource,
  type SubjectMaterialBinding,
} from "../src/index.js";
import { sha256Digest } from "@jevyr/protocol";

const execute = promisify(execFile);
const temporary: string[] = [];
const capturedAt = "2026-09-04T12:00:00.000Z";

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function noArtifacts() {
  return { resolveArtifact: async () => undefined };
}

async function fixture(prefix: string): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(root);
  const store = join(root, "private-cas");
  return { root, store };
}

function onlyBinding(bindings: readonly SubjectMaterialBinding[]): SubjectMaterialBinding {
  const binding = bindings[0];
  if (!binding) throw new Error("fixture did not produce a binding");
  return binding;
}

test("captured file bytes remain immutable after the original locator mutates", async () => {
  const { root, store } = await fixture("jevyr-material-mutation-");
  const source = join(root, "source.txt");
  await writeFile(source, "before seal", "utf8");
  const capture = await captureSubjectMaterials(
    store,
    [{ id: "source", kind: "file", locator: source }],
    capturedAt,
    {},
    noArtifacts(),
  );
  await writeFile(source, "after seal", "utf8");

  const projection = await projectSubjectText(store, capture.bindings);
  assert.equal(projection.files.length, 1);
  assert.equal(projection.files[0]?.text, "before seal");
  assert.equal(projection.files[0]?.sourceDigest, sha256Digest("before seal"));
  assert.equal(JSON.stringify(projection).includes(source), false);
  assert.equal(capture.bindings[0]?.availability, "MATERIALIZED");

  const forgeInput = join(root, "forge-input");
  const materialized = await materializeSubjectMaterials(store, capture.bindings, forgeInput);
  assert.equal(materialized.subjects[0]?.relativeRoot, "subject-0000");
  assert.equal(await readFile(join(forgeInput, "subject-0000", "content"), "utf8"), "before seal");
  assert.equal(JSON.stringify(materialized).includes(source), false);
});

test("directory material uses the snapshot ignore boundary and never stores built-in secrets", async () => {
  const { root, store } = await fixture("jevyr-material-secrets-");
  const tree = join(root, "tree");
  await mkdir(tree);
  await writeFile(join(tree, ".jevyrignore"), "ignored.txt\n", "utf8");
  await writeFile(join(tree, "visible.txt"), "visible", "utf8");
  await writeFile(join(tree, "ignored.txt"), "ignored by policy", "utf8");
  await writeFile(join(tree, ".env"), "TOKEN=never-store", "utf8");
  await writeFile(join(tree, "credential.pem"), "never-store", "utf8");
  await writeFile(join(tree, "innocent.txt"), "-----BEGIN PRIVATE KEY-----\nnever-store", "utf8");
  const subject = { id: "tree", kind: "directory" as const, locator: tree };

  const capture = await captureSubjectMaterials(store, [subject], capturedAt, {}, noArtifacts());
  const ordinary = await resolveSubjectSnapshots([subject], capturedAt, {}, noArtifacts());
  assert.equal(capture.snapshots[0]?.digest, ordinary[0]?.digest);
  const manifest = await verifySubjectMaterialBinding(store, onlyBinding(capture.bindings));
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [".jevyrignore", "visible.txt"]);
  assert.deepEqual(
    manifest.omissions.map((entry) => [entry.path, entry.reason]),
    [
      [".env", "built-in-secret-name"],
      ["credential.pem", "built-in-secret-name"],
      ["ignored.txt", "jevyrignore"],
      ["innocent.txt", "built-in-private-key-content"],
    ],
  );
  const projection = await projectSubjectText(store, capture.bindings);
  assert.equal(projection.files.some((file) => file.text.includes("never-store")), false);
  assert.equal(projection.omissions.filter((entry) => entry.reason === "POLICY_EXCLUDED").length, 4);
  const storedBlobBodies = await Promise.all(
    (await readdir(join(store, "blobs"))).map(async (name) => await readFile(join(store, "blobs", name), "utf8")),
  );
  assert.equal(storedBlobBodies.some((body) => body.includes("never-store")), false);
});

test("text projection omits invalid UTF-8, binary controls, and oversized files without truncating", async () => {
  const { root, store } = await fixture("jevyr-material-bounds-");
  const tree = join(root, "tree");
  await mkdir(tree);
  await writeFile(join(tree, "a.txt"), "ok", "utf8");
  await writeFile(join(tree, "b-invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
  await writeFile(join(tree, "c-control.bin"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(tree, "d-large.txt"), "123456", "utf8");
  const capture = await captureSubjectMaterials(
    store,
    [{ id: "tree", kind: "directory", locator: tree }],
    capturedAt,
    {},
    noArtifacts(),
  );
  const projection = await projectSubjectText(store, capture.bindings, { maxFileBytes: 4, maxTotalBytes: 20 });
  assert.deepEqual(projection.files.map((file) => [file.path, file.text]), [["a.txt", "ok"]]);
  assert.deepEqual(
    projection.omissions.map((entry) => [entry.path, entry.reason]),
    [
      ["b-invalid.bin", "INVALID_UTF8"],
      ["c-control.bin", "BINARY_CONTROL_BYTES"],
      ["d-large.txt", "PER_FILE_LIMIT"],
    ],
  );
  assert.equal(projection.omissions.every((entry) => /^sha256:[a-f0-9]{64}$/u.test(entry.omissionDigest)), true);
});

test("projection and capture digests are deterministic under caller ordering", async () => {
  const { root, store } = await fixture("jevyr-material-order-");
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "first", "utf8");
  await writeFile(second, "second", "utf8");
  const capture = await captureSubjectMaterials(
    store,
    [
      { id: "z", kind: "file", locator: second },
      { id: "a", kind: "file", locator: first },
    ],
    capturedAt,
    {},
    noArtifacts(),
  );
  assert.deepEqual(capture.bindings.map((binding) => binding.subjectId), ["a", "z"]);
  const forward = await projectSubjectText(store, capture.bindings);
  const reversed = await projectSubjectText(store, [...capture.bindings].reverse());
  assert.deepEqual(forward, reversed);
  assert.equal(forward.projectionDigest, reversed.projectionDigest);
  assert.deepEqual(forward.files.map((file) => file.text), ["first", "second"]);
});

test("a corrupted or preoccupied CAS address is rejected and never overwritten", async () => {
  const { root, store } = await fixture("jevyr-material-corrupt-");
  const source = join(root, "source.txt");
  await writeFile(source, "trusted bytes", "utf8");
  const first = await captureSubjectMaterials(
    store,
    [{ id: "source", kind: "file", locator: source }],
    capturedAt,
    {},
    noArtifacts(),
  );
  const manifest = await verifySubjectMaterialBinding(store, onlyBinding(first.bindings));
  const blob = manifest.entries[0];
  if (!blob) throw new Error("fixture did not store a blob");
  const blobPath = join(store, "blobs", blob.blobDigest.slice("sha256:".length));
  await writeFile(blobPath, "hostile bytes", "utf8");

  await assert.rejects(projectSubjectText(store, first.bindings), /CAS address .* mismatched bytes/);
  await assert.rejects(
    captureSubjectMaterials(
      store,
      [{ id: "source", kind: "file", locator: source }],
      capturedAt,
      {},
      noArtifacts(),
    ),
    /CAS address .* mismatched bytes/,
  );
  assert.equal(await readFile(blobPath, "utf8"), "hostile bytes");
});

test("fetched URL and Jevyr artifact bytes are captured without exposing their locators", async () => {
  const { store } = await fixture("jevyr-material-external-");
  const artifactData = Buffer.from("artifact body", "utf8");
  const artifact: ArtifactSnapshotSource = {
    id: `artifact_${"a".repeat(24)}`,
    caseId: "case_12345678",
    mediaType: "text/plain",
    size: artifactData.byteLength,
    digest: sha256Digest(artifactData),
    data: artifactData,
  };
  const fetchImpl = (async () => new Response("url body", {
    status: 200,
    headers: { "content-type": "text/plain", etag: '"one"' },
  })) as typeof fetch;
  const capture = await captureSubjectMaterials(
    store,
    [
      { id: "url", kind: "url", locator: "https://example.test/private/path", revision: '"one"' },
      { id: "artifact", kind: "artifact", locator: `${artifact.caseId}/${artifact.id}`, revision: artifact.digest },
    ],
    capturedAt,
    { url: { mode: "fetch", allowedOrigins: ["https://example.test"] } },
    {
      fetch: fetchImpl,
      resolveArtifact: async (caseId, artifactId) => caseId === artifact.caseId && artifactId === artifact.id ? artifact : undefined,
    },
  );
  assert.equal(capture.bindings.every((binding) => binding.availability === "MATERIALIZED"), true);
  const projection = await projectSubjectText(store, capture.bindings);
  assert.deepEqual(projection.files.map((file) => file.text), ["artifact body", "url body"]);
  assert.equal(JSON.stringify(projection).includes("example.test"), false);
  assert.equal(JSON.stringify(projection).includes(artifact.caseId), false);
});

test("remote declarations contain no bytes and local Git captures stable clean and dirty worktrees", async (context) => {
  const { root, store } = await fixture("jevyr-material-git-");
  const remote = await captureSubjectMaterials(
    store,
    [{ id: "remote", kind: "git", locator: "https://example.invalid/repository.git", revision: "main" }],
    capturedAt,
    {},
    noArtifacts(),
  );
  assert.equal(remote.bindings[0]?.availability, "DECLARATION_ONLY");
  const remoteProjection = await projectSubjectText(store, remote.bindings);
  assert.equal(remoteProjection.files.length, 0);
  assert.equal(remoteProjection.omissions[0]?.policyReason, "REMOTE_DECLARATION");

  const repository = join(root, "repo");
  await mkdir(repository);
  try {
    await execute("git", ["init", "-q"], { cwd: repository });
  } catch {
    context.skip("git is unavailable");
    return;
  }
  await execute("git", ["config", "user.email", "jevyr@example.invalid"], { cwd: repository });
  await execute("git", ["config", "user.name", "Jevyr Test"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "committed", "utf8");
  await execute("git", ["add", "tracked.txt"], { cwd: repository });
  await execute("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

  const clean = await captureSubjectMaterials(
    store,
    [{ id: "repo-clean", kind: "git", locator: repository, revision: commit }],
    capturedAt,
    {},
    noArtifacts(),
  );
  assert.equal(clean.bindings[0]?.availability, "MATERIALIZED");
  assert.deepEqual((await projectSubjectText(store, clean.bindings)).files.map((file) => file.text), ["committed"]);

  await writeFile(join(repository, "tracked.txt"), "modified", "utf8");
  await writeFile(join(repository, "untracked.txt"), "new", "utf8");
  const dirty = await captureSubjectMaterials(
    store,
    [{ id: "repo-dirty", kind: "git", locator: repository, revision: commit }],
    capturedAt,
    {},
    noArtifacts(),
  );
  assert.equal(dirty.bindings[0]?.availability, "MATERIALIZED");
  assert.deepEqual((await projectSubjectText(store, dirty.bindings)).files.map((file) => file.text), ["modified", "new"]);

  await unlink(join(repository, "tracked.txt"));
  const deleted = await captureSubjectMaterials(
    store,
    [{ id: "repo-deleted", kind: "git", locator: repository, revision: commit }],
    capturedAt,
    {},
    noArtifacts(),
  );
  assert.equal(deleted.bindings[0]?.availability, "DECLARATION_ONLY");
  assert.equal((await projectSubjectText(store, deleted.bindings)).omissions[0]?.policyReason, "GIT_DELETION_REQUIRES_BASE_OBJECTS");
});

test("material capture rejects a linked directory entry instead of following it", async (context) => {
  const { root, store } = await fixture("jevyr-material-link-");
  const tree = join(root, "tree");
  await mkdir(tree);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside", "utf8");
  try {
    await symlink(outside, join(tree, "escape.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("This Windows account cannot create symbolic links");
      return;
    }
    throw error;
  }
  await assert.rejects(
    captureSubjectMaterials(
      store,
      [{ id: "tree", kind: "directory", locator: tree }],
      capturedAt,
      {},
      noArtifacts(),
    ),
    /refuses symbolic links/,
  );
});
