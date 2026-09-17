import { isProxy } from "node:util/types";
import {
  SealedForgeAdapter,
  adapterCapabilitySnapshot,
  type CapabilityCard,
  type MindAdapter,
  type ProbeResult,
  type ToolAdapter,
} from "@jevyr/runtime";
import type { DaemonRuntime } from "./runtime.js";

export const READINESS_PROTOCOL = "jevyr.readiness/1" as const;

export type ReadinessProbeStatus = "available" | "unavailable" | "failed" | "timed-out" | "invalid";
export type ReadinessBlockerCode =
  | "models.template-only"
  | "models.reasoning-unavailable"
  | "forge.observe-only"
  | "forge.diagnostic-only"
  | "forge.opaque"
  | "forge.substrate-unavailable"
  | "forge.execution-disabled"
  | "forge.probe-unavailable"
  | "assays.empty";

export interface SafeReadinessProbe {
  readonly status: ReadinessProbeStatus;
  readonly observedAt: string;
  readonly latencyMs: number;
}

export interface DaemonReadiness {
  readonly protocol: typeof READINESS_PROTOCOL;
  readonly ready: boolean;
  readonly scope: "infrastructure";
  readonly observedAt: string;
  readonly semanticContinuation: false;
  readonly models: {
    readonly status: "ready" | "template-only" | "unavailable";
    readonly mode: "template-only" | "local" | "remote" | "mixed" | "configured-unavailable";
    readonly configuredCount: number;
    readonly availableCount: number;
    readonly reasoningConfiguredCount: number;
    readonly reasoningAvailableCount: number;
    readonly adapters: readonly {
      readonly id: string;
      readonly role: "template" | "reasoning";
      readonly configured: true;
      readonly transport: CapabilityCard["transport"];
      readonly network: CapabilityCard["network"];
      readonly probe: SafeReadinessProbe;
    }[];
  };
  readonly forge: {
    readonly id: string;
    readonly mode: "docker" | "trusted-host" | "observe-only" | "opaque";
    readonly configured: true;
    readonly status: "ready" | "substrate-unavailable" | "execution-disabled" | "probe-unavailable" | "observe-only" | "diagnostic-only" | "opaque";
    readonly canExecuteTools: boolean;
    readonly network: CapabilityCard["network"];
    readonly probe: SafeReadinessProbe;
    readonly evidenceAuthority: "verified-docker" | "diagnostic-only" | "none";
    readonly substrate: {
      readonly status: "resolved" | "unavailable" | "not-applicable" | "opaque";
      readonly immutableImageId: string | null;
    };
    readonly usable: boolean;
  };
  readonly assays: {
    readonly status: "admitted" | "empty";
    readonly mode: "empty" | "comparative-only" | "case-binding-configured" | "mixed";
    readonly count: number;
    readonly ids: readonly string[];
    readonly frontierDigest: string;
    readonly caseApplicability: "case-dependent";
  };
  readonly blockers: readonly {
    readonly code: ReadinessBlockerCode;
    readonly component: "models" | "forge" | "assays";
    readonly detail: string;
  }[];
}

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_CACHE_MS = 5_000;
const TIMED_OUT = Symbol("readiness-probe-timeout");
const BLOCKER_DETAILS: Readonly<Record<ReadinessBlockerCode, string>> = Object.freeze({
  "models.template-only": "Only RuleMind's deterministic templates are configured; no reasoning model can generate independent candidates.",
  "models.reasoning-unavailable": "Reasoning models are configured, but none passed a live availability probe.",
  "forge.observe-only": "Forge is observation-only and cannot execute an assay.",
  "forge.diagnostic-only": "Trusted-host Forge output is diagnostic and cannot become verdict evidence.",
  "forge.opaque": "The embedder-defined Forge has no verifiable Docker evidence authority.",
  "forge.substrate-unavailable": "The Docker image was not resolved to an immutable local image ID at daemon startup.",
  "forge.execution-disabled": "The configured Forge capability cannot execute tools.",
  "forge.probe-unavailable": "The startup-sealed Docker substrate did not pass its current availability probe.",
  "assays.empty": "The compile-admitted Assay Frontier is empty; no candidate can enter a configured experiment.",
});

function elapsedMilliseconds(started: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(performance.now() - started)));
}

function ownAvailable(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "available");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "boolean"
    ? descriptor.value
    : undefined;
}

/**
 * Probe output is deliberately reduced to daemon-owned timing and controlled
 * states. Adapter detail/version strings can contain command output, paths, or
 * provider diagnostics and never cross this browser-readable boundary.
 */
async function safeProbe(
  adapter: Pick<MindAdapter | ToolAdapter, "probe">,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<SafeReadinessProbe> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invocation = Promise.resolve().then(async () => await adapter.probe(controller.signal));
  void invocation.catch(() => undefined);
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort("Jevyr readiness probe deadline reached");
      resolve(TIMED_OUT);
    }, timeoutMs);
    timer.unref();
  });
  try {
    const result: ProbeResult | typeof TIMED_OUT = await Promise.race([invocation, deadline]);
    const observedAt = new Date().toISOString();
    const latencyMs = elapsedMilliseconds(started);
    if (result === TIMED_OUT) return { status: "timed-out", observedAt, latencyMs };
    const available = ownAvailable(result);
    return {
      status: available === undefined ? "invalid" : available ? "available" : "unavailable",
      observedAt,
      latencyMs,
    };
  } catch {
    return {
      status: "failed",
      observedAt: new Date().toISOString(),
      latencyMs: elapsedMilliseconds(started),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Backward-compatible capability probe with all adapter-authored text erased. */
export async function readSanitizedCapabilityProbe(
  adapter: Pick<MindAdapter | ToolAdapter, "probe">,
): Promise<ProbeResult> {
  const probe = await safeProbe(adapter);
  return {
    available: probe.status === "available",
    observedAt: probe.observedAt,
    latencyMs: probe.latencyMs,
    detail: probe.status === "available"
      ? "Adapter availability probe passed."
      : `Adapter availability probe state: ${probe.status}.`,
  };
}

function templateCapability(capability: CapabilityCard): boolean {
  return capability.id === "mind.rule.v1"
    && capability.transport === "in-process"
    && capability.network === "none"
    && capability.deterministic;
}

function forgeView(
  forge: ToolAdapter,
  capability: CapabilityCard,
  probe: SafeReadinessProbe,
): DaemonReadiness["forge"] {
  if (!SealedForgeAdapter.isBuiltIn(forge)) {
    return {
      id: capability.id,
      mode: "opaque",
      configured: true,
      status: "opaque",
      canExecuteTools: capability.canExecuteTools,
      network: capability.network,
      probe,
      evidenceAuthority: "diagnostic-only",
      substrate: { status: "opaque", immutableImageId: null },
      usable: false,
    };
  }

  const mode = forge.mode;
  if (mode !== "docker") {
    return {
      id: capability.id,
      mode,
      configured: true,
      status: mode === "observe-only" ? "observe-only" : "diagnostic-only",
      canExecuteTools: capability.canExecuteTools,
      network: capability.network,
      probe,
      evidenceAuthority: mode === "observe-only" ? "none" : "diagnostic-only",
      substrate: { status: "not-applicable", immutableImageId: null },
      usable: false,
    };
  }

  const identity = forge.dockerSubstrateIdentity;
  const substrate = identity?.status === "resolved" && identity.immutableImageId !== null
    ? { status: "resolved" as const, immutableImageId: identity.immutableImageId }
    : { status: "unavailable" as const, immutableImageId: null };
  return {
    id: capability.id,
    mode,
    configured: true,
    status: substrate.status !== "resolved"
      ? "substrate-unavailable"
      : !capability.canExecuteTools
        ? "execution-disabled"
        : probe.status !== "available"
          ? "probe-unavailable"
          : "ready",
    canExecuteTools: capability.canExecuteTools,
    network: capability.network,
    probe,
    evidenceAuthority: "verified-docker",
    substrate,
    usable: substrate.status === "resolved"
      && capability.canExecuteTools
      && probe.status === "available",
  };
}

function forgeBlocker(forge: DaemonReadiness["forge"]): ReadinessBlockerCode | undefined {
  if (forge.mode === "observe-only") return "forge.observe-only";
  if (forge.mode === "trusted-host") return "forge.diagnostic-only";
  if (forge.mode === "opaque") return "forge.opaque";
  if (forge.substrate.status !== "resolved") return "forge.substrate-unavailable";
  if (!forge.canExecuteTools) return "forge.execution-disabled";
  if (forge.probe.status !== "available") return "forge.probe-unavailable";
  return undefined;
}

export async function readDaemonReadiness(runtime: DaemonRuntime): Promise<DaemonReadiness> {
  const modelCapabilities = runtime.minds.map((mind) => adapterCapabilitySnapshot(mind));
  const forgeCapability = adapterCapabilitySnapshot(runtime.forge);
  const [modelProbes, forgeProbe] = await Promise.all([
    Promise.all(runtime.minds.map(async (mind) => await safeProbe(mind))),
    safeProbe(runtime.forge),
  ]);
  const adapters = modelCapabilities.map((capability, index) => ({
    id: capability.id,
    role: templateCapability(capability) ? "template" as const : "reasoning" as const,
    configured: true as const,
    transport: capability.transport,
    network: capability.network,
    probe: modelProbes[index]!,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const reasoning = adapters.filter((adapter) => adapter.role === "reasoning");
  const availableReasoning = reasoning.filter((adapter) => adapter.probe.status === "available");
  const reasoningAvailableCount = availableReasoning.length;
  const localAvailable = availableReasoning.some((adapter) => adapter.network === "none" || adapter.network === "loopback");
  const remoteAvailable = availableReasoning.some((adapter) => adapter.network === "provider" || adapter.network === "unrestricted");
  const models: DaemonReadiness["models"] = {
    status: reasoningAvailableCount > 0
      ? "ready"
      : reasoning.length === 0
        ? "template-only"
        : "unavailable",
    mode: reasoning.length === 0
      ? "template-only"
      : reasoningAvailableCount === 0
        ? "configured-unavailable"
        : localAvailable && remoteAvailable
          ? "mixed"
          : remoteAvailable
            ? "remote"
            : "local",
    configuredCount: adapters.length,
    availableCount: adapters.filter((adapter) => adapter.probe.status === "available").length,
    reasoningConfiguredCount: reasoning.length,
    reasoningAvailableCount,
    adapters,
  };
  const forge = forgeView(runtime.forge, forgeCapability, forgeProbe);
  const ids = runtime.assayFrontier.assays.map((assay) => assay.assayId).sort();
  const comparativeAssays = runtime.assayFrontier.assays.filter((assay) => assay.obligationId === undefined).length;
  const boundAssays = runtime.assayFrontier.assays.length - comparativeAssays;
  const assays: DaemonReadiness["assays"] = {
    status: ids.length > 0 ? "admitted" : "empty",
    mode: ids.length === 0
      ? "empty"
      : comparativeAssays > 0 && boundAssays > 0
        ? "mixed"
        : comparativeAssays > 0
          ? "comparative-only"
          : "case-binding-configured",
    count: ids.length,
    ids,
    frontierDigest: runtime.assayFrontier.digest,
    caseApplicability: "case-dependent",
  };
  const blockers: Array<DaemonReadiness["blockers"][number]> = [];
  if (models.status === "template-only") {
    blockers.push({ code: "models.template-only", component: "models", detail: BLOCKER_DETAILS["models.template-only"] });
  } else if (models.status === "unavailable") {
    blockers.push({ code: "models.reasoning-unavailable", component: "models", detail: BLOCKER_DETAILS["models.reasoning-unavailable"] });
  }
  const forgeProblem = forgeBlocker(forge);
  if (forgeProblem !== undefined) blockers.push({ code: forgeProblem, component: "forge", detail: BLOCKER_DETAILS[forgeProblem] });
  if (assays.status === "empty") {
    blockers.push({ code: "assays.empty", component: "assays", detail: BLOCKER_DETAILS["assays.empty"] });
  }
  return {
    protocol: READINESS_PROTOCOL,
    ready: blockers.length === 0,
    scope: "infrastructure",
    observedAt: new Date().toISOString(),
    semanticContinuation: false,
    models,
    forge,
    assays,
    blockers,
  };
}

/** Coalesces UI polling while still refreshing external probes every five seconds. */
export function createReadinessReader(
  runtime: DaemonRuntime,
  cacheMilliseconds = PROBE_CACHE_MS,
): () => Promise<DaemonReadiness> {
  if (!Number.isSafeInteger(cacheMilliseconds) || cacheMilliseconds < 0 || cacheMilliseconds > 60_000) {
    throw new RangeError("Readiness cache must be an integer from 0 through 60000 milliseconds");
  }
  let cached: { readonly value: DaemonReadiness; readonly expiresAt: number } | undefined;
  let inFlight: Promise<DaemonReadiness> | undefined;
  return async () => {
    if (cached !== undefined && performance.now() < cached.expiresAt) return cached.value;
    if (inFlight !== undefined) return await inFlight;
    inFlight = readDaemonReadiness(runtime).then((value) => {
      cached = { value, expiresAt: performance.now() + cacheMilliseconds };
      return value;
    }).finally(() => {
      inFlight = undefined;
    });
    return await inFlight;
  };
}
