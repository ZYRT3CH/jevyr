import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import { GENOME_PROTOCOL, type GenomeModule, type StoredGenome } from "./types.js";

export const BUILTIN_GENOME_MODULE_PROTOCOL = "jevyr.builtin-genome-module/1" as const;
export const GENOME_RUNTIME_PROFILE_PROTOCOL = "jevyr.genome-runtime-profile/1" as const;

export type BuiltinGenomeModuleId =
  | "jevyr.nursery-governor"
  | "jevyr.archive-curator"
  | "jevyr.late-memory-gate";

export interface GenomeIntegerParameterDescriptor {
  readonly type: "integer";
  readonly minimum: number;
  readonly maximum: number;
  readonly default: number;
  readonly publicPurpose: string;
}

export interface GenomeNumberParameterDescriptor {
  readonly type: "number";
  readonly minimum: number;
  readonly maximum: number;
  readonly default: number;
  readonly publicPurpose: string;
}

export type GenomeParameterDescriptor =
  | GenomeIntegerParameterDescriptor
  | GenomeNumberParameterDescriptor;

/**
 * Canonical inert description of a built-in mechanism. Its digest is the only
 * artifact digest the compiler accepts. It names behavior already compiled
 * into Jevyr; it is never a path, package name, or executable payload.
 */
export interface BuiltinGenomeModuleDescriptor {
  readonly protocol: typeof BUILTIN_GENOME_MODULE_PROTOCOL;
  readonly id: BuiltinGenomeModuleId;
  readonly version: "1.0.0";
  readonly permissions: readonly string[];
  readonly publicPurpose: string;
  readonly parameters: Readonly<Record<string, GenomeParameterDescriptor>>;
}

export interface BuiltinGenomeModuleDefinition {
  readonly descriptor: BuiltinGenomeModuleDescriptor;
  readonly module: GenomeModule;
}

export interface GenomeRuntimeKnobs {
  readonly nursery: {
    readonly saturationWindow: number;
    readonly challengeInterval: number;
  };
  readonly archive: {
    readonly capacity: number;
    readonly minimumNovelty: number;
  };
  readonly lateMemory: {
    readonly recallLimit: number;
    readonly weight: number;
  };
}

export interface GenomeRuntimeProfile extends GenomeRuntimeKnobs {
  readonly protocol: typeof GENOME_RUNTIME_PROFILE_PROTOCOL;
  readonly profileDigest: string;
  readonly sourceGenomeDigest: string;
  readonly boneDigest: string;
  readonly generation: number;
  readonly enabledModules: readonly BuiltinGenomeModuleId[];
}

export interface CompileGenomeRuntimeProfileOptions {
  /** The Bone authenticated by the runtime outside the Genome registry. */
  readonly expectedBoneDigest: string;
}

export class GenomeCompilationError extends Error {
  override readonly name = "GenomeCompilationError";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function descriptor(value: BuiltinGenomeModuleDescriptor): BuiltinGenomeModuleDescriptor {
  return deepFreeze(value);
}

const NURSERY_GOVERNOR_DESCRIPTOR = descriptor({
  protocol: BUILTIN_GENOME_MODULE_PROTOCOL,
  id: "jevyr.nursery-governor",
  version: "1.0.0",
  permissions: ["configure:nursery"],
  publicPurpose: "Bound the nursery's measured saturation window and challenge cadence.",
  parameters: {
    saturationWindow: {
      type: "integer",
      minimum: 8,
      maximum: 4_096,
      default: 64,
      publicPurpose: "Attempts without exact yield before nursery saturation.",
    },
    challengeInterval: {
      type: "integer",
      minimum: 1,
      maximum: 256,
      default: 8,
      publicPurpose: "Completed attempts between coevolved challenges.",
    },
  },
});

const ARCHIVE_CURATOR_DESCRIPTOR = descriptor({
  protocol: BUILTIN_GENOME_MODULE_PROTOCOL,
  id: "jevyr.archive-curator",
  version: "1.0.0",
  permissions: ["configure:archive"],
  publicPurpose: "Bound the measured quality-diversity archive and its novelty threshold.",
  parameters: {
    capacity: {
      type: "integer",
      minimum: 8,
      maximum: 4_096,
      default: 64,
      publicPurpose: "Maximum number of measured archive survivors.",
    },
    minimumNovelty: {
      type: "number",
      minimum: 0.01,
      maximum: 1,
      default: 0.1,
      publicPurpose: "Minimum normalized novelty admitted to the archive.",
    },
  },
});

const LATE_MEMORY_GATE_DESCRIPTOR = descriptor({
  protocol: BUILTIN_GENOME_MODULE_PROTOCOL,
  id: "jevyr.late-memory-gate",
  version: "1.0.0",
  permissions: ["configure:late-memory"],
  publicPurpose: "Bound late, post-divergence recall without allowing memory to decide.",
  parameters: {
    recallLimit: {
      type: "integer",
      minimum: 0,
      maximum: 32,
      default: 0,
      publicPurpose: "Maximum independently admitted memories recalled late.",
    },
    weight: {
      type: "number",
      minimum: 0,
      maximum: 0.2,
      default: 0,
      publicPurpose: "Maximum recombination influence of each recalled memory.",
    },
  },
});

function definition(value: BuiltinGenomeModuleDescriptor): BuiltinGenomeModuleDefinition {
  const artifactDigest = digestJson(value as unknown as JsonValue);
  return deepFreeze({
    descriptor: value,
    module: {
      id: value.id,
      version: value.version,
      artifactDigest,
      permissions: [...value.permissions],
      publicPurpose: value.publicPurpose,
    },
  });
}

/**
 * The complete executable catalog. Digests are derived from canonical inert
 * descriptors; no registry artifact is imported, evaluated, or executed.
 */
export const BUILTIN_GENOME_MODULE_CATALOG = deepFreeze([
  definition(NURSERY_GOVERNOR_DESCRIPTOR),
  definition(ARCHIVE_CURATOR_DESCRIPTOR),
  definition(LATE_MEMORY_GATE_DESCRIPTOR),
] as const);

const CATALOG_BY_ID = new Map(
  BUILTIN_GENOME_MODULE_CATALOG.map((entry) => [entry.module.id, entry]),
);

function parameterDefault(descriptor: BuiltinGenomeModuleDescriptor, key: string): number {
  const parameter = descriptor.parameters[key];
  if (parameter === undefined) {
    throw new Error(`Built-in Genome descriptor ${descriptor.id} is missing ${key}.`);
  }
  return parameter.default;
}

export const CONSERVATIVE_GENOME_RUNTIME_BASELINE: GenomeRuntimeKnobs = deepFreeze({
  nursery: {
    saturationWindow: parameterDefault(NURSERY_GOVERNOR_DESCRIPTOR, "saturationWindow"),
    challengeInterval: parameterDefault(NURSERY_GOVERNOR_DESCRIPTOR, "challengeInterval"),
  },
  archive: {
    capacity: parameterDefault(ARCHIVE_CURATOR_DESCRIPTOR, "capacity"),
    minimumNovelty: parameterDefault(ARCHIVE_CURATOR_DESCRIPTOR, "minimumNovelty"),
  },
  lateMemory: {
    recallLimit: parameterDefault(LATE_MEMORY_GATE_DESCRIPTOR, "recallLimit"),
    weight: parameterDefault(LATE_MEMORY_GATE_DESCRIPTOR, "weight"),
  },
});

/** Return the immutable, exact manifest callers should place in a Genome. */
export function builtinGenomeModule(id: BuiltinGenomeModuleId): GenomeModule {
  const entry = CATALOG_BY_ID.get(id);
  if (entry === undefined) {
    throw new GenomeCompilationError(`Unknown built-in Genome module: ${id}`);
  }
  return entry.module;
}

function fail(message: string): never {
  throw new GenomeCompilationError(message);
}

/**
 * Copies only own, enumerable data properties into a plain canonical JSON
 * value. This happens before any semantic field read, so getters and inherited
 * configuration cannot smuggle values into compilation.
 */
function snapshotCanonicalData(
  value: unknown,
  label: string,
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain only finite numbers.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail(`${label} must be canonical JSON data.`);
  if (ancestors.has(value)) fail(`${label} must not be cyclic.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail(`${label} must not inherit from a custom array prototype.`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        fail(`${label} has an invalid array length.`);
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length }, (_, index) => String(index)),
      ]);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !expectedKeys.has(key)) {
          fail(`${label} has non-canonical array properties.`);
        }
      }
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = descriptors[String(index)];
        if (item === undefined || !("value" in item) || !item.enumerable) {
          fail(`${label}[${index}] must be an own enumerable data property.`);
        }
        copy.push(snapshotCanonicalData(item.value, `${label}[${index}]`, ancestors));
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${label} must not contain inherited configuration.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail(`${label} must not contain symbol keys.`);
      const item = descriptors[key];
      if (item === undefined || !("value" in item)) {
        fail(`${label}.${key} must be a data property; accessors are forbidden.`);
      }
      if (!item.enumerable) {
        fail(`${label}.${key} must be enumerable canonical JSON data.`);
      }
      copy[key] = snapshotCanonicalData(item.value, `${label}.${key}`, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function record(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, JsonValue>;
}

function array(value: JsonValue, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function exactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ") || "no parameters"}.`);
  }
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function safeInteger(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${label} must be a safe integer.`);
  }
  return value;
}

function boundedNumber(value: JsonValue, schema: GenomeParameterDescriptor, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  if (schema.type === "integer" && !Number.isSafeInteger(value)) {
    fail(`${label} must be a safe integer.`);
  }
  if (value < schema.minimum || value > schema.maximum) {
    fail(`${label} must be between ${schema.minimum} and ${schema.maximum}, inclusive.`);
  }
  return value;
}

function assertDigest(value: JsonValue, label: string): string {
  if (!isSha256Digest(value)) fail(`${label} must be a SHA-256 digest.`);
  return value;
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

interface ValidatedGenome {
  readonly digest: string;
  readonly boneDigest: string;
  readonly generation: number;
  readonly modules: readonly BuiltinGenomeModuleDefinition[];
  readonly parameters: Readonly<Record<string, Record<string, JsonValue>>>;
}

function validateGenome(input: StoredGenome): ValidatedGenome {
  const root = record(snapshotCanonicalData(input, "Genome"), "Genome");
  exactKeys(root, ["digest", "body"], "Genome");
  const sourceDigest = assertDigest(root.digest as JsonValue, "Genome.digest");
  const body = record(root.body as JsonValue, "Genome.body");
  exactKeys(
    body,
    ["protocol", "generation", "boneDigest", "parentDigests", "modules", "parameters"],
    "Genome.body",
  );
  if (body.protocol !== GENOME_PROTOCOL) {
    fail(`Genome.body.protocol must be ${GENOME_PROTOCOL}.`);
  }
  const generation = safeInteger(body.generation as JsonValue, "Genome.body.generation");
  if (generation < 0) fail("Genome.body.generation must not be negative.");
  const boneDigest = assertDigest(body.boneDigest as JsonValue, "Genome.body.boneDigest");
  const parents = array(body.parentDigests as JsonValue, "Genome.body.parentDigests");
  const parentSet = new Set<string>();
  for (const [index, parent] of parents.entries()) {
    const parentDigest = assertDigest(parent, `Genome.body.parentDigests[${index}]`);
    if (parentSet.has(parentDigest)) {
      fail("Genome.body.parentDigests must not contain duplicates.");
    }
    parentSet.add(parentDigest);
  }

  const moduleValues = array(body.modules as JsonValue, "Genome.body.modules");
  const modules: BuiltinGenomeModuleDefinition[] = [];
  const moduleIds = new Set<string>();
  for (const [index, value] of moduleValues.entries()) {
    const candidate = record(value, `Genome.body.modules[${index}]`);
    exactKeys(
      candidate,
      ["id", "version", "artifactDigest", "permissions", "publicPurpose"],
      `Genome.body.modules[${index}]`,
    );
    const id = string(candidate.id as JsonValue, `Genome.body.modules[${index}].id`);
    if (moduleIds.has(id)) fail(`Duplicate Genome module: ${id}.`);
    moduleIds.add(id);
    const expected = CATALOG_BY_ID.get(id);
    if (expected === undefined) fail(`Unknown Genome module: ${id}.`);

    const version = string(candidate.version as JsonValue, `Genome.body.modules[${index}].version`);
    if (version !== expected.module.version) {
      fail(`Genome module ${id} has an unsupported version.`);
    }
    const artifactDigest = assertDigest(
      candidate.artifactDigest as JsonValue,
      `Genome.body.modules[${index}].artifactDigest`,
    );
    if (artifactDigest !== expected.module.artifactDigest) {
      fail(`Genome module ${id} has the wrong built-in artifact digest.`);
    }
    if (candidate.publicPurpose !== expected.module.publicPurpose) {
      fail(`Genome module ${id} has the wrong public purpose.`);
    }

    const permissionValues = array(
      candidate.permissions as JsonValue,
      `Genome.body.modules[${index}].permissions`,
    );
    const permissions = permissionValues.map((permission, permissionIndex) =>
      string(permission, `Genome.body.modules[${index}].permissions[${permissionIndex}]`),
    );
    if (new Set(permissions).size !== permissions.length) {
      fail(`Genome module ${id} contains duplicate permissions.`);
    }
    const unexpected = permissions.filter(
      (permission) => !expected.module.permissions.includes(permission),
    );
    if (unexpected.length > 0) {
      fail(`Genome module ${id} requests an unexpected permission.`);
    }
    if (!sameStrings(permissions, expected.module.permissions)) {
      fail(`Genome module ${id} does not exactly match its permissions.`);
    }
    modules.push(expected);
  }

  const parameters = record(body.parameters as JsonValue, "Genome.body.parameters");
  for (const id of Object.keys(parameters)) {
    if (!moduleIds.has(id)) {
      fail(`Parameters for absent Genome module are forbidden: ${id}.`);
    }
  }
  for (const module of modules) {
    const id = module.module.id;
    if (!(id in parameters)) {
      fail(`Genome module ${id} requires its exact parameter object.`);
    }
    const values = record(parameters[id] as JsonValue, `Genome.body.parameters.${id}`);
    exactKeys(values, Object.keys(module.descriptor.parameters), `Genome.body.parameters.${id}`);
  }

  const calculatedDigest = digestJson(body as unknown as JsonValue);
  if (calculatedDigest !== sourceDigest) {
    fail("Genome body does not match its content digest.");
  }

  return {
    digest: sourceDigest,
    boneDigest,
    generation,
    modules,
    parameters: parameters as Readonly<Record<string, Record<string, JsonValue>>>,
  };
}

/**
 * Compile a StoredGenome into inert, bounded runtime knobs. Only the catalog
 * above can affect the result. No artifact from the Genome is loaded or run.
 */
export function compileGenomeRuntimeProfile(
  genome: StoredGenome,
  options: CompileGenomeRuntimeProfileOptions,
): GenomeRuntimeProfile {
  const optionValues = record(
    snapshotCanonicalData(options, "Genome compiler options"),
    "Genome compiler options",
  );
  exactKeys(optionValues, ["expectedBoneDigest"], "Genome compiler options");
  const expectedBoneDigest = assertDigest(
    optionValues.expectedBoneDigest as JsonValue,
    "expectedBoneDigest",
  );
  const source = validateGenome(genome);
  if (source.boneDigest !== expectedBoneDigest) {
    fail("Genome Bone digest does not match the runtime's expected Bone digest.");
  }

  const effective: {
    nursery: { saturationWindow: number; challengeInterval: number };
    archive: { capacity: number; minimumNovelty: number };
    lateMemory: { recallLimit: number; weight: number };
  } = structuredClone(CONSERVATIVE_GENOME_RUNTIME_BASELINE);

  for (const module of source.modules) {
    const id = module.module.id;
    const parameters = source.parameters[id];
    if (parameters === undefined) {
      fail(`Genome module ${id} requires parameters.`);
    }
    const schemas = module.descriptor.parameters;
    if (id === "jevyr.nursery-governor") {
      effective.nursery.saturationWindow = boundedNumber(
        parameters.saturationWindow as JsonValue,
        schemas.saturationWindow as GenomeParameterDescriptor,
        `${id}.saturationWindow`,
      );
      effective.nursery.challengeInterval = boundedNumber(
        parameters.challengeInterval as JsonValue,
        schemas.challengeInterval as GenomeParameterDescriptor,
        `${id}.challengeInterval`,
      );
      if (effective.nursery.challengeInterval > effective.nursery.saturationWindow) {
        fail(`${id}.challengeInterval must not exceed saturationWindow.`);
      }
    } else if (id === "jevyr.archive-curator") {
      effective.archive.capacity = boundedNumber(
        parameters.capacity as JsonValue,
        schemas.capacity as GenomeParameterDescriptor,
        `${id}.capacity`,
      );
      effective.archive.minimumNovelty = boundedNumber(
        parameters.minimumNovelty as JsonValue,
        schemas.minimumNovelty as GenomeParameterDescriptor,
        `${id}.minimumNovelty`,
      );
    } else if (id === "jevyr.late-memory-gate") {
      effective.lateMemory.recallLimit = boundedNumber(
        parameters.recallLimit as JsonValue,
        schemas.recallLimit as GenomeParameterDescriptor,
        `${id}.recallLimit`,
      );
      effective.lateMemory.weight = boundedNumber(
        parameters.weight as JsonValue,
        schemas.weight as GenomeParameterDescriptor,
        `${id}.weight`,
      );
      if (effective.lateMemory.recallLimit === 0 && effective.lateMemory.weight !== 0) {
        fail(`${id}.weight must be zero when recallLimit is zero.`);
      }
    }
  }

  const body = deepFreeze({
    protocol: GENOME_RUNTIME_PROFILE_PROTOCOL,
    sourceGenomeDigest: source.digest,
    boneDigest: source.boneDigest,
    generation: source.generation,
    enabledModules: source.modules
      .map((module) => module.module.id)
      .sort() as BuiltinGenomeModuleId[],
    nursery: effective.nursery,
    archive: effective.archive,
    lateMemory: effective.lateMemory,
  });
  const profileDigest = digestJson(body as unknown as JsonValue);
  return deepFreeze({ ...body, profileDigest });
}
