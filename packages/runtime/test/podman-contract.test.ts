import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { buildDockerForgeCreateArguments, parseOciImageInspection, parsePodmanRootlessInspection, sealDockerSubstrateIdentity, SealedForgeAdapter } from "../src/forge.js";
import { sealedDockerForgeAuthority } from "../src/forge-authority.js";

const image = `sha256:${"a".repeat(64)}`;
const reference = "local/jevyr:sealed";
const descriptor = (engine: "docker" | "podman", resolutionAuthority: string = `local-${engine}-cli`) => ({ protocol: "jevyr.policy-descriptor/1", policy: {
  protocol: "jevyr.effective-policy/1", effectiveForgeConfig: { mode: "docker", dockerImage: reference, dockerCommand: engine },
  forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: reference, immutableImageId: image, resolutionAuthority, status: "resolved", failure: null },
} });

test("Podman full bare image IDs normalize without accepting Docker bare IDs, abbreviations, or ambiguous output", () => {
  assert.equal(parseOciImageInspection(JSON.stringify(image.slice(7)), "podman"), image);
  assert.equal(parseOciImageInspection(JSON.stringify(image), "podman"), image);
  assert.equal(parseOciImageInspection(JSON.stringify(image.slice(7)), "docker"), undefined);
  for (const invalid of [JSON.stringify("a".repeat(12)), JSON.stringify("A".repeat(64)), image.slice(7), `${JSON.stringify(image)}\n${JSON.stringify(image)}`]) assert.equal(parseOciImageInspection(invalid, "podman"), undefined);
});

test("Podman disables unmetered automatic tmpfs while retaining exclusive read-only and writable bind mounts", () => {
  const input = { subjectRoot: resolve("podman-subject"), writableRoot: resolve("podman-writable"), image, command: "node", args: ["check.mjs"], allowNetwork: false, memoryMb: 512, cpus: 1, pidsLimit: 32, userId: 1000, groupId: 1000 };
  const podman = buildDockerForgeCreateArguments({ ...input, engine: "podman", podmanRootless: true });
  const docker = buildDockerForgeCreateArguments({ ...input, engine: "docker" });
  assert.ok(podman.includes("--read-only-tmpfs=false"));
  assert.equal(docker.includes("--read-only-tmpfs=false"), false);
  assert.ok(podman.includes("--read-only"));
  assert.equal(podman[podman.indexOf("--network") + 1], "none");
  assert.equal(podman[podman.indexOf("--pull") + 1], "never");
  assert.equal(podman[podman.indexOf("--user") + 1], "1000:1000");
  assert.equal(podman[podman.indexOf("--userns") + 1], "keep-id:uid=1000,gid=1000");
  assert.equal(podman.filter((arg) => arg === "--volume").length, 4);
  assert.ok(podman.some((arg) => arg.endsWith(":/subject:ro")));
  assert.equal(podman.at(-3), image);
  // Engine-specific flags are the complete difference; the Docker membrane is unchanged.
  assert.deepEqual(podman.filter((arg, index) => arg !== "--read-only-tmpfs=false" && arg !== "--userns" && podman[index - 1] !== "--userns"), docker);
});

test("Podman rootful mode retains host ownership and non-root execution without mapping host root into its user", () => {
  const input = { subjectRoot: resolve("podman-subject"), writableRoot: resolve("podman-writable"), image, command: "node", args: ["check.mjs"], allowNetwork: false, memoryMb: 512, cpus: 1, pidsLimit: 32, userId: 65532, groupId: 65533, engine: "podman" as const };
  const rootful = buildDockerForgeCreateArguments({ ...input, podmanRootless: false });
  assert.equal(rootful[rootful.indexOf("--userns") + 1], "host");
  assert.equal(rootful[rootful.indexOf("--user") + 1], "65532:65533");
  assert.equal(rootful.some(arg => arg.includes("keep-id")), false);
  const rootless = buildDockerForgeCreateArguments({ ...input, podmanRootless: true });
  assert.equal(rootless[rootless.indexOf("--userns") + 1], "keep-id:uid=65532,gid=65533");
  assert.throws(() => buildDockerForgeCreateArguments(input), /observed rootless server mode/);
  assert.throws(() => buildDockerForgeCreateArguments({ ...input, podmanRootless: true, userId: 0 }), /non-root/);
});

test("Podman server mode inspection rejects missing, nonboolean, duplicate and ambiguous output", () => {
  assert.equal(parsePodmanRootlessInspection("true\n"), true);
  assert.equal(parsePodmanRootlessInspection(" false \r\n"), false);
  for (const value of ["", "null", "1", '"true"', "True", "true\nfalse", "{}", "[]", "true trailing"]) assert.equal(parsePodmanRootlessInspection(value), undefined);
});

test("Podman startup and live authority cannot be substituted with Docker using the same image ID", () => {
  const admitted = sealedDockerForgeAuthority(descriptor("podman"));
  assert.equal(admitted.verified, true);
  assert.equal(admitted.authority?.engine, "podman");
  const identity = sealDockerSubstrateIdentity(reference, { status: "resolved", imageId: image }, "local-podman-cli");
  const podman = new SealedForgeAdapter({ mode: "docker", dockerCommand: "podman", dockerImage: reference, dockerSubstrateIdentity: identity });
  const substituted = new SealedForgeAdapter({ mode: "docker", dockerCommand: "docker", dockerImage: reference, dockerSubstrateIdentity: identity });
  assert.equal(SealedForgeAdapter.liveAuthorityProblem(podman, admitted.authority!), undefined);
  assert.match(SealedForgeAdapter.liveAuthorityProblem(substituted, admitted.authority!) ?? "", /does not equal/);
  assert.equal(sealedDockerForgeAuthority(descriptor("docker", "local-podman-cli")).verified, false);
  assert.equal(sealedDockerForgeAuthority(descriptor("podman", "local-docker-cli")).verified, false);
  assert.notEqual(admitted.authority?.digest, sealedDockerForgeAuthority(descriptor("docker")).authority?.digest);
});
