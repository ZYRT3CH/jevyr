import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevyrClient, type AuthenticatedTerminalRecord, type JevyrReadiness, type JevyrRecord } from "@jevyr/sdk";
import { main } from "../src/main.js";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI invocation boundary", () => {
  it("documents Cast as one-way and exposes no semantic continuation command", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["--help"])).resolves.toBe(0);
    const help = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(help).toContain("cast once, observe live");
    expect(help).toContain("does not replay persisted evidence");
    expect(help).toContain("no continue or send-message command");
    expect(help).toContain("--force replaces the five portable defaults");
    expect(help).toContain("New policies select Bone v2. Init installs no calibration or private state.");
    expect(help).not.toMatch(/^\s+jevyr (?:continue|send-message|message|input)\b/mu);
  });

  it("rejects malformed explicit local model names before launch", async () => {
    await expect(main(["up", "--local-model", "model name with spaces", "--no-open"]))
      .rejects.toThrow("--local-model must be a bounded Ollama model name");
  });

  it.each([["--help"], ["-h"]])("renders init %s without writing initialization files", async (help) => {
    const root = await mkdtemp(join(repositoryRoot, ".tmp-jevyr-help-"));
    roots.push(root);
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = root;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main(["init", help])).resolves.toBe(0);
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previous;
    }
    expect(output).toHaveBeenCalledWith(expect.stringContaining("jevyr init [directory] [--force]"));
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("preserves the caller directory through the documented root pnpm wrapper", async () => {
    const targetName = `.tmp-jevyr-root-wrapper-${randomUUID()}`;
    const root = join(repositoryRoot, targetName);
    const wrongPackageRoot = join(repositoryRoot, "apps", "cli", targetName);
    roots.push(root, wrongPackageRoot);
    const childEnv = { ...process.env };
    delete childEnv.INIT_CWD;
    const packageManager = process.env.npm_execpath;
    if (!packageManager) throw new Error("pnpm did not expose npm_execpath to the CLI test");

    const { stdout } = await exec(process.execPath, [packageManager, "jevyr", "init", targetName], {
      cwd: repositoryRoot,
      env: childEnv,
      timeout: 30_000,
      windowsHide: true,
    });

    await expect(access(join(root, ".jevyr", "config.json"))).resolves.toBeUndefined();
    await expect(access(join(root, ".jevyr", "policy.json"))).resolves.toBeUndefined();
    expect(stdout).toContain(join(root, ".jevyr", "config.json"));
    await expect(access(join(wrongPackageRoot, ".jevyr", "config.json"))).rejects.toThrow();
  }, 40_000);

  it("doctor consumes sanitized readiness and exits nonzero for incomplete infrastructure", async () => {
    const hash = (character: string) => `sha256:${character.repeat(64)}`;
    const readiness: JevyrReadiness = {
      protocol: "jevyr.readiness/1",
      ready: false,
      scope: "infrastructure",
      observedAt: "2026-09-05T10:00:00.000Z",
      semanticContinuation: false,
      models: {
        status: "template-only",
        mode: "template-only",
        configuredCount: 1,
        availableCount: 1,
        reasoningConfiguredCount: 0,
        reasoningAvailableCount: 0,
        adapters: [{
          id: "mind.rule.v1",
          role: "template",
          configured: true,
          transport: "in-process",
          network: "none",
          probe: { status: "available", observedAt: "2026-09-05T10:00:00.000Z", latencyMs: 0 },
        }],
      },
      forge: {
        id: "tool.forge.observe-only.v1",
        mode: "observe-only",
        configured: true,
        status: "observe-only",
        canExecuteTools: false,
        network: "none",
        probe: { status: "available", observedAt: "2026-09-05T10:00:00.000Z", latencyMs: 0 },
        evidenceAuthority: "none",
        substrate: { status: "not-applicable", immutableImageId: null },
        usable: false,
      },
      assays: {
        status: "empty",
        mode: "empty",
        count: 0,
        ids: [],
        frontierDigest: hash("a"),
        caseApplicability: "case-dependent",
      },
      blockers: [
        {
          code: "models.template-only",
          component: "models",
          detail: "Only RuleMind's deterministic templates are configured; no reasoning model can generate independent candidates.",
        },
        {
          code: "forge.observe-only",
          component: "forge",
          detail: "Forge is observation-only and cannot execute an assay.",
        },
        {
          code: "assays.empty",
          component: "assays",
          detail: "The compile-admitted Assay Frontier is empty; no candidate can enter a configured experiment.",
        },
      ],
    };
    vi.spyOn(JevyrClient.prototype, "readiness").mockResolvedValue(readiness);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main(["doctor", "--json"])).resolves.toBe(3);
    const report = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(report).toMatchObject({
      protocol: "jevyr.doctor/2",
      ready: false,
      daemon: { status: "blocked", readiness: { models: { mode: "template-only" } } },
    });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(report.commands).toHaveProperty("podman");
  });

  it("rejects malformed or oversized Cast files before semantic submission", async () => {
    const root = await mkdtemp(join(repositoryRoot, ".tmp-jevyr-cast-bytes-"));
    roots.push(root);
    const malformed = join(root, "malformed.txt");
    const oversized = join(root, "oversized.txt");
    await writeFile(malformed, Uint8Array.from([0x43, 0x61, 0x73, 0x74, 0x20, 0xc3, 0x28]));
    await writeFile(oversized, Buffer.alloc(1_048_577, 0x61));
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = root;
    try {
      await expect(main(["cast", "--file", malformed])).rejects.toThrow(/not valid UTF-8/u);
      await expect(main(["cast", "--file", oversized])).rejects.toThrow(/exceeds 1048576 bytes/u);
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previous;
    }
  });

  it("watch reports authentication scope and refuses to imply evidence replay", async () => {
    const hash = (character: string) => `sha256:${character.repeat(64)}`;
    const record = {
      caseDigest: hash("1"),
      runDigest: hash("2"),
      verdict: { integrity: "VALID" },
    } as unknown as JevyrRecord;
    const authenticated: AuthenticatedTerminalRecord = {
      payload: record,
      envelope: {
        payloadType: "application/vnd.jevyr.record+json",
        payload: "e30=",
        signatures: [{ keyid: hash("3"), sig: "AA==" }],
      },
      keyId: hash("3"),
      payloadType: "application/vnd.jevyr.record+json",
      verification: "dsse-ed25519",
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
      traceVerification: "event-hash-chain+signed-terminal-head",
      terminal: {
        payload: {
          protocol: "jevyr.terminal/1",
          caseId: "case_abcdefgh",
          caseDigest: hash("1"),
          runDigest: hash("2"),
          lifecycle: "terminated",
          stage: "terminate",
          stageStatus: "completed",
          lastSequence: 1,
          eventHeadDigest: hash("4"),
          recordDigest: hash("5"),
          artifactIndexDigest: hash("6"),
          closedAt: "2026-09-05T00:00:00.000Z",
        },
        envelope: {
          payloadType: "application/vnd.jevyr.terminal+json",
          payload: "e30=",
          signatures: [{ keyid: hash("3"), sig: "AA==" }],
        },
        keyId: hash("3"),
        payloadType: "application/vnd.jevyr.terminal+json",
        verification: "dsse-ed25519",
      },
    };
    vi.spyOn(JevyrClient.prototype, "liveEvents").mockImplementation(async function* () {});
    const waitForAuthenticatedRecord = vi.spyOn(JevyrClient.prototype, "waitForAuthenticatedRecord").mockResolvedValue(authenticated);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main(["watch", "case_abcdefgh", "--json"])).resolves.toBe(0);
    const terminal = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(terminal).toMatchObject({
      type: "record",
      verification: "dsse-ed25519",
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
      traceVerification: "event-hash-chain+signed-terminal-head",
      terminal: {
        verification: "dsse-ed25519",
        keyId: hash("3"),
        receipt: { artifactIndexDigest: hash("6") },
      },
    });
    expect(waitForAuthenticatedRecord).toHaveBeenCalledWith("case_abcdefgh", {
      cursor: 0,
      pollWaitMs: 15_000,
    });
    expect(terminal).not.toHaveProperty("valid", true);

    (record.verdict as { integrity: "VALID" | "INVALID" }).integrity = "INVALID";
    await expect(main(["watch", "case_abcdefgh", "--json"])).resolves.toBe(0);
  });
});
