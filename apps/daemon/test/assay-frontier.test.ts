import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestJson } from "@jevyr/protocol";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";

function assay(assayId = "daemon.version") {
  return {
    assayId,
    costUnits: 1,
    tool: "forge.command",
    args: { command: "node", args: ["--version"] },
    timeoutMs: 10_000,
  };
}

function runtimeOptions(root: string, env: NodeJS.ProcessEnv) {
  return {
    projectRoot: root,
    dataDir: join(root, "data"),
    env,
    minds: [new RuleMindAdapter()],
    forge: new SealedForgeAdapter({ mode: "observe-only" as const }),
  };
}

function effectivePolicy(runtime: ReturnType<typeof createDaemonRuntime>): Record<string, unknown> {
  const descriptor = runtime.repository.policyDescriptor as Record<string, unknown>;
  return descriptor.policy as Record<string, unknown>;
}

test("daemon seals one immutable canonical Assay Frontier snapshot into effective policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-"));
  const path = join(root, "frontier.json");
  await writeFile(path, JSON.stringify({
    protocol: "jevyr.assay-frontier/1",
    assays: [assay("z.last"), assay("a.first")],
  }), "utf8");
  const runtime = createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier.json" }));
  try {
    const policy = effectivePolicy(runtime);
    const frontier = policy.assayFrontier as Record<string, unknown>;
    assert.equal(frontier.protocol, "jevyr.assay-frontier/1");
    assert.deepEqual((frontier.assays as Array<{ assayId: string }>).map((entry) => entry.assayId), ["a.first", "z.last"]);
    assert.equal(policy.assayFrontierDigest, frontier.digest);
    assert.equal(frontier.digest, digestJson({
      protocol: frontier.protocol,
      assays: frontier.assays,
      aggregateLimits: frontier.aggregateLimits,
      archive: frontier.archive,
    } as never));

    await writeFile(path, JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [] }), "utf8");
    assert.equal((effectivePolicy(runtime).assayFrontier as Record<string, unknown>).digest, frontier.digest);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository-local .jevyr/assay-frontier.json is discovered without ambient configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-conventional-"));
  await mkdir(join(root, ".jevyr"));
  await writeFile(join(root, ".jevyr", "assay-frontier.json"), JSON.stringify({
    protocol: "jevyr.assay-frontier/1",
    assays: [assay("repo.local")],
  }), "utf8");
  const runtime = createDaemonRuntime(runtimeOptions(root, {}));
  try {
    const frontier = effectivePolicy(runtime).assayFrontier as { assays: Array<{ assayId: string }> };
    assert.deepEqual(frontier.assays.map((entry) => entry.assayId), ["repo.local"]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon rejects malformed, duplicate, unknown, and hidden-weakening frontier inputs", async () => {
  const cases: readonly [string, unknown, RegExp][] = [
    ["unknown-root", { protocol: "jevyr.assay-frontier/1", assays: [], approvalBypass: true }, /unknown fields: approvalBypass/u],
    ["wrong-version", { protocol: "jevyr.assay-frontier/0", assays: [] }, /requires protocol jevyr\.assay-frontier\/1/u],
    ["duplicate", { protocol: "jevyr.assay-frontier/1", assays: [assay("same"), assay("same")] }, /must be unique/u],
    ["zero-cost", { protocol: "jevyr.assay-frontier/1", assays: [{ ...assay(), costUnits: 0 }] }, /positive safe integer/u],
    ["hidden-field", { protocol: "jevyr.assay-frontier/1", assays: [{ ...assay(), decisiveOnSuccess: true }] }, /not a recognized assay field/u],
    ["source-root", { protocol: "jevyr.assay-frontier/1", assays: [{ ...assay(), args: { command: "node", sourceRoot: "." } }] }, /not a recognized assay field/u],
    ["environment", { protocol: "jevyr.assay-frontier/1", assays: [{ ...assay(), args: { command: "node", environment: { TOKEN: "secret" } } }] }, /not a recognized assay field/u],
  ];
  for (const [name, value, expected] of cases) {
    const root = await mkdtemp(join(tmpdir(), `jevyr-daemon-frontier-${name}-`));
    try {
      await writeFile(join(root, "frontier.json"), JSON.stringify(value), "utf8");
      assert.throws(
        () => createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier.json" })),
        expected,
        name,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Assay Frontier byte decoding rejects duplicate authority and malformed UTF-8 before daemon construction", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-unambiguous-"));
  const path = join(root, "frontier.json");
  try {
    await writeFile(
      path,
      '{"protocol":"jevyr.assay-frontier/0","protocol":"jevyr.assay-frontier/1","assays":[]}',
      "utf8",
    );
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier.json" })),
      /duplicate object key "protocol"/u,
    );

    const encoded = Buffer.from(JSON.stringify({
      protocol: "jevyr.assay-frontier/1",
      assays: [{ ...assay(), args: { command: "node", args: ["hostile-byte"] } }],
    }), "utf8");
    const marker = encoded.indexOf("hostile-byte");
    assert.ok(marker >= 0);
    encoded[marker] = 0xff;
    await writeFile(path, encoded);
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier.json" })),
      /not valid UTF-8/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontier loading is regular-file bounded and mutually exclusive with the legacy bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-file-"));
  try {
    await mkdir(join(root, "frontier-directory"));
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier-directory" })),
      /regular non-symbolic-link file/u,
    );

    await writeFile(join(root, "frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [] }), "utf8");
    await writeFile(join(root, "legacy.json"), JSON.stringify({ command: "node", args: ["--version"] }), "utf8");
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, {
        JEVYR_ASSAY_FRONTIER_FILE: "frontier.json",
        JEVYR_FORGE_PLAN_FILE: "legacy.json",
      })),
      /never both/u,
    );
    await writeFile(join(root, "legacy.json"), JSON.stringify({
      command: "node",
      args: ["--version"],
      timeoutMs: "10000",
    }), "utf8");
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, { JEVYR_FORGE_PLAN_FILE: "legacy.json" })),
      /timeoutMs must be 1000/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontier loading fails closed when the pathname is swapped after its handle is opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-swap-"));
  const path = join(root, "frontier.json");
  const replacement = join(root, "replacement.json");
  const displaced = join(root, "displaced.json");
  await writeFile(path, JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [assay("original")] }), "utf8");
  await writeFile(replacement, JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [assay("replacement")] }), "utf8");

  const require = createRequire(import.meta.url);
  const mutableFs = require("node:fs") as typeof import("node:fs");
  const originalReadFileSync = mutableFs.readFileSync;
  let swapped = false;
  const replacementReadFileSync = ((...args: unknown[]) => {
    if (!swapped && typeof args[0] === "number") {
      mutableFs.renameSync(path, displaced);
      mutableFs.renameSync(replacement, path);
      swapped = true;
    }
    return Reflect.apply(originalReadFileSync, mutableFs, args);
  }) as typeof mutableFs.readFileSync;
  Object.defineProperty(mutableFs, "readFileSync", { configurable: true, value: replacementReadFileSync });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => createDaemonRuntime(runtimeOptions(root, { JEVYR_ASSAY_FRONTIER_FILE: "frontier.json" })),
      /changed while the daemon was binding its opened file/u,
    );
    assert.equal(swapped, true);
  } finally {
    Object.defineProperty(mutableFs, "readFileSync", { configurable: true, value: originalReadFileSync });
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-plan loading is only a strict canonical frontier bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-daemon-frontier-legacy-"));
  await writeFile(join(root, "legacy.json"), JSON.stringify({ command: "node", args: ["--version"] }), "utf8");
  const runtime = createDaemonRuntime(runtimeOptions(root, { JEVYR_FORGE_PLAN_FILE: "legacy.json" }));
  try {
    const frontier = effectivePolicy(runtime).assayFrontier as { assays: Array<Record<string, unknown>> };
    assert.equal(frontier.assays.length, 1);
    assert.equal(frontier.assays[0]?.assayId, "legacy.default");
    assert.equal(frontier.assays[0]?.costUnits, 1);
    assert.deepEqual(frontier.assays[0]?.args, { command: "node", args: ["--version"] });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
