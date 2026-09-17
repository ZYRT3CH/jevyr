import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestJson, sha256Digest } from "../packages/protocol/dist/index.js";
import { JEVYR_BONE_DIGEST, JEVYR_BONE_V2_DIGEST } from "../packages/core/dist/index.js";
import { investigationImplementationDescriptor, metabolicImplementationDigest, loadRepositoryPureProducerAssetsSync, ORIGINAL_SUBJECT_CERTIFICATE_CHECKER } from "../packages/runtime/dist/index.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push({ path: relative(root, path).replaceAll("\\", "/"), digest: sha256Digest(await readFile(path)) });
    else throw new Error("Compiled method inventory must contain ordinary files and directories");
  }
}
// Include the production presentation bytes in new release checkpoints. The
// per-method descriptors below still bind only their own authority-bearing code.
for (const tree of ["packages/protocol/dist", "packages/core/dist", "packages/core/policy", "packages/sdk/dist", "packages/growth/dist", "packages/memory/dist", "packages/runtime/dist", "apps/daemon/dist", "apps/cli/dist", "apps/chamber/dist/server", "apps/chamber/dist/client"]) await walk(join(root, tree));
files.sort((a,b) => a.path < b.path ? -1 : 1);
const report = { protocol: "jevyr.installed-method-freeze/1", observedAt: new Date().toISOString(), boneV1Digest: JEVYR_BONE_DIGEST, boneV2Digest: JEVYR_BONE_V2_DIGEST,
  investigation: investigationImplementationDescriptor(), metabolism: metabolicImplementationDigest(), originalSubjectChecker: ORIGINAL_SUBJECT_CERTIFICATE_CHECKER,
  producer: loadRepositoryPureProducerAssetsSync().descriptor, filesDigest: digestJson(files), files };
const output = resolve(process.argv[2]);
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report,null,2), { flag: "wx" });
console.log(JSON.stringify({ output, files: files.length, filesDigest: report.filesDigest, investigation: report.investigation.digest, metabolism: report.metabolism, producer: report.producer.digest }));
