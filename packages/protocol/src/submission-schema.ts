import Type from "typebox";

const text = () => Type.String({ minLength: 1 });
export const CASE_SUBMISSION_TYPEBOX = Type.Object({
  protocol: Type.Literal("jevyr.case/1"),
  case: Type.Object({
    impulse: Type.String({ minLength: 1, maxLength: 100_000 }),
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("audit"), Type.Literal("design")])),
    privacy: Type.Optional(Type.Union([Type.Literal("full_case"), Type.Literal("provider_scoped"), Type.Literal("local_only")])),
    control: Type.Optional(Type.Union([Type.Literal("sovereign"), Type.Literal("juggler")])),
    seed: Type.Optional(text()),
    constraints: Type.Optional(Type.Array(text())),
    requestedAssays: Type.Optional(Type.Array(text())),
    subjects: Type.Optional(Type.Array(Type.Object({
      id: text(),
      kind: Type.Union((["git", "directory", "file", "url", "text", "artifact"] as const).map(value => Type.Literal(value))),
      locator: text(), revision: Type.Optional(text()), mediaType: Type.Optional(text()),
    }, { additionalProperties: false }))),
  }, { additionalProperties: false }),
}, { additionalProperties: false, $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://jevyr.local/schema/case-submission-1.json" });

export type TypeBoxCaseSubmission = Type.Static<typeof CASE_SUBMISSION_TYPEBOX>;
