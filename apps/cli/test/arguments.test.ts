import { describe, expect, it } from "vitest";
import { assertCommandInvocation, caseMode, parseArguments, parseSubject } from "../src/arguments.js";

describe("CLI grammar", () => {
  it("keeps repeated subjects and positional impulse", () => {
    const parsed = parseArguments([
      "cast",
      "test this",
      "--subject",
      "git:repo@abc",
      "--subject=directory:src",
    ]);
    expect(parsed.command).toBe("cast");
    expect(parsed.positionals).toEqual(["test this"]);
    expect(parsed.options.get("subject")).toEqual(["git:repo@abc", "directory:src"]);
  });

  it("parses Windows drive paths without losing the colon", () => {
    expect(parseSubject("directory:C:\\work\\repo")).toEqual({
      id: "subject-1",
      kind: "directory",
      locator: "C:\\work\\repo",
    });
  });

  it("separates a full immutable Git revision from a local locator", () => {
    const revision = "A".repeat(40);
    expect(parseSubject(`git:/workspace/repo@${revision}`)).toEqual({
      id: "subject-1",
      kind: "git",
      locator: "/workspace/repo",
      revision: revision.toLowerCase(),
    });
    expect(parseSubject("git:owner/repo@main")).toEqual({
      id: "subject-1",
      kind: "git",
      locator: "owner/repo@main",
    });
  });

  it("treats short subcommand help as a flag instead of a path", () => {
    const parsed = parseArguments(["init", "-h"]);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.options.get("help")).toEqual(["true"]);
  });

  it("accepts a bounded foreground launch shape and no positional authority", () => {
    expect(() => assertCommandInvocation(parseArguments([
      "up",
      "--url",
      "http://127.0.0.1:4317",
      "--chamber-url",
      "http://localhost:3001",
      "--local-model",
      "qwen3-coder:30b-32k",
      "--no-open",
    ]))).not.toThrow();
    expect(() => assertCommandInvocation(parseArguments(["up", "another-project"])))
      .toThrow("up accepts no positional arguments");
    expect(() => assertCommandInvocation(parseArguments([
      "mcp",
      "serve",
      "--url",
      "http://127.0.0.1:4317",
    ]))).not.toThrow();
  });

  it("parses the replay IntentContract as a valued option", () => {
    const parsed = parseArguments([
      "replay",
      "record.json",
      "--events",
      "events.json",
      "--intent-contract",
      "intent-contract.json",
    ]);
    expect(parsed.options.get("intent-contract")).toEqual(["intent-contract.json"]);
  });

  it("retains repeated sealed constraints and requested assays", () => {
    const parsed = parseArguments([
      "cast",
      "build it",
      "--mode",
      "design",
      "--constraint",
      "never use a network",
      "--constraint=emit JSON",
      "--requested-assay",
      "node artifact.js exits with code 0",
    ]);
    expect(caseMode(parsed.options.get("mode")?.at(-1))).toBe("design");
    expect(parsed.options.get("constraint")).toEqual(["never use a network", "emit JSON"]);
    expect(parsed.options.get("requested-assay")).toEqual(["node artifact.js exits with code 0"]);
    expect(() => caseMode("please-me")).toThrow("Invalid mode");
  });

  it("rejects unknown, duplicate singleton, and valued flag ambiguity", () => {
    expect(() => parseArguments(["cast", "build", "--privay", "full_case"]))
      .toThrow("Unknown option --privay");
    expect(() => parseArguments(["cast", "build", "--privacy", "local_only", "--privacy", "full_case"]))
      .toThrow("--privacy may be supplied at most once");
    expect(() => parseArguments(["watch", "case_abcdefgh", "--json=false"]))
      .toThrow("--json is a flag and does not accept a value");
  });

  it("rejects command options and positionals that would otherwise be ignored", () => {
    expect(() => assertCommandInvocation(parseArguments(["init", ".", "extra"])))
      .toThrow("init accepts at most one directory");
    expect(() => assertCommandInvocation(parseArguments(["open", "case_abcdefgh", "--json"])))
      .toThrow("Command open does not accept --json");
    expect(() => assertCommandInvocation(parseArguments(["mcp", "continue"])))
      .toThrow("mcp requires exactly the subcommand serve");
  });

  it("accepts only the closed offline-verifier argument shape", () => {
    expect(() => assertCommandInvocation(parseArguments([
      "verify-bundle",
      "proof",
      "--trusted-key-id",
      `sha256:${"a".repeat(64)}`,
      "--expected-runtime-sha",
      "b".repeat(40),
      "--json",
    ]))).not.toThrow();
    expect(() => assertCommandInvocation(parseArguments(["verify-bundle"])))
      .toThrow("verify-bundle requires exactly one positional reference");
    expect(() => assertCommandInvocation(parseArguments(["verify-bundle", "a", "b"])))
      .toThrow("verify-bundle requires exactly one positional reference");
    expect(() => assertCommandInvocation(parseArguments(["verify-bundle", "proof", "--url", "http://daemon"])))
      .toThrow("Command verify-bundle does not accept --url");
  });
});
