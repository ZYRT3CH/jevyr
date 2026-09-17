import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseJsonBytes } from "@jevyr/core";
import { createDaemonRuntime, createJevyrHttpService } from "@jevyr/daemon";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { canonicalJson, JevyrClient } from "@jevyr/sdk";
import { canonicalRecordText } from "@jevyr/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { verifyProofBundle, type GithubAdvisoryProvenance } from "../src/bundle.js";
import { allEvents, replayAuthenticatedCase } from "../src/replay.js";
import { verifyLocalProof } from "../src/local-proof.js";

const run = promisify(execFile);
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-proof-bundle-"));
  temporaryRoots.push(root);
  return root;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await run("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-C", repository,
    ...args,
  ], { windowsHide: true });
  return result.stdout.trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function digestFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeManifest(bundle: string, files: readonly string[]): Promise<void> {
  const lines: string[] = [];
  for (const entry of [...files].sort()) {
    lines.push(`${await digestFile(join(bundle, ...entry.split("/")))}  ./${entry}`);
  }
  await writeFile(join(bundle, "MANIFEST.sha256"), `${lines.join("\n")}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("offline proof bundles", () => {
  it("distinguishes internal consistency from external trust and rejects re-manifested provenance", async () => {
    const root = await temporaryRoot();
    const repositoryPath = join(root, "subject");
    await mkdir(repositoryPath);
    const repository = await realpath(repositoryPath);
    await run("git", ["init", repository], { windowsHide: true });
    await writeFile(join(repository, "specimen.txt"), "Jevyr proof specimen.\n", "utf8");
    await git(repository, "add", "--", "specimen.txt");
    await git(
      repository,
      "-c", "user.name=Jevyr Test",
      "-c", "user.email=jevyr@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "-m", "proof specimen",
    );
    const subjectSha = await git(repository, "rev-parse", "--verify", "HEAD^{commit}");

    const dataDir = join(root, "data");
    const runtime = createDaemonRuntime({
      projectRoot: repository,
      dataDir,
      minds: [new RuleMindAdapter()],
      forge: new SealedForgeAdapter({ mode: "observe-only" }),
    });
    const service = createJevyrHttpService({ runtime });
    try {
      const address = await service.listen(0, "127.0.0.1");
      const client = new JevyrClient({ baseUrl: address.url });
      const provenance: GithubAdvisoryProvenance = {
        protocol: "jevyr.github-advisory-provenance/1",
        eventName: "workflow_dispatch",
        workflowSha: "1".repeat(40),
        runtimeRepository: "jevyr/runtime",
        runtimeSha: "2".repeat(40),
        runtimeTreeOid: "3".repeat(40),
        runtimeLockDigest: `sha256:${"4".repeat(64)}`,
        subjectRepository: "owner/specimen",
        subjectSha,
        runId: "9001",
        runAttempt: "1",
        pullRequestNumber: null,
      };
      const accepted = await client.cast({
        protocol: "jevyr.case/1",
        case: {
          impulse: "Discriminate this exact immutable repository as an archival specimen.",
          mode: "audit",
          privacy: "local_only",
          control: "sovereign",
          subjects: [
            { id: "subject-1", kind: "git", locator: repository, revision: subjectSha },
            { id: "subject-2", kind: "text", locator: canonicalJson(provenance) },
          ],
        },
      });
      const authenticated = await client.waitForAuthenticatedRecord(accepted.caseId, {
        preferSse: false,
        pollWaitMs: 50,
        reconnectDelayMs: 10,
        maxReconnectDelayMs: 50,
      });
      const preReplayStatus = await client.status(accepted.caseId);
      if (preReplayStatus.lifecycle === "invalid") {
        const invalidEvents = await allEvents(client, accepted.caseId);
        const failure = [...invalidEvents].reverse().find((event) =>
          event.kind === "stage.status" && event.payload.status === "failed"
        );
        throw new Error(`Proof fixture became invalid: ${failure?.payload.summary ?? "unknown runtime failure"}`);
      }
      const [seal, sealEnvelope, recordEnvelope, terminal, terminalEnvelope, trust, intentContract, policyDescriptor, status, artifactIndex, events] = await Promise.all([
        client.sealReceipt(accepted.caseId),
        client.sealEnvelope(accepted.caseId),
        client.recordEnvelope(accepted.caseId),
        client.terminalReceipt(accepted.caseId),
        client.terminalEnvelope(accepted.caseId),
        client.trustBundle(),
        client.intentContract(accepted.caseId),
        client.policyDescriptor(accepted.caseId),
        client.status(accepted.caseId),
        client.artifactList(accepted.caseId),
        allEvents(client, accepted.caseId),
      ]);
      const replay = await replayAuthenticatedCase(client, accepted.caseId, authenticated.payload);
      expect(replay.valid).toBe(true);
      const sealed = parseJsonBytes(
        await readFile(join(dataDir, "cases", accepted.caseId, "sealed.json")),
        "Persisted SealedCase test fixture",
      );

      const bundle = join(root, "bundle");
      await mkdir(join(bundle, "artifacts"), { recursive: true });
      const rootDocuments: Readonly<Record<string, unknown>> = {
        "events.json": events,
        "intent-contract.json": intentContract,
        "policy-descriptor.json": policyDescriptor,
        "record.dsse.json": recordEnvelope,
        "record.json": authenticated.payload,
        "replay.json": {
          ...replay,
          authenticity: { verification: "dsse-ed25519", keyId: authenticated.keyId },
        },
        "seal.dsse.json": sealEnvelope,
        "seal.json": seal,
        "sealed.json": sealed,
        "status.json": status,
        "terminal.dsse.json": terminalEnvelope,
        "terminal.json": terminal,
        "trust.json": trust,
      };
      for (const [name, value] of Object.entries(rootDocuments)) {
        await writeJson(join(bundle, name), value);
      }
      await writeFile(join(bundle, "runtime-provenance.json"), canonicalJson(provenance), {
        encoding: "utf8",
        flag: "wx",
      });
      await writeJson(join(bundle, "artifacts", "index.json"), artifactIndex);
      for (const meta of artifactIndex.artifacts) {
        const artifact = await client.fetchArtifact(accepted.caseId, meta.id);
        await writeFile(join(bundle, "artifacts", `${meta.id}.blob`), artifact.data, { flag: "wx" });
      }
      const files = [
        ...Object.keys(rootDocuments),
        "runtime-provenance.json",
        "artifacts/index.json",
        ...artifactIndex.artifacts.map((meta) => `artifacts/${meta.id}.blob`),
      ];
      await writeManifest(bundle, files);

      const localProof = join(root, "local-proof");
      await mkdir(join(localProof, "artifacts"), { recursive: true });
      const localNames: Record<string, string> = {
        "seal.json": "seal-receipt.json", "terminal.json": "terminal-receipt.json",
      };
      for (const name of ["events.json", "intent-contract.json", "policy-descriptor.json", "record.dsse.json", "record.json", "seal.dsse.json", "seal.json", "terminal.dsse.json", "terminal.json", "trust.json"]) {
        await writeFile(join(localProof, localNames[name] ?? name), await readFile(join(bundle, name)));
      }
      await writeFile(join(localProof, "sealed-case.json"), await readFile(join(bundle, "sealed.json")));
      await writeJson(join(localProof, "artifact-index.json"), artifactIndex);
      await writeFile(join(localProof, "canonical-record.json"), canonicalRecordText(authenticated.payload));
      await writeJson(join(localProof, "run-attestations.json"), await client.runAttestations(accepted.caseId));
      for (const meta of artifactIndex.artifacts) await writeFile(join(localProof, "artifacts", `${meta.id}.blob`), await readFile(join(bundle, "artifacts", `${meta.id}.blob`)));
      expect(await verifyLocalProof(localProof, authenticated.keyId)).toMatchObject({ valid: true, trustScope: "externally-pinned-key", caseId: accepted.caseId });
      expect(await verifyLocalProof(localProof, `sha256:${"0".repeat(64)}`)).toMatchObject({ valid: false });
      await writeFile(join(localProof, "record.json"), JSON.stringify({ ...authenticated.payload, runDigest: `sha256:${"0".repeat(64)}` }));
      expect(await verifyLocalProof(localProof, authenticated.keyId)).toMatchObject({ valid: false });

      const internallyConsistent = await verifyProofBundle(bundle);
      expect(internallyConsistent).toMatchObject({
        valid: false,
        integrityValid: true,
        caseId: accepted.caseId,
        trust: {
          anchored: false,
          keyId: authenticated.keyId,
          scope: "bundle-declared-key",
        },
        problems: [],
      });
      const anchored = await verifyProofBundle(bundle, {
        trustedKeyId: authenticated.keyId,
        expectedRuntimeSha: provenance.runtimeSha,
        expectedSubjectSha: subjectSha,
        expectedWorkflowSha: provenance.workflowSha,
      });
      expect(anchored).toMatchObject({
        valid: true,
        integrityValid: true,
        trust: { anchored: true, scope: "externally-pinned-key" },
        problems: [],
      });
      const wrongAnchor = await verifyProofBundle(bundle, {
        trustedKeyId: `sha256:${"f".repeat(64)}`,
      });
      expect(wrongAnchor).toMatchObject({
        valid: false,
        integrityValid: true,
        trust: { anchored: false, scope: "bundle-declared-key" },
      });
      expect(wrongAnchor.problems).toEqual([
        `Authenticated key ${authenticated.keyId} does not match the externally trusted key`,
      ]);

      const truncatedEvents = events.slice(0, -1);
      const truncatedTail = truncatedEvents.at(-1);
      expect(truncatedTail).toBeDefined();
      const reauthoredStatus = {
        ...status,
        stage: truncatedTail!.stage,
        stageStatus: truncatedTail!.kind === "stage.status"
          ? truncatedTail!.payload.status
          : status.stageStatus,
        lastSequence: truncatedTail!.sequence,
        headDigest: truncatedTail!.eventDigest,
        updatedAt: truncatedTail!.observedAt,
      };
      await writeFile(join(bundle, "events.json"), `${JSON.stringify(truncatedEvents, null, 2)}\n`, "utf8");
      await writeFile(join(bundle, "status.json"), `${JSON.stringify(reauthoredStatus, null, 2)}\n`, "utf8");
      await writeManifest(bundle, files);
      const reauthoredTail = await verifyProofBundle(bundle, { trustedKeyId: authenticated.keyId });
      expect(reauthoredTail.valid).toBe(false);
      expect(reauthoredTail.integrityValid).toBe(false);
      expect(reauthoredTail.problems).toEqual([
        "Authenticated terminal closure does not equal the Record, artifact index, terminal status, and final event",
      ]);
      await writeFile(join(bundle, "events.json"), `${JSON.stringify(events, null, 2)}\n`, "utf8");
      await writeFile(join(bundle, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");

      const injectedBytes = Buffer.from("manifested but not signed into the terminal artifact inventory", "utf8");
      const injectedDigest = `sha256:${createHash("sha256").update(injectedBytes).digest("hex")}`;
      const injectedId = `artifact_${injectedDigest.slice("sha256:".length, "sha256:".length + 24)}`;
      const injectedMeta = {
        protocol: "jevyr.artifact/1" as const,
        id: injectedId,
        caseId: accepted.caseId,
        name: "injected.txt",
        mediaType: "text/plain",
        size: injectedBytes.byteLength,
        digest: injectedDigest,
        createdAt: terminal.closedAt,
      };
      const injectedIndex = {
        ...artifactIndex,
        artifacts: [...artifactIndex.artifacts, injectedMeta].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      };
      const injectedPath = `artifacts/${injectedId}.blob`;
      await writeFile(join(bundle, "artifacts", "index.json"), `${JSON.stringify(injectedIndex, null, 2)}\n`, "utf8");
      await writeFile(join(bundle, "artifacts", `${injectedId}.blob`), injectedBytes, { flag: "wx" });
      await writeManifest(bundle, [...files, injectedPath]);
      const injected = await verifyProofBundle(bundle, { trustedKeyId: authenticated.keyId });
      expect(injected.valid).toBe(false);
      expect(injected.integrityValid).toBe(false);
      expect(injected.problems).toEqual([
        "Authenticated terminal closure does not equal the Record, artifact index, terminal status, and final event",
      ]);
      await rm(join(bundle, "artifacts", `${injectedId}.blob`));
      await writeFile(join(bundle, "artifacts", "index.json"), `${JSON.stringify(artifactIndex, null, 2)}\n`, "utf8");

      const forgedProvenance = { ...provenance, subjectRepository: "forged/specimen" };
      await writeFile(join(bundle, "runtime-provenance.json"), canonicalJson(forgedProvenance), "utf8");
      await writeManifest(bundle, files);
      const forged = await verifyProofBundle(bundle, { trustedKeyId: authenticated.keyId });
      expect(forged.valid).toBe(false);
      expect(forged.integrityValid).toBe(false);
      expect(forged.problems).toEqual([
        "Authenticated SealedCase does not bind the exact Git subject and runtime provenance",
      ]);
    } finally {
      await service.close();
    }
  }, 60_000);
});
