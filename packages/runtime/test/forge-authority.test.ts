import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@jevyr/protocol";
import {
  sealedDockerForgeAuthority,
  verifyForgeExecutionAuthority,
} from "../src/forge-authority.js";
import {
  SealedForgeAdapter,
  sealDockerSubstrateIdentity,
} from "../src/forge.js";
import type { ToolAdapter } from "../src/contracts.js";
import type { ForgeOracleObservation } from "../src/typed-oracles.js";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const REFERENCE = "registry.example/jevyr:stable";

function policy(
  bindingOverrides: Readonly<Record<string, unknown>> = {},
  configOverrides: Readonly<Record<string, unknown>> = {},
): JsonValue {
  return {
    protocol: "jevyr.policy-descriptor/1",
    version: "jevyr.bone/1",
    policy: {
      protocol: "jevyr.effective-policy/1",
      forgeSubstrateIdentity: {
        protocol: "jevyr.forge-substrate-binding/1",
        adapterBoundary: "built-in",
        mode: "docker",
        requestedReference: REFERENCE,
        status: "resolved",
        immutableImageId: IMAGE_A,
        resolutionAuthority: "embedder-injected-resolver",
        failure: null,
        ...bindingOverrides,
      },
      effectiveForgeConfig: {
        mode: "docker",
        dockerCommand: null,
        dockerImage: REFERENCE,
        ...configOverrides,
      },
    },
    subjectSnapshots: {},
  } as JsonValue;
}

function observation(overrides: Readonly<Record<string, unknown>> = {}): ForgeOracleObservation {
  return {
    execution: {
      state: "exited",
      mode: "docker",
      command: "node",
      args: ["check.js"],
      shell: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      substrate: {
        schema: "jevyr.docker-execution-substrate/1",
        requestedReference: REFERENCE,
        startupResolvedImageId: IMAGE_A,
        executionImageId: IMAGE_A,
        contentAddressed: true,
        inspectedBeforeExecution: true,
        ...overrides,
      },
    },
  } as ForgeOracleObservation;
}

test("persisted authority requires the exact startup-sealed Docker image", () => {
  const verified = verifyForgeExecutionAuthority(policy(), observation());
  assert.equal(verified.verified, true);
  assert.equal(verified.authority?.immutableImageId, IMAGE_A);

  assert.equal(verifyForgeExecutionAuthority(
    policy(),
    observation({ executionImageId: IMAGE_B }),
  ).verified, false);
  assert.equal(verifyForgeExecutionAuthority(
    policy(),
    observation({ unexpected: true }),
  ).verified, false, "extra attestation keys are not silently accepted");
});

test("opaque, trusted-host, unavailable, and unbound-direct substrates have no sandbox authority", () => {
  assert.equal(sealedDockerForgeAuthority(policy({ adapterBoundary: "opaque-embedder" })).verified, false);
  assert.equal(sealedDockerForgeAuthority(policy({ mode: "trusted-host", status: "not-applicable" })).verified, false);
  assert.equal(sealedDockerForgeAuthority(policy({ status: "unavailable", immutableImageId: null, failure: "inspect-failed" })).verified, false);
  assert.equal(sealedDockerForgeAuthority(policy({ resolutionAuthority: "unbound-direct-construction" })).verified, false);
  assert.equal(sealedDockerForgeAuthority(policy({}, { dockerCommand: "docker-wrapper" })).verified, false);
});

test("the built-in Forge snapshots configuration and exposes a frozen, unforgeable identity", () => {
  const identity = sealDockerSubstrateIdentity(
    REFERENCE,
    { status: "resolved", imageId: IMAGE_A },
    "embedder-injected-resolver",
  );
  const mutableConfig = {
    mode: "docker" as const,
    dockerImage: REFERENCE,
    dockerSubstrateIdentity: identity,
  };
  const forge = new SealedForgeAdapter(mutableConfig);
  mutableConfig.dockerImage = "registry.example/jevyr:moved";
  assert.equal(forge.dockerSubstrateIdentity?.requestedReference, REFERENCE);
  assert.equal(Object.isFrozen(forge), true);
  assert.equal(Object.isFrozen(forge.capability), true);
  assert.equal(Object.isFrozen(forge.capability.limits), true);
  assert.throws(
    () => Object.assign(forge, { dockerSubstrateIdentity: { ...identity, immutableImageId: IMAGE_B } }),
    /read only|extensible|getter|assign/iu,
  );

  const sealed = sealedDockerForgeAuthority(policy());
  assert.equal(sealed.verified, true);
  assert.equal(SealedForgeAdapter.liveAuthorityProblem(forge, sealed.authority!), undefined);

  const counterfeit = {
    capability: forge.capability,
    probe: forge.probe.bind(forge),
    execute: forge.execute.bind(forge),
  } satisfies ToolAdapter;
  assert.match(
    SealedForgeAdapter.liveAuthorityProblem(counterfeit, sealed.authority!) ?? "",
    /opaque Forge adapter/u,
  );
});

test("SealedForgeAdapter cannot be subclassed into an alternate execution implementation", () => {
  class CounterfeitForge extends SealedForgeAdapter {}
  assert.throws(
    () => new CounterfeitForge({ mode: "observe-only" }),
    /final execution boundary/u,
  );
});
