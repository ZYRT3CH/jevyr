import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type PublicContribution } from "../packages/runtime/src/index.js";
import { createDaemonRuntime } from "../apps/daemon/src/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { setTimeout as delay } from "node:timers/promises";

// An isolated local UI fixture: delays let a human or browser exercise abort.
class UiMind extends RuleMindAdapter {
  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    await delay(1500, undefined, { signal: request.signal });
    yield* super.run(request);
  }
}
const root = resolve(import.meta.dirname, "..", "artifacts", `airlock-ui-${Date.now()}`);
await mkdir(root, { recursive: true });
const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, "store"), env: {}, minds: [new UiMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
const service = createJevyrHttpService({ runtime, env: {}, allowedOrigins: ["http://localhost:3002", "http://127.0.0.1:3002"] });
console.log(JSON.stringify({ ...await service.listen(4328), root }));
const stop = () => { void service.close().finally(() => process.exit(0)); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
