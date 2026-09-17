"""Live additive work, independently signed under the exact presealed allowance."""
from __future__ import annotations
import hashlib
import re
from typing import Any, Mapping
from .juggler import _check, _exact

KINDS = ("Mass", "Refraction", "Polarity", "Fission", "Inertia")
RESOURCES = ("maxMindInvocations", "maxInputTokens", "maxOutputTokens", "maxWallMillis", "maxGeneratedBytes", "maxForgeCpuMillis", "maxForgeWallMillis", "maxMemorySeconds", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "maxTotalAssayCost")
WORK = ("general", "unfamiliarFamilies", "counterbelief", "isolatedLanes", "scentContinuation")
PAYLOAD_TYPE = "application/vnd.jevyr.metabolism-receipt+json"

def _hash(value: Any) -> str:
    from .client import _canonical
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()

def _digest(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) is not None

def _integer(value: Any, low: int = 0, high: int = 9007199254740991) -> bool:
    return type(value) is int and low <= value <= high

def _vector(value: Any, fields: tuple[str, ...] = RESOURCES) -> dict[str, Any]:
    result = _exact(value, set(fields), "Metabolic vector")
    _check(all(_integer(result[key]) for key in fields), "Metabolic vector contains an invalid bounded integer")
    return result

def assert_ball_id(value: Any) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"ball_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", value):
        raise ValueError("Metabolism requires a canonical offered ballId")

def assert_quantity(value: Any) -> None:
    if not _integer(value, 1, 64):
        raise ValueError("Metabolism quantity must be an integer from 1 through 64")

def allowance_from_policy(policy: Any, seal: Mapping[str, Any]) -> dict[str, Any]:
    _check(policy.get("caseId") == seal["caseId"] and policy.get("policyDigest") == seal["policyDigest"], "Metabolic policy crosses its authenticated Seal")
    allowance = _exact(policy.get("artifact", {}).get("descriptor", {}).get("policy", {}).get("metabolicAllowance"), {"protocol", "baselineSearchDigest", "maximumAddedResources", "maximumQuantityPerBall", "maximumReceipts", "unitCostCeilings", "calibrationSetDigest", "calibrations", "signer", "digest"}, "Metabolic allowance")
    _check(allowance["protocol"] == "jevyr.metabolic-allowance/1" and allowance["baselineSearchDigest"] == seal["searchDigest"] and _digest(allowance["digest"]) and _hash({k:v for k,v in allowance.items() if k != "digest"}) == allowance["digest"], "Metabolic allowance digest or baseline differs")
    _check(_integer(allowance["maximumQuantityPerBall"], 1, 64) and _integer(allowance["maximumReceipts"], 1, 4096), "Invalid metabolic bounds")
    _vector(allowance["maximumAddedResources"])
    ceilings = _exact(allowance["unitCostCeilings"], set(KINDS), "Metabolic ceilings")
    for kind in KINDS:
        _vector(ceilings[kind])
        _check(all(ceilings[kind][key] <= allowance["maximumAddedResources"][key] for key in RESOURCES), "Dose exceeds allowance")
    calibrations = allowance["calibrations"]
    _check(isinstance(calibrations, list) and len(calibrations) <= 5, "Unbounded metabolic calibration set")
    seen: set[str] = set()
    for value in calibrations:
        item = _exact(value, {"kind", "digest", "summaryDigest", "maximumDose"}, "Calibration binding")
        _check(_digest(item["summaryDigest"]), "Invalid calibration summary digest")
        _check(item["kind"] in KINDS and item["kind"] not in seen and _digest(item["digest"]) and _integer(item["maximumDose"], 2, 64), "Invalid calibration binding")
        seen.add(item["kind"])
    reports = sorted([{"kind": c["kind"], "digest": c["digest"]} for c in calibrations], key=lambda c:c["kind"])
    _check(_hash({"protocol":"jevyr.metabolic-calibration-set/1", "reports":reports}) == allowance["calibrationSetDigest"], "Calibration set digest mismatch")
    signer = _exact(allowance["signer"], {"keyId", "publicKeyPem"}, "Metabolic signer")
    _check(_digest(signer["keyId"]) and isinstance(signer["publicKeyPem"], str) and len(signer["publicKeyPem"]) <= 1024, "Invalid metabolic signer")
    return allowance

def verify_redemption(value: Any, allowance: Mapping[str, Any], seal: Mapping[str, Any], previous: Mapping[str, Any] | None = None) -> dict[str, Any]:
    from .client import _base64, _canonical, _dsse_pae, _loads_unambiguous, _public_key, _valid_canonical_timestamp
    from cryptography.exceptions import InvalidSignature
    result = _exact(value, {"protocol", "receipt", "envelope"}, "Metabolic redemption")
    _check(result["protocol"] == "jevyr.metabolism-redemption/1", "Invalid metabolic redemption protocol")
    receipt = _exact(result["receipt"], {"protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest", "allowanceDigest", "calibrationDigest", "ballId", "kind", "quantity", "sequence", "previousReceiptDigest", "issuedAt", "grant", "cumulativeGrant", "cumulativeQuantities", "work", "baselineUnchanged", "verdictAuthority", "digest"}, "Metabolic receipt")
    _check(receipt["protocol"] == "jevyr.metabolism-receipt/1" and receipt["baselineUnchanged"] is True and receipt["verdictAuthority"] == "none", "Metabolic receipt changes authority")
    _check(all(receipt[key] == seal[key] for key in ("caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest")) and receipt["allowanceDigest"] == allowance["digest"], "Metabolic receipt crosses the sealed identity")
    if previous:
        _check(all(previous[key] == receipt[key] for key in ("caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest", "allowanceDigest")), "Metabolic predecessor crosses the sealed identity")
    assert_ball_id(receipt["ballId"]); assert_quantity(receipt["quantity"])
    kind = receipt["kind"]
    calibration = next((c for c in allowance["calibrations"] if c["kind"] == kind), None)
    _check(kind in KINDS and calibration is not None and receipt["calibrationDigest"] == calibration["digest"], "Receipt lacks its exact measured calibration")
    _check(_integer(receipt["sequence"], 1, allowance["maximumReceipts"]) and receipt["sequence"] == (previous["sequence"] if previous else 0) + 1 and receipt["previousReceiptDigest"] == (previous["digest"] if previous else None), "Metabolic receipt sequence has a gap or wrong predecessor")
    _check(receipt["quantity"] <= allowance["maximumQuantityPerBall"] and _valid_canonical_timestamp(receipt["issuedAt"]), "Invalid metabolic quantity or timestamp")
    _check(_hash({k:v for k,v in receipt.items() if k != "digest"}) == receipt["digest"], "Metabolic receipt digest mismatch")
    grant = _vector(receipt["grant"]); cumulative = _vector(receipt["cumulativeGrant"]); quantities = _vector(receipt["cumulativeQuantities"], KINDS); work = _vector(receipt["work"], WORK)
    for key in RESOURCES:
        _check(grant[key] == allowance["unitCostCeilings"][kind][key] * receipt["quantity"] and cumulative[key] == (previous["cumulativeGrant"][key] if previous else 0) + grant[key] and cumulative[key] <= allowance["maximumAddedResources"][key], "Metabolic resource addition exceeds sealed allowance")
    for name in KINDS:
        _check(quantities[name] == (previous["cumulativeQuantities"][name] if previous else 0) + (receipt["quantity"] if name == kind else 0), "Metabolic cumulative quantity differs")
    _check(quantities[kind] <= calibration["maximumDose"], "Metabolic quantity exceeds measured dose")
    _check(all(work[name] == (receipt["quantity"] if name == WORK[KINDS.index(kind)] else 0) for name in WORK), "Metabolic receipt changes finite work kind")
    envelope = _exact(result["envelope"], {"payloadType", "payload", "signatures"}, "Metabolic envelope")
    _check(envelope["payloadType"] == PAYLOAD_TYPE and isinstance(envelope["signatures"], list) and len(envelope["signatures"]) == 1, "Metabolic envelope requires its separate signer")
    signature = _exact(envelope["signatures"][0], {"keyid", "sig"}, "Metabolic signature")
    _check(signature["keyid"] == allowance["signer"]["keyId"], "Metabolic signature is not the sealed signer")
    payload = _base64(envelope["payload"], "Metabolic payload")
    _check(_canonical(_loads_unambiguous(payload)) == payload == _canonical(receipt), "Signed metabolic payload differs from receipt")
    key, _spki = _public_key({**allowance["signer"], "algorithm":"Ed25519"})
    _check("sha256:" + hashlib.sha256(_spki).hexdigest() == allowance["signer"]["keyId"], "Metabolic SPKI key identity mismatch")
    try:
        key.verify(_base64(signature["sig"], "Metabolic signature"), _dsse_pae(PAYLOAD_TYPE, payload))
    except InvalidSignature:
        _check(False, "Metabolic receipt signature failed")
    return result

def verify_offers(value: Any, allowance: Mapping[str, Any], seal: Mapping[str, Any]) -> dict[str, Any]:
    from .client import _utf16_length
    result = _exact(value, {"protocol", "caseId", "runDigest", "allowanceDigest", "baselineSearchDigest", "admission", "cumulativeGrant", "cumulativeQuantities", "offers", "receipts"}, "Metabolic offers")
    _check(result["protocol"] == "jevyr.metabolic-offers/1" and result["caseId"] == seal["caseId"] and result["runDigest"] == seal["runDigest"] and result["allowanceDigest"] == allowance["digest"] and result["baselineSearchDigest"] == seal["searchDigest"] and result["admission"] in ("open", "closed"), "Metabolic offers cross sealed identity")
    _check(isinstance(result["receipts"], list) and len(result["receipts"]) <= min(320, allowance["maximumReceipts"]), "Unbounded metabolic receipt history")
    previous = None
    for entry in result["receipts"]:
        previous = verify_redemption(entry, allowance, seal, previous)["receipt"]
    grant = _vector(result["cumulativeGrant"]); quantities = _vector(result["cumulativeQuantities"], KINDS)
    _check(all(grant[k] == (previous["cumulativeGrant"][k] if previous else 0) for k in RESOURCES) and all(quantities[k] == (previous["cumulativeQuantities"][k] if previous else 0) for k in KINDS), "Metabolic offers omit signed history")
    offers = result["offers"]
    _check(isinstance(offers, list) and len(offers) <= 5 and (result["admission"] == "open" or not offers), "Invalid metabolic admission")
    seen_kinds: set[str] = set(); seen_balls: set[str] = set()
    for raw in offers:
        offer = _exact(raw, {"ballId", "kind", "minQuantity", "maxQuantity", "promisedEffect", "unitCostCeiling", "unitWork", "calibration"}, "Metabolic offer")
        assert_ball_id(offer["ballId"]); assert_quantity(offer["maxQuantity"])
        kind = offer["kind"]
        _check(kind in KINDS and kind not in seen_kinds and offer["ballId"] not in seen_balls and offer["minQuantity"] == 1, "Duplicate or invalid metabolic offer")
        seen_kinds.add(kind); seen_balls.add(offer["ballId"])
        calibration = _exact(offer["calibration"], {"digest", "scope", "pairedSeeds", "doses", "monotonic", "identicalEvidenceJudgment", "recallDifference", "reproducibilityDifference", "nonInferiorityMargin", "maximumObservedUnitResources"}, "Metabolic calibration summary")
        binding = next((c for c in allowance["calibrations"] if c["kind"] == kind), None)
        _check(binding is not None and _hash(calibration) == binding["summaryDigest"], "Offered calibration summary differs from sealed digest")
        _check(binding is not None and calibration["digest"] == binding["digest"] and offer["maxQuantity"] <= min(allowance["maximumQuantityPerBall"], binding["maximumDose"] - quantities[kind]) and calibration["monotonic"] is True and calibration["identicalEvidenceJudgment"] is True and _integer(calibration["pairedSeeds"], 1), "Offer has no exact measured calibration")
        _check(isinstance(calibration["scope"], str) and 8 <= _utf16_length(calibration["scope"]) <= 2048 and isinstance(calibration["doses"], list) and len(calibration["doses"]) <= 65 and all(_integer(d, 0, 64) for d in calibration["doses"]), "Invalid calibration sample")
        for field in ("recallDifference", "reproducibilityDifference"):
            interval = _exact(calibration[field], {"lower", "upper", "confidence"}, "Calibration interval")
            _check(type(interval["lower"]) in (int, float) and type(interval["upper"]) in (int, float) and -1 <= interval["lower"] <= interval["upper"] <= 1 and interval["confidence"] == 0.95, "Invalid calibration interval")
        _check(type(calibration["nonInferiorityMargin"]) in (int, float) and 0 <= calibration["nonInferiorityMargin"] <= 0.1 and isinstance(offer["promisedEffect"], str) and 0 < len(offer["promisedEffect"]) <= 1024, "Invalid finite effect promise")
        costs = _vector(offer["unitCostCeiling"]); work = _vector(offer["unitWork"], WORK)
        observed_costs = _vector(calibration["maximumObservedUnitResources"])
        _check(all(observed_costs[k] <= costs[k] for k in RESOURCES), "Offer understates measured unit resources")
        _check(all(costs[k] == allowance["unitCostCeilings"][kind][k] and costs[k] * offer["maxQuantity"] + grant[k] <= allowance["maximumAddedResources"][k] for k in RESOURCES), "Offer exceeds additive allowance")
        _check(all(work[k] == (1 if k == WORK[KINDS.index(kind)] else 0) for k in WORK), "Offer changes work kind")
    return result
