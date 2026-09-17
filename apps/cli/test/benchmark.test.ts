import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JevyrClient, JevyrRecord } from "@jevyr/sdk";
import { loadCorpus, runCorpus, validateCorpus } from "../src/benchmark.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("benchmark corpus boundary", () => {
  it("accepts the checked-in constitutional corpus", async () => {
    const corpus = await loadCorpus(resolve(process.cwd(), "../../benchmarks/corpus.v1.json"));
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  it("rejects duplicate JSON members before a benchmark can hide its expectation", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevyr-corpus-"));
    roots.push(root);
    const path = join(root, "corpus.json");
    await writeFile(
      path,
      '{"protocol":"jevyr.benchmark-corpus/1","requiredInvariants":[],"cases":[{"id":"x","category":"authority","impulse":"first","\\u0069mpulse":"replacement","expect":{"creation":"PRESENT","judgment":"PRESENT"}}]}',
      "utf8",
    );
    await expect(loadCorpus(path)).rejects.toThrow(/duplicate object key "impulse"/u);
  });

  it("rejects unknown authority fields and incomplete nested records", () => {
    expect(() => validateCorpus({
      protocol: "jevyr.benchmark-corpus/1",
      requiredInvariants: [],
      cases: [{
        id: "x",
        category: "authority",
        impulse: "Judge this exact claim.",
        expect: { creation: "PRESENT", judgment: "PRESENT", preferredAnswer: "ACCEPT" },
      }],
    })).toThrow(/unknown fields: preferredAnswer/u);
  });

  it("does not pass a matching signed verdict when independent replay is unavailable", async () => {
    const matchingRecord = {
      verdict: {
        integrity: "VALID",
        creation: "CONCEIVED",
        embodiment: "NOT_BUILT",
        judgment: "UNPROVEN",
      },
    } as JevyrRecord;
    const client = {
      cast: async () => ({ caseId: "case_test" }),
      waitForAuthenticatedRecord: async () => ({ payload: matchingRecord }),
      verifiedPolicyDescriptor: async () => {
        throw new Error("persisted replay unavailable");
      },
      verifiedIntentContract: async () => {
        throw new Error("persisted replay unavailable");
      },
      pollEvents: async () => {
        throw new Error("persisted replay unavailable");
      },
      trustBundle: async () => {
        throw new Error("persisted replay unavailable");
      },
    } as unknown as JevyrClient;
    const [result] = await runCorpus({
      protocol: "jevyr.benchmark-corpus/1",
      requiredInvariants: [],
      cases: [{
        id: "matching-verdict",
        category: "authority",
        impulse: "Judge this.",
        expect: { integrity: "VALID", creation: "CONCEIVED", judgment: "UNPROVEN" },
      }],
    }, client);

    expect(result).toMatchObject({
      id: "matching-verdict",
      passed: false,
      failures: ["persisted replay unavailable"],
    });
  });
});
