import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Digest } from "@jevyr/protocol";
import { decodeRepositoryPureProducerImplementation, decodeRepositoryPureProducerRequest, deriveRepositoryPureProducerPackageDescriptor,
  pureProducerBytes, pureProducerPath, reconstructRepositoryPureProducerResult, REPOSITORY_PURE_PRODUCER_LIMITS, type RepositoryPureProducerPackageDescriptor } from "./repository-pure-producer-data.js";

// Bundled trusted entrypoint. Every submitted byte remains data. There are no
// subject-controlled import specifiers, CLI arguments or environment loaders.
async function readBounded(path: string, maximum: number, exactSize?: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || exactSize !== undefined && before.size !== exactSize || (before.mode & 0o222) !== 0) throw new Error("plain readonly file required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const elected = await handle.stat(); if (elected.dev !== before.dev || elected.ino !== before.ino || elected.size !== before.size || elected.nlink !== 1) throw new Error("file changed");
    const output = Buffer.alloc(before.size + 1); let used = 0;
    while (used < output.length) { const next = await handle.read(output, used, output.length - used, used); if (!next.bytesRead) break; used += next.bytesRead; }
    const after = await handle.stat(); if (used !== before.size || after.size !== before.size || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino) throw new Error("file changed");
    return output.subarray(0, used);
  } finally { await handle.close(); }
}
async function checkInventory(subjectRoot: string, descriptor: RepositoryPureProducerPackageDescriptor): Promise<void> {
  const expected = new Map(descriptor.entries.map(entry => [entry.path, entry])), found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory ? join(subjectRoot, ...directory.split("/")) : subjectRoot, { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!pureProducerPath(path) || found.size >= REPOSITORY_PURE_PRODUCER_LIMITS.maxEntries) throw new Error("inventory bound");
      const expectedEntry = expected.get(path), absolute = join(subjectRoot, ...path.split("/")), info = await lstat(absolute);
      if (!expectedEntry || info.isSymbolicLink()) throw new Error("unexpected material"); found.add(path);
      if (expectedEntry.type === "directory") { if (!info.isDirectory()) throw new Error("directory required"); await walk(path); }
      else {
        const bytes = await readBounded(absolute, expectedEntry.byteLength, expectedEntry.byteLength);
        if (sha256Digest(bytes) !== expectedEntry.digest) throw new Error("material digest changed");
      }
    }
  };
  await walk(""); if (found.size !== expected.size) throw new Error("missing material");
}
try {
  if (process.argv.length !== 2 || Number(process.versions.node.split(".")[0]) !== 24) throw new Error("fixed invocation required");
  const root = dirname(fileURLToPath(import.meta.url)); if (basename(root) !== "repository-pure") throw new Error("fixed package root required");
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("plain package root required");
  const implementation = decodeRepositoryPureProducerImplementation(await readBounded(join(root, "implementation.json"), REPOSITORY_PURE_PRODUCER_LIMITS.maxManifestBytes));
  const request = decodeRepositoryPureProducerRequest(await readBounded(join(root, "request.json"), REPOSITORY_PURE_PRODUCER_LIMITS.maxRequestBytes), implementation);
  const descriptor = deriveRepositoryPureProducerPackageDescriptor(implementation, request);
  await checkInventory(dirname(root), descriptor);
  const result = await reconstructRepositoryPureProducerResult(request, file => readBounded(join(root, ...file.path.split("/")), file.byteLength, file.byteLength));
  await checkInventory(dirname(root), descriptor);
  const bytes = pureProducerBytes(result);
  if (bytes.length > REPOSITORY_PURE_PRODUCER_LIMITS.maxResultBytes) throw new Error("output bound");
  process.stdout.write(Buffer.concat([bytes, Buffer.from("\n")]));
} catch {
  process.stderr.write("Pure producer refused invalid or unavailable package\n"); process.exitCode = 2;
}
