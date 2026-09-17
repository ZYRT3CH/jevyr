import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { CASE_SUBMISSION_JSON_SCHEMA, CASE_SUBMISSION_TYPEBOX, validateCaseSubmission, type CaseSubmission, type TypeBoxCaseSubmission } from "../src/index.js";
import compiled from "../src/generated-case-validator.js";

describe("TypeBox and standalone Ajv admission", () => {
  it("shares the actual wire schema and inferred type", () => {
    expectTypeOf<TypeBoxCaseSubmission>().toMatchTypeOf<CaseSubmission>();
    expect(CASE_SUBMISSION_JSON_SCHEMA).toBe(CASE_SUBMISSION_TYPEBOX);
    const value = { protocol: "jevyr.case/1", case: { impulse: "Inspect 🧪", subjects: [{ id: "source", kind: "text", locator: "Exact bytes" }] } };
    expect(compiled(value)).toBe(true); expect(validateCaseSubmission(value).ok).toBe(true);
  });
  it("rejects semantic side channels without coercion, defaults, or property removal", () => {
    for (const extra of [{ verdict: "ACCEPT" }, { seed: 123 }, { control: "continue" }]) {
      const value = { protocol: "jevyr.case/1", case: { impulse: "Inspect", ...extra } }, before = JSON.stringify(value);
      expect(compiled(value)).toBe(false); expect(validateCaseSubmission(value).ok).toBe(false); expect(JSON.stringify(value)).toBe(before);
    }
    expect(validateCaseSubmission({ protocol: "jevyr.case/1", case: { impulse: "  " } }).ok).toBe(false);
  });
  it("ships browser-safe generated validation without runtime code generation", async () => {
    const source = await readFile(new URL("../src/generated-case-validator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\brequire\s*\(|\beval\s*\(|new Function/u);
  });
});
