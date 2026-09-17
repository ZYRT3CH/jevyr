import { createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { JEVYR_BONE_DESCRIPTOR, JEVYR_BONE_DIGEST, JEVYR_BONE_V2_DESCRIPTOR, JEVYR_BONE_V2_DIGEST, keyIdFor, parseJsonBytes } from "@jevyr/core";
import {
  GenomeRegistry,
  compileGenomeRuntimeProfile,
  type ActiveGenome,
  type GenomeRuntimeProfile,
} from "@jevyr/growth";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import {
  DEFAULT_GENOME_DESCRIPTOR,
  type RepositorySealProfile,
} from "@jevyr/runtime";

export const GENOME_GOVERNANCE_TRUST_PROTOCOL = "jevyr.genome-governance-trust/1" as const;
export const GENOME_STARTUP_SELECTION_PROTOCOL = "jevyr.genome-startup-selection/1" as const;

const MAX_TRUST_FILE_BYTES = 1_048_576;
const MAX_GOVERNANCE_KEYS = 64;

export interface GenomeGovernanceTrustKey {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKeyPem: string;
}

export interface LoadedGenomeStartupSelection {
  readonly registryRoot: string;
  readonly source: "baseline" | "governance-promotion" | "benchmark-experiment";
  readonly active?: ActiveGenome;
  /** Present only for a governance-promoted Genome compiled against runtime-owned Bone. */
  readonly runtimeProfile?: GenomeRuntimeProfile;
  readonly repositorySealProfile: Readonly<Required<Pick<RepositorySealProfile, "genomeVersion" | "genomeDescriptor">> & Pick<RepositorySealProfile, "policyVersion">>;
  /** Portable, public provenance. It contains no filesystem paths or private key material. */
  readonly descriptor: JsonValue;
  readonly descriptorDigest: string;
}

export interface LoadedGovernanceTrust {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly descriptor: JsonValue;
  readonly digest: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function configuredPath(value: string | undefined, projectRoot: string, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0 || value.includes("\0")) throw new TypeError(`${label} must be a non-empty path`);
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

function readStableTrustFile(path: string, projectRoot: string, wasRelative: boolean): unknown {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new TypeError(`Genome governance trust config must be a regular, non-symbolic file: ${path}`);
  }
  if (before.size < 1 || before.size > MAX_TRUST_FILE_BYTES) {
    throw new TypeError(`Genome governance trust config must contain 1–${MAX_TRUST_FILE_BYTES} bytes: ${path}`);
  }
  if (wasRelative) {
    const realRoot = realpathSync(projectRoot);
    const realPath = realpathSync(path);
    const fromRoot = relative(realRoot, realPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TypeError("Relative genome governance trust config resolves outside the explicit project root");
    }
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() || !after.isFile() ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    bytes.byteLength !== after.size
  ) {
    throw new Error("Genome governance trust config changed while startup was binding it");
  }
  try {
    return parseJsonBytes(bytes, "Genome governance trust config");
  } catch (cause) {
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    throw new TypeError(`Genome governance trust config is not valid unambiguous UTF-8 JSON: ${path}${detail}`, { cause });
  }
}

export function loadGovernanceTrust(env: NodeJS.ProcessEnv, projectRoot: string): LoadedGovernanceTrust {
  const configured = env.JEVYR_GENOME_GOVERNANCE_TRUST_FILE;
  const path = configuredPath(configured, projectRoot, "JEVYR_GENOME_GOVERNANCE_TRUST_FILE");
  if (path === undefined) {
    const descriptor = Object.freeze({
      protocol: "jevyr.genome-governance-trust-descriptor/1",
      source: "none",
      keys: Object.freeze([]),
    }) as unknown as JsonValue;
    return Object.freeze({ keys: new Map(), descriptor, digest: digestJson(descriptor) });
  }

  const root = object(readStableTrustFile(path, projectRoot, !isAbsolute(configured as string)), "Genome governance trust config");
  exactKeys(root, ["protocol", "keys"], "Genome governance trust config");
  if (root.protocol !== GENOME_GOVERNANCE_TRUST_PROTOCOL) {
    throw new TypeError(`Genome governance trust config protocol must equal ${GENOME_GOVERNANCE_TRUST_PROTOCOL}`);
  }
  if (!Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > MAX_GOVERNANCE_KEYS) {
    throw new TypeError(`Genome governance trust config keys must contain 1–${MAX_GOVERNANCE_KEYS} entries`);
  }

  const keys = new Map<string, KeyObject>();
  const publicKeys: Array<{ keyId: string; algorithm: "Ed25519"; publicKeySpkiDigest: string }> = [];
  for (const [index, candidate] of root.keys.entries()) {
    const entry = object(candidate, `Genome governance trust key ${index}`);
    exactKeys(entry, ["keyId", "algorithm", "publicKeyPem"], `Genome governance trust key ${index}`);
    if (entry.algorithm !== "Ed25519") {
      throw new TypeError(`Genome governance trust key ${index}.algorithm must equal Ed25519`);
    }
    if (typeof entry.keyId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.keyId)) {
      throw new TypeError(`Genome governance trust key ${index}.keyId must be a SHA-256 SPKI digest`);
    }
    if (
      typeof entry.publicKeyPem !== "string" ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n/u.test(entry.publicKeyPem) ||
      !/\r?\n-----END PUBLIC KEY-----\r?\n?$/u.test(entry.publicKeyPem) ||
      entry.publicKeyPem.length > 16_384
    ) {
      throw new TypeError(`Genome governance trust key ${index}.publicKeyPem must be one bounded public-key PEM block`);
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch (cause) {
      throw new TypeError(`Genome governance trust key ${index}.publicKeyPem is invalid`, { cause });
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`Genome governance trust key ${index} is not an Ed25519 public key`);
    }
    const actualKeyId = keyIdFor(publicKey);
    if (entry.keyId !== actualKeyId) {
      throw new TypeError(`Genome governance trust key ${index}.keyId does not match its public key`);
    }
    if (keys.has(actualKeyId)) throw new TypeError(`Genome governance trust key ${index} duplicates ${actualKeyId}`);
    keys.set(actualKeyId, publicKey);
    publicKeys.push({ keyId: actualKeyId, algorithm: "Ed25519", publicKeySpkiDigest: actualKeyId });
  }
  publicKeys.sort((left, right) => left.keyId.localeCompare(right.keyId));
  const descriptor = Object.freeze({
    protocol: "jevyr.genome-governance-trust-descriptor/1",
    source: "operator-file",
    keys: Object.freeze(publicKeys.map((key) => Object.freeze(key))),
  }) as unknown as JsonValue;
  return Object.freeze({ keys, descriptor, digest: digestJson(descriptor) });
}

/**
 * Reads the mutable active pointer once and converts that verified snapshot to
 * immutable repository inputs. This function never writes or promotes a Genome.
 */
export function loadGenomeStartupSelection(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  dataDir: string,
  policyVersion: "bone-v1" | "bone-v2" = "bone-v1",
): LoadedGenomeStartupSelection {
  const bone = policyVersion === "bone-v2" ? JEVYR_BONE_V2_DESCRIPTOR : JEVYR_BONE_DESCRIPTOR;
  const boneDigest = policyVersion === "bone-v2" ? JEVYR_BONE_V2_DIGEST : JEVYR_BONE_DIGEST;
  const trust = loadGovernanceTrust(env, projectRoot);
  const configuredRoot = configuredPath(env.JEVYR_GENOME_REGISTRY_DIR, projectRoot, "JEVYR_GENOME_REGISTRY_DIR");
  const registryRoot = configuredRoot ?? resolve(dataDir, "genome-registry");
  const active = new GenomeRegistry(registryRoot).readActiveSync(trust.keys);
  const runtimeProfile = active === undefined
    ? undefined
    : compileGenomeRuntimeProfile(active.genome, { expectedBoneDigest: boneDigest });
  const repositorySealProfile = Object.freeze(active === undefined
    ? {
        genomeVersion: "jevyr.genome/1",
        genomeDescriptor: DEFAULT_GENOME_DESCRIPTOR,
        ...(policyVersion === "bone-v2" ? { policyVersion: "jevyr.bone/2" as const } : {}),
      }
    : {
        genomeVersion: active.genome.body.protocol,
        // The stored Genome digest is defined over this exact body. Repository
        // provenance therefore preserves the registry's content address.
        genomeDescriptor: active.genome.body as unknown as JsonValue,
        ...(policyVersion === "bone-v2" ? { policyVersion: "jevyr.bone/2" as const } : {}),
      });
  const selection = active === undefined
    ? Object.freeze({ mode: "baseline", genomeVersion: repositorySealProfile.genomeVersion, genomeDigest: digestJson(repositorySealProfile.genomeDescriptor) })
    : Object.freeze({
        mode: "governance-promotion",
        genomeVersion: repositorySealProfile.genomeVersion,
        genomeDigest: active.genome.digest,
        generation: active.genome.body.generation,
        pointerDigest: active.pointer.pointerDigest,
        promotionDigest: active.promotion.digest,
        proposalDigest: active.promotion.body.proposalDigest,
      });
  const descriptor = Object.freeze({
    protocol: GENOME_STARTUP_SELECTION_PROTOCOL,
    selection,
    governanceTrustDigest: trust.digest,
    governanceTrust: trust.descriptor,
    pointerRead: "startup-once",
    promotionAuthority: "signed-governance-only",
    runtimeCompilation: runtimeProfile === undefined
      ? {
          mode: "baseline-static",
          boneDigest,
          bone,
        }
      : {
          mode: "built-in-catalog-only",
          boneDigest,
          bone,
          runtimeProfileDigest: runtimeProfile.profileDigest,
          runtimeProfile,
        },
  }) as unknown as JsonValue;
  return Object.freeze({
    registryRoot,
    source: active === undefined ? "baseline" : "governance-promotion",
    ...(active === undefined ? {} : { active }),
    ...(runtimeProfile === undefined ? {} : { runtimeProfile }),
    repositorySealProfile,
    descriptor,
    descriptorDigest: digestJson(descriptor),
  });
}

/** The selected version chooses a runtime constant, never a Genome-supplied kernel. */
export function selectedStartupBone(selection: LoadedGenomeStartupSelection) {
  return selection.repositorySealProfile.policyVersion === "jevyr.bone/2"
    ? { bone: JEVYR_BONE_V2_DESCRIPTOR, boneDigest: JEVYR_BONE_V2_DIGEST }
    : { bone: JEVYR_BONE_DESCRIPTOR, boneDigest: JEVYR_BONE_DIGEST };
}
