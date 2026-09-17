"""Editable local Airlock previews. Authenticity begins at the signed Seal."""
from __future__ import annotations
import re
from typing import Any
from .juggler import _check, _exact
from .metabolism import _hash, _digest, _integer

def assert_draft_id(value: Any) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"draft_[a-f0-9]{32}", value):
        raise ValueError("Invalid draft identifier")

def assert_revision(value: Any) -> None:
    if not _integer(value, 1, 32):
        raise ValueError("Draft revision must be an integer from 1 through 32")

def validate_choices(raw: Any) -> dict[str, Any]:
    _check(isinstance(raw, dict) and not set(raw) - {"capabilityIds", "resourceCeiling", "preset", "sandbox"}, "Unknown Airlock execution choice")
    if "preset" in raw:
        _check(raw["preset"] in ("startup", "wild"), "Unknown Airlock preset choice")
    if "sandbox" in raw:
        _check(raw["sandbox"] in ("configured", "observe_only"), "Unknown Airlock sandbox choice")
    if "capabilityIds" in raw:
        ids = raw["capabilityIds"]
        _check(isinstance(ids, list) and len(ids) <= 128 and all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value) for value in ids) and len(set(ids)) == len(ids), "Invalid selected capability identities")
    if "resourceCeiling" in raw:
        resources = raw["resourceCeiling"]
        allowed = {"maxMindInvocations", "maxInputTokens", "maxOutputTokens", "maxWallMillis", "maxSingleInvocationMillis", "maxGeneratedBytes", "maxForgeCpuMillis", "maxForgeWallMillis", "maxMemorySeconds", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "maxNetworkBytes", "concurrentLineages", "maxTotalAssayCost"}
        _check(isinstance(resources, dict) and not set(resources) - allowed and all(_integer(value, 0) for value in resources.values()), "Invalid finite resource ceilings")
    return raw

def validate_draft(raw: Any) -> dict[str, Any]:
    from .client import assert_intent_contract_payload, _assert_seal_receipt, _valid_canonical_timestamp
    fields = {"protocol", "draftId", "revision", "state", "createdAt", "updatedAt", "submission", "submissionDigest", "preview", "startup", "choices", "choicesDigest"}
    if isinstance(raw, dict) and "receipt" in raw:
        fields.add("receipt")
    draft = _exact(raw, fields, "Airlock draft")
    assert_draft_id(draft["draftId"]); assert_revision(draft["revision"])
    _check(draft["protocol"] == "jevyr.airlock-draft/1" and draft["state"] in ("DRAFT", "SEALING", "SEALED", "FAILED") and _valid_canonical_timestamp(draft["createdAt"]) and _valid_canonical_timestamp(draft["updatedAt"]), "Invalid Airlock state or time")
    submission = _exact(draft["submission"], {"protocol", "case"}, "Draft submission")
    _check(submission["protocol"] == "jevyr.case/1" and isinstance(submission["case"], dict) and isinstance(submission["case"].get("impulse"), str) and bool(submission["case"]["impulse"].strip()) and not set(submission["case"]) - {"impulse", "mode", "subjects", "constraints", "requestedAssays", "privacy", "control", "seed"}, "Invalid Airlock submission")
    _check(_hash(submission) == draft["submissionDigest"], "Airlock submission digest mismatch")
    choices = validate_choices(draft["choices"])
    _check(_hash(choices) == draft["choicesDigest"], "Airlock execution choices digest mismatch")
    preview = assert_intent_contract_payload(draft["preview"])
    _check(preview["originalImpulse"] == submission["case"]["impulse"] and _hash({k:v for k,v in preview.items() if k != "digest"}) == preview["digest"], "Airlock preview describes a different submission")
    startup_fields = {"policyDigest", "genomeDigest", "genomeVersion", "searchEnvelope", "capabilities", "policy", "subjectCapture"}
    if isinstance(draft["startup"], dict):
        startup_fields.update(set(draft["startup"]) & {"availableCapabilities", "resourceMaximum"})
    startup = _exact(draft["startup"], startup_fields, "Airlock startup")
    _check(_digest(startup["genomeDigest"]) and isinstance(startup["capabilities"], list) and len(startup["capabilities"]) <= 256 and _hash(startup["policy"]) == startup["policyDigest"], "Airlock startup policy digest mismatch")
    if choices:
        _check(isinstance(startup["policy"], dict) and isinstance(startup["policy"].get("policy"), dict) and startup["policy"]["policy"].get("airlockChoicesDigest") == draft["choicesDigest"], "Airlock policy describes different execution choices")
    if "availableCapabilities" in startup:
        _check(isinstance(startup["availableCapabilities"], list) and len(startup["availableCapabilities"]) <= 256, "Invalid available capability preview")
    if "resourceMaximum" in startup:
        validate_choices({"resourceCeiling": startup["resourceMaximum"]})
    if draft["state"] == "SEALED":
        receipt = _assert_seal_receipt(draft.get("receipt"))
        _check(receipt["submissionDigest"] == draft["submissionDigest"] and receipt["policyDigest"] == startup["policyDigest"], "Airlock Seal changed the previewed policy or submission")
    else:
        _check("receipt" not in draft, "Unsealed draft contains a Seal")
    return draft
