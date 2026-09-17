import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { sha256Digest } from "@jevyr/protocol";
import { CaseRepository, resolveSubjectSnapshots } from "../src/index.js";

const execute = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function dependencies(fetchImpl?: typeof fetch) {
  return {
    resolveArtifact: async () => undefined,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

test("file and text snapshots bind bytes and reject a false digest revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-subject-file-"));
  temporary.push(root);
  const path = join(root, "subject.txt");
  await writeFile(path, "same bytes", "utf8");
  const capturedAt = "2026-09-04T12:00:00.000Z";
  const [file, text] = await resolveSubjectSnapshots(
    [
      { id: "file", kind: "file", locator: path },
      { id: "text", kind: "text", locator: "same bytes" },
    ],
    capturedAt,
    {},
    dependencies(),
  );
  assert.equal(file?.digest, text?.digest);
  assert.equal(file?.digest, sha256Digest("same bytes"));
  assert.equal(file?.byteLength, 10);
  await assert.rejects(
    resolveSubjectSnapshots(
      [{ id: "wrong", kind: "file", locator: path, revision: `sha256:${"0".repeat(64)}` }],
      capturedAt,
      {},
      dependencies(),
    ),
    /does not match its declared revision digest/,
  );
});

test("directory manifests are stable, exclude volatile roots, and change with included content", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-subject-directory-"));
  temporary.push(root);
  await mkdir(join(root, "nested"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".jevyr"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "visible.txt"), "visible", "utf8");
  await writeFile(join(root, "nested", "inside.txt"), "inside", "utf8");
  await writeFile(join(root, ".git", "volatile"), "one", "utf8");
  await writeFile(join(root, ".jevyr", "volatile"), "one", "utf8");
  await writeFile(join(root, "node_modules", "volatile"), "one", "utf8");
  const subject = { id: "tree", kind: "directory" as const, locator: root };
  const capturedAt = "2026-09-04T12:00:00.000Z";
  const first = (await resolveSubjectSnapshots([subject], capturedAt, {}, dependencies()))[0];
  const second = (await resolveSubjectSnapshots([subject], capturedAt, {}, dependencies()))[0];
  assert.equal(first?.digest, second?.digest);
  assert.equal(first?.byteLength, Buffer.byteLength("visibleinside"));
  await assert.rejects(
    resolveSubjectSnapshots([subject], capturedAt, { maxDirectoryBytes: 1 }, dependencies()),
    /exceeds 1 bytes/,
  );

  await writeFile(join(root, ".git", "volatile"), "two", "utf8");
  await writeFile(join(root, ".jevyr", "volatile"), "two", "utf8");
  await writeFile(join(root, "node_modules", "volatile"), "two", "utf8");
  const excludedChanged = (await resolveSubjectSnapshots([subject], capturedAt, {}, dependencies()))[0];
  assert.equal(first?.digest, excludedChanged?.digest);

  await writeFile(join(root, "visible.txt"), "changed", "utf8");
  const includedChanged = (await resolveSubjectSnapshots([subject], capturedAt, {}, dependencies()))[0];
  assert.notEqual(first?.digest, includedChanged?.digest);
});

test("directory snapshots refuse symlinks instead of following them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-subject-link-"));
  temporary.push(root);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside", "utf8");
  await mkdir(join(root, "tree"));
  try {
    await symlink(outside, join(root, "tree", "escape.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("This Windows account cannot create symbolic links");
      return;
    }
    throw error;
  }
  await assert.rejects(
    resolveSubjectSnapshots(
      [{ id: "tree", kind: "directory", locator: join(root, "tree") }],
      "2026-09-04T12:00:00.000Z",
      {},
      dependencies(),
    ),
    /refuse symbolic links/,
  );
});

test("Git snapshots bind a declared commit and expose worktree dirtiness", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-subject-git-"));
  temporary.push(root);
  try {
    await execute("git", ["init", "-q"], { cwd: root });
  } catch {
    context.skip("git is unavailable");
    return;
  }
  await execute("git", ["config", "user.email", "jevyr@example.invalid"], { cwd: root });
  await execute("git", ["config", "user.name", "Jevyr Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "committed", "utf8");
  await execute("git", ["add", "tracked.txt"], { cwd: root });
  await execute("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const capturedAt = "2026-09-04T12:00:00.000Z";
  const clean = (await resolveSubjectSnapshots(
    [{ id: "repo", kind: "git", locator: root, revision: commit }],
    capturedAt,
    {},
    dependencies(),
  ))[0];
  assert.equal(clean?.revision, commit);

  await mkdir(join(root, "nested-locator"));
  await assert.rejects(
    resolveSubjectSnapshots(
      [{ id: "repo", kind: "git", locator: join(root, "nested-locator"), revision: commit }],
      capturedAt,
      {},
      dependencies(),
    ),
    /must name the repository root/,
  );

  await writeFile(join(root, "tracked.txt"), "modified", "utf8");
  await writeFile(join(root, "untracked.txt"), "new", "utf8");
  const dirty = (await resolveSubjectSnapshots(
    [{ id: "repo", kind: "git", locator: root, revision: commit }],
    capturedAt,
    {},
    dependencies(),
  ))[0];
  assert.notEqual(clean?.digest, dirty?.digest);
  assert.match(dirty?.revision ?? "", new RegExp(`^${commit}\\+dirty\\.`));
  await assert.rejects(
    resolveSubjectSnapshots(
      [{ id: "repo", kind: "git", locator: root, revision: "--help" }],
      capturedAt,
      {},
      dependencies(),
    ),
    /unsafe or unsupported/,
  );
});

test("remote Git and default URL subjects seal declarations without network access", async () => {
  let requests = 0;
  const forbiddenFetch = (async () => {
    requests += 1;
    throw new Error("network should not be reached");
  }) as typeof fetch;
  const snapshots = await resolveSubjectSnapshots(
    [
      { id: "git", kind: "git", locator: "https://example.invalid/repository.git", revision: "main" },
      { id: "ssh-git", kind: "git", locator: "git@example.invalid:team/repository.git", revision: "main" },
      { id: "url", kind: "url", locator: "https://example.invalid/specification", revision: "v1" },
    ],
    "2026-09-04T12:00:00.000Z",
    {},
    dependencies(forbiddenFetch),
  );
  assert.equal(requests, 0);
  assert.equal(snapshots.every((snapshot) => snapshot.resolvedLocator.startsWith("declaration:")), true);
  assert.equal(snapshots.every((snapshot) => /^sha256:[a-f0-9]{64}$/.test(snapshot.digest)), true);
});

test("URL content is fetched only under an exact explicit origin policy", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/plain", etag: '"fixture-v1"' });
    response.end("network-bound bytes");
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const snapshot = (await resolveSubjectSnapshots(
      [{ id: "url", kind: "url", locator: `${origin}/subject`, revision: '"fixture-v1"' }],
      "2026-09-04T12:00:00.000Z",
      { url: { mode: "fetch", allowedOrigins: [origin], maxBytes: 1_000 } },
      dependencies(),
    ))[0];
    assert.equal(requests, 1);
    assert.equal(snapshot?.digest, sha256Digest("network-bound bytes"));
    assert.equal(snapshot?.revision, '"fixture-v1"');
    await assert.rejects(
      resolveSubjectSnapshots(
        [{ id: "url", kind: "url", locator: `${origin}/subject` }],
        "2026-09-04T12:00:00.000Z",
        { url: { mode: "fetch", allowedOrigins: ["https://example.invalid"] } },
        dependencies(),
      ),
      /not explicitly allowed/,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
});

test("artifact subjects resolve and reverify stored content-addressed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-subject-artifact-"));
  temporary.push(root);
  const repository = new CaseRepository(root);
  const sourceCase = await repository.create({ protocol: "jevyr.case/1", case: { impulse: "produce source artifact" } });
  const meta = await repository.putArtifact(sourceCase.caseId, "evidence.txt", "text/plain", Buffer.from("artifact bytes"));
  const dependent = await repository.create({
    protocol: "jevyr.case/1",
    case: {
      impulse: "consume artifact",
      subjects: [{ id: "artifact", kind: "artifact", locator: `${sourceCase.caseId}/${meta.id}`, revision: meta.digest }],
    },
  });
  assert.equal(dependent.sealed.subjects[0]?.digest, meta.digest);
  assert.equal(dependent.sealed.subjects[0]?.resolvedLocator, `jevyr:artifact:${sourceCase.caseId}/${meta.id}`);
  await assert.rejects(
    repository.create({
      protocol: "jevyr.case/1",
      case: {
        impulse: "consume wrong artifact revision",
        subjects: [{ id: "artifact", kind: "artifact", locator: `${sourceCase.caseId}/${meta.id}`, revision: `sha256:${"0".repeat(64)}` }],
      },
    }),
    /does not match its declared revision/,
  );

  await writeFile(join(root, "cases", sourceCase.caseId, "artifacts", `${meta.id}.blob`), "tampered", "utf8");
  await assert.rejects(
    repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "consume corrupt artifact", subjects: [{ id: "artifact", kind: "artifact", locator: `${sourceCase.caseId}/${meta.id}` }] },
    }),
    /failed content-address verification/,
  );
  assert.notEqual(await readFile(join(root, "cases", sourceCase.caseId, "artifacts", `${meta.id}.blob`), "utf8"), "artifact bytes");
});
