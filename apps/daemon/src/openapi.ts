import {
  CASE_EVENT_JSON_SCHEMA,
  CASE_SUBMISSION_JSON_SCHEMA,
  INTENT_COMPILER_VERSION,
  INTENT_CONTRACT_PROTOCOL,
  LIFECYCLE_STAGES,
  SEAL_RECEIPT_JSON_SCHEMA,
  SIGNED_RECORD_JSON_SCHEMA,
  TERMINAL_RECEIPT_JSON_SCHEMA,
} from "@jevyr/protocol";

const digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const caseId = { type: "string", pattern: "^case_[a-f0-9]{16}$" } as const;
const artifactId = { type: "string", pattern: "^artifact_[a-f0-9]{24}$" } as const;
const safeCounter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const airlockChoices = { type: "object", additionalProperties: false, properties: {
  capabilityIds: { type: "array", maxItems: 128, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" } },
  preset: { enum: ["startup", "wild"] }, sandbox: { enum: ["configured", "observe_only"] },
  resourceCeiling: { type: "object", additionalProperties: false, properties: Object.fromEntries([
    "maxMindInvocations", "maxInputTokens", "maxOutputTokens", "maxWallMillis", "maxSingleInvocationMillis", "maxGeneratedBytes", "maxForgeCpuMillis", "maxForgeWallMillis", "maxMemorySeconds", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "maxNetworkBytes", "concurrentLineages", "maxTotalAssayCost",
  ].map(name => [name, safeCounter])) },
} } as const;
const canonicalTimestamp = {
  type: "string",
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
} as const;
const lifecycle = { enum: ["queued", "running", "crystallized", "terminated", "invalid"] } as const;
const stageStatus = { enum: ["entered", "working", "completed", "failed", "skipped"] } as const;
const sealReceiptExample = {
  protocol: "jevyr.seal/1",
  caseId: "case_0123456789abcdef",
  submissionDigest: `sha256:${"1".repeat(64)}`,
  subjectMaterialCaptureDigest: `sha256:${"2".repeat(64)}`,
  caseDigest: `sha256:${"3".repeat(64)}`,
  runDigest: `sha256:${"4".repeat(64)}`,
  sealedAt: "2026-09-04T12:00:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: `sha256:${"5".repeat(64)}`,
  genomeVersion: "jevyr.genome/1",
  genomeDigest: `sha256:${"6".repeat(64)}`,
  searchDigest: `sha256:${"7".repeat(64)}`,
  intentContractDigest: `sha256:${"8".repeat(64)}`,
} as const;

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Jevyr local daemon",
    version: "0.1.0",
    description: "One-way sealed cases with one semantic write (Cast), no continuation input, canonical cursor polling, server-sent public events, and signed terminal closure. Record authentication does not by itself replay persisted evidence.",
  },
  servers: [{ url: "http://127.0.0.1:4317" }],
  components: {
    securitySchemes: { TeamBearer: { type: "http", scheme: "bearer", description: "When configured, every private endpoint requires the startup broker-referenced token. Never pass tokens in URLs." } },
    schemas: {
      ModelConnection: {
        type: "object", additionalProperties: false,
        required: ["id", "label", "provider", "baseUrl", "model", "transport", "remoteDisclosure"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          label: { type: "string", minLength: 1, maxLength: 256 }, provider: { enum: ["ollama", "lm-studio", "openai-compatible"] },
          baseUrl: { type: "string", format: "uri", maxLength: 2048, description: "Canonical trailing-slash base URL, no credentials/query/fragment. Loopback HTTP or HTTPS; remote HTTPS requires case-policy disclosure." },
          model: { type: "string", minLength: 1, maxLength: 256 }, modelFamily: { type: "string", minLength: 1, maxLength: 256 },
          transport: { enum: ["native", "structured"] }, remoteDisclosure: { enum: ["none", "case-policy"] },
          credentialId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Startup-registered reference bound to the exact endpoint origin; never a credential value." },
        },
      },
      ConnectionProfile: {
        type: "object", additionalProperties: false, required: ["protocol", "models", "mcpServerIds"],
        properties: { protocol: { const: "jevyr.connection-profile/1" },
          models: { type: "array", maxItems: 8, items: { $ref: "#/components/schemas/ModelConnection" } },
          mcpServerIds: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
        },
      },
      CaseSubmission: CASE_SUBMISSION_JSON_SCHEMA,
      CaseEvent: CASE_EVENT_JSON_SCHEMA,
      SealReceipt: SEAL_RECEIPT_JSON_SCHEMA,
      DsseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["payloadType", "payload", "signatures"],
        properties: {
          payloadType: { enum: ["application/vnd.jevyr.seal+json", "application/vnd.jevyr.record+json", "application/vnd.jevyr.terminal+json"] },
          payload: { type: "string", contentEncoding: "base64" },
          signatures: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["keyid", "sig"],
              properties: { keyid: digest, sig: { type: "string", contentEncoding: "base64" } },
            },
          },
        },
      },
      CapabilityCard: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "displayName", "version", "transport", "trust", "modalities", "network", "canExecuteTools", "deterministic"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          kind: { enum: ["mind", "tool", "peer"] },
          displayName: { type: "string", minLength: 1, maxLength: 256 },
          version: { type: "string", minLength: 1, maxLength: 256 },
          transport: { enum: ["process", "http", "in-process", "a2a"] },
          trust: { enum: ["inner", "quarantined", "local-deterministic"] },
          modalities: {
            type: "array",
            maxItems: 4,
            uniqueItems: true,
            items: { enum: ["text", "files", "commands", "structured-data"] },
          },
          network: { enum: ["none", "loopback", "provider", "unrestricted"] },
          canExecuteTools: { type: "boolean" },
          deterministic: { type: "boolean" },
          limits: {
            type: "object",
            maxProperties: 256,
            additionalProperties: { oneOf: [{ type: "number" }, { type: "string", maxLength: 4_096 }, { type: "boolean" }] },
          },
        },
      },
      ProbeResult: {
        type: "object",
        additionalProperties: false,
        required: ["available", "observedAt", "latencyMs", "detail"],
        properties: {
          available: { type: "boolean" },
          observedAt: canonicalTimestamp,
          latencyMs: { type: "number", minimum: 0 },
          version: { type: "string" },
          detail: { type: "string" },
        },
      },
      Capabilities: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "adapters"],
        properties: {
          protocol: { const: "jevyr.capabilities/1" },
          adapters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["capability", "probe"],
              properties: {
                capability: { $ref: "#/components/schemas/CapabilityCard" },
                probe: { $ref: "#/components/schemas/ProbeResult" },
              },
            },
          },
        },
      },
      ReadinessProbe: {
        type: "object",
        additionalProperties: false,
        required: ["status", "observedAt", "latencyMs"],
        properties: {
          status: { enum: ["available", "unavailable", "failed", "timed-out", "invalid"] },
          observedAt: canonicalTimestamp,
          latencyMs: safeCounter,
        },
      },
      Readiness: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "ready", "scope", "observedAt", "semanticContinuation", "models", "forge", "assays", "blockers"],
        properties: {
          protocol: { const: "jevyr.readiness/1" },
          ready: { type: "boolean" },
          scope: { const: "infrastructure" },
          observedAt: canonicalTimestamp,
          semanticContinuation: { const: false },
          models: {
            type: "object",
            additionalProperties: false,
            required: ["status", "mode", "configuredCount", "availableCount", "reasoningConfiguredCount", "reasoningAvailableCount", "adapters"],
            properties: {
              status: { enum: ["ready", "template-only", "unavailable"] },
              mode: { enum: ["template-only", "local", "remote", "mixed", "configured-unavailable"] },
              configuredCount: safeCounter,
              availableCount: safeCounter,
              reasoningConfiguredCount: safeCounter,
              reasoningAvailableCount: safeCounter,
              adapters: {
                type: "array",
                maxItems: 256,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "role", "configured", "transport", "network", "probe"],
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 256 },
                    role: { enum: ["template", "reasoning"] },
                    configured: { const: true },
                    transport: { enum: ["process", "http", "in-process", "a2a"] },
                    network: { enum: ["none", "loopback", "provider", "unrestricted"] },
                    probe: { $ref: "#/components/schemas/ReadinessProbe" },
                  },
                },
              },
            },
          },
          forge: {
            type: "object",
            additionalProperties: false,
            required: ["id", "mode", "configured", "status", "canExecuteTools", "network", "probe", "evidenceAuthority", "substrate", "usable"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 256 },
              mode: { enum: ["docker", "trusted-host", "observe-only", "opaque"] },
              configured: { const: true },
              status: { enum: ["ready", "substrate-unavailable", "execution-disabled", "probe-unavailable", "observe-only", "diagnostic-only", "opaque"] },
              canExecuteTools: { type: "boolean" },
              network: { enum: ["none", "loopback", "provider", "unrestricted"] },
              probe: { $ref: "#/components/schemas/ReadinessProbe" },
              evidenceAuthority: { enum: ["verified-docker", "diagnostic-only", "none"] },
              substrate: {
                type: "object",
                additionalProperties: false,
                required: ["status", "immutableImageId"],
                properties: {
                  status: { enum: ["resolved", "unavailable", "not-applicable", "opaque"] },
                  immutableImageId: { oneOf: [digest, { type: "null" }] },
                },
              },
              usable: { type: "boolean" },
            },
          },
          assays: {
            type: "object",
            additionalProperties: false,
            required: ["status", "mode", "count", "ids", "frontierDigest", "caseApplicability"],
            properties: {
              status: { enum: ["admitted", "empty"] },
              mode: { enum: ["empty", "comparative-only", "case-binding-configured", "mixed"] },
              count: safeCounter,
              ids: {
                type: "array",
                maxItems: 256,
                uniqueItems: true,
                items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
              },
              frontierDigest: digest,
              caseApplicability: { const: "case-dependent" },
            },
          },
          blockers: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "component", "detail"],
              properties: {
                code: {
                  enum: [
                    "models.template-only",
                    "models.reasoning-unavailable",
                    "forge.observe-only",
                    "forge.diagnostic-only",
                    "forge.opaque",
                    "forge.substrate-unavailable",
                    "forge.execution-disabled",
                    "forge.probe-unavailable",
                    "assays.empty",
                  ],
                },
                component: { enum: ["models", "forge", "assays"] },
                detail: { type: "string", minLength: 1, maxLength: 512 },
              },
            },
          },
        },
      },
      PublicTrustBundle: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "keys"],
        properties: {
          protocol: { const: "jevyr.trust-bundle/1" },
          keys: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["keyId", "algorithm", "publicKeyPem", "payloadTypes"],
              properties: {
                keyId: digest,
                algorithm: { const: "Ed25519" },
                publicKeyPem: { type: "string", pattern: "^-----BEGIN PUBLIC KEY-----" },
                payloadTypes: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  uniqueItems: true,
                  items: { enum: ["application/vnd.jevyr.seal+json", "application/vnd.jevyr.record+json", "application/vnd.jevyr.terminal+json"] },
                },
              },
            },
          },
        },
      },
      SignedRecord: SIGNED_RECORD_JSON_SCHEMA,
      TerminalReceipt: TERMINAL_RECEIPT_JSON_SCHEMA,
      IntentContract: {
        type: "object",
        additionalProperties: false,
        required: [
          "protocol",
          "compilerVersion",
          "originalImpulse",
          "originalImpulseDigest",
          "goal",
          "subjectIds",
          "explicitConstraints",
          "requestedAssays",
          "successConditions",
          "failureConditions",
          "ambiguities",
          "alternativeInterpretations",
          "criticalObligations",
          "digest",
        ],
        properties: {
          protocol: { const: INTENT_CONTRACT_PROTOCOL },
          compilerVersion: { const: INTENT_COMPILER_VERSION },
          originalImpulse: { type: "string", minLength: 1 },
          originalImpulseDigest: digest,
          goal: { type: "object" },
          subjectIds: { type: "array", items: { type: "string" } },
          explicitConstraints: { type: "array", items: { type: "object" } },
          requestedAssays: { type: "array", items: { type: "string" } },
          successConditions: { type: "array", items: { type: "object" } },
          failureConditions: { type: "array", items: { type: "object" } },
          ambiguities: { type: "array", items: { type: "object" } },
          alternativeInterpretations: {
            type: "array",
            items: { type: "object" },
          },
          criticalObligations: {
            type: "array",
            minItems: 1,
            items: { type: "object" },
          },
          digest,
        },
      },
      DescriptorArtifact: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "kind", "digest", "descriptor"],
        properties: {
          protocol: { const: "jevyr.descriptor-artifact/1" },
          kind: { enum: ["policy", "genome", "search"] },
          digest,
          descriptor: {},
        },
      },
      PolicyDescriptorArtifact: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "kind", "digest", "descriptor"],
        properties: {
          protocol: { const: "jevyr.descriptor-artifact/1" },
          kind: { const: "policy" },
          digest,
          descriptor: {
            type: "object",
            additionalProperties: false,
            required: ["protocol", "version", "policy", "subjectSnapshots"],
            properties: {
              protocol: { const: "jevyr.policy-descriptor/1" },
              version: { type: "string", minLength: 1 },
              policy: { type: "object" },
              subjectSnapshots: { type: "object" },
            },
          },
        },
      },
      CasePolicyDescriptor: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "artifact"],
        properties: {
          protocol: { const: "jevyr.case-policy-descriptor/1" },
          caseId,
          caseDigest: digest,
          runDigest: digest,
          policyDigest: digest,
          artifact: { $ref: "#/components/schemas/PolicyDescriptorArtifact" },
        },
      },
      ArtifactMeta: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "id", "caseId", "name", "mediaType", "size", "digest", "createdAt"],
        properties: {
          protocol: { const: "jevyr.artifact/1" },
          id: artifactId,
          caseId,
          name: { type: "string", minLength: 1, maxLength: 255 },
          mediaType: { type: "string", minLength: 3, maxLength: 200 },
          size: safeCounter,
          digest,
          createdAt: canonicalTimestamp,
        },
      },
      ArtifactList: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "caseId", "artifacts"],
        properties: {
          protocol: { const: "jevyr.artifacts/1" },
          caseId,
          artifacts: { type: "array", items: { $ref: "#/components/schemas/ArtifactMeta" } },
        },
      },
      LiveCaseStatus: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "caseDigest", "runDigest", "lifecycle", "stage", "stageStatus", "lastSequence", "headDigest", "updatedAt"],
        properties: {
          protocol: { const: "jevyr.status/1" },
          caseDigest: digest,
          runDigest: digest,
          lifecycle,
          stage: { enum: LIFECYCLE_STAGES },
          stageStatus,
          lastSequence: safeCounter,
          headDigest: { anyOf: [{ type: "null" }, digest] },
          updatedAt: canonicalTimestamp,
        },
      },
      LiveEventBatch: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "caseDigest", "runDigest", "afterSequence", "throughSequence", "headDigest", "caughtUp", "events", "polledAt"],
        properties: {
          protocol: { const: "jevyr.live/1" },
          caseDigest: digest,
          runDigest: digest,
          afterSequence: safeCounter,
          throughSequence: safeCounter,
          headDigest: { anyOf: [{ type: "null" }, digest] },
          caughtUp: { type: "boolean" },
          events: { type: "array", items: { $ref: "#/components/schemas/CaseEvent" } },
          polledAt: canonicalTimestamp,
        },
      },
    },
  },
  paths: {
    "/v1/settings/connections": {
      get: { summary: "Read active and next-start connection profiles",
        description: "Local loopback Host/peer only; a supplied Origin must exactly match the daemon or configured application origin. Bearer authentication applies when configured. Credential values and process commands are never returned.",
        responses: { "200": { description: "jevyr.connections-view/1; immutable active snapshot, saved revision, public credential/MCP catalogs and configuration permissions" }, "403": { description: "Host, peer or Origin refused" } } },
      put: { summary: "Save a profile for the next daemon startup", "x-jevyr-semantic-write": false,
        description: "Requires an explicit permitted browser Origin plus existing HTTP authentication. Replaces HTTP model selection and registered MCP selection; native agents remain configured. Does not change active adapters or sealed Cases.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["revision", "profile"], properties: {
          revision: { type: "integer", minimum: 0, maximum: 2147483647 }, profile: { $ref: "#/components/schemas/ConnectionProfile" },
        } } } } }, responses: { "200": { description: "Full connections view; saved revision increased by one" }, "400": { description: "Invalid profile, unregistered credential destination or MCP server" }, "403": { description: "Host, peer or Origin refused" }, "409": { description: "Revision conflict, busy or unsafe profile storage" } } },
    },
    "/v1/settings/connections/models": {
      post: { summary: "Request bounded model-list metadata without inference", "x-jevyr-semantic-write": false,
        description: "Same local configuration access rules. GET models only, no redirects/cookies/proxy, five-second deadline, 256 KiB response ceiling, at most 128 returned model IDs. Remote DNS is pinned to validated public addresses. Availability does not establish output quality.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["connection"], properties: { connection: { $ref: "#/components/schemas/ModelConnection" } } } } } },
        responses: { "200": { description: "jevyr.connection-model-list/1 with explicit availability/status code and bounded IDs" }, "400": { description: "Invalid endpoint or credential binding" }, "403": { description: "Local access refused" }, "429": { description: "Two metadata tests already in flight" } } },
    },
    "/v1/settings/connections/mcp-test": {
      post: { summary: "Initialize and list metadata from a registered MCP server", "x-jevyr-semantic-write": false,
        description: "Only an existing operator-registered server ID is accepted. Uses its captured command/environment with a five-second bound; never invokes a discovered tool or expands its sealed allowlist.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["serverId"], properties: { serverId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } } } } } },
        responses: { "200": { description: "jevyr.connection-mcp-test/1, metadata availability only" }, "400": { description: "Server not registered" }, "403": { description: "Local access refused" }, "429": { description: "Two metadata tests already in flight" } } },
    },
    "/v1/drafts": {
      post: {
        summary: "Create an editable pre-seal Airlock draft",
        "x-jevyr-semantic-write": false,
        description: "No Case or model call is created. Missing seed becomes 256 random bits; local control defaults to Juggler. These values remain editable until Seal.",
        requestBody: { required: true, content: { "application/json": { schema: CASE_SUBMISSION_JSON_SCHEMA } } },
        responses: { "201": { description: "Draft with revision, intent preview, exact startup policy, capabilities, and ceilings" }, "429": { description: "Bounded draft capacity exhausted" } },
      },
    },
    "/v1/drafts/{draftId}": {
      parameters: [{ name: "draftId", in: "path", required: true, schema: { type: "string", pattern: "^draft_[a-f0-9]{32}$" } }],
      get: { summary: "Inspect a draft and its current admission state", responses: { "200": { description: "Airlock draft" } } },
      patch: {
        summary: "Replace the exact current DRAFT revision", "x-jevyr-semantic-write": false,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["revision", "submission"], properties: { revision: { type: "integer", minimum: 1, maximum: 32 }, submission: CASE_SUBMISSION_JSON_SCHEMA, choices: airlockChoices } } } } },
        responses: { "200": { description: "New revision and recomputed intent preview" }, "409": { description: "Stale revision, concurrent edit, or sealing has closed editing" } },
      },
    },
    "/v1/drafts/{draftId}/seal": {
      post: {
        summary: "Cast the exact reviewed draft once", "x-jevyr-admission": "cast",
        description: "Uses the same Cast implementation. A durable seal claim closes editing before admission. Interrupted admission is never automatically retried.",
        parameters: [{ name: "draftId", in: "path", required: true, schema: { type: "string", pattern: "^draft_[a-f0-9]{32}$" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["revision", "policyDigest"], properties: { revision: { type: "integer", minimum: 1, maximum: 32 }, policyDigest: digest } } } } },
        responses: { "202": { description: "Sealed draft and capture-bound Seal receipt" }, "409": { description: "Revision or policy changed, or the draft has already entered sealing" } },
      },
    },
    "/v1/cases/{caseId}/abort": {
      post: {
        summary: "Emergency abort to INVALID", "x-jevyr-semantic-write": false,
        description: "Accepts no text or semantic fields. Every accepted abort invalidates the Case and closes it without resume. Signing closes abort admission; too-late requests cannot alter an immutable Record.",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, maxProperties: 0 } } } },
        responses: { "202": { description: "Abort accepted; observe signed INVALID terminal closure" }, "409": { description: "Abort admission is already closed" } },
      },
    },
    "/v1/cases/{caseId}/metabolism": {
      get: { summary: "Read currently calibrated additive Juggler offers and their signed receipt history",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        description: "The Seal binds a separate additive allowance and a dedicated metabolic signer. A kind without empirical calibration is never exposed. Offers include bounded quantity, promised effect, per-unit cost ceilings, calibration scope and intervals.",
        responses: { "200": { description: "jevyr.metabolic-offers/1, including the complete ordered DSSE grant history" }, "409": { description: "Work admission is closed" } } },
    },
    "/v1/cases/{caseId}/sealed-case": {
      get: { summary: "Reveal the exact normalized sealed Case and locked seed",
        description: "Includes original normalized subjects and locators, privacy, control, intent contract, Genome and search bindings. The consumer must validate the Case identity and compare every receipt field with the authenticated Seal. Protected by team bearer access when configured.",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "Canonical jevyr.case/1 SealedCase" }, "404": { description: "Case unavailable" } } },
    },
    "/v1/cases/{caseId}/attestations": {
      get: { summary: "Read separate SLSA production and in-toto advisory DSSE attestations",
        description: "Fixed derived payloads authenticate the canonical Record and its production inputs. They grant no verdict or governance authority and assert no SLSA certification level.",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "jevyr.run-attestations/1 with two distinct in-toto DSSE envelopes" }, "404": { description: "Unavailable or historical unmarked Case" } } },
    },
    "/v1/reproductions": {
      post: { summary: "Cast a new Case from authenticated frozen subject bytes", "x-jevyr-admission": "cast", "x-jevyr-semantic-write": false,
        description: "Requires a closed Sovereign Case and the identical admitted policy, Genome, provider and search configuration. No original locator is recaptured. The original Case stays immutable; provider seed enforcement remains explicitly classified.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["sourceCaseId", "seed"], properties: { sourceCaseId: caseId, seed: { enum: ["same", "new"] } } } } } },
        responses: { "202": { description: "New Case Seal receipt" }, "409": { description: "Frozen source or exact execution configuration is unavailable" } } },
    },
    "/runs/{caseId}/metabolism": {
      post: { summary: "Add an offered dose to a Juggler run", "x-jevyr-semantic-write": false,
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["ballId", "quantity"], properties: { ballId: { type: "string", pattern: "^ball_[A-Za-z0-9_-]{43}$" }, quantity: { type: "integer", minimum: 1, maximum: 64 } } } } } },
        responses: { "200": { description: "Signed sequenced grant; same admission contract as /v1/cases/{caseId}/metabolism/redeem" }, "405": { description: "Sovereign run" }, "409": { description: "Offer unavailable" } } },
    },
    "/v1/cases/{caseId}/metabolism/redeem": {
      post: { summary: "Add exactly an offered calibrated dose", "x-jevyr-semantic-write": false,
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["ballId", "quantity"], properties: {
          ballId: { type: "string", pattern: "^ball_[A-Za-z0-9_-]{43}$" }, quantity: { type: "integer", minimum: 1, maximum: 64 },
        } } } } },
        description: "The dedicated application/vnd.jevyr.metabolism-receipt+json DSSE is persisted, published in the artifact inventory, and linked in the ledger before additional work can spend it. The original baseline, capabilities, obligations and verdict authority never change.",
        responses: { "200": { description: "jevyr.metabolism-redemption/1 with receipt and dedicated DSSE envelope" }, "409": { description: "Offer closed, unavailable, or beyond its calibrated allowance" } } },
    },
    "/": {
      get: {
        summary: "Discover the local daemon's read surfaces and one Cast endpoint",
        responses: { "200": { description: "Daemon identity, links, and semanticContinuation=false" } },
      },
    },
    "/health": {
      get: {
        summary: "Read local daemon liveness",
        responses: { "200": { description: "Current daemon time and ok status" } },
      },
    },
    "/openapi.json": {
      get: {
        summary: "Read this OpenAPI contract",
        responses: { "200": { description: "OpenAPI 3.1 document" } },
      },
    },
    "/v1/capabilities": {
      get: {
        summary: "Read snapshotted adapter capabilities and sanitized current probes",
        description: "Probe detail is daemon-authored and never includes provider errors, command output, credentials, or filesystem paths.",
        responses: { "200": { description: "Versioned adapter capability report", content: { "application/json": { schema: { $ref: "#/components/schemas/Capabilities" } } } } },
      },
    },
    "/v1/readiness": {
      get: {
        summary: "Probe infrastructure readiness without exposing provider diagnostics",
        description: "Reports configured versus available reasoning minds, verified Docker Forge usability, and the compile-admitted Assay Frontier. It does not claim that an assay applies to or proves any future Case.",
        responses: { "200": { description: "Sanitized live infrastructure readiness", content: { "application/json": { schema: { $ref: "#/components/schemas/Readiness" } } } } },
      },
    },
    "/v1/trust": {
      get: {
        summary: "Read public Ed25519 verification keys",
        description: "Returns only public key material. The daemon never exposes a private signing key or its path.",
        responses: { "200": { description: "Versioned Jevyr public trust bundle", content: { "application/json": { schema: { $ref: "#/components/schemas/PublicTrustBundle" } } } } },
      },
    },
    "/v1/genome-lab": {
      get: {
        summary: "Inspect the startup-bound Genome and quarantined offspring",
        description: "Read-only public selection, proposal digests, benchmark and damage evidence. Promotion requires governance outside the sealed Case interface.",
        responses: { "200": { description: "jevyr.genome-lab/1; at most 256 validated offspring and an explicit truncated flag" } },
      },
    },
    "/v1/cases": {
      post: {
        summary: "Cast and seal a new case",
        "x-jevyr-semantic-write": true,
        description: "The only semantic write. A successful Cast closes the airlock; no message, input, or continuation endpoint exists for that Case.",
        requestBody: { required: true, content: {
          "application/json": { schema: { $ref: "#/components/schemas/CaseSubmission" } },
          "multipart/form-data": { schema: { type: "object", required: ["case"], properties: { case: { type: "string", contentMediaType: "application/json", description: "Complete CaseSubmission JSON; optional subject:<id> UTF-8 uploads expand declared text locators upload:<id> before Seal." } } } },
        } },
        responses: {
          "202": {
            description: "Canonical SealReceipt; Location identifies the live status resource",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SealReceipt" }, example: sealReceiptExample } },
          },
        },
      },
    },
    "/v1/cases/{caseId}": {
      get: {
        summary: "Read canonical live case status without steering the sealed run",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "LiveCaseStatus", content: { "application/json": { schema: { $ref: "#/components/schemas/LiveCaseStatus" } } } }, "404": { description: "Unknown case" } },
      },
    },
    "/v1/cases/{caseId}/vouchers": {
      get: {
        summary: "Read currently offered opaque Juggler vouchers",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "Run-bound offers while the sealed Juggler scheduler checkpoint is open" }, "405": { description: "Sovereign Case" }, "409": { description: "Scheduler checkpoint closed" } },
      },
    },
    "/v1/cases/{caseId}/vouchers/redeem": {
      post: {
        summary: "Redeem one server-issued opaque resource voucher",
        "x-jevyr-semantic-write": false,
        description: "No text, resource values, capabilities, approvals or verdicts are accepted. One use before the scheduler checkpoint, within the sealed resource envelope.",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["voucher"], properties: { voucher: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } } } } } },
        responses: { "200": { description: "Digest-bound Juggler receipt with verdictAuthority=none" }, "400": { description: "Non-opaque or extra input" }, "405": { description: "Sovereign Case" }, "409": { description: "Voucher spent, unknown, or checkpoint closed" } },
      },
    },
    "/v1/cases/{caseId}/events": {
      get: {
        summary: "Cursor poll canonical public events",
        parameters: [
          { name: "caseId", in: "path", required: true, schema: caseId },
          { name: "after", in: "query", schema: safeCounter, description: "Zero means before the first 1-based event." },
          { name: "cursor", in: "query", schema: safeCounter, description: "Compatibility alias for after; if both occur they must be equal." },
          { name: "waitMs", in: "query", schema: { type: "integer", minimum: 0, maximum: 30000 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 2000 } },
        ],
        responses: {
          "200": { description: "LiveEventBatch", content: { "application/json": { schema: { $ref: "#/components/schemas/LiveEventBatch" } } } },
          "409": { description: "Requested cursor is beyond the current append-only ledger" },
        },
      },
    },
    "/v1/cases/{caseId}/events/stream": {
      get: {
        summary: "Stream default-message CaseEvents over SSE; resumes from canonical numeric Last-Event-ID",
        description: "Read-only observation. Last-Event-ID supersedes the initial after query on browser-managed reconnects.",
        parameters: [
          { name: "caseId", in: "path", required: true, schema: caseId },
          { name: "after", in: "query", schema: safeCounter, description: "Initial cursor when Last-Event-ID is absent." },
          { name: "Last-Event-ID", in: "header", schema: safeCounter, description: "Last accepted event sequence; takes precedence over after." },
        ],
        responses: {
          "200": { description: "text/event-stream" },
          "409": { description: "Requested cursor is beyond the current append-only ledger" },
        },
      },
    },
    "/v1/cases/{caseId}/seal": {
      get: {
        summary: "Read the canonical SealReceipt",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: {
          "200": {
            description: "SealReceipt",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SealReceipt" }, example: sealReceiptExample } },
          },
        },
      },
    },
    "/v1/cases/{caseId}/seal/envelope": {
      get: {
        summary: "Read the DSSE envelope for the SealReceipt",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "DSSE envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/DsseEnvelope" } } } } },
      },
    },
    "/v1/cases/{caseId}/record": {
      get: {
        summary: "Read the canonical terminal SignedRecord",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "Structurally canonical but unauthenticated Record payload. Authenticate it with the envelope endpoint; signature and Seal provenance do not replay persisted evidence.", content: { "application/json": { schema: { $ref: "#/components/schemas/SignedRecord" } } } }, "409": { description: "Record not signed yet" } },
      },
    },
    "/v1/cases/{caseId}/intent-contract": {
      get: {
        summary: "Read the digest-bound replay contract",
        description:
          "Returns the exact deterministic IntentContract whose digest is authenticated by the SealReceipt and crystallized Record. It is data for replay, never semantic continuation.",
        parameters: [
          {
            name: "caseId",
            in: "path",
            required: true,
            schema: caseId,
          },
        ],
        responses: {
          "200": {
            description: "Canonical IntentContract",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/IntentContract" },
              },
            },
          },
          "404": { description: "Unknown case" },
        },
      },
    },
    "/v1/cases/{caseId}/policy-descriptor": {
      get: {
        summary: "Read the Case-bound policy descriptor for independent replay",
        description:
          "Returns the content-addressed policy descriptor selected by the sealed Case. Clients must bind policyDigest to an authenticated SealReceipt or crystallized Record before trusting it.",
        parameters: [
          {
            name: "caseId",
            in: "path",
            required: true,
            schema: caseId,
          },
        ],
        responses: {
          "200": {
            description: "Case and run scoped content-addressed policy descriptor",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CasePolicyDescriptor" },
              },
            },
          },
          "404": { description: "Unknown Case or missing descriptor" },
        },
      },
    },
    "/v1/cases/{caseId}/record/envelope": {
      get: {
        summary: "Read the DSSE envelope for the Record",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: { "200": { description: "DSSE envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/DsseEnvelope" } } } }, "409": { description: "Record not signed yet" } },
      },
    },
    "/v1/cases/{caseId}/terminal": {
      get: {
        summary: "Read the signed closure payload for the complete terminal ledger",
        description: "Binds the exact terminal event head, final status projection, canonical Record digest, and complete canonical artifact-index digest. Authenticate it with the terminal envelope and the same externally trusted key used for the Seal and Record.",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: {
          "200": { description: "TerminalReceipt", content: { "application/json": { schema: { $ref: "#/components/schemas/TerminalReceipt" } } } },
          "409": { description: "Terminal closure is not signed yet" },
        },
      },
    },
    "/v1/cases/{caseId}/terminal/envelope": {
      get: {
        summary: "Read the DSSE envelope for the terminal closure",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: {
          "200": { description: "DSSE terminal envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/DsseEnvelope" } } } },
          "409": { description: "Terminal closure is not signed yet" },
        },
      },
    },
    "/v1/cases/{caseId}/artifacts": {
      get: {
        summary: "List content-addressed exported Case artifacts",
        parameters: [{ name: "caseId", in: "path", required: true, schema: caseId }],
        responses: {
          "200": { description: "Exact Case-bound artifact index", content: { "application/json": { schema: { $ref: "#/components/schemas/ArtifactList" } } } },
          "404": { description: "Unknown Case" },
        },
      },
    },
    "/v1/cases/{caseId}/artifacts/{artifactId}": {
      get: {
        summary: "Read exact bytes for one indexed content-addressed artifact",
        description: "Clients must bind the artifact to the Case index, verify content-type, content-length, and x-jevyr-digest, then hash the complete body before treating bytes as verified.",
        parameters: [
          { name: "caseId", in: "path", required: true, schema: caseId },
          { name: "artifactId", in: "path", required: true, schema: artifactId },
        ],
        responses: {
          "200": {
            description: "Immutable artifact bytes",
            headers: {
              "content-type": { required: true, schema: { type: "string" } },
              "content-length": { required: true, schema: safeCounter },
              "x-jevyr-digest": { required: true, schema: digest },
              "content-disposition": { required: true, schema: { type: "string" } },
              "cache-control": { required: true, schema: { const: "private, immutable" } },
            },
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          "404": { description: "Artifact is not indexed for this Case" },
        },
      },
    },
  },
} as const;
