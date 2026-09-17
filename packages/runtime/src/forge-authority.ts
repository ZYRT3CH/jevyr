import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import type { ForgeOracleObservation } from "./typed-oracles.js";

export const SEALED_DOCKER_FORGE_AUTHORITY_PROTOCOL =
  "jevyr.sealed-docker-forge-authority/1" as const;

export interface SealedDockerForgeAuthority {
  readonly protocol: typeof SEALED_DOCKER_FORGE_AUTHORITY_PROTOCOL;
  readonly adapterBoundary: "built-in";
  readonly mode: "docker";
  /** Omitted in the original Docker encoding; omission continues to mean Docker. */
  readonly engine?: "podman";
  readonly requestedReference: string;
  readonly immutableImageId: string;
  readonly resolutionAuthority: "local-docker-cli" | "local-podman-cli" | "embedder-injected-resolver";
  readonly digest: string;
}

export interface ForgeExecutionAuthorityAssessment {
  readonly verified: boolean;
  readonly reason: string;
  readonly authority?: SealedDockerForgeAuthority;
}

const BINDING_KEYS = Object.freeze([
  "adapterBoundary",
  "failure",
  "immutableImageId",
  "mode",
  "protocol",
  "requestedReference",
  "resolutionAuthority",
  "status",
].sort());

const EXECUTION_SUBSTRATE_KEYS = Object.freeze([
  "contentAddressed",
  "executionImageId",
  "inspectedBeforeExecution",
  "requestedReference",
  "schema",
  "startupResolvedImageId",
].sort());

function dataObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function blocked(reason: string): ForgeExecutionAuthorityAssessment {
  return Object.freeze({ verified: false, reason });
}

/**
 * Extracts the only execution boundary currently permitted to mint decisive
 * sandbox evidence. The input is the exact Case policy descriptor authenticated
 * by the Seal/Record, not a mutable daemon configuration object.
 */
export function sealedDockerForgeAuthority(
  policyDescriptor: unknown,
): ForgeExecutionAuthorityAssessment {
  const envelope = dataObject(policyDescriptor);
  if (envelope?.protocol !== "jevyr.policy-descriptor/1") {
    return blocked("The authenticated policy is not a Jevyr Case policy descriptor.");
  }
  const effective = dataObject(envelope.policy);
  if (effective?.protocol !== "jevyr.effective-policy/1") {
    return blocked("The Case policy does not contain an effective Jevyr policy.");
  }
  const binding = dataObject(effective.forgeSubstrateIdentity);
  if (binding === undefined
    || binding.protocol !== "jevyr.forge-substrate-binding/1"
    || !exactKeys(binding, BINDING_KEYS)) {
    return blocked("The Case policy has no exact Forge substrate binding.");
  }
  if (binding.adapterBoundary !== "built-in") {
    return blocked("An opaque Forge adapter has no authority to mint sandbox verdict evidence.");
  }
  if (binding.mode !== "docker") {
    return blocked("Only the built-in Docker Forge may mint sandbox verdict evidence.");
  }
  if (binding.status !== "resolved" || binding.failure !== null) {
    return blocked("The Docker Forge substrate was not resolved before the Case was sealed.");
  }
  if (typeof binding.requestedReference !== "string"
    || binding.requestedReference.length === 0
    || binding.requestedReference.includes("\0")
    || typeof binding.immutableImageId !== "string"
    || !isSha256Digest(binding.immutableImageId)) {
    return blocked("The sealed Docker Forge binding has no valid requested reference and immutable image ID.");
  }
  if (binding.resolutionAuthority !== "local-docker-cli"
    && binding.resolutionAuthority !== "local-podman-cli"
    && binding.resolutionAuthority !== "embedder-injected-resolver") {
    return blocked("The Docker Forge identity was not bound by a startup resolution authority.");
  }
  const config = dataObject(effective.effectiveForgeConfig);
  if (config?.mode !== "docker"
    || config.dockerImage !== binding.requestedReference
    || (config.dockerCommand !== null && config.dockerCommand !== "docker" && config.dockerCommand !== "podman")
    || (binding.resolutionAuthority === "local-podman-cli" && config.dockerCommand !== "podman")
    || (binding.resolutionAuthority === "local-docker-cli" && config.dockerCommand === "podman")) {
    return blocked("The effective Forge configuration disagrees with the sealed Docker substrate binding.");
  }
  const unsigned = Object.freeze({
    protocol: SEALED_DOCKER_FORGE_AUTHORITY_PROTOCOL,
    adapterBoundary: "built-in" as const,
    mode: "docker" as const,
    ...(config.dockerCommand === "podman" ? { engine: "podman" as const } : {}),
    requestedReference: binding.requestedReference,
    immutableImageId: binding.immutableImageId,
    resolutionAuthority: binding.resolutionAuthority,
  });
  const authority: SealedDockerForgeAuthority = Object.freeze({
    ...unsigned,
    digest: digestJson(unsigned as unknown as JsonValue),
  });
  return Object.freeze({
    verified: true,
    reason: "The Case policy binds the built-in Docker Forge to one startup-resolved immutable image ID.",
    authority,
  });
}

/**
 * Replays execution provenance without trusting adapter metadata or a generic
 * success flag. Typed oracle semantics are a separate check; both must pass.
 */
export function verifyForgeExecutionAuthority(
  policyDescriptor: unknown,
  observation: ForgeOracleObservation,
): ForgeExecutionAuthorityAssessment {
  const policy = sealedDockerForgeAuthority(policyDescriptor);
  if (!policy.verified || policy.authority === undefined) return policy;
  const execution = dataObject(observation.execution);
  if (execution?.mode !== "docker") {
    return blocked("The persisted execution was not produced in Docker mode.");
  }
  const substrate = dataObject(execution.substrate);
  if (substrate === undefined
    || substrate.schema !== "jevyr.docker-execution-substrate/1"
    || !exactKeys(substrate, EXECUTION_SUBSTRATE_KEYS)) {
    return blocked("The persisted execution has no exact Docker substrate attestation.");
  }
  if (substrate.contentAddressed !== true || substrate.inspectedBeforeExecution !== true) {
    return blocked("The Docker execution was not attested as content-addressed and inspected before execution.");
  }
  if (substrate.requestedReference !== policy.authority.requestedReference
    || substrate.startupResolvedImageId !== policy.authority.immutableImageId
    || substrate.executionImageId !== policy.authority.immutableImageId) {
    return blocked("The Docker execution substrate does not equal the image identity sealed into the Case policy.");
  }
  return Object.freeze({
    verified: true,
    reason: "The persisted execution names the exact startup-sealed Docker image ID.",
    authority: policy.authority,
  });
}
