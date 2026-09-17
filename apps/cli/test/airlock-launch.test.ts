import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { airlockLaunchUrl } from "../src/airlock-launch.js";
import { assertCommandInvocation, parseArguments } from "../src/arguments.js";

describe("Airlock source launch", () => {
  it("distinguishes editable source launch from finite draft mutations", () => {
    for (const argv of [["airlock"], ["airlock", "./source", "--no-open", "--json"], ["airlock", "create", "--file", "case.json"]]) expect(() => assertCommandInvocation(parseArguments(argv))).not.toThrow();
    for (const argv of [["airlock", "create"], ["airlock", "./source", "--file", "case.json"], ["airlock", "show", "draft-id", "--no-open"], ["airlock", "./source", "--policy-digest", `sha256:${"a".repeat(64)}`]]) expect(() => assertCommandInvocation(parseArguments(argv))).toThrow();
  });
  it("encodes paths as editable fields, rejects absent source and embedded URL credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-airlock-launch-"));
    try {
      const name = "source & seed.mjs"; await writeFile(join(root, name), "export const value = 1;");
      const url = new URL(await airlockLaunchUrl(root, name, "http://localhost:3002", "http://127.0.0.1:4328"));
      expect(url.pathname).toBe("/airlock"); expect(url.searchParams.get("subject-kind")).toBe("file");
      expect(url.searchParams.get("subject-locator")).toBe(resolve(root, name)); expect(url.searchParams.has("seed")).toBe(false);
      expect(new URL(await airlockLaunchUrl(root, undefined, "http://localhost:3002", "http://127.0.0.1:4328")).searchParams.get("subject-kind")).toBe("directory");
      await expect(airlockLaunchUrl(root, "absent", "http://localhost:3002", "http://127.0.0.1:4328")).rejects.toThrow();
      await expect(airlockLaunchUrl(root, name, "http://token:secret@localhost:3002", "http://127.0.0.1:4328")).rejects.toThrow("credentials");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
