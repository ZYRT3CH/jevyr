import type { SearchResourceEnvelope } from "./types.js";

/** Editable only before Seal. These choices may narrow startup authority; Wild
 * removes preset restrictions while retaining the startup Genome and policy. */
export interface AirlockChoices {
  readonly capabilityIds?: readonly string[];
  readonly resourceCeiling?: Partial<SearchResourceEnvelope>;
  readonly preset?: "startup" | "wild";
  readonly sandbox?: "configured" | "observe_only";
}

export function validateAirlockChoices(raw: unknown = {}): AirlockChoices {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["capabilityIds", "resourceCeiling", "preset", "sandbox"].includes(key))) throw new TypeError("Unknown Airlock execution choice");
  const value = raw as AirlockChoices;
  if (value.preset !== undefined && !["startup", "wild"].includes(value.preset)) throw new TypeError("Unknown preset choice");
  if (value.sandbox !== undefined && !["configured", "observe_only"].includes(value.sandbox)) throw new TypeError("Unknown sandbox choice");
  if (value.capabilityIds !== undefined && (!Array.isArray(value.capabilityIds) || value.capabilityIds.length > 128
    || value.capabilityIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id))
    || new Set(value.capabilityIds).size !== value.capabilityIds.length)) throw new TypeError("Capability selection must contain unique configured identifiers");
  if (value.resourceCeiling !== undefined && (!value.resourceCeiling || typeof value.resourceCeiling !== "object" || Array.isArray(value.resourceCeiling)
    || Object.values(value.resourceCeiling).some(amount => !Number.isSafeInteger(amount) || amount < 0))) throw new TypeError("Resource ceilings must be nonnegative bounded integers");
  return Object.freeze(structuredClone(value));
}
