import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestJson } from "@jevyr/protocol";
import {
  CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL,
  CaseRepository,
  SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
  type CaseSubjectMaterialBindingEnvelope,
} from "../src/index.js";

async function withRepository(
  prefix: string,
  run: (root: string, repository: CaseRepository) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root, new CaseRepository(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CaseRepository persists and signs an immutable subject-material commitment before status", async () => {
  await withRepository("jevyr-repository-material-", async (root, repository) => {
    const source = join(root, "subject.txt");
    await writeFile(source, "captured before Seal", "utf8");
    const status = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Judge the captured bytes.", subjects: [{ id: "source", kind: "file", locator: source }] },
    });

    const stored = JSON.parse(await readFile(
      join(root, "cases", status.caseId, "subject-materials.json"),
      "utf8",
    )) as CaseSubjectMaterialBindingEnvelope;
    assert.equal(stored.protocol, CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL);
    assert.equal(stored.captureDigest, status.sealed.subjectMaterialCaptureDigest);
    assert.equal(status.receipt.subjectMaterialCaptureDigest, stored.captureDigest);
    assert.equal(
      stored.captureDigest,
      digestJson({ protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL, bindings: stored.bindings }),
    );

    await writeFile(source, "mutated after Seal", "utf8");
    const capture = await repository.loadSubjectMaterialCapture(status.caseId);
    assert.equal(capture.captureDigest, stored.captureDigest);
    assert.equal((await repository.projectSubjectText(status.caseId)).files[0]?.text, "captured before Seal");
  });
});

test("concurrent repository initialization converges on one signing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-repository-key-race-"));
  try {
    const repositories = Array.from({ length: 24 }, () => new CaseRepository(root));
    const bundles = await Promise.all(repositories.map(async (repository) => await repository.publicTrustBundle()));
    const identities = new Set(bundles.map((bundle) => {
      const key = bundle.keys[0];
      return `${key?.keyId}\u0000${key?.publicKeyPem}`;
    }));
    assert.equal(identities.size, 1);
    assert.equal(bundles.every((bundle) => bundle.keys.length === 1), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent identical artifact commits converge on one immutable metadata winner", async () => {
  await withRepository("jevyr-repository-artifact-race-", async (_root, repository) => {
    const status = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Commit identical evidence concurrently." },
    });
    const bytes = Buffer.from("one content address", "utf8");
    const results = await Promise.all(Array.from({ length: 24 }, async (_entry, index) =>
      await repository.putArtifact(
        status.caseId,
        `concurrent-${index}.txt`,
        index % 2 === 0 ? "text/plain" : "application/octet-stream",
        bytes,
      )));

    assert.equal(new Set(results.map((entry) => JSON.stringify(entry))).size, 1);
    assert.deepEqual(await repository.artifacts(status.caseId), [results[0]]);
    assert.deepEqual((await repository.artifact(status.caseId, results[0]!.id))?.data, bytes);
  });
});

test("atomic status publication remains readable under continuous polling", async () => {
  await withRepository("jevyr-repository-status-poll-", async (_root, repository) => {
    const created = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Keep status replacement atomic under observer pressure." },
    });
    let polling = true;
    const observed: string[] = [];
    const readers = Array.from({ length: 8 }, async () => {
      while (polling) {
        const status = await repository.status(created.caseId);
        assert.ok(status);
        observed.push(status.updatedAt);
      }
    });
    try {
      for (let index = 0; index < 64; index += 1) {
        await repository.updateStatus(created.caseId, {
          lifecycle: "queued",
          stage: "seal",
          stageStatus: "completed",
          lastSequence: 0,
          headDigest: null,
        });
      }
    } finally {
      polling = false;
      await Promise.all(readers);
    }
    assert.ok(observed.length > 0);
    assert.equal((await repository.status(created.caseId))?.lifecycle, "queued");
  });
});

test("CaseRepository rejects missing binding state and corrupted CAS bytes", async () => {
  await withRepository("jevyr-repository-material-tamper-", async (root, repository) => {
    const first = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Keep an empty material commitment." },
    });
    await unlink(join(root, "cases", first.caseId, "subject-materials.json"));
    await assert.rejects(repository.loadSubjectMaterialCapture(first.caseId), /refusing a pre-capture downgrade/);
    await assert.rejects(repository.statuses(), /refusing a pre-capture downgrade/);

    const source = join(root, "second.txt");
    await writeFile(source, "trusted", "utf8");
    const second = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Rehash before use.", subjects: [{ id: "source", kind: "file", locator: source }] },
    });
    const binding = (await repository.loadSubjectMaterialCapture(second.caseId)).bindings[0];
    if (!binding) throw new Error("fixture did not capture a binding");
    const envelopePath = join(root, "cases", second.caseId, "subject-materials.json");
    const originalEnvelope = await readFile(envelopePath, "utf8");
    const envelopeWithUnknownAuthority = {
      ...(JSON.parse(originalEnvelope) as Record<string, unknown>),
      trustedByModel: true,
    };
    await writeFile(envelopePath, `${JSON.stringify(envelopeWithUnknownAuthority)}\n`, "utf8");
    await assert.rejects(repository.loadSubjectMaterialCapture(second.caseId), /missing or unknown fields/);
    await writeFile(envelopePath, originalEnvelope, "utf8");
    const manifestPath = join(root, "subject-materials", "manifests", binding.manifestDigest.slice("sha256:".length));
    await writeFile(manifestPath, "{}", "utf8");
    await assert.rejects(repository.loadSubjectMaterialCapture(second.caseId), /CAS address .* mismatched bytes/);
  });
});

test("remote declaration-only material remains explicit and cryptographically bound", async () => {
  await withRepository("jevyr-repository-material-declaration-", async (_root, repository) => {
    const status = await repository.create({
      protocol: "jevyr.case/1",
      case: {
        impulse: "Assess this declaration without fetching it.",
        subjects: [{ id: "remote", kind: "git", locator: "https://example.invalid/private.git", revision: "main" }],
      },
    });
    const capture = await repository.loadSubjectMaterialCapture(status.caseId);
    assert.equal(capture.bindings[0]?.availability, "DECLARATION_ONLY");
    const projection = await repository.projectSubjectText(status.caseId);
    assert.equal(projection.files.length, 0);
    assert.equal(projection.omissions[0]?.reason, "DECLARATION_ONLY");
    assert.equal(projection.omissions[0]?.policyReason, "REMOTE_DECLARATION");
  });
});

test("CaseRepository rehashes content-addressed artifacts on every read and listing", async () => {
  await withRepository("jevyr-repository-artifact-integrity-", async (root, repository) => {
    const status = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Keep evidence recoverable." },
    });
    const bytes = Buffer.from("canonical evidence", "utf8");
    const stored = await repository.putArtifact(
      status.caseId,
      "evidence.json",
      "application/json",
      bytes,
    );
    const duplicate = await repository.putArtifact(
      status.caseId,
      "renamed.json",
      "application/octet-stream",
      bytes,
    );
    assert.deepEqual(duplicate, stored, "content identity preserves the first immutable metadata");
    assert.deepEqual((await repository.artifact(status.caseId, stored.id))?.data, bytes);
    assert.deepEqual(await repository.artifacts(status.caseId), [stored]);

    const artifactRoot = join(root, "cases", status.caseId, "artifacts");
    const blobPath = join(artifactRoot, `${stored.id}.blob`);
    await writeFile(blobPath, "tampered", "utf8");
    await assert.rejects(
      repository.artifact(status.caseId, stored.id),
      /failed content-address verification/,
    );
    await assert.rejects(repository.artifacts(status.caseId), /failed content-address verification/);

    await writeFile(blobPath, bytes);
    const metaPath = join(artifactRoot, `${stored.id}.json`);
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    await writeFile(metaPath, `${JSON.stringify({ ...metadata, assertedByCandidate: true })}\n`, "utf8");
    await assert.rejects(repository.artifact(status.caseId, stored.id), /missing or unknown fields/);
  });
});

test("CaseRepository rejects ambiguous or malformed UTF-8 artifact metadata before returning evidence", async () => {
  await withRepository("jevyr-repository-artifact-json-", async (root, repository) => {
    const status = await repository.create({
      protocol: "jevyr.case/1",
      case: { impulse: "Artifact metadata bytes cannot redefine authority." },
    });
    const stored = await repository.putArtifact(
      status.caseId,
      "hostile-byte.json",
      "application/json",
      Buffer.from("{}", "utf8"),
    );
    const metaPath = join(root, "cases", status.caseId, "artifacts", `${stored.id}.json`);
    const original = await readFile(metaPath, "utf8");
    const duplicate = original.replace(
      `  "digest": "${stored.digest}",`,
      `  "digest": "sha256:${"0".repeat(64)}",\n  "digest": "${stored.digest}",`,
    );
    assert.notEqual(duplicate, original);
    await writeFile(metaPath, duplicate, "utf8");
    await assert.rejects(repository.artifact(status.caseId, stored.id), /duplicate object key "digest"/u);

    const malformed = Buffer.from(original, "utf8");
    const marker = malformed.indexOf("hostile-byte.json");
    assert.ok(marker >= 0);
    malformed[marker] = 0xff;
    await writeFile(metaPath, malformed);
    await assert.rejects(repository.artifact(status.caseId, stored.id), /not valid UTF-8/u);
  });
});
