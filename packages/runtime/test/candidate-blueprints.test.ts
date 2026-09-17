import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  CANDIDATE_BLUEPRINT_PROTOCOL,
  CandidateBlueprintError,
  compileCandidateBlueprint,
  loadJevyrIgnorePolicy,
  materializeCandidateBlueprint,
  verifyCandidateBlueprint,
  verifyCandidateMaterialization,
  type CompiledCandidateBlueprint,
  type JevyrIgnorePolicy,
} from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(ignore = ""): Promise<{ root: string; policy: JevyrIgnorePolicy }> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-blueprint-"));
  temporary.push(root);
  if (ignore) await writeFile(join(root, ".jevyrignore"), ignore, "utf8");
  return { root, policy: await loadJevyrIgnorePolicy(root) };
}

function input(
  files: readonly { readonly path: string; readonly content: string }[],
  command?: { readonly executable: string; readonly args: readonly string[] },
): unknown {
  return {
    protocol: CANDIDATE_BLUEPRINT_PROTOCOL,
    files,
    ...(command === undefined ? {} : { command }),
  };
}

function expectCode(action: () => unknown, code: CandidateBlueprintError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CandidateBlueprintError && error.code === code);
}

test("compilation is deterministic, sorted, policy-bound, and makes commands proposal-only", async () => {
  const { policy } = await fixture();
  const first = compileCandidateBlueprint(input([
    { path: "src/z.ts", content: "export const z = 2;\n" },
    { path: "src/a.ts", content: "export const a = '😀';\n" },
  ], { executable: "pnpm", args: ["test", "--runInBand"] }), policy);
  const second = compileCandidateBlueprint(input([
    { path: "src/a.ts", content: "export const a = '😀';\n" },
    { path: "src/z.ts", content: "export const z = 2;\n" },
  ], { executable: "pnpm", args: ["test", "--runInBand"] }), policy);

  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map((file) => file.path), ["src/a.ts", "src/z.ts"]);
  assert.match(first.blueprintDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.ignorePolicyDigest, policy.sourceDigest);
  assert.deepEqual(first.command, {
    executable: "pnpm",
    args: ["test", "--runInBand"],
    shell: false,
    authority: "proposal-only",
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.files), true);
  assert.equal(Object.isFrozen(first.files[0]), true);
  assert.equal(Object.isFrozen(first.command?.args), true);
  assert.deepEqual(verifyCandidateBlueprint(JSON.parse(JSON.stringify(first)), policy), first);
});

test("the source schema rejects unknown authority, oracle, shell, verdict, and link fields", async () => {
  const { policy } = await fixture();
  const ordinary = [{ path: "index.ts", content: "export {};\n" }];
  expectCode(() => compileCandidateBlueprint({ ...(input(ordinary) as object), verdict: "ACCEPT" }, policy), "unknown-field");
  expectCode(() => compileCandidateBlueprint({ ...(input(ordinary) as object), oracle: { kind: "trust-me" } }, policy), "unknown-field");
  expectCode(() => compileCandidateBlueprint(input([
    { path: "link", content: "../outside", kind: "symlink", target: "../outside" } as never,
  ]), policy), "unknown-field");
  expectCode(() => compileCandidateBlueprint(input(ordinary, {
    executable: "node",
    args: [],
    shell: true,
    authority: "execute",
  } as never), policy), "unknown-field");
  expectCode(() => compileCandidateBlueprint(new Date(), policy), "invalid-shape");

  const sparse: unknown[] = [];
  sparse.length = 1;
  expectCode(() => compileCandidateBlueprint(input(sparse as never), policy), "invalid-shape");
});

test("portable paths reject traversal, absolutes, drives, reserved names, ambiguity, and Jevyr controls", async () => {
  const { policy } = await fixture("generated/\n*.tmp\n");
  const paths = [
    "../escape.ts",
    "/absolute.ts",
    "C:/drive.ts",
    "C:\\drive.ts",
    "a//b.ts",
    "a/./b.ts",
    "a/../b.ts",
    "CON.txt",
    "CON .txt",
    "dir/NUL",
    "trailing.",
    " trailing.ts",
    "trailing.ts ",
    "stream:fork",
  ];
  for (const path of paths) {
    expectCode(() => compileCandidateBlueprint(input([{ path, content: "safe" }]), policy), "invalid-path");
  }
  expectCode(() => compileCandidateBlueprint(input([{ path: ".jevyrignore", content: "!*.pem\n" }]), policy), "ignored-path");
  expectCode(() => compileCandidateBlueprint(input([{ path: ".jevyr-subjects/input.txt", content: "collision" }]), policy), "ignored-path");
  expectCode(() => compileCandidateBlueprint(input([{ path: ".jevyr/state.json", content: "{}" }]), policy), "ignored-path");
  expectCode(() => compileCandidateBlueprint(input([{ path: "generated/result.ts", content: "safe" }]), policy), "ignored-path");
  expectCode(() => compileCandidateBlueprint(input([{ path: "scratch.tmp", content: "safe" }]), policy), "ignored-path");
  expectCode(() => compileCandidateBlueprint(input([{ path: ".env", content: "nothing" }]), policy), "ignored-path");
});

test("duplicates, case-fold collisions, and file-directory collisions are rejected", async () => {
  const { policy } = await fixture();
  expectCode(() => compileCandidateBlueprint(input([
    { path: "a.ts", content: "one" },
    { path: "a.ts", content: "two" },
  ]), policy), "collision");
  expectCode(() => compileCandidateBlueprint(input([
    { path: "README.md", content: "one" },
    { path: "readme.md", content: "two" },
  ]), policy), "collision");
  expectCode(() => compileCandidateBlueprint(input([
    { path: "src", content: "file" },
    { path: "SRC/index.ts", content: "nested" },
  ]), policy), "collision");
});

test("binary text, malformed Unicode, credentials, and private keys never enter a blueprint", async () => {
  const { policy } = await fixture();
  expectCode(() => compileCandidateBlueprint(input([{ path: "binary.dat", content: "a\u0000b" }]), policy), "invalid-content");
  expectCode(() => compileCandidateBlueprint(input([{ path: "delete.dat", content: "a\u007fb" }]), policy), "invalid-content");
  expectCode(() => compileCandidateBlueprint(input([{ path: "bad.txt", content: "\ud800" }]), policy), "invalid-content");
  expectCode(() => compileCandidateBlueprint(input([{ path: "buffer.bin", content: Buffer.from([0xff]) as never }]), policy), "invalid-content");
  expectCode(() => compileCandidateBlueprint(input([{
    path: "innocent.txt",
    content: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-for-the-forge",
  }]), policy), "secret-content");
  expectCode(() => compileCandidateBlueprint(input([{
    path: "config.ts",
    content: `const api_key = "sk-${"a".repeat(32)}";`,
  }]), policy), "secret-content");
});

test("hard and caller-selected file, aggregate, path, and argv limits are enforced", async () => {
  const { policy } = await fixture();
  expectCode(() => compileCandidateBlueprint(input([
    { path: "a", content: "a" },
    { path: "b", content: "b" },
  ]), policy, { maxFiles: 1 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "1234" }]), policy, { maxFileBytes: 3 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([
    { path: "a", content: "123" },
    { path: "b", content: "456" },
  ]), policy, { maxFileBytes: 3, maxTotalBytes: 5 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([{ path: "long-name", content: "x" }]), policy, { maxPathBytes: 8 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "x" }], {
    executable: "node",
    args: ["a", "b"],
  }), policy, { maxCommandArgs: 1 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "x" }], {
    executable: "node",
    args: ["1234"],
  }), policy, { maxArgumentBytes: 3 }), "limit");
  expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "x" }]), policy, {
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  }), "limit");
});

test("command proposals are exact argv values and cannot name a path or shell expression", async () => {
  const { policy } = await fixture();
  for (const executable of ["../node", "/bin/sh", "C:\\cmd.exe", "cmd /c", "node;rm", "NUL"]) {
    expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "x" }], {
      executable,
      args: [],
    }), policy), "invalid-command");
  }
  expectCode(() => compileCandidateBlueprint(input([{ path: "a", content: "x" }], {
    executable: "node",
    args: ["line\nbreak"],
  }), policy), "invalid-command");

  const compiled = compileCandidateBlueprint(input([{ path: "a", content: "x" }], {
    executable: "node",
    // These remain literal argv bytes; there is no shell interpreter.
    args: ["script.js", "$(touch impossible)", "a && b"],
  }), policy);
  assert.equal(compiled.command?.shell, false);
  assert.deepEqual(compiled.command?.args, ["script.js", "$(touch impossible)", "a && b"]);
});

test("materialization uses fresh roots, exclusive files, and deterministic verified manifests", async () => {
  const { root, policy } = await fixture();
  const compiled = compileCandidateBlueprint(input([
    { path: "README.md", content: "Jevyr candidate\n" },
    { path: "src/index.ts", content: "export const answer = 42;\n" },
  ], { executable: "node", args: ["src/index.ts"] }), policy);

  const first = await materializeCandidateBlueprint(compiled, root, policy);
  const second = await materializeCandidateBlueprint(compiled, root, policy);
  assert.notEqual(first.root, second.root);
  assert.equal(await readFile(join(first.root, "README.md"), "utf8"), "Jevyr candidate\n");
  assert.equal(await readFile(join(first.root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  assert.deepEqual(first.files, second.files);
  assert.equal(first.materializationDigest, second.materializationDigest);
  assert.equal(first.blueprintDigest, compiled.blueprintDigest);
  assert.equal(first.commandProposal?.authority, "proposal-only");
  assert.deepEqual(await verifyCandidateMaterialization(compiled, first.root, policy), first);

  if (process.platform !== "win32") {
    assert.equal((await stat(first.root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.root, "README.md"))).mode & 0o777, 0o600);
  }
});

test("compiled and on-disk tampering is detected before either can be trusted", async () => {
  const { root, policy } = await fixture();
  const compiled = compileCandidateBlueprint(input([{ path: "src/index.ts", content: "original\n" }]), policy);
  const altered = JSON.parse(JSON.stringify(compiled)) as {
    files: Array<{ content: string; digest: string }>;
    blueprintDigest: string;
  };
  const firstFile = altered.files[0];
  assert.ok(firstFile);
  firstFile.content = "altered\n";
  expectCode(() => verifyCandidateBlueprint(altered, policy), "integrity");

  const forgedDigest = JSON.parse(JSON.stringify(compiled)) as CompiledCandidateBlueprint & { blueprintDigest: string };
  forgedDigest.blueprintDigest = `sha256:${"0".repeat(64)}`;
  expectCode(() => verifyCandidateBlueprint(forgedDigest, policy), "integrity");

  const materialized = await materializeCandidateBlueprint(compiled, root, policy);
  await writeFile(join(materialized.root, "src", "index.ts"), "altered\n", "utf8");
  await assert.rejects(
    verifyCandidateMaterialization(compiled, materialized.root, policy),
    (error: unknown) => error instanceof CandidateBlueprintError && error.code === "filesystem-integrity",
  );
  await writeFile(join(materialized.root, "extra.txt"), "extra", "utf8");
  await assert.rejects(
    verifyCandidateMaterialization(compiled, materialized.root, policy),
    (error: unknown) => error instanceof CandidateBlueprintError && error.code === "filesystem-integrity",
  );

  const alternate = await fixture("*.ts\n");
  expectCode(() => verifyCandidateBlueprint(compiled, alternate.policy), "integrity");
});

test("a failed preflight never creates a disposable directory", async () => {
  const { root, policy } = await fixture();
  const compiled = compileCandidateBlueprint(input([{ path: "safe.txt", content: "safe" }]), policy);
  const tampered = JSON.parse(JSON.stringify(compiled)) as { blueprintDigest: string };
  tampered.blueprintDigest = `sha256:${"f".repeat(64)}`;
  const before = await readdir(root);
  await assert.rejects(materializeCandidateBlueprint(tampered, root, policy));
  assert.deepEqual(await readdir(root), before);

  const nonDirectory = join(root, "not-a-directory");
  await writeFile(nonDirectory, "x", "utf8");
  await assert.rejects(
    materializeCandidateBlueprint(compiled, nonDirectory, policy),
    (error: unknown) => error instanceof CandidateBlueprintError && error.code === "unsafe-destination",
  );
  assert.equal((await lstat(nonDirectory)).isFile(), true);
});
