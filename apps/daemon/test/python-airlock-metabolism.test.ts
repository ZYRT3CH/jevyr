import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
const exec = promisify(execFile);

test("Python SDK creates, edits, seals and reads calibrated-only offers over real HTTP before nonresumable abort", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jevyr-python-airlock-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class WaitingMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      if (request.stage === "interpret") await gate;
      yield* super.run(request);
    }
  }
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: [new WaitingMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0);
    const pythonRoot = fileURLToPath(new URL("../../../sdk/python", import.meta.url));
    const source = `import json,sys
from jevyr import JevyrClient, JevyrHttpError
c=JevyrClient(sys.argv[1])
d=c.create_draft({"case":{"impulse":"Investigate a finite counter", "control":"juggler", "seed":"ab"*32}})
assert d["state"]=="DRAFT" and d["revision"]==1
d=c.replace_draft(d["draftId"],d["revision"],d["submission"])
assert d["revision"]==2
assert c.draft(d["draftId"])["submissionDigest"]==d["submissionDigest"]
d=c.seal_draft(d["draftId"],d["revision"],d["startup"]["policyDigest"])
assert d["state"]=="SEALED"
offers=c.metabolism_offers(d["receipt"]["caseId"])
assert offers["offers"]==[] and offers["receipts"]==[]
try:
 c.replace_draft(d["draftId"],d["revision"],d["submission"])
 raise AssertionError("sealed draft accepted edit")
except JevyrHttpError as error:
 assert error.status==409
stopped=c.abort(d["receipt"]["caseId"])
assert stopped["outcome"]=="INVALID" and stopped["resumable"] is False
print(json.dumps({"caseId":stopped["caseId"],"revision":d["revision"],"offers":len(offers["offers"]),"outcome":stopped["outcome"]}))
`;
    const result = await exec("python", ["-c", source, url], { cwd: pythonRoot, env: { ...process.env, PYTHONPATH: pythonRoot }, windowsHide: true, timeout: 30_000, maxBuffer: 1048576 });
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.revision, 2); assert.equal(observed.offers, 0); assert.equal(observed.outcome, "INVALID");
    release(); await runtime.orchestrator.waitForTerminal(observed.caseId);
    const record = await runtime.repository.record(observed.caseId);
    assert.equal(record?.verdict.integrity, "INVALID");
  } finally { release(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
