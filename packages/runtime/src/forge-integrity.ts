import type { ToolObservation } from "./contracts.js";

/** Classifies host-observed failures; adapter prose cannot confer authority. */
export function forgeIntegrityFailure(
  observation: ToolObservation,
  boundary: {
    readonly builtInSandbox: boolean;
    readonly adapterThrew: boolean;
    readonly interrupted: boolean;
    readonly authorityProblem?: string;
  },
): "integrity.sandbox_failure" | "integrity.capability_loss" | undefined {
  // Enforcing a sealed deadline, user interruption, or physical limit is a
  // functioning boundary, not evidence that the execution substrate was lost.
  if (boundary.interrupted || observation.metadata?.reason === "bone-cell-deadline"
    || observation.metadata?.nonAdmissibleReason === "physical-resource-limit"
    || observation.oracle?.execution.state === "timed-out") return undefined;
  if (boundary.adapterThrew) return "integrity.sandbox_failure";
  if (!boundary.builtInSandbox) return undefined;
  if (observation.metadata?.reason === "docker-unavailable") return "integrity.sandbox_failure";
  if (observation.metadata?.nonAdmissibleReason === "boundary-or-integrity-failure"
    || observation.metadata?.reason === "forge-observation-invalid"
    || observation.metadata?.reason === "forge-invocation-id-mismatch"
    || (observation.oracle?.execution.state === "exited" && boundary.authorityProblem !== undefined)) {
    return "integrity.capability_loss";
  }
  return undefined;
}
