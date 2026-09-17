import { describe, expect, it } from "vitest";
import {
  CASE_EVENT_JSON_SCHEMA,
  SIGNED_RECORD_JSON_SCHEMA,
  TERMINAL_RECEIPT_JSON_SCHEMA,
  canonicalize,
  createSearchEnvelope,
  digestJson,
  sealedCaseIdentityDigest,
  sha256Digest,
  validateCaseEventShape,
  validateCaseSubmission,
  validateIntentContract,
  validateSealReceipt,
  validateSealedCase,
  validateSearchEnvelope,
  validateSignedRecord,
  validateTerminalReceipt,
  type SealedCase,
} from "../src/index.js";

const searchProfile = {
  attemptSafetyCeiling: "1500000000000000000000",
  nursery: {
    minimumAttempts: 6,
    saturationWindow: 4,
    independentLineages: 4,
    challengeInterval: 3,
  },
  resources: {
    maxMindInvocations: 12,
    maxInputTokens: 262_144,
    maxOutputTokens: 131_072,
    maxWallMillis: 900_000,
    maxSingleInvocationMillis: 120_000,
    maxGeneratedBytes: 50_000_000,
    maxForgeCpuMillis: 120_000,
    maxForgeWallMillis: 180_000,
    maxMemorySeconds: 30,
    maxWritableBytes: 100_000_000,
    maxWritableInodes: 10_000,
    maxArtifactBytes: 20_000_000,
    maxNetworkBytes: 0,
    concurrentLineages: 4,
    maxTotalAssayCost: 1_000,
  },
  seedDerivation: "sha256-run-digest-frontier-v1",
} as const;

function sealedCaseFixture(): SealedCase {
  const impulse = "Judge the exact sealed subjects.";
  const unsignedContract = {
    protocol: "jevyr.intent-contract/1" as const,
    compilerVersion: "jevyr.intent-compiler/1" as const,
    originalImpulse: impulse,
    originalImpulseDigest: sha256Digest(impulse),
    goal: { statement: impulse, source: "whole_impulse" as const },
    subjectIds: ["source", "workspace"],
    explicitConstraints: [],
    requestedAssays: [],
    successConditions: [{
      id: "success-1",
      kind: "success" as const,
      statement: "The obligation is proven.",
      source: "kernel" as const,
      obligationIds: ["obligation-1"],
    }],
    failureConditions: [{
      id: "failure-1",
      kind: "failure" as const,
      statement: "The obligation is refuted.",
      source: "kernel" as const,
      obligationIds: ["obligation-1"],
    }],
    ambiguities: [],
    alternativeInterpretations: [],
    criticalObligations: [{
      id: "obligation-1",
      statement: impulse,
      origin: "impulse" as const,
      critical: true as const,
      assayability: "UNASSAYABLE" as const,
      unassayableReason: "No sealed oracle was supplied.",
    }],
  };
  const intentContract = { ...unsignedContract, digest: digestJson(unsignedContract) };
  const intent = {
    impulse,
    mode: "audit" as const,
    subjects: [
      {
        id: "source",
        kind: "text" as const,
        locator: "exact source bytes",
        revision: "source-v1",
        mediaType: "text/plain; charset=utf-8",
      },
      { id: "workspace", kind: "git" as const, locator: "/sealed/workspace", revision: "HEAD" },
    ],
    constraints: ["offline", "read-only"],
    requestedAssays: [],
    privacy: "local_only" as const,
    control: "sovereign" as const,
    seed: "sealed-seed",
  };
  const capturedAt = "2026-09-04T11:59:59.000Z";
  const subjects = [
    {
      subjectId: "source",
      digest: sha256Digest("exact source bytes"),
      resolvedLocator: "inline:source",
      revision: "source-v1",
      capturedAt,
      byteLength: new TextEncoder().encode("exact source bytes").byteLength,
      mediaType: "text/plain; charset=utf-8",
    },
    {
      subjectId: "workspace",
      digest: `sha256:${"a".repeat(64)}`,
      resolvedLocator: "/sealed/workspace",
      revision: "0123456789abcdef0123456789abcdef01234567",
      capturedAt,
    },
  ];
  const subjectMaterialCaptureDigest = `sha256:${"b".repeat(64)}`;
  const caseDigest = sealedCaseIdentityDigest({
    intent,
    intentContractDigest: intentContract.digest,
    subjectMaterialCaptureDigest,
    subjects,
  });
  const searchEnvelope = createSearchEnvelope(searchProfile);
  const sealedAt = "2026-09-04T12:00:00.000Z";
  const runDigest = digestJson({
    caseDigest,
    policyVersion: "jevyr.bone/1",
    policyDigest: `sha256:${"c".repeat(64)}`,
    genomeVersion: "jevyr.genome/1",
    genomeDigest: `sha256:${"d".repeat(64)}`,
    searchDigest: searchEnvelope.digest,
    seed: intent.seed,
    sealedAt,
  });
  return {
    protocol: "jevyr.case/1",
    caseId: `case_${runDigest.slice(7, 23)}`,
    submissionDigest: `sha256:${"e".repeat(64)}`,
    subjectMaterialCaptureDigest,
    caseDigest,
    runDigest,
    sealedAt,
    policyVersion: "jevyr.bone/1",
    policyDigest: `sha256:${"c".repeat(64)}`,
    genomeVersion: "jevyr.genome/1",
    genomeDigest: `sha256:${"d".repeat(64)}`,
    searchEnvelope,
    intentContractDigest: intentContract.digest,
    intentContract,
    intent,
    subjects,
  };
}

function reidentifySealedCase(value: SealedCase): SealedCase {
  const mutable = value as unknown as Record<string, unknown>;
  const caseDigest = sealedCaseIdentityDigest({
    intent: value.intent,
    intentContractDigest: value.intentContractDigest,
    subjectMaterialCaptureDigest: value.subjectMaterialCaptureDigest,
    subjects: value.subjects,
  });
  const runDigest = digestJson({
    caseDigest,
    policyVersion: value.policyVersion,
    policyDigest: value.policyDigest,
    genomeVersion: value.genomeVersion,
    genomeDigest: value.genomeDigest,
    searchDigest: value.searchEnvelope.digest,
    seed: value.intent.seed,
    sealedAt: value.sealedAt,
  });
  mutable.caseDigest = caseDigest;
  mutable.runDigest = runDigest;
  mutable.caseId = `case_${runDigest.slice(7, 23)}`;
  return value;
}

describe("canonical protocol encoding", () => {
  it("matches the standard SHA-256 vectors without a platform crypto import", () => {
    expect(sha256Digest("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Digest("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Digest("Jevyr · exact bytes")).toBe(
      "sha256:dc7b9afa9828c5829dc154f8339864f116c928397c9b174f55d77bca0c16ac67",
    );
  });

  it("is invariant to object insertion order", () => {
    const left = { z: [3, { b: true, a: "x" }], a: 1 } as const;
    const right = { a: 1, z: [3, { a: "x", b: true }] } as const;
    expect(canonicalize(left)).toBe('{"a":1,"z":[3,{"a":"x","b":true}]}');
    expect(digestJson(left)).toBe(digestJson(right));
  });

  it("rejects values with no stable JSON representation", () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ value: undefined } as never)).toThrow(/not a JSON value/);
  });

  it("rejects behavioral or ambiguous object shapes without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "untrusted";
      },
    });
    expect(() => canonicalize(accessor as never)).toThrow(/data property/);
    expect(getterCalls).toBe(0);

    const hidden = { visible: true } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(() => canonicalize(hidden as never)).toThrow(/enumerable data property/);

    const sparse = new Array(2) as unknown[];
    sparse[1] = "present";
    expect(() => canonicalize(sparse as never)).toThrow(/dense|every index/);

    const decorated = ["value"] as unknown[] & { extra?: string };
    decorated.extra = "ambiguous";
    expect(() => canonicalize(decorated as never)).toThrow(/no extra properties/);

    const symbol = Symbol("hidden");
    const symbolic = { value: true, [symbol]: false };
    expect(() => canonicalize(symbolic as never)).toThrow(/symbol properties/);
  });

  it("accepts inert null-prototype records", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: 2,
      a: 1,
    });
    expect(canonicalize(value as never)).toBe('{"a":1,"z":2}');
  });
});

describe("case submission validation", () => {
  it("accepts the minimal transport-neutral shorthand", () => {
    const result = validateCaseSubmission({
      protocol: "jevyr.case/1",
      case: { impulse: "Find the hidden failure." },
    });
    expect(result.ok).toBe(true);
  });

  it("reports bounded, addressable problems", () => {
    const result = validateCaseSubmission({
      protocol: "wrong",
      case: { impulse: "", subjects: [{ id: "x", kind: "moon", locator: "" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.problems.map((item) => item.path)).toContain("$.case.impulse");
    expect(result.problems.map((item) => item.path)).toContain("$.case.subjects[0].kind");
  });
});

describe("intent contract validation", () => {
  it("binds the exact impulse, obligations, unresolved ambiguity, and canonical contract", () => {
    const impulse = "Make this beautiful.";
    const unsigned = {
      protocol: "jevyr.intent-contract/1" as const,
      compilerVersion: "jevyr.intent-compiler/1" as const,
      originalImpulse: impulse,
      originalImpulseDigest: sha256Digest(impulse),
      goal: { statement: impulse, source: "whole_impulse" as const },
      subjectIds: [],
      explicitConstraints: [],
      requestedAssays: [],
      successConditions: [
        {
          id: "success-1",
          kind: "success" as const,
          statement: "All obligations are proven.",
          source: "kernel" as const,
          obligationIds: ["obligation-1"],
        },
      ],
      failureConditions: [
        {
          id: "failure-1",
          kind: "failure" as const,
          statement: "An obligation is refuted.",
          source: "kernel" as const,
          obligationIds: ["obligation-1"],
        },
      ],
      ambiguities: [
        {
          id: "ambiguity-1",
          code: "DEICTIC_REFERENCE" as const,
          sourceText: "this",
          summary: "The referent is unresolved.",
        },
      ],
      alternativeInterpretations: [
        {
          id: "alternative-1",
          ambiguityId: "ambiguity-1",
          statement: "Resolve this to the sealed subject.",
          resolution: "UNRESOLVED" as const,
        },
      ],
      criticalObligations: [
        {
          id: "obligation-1",
          statement: impulse,
          origin: "impulse" as const,
          critical: true as const,
          assayability: "UNASSAYABLE" as const,
          unassayableReason: "No truth-conditional oracle is stated.",
        },
      ],
    };
    const contract = { ...unsigned, digest: digestJson(unsigned) };
    expect(validateIntentContract(contract).ok).toBe(true);

    const tampered = {
      ...contract,
      goal: { ...contract.goal, statement: "Make this measurable." },
    };
    expect(validateIntentContract(tampered).problems.map((entry) => entry.code)).toContain(
      "digest_mismatch",
    );
  });
});

describe("sealed search provenance", () => {
  it("binds the exact nursery and hard resource profile", () => {
    const envelope = createSearchEnvelope(searchProfile);
    expect(validateSearchEnvelope(envelope).ok).toBe(true);
    expect(envelope.digest).toBe(
      digestJson({ protocol: envelope.protocol, profile: envelope.profile }),
    );

    const tampered = {
      ...envelope,
      profile: {
        ...envelope.profile,
        resources: { ...envelope.profile.resources, maxNetworkBytes: 1 },
      },
    };
    const result = validateSearchEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.problems.map((item) => item.code)).toContain("digest_mismatch");
  });

  it("rejects unbounded or ambiguous resource fields", () => {
    const envelope = structuredClone(createSearchEnvelope(searchProfile)) as unknown as Record<
      string,
      unknown
    >;
    const profile = envelope.profile as Record<string, unknown>;
    const resources = profile.resources as Record<string, unknown>;
    resources.maxOutputTokens = null;
    expect(validateSearchEnvelope(envelope).ok).toBe(false);
  });

  it("bounds the remote attempt guard before arbitrary-precision parsing", () => {
    expect(() =>
      createSearchEnvelope({
        ...searchProfile,
        attemptSafetyCeiling: "9".repeat(129),
      }),
    ).toThrow(/at most 128 digits/);
  });
});

describe("sealed subject material provenance", () => {
  it("rejects Seal receipts and Cases that omit the capture commitment", () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const receipt = {
      protocol: "jevyr.seal/1",
      caseId: "case_1111111111111111",
      submissionDigest: digest,
      caseDigest: digest,
      runDigest: digest,
      sealedAt: "2026-09-04T12:00:00.000Z",
      policyVersion: "jevyr.bone/1",
      policyDigest: digest,
      genomeVersion: "jevyr.genome/1",
      genomeDigest: digest,
      searchDigest: digest,
      intentContractDigest: digest,
    };
    expect(validateSealReceipt(receipt).problems.map((entry) => entry.path)).toContain(
      "$.subjectMaterialCaptureDigest",
    );
    expect(
      validateSealedCase({ ...receipt, protocol: "jevyr.case/1" }).problems.map(
        (entry) => entry.path,
      ),
    ).toContain("$.subjectMaterialCaptureDigest");
  });

  it("requires digest-derived Case identity and canonical UTC Seal timestamps", () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const receipt = {
      protocol: "jevyr.seal/1",
      caseId: "case_1111111111111111",
      submissionDigest: digest,
      subjectMaterialCaptureDigest: digest,
      caseDigest: digest,
      runDigest: digest,
      sealedAt: "2026-09-04T12:00:00.000Z",
      policyVersion: "jevyr.bone/1",
      policyDigest: digest,
      genomeVersion: "jevyr.genome/1",
      genomeDigest: digest,
      searchDigest: digest,
      intentContractDigest: digest,
    };
    expect(validateSealReceipt(receipt).ok).toBe(true);
    expect(validateSealReceipt({ ...receipt, caseId: "case_2222222222222222" }).ok).toBe(false);
    expect(validateSealReceipt({ ...receipt, sealedAt: "2026-09-04T12:00:00Z" }).ok).toBe(false);
    expect(validateSealReceipt({ ...receipt, sealedAt: "2026-09-04T14:00:00.000+02:00" }).ok).toBe(false);
  });
});

describe("complete SealedCase boundary", () => {
  it("accepts a fully normalized intent and exact one-to-one snapshots", () => {
    expect(validateSealedCase(sealedCaseFixture())).toEqual({
      ok: true,
      value: sealedCaseFixture(),
      problems: [],
    });
  });

  it.each([
    ["an unknown normalized-intent field", "$.intent.helpful", (value: any) => { value.intent.helpful = true; }],
    ["a missing normalized-intent field", "$.intent.control", (value: any) => { delete value.intent.control; }],
    ["an unknown mode", "$.intent.mode", (value: any) => { value.intent.mode = "improvise"; }],
    ["a noncanonical seed", "$.intent.seed", (value: any) => { value.intent.seed = " sealed-seed "; }],
    ["duplicate constraints", "$.intent.constraints[1]", (value: any) => { value.intent.constraints = ["offline", "offline"]; }],
    ["unsorted constraints", "$.intent.constraints[1]", (value: any) => { value.intent.constraints = ["read-only", "offline"]; }],
    ["an unknown subject field", "$.intent.subjects[0].mutable", (value: any) => { value.intent.subjects[0].mutable = true; }],
    ["a missing subject locator", "$.intent.subjects[0].locator", (value: any) => { delete value.intent.subjects[0].locator; }],
    ["an unknown subject kind", "$.intent.subjects[0].kind", (value: any) => { value.intent.subjects[0].kind = "thought"; }],
    ["a noncanonical subject id", "$.intent.subjects[0].id", (value: any) => { value.intent.subjects[0].id = " source "; }],
    ["an invalid declared media type", "$.intent.subjects[0].mediaType", (value: any) => { value.intent.subjects[0].mediaType = "not a media type"; }],
    ["out-of-order subject ids", "$.intent.subjects[1].id", (value: any) => { value.intent.subjects.reverse(); }],
    ["duplicate subject ids", "$.intent.subjects[1].id", (value: any) => { value.intent.subjects[1].id = "source"; }],
  ])("rejects %s even when identity digests are recomputed", (_label, expectedPath, mutate) => {
    const value = structuredClone(sealedCaseFixture());
    mutate(value);
    let candidate = value;
    try {
      candidate = reidentifySealedCase(value);
    } catch {
      // Missing required identity material is itself invalid; the validator must
      // still report the addressable shape error instead of accepting it.
    }
    const result = validateSealedCase(candidate);
    expect(result.ok).toBe(false);
    expect(result.problems.map((entry) => entry.path)).toContain(expectedPath);
  });

  it.each([
    ["an unknown snapshot field", "$.subjects[0].mutable", (value: any) => { value.subjects[0].mutable = true; }],
    ["a missing snapshot digest", "$.subjects[0].digest", (value: any) => { delete value.subjects[0].digest; }],
    ["an uppercase snapshot digest", "$.subjects[0].digest", (value: any) => { value.subjects[0].digest = `sha256:${"A".repeat(64)}`; }],
    ["a noncanonical capture timestamp", "$.subjects[0].capturedAt", (value: any) => { value.subjects[0].capturedAt = "2026-09-04T11:59:59Z"; }],
    ["a post-Seal capture timestamp", "$.subjects[0].capturedAt", (value: any) => { value.subjects[0].capturedAt = "2026-09-04T12:00:00.001Z"; }],
    ["a negative byte length", "$.subjects[0].byteLength", (value: any) => { value.subjects[0].byteLength = -1; }],
    ["a fractional byte length", "$.subjects[0].byteLength", (value: any) => { value.subjects[0].byteLength = 1.5; }],
    ["an invalid observed media type", "$.subjects[0].mediaType", (value: any) => { value.subjects[0].mediaType = "text"; }],
    ["out-of-order snapshots", "$.subjects[1].subjectId", (value: any) => { value.subjects.reverse(); }],
    ["duplicate snapshot ids", "$.subjects[1].subjectId", (value: any) => { value.subjects[1].subjectId = "source"; }],
    ["a missing subject snapshot", "$.subjects", (value: any) => { value.subjects.pop(); }],
    ["a snapshot for an unknown subject", "$.subjects[1].subjectId", (value: any) => { value.subjects[1].subjectId = "unknown"; }],
    ["declared/observed media-type drift", "$.subjects[0].mediaType", (value: any) => { value.subjects[0].mediaType = "application/json"; }],
    ["declared/observed revision drift", "$.subjects[0].revision", (value: any) => { value.subjects[0].revision = "source-v2"; }],
    ["text-byte digest substitution", "$.subjects[0].digest", (value: any) => { value.subjects[0].digest = `sha256:${"f".repeat(64)}`; }],
    ["text locator substitution", "$.subjects[0].resolvedLocator", (value: any) => { value.subjects[0].resolvedLocator = "inline:elsewhere"; }],
    ["text byte-length substitution", "$.subjects[0].byteLength", (value: any) => { value.subjects[0].byteLength += 1; }],
  ])("rejects %s after recomputed Case and Run identities", (_label, expectedPath, mutate) => {
    const value = structuredClone(sealedCaseFixture());
    mutate(value);
    let candidate = value;
    try {
      candidate = reidentifySealedCase(value);
    } catch {
      // A missing identity field is still expected to produce a validation
      // problem at the mutated path.
    }
    const result = validateSealedCase(candidate);
    expect(result.ok).toBe(false);
    expect(result.problems.map((entry) => entry.path)).toContain(expectedPath);
  });
});

describe("event cursor boundary", () => {
  it("reserves zero for the cursor before the first event", () => {
    const digest = `sha256:${"0".repeat(64)}`;
    const result = validateCaseEventShape({
      protocol: "jevyr.event/1",
      caseDigest: digest,
      runDigest: digest,
      sequence: 0,
      priorDigest: null,
      eventDigest: digest,
      observedAt: "2026-01-01T00:00:00.000Z",
      stage: "cast",
      kind: "stage.status",
      actor: { id: "kernel", kind: "kernel" },
      payload: {
        stage: "cast",
        status: "entered",
        summary: "Cast received.",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.map((item) => item.path)).toContain("$.sequence");
  });

  it("accepts explicit candidate genealogy but rejects duplicate and self parents", () => {
    const digest = `sha256:${"2".repeat(64)}`;
    const event = {
      protocol: "jevyr.event/1",
      caseDigest: digest,
      runDigest: digest,
      sequence: 1,
      priorDigest: null,
      eventDigest: digest,
      observedAt: "2026-01-01T00:00:00.000Z",
      stage: "diverge",
      kind: "candidate.status",
      actor: { id: "nursery", kind: "tool" },
      payload: {
        candidateId: "candidate_child",
        status: "proposed",
        summary: "A child with disclosed ancestry.",
        parentIds: ["candidate_parent"],
      },
    };
    expect(validateCaseEventShape(event).ok).toBe(true);
    expect(
      validateCaseEventShape({
        ...event,
        payload: { ...event.payload, parentIds: ["candidate_parent", "candidate_parent"] },
      }).ok,
    ).toBe(false);
    expect(
      validateCaseEventShape({
        ...event,
        payload: { ...event.payload, parentIds: ["candidate_child"] },
      }).ok,
    ).toBe(false);
  });

  it("carries search physics without turning attempt count into a score", () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const result = validateCaseEventShape({
      protocol: "jevyr.event/1",
      caseDigest: digest,
      runDigest: digest,
      sequence: 1,
      priorDigest: null,
      eventDigest: digest,
      observedAt: "2026-01-01T00:00:00.000Z",
      stage: "diverge",
      kind: "search.status",
      actor: { id: "search-governor", kind: "kernel" },
      payload: {
        layer: "HYPOTHESIS_NURSERY",
        status: "exploring",
        attempted: 42,
        attemptSafetyCeiling: "1500000000000000000000",
        resources: [
          ["mindInvocations", 42, 100, "MEASURED"],
          ["inputTokens", null, 1000, "DECLARED_ONLY"],
          ["outputTokens", null, 1000, "DECLARED_ONLY"],
          ["wallMillis", 3500, 10000, "MEASURED"],
          ["singleInvocationMillis", null, 1000, "DECLARED_ONLY"],
          ["generatedBytes", 12000, 100000, "MEASURED"],
          ["forgeCpuMillis", null, 10000, "DECLARED_ONLY"],
          ["forgeWallMillis", null, 10000, "DECLARED_ONLY"],
          ["memorySeconds", null, 30, "DECLARED_ONLY"],
          ["writableBytes", null, 100000, "DECLARED_ONLY"],
          ["writableInodes", null, 100, "DECLARED_ONLY"],
          ["artifactBytes", null, 100000, "DECLARED_ONLY"],
          ["networkBytes", null, 0, "DECLARED_ONLY"],
          ["concurrentLineages", 1, 4, "MEASURED"],
          ["totalAssayCost", null, 100, "DECLARED_ONLY"],
        ].map(([name, used, ceiling, measurement]) => ({ name, used, ceiling, measurement })),
        hypothesisNursery: {
          exactDistinctHypotheses: 11,
          scars: 3,
          declaredMechanismLabels: ["inversion", "substrate-state"],
          exactYieldAge: 2,
        },
        summary: "Exact-distinct hypotheses are entering the untrusted nursery.",
      },
    });

    expect(result.ok).toBe(true);
  });
});

describe("strict evidentiary event payloads", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const event = (kind: string, payload: Record<string, unknown>) => ({
    protocol: "jevyr.event/1",
    caseDigest: digest,
    runDigest: digest,
    sequence: 1,
    priorDigest: null,
    eventDigest: digest,
    observedAt: "2026-01-01T00:00:00.000Z",
    stage: "assay",
    kind,
    actor: { id: "tribunal", kind: "kernel" },
    payload,
  });

  const evidence = {
    evidenceId: "evidence-1",
    evidenceType: "sandbox_execution",
    summary: "A sealed execution observation.",
    contentDigest: digest,
    candidateId: "candidate-1",
    assayId: "assay-1",
    supports: ["claim-1"],
    refutes: ["claim-2"],
  };

  const candidate = {
    candidateId: "candidate-1",
    status: "embodied",
    summary: "A candidate with explicit ancestry and artifacts.",
    feasibility: "BUILDABLE_NOW",
    parentIds: ["candidate-parent"],
    artifactDigests: [digest],
  };

  const assay = {
    assayId: "assay-1",
    candidateId: "candidate-1",
    obligationId: "obligation-1",
    status: "passed",
    critical: false,
    summary: "The non-critical assay passed.",
    evidenceIds: ["evidence-1"],
  };

  it("accepts every exact enum member and complete optional provenance", () => {
    const evidenceTypes = [
      "subject_snapshot",
      "tool_observation",
      "sandbox_execution",
      "artifact",
      "model_report",
      "peer_report",
      "memory_hint",
    ];
    for (const evidenceType of evidenceTypes) {
      expect(validateCaseEventShape(event("evidence.observed", { ...evidence, evidenceType })).ok).toBe(true);
    }

    const candidateStatuses = ["proposed", "embodied", "invalidated", "survived", "selected"];
    const feasibilities = ["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"];
    for (const status of candidateStatuses) {
      for (const feasibility of feasibilities) {
        expect(validateCaseEventShape(event("candidate.status", { ...candidate, status, feasibility })).ok).toBe(true);
      }
    }

    for (const status of ["planned", "running", "passed", "failed", "inconclusive", "blocked"]) {
      expect(validateCaseEventShape(event("assay.status", { ...assay, status })).ok).toBe(true);
    }
  });

  it("rejects invented enum members and fields for each closed payload", () => {
    const invalid = [
      event("evidence.observed", {
        evidenceId: evidence.evidenceId,
        summary: evidence.summary,
        contentDigest: evidence.contentDigest,
      }),
      event("evidence.observed", { ...evidence, evidenceType: "sandbox-execution" }),
      event("evidence.observed", { ...evidence, authority: "self-attested" }),
      event("evidence.observed", { ...evidence, supports: undefined }),
      event("candidate.status", { ...candidate, status: "approved" }),
      event("candidate.status", { ...candidate, feasibility: "PROBABLY_BUILDABLE" }),
      event("candidate.status", { ...candidate, score: 1 }),
      event("candidate.status", { ...candidate, parentIds: undefined }),
      event("candidate.status", { candidateId: "candidate-1", summary: "Missing status." }),
      event("assay.status", { ...assay, status: "successful" }),
      event("assay.status", { ...assay, critical: 1 }),
      event("assay.status", { ...assay, verdict: "trust me" }),
      event("assay.status", { ...assay, evidenceIds: undefined }),
      event("assay.status", { assayId: "assay-1", status: "passed", summary: "Missing critical." }),
    ];
    for (const value of invalid) expect(validateCaseEventShape(value).ok).toBe(false);
  });

  it("enforces bounded, unique identifier and digest arrays", () => {
    const tooMany = Array.from({ length: 257 }, (_, index) => `claim-${index}`);
    const invalid = [
      event("evidence.observed", { ...evidence, supports: "claim-1" }),
      event("evidence.observed", { ...evidence, supports: ["claim-1", "claim-1"] }),
      event("evidence.observed", { ...evidence, supports: ["claim-1"], refutes: ["claim-1"] }),
      event("evidence.observed", { ...evidence, supports: tooMany }),
      event("evidence.observed", { ...evidence, evidenceId: "x".repeat(257) }),
      event("evidence.observed", { ...evidence, summary: "x".repeat(32_769) }),
      event("candidate.status", { ...candidate, parentIds: ["candidate-1"] }),
      event("candidate.status", { ...candidate, artifactDigests: ["sha256:not-a-digest"] }),
      event("candidate.status", { ...candidate, artifactDigests: [digest, digest] }),
      event("assay.status", { ...assay, evidenceIds: ["evidence-1", "evidence-1"] }),
      event("assay.status", { ...assay, evidenceIds: [" "] }),
    ];
    for (const value of invalid) expect(validateCaseEventShape(value).ok).toBe(false);
  });

  it("rejects accessor-backed payload fields and array entries without executing them", () => {
    let getterCalls = 0;
    const accessorPayload = { ...evidence } as Record<string, unknown>;
    Object.defineProperty(accessorPayload, "evidenceType", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "sandbox_execution";
      },
    });
    expect(validateCaseEventShape(event("evidence.observed", accessorPayload)).ok).toBe(false);
    expect(getterCalls).toBe(0);

    const supports = ["claim-1"];
    Object.defineProperty(supports, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "claim-1";
      },
    });
    expect(validateCaseEventShape(event("evidence.observed", { ...evidence, supports })).ok).toBe(false);
    expect(getterCalls).toBe(0);

    const topLevel = event("assay.status", assay);
    Object.defineProperty(topLevel, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return assay;
      },
    });
    expect(validateCaseEventShape(topLevel).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse, decorated, and non-intrinsic reference arrays", () => {
    const sparse = new Array(1);
    const decorated = ["evidence-1"] as string[] & { authority?: string };
    decorated.authority = "caller";
    const nonIntrinsic = ["candidate-parent"];
    Object.setPrototypeOf(nonIntrinsic, Object.create(Array.prototype));

    expect(validateCaseEventShape(event("evidence.observed", { ...evidence, supports: sparse })).ok).toBe(false);
    expect(validateCaseEventShape(event("assay.status", { ...assay, evidenceIds: decorated })).ok).toBe(false);
    expect(validateCaseEventShape(event("candidate.status", { ...candidate, parentIds: nonIntrinsic })).ok).toBe(false);
  });
});

describe("cross-surface public contract schemas", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  const event = (kind: string, payload: Record<string, unknown>) => ({
    protocol: "jevyr.event/1",
    caseDigest: digest,
    runDigest: digest,
    sequence: 1,
    priorDigest: null,
    eventDigest: digest,
    observedAt: "2026-09-04T00:00:00.000Z",
    stage: "diverge",
    kind,
    actor: { id: "kernel", kind: "kernel" },
    payload,
  });
  const resources = [
    "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
    "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
    "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
  ].map((name) => ({ name, used: null, ceiling: 1, measurement: "DECLARED_ONLY" }));

  it("keeps the exported Record schema exact and intent-bound", () => {
    expect(SIGNED_RECORD_JSON_SCHEMA.required).toContain("intentContractDigest");
    expect(Object.keys(SIGNED_RECORD_JSON_SCHEMA.properties).sort()).toEqual(
      [...SIGNED_RECORD_JSON_SCHEMA.required].sort(),
    );
  });

  it("keeps terminal closure exact and rejects contradictory ledger or lifecycle claims", () => {
    const runDigest = `sha256:${"b".repeat(64)}`;
    const terminal = {
      protocol: "jevyr.terminal/1",
      caseId: "case_bbbbbbbbbbbbbbbb",
      caseDigest: digest,
      runDigest,
      lifecycle: "terminated",
      stage: "terminate",
      stageStatus: "completed",
      lastSequence: 42,
      eventHeadDigest: digest,
      recordDigest: digest,
      artifactIndexDigest: digest,
      closedAt: "2026-09-04T00:00:02.000Z",
    };
    expect(validateTerminalReceipt(terminal).ok).toBe(true);
    expect(TERMINAL_RECEIPT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(validateTerminalReceipt({ ...terminal, eventHeadDigest: null }).ok).toBe(false);
    expect(validateTerminalReceipt({ ...terminal, artifactIndexDigest: "sha256:not-a-digest" }).ok).toBe(false);
    expect(validateTerminalReceipt({ ...terminal, stageStatus: "failed" }).ok).toBe(false);
    expect(validateTerminalReceipt({ ...terminal, callerApproval: true }).ok).toBe(false);
  });

  it("validates every nested Record field instead of trusting signed shape labels", () => {
    const record = {
      protocol: "jevyr.record/1",
      caseDigest: digest,
      runDigest: digest,
      policyDigest: digest,
      genomeDigest: digest,
      searchDigest: digest,
      intentContractDigest: digest,
      eventHeadDigest: digest,
      verdict: {
        policyVersion: "jevyr.bone/1",
        intentContractDigest: digest,
        evidenceDigest: digest,
        integrity: "VALID",
        creation: "NO_SURVIVOR",
        embodiment: "NOT_BUILT",
        judgment: "UNPROVEN",
        feasibilityByCandidate: {},
        basis: [],
      },
      reflex: {
        loop: 1,
        reviewedEvidenceDigest: digest,
        intentContractDigest: digest,
        challengedNodeIds: [],
        materialFindings: [],
        decision: "confirm",
      },
      memoryInfluences: [],
      crystallizedAt: "2026-09-04T00:00:00.000Z",
    };
    expect(validateSignedRecord(record).ok).toBe(true);
    expect(validateSignedRecord({ ...record, verdict: { ...record.verdict, callerApproval: true } }).ok).toBe(false);
    expect(validateSignedRecord({ ...record, reflex: { ...record.reflex, decision: "skip" } }).ok).toBe(false);
    expect(validateSignedRecord({ ...record, memoryInfluences: [{ memoryDigest: digest, influence: "vote", summary: "No.", weight: 0.1 }] }).ok).toBe(false);
    expect(validateSignedRecord({ ...record, crystallizedAt: "2026-09-04T00:00:00Z" }).ok).toBe(false);
  });

  it("publishes a closed payload schema for every event discriminator", () => {
    expect(CASE_EVENT_JSON_SCHEMA.allOf).toHaveLength(CASE_EVENT_JSON_SCHEMA.properties.kind.enum.length);
    for (const rule of CASE_EVENT_JSON_SCHEMA.allOf) {
      expect(rule.then.properties.payload.additionalProperties).toBe(false);
    }
    expect(CASE_EVENT_JSON_SCHEMA.properties.sequence.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects legacy, unknown, and overlong search telemetry after rehashing", () => {
    const canonical = {
      layer: "HYPOTHESIS_NURSERY",
      status: "exploring",
      attempted: 17,
      attemptSafetyCeiling: "9".repeat(128),
      resources,
      hypothesisNursery: {
        exactDistinctHypotheses: 2,
        scars: 0,
        declaredMechanismLabels: ["inversion"],
        exactYieldAge: 1,
      },
      summary: "The frontier is still changing.",
    };
    expect(validateCaseEventShape(event("search.status", canonical)).ok).toBe(true);
    expect(validateCaseEventShape(event("search.status", { ...canonical, effortUsed: 3 })).ok).toBe(false);
    expect(validateCaseEventShape(event("search.status", { ...canonical, attemptSafetyCeiling: "9".repeat(129) })).ok).toBe(false);
  });

  it("treats every non-evidentiary event payload as a closed enum-bearing contract", () => {
    const payloads = [
      ["stage.status", { stage: "diverge", status: "working", summary: "Working." }],
      ["claim.published", { claimId: "claim-1", statement: "A claim.", claimType: "mechanism" }],
      ["action.status", { actionId: "action-1", actionType: "forge", status: "completed", summary: "Done." }],
      ["reflex.completed", { loop: 1, reviewedEvidenceDigest: digest, intentContractDigest: digest, challengedNodeIds: [], materialFindings: [], decision: "confirm" }],
      ["memory.influence", { memoryDigest: digest, influence: "strategy_selected", summary: "Bounded hint.", weight: 0.1 }],
      ["kernel.status", { operation: "terminated", summary: "Terminal." }],
    ] as const;
    for (const [kind, payload] of payloads) {
      expect(validateCaseEventShape(event(kind, payload)).ok).toBe(true);
      expect(validateCaseEventShape(event(kind, { ...payload, callerVerdict: "trust-me" })).ok).toBe(false);
    }
    expect(validateCaseEventShape(event("action.status", { ...payloads[2][1], status: "approved" })).ok).toBe(false);
    expect(validateCaseEventShape(event("kernel.status", { ...payloads[5][1], operation: "continued" })).ok).toBe(false);
  });
});
