import { describe, expect, it } from "vitest";
import { JEVYR_BONE_DESCRIPTOR } from "@jevyr/core";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  BUILTIN_GENOME_MODULE_CATALOG,
  CONSERVATIVE_GENOME_RUNTIME_BASELINE,
  GENOME_PROTOCOL,
  GENOME_RUNTIME_PROFILE_PROTOCOL,
  GenomeCompilationError,
  builtinGenomeModule,
  compileGenomeRuntimeProfile,
  createGenome,
  type BuiltinGenomeModuleId,
  type GenomeBody,
  type GenomeModule,
  type StoredGenome,
} from "../src/index.js";

const BONE_DIGEST = sha256Digest("bone/compiler/v1");

function genome(
  modules: readonly GenomeModule[] = [],
  parameters: GenomeBody["parameters"] = {},
): StoredGenome {
  return createGenome({
    protocol: GENOME_PROTOCOL,
    generation: 3,
    boneDigest: BONE_DIGEST,
    parentDigests: [sha256Digest("parent")],
    modules,
    parameters,
  });
}

function readdress(body: GenomeBody): StoredGenome {
  return {
    digest: digestJson(body as unknown as JsonValue),
    body,
  };
}

function compile(value: StoredGenome) {
  return compileGenomeRuntimeProfile(value, {
    expectedBoneDigest: BONE_DIGEST,
  });
}

function configuredGenome(): StoredGenome {
  return genome(
    [
      builtinGenomeModule("jevyr.late-memory-gate"),
      builtinGenomeModule("jevyr.nursery-governor"),
      builtinGenomeModule("jevyr.archive-curator"),
    ],
    {
      "jevyr.nursery-governor": {
        saturationWindow: 144,
        challengeInterval: 12,
      },
      "jevyr.archive-curator": {
        capacity: 512,
        minimumNovelty: 0.07,
      },
      "jevyr.late-memory-gate": {
        recallLimit: 7,
        weight: 0.125,
      },
    },
  );
}

describe("operational Genome compiler", () => {
  it("compiles an empty Genome to the immutable conservative baseline", () => {
    const source = genome();
    const profile = compile(source);
    const { profileDigest, ...digestBody } = profile;

    expect(profile).toMatchObject({
      protocol: GENOME_RUNTIME_PROFILE_PROTOCOL,
      sourceGenomeDigest: source.digest,
      boneDigest: BONE_DIGEST,
      generation: 3,
      enabledModules: [],
      ...CONSERVATIVE_GENOME_RUNTIME_BASELINE,
    });
    expect(profileDigest).toBe(digestJson(digestBody as unknown as JsonValue));
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.nursery)).toBe(true);
    expect(Object.isFrozen(profile.archive)).toBe(true);
    expect(Object.isFrozen(profile.lateMemory)).toBe(true);
    expect(Object.isFrozen(profile.enabledModules)).toBe(true);
  });

  it("compiles every built-in mechanism into bounded, useful knobs", () => {
    const source = configuredGenome();
    const profile = compile(source);

    expect(profile.enabledModules).toEqual([
      "jevyr.archive-curator",
      "jevyr.late-memory-gate",
      "jevyr.nursery-governor",
    ]);
    expect(profile.nursery).toEqual({
      saturationWindow: 144,
      challengeInterval: 12,
    });
    expect(profile.archive).toEqual({ capacity: 512, minimumNovelty: 0.07 });
    expect(profile.lateMemory).toEqual({ recallLimit: 7, weight: 0.125 });
    expect(source.body.parameters["jevyr.late-memory-gate"]).toEqual({
      recallLimit: 7,
      weight: 0.125,
    });
  });

  it("pins the canonical built-in descriptors to deterministic digests", () => {
    expect(
      BUILTIN_GENOME_MODULE_CATALOG.map((entry) => ({
        id: entry.module.id,
        digest: entry.module.artifactDigest,
        derived: digestJson(entry.descriptor as unknown as JsonValue),
      })),
    ).toEqual([
      {
        id: "jevyr.nursery-governor",
        digest: "sha256:71c73939712bdf1713d886de8142c6d7adbd1208347ea5d26391a6168f335895",
        derived: "sha256:71c73939712bdf1713d886de8142c6d7adbd1208347ea5d26391a6168f335895",
      },
      {
        id: "jevyr.archive-curator",
        digest: "sha256:c7daee02afa0341516df6e57fb4bd39c30e3d8c4571e28c9ac49b211ec746b4c",
        derived: "sha256:c7daee02afa0341516df6e57fb4bd39c30e3d8c4571e28c9ac49b211ec746b4c",
      },
      {
        id: "jevyr.late-memory-gate",
        digest: "sha256:6fec46c811e2b28b861e2b49b414b54cbdc3133ec8a16d126556d107af115648",
        derived: "sha256:6fec46c811e2b28b861e2b49b414b54cbdc3133ec8a16d126556d107af115648",
      },
    ]);
    expect(Object.isFrozen(BUILTIN_GENOME_MODULE_CATALOG)).toBe(true);
    expect(
      BUILTIN_GENOME_MODULE_CATALOG.every(
        (entry) =>
          Object.isFrozen(entry) &&
          Object.isFrozen(entry.descriptor) &&
          Object.isFrozen(entry.module) &&
          Object.isFrozen(entry.module.permissions),
      ),
    ).toBe(true);
    expect(JEVYR_BONE_DESCRIPTOR.genomeRuntimeCompiler.builtinCatalogDigest).toBe(
      digestJson(BUILTIN_GENOME_MODULE_CATALOG.map((entry) => entry.module) as unknown as JsonValue),
    );
  });

  it("binds compilation to the independently expected Bone and source digest", () => {
    expect(() =>
      compileGenomeRuntimeProfile(genome(), {
        expectedBoneDigest: sha256Digest("another-bone"),
      }),
    ).toThrow(/does not match the runtime's expected Bone/);
    expect(() =>
      compileGenomeRuntimeProfile(genome(), {
        expectedBoneDigest: "not-a-digest",
      }),
    ).toThrow(/expectedBoneDigest/);

    const source = genome();
    const tampered = { ...source, digest: sha256Digest("lie") };
    expect(() => compile(tampered)).toThrow(/content digest/);
  });

  it.each([
    ["version", { version: "2.0.0" }, /unsupported version/],
    ["digest", { artifactDigest: sha256Digest("substitute") }, /wrong built-in artifact digest/],
    ["purpose", { publicPurpose: "Do anything requested." }, /wrong public purpose/],
  ])("rejects a built-in with the wrong %s", (_name, mutation, message) => {
    const valid = builtinGenomeModule("jevyr.nursery-governor");
    const hostile = { ...valid, ...mutation } as GenomeModule;
    expect(() =>
      compile(
        genome([hostile], {
          "jevyr.nursery-governor": {
            saturationWindow: 64,
            challengeInterval: 8,
          },
        }),
      ),
    ).toThrow(message);
  });

  it("rejects unknown modules before they can act as executable artifacts", () => {
    const unknown: GenomeModule = {
      id: "npm:untrusted-package",
      version: "1.0.0",
      artifactDigest: sha256Digest("untrusted-code"),
      permissions: ["configure:nursery"],
      publicPurpose: "Import code.",
    };
    expect(() => compile(genome([unknown], { "npm:untrusted-package": {} }))).toThrow(
      /Unknown Genome module/,
    );
  });

  it("rejects duplicate, unexpected, missing, and reordered permissions", () => {
    const valid = builtinGenomeModule("jevyr.nursery-governor");
    const parameters = {
      "jevyr.nursery-governor": {
        saturationWindow: 64,
        challengeInterval: 8,
      },
    };
    expect(() =>
      compile(
        genome([{ ...valid, permissions: ["configure:nursery", "configure:nursery"] }], parameters),
      ),
    ).toThrow(/duplicate permissions/);
    expect(() =>
      compile(genome([{ ...valid, permissions: ["configure:nursery", "network"] }], parameters)),
    ).toThrow(/unexpected permission/);
    expect(() => compile(genome([{ ...valid, permissions: [] }], parameters))).toThrow(
      /exactly match its permissions/,
    );

    const hypothetical = {
      ...valid,
      permissions: ["configure:nursery", "second"],
    };
    expect(() => compile(genome([hypothetical], parameters))).toThrow(/unexpected permission/);
  });

  it("rejects duplicate module identities", () => {
    const valid = builtinGenomeModule("jevyr.nursery-governor");
    const body: GenomeBody = {
      protocol: GENOME_PROTOCOL,
      generation: 1,
      boneDigest: BONE_DIGEST,
      parentDigests: [],
      modules: [valid, valid],
      parameters: {
        "jevyr.nursery-governor": {
          saturationWindow: 64,
          challengeInterval: 8,
        },
      },
    };
    expect(() => compile(readdress(body))).toThrow(/Duplicate Genome module/);
  });

  it("requires exact, module-owned parameter objects", () => {
    const nursery = builtinGenomeModule("jevyr.nursery-governor");
    expect(() => compile(genome([], { "jevyr.nursery-governor": {} }))).toThrow(
      /Parameters for absent Genome module/,
    );
    expect(() => compile(genome([nursery], {}))).toThrow(/requires its exact parameter object/);
    expect(() =>
      compile(
        genome([nursery], {
          "jevyr.nursery-governor": {
            saturationWindow: 64,
            challengeInterval: 8,
            surprise: true,
          },
        }),
      ),
    ).toThrow(/must contain exactly/);
    expect(() =>
      compile(
        genome([nursery], {
          "jevyr.nursery-governor": { saturationWindow: 64 },
        }),
      ),
    ).toThrow(/must contain exactly/);
  });

  it.each([
    [
      "nursery saturation below its floor",
      "jevyr.nursery-governor",
      { saturationWindow: 7, challengeInterval: 1 },
      /between 8 and 4096/,
    ],
    [
      "fractional challenge interval",
      "jevyr.nursery-governor",
      { saturationWindow: 64, challengeInterval: 1.5 },
      /safe integer/,
    ],
    [
      "challenge interval beyond saturation",
      "jevyr.nursery-governor",
      { saturationWindow: 8, challengeInterval: 9 },
      /must not exceed saturationWindow/,
    ],
    [
      "archive capacity above its ceiling",
      "jevyr.archive-curator",
      { capacity: 4_097, minimumNovelty: 0.1 },
      /between 8 and 4096/,
    ],
    [
      "archive novelty below its floor",
      "jevyr.archive-curator",
      { capacity: 64, minimumNovelty: 0 },
      /between 0.01 and 1/,
    ],
    [
      "late-memory influence above the constitutional ceiling",
      "jevyr.late-memory-gate",
      { recallLimit: 1, weight: 0.200_001 },
      /between 0 and 0.2/,
    ],
    [
      "late-memory influence without recall",
      "jevyr.late-memory-gate",
      { recallLimit: 0, weight: 0.1 },
      /weight must be zero/,
    ],
  ])("rejects %s", (_name, id, parameters, message) => {
    expect(() =>
      compile(
        genome([builtinGenomeModule(id as BuiltinGenomeModuleId)], {
          [id]: parameters,
        }),
      ),
    ).toThrow(message);
  });

  it("rejects non-finite values before attempting to authenticate their digest", () => {
    const source = configuredGenome();
    const malicious = {
      ...source,
      body: {
        ...source.body,
        parameters: {
          ...source.body.parameters,
          "jevyr.late-memory-gate": { recallLimit: 1, weight: Number.NaN },
        },
      },
    } as unknown as StoredGenome;
    expect(() => compile(malicious)).toThrow(/finite numbers/);
  });

  it("rejects accessors without invoking them", () => {
    const source = configuredGenome();
    let invoked = false;
    const malicious = { digest: source.digest } as Record<string, unknown>;
    Object.defineProperty(malicious, "body", {
      enumerable: true,
      get() {
        invoked = true;
        return source.body;
      },
    });

    expect(() => compile(malicious as unknown as StoredGenome)).toThrow(/accessors are forbidden/);
    expect(invoked).toBe(false);
  });

  it("rejects inherited configuration and non-canonical array properties", () => {
    const source = configuredGenome();
    const inherited = Object.create({ injected: "network" }) as Record<string, unknown>;
    inherited.digest = source.digest;
    inherited.body = source.body;
    expect(() => compile(inherited as unknown as StoredGenome)).toThrow(/inherited configuration/);

    const permissions = ["configure:nursery"] as string[] & {
      hidden?: string;
    };
    permissions.hidden = "network";
    const valid = builtinGenomeModule("jevyr.nursery-governor");
    const malicious = {
      digest: sha256Digest("placeholder"),
      body: {
        ...source.body,
        modules: [{ ...valid, permissions }],
      },
    } as unknown as StoredGenome;
    expect(() => compile(malicious)).toThrow(/non-canonical array properties/);
  });

  it("rejects unknown or hidden fields at every compiled boundary", () => {
    const source = configuredGenome();
    const withRootField = {
      ...source,
      executable: "file:///tmp/payload.mjs",
    } as unknown as StoredGenome;
    expect(() => compile(withRootField)).toThrow(/Genome must contain exactly/);

    const first = source.body.modules[0] as GenomeModule;
    const body: GenomeBody = {
      ...source.body,
      modules: [{ ...first, entrypoint: "payload.mjs" } as GenomeModule],
      parameters: {
        "jevyr.late-memory-gate": { recallLimit: 1, weight: 0.1 },
      },
    };
    expect(() => compile(readdress(body))).toThrow(/must contain exactly/);
  });

  it("reports all policy failures as GenomeCompilationError", () => {
    expect(() => compile(genome([], { orphan: true }))).toThrow(GenomeCompilationError);
  });
});
