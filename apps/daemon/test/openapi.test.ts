import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENAPI } from "../src/openapi.js";

test("OpenAPI exposes the exact capture-bound SealReceipt", () => {
  const schema = OPENAPI.components.schemas.SealReceipt;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("subjectMaterialCaptureDigest"));
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());

  const castExample =
    OPENAPI.paths["/v1/cases"].post.responses["202"].content["application/json"].example;
  const readExample =
    OPENAPI.paths["/v1/cases/{caseId}/seal"].get.responses["200"].content["application/json"]
      .example;
  assert.deepEqual(readExample, castExample);
  assert.match(castExample.subjectMaterialCaptureDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(castExample).sort(), [...schema.required].sort());

  const contractSchema = OPENAPI.components.schemas.IntentContract;
  assert.equal(contractSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(contractSchema.properties).sort(),
    [...contractSchema.required].sort(),
  );
  assert.equal(
    OPENAPI.paths["/v1/cases/{caseId}/intent-contract"].get.responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/IntentContract",
  );
});
