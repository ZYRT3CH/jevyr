import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";
import { parseJsonBytes } from "@jevyr/core";
import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";

export interface SelfJudgeMission {
  readonly protocol: "jevyr.self-judge-mission/1";
  readonly impulse: string;
  readonly constraints: readonly string[];
  readonly requestedAssays: readonly string[];
  readonly digest: string;
}
const MAX_MISSION_BYTES = 128 * 1024;
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\0"); }
function boundedStrings(value: unknown): value is string[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) { const descriptor = descriptors[String(index)]; if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || !text(descriptor.value, 4096)) return false; }
  return true;
}
export function createSelfJudgeMission(input: unknown): SelfJudgeMission {
  if (!input || typeof input !== "object" || Array.isArray(input) || isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => typeof key !== "string") || Reflect.ownKeys(input).sort().join("\0") !== "constraints\0impulse\0protocol\0requestedAssays" || Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) throw new TypeError("Self-judge mission requires exactly protocol, impulse, constraints and requestedAssays");
  const value = input as Record<string, unknown>;
  if (value.protocol !== "jevyr.self-judge-mission/1" || !text(value.impulse, 32_768) || !boundedStrings(value.constraints) || !boundedStrings(value.requestedAssays)) throw new TypeError("Self-judge mission strings and lists must remain finite");
  const body = { protocol: "jevyr.self-judge-mission/1" as const, impulse: value.impulse, constraints: Object.freeze([...value.constraints] as string[]), requestedAssays: Object.freeze([...value.requestedAssays] as string[]) };
  if (Buffer.byteLength(canonicalize(body)) > MAX_MISSION_BYTES) throw new TypeError("Self-judge mission exceeds its finite byte ceiling");
  return Object.freeze({ ...body, digest: digestJson(body) });
}
export const DEFAULT_SELF_JUDGE_MISSION = createSelfJudgeMission({ protocol: "jevyr.self-judge-mission/1", impulse: "Investigate this immutable snapshot of the organism's own repository for reproducible critical defects and constitutional binding failures. Use only the sealed permitted assays; keep unexecuted claims UNPROVEN. Any proposed improvement is an untrusted offspring proposal requiring the existing governance process.", constraints: [], requestedAssays: [] });

/** Reads one explicit startup mission. It cannot select subjects, privacy, mode, seed, or capabilities. */
export function loadSelfJudgeMission(env: NodeJS.ProcessEnv, projectRoot: string): SelfJudgeMission {
  const configured = env.JEVYR_SELF_JUDGE_CASE_FILE;
  if (configured === undefined) return DEFAULT_SELF_JUDGE_MISSION;
  if (!text(configured, 4096)) throw new TypeError("JEVYR_SELF_JUDGE_CASE_FILE must be an explicit finite path");
  const path = resolve(projectRoot, configured), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > MAX_MISSION_BYTES) throw new TypeError("Self-judge mission must be one bounded regular non-aliased file");
  const canonical = realpathSync(path);
  if (!isAbsolute(configured)) { const inside = relative(realpathSync(projectRoot), canonical); if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw new TypeError("Relative self-judge mission escaped its project root"); }
  const file = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const actual = fstatSync(file);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw new TypeError("Self-judge mission changed before capture");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(file, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const after = fstatSync(file); bytes = buffer.subarray(0, length);
    if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.size !== before.size || realpathSync(path) !== canonical) throw new TypeError("Self-judge mission changed during capture");
  } finally { closeSync(file); }
  return createSelfJudgeMission(parseJsonBytes(bytes, "Self-judge mission"));
}

export function assertSelfJudgeMission(value: SelfJudgeMission): void {
  const { digest, ...body } = value;
  const expected = createSelfJudgeMission(body);
  if (digest !== expected.digest || canonicalize(value as unknown as JsonValue) !== canonicalize(expected as unknown as JsonValue)) throw new TypeError("Self-judge mission does not match its startup digest");
}
