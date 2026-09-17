import {
  CASE_PROTOCOL,
  EVENT_PROTOCOL,
  LIFECYCLE_STAGES,
  RECORD_PROTOCOL,
  SEARCH_ENVELOPE_PROTOCOL,
  TERMINAL_PROTOCOL,
} from "./types.js";
import { CASE_SUBMISSION_TYPEBOX } from "./submission-schema.js";

const SHA256_SCHEMA = Object.freeze({ type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const);
const CANONICAL_TIMESTAMP_SCHEMA = Object.freeze({
  type: "string",
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
} as const);
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const EVENT_ID_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: 256 } as const);
const EVENT_SUMMARY_SCHEMA = Object.freeze({ type: "string", minLength: 1, maxLength: 32_768 } as const);
export const FORMAL_COUNTEREXAMPLE_JSON_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["protocol", "rule", "intentContractDigest", "obligationId", "statementDigest", "source", "proposition", "witness"],
  properties: {
    protocol: { const: "jevyr.formal-counterexample/1" }, rule: { const: "finite-sequence-length-lower-bound" },
    intentContractDigest: SHA256_SCHEMA, obligationId: EVENT_ID_SCHEMA, statementDigest: SHA256_SCHEMA,
    source: { type: "object", additionalProperties: false, required: ["start", "end", "text"], properties: {
      start: { type: "integer", minimum: 0, maximum: 1_000_000 }, end: { type: "integer", minimum: 0, maximum: 1_000_000 }, text: EVENT_SUMMARY_SCHEMA,
    } },
    proposition: { type: "object", additionalProperties: false, required: ["domain", "minimumInputLength", "minimumOutputLength", "requiredSaving"], properties: {
      domain: { enum: ["all_finite_byte_strings", "all_finite_bit_strings"] }, minimumInputLength: { const: 0 }, minimumOutputLength: { const: 0 }, requiredSaving: { type: "integer", minimum: 1, maximum: 999_999 },
    } },
    witness: { type: "object", additionalProperties: false, required: ["inputLength", "inputHex", "maximumOutputLength"], properties: {
      inputLength: { const: 0 }, inputHex: { const: "" }, maximumOutputLength: { type: "integer", minimum: -999_999, maximum: -1 },
    } },
  },
} as const);
const EVENT_REFERENCE_ARRAY_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 256,
  uniqueItems: true,
  items: EVENT_ID_SCHEMA,
} as const);
const EVENT_DIGEST_ARRAY_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 256,
  uniqueItems: true,
  items: SHA256_SCHEMA,
} as const);

export const INVESTIGATION_AUDIT_JSON_SCHEMA = Object.freeze({
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "invocationId", "providerId", "modelId", "lineageId", "seedCommitment", "seedEnforcement", "promptDigest", "candidateIds", "visibleCandidateIds", "memoryDigests", "assumptionDigest"], properties: {
      kind: { const: "lineage_commitment" }, invocationId: EVENT_ID_SCHEMA, providerId: EVENT_ID_SCHEMA, modelId: EVENT_ID_SCHEMA, lineageId: EVENT_ID_SCHEMA, seedCommitment: SHA256_SCHEMA, seedEnforcement: { enum: ["honored", "unverified"] }, promptDigest: SHA256_SCHEMA, candidateIds: EVENT_REFERENCE_ARRAY_SCHEMA, visibleCandidateIds: EVENT_REFERENCE_ARRAY_SCHEMA, memoryDigests: EVENT_DIGEST_ARRAY_SCHEMA, assumptionDigest: SHA256_SCHEMA,
    } },
    { type: "object", additionalProperties: false, required: ["kind", "pairId", "axis", "arm", "obligationDigest", "evidenceDigest", "outcomeDigest"], properties: {
      kind: { const: "paired_probe" }, pairId: EVENT_ID_SCHEMA, axis: { enum: ["preference_wording", "initial_condition"] }, arm: { enum: ["baseline", "variant"] }, obligationDigest: SHA256_SCHEMA, evidenceDigest: SHA256_SCHEMA, outcomeDigest: SHA256_SCHEMA,
    } },
    { type: "object", additionalProperties: false, required: ["kind", "builderId", "evaluatorId", "sealedOracleDigest", "appliedOracleDigest", "untrustedOracleInput"], properties: {
      kind: { const: "evaluator_boundary" }, builderId: EVENT_ID_SCHEMA, evaluatorId: EVENT_ID_SCHEMA, sealedOracleDigest: SHA256_SCHEMA, appliedOracleDigest: SHA256_SCHEMA, untrustedOracleInput: { type: "boolean" },
    } },
    { type: "object", additionalProperties: false, required: ["kind", "sealedAssumptionsDigest", "appliedAssumptionsDigest"], properties: {
      kind: { const: "assumption_check" }, sealedAssumptionsDigest: SHA256_SCHEMA, appliedAssumptionsDigest: SHA256_SCHEMA,
    } },
    { type: "object", additionalProperties: false, required: ["kind", "memoryDigest", "contaminated", "derivedFromDigests"], properties: {
      kind: { const: "memory_validation" }, memoryDigest: SHA256_SCHEMA, contaminated: { type: "boolean" }, derivedFromDigests: EVENT_DIGEST_ARRAY_SCHEMA,
    } },
    { type: "object", additionalProperties: false, required: ["kind", "claimId", "evidenceIds"], properties: {
      kind: { const: "terminal_claim" }, claimId: EVENT_ID_SCHEMA, evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA,
    } },
  ],
} as const);

const REFLEX_AUDITS_SCHEMA = Object.freeze({ type: "array", maxItems: 32, items: {
  type: "object", additionalProperties: false, required: ["audit", "status", "summary", "evidenceIds"],
  properties: { audit: EVENT_ID_SCHEMA, status: { enum: ["passed", "failed", "unmeasured"] }, summary: EVENT_SUMMARY_SCHEMA, evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA },
} } as const);

export const SEARCH_ENVELOPE_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/search-envelope-1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "profile", "digest"],
  properties: {
    protocol: { const: SEARCH_ENVELOPE_PROTOCOL },
    digest: SHA256_SCHEMA,
    profile: {
      type: "object",
      additionalProperties: false,
      required: ["attemptSafetyCeiling", "nursery", "resources", "seedDerivation"],
      properties: {
        attemptSafetyCeiling: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 128 },
        seedDerivation: { enum: ["sha256-run-digest-frontier-v1", "sha256-case-seed-frontier-v2"] },
        nursery: {
          type: "object",
          additionalProperties: false,
          required: ["minimumAttempts", "saturationWindow", "independentLineages", "challengeInterval"],
          properties: {
            minimumAttempts: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
            saturationWindow: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            independentLineages: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
            challengeInterval: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
          },
        },
        resources: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxMindInvocations", "maxInputTokens", "maxOutputTokens", "maxWallMillis",
            "maxSingleInvocationMillis", "maxGeneratedBytes", "maxForgeCpuMillis", "maxForgeWallMillis",
            "maxMemorySeconds", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes",
            "maxNetworkBytes", "concurrentLineages", "maxTotalAssayCost",
          ],
          properties: {
            maxMindInvocations: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxInputTokens: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxOutputTokens: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxWallMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxSingleInvocationMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxGeneratedBytes: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxForgeCpuMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxForgeWallMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxMemorySeconds: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxWritableBytes: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxWritableInodes: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxArtifactBytes: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            maxNetworkBytes: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            concurrentLineages: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
            maxTotalAssayCost: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          },
        },
      },
    },
  },
} as const);

export const SEAL_RECEIPT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/seal-receipt-1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchDigest", "intentContractDigest"],
  properties: {
    protocol: { const: "jevyr.seal/1" },
    caseId: { type: "string", pattern: "^case_[a-f0-9]{16}$" },
    submissionDigest: SHA256_SCHEMA,
    subjectMaterialCaptureDigest: SHA256_SCHEMA,
    caseDigest: SHA256_SCHEMA,
    runDigest: SHA256_SCHEMA,
    sealedAt: CANONICAL_TIMESTAMP_SCHEMA,
    policyVersion: { type: "string", minLength: 1 },
    policyDigest: SHA256_SCHEMA,
    genomeVersion: { type: "string", minLength: 1 },
    genomeDigest: SHA256_SCHEMA,
    searchDigest: SHA256_SCHEMA,
    intentContractDigest: SHA256_SCHEMA,
  },
} as const);

export const SEALED_CASE_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/sealed-case-1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchEnvelope", "intentContractDigest", "intentContract", "intent", "subjects"],
  properties: {
    protocol: { const: CASE_PROTOCOL },
    caseId: { type: "string", pattern: "^case_[a-f0-9]{16}$" },
    submissionDigest: SHA256_SCHEMA,
    subjectMaterialCaptureDigest: SHA256_SCHEMA,
    caseDigest: SHA256_SCHEMA,
    runDigest: SHA256_SCHEMA,
    sealedAt: CANONICAL_TIMESTAMP_SCHEMA,
    policyVersion: { type: "string", minLength: 1 },
    policyDigest: SHA256_SCHEMA,
    genomeVersion: { type: "string", minLength: 1 },
    genomeDigest: SHA256_SCHEMA,
    searchEnvelope: SEARCH_ENVELOPE_JSON_SCHEMA,
    intentContractDigest: SHA256_SCHEMA,
    intentContract: { type: "object" },
    intent: { type: "object" },
    subjects: { type: "array" },
  },
} as const);

export const SIGNED_RECORD_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/signed-record-1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest", "verdict", "reflex", "memoryInfluences", "crystallizedAt"],
  properties: {
    protocol: { const: RECORD_PROTOCOL },
    caseDigest: SHA256_SCHEMA,
    runDigest: SHA256_SCHEMA,
    policyDigest: SHA256_SCHEMA,
    genomeDigest: SHA256_SCHEMA,
    searchDigest: SHA256_SCHEMA,
    intentContractDigest: SHA256_SCHEMA,
    eventHeadDigest: SHA256_SCHEMA,
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["policyVersion", "intentContractDigest", "evidenceDigest", "integrity", "creation", "embodiment", "judgment", "feasibilityByCandidate", "basis"],
      properties: {
        policyVersion: { type: "string", minLength: 1 },
        intentContractDigest: SHA256_SCHEMA,
        evidenceDigest: SHA256_SCHEMA,
        integrity: { enum: ["VALID", "INVALID"] },
        creation: { enum: ["CONCEIVED", "NO_SURVIVOR", "FAILED"] },
        embodiment: { enum: ["BUILT", "NOT_BUILT", "FAILED"] },
        judgment: { enum: ["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"] },
        selectedCandidateId: EVENT_ID_SCHEMA,
        feasibilityByCandidate: {
          type: "object",
          maxProperties: 256,
          additionalProperties: { enum: ["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"] },
        },
        basis: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "summary", "evidenceIds"],
            properties: {
              code: EVENT_ID_SCHEMA,
              summary: EVENT_SUMMARY_SCHEMA,
              evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA,
              obligationIds: EVENT_REFERENCE_ARRAY_SCHEMA,
              candidateIds: EVENT_REFERENCE_ARRAY_SCHEMA,
            },
          },
        },
      },
    },
    reflex: {
      type: "object",
      additionalProperties: false,
      required: ["loop", "reviewedEvidenceDigest", "intentContractDigest", "challengedNodeIds", "materialFindings", "decision"],
      properties: {
        loop: { enum: [1, 2] },
        reviewedEvidenceDigest: SHA256_SCHEMA,
        intentContractDigest: SHA256_SCHEMA,
        challengedNodeIds: EVENT_REFERENCE_ARRAY_SCHEMA,
        materialFindings: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "summary", "evidenceIds"],
            properties: { code: EVENT_ID_SCHEMA, summary: EVENT_SUMMARY_SCHEMA, evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA },
          },
        },
        decision: { enum: ["confirm", "revise", "repeat_once"] },
        audits: REFLEX_AUDITS_SCHEMA,
      },
    },
    memoryInfluences: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memoryDigest", "influence", "summary", "weight"],
        properties: {
          memoryDigest: SHA256_SCHEMA,
          influence: { enum: ["seeded_hypothesis", "strategy_selected", "calibration_applied"] },
          summary: EVENT_SUMMARY_SCHEMA,
          weight: { type: "number", minimum: 0, maximum: 0.2 },
        },
      },
    },
    crystallizedAt: CANONICAL_TIMESTAMP_SCHEMA,
  },
} as const);

export const TERMINAL_RECEIPT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/terminal-receipt-1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "protocol", "caseId", "caseDigest", "runDigest", "lifecycle", "stage",
    "stageStatus", "lastSequence", "eventHeadDigest", "recordDigest", "artifactIndexDigest", "closedAt",
  ],
  properties: {
    protocol: { const: TERMINAL_PROTOCOL },
    caseId: { type: "string", pattern: "^case_[a-f0-9]{16}$" },
    caseDigest: SHA256_SCHEMA,
    runDigest: SHA256_SCHEMA,
    lifecycle: { enum: ["terminated", "invalid"] },
    stage: { enum: LIFECYCLE_STAGES },
    stageStatus: { enum: ["entered", "working", "completed", "failed", "skipped"] },
    lastSequence: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
    eventHeadDigest: { anyOf: [{ type: "null" }, SHA256_SCHEMA] },
    recordDigest: SHA256_SCHEMA,
    artifactIndexDigest: SHA256_SCHEMA,
    closedAt: CANONICAL_TIMESTAMP_SCHEMA,
  },
  allOf: [
    {
      if: { properties: { lastSequence: { const: 0 } } },
      then: { properties: { eventHeadDigest: { type: "null" } } },
      else: { properties: { eventHeadDigest: SHA256_SCHEMA } },
    },
    {
      if: { properties: { lifecycle: { const: "terminated" } } },
      then: { properties: { stage: { const: "terminate" }, stageStatus: { const: "completed" } } },
      else: { properties: { stageStatus: { const: "failed" } } },
    },
  ],
} as const);

/** JSON Schema for adapters that cannot import TypeScript declarations. Runtime validation remains authoritative. */
export const CASE_SUBMISSION_JSON_SCHEMA = Object.freeze(CASE_SUBMISSION_TYPEBOX);

const SEARCH_RESOURCE_NAMES = [
  "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
  "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
  "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
] as const;

/** Closed schemas for every public event payload, shared by OpenAPI and protocol consumers. */
export const EVENT_PAYLOAD_JSON_SCHEMAS = Object.freeze({
  stageStatus: {
    type: "object",
    additionalProperties: false,
    required: ["stage", "status", "summary"],
    properties: {
      stage: { enum: LIFECYCLE_STAGES },
      status: { enum: ["entered", "working", "completed", "failed", "skipped"] },
      summary: EVENT_SUMMARY_SCHEMA,
      progress: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  claimPublished: {
    type: "object",
    additionalProperties: false,
    required: ["claimId", "statement", "claimType"],
    properties: {
      claimId: EVENT_ID_SCHEMA,
      statement: { type: "string", minLength: 1 },
      claimType: { enum: ["interpretation", "mechanism", "risk", "requirement", "prediction"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      candidateId: EVENT_ID_SCHEMA,
    },
  },
  actionStatus: {
    type: "object",
    additionalProperties: false,
    required: ["actionId", "actionType", "status", "summary"],
    properties: {
      actionId: EVENT_ID_SCHEMA,
      actionType: EVENT_ID_SCHEMA,
      status: { enum: ["requested", "started", "completed", "failed", "denied"] },
      summary: EVENT_SUMMARY_SCHEMA,
      toolId: EVENT_ID_SCHEMA,
      artifactDigests: EVENT_DIGEST_ARRAY_SCHEMA,
      resource: {
        type: "object",
        additionalProperties: false,
        properties: {
          cpuMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          wallMillis: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          bytesRead: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          bytesWritten: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
        },
      },
    },
  },
  evidenceObserved: {
    type: "object",
    additionalProperties: false,
    required: ["evidenceId", "evidenceType", "summary", "contentDigest"],
    properties: {
      evidenceId: EVENT_ID_SCHEMA,
      evidenceType: { enum: ["subject_snapshot", "tool_observation", "sandbox_execution", "original_subject_assertions", "artifact", "model_report", "peer_report", "memory_hint"] },
      summary: EVENT_SUMMARY_SCHEMA,
      contentDigest: SHA256_SCHEMA,
      candidateId: EVENT_ID_SCHEMA,
      assayId: EVENT_ID_SCHEMA,
      supports: EVENT_REFERENCE_ARRAY_SCHEMA,
      refutes: EVENT_REFERENCE_ARRAY_SCHEMA,
      audit: INVESTIGATION_AUDIT_JSON_SCHEMA,
      formalProof: FORMAL_COUNTEREXAMPLE_JSON_SCHEMA,
      originalSubject: {
        type: "object", additionalProperties: false,
        required: ["protocol", "subjectId", "obligationId", "captureDigest", "certificateDigest", "executionReceiptDigest", "kernelDigest"],
        properties: { protocol: { const: "jevyr.original-subject-assertion-binding/1" }, subjectId: EVENT_ID_SCHEMA, obligationId: EVENT_ID_SCHEMA,
          captureDigest: SHA256_SCHEMA, certificateDigest: SHA256_SCHEMA, executionReceiptDigest: SHA256_SCHEMA, kernelDigest: SHA256_SCHEMA },
      },
    },
  },
  candidateStatus: {
    type: "object",
    additionalProperties: false,
    required: ["candidateId", "status", "summary"],
    properties: {
      candidateId: EVENT_ID_SCHEMA,
      status: { enum: ["proposed", "embodied", "invalidated", "survived", "selected"] },
      summary: EVENT_SUMMARY_SCHEMA,
      feasibility: { enum: ["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"] },
      parentIds: EVENT_REFERENCE_ARRAY_SCHEMA,
      artifactDigests: EVENT_DIGEST_ARRAY_SCHEMA,
    },
  },
  assayStatus: {
    type: "object",
    additionalProperties: false,
    required: ["assayId", "status", "critical", "summary"],
    properties: {
      assayId: EVENT_ID_SCHEMA,
      candidateId: EVENT_ID_SCHEMA,
      obligationId: EVENT_ID_SCHEMA,
      status: { enum: ["planned", "running", "passed", "failed", "inconclusive", "blocked"] },
      critical: { type: "boolean" },
      summary: EVENT_SUMMARY_SCHEMA,
      evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA,
      scope: { const: "closed_population" },
      populationIds: EVENT_REFERENCE_ARRAY_SCHEMA,
    },
  },
  reflexCompleted: {
    type: "object",
    additionalProperties: false,
    required: ["loop", "reviewedEvidenceDigest", "intentContractDigest", "challengedNodeIds", "materialFindings", "decision"],
    properties: {
      loop: { enum: [1, 2] },
      reviewedEvidenceDigest: SHA256_SCHEMA,
      intentContractDigest: SHA256_SCHEMA,
      challengedNodeIds: EVENT_REFERENCE_ARRAY_SCHEMA,
      materialFindings: {
        type: "array",
        maxItems: 256,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "summary", "evidenceIds"],
          properties: {
            code: EVENT_ID_SCHEMA,
            summary: EVENT_SUMMARY_SCHEMA,
            evidenceIds: EVENT_REFERENCE_ARRAY_SCHEMA,
          },
        },
      },
      decision: { enum: ["confirm", "revise", "repeat_once"] },
      audits: REFLEX_AUDITS_SCHEMA,
    },
  },
  memoryInfluence: {
    type: "object",
    additionalProperties: false,
    required: ["memoryDigest", "influence", "summary", "weight"],
    properties: {
      memoryDigest: SHA256_SCHEMA,
      influence: { enum: ["seeded_hypothesis", "strategy_selected", "calibration_applied"] },
      summary: EVENT_SUMMARY_SCHEMA,
      weight: { type: "number", minimum: 0, maximum: 0.2 },
    },
  },
  searchStatus: {
    type: "object",
    additionalProperties: false,
    required: ["layer", "status", "attempted", "attemptSafetyCeiling", "resources", "summary"],
    properties: {
      layer: { enum: ["HYPOTHESIS_NURSERY", "ASSAY_ARCHIVE"] },
      status: { enum: ["started", "exploring", "hypothesis_admitted", "archive_changed", "completed", "failed"] },
      attempted: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
      attemptSafetyCeiling: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 128 },
      resources: {
        type: "array",
        minItems: SEARCH_RESOURCE_NAMES.length,
        maxItems: SEARCH_RESOURCE_NAMES.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "used", "ceiling", "measurement"],
          properties: {
            name: { enum: SEARCH_RESOURCE_NAMES },
            used: { anyOf: [{ type: "null" }, { type: "number", minimum: 0 }] },
            ceiling: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
            measurement: { enum: ["MEASURED", "UPPER_BOUND", "DECLARED_ONLY"] },
          },
        },
      },
      candidateId: EVENT_ID_SCHEMA,
      assayId: EVENT_ID_SCHEMA,
      hypothesisNursery: {
        type: "object",
        additionalProperties: false,
        required: ["exactDistinctHypotheses", "scars", "declaredMechanismLabels", "exactYieldAge"],
        properties: {
          exactDistinctHypotheses: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          scars: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          declaredMechanismLabels: { type: "array", items: { type: "string", minLength: 1 } },
          exactYieldAge: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
        },
      },
      assayArchive: {
        type: "object",
        additionalProperties: false,
        required: ["measuredEntries", "occupiedNiches"],
        properties: {
          measuredEntries: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          occupiedNiches: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
          lastMeasuredNovelty: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      termination: { enum: ["HYPOTHESIS_SATURATED", "RESOURCE_EXHAUSTED", "ATTEMPT_CEILING"] },
      summary: EVENT_SUMMARY_SCHEMA,
    },
  },
  kernelStatus: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "summary"],
    properties: {
      operation: { enum: ["sealed", "policy_compiled", "record_crystallized", "signed", "terminated"] },
      summary: EVENT_SUMMARY_SCHEMA,
      artifactDigest: SHA256_SCHEMA,
    },
  },
} as const);

export const CASE_EVENT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://jevyr.local/schema/case-event-1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "caseDigest", "runDigest", "sequence", "priorDigest", "eventDigest", "observedAt", "stage", "kind", "actor", "payload"],
  properties: {
    protocol: { const: EVENT_PROTOCOL },
    caseDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    runDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    sequence: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    priorDigest: { anyOf: [{ type: "null" }, { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }] },
    eventDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    observedAt: CANONICAL_TIMESTAMP_SCHEMA,
    stage: { enum: LIFECYCLE_STAGES },
    kind: { enum: ["stage.status", "claim.published", "action.status", "evidence.observed", "candidate.status", "assay.status", "reflex.completed", "memory.influence", "search.status", "kernel.status"] },
    actor: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind"],
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { enum: ["kernel", "mind", "tool", "peer", "forge", "archivist"] },
        instance: { type: "string" },
      },
    },
    payload: { type: "object" },
  },
  allOf: [
    { if: { properties: { kind: { const: "stage.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.stageStatus } } },
    { if: { properties: { kind: { const: "claim.published" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.claimPublished } } },
    { if: { properties: { kind: { const: "action.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.actionStatus } } },
    { if: { properties: { kind: { const: "evidence.observed" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.evidenceObserved } } },
    { if: { properties: { kind: { const: "candidate.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.candidateStatus } } },
    { if: { properties: { kind: { const: "assay.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.assayStatus } } },
    { if: { properties: { kind: { const: "reflex.completed" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.reflexCompleted } } },
    { if: { properties: { kind: { const: "memory.influence" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.memoryInfluence } } },
    { if: { properties: { kind: { const: "search.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.searchStatus } } },
    { if: { properties: { kind: { const: "kernel.status" } } }, then: { properties: { payload: EVENT_PAYLOAD_JSON_SCHEMAS.kernelStatus } } },
  ],
} as const);
