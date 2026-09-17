import { isProxy } from "node:util/types";
import type { CapabilityCard, ToolAdapter } from "./contracts.js";
import { SealedForgeAdapter } from "./forge.js";

const CARD_FIELDS = Object.freeze([
  "id",
  "kind",
  "displayName",
  "version",
  "transport",
  "trust",
  "modalities",
  "network",
  "canExecuteTools",
  "deterministic",
  "limits",
] as const);
const REQUIRED_CARD_FIELDS = Object.freeze(CARD_FIELDS.filter((field) => field !== "limits"));
const KINDS = new Set(["mind", "tool", "peer"]);
const TRANSPORTS = new Set(["process", "http", "in-process", "a2a"]);
const TRUST_LEVELS = new Set(["inner", "quarantined", "local-deterministic"]);
const MODALITIES = new Set(["text", "files", "commands", "structured-data"]);
const NETWORK_SCOPES = new Set(["none", "loopback", "provider", "unrestricted"]);
const ADAPTER_CAPABILITIES = new WeakMap<object, CapabilityCard>();

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${path} must be a plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain or null-prototype object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an enumerable own data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${path}.${key} is not a recognized capability field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must be an ordinary array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0 || (lengthDescriptor.value as number) > maximum) {
    throw new TypeError(`${path} must contain at most ${maximum} entries`);
  }
  const length = lengthDescriptor.value as number;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw new TypeError(`${path}.${key} is not an ordinary array entry`);
    }
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} must not contain holes or accessor entries`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} must contain 1–${maximum} non-control characters`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${path} contains malformed Unicode`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${path} contains malformed Unicode`);
    }
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<string>, path: string): T {
  if (typeof value !== "string" || !values.has(value)) throw new TypeError(`${path} is invalid`);
  return value as T;
}

function capabilityLimits(value: unknown): Readonly<Record<string, number | string | boolean>> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "CapabilityCard.limits");
  const keys = Object.keys(input).sort();
  if (keys.length > 256) throw new TypeError("CapabilityCard.limits contains too many entries");
  const output: Record<string, number | string | boolean> = {};
  for (const key of keys) {
    boundedString(key, "CapabilityCard.limits key", 256);
    const entry = input[key];
    let admitted: number | string | boolean;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError(`CapabilityCard.limits.${key} must be finite`);
      admitted = entry;
    } else if (typeof entry === "string") {
      admitted = boundedString(entry, `CapabilityCard.limits.${key}`, 4_096);
    } else if (typeof entry === "boolean") {
      admitted = entry;
    } else {
      throw new TypeError(`CapabilityCard.limits.${key} must be a number, string, or boolean`);
    }
    Object.defineProperty(output, key, {
      value: admitted,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output);
}

/** Creates one immutable, side-effect-free representation of adapter provenance. */
export function snapshotCapabilityCard(value: unknown): CapabilityCard {
  const input = record(value, "CapabilityCard");
  exactKeys(input, CARD_FIELDS, REQUIRED_CARD_FIELDS, "CapabilityCard");
  const modalities = denseArray(input.modalities, "CapabilityCard.modalities", MODALITIES.size)
    .map((entry) => enumValue<CapabilityCard["modalities"][number]>(entry, MODALITIES, "CapabilityCard.modalities"));
  if (new Set(modalities).size !== modalities.length) {
    throw new TypeError("CapabilityCard.modalities must be unique");
  }
  if (typeof input.canExecuteTools !== "boolean" || typeof input.deterministic !== "boolean") {
    throw new TypeError("CapabilityCard execution and determinism flags must be booleans");
  }
  if (Object.hasOwn(input, "limits") && input.limits === undefined) {
    throw new TypeError("CapabilityCard.limits must be omitted or an exact limits object");
  }
  const limits = capabilityLimits(input.limits);
  return Object.freeze({
    id: boundedString(input.id, "CapabilityCard.id", 256),
    kind: enumValue<CapabilityCard["kind"]>(input.kind, KINDS, "CapabilityCard.kind"),
    displayName: boundedString(input.displayName, "CapabilityCard.displayName", 256),
    version: boundedString(input.version, "CapabilityCard.version", 256),
    transport: enumValue<CapabilityCard["transport"]>(input.transport, TRANSPORTS, "CapabilityCard.transport"),
    trust: enumValue<CapabilityCard["trust"]>(input.trust, TRUST_LEVELS, "CapabilityCard.trust"),
    modalities: Object.freeze(modalities),
    network: enumValue<CapabilityCard["network"]>(input.network, NETWORK_SCOPES, "CapabilityCard.network"),
    canExecuteTools: input.canExecuteTools,
    deterministic: input.deterministic,
    ...(limits === undefined ? {} : { limits }),
  });
}

/**
 * Snapshots an adapter's own data property exactly once. The sole accessor
 * exception is the unforgeably branded built-in Forge, whose card is backed by
 * frozen private state. Caller-supplied accessors are never invoked.
 */
export function snapshotAdapterCapability(
  adapter: { readonly capability: CapabilityCard },
): CapabilityCard {
  if (adapter === null || typeof adapter !== "object" || isProxy(adapter)) {
    throw new TypeError("Adapter must be a non-Proxy object");
  }
  const existing = ADAPTER_CAPABILITIES.get(adapter);
  if (existing !== undefined) return existing;
  const descriptor = Object.getOwnPropertyDescriptor(adapter, "capability");
  let value: unknown;
  if (descriptor !== undefined && descriptor.enumerable && "value" in descriptor) {
    value = descriptor.value;
  } else if (SealedForgeAdapter.isBuiltIn(adapter as ToolAdapter)) {
    value = adapter.capability;
  } else {
    throw new TypeError("Adapter capability must be an enumerable own data property");
  }
  const snapshot = snapshotCapabilityCard(value);
  ADAPTER_CAPABILITIES.set(adapter, snapshot);
  return snapshot;
}

/** Returns the first admitted snapshot, never the adapter's live property. */
export function adapterCapabilitySnapshot(adapter: { readonly capability: CapabilityCard }): CapabilityCard {
  return ADAPTER_CAPABILITIES.get(adapter) ?? snapshotAdapterCapability(adapter);
}
