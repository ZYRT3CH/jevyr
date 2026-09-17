import { digestJson, type JsonValue } from "@jevyr/protocol";
import type { SealedAssayPlan } from "./assay-frontier.js";

/** This finite language cannot execute evaluator JavaScript or alter an oracle. */
export interface BrowserProbeSpec {
  readonly protocol: "jevyr.browser-probe/1";
  readonly entry: string;
  readonly steps: readonly (
    | { action: "click"; selector: string }
    | { action: "fill"; selector: string; value: string }
    | { action: "assert-text"; selector: string; expected: string }
    | { action: "assert-count"; selector: string; expected: number }
  )[];
}
export const BROWSER_PROBE_RUNNER = "/opt/jevyr/browser-probe.mjs";

export function validateBrowserProbeSpec(value: unknown): BrowserProbeSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Browser probe must be an object");
  const spec = value as BrowserProbeSpec;
  if (Object.keys(spec).sort().join(",") !== "entry,protocol,steps" || spec.protocol !== "jevyr.browser-probe/1"
    || typeof spec.entry !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*\.html$/u.test(spec.entry) || spec.entry.split("/").some(part => part === ".." || part === ".")
    || !Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 64) throw new TypeError("Invalid bounded browser probe");
  for (const step of spec.steps) {
    if (!step || typeof step !== "object" || !["click", "fill", "assert-text", "assert-count"].includes(step.action)
      || typeof step.selector !== "string" || !step.selector || step.selector.length > 1024) throw new TypeError("Invalid browser probe step");
    const allowed = step.action === "click" ? ["action", "selector"] : step.action === "fill" ? ["action", "selector", "value"] : ["action", "expected", "selector"];
    if (Object.keys(step).sort().join(",") !== allowed.sort().join(",")) throw new TypeError("Unknown browser probe step field");
    if (step.action === "fill" && (typeof step.value !== "string" || step.value.length > 8192)) throw new TypeError("Invalid fill value");
    if (step.action === "assert-text" && (typeof step.expected !== "string" || step.expected.length > 8192)) throw new TypeError("Invalid expected text");
    if (step.action === "assert-count" && (!Number.isSafeInteger(step.expected) || step.expected < 0 || step.expected > 10000)) throw new TypeError("Invalid expected count");
  }
  if (!spec.steps.some(step => step.action.startsWith("assert-"))) throw new TypeError("Browser probe requires a discriminating assertion");
  return Object.freeze(JSON.parse(JSON.stringify(spec)) as BrowserProbeSpec);
}

/** The runner and Playwright live in the startup-pinned image, outside candidate writes. */
export function browserProbeAssay(spec: BrowserProbeSpec, obligationId?: string): SealedAssayPlan {
  const canonical = validateBrowserProbeSpec(spec);
  const encoded = Buffer.from(JSON.stringify(canonical)).toString("base64url");
  return Object.freeze({
    assayId: `browser.${digestJson(canonical as unknown as JsonValue).slice(7, 27)}`,
    costUnits: 1, tool: "forge.command", args: { command: "node", args: [BROWSER_PROBE_RUNNER, encoded] }, timeoutMs: 60_000,
    ...(obligationId === undefined ? {} : { obligationId }),
  });
}
