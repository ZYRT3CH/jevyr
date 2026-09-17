import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

// A build-only override supports isolated packaging tests. No Case data, URL,
// provider output or daemon request can choose this installation directory.
const directory = process.argv[2] === undefined ? fileURLToPath(new URL("../dist/", import.meta.url)) : resolve(process.argv[2]);
if (!isAbsolute(directory) || process.argv.length > 3) throw new Error("A single local compiled runtime directory is required");
const { createRepositoryPureProducerAssets, repositoryPureProducerInstallationFiles } = await import(pathToFileURL(join(directory, "repository-pure-producer.js")).href);
const assets = await createRepositoryPureProducerAssets(), files = repositoryPureProducerInstallationFiles(assets);
const destination = join(directory, "repository-pure-assets"), temporary = await mkdtemp(join(directory, ".repository-pure-assets-"));
const pinTemporary = join(directory, `.repository-pure-assets-pin-${randomUUID()}.js`);
// Every removal remains inside this explicit compiled output directory.
const checked = path => { if (dirname(resolve(path)) !== resolve(directory)) throw new Error("Producer build target escaped compiled output"); return path; };
try {
  for (const file of files) {
    if (!/^[A-Za-z0-9._/-]+$/u.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Producer installation path refused");
    const target = join(temporary, ...file.path.split("/")); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.bytes, { flag: "wx" });
    const actual = await readFile(target); if (!actual.equals(Buffer.from(file.bytes))) throw new Error("Producer installation bytes changed during build");
  }
  await rm(checked(destination), { recursive: true, force: true }); await rename(checked(temporary), destination);
  const pinPath = join(directory, "repository-pure-assets-pin.js");
  await writeFile(pinTemporary, `// Generated at build; trusted installed-code pin, never a Case-supplied hash.\nexport const BUILT_REPOSITORY_PURE_PRODUCER_DESCRIPTOR_DIGEST = ${JSON.stringify(assets.descriptor.digest)};\n`, { flag: "wx" });
  await rename(checked(pinTemporary), pinPath);
  const manifest = await readFile(join(destination, "implementation.json"));
  process.stdout.write(JSON.stringify({ protocol: "jevyr.repository-pure-producer-build/1", descriptorDigest: assets.descriptor.digest,
    installedManifestDigest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`, files: files.length }) + "\n");
} finally { await rm(checked(temporary), { recursive: true, force: true }); await rm(checked(pinTemporary), { force: true }); }
