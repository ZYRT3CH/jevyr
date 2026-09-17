"""Fixed local production/advisory verification; no SLSA level is claimed.

This does not extend the three-purpose trust bundle to arbitrary in-toto payloads.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Mapping
from cryptography.exceptions import InvalidSignature
from .client import (
    JevyrContinuityError, _DIGEST, _assert_record, _assert_seal_receipt,
    _assert_trust_bundle, _base64, _canonical, _digest, _dsse_pae,
    _exact_keys, _public_key, assert_terminal_receipt,
    verify_record_envelope, verify_seal_envelope, verify_terminal_envelope,
)

RUN_ATTESTATIONS_PROTOCOL = "jevyr.run-attestations/1"
IN_TOTO_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json"
SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
ADVISORY_VERDICT_PREDICATE_TYPE = "urn:jevyr:advisory-verdict:v1"


@dataclass(frozen=True)
class VerifiedRunAttestations:
    payload: dict[str, Any]
    statements: dict[str, Any]
    key_id: str
    canonical_record: str
    verification: str = "dsse-ed25519+exact-derived-run-statements"
    slsa_level_claim: str = "none"


def canonical_record_text(record: Mapping[str, Any]) -> str:
    """Save exactly as UTF-8 canonical-record.json, without a trailing newline."""
    return _canonical(_assert_record(record)).decode("utf-8")


def assert_run_attestations(raw: Any) -> dict[str, Any]:
    def exact(value: Any, keys: set[str]) -> None:
        if not isinstance(value, dict):
            raise JevyrContinuityError("Run attestation is not an object")
        _exact_keys(value, keys, "Run attestation")
    exact(raw, {"protocol", "caseId", "runDigest", "production", "advisory"})
    run = raw["runDigest"]
    if raw["protocol"] != RUN_ATTESTATIONS_PROTOCOL or not isinstance(run, str) or not _DIGEST.fullmatch(run) or raw["caseId"] != "case_" + run[7:23]:
        raise JevyrContinuityError("Run attestation identity is invalid")
    for name in ("production", "advisory"):
        envelope = raw[name]
        exact(envelope, {"payloadType", "payload", "signatures"})
        payload = envelope["payload"]
        if envelope["payloadType"] != IN_TOTO_DSSE_PAYLOAD_TYPE or not isinstance(payload, str) or len(payload) > 262_144:
            raise JevyrContinuityError("Run attestation is not the bounded in-toto contract")
        _base64(payload, "Run attestation payload")
        signatures = envelope["signatures"]
        if not isinstance(signatures, list) or len(signatures) != 1:
            raise JevyrContinuityError("Run attestation requires exactly one signature")
        signature = signatures[0]
        exact(signature, {"keyid", "sig"})
        if not isinstance(signature["keyid"], str) or not _DIGEST.fullmatch(signature["keyid"]) or len(_base64(signature["sig"], "Run attestation signature")) != 64:
            raise JevyrContinuityError("Run attestation requires an Ed25519 signature")
    return raw


def derive_run_statements(seal: Mapping[str, Any], record: Mapping[str, Any], terminal: Mapping[str, Any], key_id: str) -> dict[str, Any]:
    """Derive only the two fixed statements; caller-supplied predicates are forbidden."""
    _assert_seal_receipt(seal); _assert_record(record); assert_terminal_receipt(terminal)
    if not isinstance(key_id, str) or not _DIGEST.fullmatch(key_id):
        raise JevyrContinuityError("Run statement signer identity is invalid")
    for field in ("caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest"):
        if seal[field] != record[field]:
            raise JevyrContinuityError("Run statement Record differs from Seal " + field)
    if (any(terminal[field] != seal[field] for field in ("caseId", "caseDigest", "runDigest"))
            or terminal["recordDigest"] != _digest(record) or terminal["closedAt"] < seal["sealedAt"]):
        raise JevyrContinuityError("Run statement terminal identity or canonical Record digest mismatch")
    subject = [{"name": "canonical-record.json", "digest": {"sha256": terminal["recordDigest"][7:]}}]
    dependencies = [("policy", seal["policyDigest"]), ("genome", seal["genomeDigest"]), ("search", seal["searchDigest"]),
        ("subject-material-capture", seal["subjectMaterialCaptureDigest"]), ("intent-contract", seal["intentContractDigest"]),
        ("evidence", record["verdict"]["evidenceDigest"]), ("artifact-index", terminal["artifactIndexDigest"]),
        ("terminal-receipt", _digest(terminal))]
    if terminal["eventHeadDigest"]:
        dependencies.append(("event-head", terminal["eventHeadDigest"]))
    def statement(predicate_type: str, predicate: dict[str, Any]) -> dict[str, Any]:
        return {"_type": "https://in-toto.io/Statement/v1", "subject": copy.deepcopy(subject), "predicateType": predicate_type, "predicate": predicate}
    production = statement(SLSA_PROVENANCE_PREDICATE_TYPE, {
        "buildDefinition": {"buildType": "urn:jevyr:local-case-lifecycle:v1",
            "externalParameters": {field: seal[field] for field in ("caseDigest", "intentContractDigest")},
            "internalParameters": {field: seal[field] for field in ("policyDigest", "genomeDigest", "searchDigest")},
            "resolvedDependencies": [{"uri": f"urn:jevyr:{name}:{digest}", "digest": {"sha256": digest[7:]}} for name, digest in dependencies]},
        "runDetails": {"builder": {"id": "urn:jevyr:local-builder:" + key_id},
            "metadata": {"invocationId": seal["runDigest"], "startedOn": seal["sealedAt"], "finishedOn": terminal["closedAt"]}}})
    advisory = statement(ADVISORY_VERDICT_PREDICATE_TYPE, {
        "protocol": "jevyr.advisory-verdict/1", **{field: seal[field] for field in ("caseId", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest")},
        "evidenceDigest": record["verdict"]["evidenceDigest"], "eventHeadDigest": terminal["eventHeadDigest"],
        "artifactIndexDigest": terminal["artifactIndexDigest"], "terminalReceiptDigest": _digest(terminal), "lifecycle": terminal["lifecycle"],
        "axes": {field: record["verdict"][field] for field in ("integrity", "creation", "embodiment", "judgment")},
        "authority": "advisory-only", "enforcement": "none", "slsaLevelClaim": "none"})
    return {"production": production, "advisory": advisory}


def verify_run_attestations(raw: Any, material: Mapping[str, Any]) -> VerifiedRunAttestations:
    """Authenticate fixed statements and their three-payload chain, not evidence replay.

Material keys match the TypeScript offline verifier: seal, record, terminal,
sealEnvelope, recordEnvelope, terminalEnvelope and trust.
"""
    value = copy.deepcopy(raw)
    assert_run_attestations(value)
    if not isinstance(material, Mapping) or not all(key in material for key in ("seal", "record", "terminal", "sealEnvelope", "recordEnvelope", "terminalEnvelope", "trust")):
        raise JevyrContinuityError("Run attestation authentication material is incomplete")
    seal = verify_seal_envelope(material["sealEnvelope"], material["trust"], material["seal"])
    record = verify_record_envelope(material["recordEnvelope"], material["trust"], material["record"])
    terminal = verify_terminal_envelope(material["terminalEnvelope"], material["trust"], material["terminal"])
    if seal.key_id != record.key_id or seal.key_id != terminal.key_id or value["caseId"] != seal.payload["caseId"] or value["runDigest"] != seal.payload["runDigest"]:
        raise JevyrContinuityError("Run attestation changed the authenticated Case or signer")
    statements = derive_run_statements(seal.payload, record.payload, terminal.payload, seal.key_id)
    trust = _assert_trust_bundle(material["trust"])
    key, _ = _public_key(next(entry for entry in trust["keys"] if entry["keyId"] == seal.key_id))
    for name in ("production", "advisory"):
        envelope = value[name]
        payload = _base64(envelope["payload"], "Run attestation payload")
        signature = envelope["signatures"][0]
        if signature["keyid"] != seal.key_id or payload != _canonical(statements[name]):
            raise JevyrContinuityError("Run " + name + " attestation differs from the exact derived payload or signer")
        try:
            key.verify(_base64(signature["sig"], "Run attestation signature"), _dsse_pae(IN_TOTO_DSSE_PAYLOAD_TYPE, payload))
        except InvalidSignature as error:
            raise JevyrContinuityError("Run " + name + " attestation signature did not verify") from error
    return VerifiedRunAttestations(value, statements, seal.key_id, canonical_record_text(record.payload))
