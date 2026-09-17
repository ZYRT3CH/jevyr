import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENAPI } from "../src/openapi.js";

const exactSchema = (schema: {
  readonly additionalProperties: boolean;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}) => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
};

test("OpenAPI is a closed projection of the canonical status, page, Seal, Record, policy, and artifact contracts", () => {
  exactSchema(OPENAPI.components.schemas.SealReceipt);
  exactSchema(OPENAPI.components.schemas.SignedRecord);
  exactSchema(OPENAPI.components.schemas.TerminalReceipt);
  exactSchema(OPENAPI.components.schemas.LiveCaseStatus);
  exactSchema(OPENAPI.components.schemas.LiveEventBatch);
  exactSchema(OPENAPI.components.schemas.CasePolicyDescriptor);
  exactSchema(OPENAPI.components.schemas.PolicyDescriptorArtifact);
  exactSchema(OPENAPI.components.schemas.ArtifactMeta);
  exactSchema(OPENAPI.components.schemas.ArtifactList);

  assert.ok(OPENAPI.components.schemas.SignedRecord.required.includes("intentContractDigest"));
  assert.equal(OPENAPI.components.schemas.SignedRecord.properties.verdict.additionalProperties, false);
  const reflex = OPENAPI.components.schemas.SignedRecord.properties.reflex;
  assert.equal(reflex.additionalProperties, false);
  assert.deepEqual(Object.keys(reflex.properties).sort(), [...reflex.required, "audits"].sort());
  exactSchema(OPENAPI.components.schemas.SignedRecord.properties.memoryInfluences.items);
  const basis = OPENAPI.components.schemas.SignedRecord.properties.verdict.properties.basis.items;
  assert.equal(basis.additionalProperties, false);
  assert.deepEqual(Object.keys(basis.properties).sort(), [...basis.required, "obligationIds", "candidateIds"].sort());
  assert.equal(OPENAPI.components.schemas.SignedRecord.properties.crystallizedAt.pattern, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
  assert.equal(OPENAPI.components.schemas.LiveCaseStatus.properties.lastSequence.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(OPENAPI.components.schemas.TerminalReceipt.properties.lastSequence.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(OPENAPI.components.schemas.LiveEventBatch.properties.afterSequence.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(OPENAPI.components.schemas.LiveEventBatch.properties.throughSequence.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(OPENAPI.components.schemas.ArtifactMeta.properties.size.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(OPENAPI.components.schemas.PolicyDescriptorArtifact.properties.kind.const, "policy");
  exactSchema(OPENAPI.components.schemas.PolicyDescriptorArtifact.properties.descriptor);
});

test("OpenAPI binds every event discriminator to a closed payload and publishes the 128-digit attempt guard", () => {
  const event = OPENAPI.components.schemas.CaseEvent;
  assert.equal(event.properties.sequence.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(event.allOf.length, event.properties.kind.enum.length);
  for (const rule of event.allOf) {
    assert.equal(rule.then.properties.payload.additionalProperties, false);
  }
  const searchRule = event.allOf.find((rule) => rule.if.properties.kind.const === "search.status");
  assert.ok(searchRule);
  assert.equal(searchRule.then.properties.payload.properties.attemptSafetyCeiling.maxLength, 128);
  assert.equal(searchRule.then.properties.payload.properties.attempted.maximum, Number.MAX_SAFE_INTEGER);
});

test("OpenAPI limits semantic admission to Cast and the exact reviewed draft Seal", () => {
  const paths = OPENAPI.paths as unknown as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const operations = Object.entries(paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map((method) => [path, method] as const),
  );
  assert.deepEqual(operations.filter(([path, method]) => method !== "get" && (paths[path]?.[method] as Record<string, unknown>)["x-jevyr-semantic-write"] !== false), [["/v1/drafts/{draftId}/seal", "post"], ["/v1/cases", "post"]]);
  assert.equal((paths["/v1/cases/{caseId}/vouchers/redeem"]?.post as Record<string, unknown>)["x-jevyr-semantic-write"], false);
  assert.equal(Object.keys(paths).some((path) => /(?:continue|messages?|input)/u.test(path)), false);
  assert.ok(paths["/"]?.get);
  assert.ok(paths["/health"]?.get);
  assert.ok(paths["/openapi.json"]?.get);
  assert.ok(paths["/v1/capabilities"]?.get);
  assert.ok(paths["/v1/readiness"]?.get);
  assert.ok(paths["/v1/cases/{caseId}/artifacts/{artifactId}"]?.get);
  assert.ok(paths["/v1/cases/{caseId}/terminal"]?.get);
  assert.ok(paths["/v1/cases/{caseId}/terminal/envelope"]?.get);

  const payloadTypes = OPENAPI.components.schemas.PublicTrustBundle.properties.keys.items.properties.payloadTypes;
  assert.equal(payloadTypes.minItems, 3);
  assert.equal(payloadTypes.maxItems, 3);
  assert.deepEqual(payloadTypes.items.enum, [
    "application/vnd.jevyr.seal+json",
    "application/vnd.jevyr.record+json",
    "application/vnd.jevyr.terminal+json",
  ]);

  const description = OPENAPI.info.description.toLowerCase();
  assert.match(description, /one semantic write/u);
  assert.match(description, /no continuation/u);
  assert.match(description, /does not by itself replay persisted evidence/u);
});

test("OpenAPI requires artifact verification headers and documents both polling cursor names", () => {
  const artifact = OPENAPI.paths["/v1/cases/{caseId}/artifacts/{artifactId}"].get.responses["200"];
  assert.deepEqual(Object.keys(artifact.headers).sort(), [
    "cache-control",
    "content-disposition",
    "content-length",
    "content-type",
    "x-jevyr-digest",
  ]);
  assert.ok(Object.values(artifact.headers).every((header) => header.required));

  const polling = OPENAPI.paths["/v1/cases/{caseId}/events"].get.parameters;
  assert.deepEqual(
    polling.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name),
    ["after", "cursor", "waitMs", "limit"],
  );
  assert.equal(polling[1]?.schema.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(polling[2]?.schema.maximum, Number.MAX_SAFE_INTEGER);
});
