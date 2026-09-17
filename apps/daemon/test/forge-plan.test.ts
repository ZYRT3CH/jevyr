import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";

test("Forge plan loading rejects obsolete self-declared decisiveness and releases its lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-plan-validation-"));
  const dataDir = join(root, "data");
  const planPath = join(root, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({
      command: process.execPath,
      args: ["--version"],
      decisiveOnSuccess: true,
    }), "utf8");
    assert.throws(
      () => createDaemonRuntime({ dataDir, env: { JEVYR_FORGE_PLAN_FILE: planPath } }),
      /unknown or obsolete fields: decisiveOnSuccess/u,
    );

    const runtime = createDaemonRuntime({
      dataDir,
      minds: [new RuleMindAdapter()],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    await runtime.ready();
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
