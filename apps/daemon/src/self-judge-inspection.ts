import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import type { SelfJudgeOffspringRequest } from "./self-judge-proposals.js";

/** Local content-addressed intake, not a governance signature or promotion. */
export async function readSelfJudgeRequests(root: string): Promise<{ requests: SelfJudgeOffspringRequest[]; truncated: boolean }> {
  const directory = join(root, "self-judge-requests");
  let names: string[];
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Self-judgment intake directory is not a plain directory");
    names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { requests: [], truncated: false }; throw error; }
  const requests: SelfJudgeOffspringRequest[] = [];
  for (const name of names.slice(0, 256)) {
    const path = join(directory, name), before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 131_072) throw new Error("Self-judgment intake file is unsafe or oversized");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 131_072 || info.ino !== before.ino || info.dev !== before.dev) throw new Error("Self-judgment intake changed while opening");
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await file.stat();
      if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1) throw new Error("Self-judgment intake changed while reading");
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))) as SelfJudgeOffspringRequest;
      const { digest, ...body } = request;
      if (request.protocol !== "jevyr.self-judge-offspring-request/1" || digest !== `sha256:${name.slice(0, -5)}` || digestJson(body as unknown as JsonValue) !== digest
        || request.activeGenomeChanged !== false || request.governanceSignature !== null || !Array.isArray(request.failures) || request.failures.length > 64) throw new Error("Self-judgment intake content-address mismatch");
      requests.push(request);
    } finally { await file.close(); }
  }
  return { requests, truncated: names.length > 256 };
}
