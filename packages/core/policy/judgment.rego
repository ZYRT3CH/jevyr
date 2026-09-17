package jevyr.bone

import rego.v1

# This policy consumes only typed graph projections. There are no prompt,
# provider, preference, clock, random, network, or host builtins.
surviving := [candidate | some candidate in input.candidates; candidate.survived; candidate.feasibility != "CONTRADICTED"]
selected := [candidate | some candidate in input.candidates; candidate.selected]
critical := [obligation | some obligation in input.obligations; obligation.critical]

fatal if { some issue in input.integrityIssues; issue.severity == "fatal" }
fatal if { some finding in input.auditFindings; finding.impact == "invalid" }
pre_invalid if { some issue in input.integrityIssues; issue.severity == "fatal"; issue.phase == "pre_judgment" }
pre_invalid if { some finding in input.auditFindings; finding.impact == "invalid" }

integrity := "INVALID" if fatal else := "VALID"
creation := "FAILED" if input.creationFailed else := "FAILED" if count(input.candidates) == 0 else := "NO_SURVIVOR" if count(surviving) == 0 else := "CONCEIVED"
embodiment := "BUILT" if { count(selected) > 0; selected[0].embodiment == "built" } else := "FAILED" if { some candidate in input.candidates; candidate.embodiment == "failed" } else := "NOT_BUILT"

refuted if { count(selected) > 1 }
refuted if { some assay in input.assays; assay.critical; assay.status == "failed" }
refuted if { some obligation in critical; obligation.refutationWeight >= 3; obligation.refutationWeight >= obligation.supportWeight }
refuted if { count(selected) > 0; selected[0].feasibility == "CONTRADICTED" }

unproven if { count(critical) == 0 }
unproven if { creation != "CONCEIVED" }
unproven if { some obligation in critical; obligation.assayability == "unassayable" }
unproven if { some obligation in critical; obligation.supportWeight < 3 }
unproven if { some assay in input.assays; assay.critical; assay.status != "passed"; assay.status != "failed" }
unproven if { some finding in input.auditFindings; finding.impact == "unproven" }

judgment := "NOT_APPLICABLE" if pre_invalid else := "REJECT" if refuted else := "UNPROVEN" if unproven else := "ACCEPT"

axes := {"integrity": integrity, "creation": creation, "embodiment": embodiment, "judgment": judgment}
