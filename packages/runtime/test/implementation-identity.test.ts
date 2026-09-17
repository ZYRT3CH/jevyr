import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256Digest } from "@jevyr/protocol";
import { investigationImplementationDescriptor } from "../src/investigation-identity.js";
import { metabolicImplementationDigest } from "../src/juggler-calibration.js";

test("investigation identity binds the growth implementation selected by package conditions", () => {
  const entry = new URL(import.meta.resolve("@jevyr/growth"));
  const extension = entry.pathname.endsWith(".ts") ? ".ts" : ".js";
  const executedNursery = new URL(`./nursery${extension}`, entry);
  assert.equal(investigationImplementationDescriptor().growthNurseryDigest, sha256Digest(readFileSync(executedNursery)));
});

test("metabolic identity resolves each dependency independently of the source runtime module", () => {
  assert.match(metabolicImplementationDigest(), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(metabolicImplementationDigest(), metabolicImplementationDigest());
});
