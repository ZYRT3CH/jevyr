# Shared protocol validation

Case admission uses a TypeBox schema shared with OpenAPI and transport clients. Its inferred TypeScript type matches the public Case submission contract. Ajv 2020 compiles that schema at build time into a standalone validator; the browser and Worker bundles do not compile code dynamically. Both libraries are pinned in the protocol package and lockfile.

Every Cast passes the generated validator as well as the existing semantic checks. Validation does not coerce values, insert defaults, delete properties, or allow a desired verdict or continuation field. Semantic checks still handle constraints JSON Schema alone cannot express, including duplicate subject identities and meaningful nonempty text. Signed Records, ledger events, evidence, and cross-digest relationships retain their dedicated closed schemas and semantic validators.

`pnpm --filter @jevyr/protocol build` regenerates the validator before compiling TypeScript. The generated file is checked in with its source schema so source-mode tests can run without a prior build. Protocol tests cover the shared wire schema, malformed inputs, nonmutation, and absence of runtime `eval`, `require`, or `new Function` in the generated validator.

The implementation follows the primary [TypeBox documentation](https://github.com/sinclairzx81/typebox) and [Ajv JSON Schema documentation](https://ajv.js.org/json-schema.html). This is schema validation; it does not grant a provider or schema compiler verdict authority.
