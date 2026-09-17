import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialize, invocationBase, loadConfig } from "../src/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("jevyr init", () => {
  it("uses a valid package-manager invocation directory and rejects invalid candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-invocation-base-"));
    roots.push(root);
    expect(invocationBase({ INIT_CWD: root }, process.cwd())).toBe(root);
    expect(invocationBase({ INIT_CWD: "relative/path" }, root)).toBe(root);
    expect(invocationBase({ INIT_CWD: join(root, "missing") }, root)).toBe(root);
  });

  it("installs portable config and policy without overwriting existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-init-"));
    roots.push(root);
    const first = await initialize(root);
    expect(first.created).toContain(first.configPath);
    expect(JSON.parse(await readFile(first.configPath, "utf8"))).toMatchObject({ privacy: "local_only", control: "juggler" });
    expect(JSON.parse(await readFile(first.policyPath, "utf8"))).toMatchObject({ protocol: "jevyr.policy/1", policyVersion: "bone-v2", semanticContinuation: false });
    expect(JSON.parse(await readFile(first.assayFrontierPath, "utf8"))).toEqual({
      protocol: "jevyr.assay-frontier/1",
      assays: [{
        assayId: "jevyr.experiment.node-v1",
        costUnits: 1,
        tool: "forge.command",
        args: { command: "node", args: ["jevyr.experiment.mjs"] },
        timeoutMs: 30_000,
      }],
    });
    const original = await readFile(first.configPath, "utf8");
    const second = await initialize(root);
    expect(second.created).toHaveLength(0);
    expect(second.existing).toContain(first.configPath);
    expect(await readFile(first.configPath, "utf8")).toBe(original);
  });

  it("creates only the five portable files, without calibration, keys, Cases, or memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-init-portable-"));
    roots.push(root);
    const initialized = await initialize(root);
    expect(initialized.created).toHaveLength(5);
    expect((await readdir(root)).sort()).toEqual([".jevyr", ".jevyrignore"]);
    expect((await readdir(join(root, ".jevyr"))).sort()).toEqual([
      ".gitignore", "assay-frontier.json", "config.json", "policy.json",
    ]);
    const policy = JSON.parse(await readFile(initialized.policyPath, "utf8"));
    expect(policy.policyVersion).toBe("bone-v2");
    expect(Object.keys(policy).sort()).toEqual([
      "forge", "growth", "memory", "policyVersion", "protocol", "reflex", "semanticContinuation",
    ]);
  });

  it("preserves a legacy policy and custom configuration byte-for-byte when filling missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-init-legacy-"));
    roots.push(root);
    await mkdir(join(root, ".jevyr"));
    const policyPath = join(root, ".jevyr", "policy.json");
    const configPath = join(root, ".jevyr", "config.json");
    const policy = Buffer.from('{\r\n  "protocol": "jevyr.policy/1", "policyVersion": "bone-v1",\r\n  "operatorSetting": "preserve verbatim"\r\n}\r\n');
    const config = Buffer.from('{ "daemonUrl": "http://127.0.0.1:5555", "control": "sovereign" }\n');
    await writeFile(policyPath, policy);
    await writeFile(configPath, config);
    const initialized = await initialize(root);
    expect(initialized.created).toHaveLength(3);
    expect([...initialized.existing].sort()).toEqual([configPath, policyPath].sort());
    expect(initialized.replaced).toEqual([]);
    expect(await readFile(policyPath)).toEqual(policy);
    expect(await readFile(configPath)).toEqual(config);
    const repeated = await initialize(root);
    expect(repeated.created).toEqual([]);
    expect(repeated.replaced).toEqual([]);
    expect(await readFile(policyPath)).toEqual(policy);
  });

  it("replaces only the exact initialization targets when force is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-init-force-"));
    roots.push(root);
    const first = await initialize(root);
    await writeFile(first.policyPath, "user-edited\n", "utf8");

    const forced = await initialize(root, { force: true });

    expect(forced.created).toHaveLength(0);
    expect(forced.existing).toHaveLength(0);
    expect(forced.replaced).toHaveLength(5);
    expect(JSON.parse(await readFile(first.policyPath, "utf8"))).toMatchObject({
      protocol: "jevyr.policy/1",
      policyVersion: "bone-v2",
    });
  });

  it("fails closed on ambiguous, malformed, or expansive CLI configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-config-hostile-"));
    roots.push(root);
    const initialized = await initialize(root);

    await writeFile(
      initialized.configPath,
      '{"daemonUrl":"http://127.0.0.1:4317","chamberUrl":"http://127.0.0.1:3001","privacy":"local_only","\\u0070rivacy":"full_case","control":"sovereign"}',
      "utf8",
    );
    await expect(loadConfig(root)).rejects.toThrow(/duplicate object key "privacy"/u);

    await writeFile(initialized.configPath, Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    await expect(loadConfig(root)).rejects.toThrow(/not valid UTF-8/u);

    await writeFile(
      initialized.configPath,
      JSON.stringify({ ...DEFAULT_CONFIG_FIXTURE, daemonUrl: "file:///tmp/jevyr", hidden: true }),
      "utf8",
    );
    await expect(loadConfig(root)).rejects.toThrow(/unknown fields: hidden/u);
  });
});

const DEFAULT_CONFIG_FIXTURE = {
  daemonUrl: "http://127.0.0.1:4317",
  chamberUrl: "http://localhost:3001",
  privacy: "local_only",
  control: "sovereign",
};
