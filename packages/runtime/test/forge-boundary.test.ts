import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { digestJson, sha256Digest } from "@jevyr/protocol";
import {
  buildDockerForgeArguments,
  buildDockerForgeCreateArguments,
  candidateMaterializationDigest,
  candidateTreeDigest,
  copySanitizedDirectory,
  dockerForgeImageVolumeProblem,
  dockerForgeMountTopologyProblem,
  decodeExactByteCapture,
  decodeToolObservation,
  encodeToolObservation,
  FORGE_LIMIT_DEFAULTS,
  MAX_JEVYR_IGNORE_BYTES,
  MAX_TOOL_OBSERVATION_BYTES,
  normalizeJevyrRelativePath,
  resolveSubjectSnapshots,
  sealDockerSubstrateIdentity,
  SealedForgeAdapter,
  toolObservationOutputBytes,
  type CandidateMaterializedFile,
  type ForgeInvocationMaterials,
} from "../src/index.js";

const temporary: string[] = [];
const DOCKER_IMAGE_A = `sha256:${"a".repeat(64)}`;
const DOCKER_IMAGE_B = `sha256:${"b".repeat(64)}`;
const DOCKER_USER_ID = 1_000;
const DOCKER_GROUP_ID = 1_000;

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const noArtifacts = { resolveArtifact: async () => undefined };

function materializedFile(path: string, content: string): CandidateMaterializedFile {
  const bytes = Buffer.from(content, "utf8");
  return Object.freeze({ path, byteLength: bytes.byteLength, digest: sha256Digest(bytes) });
}

async function forgeMaterials(
  candidateRootInput?: string,
  files: readonly CandidateMaterializedFile[] = [],
): Promise<ForgeInvocationMaterials> {
  const candidateRoot = candidateRootInput ?? await mkdtemp(join(tmpdir(), "jevyr-forge-candidate-fixture-"));
  if (candidateRootInput === undefined) temporary.push(candidateRoot);
  const subjectRoot = await mkdtemp(join(dirname(candidateRoot), "jevyr-forge-subject-fixture-"));
  temporary.push(subjectRoot);
  const blueprintDigest = digestJson({ protocol: "fixture.candidate-blueprint/1", files: [] });
  return Object.freeze({
    protocol: "jevyr.forge-invocation-materials/1",
    candidate: Object.freeze({
      sourceRoot: candidateRoot,
      blueprintDigest,
      materializationDigest: candidateMaterializationDigest(blueprintDigest, files),
      treeDigest: candidateTreeDigest(files),
    }),
    subjects: Object.freeze({
      subjectRoot,
      captureDigest: digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: [] }),
      materializationDigest: digestJson({ protocol: "jevyr.subject-materialization/1", subjects: [] }),
    }),
  });
}

test("directory snapshots exclude built-in secrets even when .jevyrignore negates them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-ignore-snapshot-"));
  temporary.push(root);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, ".jevyrignore"), "!.env\n!nested/private.pem\n!credentials.json\n!disguised.txt\n", "utf8");
  await writeFile(join(root, "visible.txt"), "visible", "utf8");
  await writeFile(join(root, ".env"), "TOKEN=first", "utf8");
  await writeFile(join(root, "nested", "private.pem"), "private-one", "utf8");
  await writeFile(join(root, "credentials.json"), "credential-one", "utf8");
  await writeFile(join(root, "disguised.txt"), "-----BEGIN PRIVATE KEY-----\none", "utf8");
  const subject = { id: "tree", kind: "directory" as const, locator: root };
  const capturedAt = "2026-09-04T12:00:00.000Z";
  const first = (await resolveSubjectSnapshots([subject], capturedAt, {}, noArtifacts))[0];

  await writeFile(join(root, ".env"), "TOKEN=second", "utf8");
  await writeFile(join(root, "nested", "private.pem"), "private-two", "utf8");
  await writeFile(join(root, "credentials.json"), "credential-two", "utf8");
  await writeFile(join(root, "disguised.txt"), "-----BEGIN PRIVATE KEY-----\ntwo", "utf8");
  const secretsChanged = (await resolveSubjectSnapshots([subject], capturedAt, {}, noArtifacts))[0];
  assert.equal(secretsChanged?.digest, first?.digest);
  assert.equal(secretsChanged?.byteLength, first?.byteLength);

  await writeFile(join(root, "visible.txt"), "visible-change", "utf8");
  const visibleChanged = (await resolveSubjectSnapshots([subject], capturedAt, {}, noArtifacts))[0];
  assert.notEqual(visibleChanged?.digest, first?.digest);
});

test("the shared ignore control file and portable paths are strictly bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-ignore-bounds-"));
  temporary.push(root);
  await writeFile(join(root, ".jevyrignore"), "x".repeat(MAX_JEVYR_IGNORE_BYTES + 1), "utf8");
  await assert.rejects(
    resolveSubjectSnapshots(
      [{ id: "tree", kind: "directory", locator: root }],
      "2026-09-04T12:00:00.000Z",
      {},
      noArtifacts,
    ),
    new RegExp(`exceeds ${MAX_JEVYR_IGNORE_BYTES} bytes`),
  );
  assert.throws(() => normalizeJevyrRelativePath("../escape"), /Unsafe relative path segments/);
  assert.throws(() => normalizeJevyrRelativePath("ambiguous//name"), /Unsafe relative path segments/);
});

test("trusted-host Forge receives only the sanitized copy and a clean environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-ignore-forge-"));
  temporary.push(root);
  await writeFile(join(root, ".jevyrignore"), "!.env\n!private.pem\n!credentials.json\n!disguised.txt\n", "utf8");
  await writeFile(join(root, "visible.txt"), "visible", "utf8");
  await writeFile(join(root, ".env"), "TOKEN=sealed", "utf8");
  await writeFile(join(root, "private.pem"), "pem-secret", "utf8");
  await writeFile(join(root, "credentials.json"), "credential-secret", "utf8");
  await writeFile(join(root, "disguised.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret", "utf8");

  const variable = "JEVYR_FORGE_BOUNDARY_HOST_SECRET";
  const previous = process.env[variable];
  process.env[variable] = "must-not-cross";
  try {
    const script = [
      "const fs=require('node:fs')",
      `process.stdout.write(JSON.stringify({visible:fs.existsSync('visible.txt'),env:fs.existsSync('.env'),pem:fs.existsSync('private.pem'),credentials:fs.existsSync('credentials.json'),disguised:fs.existsSync('disguised.txt'),host:process.env.${variable}??null,cwd:process.cwd(),home:process.env.HOME??null,tmpdir:process.env.TMPDIR??null,tmp:process.env.TMP??null,temp:process.env.TEMP??null,cache:process.env.XDG_CACHE_HOME??null}))`,
    ].join(";");
    const observation = await new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true }).execute({
      invocationId: "invocation_boundary",
      caseId: "case_boundary_12345678",
      tool: "forge.command",
      args: {
        command: process.execPath,
        args: ["-e", script],
        environment: {
          HOME: "C:/outside/home",
          TMPDIR: "C:/outside/tmpdir",
          TMP: "C:/outside/tmp",
          TEMP: "C:/outside/temp",
          XDG_CACHE_HOME: "C:/outside/cache",
        },
      },
      timeoutMs: 10_000,
      forgeMaterials: await forgeMaterials(root, [
        materializedFile(".jevyrignore", "!.env\n!private.pem\n!credentials.json\n!disguised.txt\n"),
        materializedFile("visible.txt", "visible"),
      ]),
      signal: new AbortController().signal,
    });
    assert.equal(observation.status, "succeeded", observation.summary);
    const stdout = observation.oracle?.execution.stdoutCapture;
    assert.ok(stdout);
    const view = JSON.parse(decodeExactByteCapture(stdout).text ?? "{}") as Record<string, unknown>;
    assert.equal(view.visible, true);
    assert.equal(view.env, false);
    assert.equal(view.pem, false);
    assert.equal(view.credentials, false);
    assert.equal(view.disguised, false);
    assert.equal(view.host, null);
    assert.match(String(view.home), /jevyr-forge-/u);
    const writableRoot = dirname(String(view.cwd));
    assert.equal(dirname(dirname(String(view.home))), writableRoot);
    assert.equal(dirname(dirname(String(view.tmpdir))), writableRoot);
    assert.equal(view.tmp, view.tmpdir);
    assert.equal(view.temp, view.tmpdir);
    assert.equal(dirname(dirname(dirname(String(view.cache)))), writableRoot);
    assert.equal(JSON.stringify(view).includes("C:/outside"), false);
    const excluded = observation.metadata?.excludedPaths as Array<{ path: string; reason: string }>;
    assert.deepEqual(excluded.map((entry) => entry.path), [".env", "credentials.json", "disguised.txt", "private.pem"]);
    assert.equal(observation.metadata?.sourceSanitized, true);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("executable Forge fails closed without a runtime material binding", async () => {
  const observation = await new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true }).execute({
    invocationId: "invocation_missing_material_binding",
    caseId: "case_missing_material_binding_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["--version"] },
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(observation.metadata?.admissible, false);
  assert.match(String(observation.metadata?.boundaryFailure), /forgeMaterials/u);
});

test("Forge rejects a candidate changed after Bone supplied its expected tree binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-forge-candidate-tamper-"));
  temporary.push(root);
  const expected = materializedFile("input.txt", "expected");
  await writeFile(join(root, "input.txt"), "expected", "utf8");
  const materials = await forgeMaterials(root, [expected]);
  await writeFile(join(root, "input.txt"), "tampered", "utf8");
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    retainFailedWorkspace: true,
  }).execute({
    invocationId: "invocation_candidate_tamper",
    caseId: "case_candidate_tamper_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["--version"] },
    timeoutMs: 5_000,
    forgeMaterials: materials,
    signal: new AbortController().signal,
  });
  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.match(String(observation.metadata?.boundaryFailure), /materialization binding/u);
  const retained = String(observation.metadata?.retainedWorkspace);
  temporary.push(retained);
  assert.deepEqual(await readdir(retained), ["work"], "runtime directories must not precede blueprint validation");
});

test("sanitized Forge copies refuse symbolic links rather than following or silently skipping them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-ignore-link-"));
  const destinationParent = await mkdtemp(join(tmpdir(), "jevyr-ignore-link-copy-"));
  temporary.push(root, destinationParent);
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
    copySanitizedDirectory(join(root, "tree"), join(destinationParent, "copy"), {
      maxFiles: 100,
      maxFileBytes: 1_000_000,
    }),
    /refuses symbolic links/,
  );
});

test("Docker arguments place every declared writable surface inside one monitored host envelope", () => {
  const original = resolve("C:/sensitive/original-subject");
  const sanitized = resolve("C:/temp/jevyr-forge-123/subject");
  const writableRoot = resolve("C:/temp/jevyr-forge-123/writable");
  const args = buildDockerForgeArguments({
    subjectRoot: sanitized,
    writableRoot,
    image: DOCKER_IMAGE_A,
    command: "node",
    args: ["--version"],
    environment: {
      CUSTOM: "visible",
      HOME: "/escape/home",
      TMPDIR: "/escape/tmp",
      XDG_CACHE_HOME: "/escape/cache",
    },
    allowNetwork: false,
    memoryMb: 1_024,
    cpus: 2,
    pidsLimit: 256,
    userId: DOCKER_USER_ID,
    groupId: DOCKER_GROUP_ID,
  });
  const mounts = args.flatMap((argument, index) => argument === "--volume" ? [args[index + 1] as string] : []);
  assert.equal(mounts.some((mount) => mount.includes(original)), false);
  assert.deepEqual(mounts, [
    `${sanitized}:/subject:ro`,
    `${writableRoot}:/jevyr-writable:rw`,
    `${join(writableRoot, "runtime", "tmp")}:/tmp:rw`,
    `${join(writableRoot, "runtime", "shm")}:/dev/shm:rw`,
  ]);
  assert.equal(args.includes("--tmpfs"), false);
  assert.notEqual(sanitized, writableRoot);
  const environment = args.flatMap((argument, index) => argument === "--env" ? [args[index + 1] as string] : []);
  assert.ok(environment.includes("CUSTOM=visible"));
  assert.ok(environment.includes("HOME=/jevyr-writable/runtime/home"));
  assert.ok(environment.includes("TMPDIR=/tmp"));
  assert.ok(environment.includes("TMP=/tmp"));
  assert.ok(environment.includes("TEMP=/tmp"));
  assert.ok(environment.includes("XDG_CACHE_HOME=/jevyr-writable/runtime/home/.cache"));
  assert.equal(environment.some((entry) => entry.includes("/escape/")), false);
  assert.ok(args.includes("--read-only"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--ipc") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], `${DOCKER_USER_ID}:${DOCKER_GROUP_ID}`);
  assert.ok(DOCKER_USER_ID > 0 && DOCKER_GROUP_ID > 0);
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(args[args.indexOf("--workdir") + 1], "/jevyr-writable/work");
  assert.ok(args.includes(DOCKER_IMAGE_A));
  assert.deepEqual(args.slice(args.indexOf(DOCKER_IMAGE_A)), [DOCKER_IMAGE_A, "node", "--version"]);
  assert.equal(args.includes("node:24-alpine"), false);
});

test("Docker execution arguments reject mutable tags", () => {
  assert.throws(
    () => buildDockerForgeArguments({
      subjectRoot: resolve("C:/temp/jevyr-forge-tag/subject"),
      writableRoot: resolve("C:/temp/jevyr-forge-tag/writable"),
      image: "node:24-alpine",
      command: "node",
      args: ["--version"],
      allowNetwork: false,
      memoryMb: 1_024,
      cpus: 2,
      pidsLimit: 256,
      userId: DOCKER_USER_ID,
      groupId: DOCKER_GROUP_ID,
    }),
    /full lowercase SHA-256 image ID/u,
  );
});

test("Docker argument construction rejects overlapping read-only and writable roots", () => {
  const subjectRoot = resolve("C:/temp/jevyr-forge-overlap/subject");
  assert.throws(
    () => buildDockerForgeArguments({
      subjectRoot,
      writableRoot: join(subjectRoot, "candidate-writable"),
      image: DOCKER_IMAGE_A,
      command: "node",
      args: ["--version"],
      allowNetwork: false,
      memoryMb: 1_024,
      cpus: 2,
      pidsLimit: 256,
      userId: DOCKER_USER_ID,
      groupId: DOCKER_GROUP_ID,
    }),
    /must not overlap/u,
  );
});

test("Docker argument construction cannot restore container-root execution", () => {
  assert.throws(
    () => buildDockerForgeArguments({
      subjectRoot: resolve("C:/temp/jevyr-forge-root-user/subject"),
      writableRoot: resolve("C:/temp/jevyr-forge-root-user/writable"),
      image: DOCKER_IMAGE_A,
      command: "node",
      args: ["--version"],
      allowNetwork: false,
      memoryMb: 1_024,
      cpus: 2,
      pidsLimit: 256,
      userId: 0,
      groupId: 0,
    }),
    /numeric non-root/u,
  );
});

test("Docker mount verification rejects image volumes and writable subject substitution", () => {
  const roots = {
    subjectRoot: resolve("C:/host/subject"),
    writableRoot: resolve("C:/host/writable"),
  };
  const exact = [
    { Type: "bind", Source: roots.subjectRoot, Destination: "/subject", RW: false },
    { Type: "bind", Source: roots.writableRoot, Destination: "/jevyr-writable", RW: true },
    { Type: "bind", Source: join(roots.writableRoot, "runtime", "tmp"), Destination: "/tmp", RW: true },
    { Type: "bind", Source: join(roots.writableRoot, "runtime", "shm"), Destination: "/dev/shm", RW: true },
  ];
  assert.equal(dockerForgeMountTopologyProblem(exact, roots), undefined);
  if (process.platform === "win32") {
    const desktopSource = (path: string): string => {
      const portable = path.replace(/\\/gu, "/");
      return `/run/desktop/mnt/host/${portable[0]?.toLowerCase()}${portable.slice(2)}`;
    };
    assert.equal(dockerForgeMountTopologyProblem(exact.map((mount) => ({
      ...mount,
      Source: desktopSource(mount.Source),
    })), roots), undefined);
  }
  assert.equal(dockerForgeImageVolumeProblem(null), undefined);
  assert.equal(dockerForgeImageVolumeProblem({}), undefined);
  assert.match(String(dockerForgeImageVolumeProblem({ "/data": {} })), /declares storage-bearing volumes/u);
  assert.match(String(dockerForgeMountTopologyProblem([
    ...exact,
    { Type: "volume", Source: "/var/lib/docker/volumes/extra", Destination: "/data", RW: true },
  ], roots)), /unexpected mount count/u);
  assert.match(String(dockerForgeMountTopologyProblem(exact.map((mount) => mount.Destination === "/subject"
    ? { ...mount, RW: true }
    : mount), roots)), /unexpected writable mount topology/u);
  assert.match(String(dockerForgeMountTopologyProblem(exact.map((mount) => mount.Destination === "/tmp"
    ? { ...mount, Source: join(roots.writableRoot, "unmonitored-tmp") }
    : mount), roots)), /unexpected writable mount topology/u);
});

test("Docker create arguments permit concrete-container inspection before execution", () => {
  const containerIdFile = resolve("C:/temp/jevyr-forge-create/control/container.cid");
  const args = buildDockerForgeCreateArguments({
    subjectRoot: resolve("C:/temp/jevyr-forge-create/subject"),
    writableRoot: resolve("C:/temp/jevyr-forge-create/writable"),
    image: DOCKER_IMAGE_A,
    command: "node",
    args: ["check.js"],
    allowNetwork: false,
    memoryMb: 1_024,
    cpus: 2,
    pidsLimit: 256,
    userId: DOCKER_USER_ID,
    groupId: DOCKER_GROUP_ID,
    containerIdFile,
  });
  assert.equal(args[0], "create");
  assert.equal(args.includes("--rm"), false);
  assert.equal(args[args.indexOf("--cidfile") + 1], containerIdFile);
  assert.ok(args.includes(DOCKER_IMAGE_A));
});

test("Docker substrate seals reject a reference mismatch instead of following a retag", () => {
  const identity = sealDockerSubstrateIdentity(
    "registry.example/jevyr:stable",
    { status: "resolved", imageId: DOCKER_IMAGE_A },
    "embedder-injected-resolver",
  );
  assert.equal(identity.immutableImageId, DOCKER_IMAGE_A);
  assert.throws(
    () => new SealedForgeAdapter({
      mode: "docker",
      dockerImage: "registry.example/jevyr:moved",
      dockerSubstrateIdentity: identity,
    }),
    /requestedReference does not match dockerImage/u,
  );
  const moved = sealDockerSubstrateIdentity(
    "registry.example/jevyr:stable",
    { status: "resolved", imageId: DOCKER_IMAGE_B },
    "embedder-injected-resolver",
  );
  assert.notEqual(moved.immutableImageId, identity.immutableImageId);
  assert.equal(identity.immutableImageId, DOCKER_IMAGE_A, "a later retag cannot mutate the startup seal");
});

function physicalViolation(observation: Awaited<ReturnType<SealedForgeAdapter["execute"]>>): Record<string, unknown> {
  return observation.metadata?.resourceViolation as Record<string, unknown>;
}

test("Forge refuses a post-execution workspace whose aggregate bytes exceed the configured ceiling", async () => {
  const script = "require('node:fs').writeFileSync('payload.bin',Buffer.alloc(80))";
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxWritableBytes: 64,
    maxWritableInodes: 10,
    maxFileBytes: 100,
    workspacePollIntervalMs: 1_000,
  }).execute({
    invocationId: "invocation_aggregate_bytes",
    caseId: "case_aggregate_bytes_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(observation.metadata?.admissible, false);
  assert.equal(physicalViolation(observation).kind, "workspace-bytes");
  assert.equal(physicalViolation(observation).used, 80);
  assert.equal(physicalViolation(observation).ceiling, 64);
});

test("Forge refuses a complete manifest when HOME files exceed the shared writable inode ceiling", async () => {
  const script = "const f=require('node:fs'),p=require('node:path');for(let i=0;i<3;i++)f.writeFileSync(p.join(process.env.HOME,`f${i}.txt`),'x')";
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxWritableBytes: 1_000,
    // Five entries are the fixed work/runtime scaffold. Three HOME files
    // therefore cross this seven-entry envelope.
    maxWritableInodes: 7,
    maxFileBytes: 100,
    workspacePollIntervalMs: 1_000,
  }).execute({
    invocationId: "invocation_inode_limit",
    caseId: "case_inode_limit_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(physicalViolation(observation).kind, "workspace-inodes");
  assert.equal(physicalViolation(observation).used, 8);
  assert.equal(physicalViolation(observation).ceiling, 7);
});

test("Forge accounts temporary-directory bytes inside the same writable envelope", async () => {
  const script = "require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'payload.bin'),Buffer.alloc(80))";
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxWritableBytes: 64,
    maxWritableInodes: 20,
    maxFileBytes: 100,
    workspacePollIntervalMs: 1_000,
  }).execute({
    invocationId: "invocation_temporary_bytes",
    caseId: "case_temporary_bytes_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(physicalViolation(observation).kind, "workspace-bytes");
  assert.equal(physicalViolation(observation).used, 80);
  assert.equal(physicalViolation(observation).ceiling, 64);
});

test("runtime-state accounting does not contaminate deterministic candidate output accounting", async () => {
  const script = [
    "const f=require('node:fs'),p=require('node:path')",
    "f.writeFileSync(p.join(process.env.TMPDIR,'runtime.bin'),'runtime!')",
    "f.writeFileSync('result.txt','out')",
  ].join(";");
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxWritableBytes: 1_000,
    maxWritableInodes: 20,
    maxFileBytes: 100,
  }).execute({
    invocationId: "invocation_runtime_output_separation",
    caseId: "case_runtime_output_separation_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "succeeded", observation.summary);
  assert.deepEqual(observation.metadata?.changedFiles, ["result.txt"]);
  const receipt = observation.metadata?.artifactReceipt as Record<string, unknown>;
  assert.equal(receipt.outputBytes, 3);
  assert.deepEqual(observation.oracle?.workspace?.entries, [{
    path: "result.txt",
    kind: "file",
    byteLength: 3,
    digest: sha256Digest(Buffer.from("out", "utf8")),
  }]);
  const accounting = observation.metadata?.resourceAccounting as {
    workspace: { after: { bytes: number; inodes: number } };
  };
  assert.equal(accounting.workspace.after.bytes, 11);
  assert.equal(accounting.workspace.after.inodes, 7);
});

test("Forge terminates and makes excessive combined process output non-admissible", async () => {
  const script = "process.stdout.write('o'.repeat(4096));process.stderr.write('e'.repeat(4096));setInterval(()=>{},1000)";
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxProcessOutputBytes: 64,
    workspacePollIntervalMs: 1_000,
  }).execute({
    invocationId: "invocation_output_limit",
    caseId: "case_output_limit_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(
    (observation.stdoutCapture?.byteLength ?? 0) + (observation.stderrCapture?.byteLength ?? 0),
    64,
  );
  assert.equal(physicalViolation(observation).kind, "process-output");
  assert.equal(physicalViolation(observation).ceiling, 64);
  assert.ok(Number(physicalViolation(observation).used) > 64);
});

test("Forge artifacts preserve invalid stdout and stderr as distinct exact byte streams", async () => {
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
  }).execute({
    invocationId: "invocation_binary_output",
    caseId: "case_binary_output_12345678",
    tool: "forge.command",
    args: {
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from([128]));process.stderr.write(Buffer.from([129]))"],
    },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "succeeded", observation.summary);
  assert.equal(observation.stdout, undefined);
  assert.equal(observation.stderr, undefined);
  const stdout = observation.oracle?.execution.stdoutCapture;
  const stderr = observation.oracle?.execution.stderrCapture;
  assert.ok(stdout);
  assert.ok(stderr);
  assert.equal(stdout.utf8, "invalid");
  assert.equal(stderr.utf8, "invalid");
  assert.notEqual(stdout.digest, stderr.digest);
  assert.deepEqual([...decodeExactByteCapture(stdout).bytes], [0x80]);
  assert.deepEqual([...decodeExactByteCapture(stderr).bytes], [0x81]);
  const processOutput = (observation.metadata?.resourceAccounting as {
    processOutput: Record<string, unknown>;
  }).processOutput;
  assert.equal(processOutput.usedBytes, 2);
  assert.equal(processOutput.retainedBytes, 2);
  assert.equal(processOutput.stdoutBytes, 1);
  assert.equal(processOutput.stderrBytes, 1);
  assert.equal(stdout.data.length + stderr.data.length, 8);
  assert.equal(toolObservationOutputBytes(observation), 2);

  const encoded = encodeToolObservation(observation);
  const replayed = decodeToolObservation(encoded.bytes);
  assert.equal(replayed.oracle?.execution.stdoutCapture?.digest, stdout.digest);
  assert.equal(replayed.oracle?.execution.stderrCapture?.digest, stderr.digest);
});

test("Forge's exact-output cap fits one canonical observation and cap plus one fails closed", async () => {
  const cap = FORGE_LIMIT_DEFAULTS.maxProcessOutputBytes;
  assert.equal(cap, 1_000_000);
  const forge = new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true });
  const invoke = async (count: number, suffix: string) => await forge.execute({
    invocationId: `invocation_output_boundary_${suffix}`,
    caseId: `case_output_boundary_${suffix}_12345678`,
    tool: "forge.command",
    args: {
      command: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.alloc(${count},97))`],
    },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  const exact = await invoke(cap, "exact");
  assert.equal(exact.status, "succeeded", exact.summary);
  assert.equal(exact.oracle?.execution.stdoutCapture?.byteLength, cap);
  assert.equal(exact.oracle?.execution.stdoutCapture?.complete, true);
  assert.ok(encodeToolObservation(exact).size <= MAX_TOOL_OBSERVATION_BYTES);

  const exceeded = await invoke(cap + 1, "exceeded");
  assert.equal(exceeded.status, "failed", exceeded.summary);
  assert.equal(exceeded.oracle, undefined);
  assert.equal(exceeded.stdoutCapture?.byteLength, cap);
  assert.equal(exceeded.stdoutCapture?.observedByteLength, cap + 1);
  assert.equal(exceeded.stdoutCapture?.complete, false);
  assert.equal(physicalViolation(exceeded).used, cap + 1);
  assert.ok(encodeToolObservation(exceeded).size <= MAX_TOOL_OBSERVATION_BYTES);
});

test("the best-effort workspace meter stops a running writer before timeout", async () => {
  const script = [
    "const f=require('node:fs')",
    "let i=0",
    "setInterval(()=>f.writeFileSync(`runaway-${i++}.txt`,'x'),2)",
  ].join(";");
  const started = Date.now();
  const observation = await new SealedForgeAdapter({
    mode: "trusted-host",
    allowTrustedHost: true,
    maxWritableBytes: 10_000,
    maxWritableInodes: 8,
    maxFileBytes: 100,
    workspacePollIntervalMs: 10,
  }).execute({
    invocationId: "invocation_workspace_monitor",
    caseId: "case_workspace_monitor_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "failed");
  assert.equal(observation.oracle, undefined);
  assert.equal(physicalViolation(observation).kind, "workspace-monitor");
  assert.match(String(physicalViolation(observation).detail), /workspace inode use/u);
  assert.ok(Date.now() - started < 4_000, "monitor should stop the writer before the wall timeout");
});

test("post manifests cover generated ignored paths and resource claims remain honest on trusted host", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-forge-complete-manifest-"));
  temporary.push(root);
  await writeFile(join(root, ".jevyrignore"), "ignored.txt\n", "utf8");
  const script = "require('node:fs').writeFileSync('ignored.txt','generated')";
  const forge = new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true });
  const observation = await forge.execute({
    invocationId: "invocation_complete_manifest",
    caseId: "case_complete_manifest_12345678",
    tool: "forge.command",
    args: { command: process.execPath, args: ["-e", script] },
    timeoutMs: 5_000,
    forgeMaterials: await forgeMaterials(root, [materializedFile(".jevyrignore", "ignored.txt\n")]),
    signal: new AbortController().signal,
  });

  assert.equal(observation.status, "succeeded", observation.summary);
  assert.equal(observation.oracle?.workspace?.complete, true);
  assert.equal(observation.oracle?.workspace?.entries.some((entry) => entry.path === "ignored.txt"), true);
  assert.equal(forge.capability.network, "unrestricted");
  assert.equal(observation.metadata?.networkDenied, false);
  assert.equal(observation.metadata?.sourceReadOnly, false);
  const accounting = observation.metadata?.resourceAccounting as {
    cpu: { measurement: string; usedMillis: number | null; enforcement: string };
    network: { measurement: string; externalBytes: number | null };
    workspace: { before: { complete: boolean }; after: { complete: boolean } };
  };
  assert.deepEqual(accounting.cpu, {
    measurement: "DECLARED_ONLY",
    usedMillis: null,
    enforcement: "UNENFORCED_AND_UNMEASURED",
  });
  assert.deepEqual(accounting.network, {
    measurement: "DECLARED_ONLY",
    externalBytes: null,
    enforcement: "UNMEASURED",
  });
  assert.equal(accounting.workspace.before.complete, true);
  assert.equal(accounting.workspace.after.complete, true);
});
