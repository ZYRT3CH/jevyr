import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, assertCommandInvocation } from "../src/arguments.js";
import { runGovernanceCommand } from "../src/governance-commands.js";
import { loadGenomeStartupSelection, loadPresetStartupSelection } from "@jevyr/daemon";
afterEach(() => vi.restoreAllMocks());
describe("local Genome governance command boundaries", () => {
  it("rejects promotion signing keys and ignored semantic/options on every branch", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    for (const argv of [
      ["genome", "promote", digest, "--attestation", "signed.json", "--signing-key-ref", "env:KEY"],
      ["genome", "inspect", "--file", "ignored.json"], ["preset", "off", "--name", "ignored"],
      ["preset", "use", "../other"], ["benchmark", "run", "--file", "trials.json"],
      ["benchmark", "compare", "--file", "signed.json", "--signing-key-ref", "env:KEY"],
      ["airlock", "seal", "draft_x", "--revision", "1"], ["run", "--file", "case.json", "--case", "second.json"],
    ]) expect(() => assertCommandInvocation(parseArguments(argv))).toThrow();
    expect(() => assertCommandInvocation(parseArguments(["genome", "promote", digest, "--attestation", "signed.json"]))).not.toThrow();
    expect(() => assertCommandInvocation(parseArguments(["preset", "off"]))).not.toThrow();
  });
  it("Wild selects a local next-startup pointer without signing or changing a captured startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-governance-cli-"));
    try {
      const env = { JEVYR_DATA_DIR: join(root, "store") };
      const genome = loadGenomeStartupSelection(env, root, env.JEVYR_DATA_DIR);
      const before = loadPresetStartupSelection(env, root, env.JEVYR_DATA_DIR, genome);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await runGovernanceCommand(parseArguments(["preset", "off", "--json"]), root, env)).toBe(0);
      const result = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(result).toMatchObject({ applies: "next-runtime-startup", sealedCasesChanged: false, selection: { mode: "wild", presetDigest: null } });
      const pointer = JSON.parse(await readFile(join(root, "store", "presets", "selection.json"), "utf8"));
      expect(pointer).toEqual(result.selection);
      expect(before.descriptorDigest).toBe(loadPresetStartupSelection(env, root, env.JEVYR_DATA_DIR, genome).descriptorDigest);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
