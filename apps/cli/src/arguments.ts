import type { CaseIntent, Control, Privacy, SubjectReference } from "@jevyr/sdk";

export interface ParsedArguments {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

const VALUE_OPTIONS = new Set([
  "url",
  "chamber-url",
  "file",
  "subject",
  "mode",
  "constraint",
  "requested-assay",
  "privacy",
  "control",
  "seed",
  "cursor",
  "events",
  "intent-contract",
  "corpus",
  "report",
  "wait-ms",
  "trusted-key-id",
  "expected-runtime-sha",
  "expected-subject-sha",
  "expected-workflow-sha",
  "local-model",
  "redeem",
  "quantity",
  "revision", "policy-digest", "case",
  "signing-key-ref", "configuration", "attestation", "name",
]);
const FLAG_OPTIONS = new Set(["help", "json", "tui", "force", "no-open", "unsigned-diagnostic", "validate-only", "same-seed", "new-seed"]);
const REPEATABLE_OPTIONS = new Set(["subject", "constraint", "requested-assay"]);
const ALL_OPTIONS = new Set([...VALUE_OPTIONS, ...FLAG_OPTIONS]);

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const positionals: string[] = [];
  const mutable = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      const values = mutable.get("help") ?? [];
      values.push("true");
      mutable.set("help", values);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=", 2);
    const rawName = token.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    if (!rawName) throw new TypeError("Empty option name");
    if (!ALL_OPTIONS.has(rawName)) throw new TypeError(`Unknown option --${rawName}`);
    if (FLAG_OPTIONS.has(rawName) && inline !== undefined) {
      throw new TypeError(`--${rawName} is a flag and does not accept a value`);
    }
    let value = inline;
    if (VALUE_OPTIONS.has(rawName) && value === undefined) {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`--${rawName} requires a value`);
      index += 1;
    }
    const values = mutable.get(rawName) ?? [];
    if (values.length > 0 && !REPEATABLE_OPTIONS.has(rawName)) {
      throw new TypeError(`--${rawName} may be supplied at most once`);
    }
    values.push(value ?? "true");
    mutable.set(rawName, values);
  }
  return { command, positionals, options: mutable };
}

export function option(args: ParsedArguments, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

export function flag(args: ParsedArguments, name: string): boolean {
  return args.options.has(name);
}

const COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  init: new Set(["force", "json", "help"]),
  up: new Set(["url", "chamber-url", "local-model", "json", "no-open", "help"]),
  doctor: new Set(["url", "json", "help"]),
  juggler: new Set(["url", "json", "redeem", "quantity", "help"]),
  cast: new Set(["url", "json", "file", "subject", "mode", "constraint", "requested-assay", "privacy", "control", "seed", "help"]),
  watch: new Set(["url", "json", "tui", "cursor", "wait-ms", "help"]),
  open: new Set(["chamber-url", "help"]),
  replay: new Set(["url", "json", "events", "intent-contract", "unsigned-diagnostic", "same-seed", "new-seed", "help"]),
  compare: new Set(["url", "json", "help"]),
  benchmark: new Set(["url", "json", "corpus", "report", "validate-only", "file", "signing-key-ref", "help"]),
  genome: new Set(["json", "file", "report", "attestation", "help"]),
  preset: new Set(["json", "file", "report", "name", "configuration", "signing-key-ref", "help"]),
  airlock: new Set(["url", "chamber-url", "no-open", "json", "file", "revision", "policy-digest", "help"]),
  run: new Set(["url", "json", "file", "case", "help"]),
  abort: new Set(["url", "json", "help"]),
  "verify-bundle": new Set(["json", "trusted-key-id", "expected-runtime-sha", "expected-subject-sha", "expected-workflow-sha", "help"]),
  mcp: new Set(["url", "help"]),
});

/** Reject options or positional shapes that a command would otherwise ignore. */
export function assertCommandInvocation(args: ParsedArguments): void {
  const allowed = COMMAND_OPTIONS[args.command];
  if (!allowed) throw new TypeError(`Unknown command: ${args.command}`);
  for (const name of args.options.keys()) {
    if (!allowed.has(name)) throw new TypeError(`Command ${args.command} does not accept --${name}`);
  }
  const count = args.positionals.length;
  if (args.command === "replay" && (flag(args, "same-seed") || flag(args, "new-seed"))) {
    if (flag(args, "same-seed") && flag(args, "new-seed")) throw new TypeError("Choose exactly one rerun seed mode");
    if (flag(args, "unsigned-diagnostic") || option(args, "events") || option(args, "intent-contract") || !/^case_[a-f0-9]{16}$/u.test(args.positionals[0] ?? "")) throw new TypeError("Seeded reruns require one daemon Case identifier and no local diagnostic options");
  }
  if (args.command === "watch" && flag(args, "tui") && flag(args, "json")) {
    throw new TypeError("watch --tui and --json are mutually exclusive");
  }
  if (args.command === "init" && count > 1) throw new TypeError("init accepts at most one directory");
  if (["up", "doctor", "run"].includes(args.command) && count !== 0) {
    throw new TypeError(`${args.command} accepts no positional arguments`);
  }
  if (["watch", "open", "replay", "verify-bundle", "juggler"].includes(args.command) && count !== 1) {
    throw new TypeError(`${args.command} requires exactly one positional reference`);
  }
  if (args.command === "compare" && count !== 2) {
    throw new TypeError("compare requires exactly two positional references");
  }
  const action = args.positionals[0];
  const only = (names: readonly string[]) => { for (const name of args.options.keys()) if (!["json", "help", ...names].includes(name)) throw new TypeError(`${args.command} ${action ?? ""} does not accept --${name}`); };
  const requireOption = (name: string) => { if (!option(args, name)?.trim()) throw new TypeError(`--${name} is required`); };
  if (args.command === "benchmark") {
    if (count === 0) only(["url", "corpus", "report", "validate-only"]);
    else {
      if (count !== 1 || !["build", "run", "compare"].includes(action!)) throw new TypeError("benchmark accepts build, run, or compare");
      only(action === "run" ? ["file", "report", "signing-key-ref"] : ["file", "report"]); requireOption("file");
      if (action === "run") requireOption("signing-key-ref");
    }
  }
  if (args.command === "genome") {
    if (action === "inspect" && count === 1) only(["report"]);
    else if (action === "propose" && count === 1) { only(["file", "report"]); requireOption("file"); }
    else if (action === "promote" && count === 2 && /^sha256:[a-f0-9]{64}$/u.test(args.positionals[1]!)) { only(["attestation", "report"]); requireOption("attestation"); }
    else throw new TypeError("genome requires inspect, propose --file FILE, or promote DIGEST --attestation FILE");
  }
  if (args.command === "preset") {
    if (["off", "wild"].includes(action!) && count === 1) only(["report"]);
    else if (action === "use" && count === 2 && /^sha256:[a-f0-9]{64}$/u.test(args.positionals[1]!)) only(["report"]);
    else if (action === "save" && count === 1) { only(["file", "report", "name", "configuration", "signing-key-ref"]); for (const key of ["file", "name", "configuration", "signing-key-ref"]) requireOption(key); }
    else throw new TypeError("preset requires save, use DIGEST, off, or wild");
  }
  if (args.command === "airlock") {
    if (count === 0 && !option(args, "file") || count === 1 && !["create", "show", "edit", "seal"].includes(action!)) only(["url", "chamber-url", "no-open"]);
    else if ((count === 0 || action === "create" && count === 1)) { only(["url", "file"]); requireOption("file"); }
    else if (action === "show" && count === 2) only(["url"]);
    else if (action === "edit" && count === 2) { only(["url", "file", "revision"]); requireOption("file"); requireOption("revision"); }
    else if (action === "seal" && count === 2) { only(["url", "revision", "policy-digest"]); requireOption("revision"); requireOption("policy-digest"); }
    else throw new TypeError("airlock accepts one source path, or create, show, edit, or seal with finite draft arguments");
  }
  if (args.command === "run" && Number(args.options.has("file")) + Number(args.options.has("case")) !== 1) throw new TypeError("run requires exactly one of --file or --case");
  if (args.command === "abort" && (count !== 1 || !/^case_[a-f0-9]{16}$/u.test(action!))) throw new TypeError("abort requires a canonical CASE_ID");
  if (args.command === "juggler") {
    if (!/^case_[a-f0-9]{16}$/u.test(args.positionals[0]!)) throw new TypeError("juggler requires a canonical CASE_ID");
    const kind = option(args, "redeem");
    const quantity = option(args, "quantity");
    if (quantity !== undefined && (kind === undefined || !/^[1-9][0-9]?$/u.test(quantity) || Number(quantity) > 64)) throw new TypeError("--quantity requires --redeem and an integer from 1 through 64");
    if (kind !== undefined && !["Mass", "Refraction", "Polarity", "Fission", "Inertia"].includes(kind)) {
      throw new TypeError("--redeem must be Mass, Refraction, Polarity, Fission, or Inertia");
    }
  }
  if (args.command === "mcp" && (count !== 1 || args.positionals[0] !== "serve")) {
    throw new TypeError("mcp requires exactly the subcommand serve");
  }
}

export function parseSubject(input: string, id = "subject-1"): SubjectReference {
  const divider = input.indexOf(":");
  if (divider <= 0 || divider === input.length - 1)
    throw new TypeError("--subject must be KIND:LOCATOR");
  const kind = input.slice(0, divider);
  if (!["git", "directory", "file", "url", "text", "artifact"].includes(kind)) {
    throw new TypeError("Subject kind must be git, directory, file, url, text, or artifact");
  }
  const rawLocator = input.slice(divider + 1);
  if (kind === "git") {
    const at = rawLocator.lastIndexOf("@");
    const revision = at > 0 ? rawLocator.slice(at + 1) : "";
    if (/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u.test(revision)) {
      return {
        id,
        kind: "git",
        locator: rawLocator.slice(0, at),
        revision: revision.toLowerCase(),
      };
    }
  }
  return { id, kind: kind as SubjectReference["kind"], locator: rawLocator };
}

export function privacy(value: string | undefined, fallback: Privacy): Privacy {
  if (value === undefined) return fallback;
  if (!["full_case", "provider_scoped", "local_only"].includes(value))
    throw new TypeError(`Invalid privacy: ${value}`);
  return value as Privacy;
}

export function control(value: string | undefined, fallback: Control): Control {
  if (value === undefined) return fallback;
  if (value !== "sovereign" && value !== "juggler")
    throw new TypeError(`Invalid control: ${value}`);
  return value as Control;
}

export function caseMode(value: string | undefined): NonNullable<CaseIntent["mode"]> | undefined {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "audit" && value !== "design") {
    throw new TypeError(`Invalid mode: ${value}`);
  }
  return value as NonNullable<CaseIntent["mode"]>;
}
