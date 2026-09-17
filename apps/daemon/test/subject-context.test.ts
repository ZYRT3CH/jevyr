import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { test } from "node:test";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type CapabilityCard } from "@jevyr/runtime";
import { executeInvestigatorTool } from "../../../packages/runtime/src/investigator-tools.js";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("ordinary and nursery investigators can inspect sealed text beyond the initial prompt while live edits and secret files remain excluded", async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-context-integration-")), sourceRoot = join(root, "subject");
  await mkdir(sourceRoot);
  const source = 'export const capturedValue = "before-seal";\n' + '// large but finite source line\n'.repeat(5000);
  await writeFile(join(sourceRoot, "README.md"), "A captured source fixture.\n");
  await writeFile(join(sourceRoot, "z-large-module.mjs"), source);
  await writeFile(join(sourceRoot, "source.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { capturedValue } from "./z-large-module.mjs";\ntest("captured source", () => assert.equal(capturedValue, "before-seal"));\n');
  await writeFile(join(sourceRoot, ".env"), "TEST_PRIVATE_VALUE=never_disclose_this_fixture\n");
  const inspected = new Set<string>();
  let changedLiveSource = false;
  class InspectingMind extends RuleMindAdapter {
    override readonly capability: CapabilityCard = { ...new RuleMindAdapter().capability, limits: { adapterClass: "model" } };
    override async runMetered(request: MindRequest) {
      assert.ok(request.subjectContext);
      assert.equal(request.subjectProjection?.files.some(file => file.path === "z-large-module.mjs"), false);
      const listed = await executeInvestigatorTool(request, "list_subject_files", "{}");
      assert.equal(listed.receipt.status, "observed"); assert.deepEqual(listed.receipt.sourceDigests, []);
      const catalog = JSON.parse(listed.content);
      assert.equal(catalog.files.some((file: { path: string }) => file.path === ".env"), false);
      const large = catalog.files.find((file: { path: string }) => file.path === "z-large-module.mjs");
      assert.ok(large);
      const tests = await executeInvestigatorTool(request, "list_repository_tests", "{}");
      const discovered = JSON.parse(tests.content);
      assert.equal(discovered.availability, "DISCOVERY_INVENTORY");
      assert.equal(discovered.files[0].path, "source.test.mjs");
      assert.equal(discovered.files[0].executionStatus, "NOT_ESTABLISHED_BY_DISCOVERY");
      assert.ok(discovered.files[0].refusals.some((refusal: { code: string }) => refusal.code === "TRUSTED_RUNNER_UNAVAILABLE"));
      assert.deepEqual(tests.receipt.sourceDigests, [], "a discovered test name does not count as source inspection or a test execution");
      if (!changedLiveSource) { await writeFile(join(sourceRoot, "z-large-module.mjs"), "human change after sealing\n"); changedLiveSource = true; }
      const observed = await executeInvestigatorTool(request, "read_subject_lines", JSON.stringify({ fileId: large.fileId, startLine: 1, endLine: 1 }));
      assert.equal(observed.receipt.status, "observed"); assert.deepEqual(observed.receipt.sourceDigests, [large.sourceDigest]);
      assert.equal(JSON.parse(observed.content).text, 'export const capturedValue = "before-seal";');
      inspected.add(request.stage);
      return super.runMetered(request);
    }
  }
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new InspectingMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const draft = await client.createDraft({ case: { impulse: "Inspect the captured repository and propose a finite probe", subjects: [{ id: "source", kind: "directory", locator: sourceRoot }], privacy: "local_only", control: "sovereign" } });
    const receipt = (await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest)).receipt!;
    const signed = await client.waitForAuthenticatedRecord(receipt.caseId);
    assert.equal(signed.payload.verdict.integrity, "VALID");
    assert.ok(inspected.has("interpret")); assert.ok(inspected.has("diverge"));
    assert.equal(await readFile(join(sourceRoot, "z-large-module.mjs"), "utf8"), "human change after sealing\n");
    const catalogArtifact = (await client.artifactList(receipt.caseId)).artifacts.find(artifact => artifact.mediaType === "application/vnd.jevyr.subject-context-catalogs+json");
    assert.ok(catalogArtifact);
    const catalogBytes = await client.fetchArtifact(receipt.caseId, catalogArtifact.id);
    const catalogText = new TextDecoder().decode(catalogBytes.data);
    assert.equal(catalogText.includes("never_disclose_this_fixture"), false);
    assert.equal(JSON.parse(catalogText).authority, "context-only");
    const events = await runtime.events.read(receipt.caseId);
    assert.ok(events.some(event => event.kind === "action.status" && event.payload.actionType === "investigation.subject-context" && event.payload.artifactDigests?.includes(catalogArtifact.digest)));
    assert.equal(events.some(event => event.kind === "evidence.observed" && JSON.stringify(event.payload).includes(catalogArtifact.digest)), false);
    const discoveryArtifact = (await client.artifactList(receipt.caseId)).artifacts.find(artifact => artifact.mediaType === "application/vnd.jevyr.repository-evaluation-plan+json");
    assert.ok(discoveryArtifact);
    const discovery = JSON.parse(new TextDecoder().decode((await client.fetchArtifact(receipt.caseId, discoveryArtifact.id)).data));
    assert.equal(discovery.target, "sealed-original-subject");
    assert.equal(discovery.coverage.discoveredTestFiles, 1);
    assert.equal(discovery.status, "unavailable");
    assert.equal(events.some(event => event.kind === "evidence.observed" && JSON.stringify(event.payload).includes(discoveryArtifact.digest)), false);
  } finally {
    await service.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("judge-context-integration-")); await rm(root, { recursive: true, force: true });
  }
});

for (const privacy of ["provider_scoped", "full_case"] as const) test(`sealed ${privacy} controls the new catalog and initial projection together for a remote mind`, async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-context-privacy-"));
  await writeFile(join(root, "subject.txt"), "Only explicit full-case disclosure may send this material.\n");
  let calls = 0;
  class RemoteMind extends RuleMindAdapter {
    override readonly capability: CapabilityCard = { ...new RuleMindAdapter().capability, id: "mind.remote-fixture", network: "provider", transport: "http", trust: "inner", limits: { adapterClass: "model" } };
    override async runMetered(request: MindRequest) {
      calls++; assert.equal(Boolean(request.subjectContext), privacy === "full_case"); assert.equal(Boolean(request.subjectProjection), privacy === "full_case");
      const tests = await executeInvestigatorTool(request, "list_repository_tests", "{}");
      assert.equal(JSON.parse(tests.content).availability, "UNAVAILABLE_OR_WITHHELD");
      assert.equal((request.preparedPublicPrompt ?? "").includes("Only explicit full-case"), false);
      return super.runMetered(request);
    }
  }
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new RemoteMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const draft = await client.createDraft({ case: { impulse: "Inspect the material", subjects: [{ id: "source", kind: "file", locator: join(root, "subject.txt") }], privacy, control: "sovereign" } });
    const receipt = (await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest)).receipt!;
    const record = await client.waitForAuthenticatedRecord(receipt.caseId);
    assert.ok(calls > 0); assert.equal(record.payload.verdict.integrity, "VALID");
  } finally {
    await service.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("judge-context-privacy-")); await rm(root, { recursive: true, force: true });
  }
});
