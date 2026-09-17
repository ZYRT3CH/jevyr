from __future__ import annotations

import base64
import hashlib
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jevyr.client import (
    AuthenticatedRecord,
    AuthenticatedTerminalReceipt,
    AuthenticatedTerminalRecord,
    ArtifactMeta,
    CasePolicyDescriptor,
    JevyrClient,
    JevyrContinuityError,
    JevyrHttpError,
    _assert_event,
    _assert_record,
    _canonical,
    _decode_sse,
    _digest,
    _dsse_pae,
    _event_digest,
    RECORD_DSSE_PAYLOAD_TYPE,
    SEAL_DSSE_PAYLOAD_TYPE,
    TERMINAL_DSSE_PAYLOAD_TYPE,
    _assert_seal_receipt,
    assert_artifact_list,
    assert_artifact_meta,
    assert_case_policy_descriptor,
    assert_descriptor_artifact,
    assert_intent_contract_payload,
    assert_policy_descriptor_record_binding,
    assert_terminal_receipt,
    verify_record_envelope,
    verify_seal_envelope,
    verify_terminal_envelope,
)


CASE_DIGEST = "sha256:" + ("a" * 64)
RUN_DIGEST = "sha256:" + ("3" * 64)


class Response(io.BytesIO):
    def __init__(self, initial_bytes: bytes = b"", headers: dict[str, str] | None = None):
        super().__init__(initial_bytes)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class BrokenResponse(Response):
    def read(self, *_args, **_kwargs):
        raise OSError("stream severed")


class ChunkedResponse:
    def __init__(self, chunks: list[bytes], headers: dict[str, str] | None = None):
        self._chunks = iter(chunks)
        self.headers = headers or {}
        self.closed = False

    def read1(self, _size: int = -1) -> bytes:
        return next(self._chunks, b"")

    def close(self) -> None:
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


ARTIFACT_CASE_ID = "case_0123456789abcdef"


def artifact_fixture(text: str = "immutable evidence\n") -> tuple[ArtifactMeta, bytes, dict[str, object]]:
    data = text.encode("utf-8")
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    meta: ArtifactMeta = {
        "protocol": "jevyr.artifact/1",
        "id": f"artifact_{digest[len('sha256:'):len('sha256:') + 24]}",
        "caseId": ARTIFACT_CASE_ID,
        "name": "observation.json",
        "mediaType": "application/vnd.jevyr.tool-observation+json",
        "size": len(data),
        "digest": digest,
        "createdAt": "2026-09-04T12:34:56.000Z",
    }
    return meta, data, {
        "protocol": "jevyr.artifacts/1",
        "caseId": ARTIFACT_CASE_ID,
        "artifacts": [meta],
    }


def artifact_response(
    meta: ArtifactMeta,
    data: bytes,
    overrides: dict[str, str | None] | None = None,
) -> Response:
    headers = {
        "content-length": str(meta["size"]),
        "content-type": meta["mediaType"],
        "x-jevyr-digest": meta["digest"],
    }
    for name, value in (overrides or {}).items():
        if value is None:
            headers.pop(name, None)
        else:
            headers[name] = value
    return Response(data, headers)


def event(
    sequence: int = 1,
    prior_digest: str | None = None,
    *,
    terminal: bool = False,
) -> dict[str, object]:
    stage = "terminate" if terminal else "cast"
    value: dict[str, object] = {
        "protocol": "jevyr.event/1",
        "caseDigest": CASE_DIGEST,
        "runDigest": RUN_DIGEST,
        "sequence": sequence,
        "priorDigest": prior_digest,
        "observedAt": f"2026-09-04T00:00:{sequence - 1:02d}.000Z",
        "stage": stage,
        "kind": "stage.status",
        "actor": {"id": "bone", "kind": "kernel"},
        "payload": {
            "stage": stage,
            "status": "completed",
            "summary": "Case terminated." if terminal else "Cast received.",
        },
    }
    value["eventDigest"] = _event_digest(value)
    return value


def search_resources() -> list[dict[str, object]]:
    names = (
        "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
        "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
        "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
    )
    return [
        {"name": name, "used": None, "ceiling": 100, "measurement": "DECLARED_ONLY"}
        for name in names
    ]


def status(
    head: str | None,
    last_sequence: int | None = None,
    lifecycle: str = "terminated",
) -> dict[str, object]:
    if last_sequence is None:
        last_sequence = 0 if head is None else 1
    terminal = lifecycle in {"terminated", "invalid"}
    return {
        "protocol": "jevyr.status/1",
        "caseDigest": CASE_DIGEST,
        "runDigest": RUN_DIGEST,
        "lifecycle": lifecycle,
        "stage": "terminate" if terminal else "self_scan",
        "stageStatus": "completed" if terminal else "working",
        "lastSequence": last_sequence,
        "headDigest": head,
        "updatedAt": "2026-09-04T00:00:01.000Z",
    }


def event_page(
    events: list[dict[str, object]],
    *,
    after: int = 0,
    caught_up: bool = True,
    head: str | None = None,
) -> dict[str, object]:
    return {
        "protocol": "jevyr.live/1",
        "caseDigest": CASE_DIGEST,
        "runDigest": RUN_DIGEST,
        "afterSequence": after,
        "throughSequence": events[-1]["sequence"] if events else after,
        "headDigest": head if head is not None else (
            events[-1]["eventDigest"] if events else None
        ),
        "caughtUp": caught_up,
        "events": events,
        "polledAt": "2026-09-04T00:00:01.000Z",
    }


def empty_artifact_index(
    case_id: str = "case_3333333333333333",
) -> dict[str, object]:
    return {
        "protocol": "jevyr.artifacts/1",
        "caseId": case_id,
        "artifacts": [],
    }


def terminal_receipt(
    record: dict[str, object],
    head: str | None,
    last_sequence: int,
    *,
    lifecycle: str = "terminated",
    stage: str | None = None,
    stage_status: str | None = None,
) -> dict[str, object]:
    return {
        "protocol": "jevyr.terminal/1",
        "caseId": "case_3333333333333333",
        "caseDigest": record["caseDigest"],
        "runDigest": record["runDigest"],
        "lifecycle": lifecycle,
        "stage": stage or ("terminate" if lifecycle == "terminated" else "assay"),
        "stageStatus": stage_status or (
            "completed" if lifecycle == "terminated" else "failed"
        ),
        "lastSequence": last_sequence,
        "eventHeadDigest": head,
        "recordDigest": _digest(record),
        "artifactIndexDigest": _digest(empty_artifact_index()),
        "closedAt": "2026-09-04T00:00:01.000Z",
    }


def http_error(status_code: int) -> HTTPError:
    return HTTPError(
        "http://test",
        status_code,
        "failed",
        {},
        io.BytesIO(json.dumps({"error": "failed"}).encode()),
    )


def intent_contract() -> dict[str, object]:
    impulse = "Judge the sealed repository against its declared test."
    unsigned: dict[str, object] = {
        "protocol": "jevyr.intent-contract/1",
        "compilerVersion": "jevyr.intent-compiler/1",
        "originalImpulse": impulse,
        "originalImpulseDigest": "sha256:" + hashlib.sha256(impulse.encode()).hexdigest(),
        "goal": {"statement": impulse, "source": "whole_impulse"},
        "subjectIds": ["repository"],
        "explicitConstraints": [],
        "requestedAssays": ["pnpm test"],
        "successConditions": [{
            "id": "condition:success",
            "kind": "success",
            "statement": "Every critical obligation is supported by admissible evidence.",
            "source": "kernel",
            "obligationIds": ["obligation:assay"],
        }],
        "failureConditions": [{
            "id": "condition:failure",
            "kind": "failure",
            "statement": "A critical obligation is refuted or remains unsupported.",
            "source": "kernel",
            "obligationIds": ["obligation:assay"],
        }],
        "ambiguities": [],
        "alternativeInterpretations": [],
        "criticalObligations": [{
            "id": "obligation:assay",
            "statement": "pnpm test",
            "origin": "requested_assay",
            "critical": True,
            "assayability": "ASSAYABLE",
            "oracle": {
                "kind": "requested_assay",
                "operand": "pnpm test",
                "operator": "passes",
                "expected": "pass",
            },
        }],
    }
    return {**unsigned, "digest": _digest(unsigned)}


def signed_fixture(
    payload_type: str,
    payload: dict[str, object],
    private: Ed25519PrivateKey | None = None,
) -> tuple[dict[str, object], dict[str, object]]:
    private = private or Ed25519PrivateKey.generate()
    public = private.public_key()
    spki = public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    pem = public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
    key_id = "sha256:" + hashlib.sha256(spki).hexdigest()
    body = _canonical(payload)
    envelope: dict[str, object] = {
        "payloadType": payload_type,
        "payload": base64.b64encode(body).decode("ascii"),
        "signatures": [{
            "keyid": key_id,
            "sig": base64.b64encode(private.sign(_dsse_pae(payload_type, body))).decode("ascii"),
        }],
    }
    trust: dict[str, object] = {
        "protocol": "jevyr.trust-bundle/1",
        "keys": [{
            "keyId": key_id,
            "algorithm": "Ed25519",
            "publicKeyPem": pem,
            "payloadTypes": [
                SEAL_DSSE_PAYLOAD_TYPE,
                RECORD_DSSE_PAYLOAD_TYPE,
                TERMINAL_DSSE_PAYLOAD_TYPE,
            ],
        }],
    }
    return envelope, trust


class ClientTest(unittest.TestCase):
    def test_intent_contract_validates_exact_shape_and_both_digests(self) -> None:
        contract = intent_contract()
        self.assertEqual(assert_intent_contract_payload(contract), contract)
        with self.assertRaisesRegex(JevyrContinuityError, "originalImpulseDigest does not bind"):
            assert_intent_contract_payload({**contract, "originalImpulse": "tampered"})
        with self.assertRaisesRegex(JevyrContinuityError, "digest does not bind"):
            assert_intent_contract_payload({**contract, "requestedAssays": ["different assay"]})
        with self.assertRaisesRegex(JevyrContinuityError, "unsupported compiler version"):
            assert_intent_contract_payload({**contract, "compilerVersion": "jevyr.intent-compiler/999"})
        with self.assertRaisesRegex(JevyrContinuityError, "fields do not match"):
            assert_intent_contract_payload({**contract, "goal": {**contract["goal"], "vote": "human"}})  # type: ignore[dict-item]
        malformed = {
            **contract,
            "successConditions": [{
                **contract["successConditions"][0],  # type: ignore[index]
                "obligationIds": ["obligation:missing"],
            }],
        }
        malformed["digest"] = _digest({key: value for key, value in malformed.items() if key != "digest"})
        with self.assertRaisesRegex(JevyrContinuityError, "unknown obligation"):
            assert_intent_contract_payload(malformed)

    def test_verified_intent_contract_binds_to_signed_seal_receipt(self) -> None:
        contract = intent_contract()
        receipt: dict[str, object] = {
            "protocol": "jevyr.seal/1",
            "caseId": "case_3333333333333333",
            "submissionDigest": "sha256:" + ("1" * 64),
            "subjectMaterialCaptureDigest": "sha256:" + ("0" * 64),
            "caseDigest": "sha256:" + ("2" * 64),
            "runDigest": "sha256:" + ("3" * 64),
            "sealedAt": "2026-09-04T00:00:00.000Z",
            "policyVersion": "bone-v1",
            "policyDigest": "sha256:" + ("4" * 64),
            "genomeVersion": "genome-v1",
            "genomeDigest": "sha256:" + ("5" * 64),
            "searchDigest": "sha256:" + ("6" * 64),
            "intentContractDigest": contract["digest"],
        }
        envelope, trust = signed_fixture(SEAL_DSSE_PAYLOAD_TYPE, receipt)
        responses = [trust, receipt, envelope, contract]
        with patch(
            "jevyr.client.urlopen",
            side_effect=[Response(json.dumps(item).encode()) for item in responses],
        ) as opened:
            result = JevyrClient().verified_intent_contract("case_3333333333333333")
        self.assertEqual(result, contract)
        self.assertEqual(opened.call_count, 4)
        contract_request = opened.call_args_list[3].args[0]
        self.assertTrue(contract_request.full_url.endswith("/v1/cases/case_3333333333333333/intent-contract"))

        mismatched_receipt = {**receipt, "intentContractDigest": "sha256:" + ("f" * 64)}
        mismatched_envelope, mismatched_trust = signed_fixture(SEAL_DSSE_PAYLOAD_TYPE, mismatched_receipt)
        with patch(
            "jevyr.client.urlopen",
            side_effect=[Response(json.dumps(item).encode()) for item in (
                mismatched_trust, mismatched_receipt, mismatched_envelope, contract,
            )],
        ):
            with self.assertRaisesRegex(JevyrContinuityError, "does not match its authenticated SealReceipt"):
                JevyrClient().verified_intent_contract("case_3333333333333333")

    def test_dsse_verification_authenticates_canonical_payload(self) -> None:
        receipt: dict[str, object] = {
            "protocol": "jevyr.seal/1",
            "caseId": "case_3333333333333333",
            "submissionDigest": "sha256:" + ("1" * 64),
            "subjectMaterialCaptureDigest": "sha256:" + ("0" * 64),
            "caseDigest": "sha256:" + ("2" * 64),
            "runDigest": "sha256:" + ("3" * 64),
            "sealedAt": "2026-09-04T00:00:00.000Z",
            "policyVersion": "bone-v1",
            "policyDigest": "sha256:" + ("4" * 64),
            "genomeVersion": "genome-v1",
            "genomeDigest": "sha256:" + ("5" * 64),
            "searchDigest": "sha256:" + ("6" * 64),
            "intentContractDigest": "sha256:" + ("a" * 64),
        }
        envelope, trust = signed_fixture(SEAL_DSSE_PAYLOAD_TYPE, receipt)
        verified = verify_seal_envelope(envelope, trust, receipt)
        self.assertEqual(verified.verification, "dsse-ed25519")
        self.assertEqual(verified.payload, receipt)

        ambiguous = _canonical(receipt).replace(
            b'"protocol":"jevyr.seal/1"',
            b'"protocol":"jevyr.seal/1","\\u0070rotocol":"jevyr.seal/1"',
        )
        private = Ed25519PrivateKey.generate()
        public = private.public_key()
        spki = public.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        pem = public.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        key_id = "sha256:" + hashlib.sha256(spki).hexdigest()
        ambiguous_envelope = {
            "payloadType": SEAL_DSSE_PAYLOAD_TYPE,
            "payload": base64.b64encode(ambiguous).decode("ascii"),
            "signatures": [{
                "keyid": key_id,
                "sig": base64.b64encode(
                    private.sign(_dsse_pae(SEAL_DSSE_PAYLOAD_TYPE, ambiguous))
                ).decode("ascii"),
            }],
        }
        ambiguous_trust = {
            "protocol": "jevyr.trust-bundle/1",
            "keys": [{
                "keyId": key_id,
                "algorithm": "Ed25519",
                "publicKeyPem": pem,
                "payloadTypes": [
                    SEAL_DSSE_PAYLOAD_TYPE,
                    RECORD_DSSE_PAYLOAD_TYPE,
                    TERMINAL_DSSE_PAYLOAD_TYPE,
                ],
            }],
        }
        with self.assertRaisesRegex(JevyrContinuityError, "duplicate object key"):
            verify_seal_envelope(ambiguous_envelope, ambiguous_trust, receipt)

        without_capture = {key: value for key, value in receipt.items() if key != "subjectMaterialCaptureDigest"}
        with self.assertRaises(JevyrContinuityError):
            _assert_seal_receipt(without_capture)
        with self.assertRaises(JevyrContinuityError):
            _assert_seal_receipt({**receipt, "subjectMaterialCaptureDigest": "sha256:not-a-digest"})
        with self.assertRaises(JevyrContinuityError):
            _assert_seal_receipt({**receipt, "mutableSubjectLocator": "/tmp/live"})
        with self.assertRaisesRegex(JevyrContinuityError, "derived from runDigest"):
            _assert_seal_receipt({**receipt, "caseId": "case_4444444444444444"})
        with self.assertRaisesRegex(JevyrContinuityError, "canonical UTC timestamp"):
            _assert_seal_receipt({**receipt, "sealedAt": "2026-09-04T00:00:00Z"})
        with self.assertRaises(JevyrContinuityError):
            _assert_seal_receipt({**receipt, "policyVersion": ""})

    def test_dsse_verification_rejects_tampering_and_wrong_endpoint_payload(self) -> None:
        record: dict[str, object] = {
            "protocol": "jevyr.record/1",
            "caseDigest": "sha256:" + ("1" * 64),
            "runDigest": "sha256:" + ("2" * 64),
            "policyDigest": "sha256:" + ("3" * 64),
            "genomeDigest": "sha256:" + ("4" * 64),
            "searchDigest": "sha256:" + ("5" * 64),
            "intentContractDigest": "sha256:" + ("a" * 64),
            "eventHeadDigest": "sha256:" + ("6" * 64),
            "verdict": {
                "policyVersion": "bone-v1",
                "intentContractDigest": "sha256:" + ("a" * 64),
                "evidenceDigest": "sha256:" + ("7" * 64),
                "integrity": "VALID",
                "creation": "NO_SURVIVOR",
                "embodiment": "NOT_BUILT",
                "judgment": "NOT_APPLICABLE",
                "feasibilityByCandidate": {},
                "basis": [],
            },
            "reflex": {
                "loop": 1,
                "reviewedEvidenceDigest": "sha256:" + ("7" * 64),
                "intentContractDigest": "sha256:" + ("a" * 64),
                "challengedNodeIds": [],
                "materialFindings": [],
                "decision": "confirm",
            },
            "memoryInfluences": [],
            "crystallizedAt": "2026-09-04T00:00:01.000Z",
        }
        envelope, trust = signed_fixture(RECORD_DSSE_PAYLOAD_TYPE, record)
        signature = bytearray(base64.b64decode(envelope["signatures"][0]["sig"]))  # type: ignore[index]
        signature[0] ^= 1
        envelope["signatures"][0]["sig"] = base64.b64encode(signature).decode("ascii")  # type: ignore[index]
        with self.assertRaises(JevyrContinuityError):
            verify_record_envelope(envelope, trust, record)
        envelope, trust = signed_fixture(RECORD_DSSE_PAYLOAD_TYPE, record)
        with self.assertRaises(JevyrContinuityError):
            verify_record_envelope(envelope, trust, {**record, "searchDigest": "sha256:" + ("9" * 64)})

        malformed_records = (
            {**record, "verdict": {**record["verdict"], "callerApproval": True}},  # type: ignore[dict-item]
            {**record, "reflex": {**record["reflex"], "decision": "skip"}},  # type: ignore[dict-item]
            {**record, "memoryInfluences": [{
                "memoryDigest": "sha256:" + ("8" * 64),
                "influence": "vote",
                "summary": "No authority.",
                "weight": 0.1,
            }]},
            {**record, "crystallizedAt": "2026-09-04T00:00:01Z"},
        )
        for malformed in malformed_records:
            with self.subTest(malformed=malformed), self.assertRaises(JevyrContinuityError):
                _assert_record(malformed)

    def test_terminal_receipt_is_a_closed_exact_terminal_contract(self) -> None:
        record = {"caseDigest": CASE_DIGEST, "runDigest": RUN_DIGEST}
        head = "sha256:" + ("b" * 64)
        receipt = terminal_receipt(record, head, 2)
        self.assertEqual(assert_terminal_receipt(receipt), receipt)
        invalid = terminal_receipt(
            record,
            head,
            2,
            lifecycle="invalid",
            stage="assay",
            stage_status="failed",
        )
        self.assertEqual(assert_terminal_receipt(invalid), invalid)

        mutations = {
            "unknown field": {**receipt, "callerApproval": True},
            "wrong protocol": {**receipt, "protocol": "jevyr.terminal/2"},
            "wrong case id": {**receipt, "caseId": "case_4444444444444444"},
            "bad case digest": {**receipt, "caseDigest": "sha256:not-a-digest"},
            "bad run digest": {**receipt, "runDigest": "sha256:not-a-digest"},
            "bad record digest": {**receipt, "recordDigest": "sha256:not-a-digest"},
            "nonterminal lifecycle": {**receipt, "lifecycle": "running"},
            "unknown stage": {**receipt, "stage": "approve"},
            "unknown status": {**receipt, "stageStatus": "approved"},
            "boolean sequence": {**receipt, "lastSequence": True},
            "negative sequence": {**receipt, "lastSequence": -1},
            "unsafe sequence": {**receipt, "lastSequence": 9_007_199_254_740_992},
            "empty ledger with head": {**receipt, "lastSequence": 0},
            "nonempty ledger without head": {**receipt, "eventHeadDigest": None},
            "terminated at wrong stage": {**receipt, "stage": "assay"},
            "terminated with wrong status": {**receipt, "stageStatus": "failed"},
            "invalid with completed status": {**invalid, "stageStatus": "completed"},
            "noncanonical time": {**receipt, "closedAt": "2026-09-04T00:00:01Z"},
            "impossible time": {**receipt, "closedAt": "2026-02-30T00:00:01.000Z"},
        }
        for label, malformed in mutations.items():
            with self.subTest(label=label), self.assertRaises(JevyrContinuityError):
                assert_terminal_receipt(malformed)

        empty = terminal_receipt(record, None, 0)
        self.assertEqual(assert_terminal_receipt(empty), empty)

    def test_terminal_dsse_and_client_authenticate_exact_endpoint_bytes(self) -> None:
        record = {"caseDigest": CASE_DIGEST, "runDigest": RUN_DIGEST}
        receipt = terminal_receipt(record, "sha256:" + ("b" * 64), 2)
        envelope, trust = signed_fixture(TERMINAL_DSSE_PAYLOAD_TYPE, receipt)
        verified = verify_terminal_envelope(envelope, trust, receipt)
        self.assertEqual(verified.payload, receipt)
        self.assertEqual(verified.payload_type, TERMINAL_DSSE_PAYLOAD_TYPE)

        legacy_trust = {
            **trust,
            "keys": [{
                **trust["keys"][0],  # type: ignore[index]
                "payloadTypes": [SEAL_DSSE_PAYLOAD_TYPE, RECORD_DSSE_PAYLOAD_TYPE],
            }],
        }
        with self.assertRaisesRegex(JevyrContinuityError, "payloadTypes"):
            verify_terminal_envelope(envelope, legacy_trust, receipt)
        with self.assertRaisesRegex(JevyrContinuityError, "canonical endpoint payload"):
            verify_terminal_envelope(
                envelope,
                trust,
                {**receipt, "recordDigest": "sha256:" + ("c" * 64)},
            )

        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(json.dumps(trust).encode()),
                Response(json.dumps(receipt).encode()),
                Response(json.dumps(envelope).encode()),
            ],
        ) as opened:
            result = JevyrClient(base_url="http://test").authenticated_terminal_receipt(
                "case_3333333333333333"
            )
        self.assertIsInstance(result, AuthenticatedTerminalReceipt)
        self.assertEqual(result.payload, receipt)
        self.assertEqual(result.key_id, verified.key_id)
        self.assertTrue(
            opened.call_args_list[1].args[0].full_url.endswith(
                "/v1/cases/case_3333333333333333/terminal"
            )
        )
        self.assertTrue(
            opened.call_args_list[2].args[0].full_url.endswith(
                "/v1/cases/case_3333333333333333/terminal/envelope"
            )
        )
        other_case = {
            **receipt,
            "caseId": "case_4444444444444444",
            "runDigest": "sha256:" + ("4" * 64),
        }
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(other_case).encode()),
        ):
            with self.assertRaisesRegex(
                JevyrContinuityError, "does not match the requested case"
            ):
                JevyrClient(base_url="http://test").terminal_receipt(
                    "case_3333333333333333"
                )

    def test_authenticated_record_requires_one_key_across_seal_and_record(self) -> None:
        receipt: dict[str, object] = {
            "protocol": "jevyr.seal/1",
            "caseId": "case_3333333333333333",
            "submissionDigest": "sha256:" + ("1" * 64),
            "subjectMaterialCaptureDigest": "sha256:" + ("0" * 64),
            "caseDigest": "sha256:" + ("2" * 64),
            "runDigest": RUN_DIGEST,
            "sealedAt": "2026-09-04T00:00:00.000Z",
            "policyVersion": "bone-v1",
            "policyDigest": "sha256:" + ("4" * 64),
            "genomeVersion": "genome-v1",
            "genomeDigest": "sha256:" + ("5" * 64),
            "searchDigest": "sha256:" + ("6" * 64),
            "intentContractDigest": "sha256:" + ("a" * 64),
        }
        record: dict[str, object] = {
            "protocol": "jevyr.record/1",
            "caseDigest": receipt["caseDigest"],
            "runDigest": receipt["runDigest"],
            "policyDigest": receipt["policyDigest"],
            "genomeDigest": receipt["genomeDigest"],
            "searchDigest": receipt["searchDigest"],
            "intentContractDigest": receipt["intentContractDigest"],
            "eventHeadDigest": "sha256:" + ("7" * 64),
            "verdict": {
                "policyVersion": "bone-v1",
                "intentContractDigest": receipt["intentContractDigest"],
                "evidenceDigest": "sha256:" + ("8" * 64),
                "integrity": "VALID",
                "creation": "NO_SURVIVOR",
                "embodiment": "NOT_BUILT",
                "judgment": "NOT_APPLICABLE",
                "feasibilityByCandidate": {},
                "basis": [],
            },
            "reflex": {
                "loop": 1,
                "reviewedEvidenceDigest": "sha256:" + ("8" * 64),
                "intentContractDigest": receipt["intentContractDigest"],
                "challengedNodeIds": [],
                "materialFindings": [],
                "decision": "confirm",
            },
            "memoryInfluences": [],
            "crystallizedAt": "2026-09-04T00:00:01.000Z",
        }
        seal_envelope, seal_trust = signed_fixture(SEAL_DSSE_PAYLOAD_TYPE, receipt)
        record_envelope, record_trust = signed_fixture(RECORD_DSSE_PAYLOAD_TYPE, record)
        trust = {
            "protocol": "jevyr.trust-bundle/1",
            "keys": [*seal_trust["keys"], *record_trust["keys"]],  # type: ignore[misc]
        }
        with patch(
            "jevyr.client.urlopen",
            side_effect=[Response(json.dumps(item).encode()) for item in (
                trust,
                receipt,
                seal_envelope,
                record,
                record_envelope,
            )],
        ):
            with self.assertRaisesRegex(JevyrContinuityError, "same trusted key"):
                JevyrClient().authenticated_record("case_3333333333333333")

    def test_authenticated_record_disclaims_persisted_evidence_replay(self) -> None:
        receipt: dict[str, object] = {
            "protocol": "jevyr.seal/1",
            "caseId": "case_3333333333333333",
            "submissionDigest": "sha256:" + ("1" * 64),
            "subjectMaterialCaptureDigest": "sha256:" + ("0" * 64),
            "caseDigest": "sha256:" + ("2" * 64),
            "runDigest": "sha256:" + ("3" * 64),
            "sealedAt": "2026-09-04T00:00:00.000Z",
            "policyVersion": "bone-v1",
            "policyDigest": "sha256:" + ("4" * 64),
            "genomeVersion": "genome-v1",
            "genomeDigest": "sha256:" + ("5" * 64),
            "searchDigest": "sha256:" + ("6" * 64),
            "intentContractDigest": "sha256:" + ("a" * 64),
        }
        record: dict[str, object] = {
            "protocol": "jevyr.record/1",
            "caseDigest": receipt["caseDigest"],
            "runDigest": receipt["runDigest"],
            "policyDigest": receipt["policyDigest"],
            "genomeDigest": receipt["genomeDigest"],
            "searchDigest": receipt["searchDigest"],
            "intentContractDigest": receipt["intentContractDigest"],
            "eventHeadDigest": "sha256:" + ("7" * 64),
            "verdict": {
                "policyVersion": "bone-v1",
                "intentContractDigest": receipt["intentContractDigest"],
                "evidenceDigest": "sha256:" + ("8" * 64),
                "integrity": "VALID",
                "creation": "NO_SURVIVOR",
                "embodiment": "NOT_BUILT",
                "judgment": "NOT_APPLICABLE",
                "feasibilityByCandidate": {},
                "basis": [],
            },
            "reflex": {
                "loop": 1,
                "reviewedEvidenceDigest": "sha256:" + ("8" * 64),
                "intentContractDigest": receipt["intentContractDigest"],
                "challengedNodeIds": [],
                "materialFindings": [],
                "decision": "confirm",
            },
            "memoryInfluences": [],
            "crystallizedAt": "2026-09-04T00:00:01.000Z",
        }
        signing_key = Ed25519PrivateKey.generate()
        seal_envelope, trust = signed_fixture(
            SEAL_DSSE_PAYLOAD_TYPE, receipt, signing_key
        )
        record_envelope, _ = signed_fixture(
            RECORD_DSSE_PAYLOAD_TYPE, record, signing_key
        )
        with patch(
            "jevyr.client.urlopen",
            side_effect=[Response(json.dumps(item).encode()) for item in (
                trust, receipt, seal_envelope, record, record_envelope,
            )],
        ):
            authenticated = JevyrClient().authenticated_record("case_3333333333333333")
        self.assertIsInstance(authenticated, AuthenticatedRecord)
        self.assertEqual(authenticated.verification_scope, "dsse-signature+seal-provenance")
        self.assertEqual(authenticated.persisted_evidence, "not-replayed")
        self.assertEqual(authenticated.payload, record)
        client = JevyrClient()
        terminal_status = {
            **status(str(record["eventHeadDigest"])),
            "caseDigest": record["caseDigest"],
            "runDigest": record["runDigest"],
        }
        closure_payload = terminal_receipt(
            record, str(record["eventHeadDigest"]), 1
        )
        closure = AuthenticatedTerminalReceipt(
            payload=closure_payload,  # type: ignore[arg-type]
            envelope={},
            key_id=authenticated.key_id,
            payload_type=TERMINAL_DSSE_PAYLOAD_TYPE,
        )
        with (
            patch.object(client, "live_events", return_value=iter(())),
            patch.object(client, "authenticated_record", return_value=authenticated),
            patch.object(
                client,
                "authenticated_terminal_receipt",
                return_value=closure,
            ),
            patch.object(client, "status", return_value=terminal_status),
            patch.object(client, "artifact_list", return_value=empty_artifact_index()),
            patch.object(
                client,
                "_scan_record_head",
                return_value=(
                    True,
                    1,
                    record["eventHeadDigest"],
                    "2026-09-04T00:00:01.000Z",
                ),
            ),
        ):
            terminal = client.wait_for_authenticated_record(
                "case_3333333333333333",
                reconnect_delay=0,
                max_reconnect_delay=0,
            )
        self.assertIsInstance(terminal, AuthenticatedTerminalRecord)
        self.assertEqual(
            terminal.trace_verification,
            "event-hash-chain+signed-terminal-head",
        )
        self.assertIs(terminal.terminal, closure)
        self.assertEqual(terminal.persisted_evidence, "not-replayed")
        with patch.object(
            JevyrClient,
            "authenticated_record",
            return_value=authenticated,
        ):
            self.assertIs(JevyrClient().verified_record("case_3333333333333333"), authenticated)

    def test_authenticated_terminal_record_binds_the_complete_terminal_ledger(self) -> None:
        first = event()
        second = event(2, str(first["eventDigest"]), terminal=True)
        terminal_status = status(str(second["eventDigest"]), 2)
        record = {
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "eventHeadDigest": first["eventDigest"],
        }
        authenticated = AuthenticatedRecord(
            payload=record,
            envelope={},
            key_id="sha256:" + ("c" * 64),
            payload_type=RECORD_DSSE_PAYLOAD_TYPE,
        )
        closure_payload = terminal_receipt(
            record, str(second["eventDigest"]), 2
        )
        closure = AuthenticatedTerminalReceipt(
            payload=closure_payload,  # type: ignore[arg-type]
            envelope={},
            key_id=authenticated.key_id,
            payload_type=TERMINAL_DSSE_PAYLOAD_TYPE,
        )
        client = JevyrClient()
        with (
            patch.object(client, "live_events", return_value=iter(())),
            patch.object(
                client,
                "status",
                side_effect=[URLError("terminal status retry"), terminal_status, terminal_status],
            ),
            patch.object(
                client,
                "authenticated_record",
                side_effect=[
                    JevyrHttpError(503, "Signer transport unavailable"),
                    JevyrHttpError(409, "Record pending"),
                    JevyrHttpError(404, "Envelope pending"),
                    authenticated,
                ],
            ) as authenticate,
            patch.object(
                client,
                "authenticated_terminal_receipt",
                side_effect=[JevyrHttpError(409, "Closure pending"), closure],
            ) as authenticate_closure,
            patch.object(
                client,
                "poll_events",
                return_value=event_page([first, second]),
            ) as poll,
            patch.object(client, "artifact_list", return_value=empty_artifact_index()),
            patch("jevyr.client.time.sleep") as sleeping,
        ):
            terminal_record = client.wait_for_authenticated_record(
                "case_3333333333333333",
                reconnect_delay=0.25,
                max_reconnect_delay=0.5,
            )
        self.assertIsInstance(terminal_record, AuthenticatedTerminalRecord)
        self.assertEqual(terminal_record.payload, record)
        self.assertEqual(
            terminal_record.trace_verification,
            "event-hash-chain+signed-terminal-head",
        )
        self.assertIs(terminal_record.terminal, closure)
        self.assertEqual(authenticate.call_count, 4)
        self.assertEqual(authenticate_closure.call_count, 2)
        poll.assert_called_once_with("case_3333333333333333", 0, limit=2_000)
        self.assertEqual(
            [call.args[0] for call in sleeping.call_args_list],
            [0.25, 0.25, 0.5, 0.5, 0.25],
        )

    def test_authenticated_terminal_record_rejects_every_cross_binding_mismatch(self) -> None:
        head = "sha256:" + ("d" * 64)
        record = {
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "eventHeadDigest": "sha256:" + ("c" * 64),
        }
        record_key = "sha256:" + ("1" * 64)
        authenticated = AuthenticatedRecord(
            payload=record,
            envelope={},
            key_id=record_key,
            payload_type=RECORD_DSSE_PAYLOAD_TYPE,
        )
        final_status = status(head, 2)
        valid = terminal_receipt(record, head, 2)
        mismatches: dict[str, tuple[dict[str, object], str, str]] = {
            "different signing key": (
                valid,
                "sha256:" + ("2" * 64),
                "same trusted key",
            ),
            "different record": (
                {**valid, "recordDigest": "sha256:" + ("e" * 64)},
                record_key,
                "canonical authenticated Record",
            ),
            "different ledger head": (
                {**valid, "eventHeadDigest": "sha256:" + ("e" * 64)},
                record_key,
                "exact verified terminal ledger head",
            ),
            "different artifact index": (
                {**valid, "artifactIndexDigest": "sha256:" + ("e" * 64)},
                record_key,
                "artifact index",
            ),
            "different case and run": (
                {
                    **valid,
                    "caseId": "case_4444444444444444",
                    "caseDigest": "sha256:" + ("b" * 64),
                    "runDigest": "sha256:" + ("4" * 64),
                },
                record_key,
                "authenticated case and run",
            ),
            "different final status": (
                {
                    **valid,
                    "lifecycle": "invalid",
                    "stage": "assay",
                    "stageStatus": "failed",
                },
                record_key,
                "final status projection",
            ),
        }
        for label, (payload, key_id, message) in mismatches.items():
            closure = AuthenticatedTerminalReceipt(
                payload=payload,  # type: ignore[arg-type]
                envelope={},
                key_id=key_id,
                payload_type=TERMINAL_DSSE_PAYLOAD_TYPE,
            )
            client = JevyrClient()
            with (
                self.subTest(label=label),
                patch.object(client, "live_events", return_value=iter(())),
                patch.object(client, "status", return_value=final_status),
                patch.object(
                    client, "authenticated_record", return_value=authenticated
                ),
                patch.object(
                    client,
                    "_scan_record_head",
                    return_value=(True, 2, head, "2026-09-04T00:00:01.000Z"),
                ),
                patch.object(
                    client,
                    "authenticated_terminal_receipt",
                    return_value=closure,
                ),
                patch.object(client, "artifact_list", return_value=empty_artifact_index()),
            ):
                with self.assertRaisesRegex(JevyrContinuityError, message):
                    client.wait_for_authenticated_record(
                        "case_3333333333333333",
                        reconnect_delay=0,
                        max_reconnect_delay=0,
                    )

    def test_terminal_closed_at_must_equal_the_verified_tail_event_time(self) -> None:
        head = "sha256:" + ("d" * 64)
        record = {
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "eventHeadDigest": "sha256:" + ("c" * 64),
        }
        key_id = "sha256:" + ("1" * 64)
        authenticated = AuthenticatedRecord(
            payload=record,
            envelope={},
            key_id=key_id,
            payload_type=RECORD_DSSE_PAYLOAD_TYPE,
        )
        payload = {
            **terminal_receipt(record, head, 2),
            "closedAt": "2026-09-04T00:00:02.000Z",
        }
        closure = AuthenticatedTerminalReceipt(
            payload=payload,  # type: ignore[arg-type]
            envelope={},
            key_id=key_id,
            payload_type=TERMINAL_DSSE_PAYLOAD_TYPE,
        )
        projected_status = {
            **status(head, 2),
            "updatedAt": payload["closedAt"],
        }
        client = JevyrClient()
        with (
            patch.object(client, "live_events", return_value=iter(())),
            patch.object(client, "status", return_value=projected_status),
            patch.object(client, "authenticated_record", return_value=authenticated),
            patch.object(
                client,
                "_scan_record_head",
                return_value=(True, 2, head, "2026-09-04T00:00:01.000Z"),
            ),
            patch.object(
                client,
                "authenticated_terminal_receipt",
                return_value=closure,
            ),
            patch.object(client, "artifact_list", return_value=empty_artifact_index()),
        ):
            with self.assertRaisesRegex(
                JevyrContinuityError,
                "exact final status projection",
            ):
                client.wait_for_authenticated_record(
                    "case_3333333333333333",
                    reconnect_delay=0,
                    max_reconnect_delay=0,
                )

    def test_record_authentication_does_not_retry_nonreadiness_client_errors(self) -> None:
        first = event()
        client = JevyrClient()
        with (
            patch.object(client, "live_events", return_value=iter(())),
            patch.object(client, "status", return_value=status(str(first["eventDigest"]))),
            patch.object(
                client,
                "authenticated_record",
                side_effect=JevyrHttpError(400, "invalid"),
            ) as authenticate,
            patch("jevyr.client.time.sleep") as sleeping,
        ):
            with self.assertRaises(JevyrHttpError):
                client.wait_for_authenticated_record(
                    "case_3333333333333333",
                    reconnect_delay=0,
                    max_reconnect_delay=0,
                )
        authenticate.assert_called_once_with("case_3333333333333333")
        sleeping.assert_not_called()

    def test_authenticated_record_refuses_an_incomplete_terminal_replay(self) -> None:
        first = event()
        second = event(2, str(first["eventDigest"]), terminal=True)
        record = {
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "eventHeadDigest": first["eventDigest"],
        }
        authenticated = AuthenticatedRecord(
            payload=record,
            envelope={},
            key_id="sha256:" + ("c" * 64),
            payload_type=RECORD_DSSE_PAYLOAD_TYPE,
        )
        client = JevyrClient()
        with (
            patch.object(client, "live_events", return_value=iter(())),
            patch.object(
                client,
                "status",
                return_value=status(str(second["eventDigest"]), 2),
            ),
            patch.object(client, "authenticated_record", return_value=authenticated),
            patch.object(
                client,
                "poll_events",
                return_value=event_page([first]),
            ),
        ):
            with self.assertRaisesRegex(
                JevyrContinuityError,
                "exact terminal ledger head",
            ):
                client.wait_for_authenticated_record(
                    "case_3333333333333333",
                    reconnect_delay=0,
                    max_reconnect_delay=0,
                )

    def test_sse_decodes_multiline_payload(self) -> None:
        response = Response(b": heartbeat\r\nid: 1\r\ndata: one\r\ndata: two\r\n\r\n")
        self.assertEqual(list(_decode_sse(response)), [{"id": "1", "data": "one\ntwo"}])

    def test_sse_decoder_handles_every_line_ending_across_chunks(self) -> None:
        response = ChunkedResponse([
            b": heartbeat\r",
            b"\nid: 1\rdata: one\r\rid: 2\ndata: t",
            b"wo\n\n",
        ])
        self.assertEqual(
            list(_decode_sse(response)),
            [
                {"id": "1", "data": "one"},
                {"id": "2", "data": "two"},
            ],
        )
        with self.assertRaisesRegex(JevyrContinuityError, "valid UTF-8"):
            list(_decode_sse(ChunkedResponse([b"data: \xff\n\n"])))

    def test_sse_decoder_bounds_one_unterminated_event(self) -> None:
        with patch("jevyr.client._MAX_SSE_EVENT_CHARACTERS", 16), self.assertRaisesRegex(
            JevyrContinuityError,
            "bounded transport envelope",
        ):
            list(_decode_sse(ChunkedResponse([b"data: this-event-never-terminates"])))

    def test_cast_uses_canonical_control_and_subject_schema(self) -> None:
        receipt = {
            "protocol": "jevyr.seal/1",
            "caseId": "case_3333333333333333",
            "submissionDigest": "sha256:" + ("c" * 64),
            "subjectMaterialCaptureDigest": "sha256:" + ("0" * 64),
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "sealedAt": "2026-09-04T00:00:00.000Z",
            "policyVersion": "bone-v1",
            "policyDigest": "sha256:" + ("d" * 64),
            "genomeVersion": "genome-v1",
            "genomeDigest": "sha256:" + ("e" * 64),
            "searchDigest": "sha256:" + ("f" * 64),
            "intentContractDigest": "sha256:" + ("a" * 64),
        }
        with patch("jevyr.client.urlopen", return_value=Response(json.dumps(receipt).encode())) as opened:
            result = JevyrClient().cast(
                "Judge this",
                subjects=({"id": "repo", "kind": "directory", "locator": "."},),
                control="sovereign",
            )
        self.assertEqual(result["caseId"], "case_3333333333333333")
        request = opened.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.method, "POST")
        self.assertEqual(body["case"]["subjects"][0], {"id": "repo", "kind": "directory", "locator": "."})
        self.assertEqual(body["case"]["control"], "sovereign")
        self.assertNotIn("sovereignty", body["case"])
        self.assertFalse(hasattr(JevyrClient, "continue_case"))
        self.assertFalse(hasattr(JevyrClient, "send_message"))

    def test_continuity_rejects_a_gap_and_tampering(self) -> None:
        value = event()
        value["sequence"] = 3
        with self.assertRaises(JevyrContinuityError):
            _assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST)
        value = event()
        value["payload"] = {"stage": "cast", "status": "completed", "summary": "tampered"}
        with self.assertRaises(JevyrContinuityError):
            _assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST)
        value = event()
        value["observedAt"] = "2026-09-04T00:00:00Z"
        value["eventDigest"] = _event_digest(value)
        with self.assertRaises(JevyrContinuityError):
            _assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST)

    def test_authenticated_ledger_scan_rejects_a_rehashed_stage_regression(self) -> None:
        first = event(terminal=True)
        second = event(2, str(first["eventDigest"]))
        client = JevyrClient()
        with patch.object(client, "poll_events", return_value=event_page([first, second])):
            with self.assertRaisesRegex(JevyrContinuityError, "stage regression"):
                client._scan_record_head(
                    "case_3333333333333333",
                    {
                        "caseDigest": CASE_DIGEST,
                        "runDigest": RUN_DIGEST,
                        "eventHeadDigest": first["eventDigest"],
                    },
                    0,
                    0,
                )

    def test_search_status_is_a_canonical_event_kind(self) -> None:
        value = event()
        value["stage"] = "diverge"
        value["kind"] = "search.status"
        value["payload"] = {
            "layer": "HYPOTHESIS_NURSERY",
            "status": "exploring",
            "attempted": 17,
            "attemptSafetyCeiling": "1500000000000000000000",
            "resources": search_resources(),
            "hypothesisNursery": {
                "exactDistinctHypotheses": 6,
                "scars": 1,
                "declaredMechanismLabels": ["substrate-state"],
                "exactYieldAge": 2,
            },
            "summary": "The frontier is still changing.",
        }
        value["eventDigest"] = _event_digest(value)
        self.assertEqual(_assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST), value)

    def test_event_payload_contract_rejects_rehashed_legacy_and_overlong_search_fields(self) -> None:
        canonical = {
            "layer": "HYPOTHESIS_NURSERY",
            "status": "exploring",
            "attempted": 17,
            "attemptSafetyCeiling": "9" * 128,
            "resources": search_resources(),
            "hypothesisNursery": {
                "exactDistinctHypotheses": 6,
                "scars": 1,
                "declaredMechanismLabels": ["substrate-state"],
                "exactYieldAge": 2,
            },
            "summary": "The frontier is still changing.",
        }
        invalid_payloads = (
            {**canonical, "effortUsed": 3},
            {**canonical, "attemptSafetyCeiling": "9" * 129},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                value = event()
                value["stage"] = "diverge"
                value["kind"] = "search.status"
                value["payload"] = payload
                value["eventDigest"] = _event_digest(value)
                with self.assertRaises(JevyrContinuityError):
                    _assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST)

    def test_every_event_discriminator_has_a_closed_payload(self) -> None:
        digest = "sha256:" + ("c" * 64)
        payloads: tuple[tuple[str, dict[str, object]], ...] = (
            ("stage.status", {"stage": "cast", "status": "completed", "summary": "Cast."}),
            ("claim.published", {"claimId": "claim-1", "statement": "A claim.", "claimType": "mechanism"}),
            ("action.status", {"actionId": "action-1", "actionType": "forge", "status": "completed", "summary": "Done."}),
            ("evidence.observed", {"evidenceId": "evidence-1", "evidenceType": "artifact", "summary": "Observed.", "contentDigest": digest}),
            ("candidate.status", {"candidateId": "candidate-1", "status": "proposed", "summary": "Proposed."}),
            ("assay.status", {"assayId": "assay-1", "status": "passed", "critical": False, "summary": "Passed."}),
            ("reflex.completed", {"loop": 1, "reviewedEvidenceDigest": digest, "intentContractDigest": digest, "challengedNodeIds": [], "materialFindings": [], "decision": "confirm"}),
            ("memory.influence", {"memoryDigest": digest, "influence": "strategy_selected", "summary": "Hint.", "weight": 0.1}),
            ("kernel.status", {"operation": "terminated", "summary": "Terminal."}),
        )
        for kind, payload in payloads:
            with self.subTest(kind=kind):
                value = event()
                value["kind"] = kind
                value["payload"] = {**payload, "callerVerdict": "trust-me"}
                value["eventDigest"] = _event_digest(value)
                with self.assertRaises(JevyrContinuityError):
                    _assert_event(value, 0, None, CASE_DIGEST, RUN_DIGEST)

    def test_live_stream_uses_numeric_resume_id(self) -> None:
        value = event()
        status_body = json.dumps(status(str(value["eventDigest"]))).encode()
        stream_body = f"id: 1\ndata: {json.dumps(value)}\n\n".encode()
        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(status_body),
                Response(stream_body, {"content-type": "text/event-stream"}),
                Response(status_body),
            ],
        ) as opened:
            frames = list(JevyrClient().live_events("case_3333333333333333"))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].continuity, "verified")
        self.assertEqual(frames[0].verification_scope, "event-hash-chain")
        self.assertEqual(frames[0].head_digest, value["eventDigest"])
        stream_request = opened.call_args_list[1].args[0]
        self.assertEqual(stream_request.get_header("Last-event-id"), "0")

    def test_status_requires_complete_canonical_shape_and_identity(self) -> None:
        first = event()
        valid = status(str(first["eventDigest"]))
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(valid).encode()),
        ):
            self.assertEqual(JevyrClient().status("case_3333333333333333"), valid)

        ambiguous = json.dumps(valid).replace(
            '"protocol": "jevyr.status/1"',
            '"protocol": "jevyr.status/1", "\\u0070rotocol": "jevyr.status/1"',
        )
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(ambiguous.encode()),
        ), self.assertRaisesRegex(JevyrContinuityError, "duplicate object key"):
            JevyrClient().status("case_3333333333333333")

        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(valid).encode("utf-16")),
        ), self.assertRaisesRegex(JevyrContinuityError, "valid UTF-8"):
            JevyrClient().status("case_3333333333333333")

        with patch(
            "jevyr.client.urlopen",
            return_value=Response(b"{}", {"content-length": str(32 * 1_048_576 + 1)}),
        ), self.assertRaisesRegex(JevyrContinuityError, "33554432-byte limit"):
            JevyrClient().status("case_3333333333333333")

        malformed = (
            {**valid, "caseDigest": "sha256:" + ("A" * 64)},
            {**valid, "runDigest": "not-a-digest"},
            {**valid, "lastSequence": True},
            {**valid, "lastSequence": 9_007_199_254_740_992},
            {**valid, "headDigest": None},
            {**valid, "lifecycle": "finished"},
            {**valid, "stage": "unknown"},
            {**valid, "stageStatus": "approved"},
            {**valid, "updatedAt": "2026-09-04T00:00:01Z"},
            {**valid, "extra": "authority"},
            {**status(None, 0, "running"), "headDigest": str(first["eventDigest"])},
        )
        for value in malformed:
            with self.subTest(value=value), patch(
                "jevyr.client.urlopen",
                return_value=Response(json.dumps(value).encode()),
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient().status("case_3333333333333333")

    def test_poll_controls_are_bounded_safe_integers_before_transport(self) -> None:
        client = JevyrClient()
        calls = (
            lambda: client.poll_events("case", True),
            lambda: client.poll_events("case", -1),
            lambda: client.poll_events("case", 9_007_199_254_740_992),
            lambda: client.poll_events("case", wait_ms=True),
            lambda: client.poll_events("case", wait_ms=30_001),
            lambda: client.poll_events("case", limit=False),
            lambda: client.poll_events("case", limit=0),
            lambda: client.poll_events("case", limit=2_001),
        )
        with patch("jevyr.client.urlopen") as opened:
            for call in calls:
                with self.subTest(call=call), self.assertRaises(ValueError):
                    call()
            live_calls = (
                lambda: list(client.live_events("case", cursor=True)),
                lambda: list(client.live_events("case", poll_wait_ms=True)),
                lambda: list(client.live_events("case", poll_wait_ms=30_001)),
                lambda: list(client.live_events("case", max_sse_failures=False)),
                lambda: list(client.live_events("case", max_sse_failures=0)),
                lambda: list(client.live_events("case", prefer_sse=1)),
                lambda: list(client.live_events("case", reconnect_delay=True)),
                lambda: list(client.live_events("case", reconnect_delay=-0.1)),
                lambda: list(
                    client.live_events(
                        "case",
                        reconnect_delay=2,
                        max_reconnect_delay=1,
                    )
                ),
            )
            for call in live_calls:
                with self.subTest(call=call), self.assertRaises(ValueError):
                    call()
        opened.assert_not_called()
        for timeout in (True, 0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                JevyrClient(timeout=timeout)

    def test_event_pages_require_complete_canonical_shape_and_identity(self) -> None:
        first = event()
        valid = event_page([first])
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(valid).encode()),
        ):
            self.assertEqual(JevyrClient().poll_events("case"), valid)

        malformed = (
            {**valid, "caseDigest": "bad"},
            {**valid, "runDigest": "sha256:" + ("A" * 64)},
            {**valid, "afterSequence": True},
            {**valid, "throughSequence": True},
            {**valid, "headDigest": "bad"},
            {**valid, "caughtUp": 1},
            {**valid, "polledAt": "yesterday"},
            {**valid, "polledAt": "2026-09-04T00:00:01Z"},
            {**valid, "extra": "authority"},
            {
                **event_page([]),
                "headDigest": str(first["eventDigest"]),
            },
        )
        for value in malformed:
            with self.subTest(value=value), patch(
                "jevyr.client.urlopen",
                return_value=Response(json.dumps(value).encode()),
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient().poll_events("case")

    def test_live_stream_rejects_missing_named_duplicate_old_and_gapped_ids(self) -> None:
        first = event()
        conflicting = {**first, "payload": {**first["payload"], "summary": "conflict"}}  # type: ignore[arg-type]
        conflicting["eventDigest"] = _event_digest(conflicting)
        second = event(2, str(first["eventDigest"]), terminal=True)
        cases = {
            "missing": f"data: {json.dumps(first)}\n\n",
            "noncanonical": f"id: 01\ndata: {json.dumps(first)}\n\n",
            "named": f"event: mutation\nid: 1\ndata: {json.dumps(first)}\n\n",
            "duplicate": (
                f"id: 1\ndata: {json.dumps(first)}\n\n"
                f"id: 1\ndata: {json.dumps(first)}\n\n"
            ),
            "conflicting-old": (
                f"id: 1\ndata: {json.dumps(first)}\n\n"
                f"id: 1\ndata: {json.dumps(conflicting)}\n\n"
            ),
            "gap": f"id: 2\ndata: {json.dumps(second)}\n\n",
            "ambiguous-json": (
                "id: 1\ndata: "
                + json.dumps(first).replace(
                    '"protocol": "jevyr.event/1"',
                    '"protocol": "jevyr.event/1", "\\u0070rotocol": "jevyr.event/1"',
                )
                + "\n\n"
            ),
        }
        for label, body in cases.items():
            initial = status(
                str(second["eventDigest"]) if label == "gap" else str(first["eventDigest"]),
                2 if label == "gap" else 1,
            )
            with self.subTest(label=label), patch(
                "jevyr.client.urlopen",
                side_effect=[
                    Response(json.dumps(initial).encode()),
                    Response(
                        body.encode(),
                        {"content-type": "text/event-stream; charset=utf-8"},
                    ),
                ],
            ):
                with self.assertRaises(JevyrContinuityError):
                    list(
                        JevyrClient().live_events(
                            "case_3333333333333333",
                            reconnect_delay=0,
                            max_reconnect_delay=0,
                        )
                    )

    def test_initial_status_and_poll_transport_failures_retry_with_bounded_backoff(self) -> None:
        first = event()
        running = status(None, 0, "running")
        terminal = status(str(first["eventDigest"]))
        responses = [
            URLError("status unavailable"),
            Response(json.dumps(running).encode()),
            URLError("poll unavailable"),
            URLError("poll still unavailable"),
            Response(json.dumps(event_page([first])).encode()),
            Response(json.dumps(terminal).encode()),
        ]
        with (
            patch("jevyr.client.urlopen", side_effect=responses),
            patch("jevyr.client.time.sleep") as sleeping,
        ):
            frames = list(
                JevyrClient().live_events(
                    "case_3333333333333333",
                    prefer_sse=False,
                    poll_wait_ms=0,
                    reconnect_delay=0.25,
                    max_reconnect_delay=0.5,
                )
            )
        self.assertEqual([frame.cursor for frame in frames], [1])
        self.assertEqual(
            [call.args[0] for call in sleeping.call_args_list],
            [0.25, 0.25, 0.5],
        )

    def test_sse_reconnects_from_only_the_exact_accepted_cursor(self) -> None:
        first = event()
        second = event(2, str(first["eventDigest"]), terminal=True)
        responses = [
            Response(json.dumps(status(None, 0, "running")).encode()),
            Response(
                f"id: 1\ndata: {json.dumps(first)}\n\n".encode(),
                {"content-type": "text/event-stream"},
            ),
            Response(
                json.dumps(status(str(first["eventDigest"]), 1, "running")).encode()
            ),
            Response(
                f"id: 2\ndata: {json.dumps(second)}\n\n".encode(),
                {"content-type": "text/event-stream"},
            ),
            Response(json.dumps(status(str(second["eventDigest"]), 2)).encode()),
        ]
        with (
            patch("jevyr.client.urlopen", side_effect=responses) as opened,
            patch("jevyr.client.time.sleep"),
        ):
            frames = list(
                JevyrClient().live_events(
                    "case_3333333333333333",
                    reconnect_delay=0,
                    max_reconnect_delay=0,
                )
            )
        self.assertEqual([frame.cursor for frame in frames], [1, 2])
        first_request = opened.call_args_list[1].args[0]
        second_request = opened.call_args_list[3].args[0]
        self.assertEqual(first_request.get_header("Last-event-id"), "0")
        self.assertEqual(second_request.get_header("Last-event-id"), "1")
        self.assertTrue(second_request.full_url.endswith("events/stream?after=1"))

    def test_sse_transport_failures_retry_with_capped_exponential_backoff(self) -> None:
        first = event()
        responses = [
            Response(json.dumps(status(None, 0, "running")).encode()),
            http_error(503),
            http_error(503),
            http_error(503),
            Response(
                f"id: 1\ndata: {json.dumps(first)}\n\n".encode(),
                {"content-type": "text/event-stream"},
            ),
            Response(json.dumps(status(str(first["eventDigest"]))).encode()),
        ]
        with (
            patch("jevyr.client.urlopen", side_effect=responses),
            patch("jevyr.client.time.sleep") as sleeping,
        ):
            frames = list(
                JevyrClient().live_events(
                    "case_3333333333333333",
                    reconnect_delay=0.25,
                    max_reconnect_delay=0.5,
                    max_sse_failures=4,
                )
            )
        self.assertEqual([frame.cursor for frame in frames], [1])
        self.assertEqual(
            [call.args[0] for call in sleeping.call_args_list],
            [0.25, 0.5, 0.5],
        )

    def test_sse_failure_budget_falls_back_to_contiguous_polling(self) -> None:
        first = event()
        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(json.dumps(status(None, 0, "running")).encode()),
                http_error(503),
                Response(json.dumps(event_page([first])).encode()),
                Response(json.dumps(status(str(first["eventDigest"]))).encode()),
            ],
        ):
            frames = list(
                JevyrClient().live_events(
                    "case_3333333333333333",
                    poll_wait_ms=0,
                    reconnect_delay=0,
                    max_reconnect_delay=0,
                    max_sse_failures=1,
                )
            )
        self.assertEqual(
            [(frame.cursor, frame.transport) for frame in frames],
            [(1, "poll")],
        )

    def test_nonprogressing_poll_page_is_an_authority_failure(self) -> None:
        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(json.dumps(status(None, 0, "running")).encode()),
                Response(json.dumps(event_page([], caught_up=False)).encode()),
            ],
        ):
            with self.assertRaisesRegex(JevyrContinuityError, "no cursor progress"):
                list(
                    JevyrClient().live_events(
                        "case_3333333333333333",
                        prefer_sse=False,
                        poll_wait_ms=0,
                    )
                )

    def test_terminal_cursor_short_circuits_and_stream_iterator_closes_response(self) -> None:
        first = event()
        head = str(first["eventDigest"])
        for lifecycle in ("terminated", "invalid"):
            with self.subTest(lifecycle=lifecycle), patch(
                "jevyr.client.urlopen",
                return_value=Response(json.dumps(status(head, 1, lifecycle)).encode()),
            ) as opened:
                self.assertEqual(
                    list(
                        JevyrClient().live_events(
                            "case_3333333333333333",
                            cursor=1,
                            cursor_digest=head,
                        )
                    ),
                    [],
                )
            self.assertEqual(opened.call_count, 1)

        stream = ChunkedResponse(
            [f"id: 1\ndata: {json.dumps(first)}\n\n".encode()],
            {"content-type": "text/event-stream"},
        )
        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(json.dumps(status(head, 1, "running")).encode()),
                stream,
            ],
        ):
            observer = JevyrClient().live_events("case_3333333333333333")
            self.assertEqual(next(observer).cursor, 1)
            observer.close()
        self.assertTrue(stream.closed)

    def test_policy_descriptor_is_exact_content_addressed_and_record_bound(self) -> None:
        descriptor = {
            "protocol": "jevyr.policy-descriptor/1",
            "version": "jevyr.bone/1",
            "policy": {"mode": "sealed"},
            "subjectSnapshots": {"repository": "sha256:" + ("d" * 64)},
        }
        policy_digest = _digest(descriptor)
        artifact = {
            "protocol": "jevyr.descriptor-artifact/1",
            "kind": "policy",
            "digest": policy_digest,
            "descriptor": descriptor,
        }
        binding: CasePolicyDescriptor = {
            "protocol": "jevyr.case-policy-descriptor/1",
            "caseId": ARTIFACT_CASE_ID,
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "policyDigest": policy_digest,
            "artifact": artifact,  # type: ignore[typeddict-item]
        }
        record = {
            "protocol": "jevyr.record/1",
            "caseDigest": CASE_DIGEST,
            "runDigest": RUN_DIGEST,
            "policyDigest": policy_digest,
            "genomeDigest": "sha256:" + ("e" * 64),
            "searchDigest": "sha256:" + ("f" * 64),
            "intentContractDigest": "sha256:" + ("1" * 64),
            "eventHeadDigest": "sha256:" + ("2" * 64),
            "verdict": {
                "policyVersion": "jevyr.bone/1",
                "intentContractDigest": "sha256:" + ("1" * 64),
                "evidenceDigest": "sha256:" + ("3" * 64),
                "integrity": "VALID",
                "creation": "NO_SURVIVOR",
                "embodiment": "NOT_BUILT",
                "judgment": "NOT_APPLICABLE",
                "feasibilityByCandidate": {},
                "basis": [],
            },
            "reflex": {
                "loop": 1,
                "reviewedEvidenceDigest": "sha256:" + ("3" * 64),
                "intentContractDigest": "sha256:" + ("1" * 64),
                "challengedNodeIds": [],
                "materialFindings": [],
                "decision": "confirm",
            },
            "memoryInfluences": [],
            "crystallizedAt": "2026-09-04T00:00:01.000Z",
        }

        self.assertEqual(assert_descriptor_artifact(artifact, expected_kind="policy"), artifact)
        self.assertEqual(assert_case_policy_descriptor(binding, ARTIFACT_CASE_ID), binding)
        self.assertEqual(assert_policy_descriptor_record_binding(binding, record), binding)
        with self.assertRaises(JevyrContinuityError):
            assert_descriptor_artifact({**artifact, "descriptor": {**descriptor, "version": "tampered"}})
        with self.assertRaises(JevyrContinuityError):
            assert_case_policy_descriptor({**binding, "caseId": "case_fedcba9876543210"}, ARTIFACT_CASE_ID)
        with self.assertRaises(JevyrContinuityError):
            assert_case_policy_descriptor({**binding, "artifact": {**artifact, "kind": "genome"}}, ARTIFACT_CASE_ID)
        with self.assertRaises(JevyrContinuityError):
            assert_policy_descriptor_record_binding(binding, {**record, "runDigest": "sha256:" + ("9" * 64)})

        with patch("jevyr.client.urlopen", return_value=Response(json.dumps(binding).encode())) as opened:
            client = JevyrClient(base_url="http://test")
            self.assertEqual(client.policy_descriptor(ARTIFACT_CASE_ID), binding)
        self.assertTrue(opened.call_args.args[0].full_url.endswith(f"/v1/cases/{ARTIFACT_CASE_ID}/policy-descriptor"))

        authenticated = AuthenticatedRecord(
            payload=record,
            envelope={},
            key_id="sha256:" + ("4" * 64),
            payload_type=RECORD_DSSE_PAYLOAD_TYPE,
        )
        client = JevyrClient(base_url="http://test")
        with (
            patch.object(client, "authenticated_record", return_value=authenticated),
            patch.object(client, "policy_descriptor", return_value=binding),
        ):
            verified = client.verified_policy_descriptor(ARTIFACT_CASE_ID)
        self.assertEqual(verified.binding, binding)
        self.assertIs(verified.record, authenticated)
        self.assertEqual(verified.verification, "sha256+dsse-record-binding")

    def test_artifact_metadata_and_index_are_strict_and_case_bound(self) -> None:
        meta, _data, index = artifact_fixture()
        self.assertEqual(
            assert_artifact_meta(
                meta,
                expected_case_id=ARTIFACT_CASE_ID,
                expected_artifact_id=meta["id"],
            ),
            meta,
        )
        self.assertEqual(assert_artifact_list(index, ARTIFACT_CASE_ID), index)

        missing = {name: value for name, value in meta.items() if name != "createdAt"}
        with self.assertRaises(JevyrContinuityError):
            assert_artifact_meta(missing)
        with self.assertRaises(JevyrContinuityError):
            assert_artifact_meta({**meta, "surprise": True})
        with self.assertRaisesRegex(JevyrContinuityError, "invalid Case index"):
            assert_artifact_list(
                {**index, "caseId": "case_fedcba9876543210"},
                ARTIFACT_CASE_ID,
            )
        with self.assertRaisesRegex(JevyrContinuityError, "Case boundary"):
            assert_artifact_list(
                {
                    **index,
                    "artifacts": [{**meta, "caseId": "case_fedcba9876543210"}],
                },
                ARTIFACT_CASE_ID,
            )
        with self.assertRaisesRegex(JevyrContinuityError, "repeats"):
            assert_artifact_list(
                {**index, "artifacts": [meta, meta]},
                ARTIFACT_CASE_ID,
            )
        with self.assertRaises(JevyrContinuityError):
            assert_artifact_list({**index, "extra": None}, ARTIFACT_CASE_ID)

    def test_artifact_metadata_rejects_invalid_identity_and_fields(self) -> None:
        meta, _data, _index = artifact_fixture()
        mutations = {
            "digest": {**meta, "digest": "sha256:" + ("A" * 64)},
            "digest-derived identifier": {**meta, "id": "artifact_" + ("f" * 24)},
            "empty case": {**meta, "caseId": ""},
            "path name": {**meta, "name": "../observation.json"},
            "control character name": {**meta, "name": "bad\x00name"},
            "utf16-oversized name": {**meta, "name": "🧬" * 128},
            "media type": {**meta, "mediaType": "not a media type"},
            "negative size": {**meta, "size": -1},
            "boolean size": {**meta, "size": True},
            "unsafe size": {**meta, "size": 9_007_199_254_740_992},
            "invalid timestamp": {**meta, "createdAt": "not-a-date"},
            "impossible timestamp": {**meta, "createdAt": "2026-02-30T12:34:56.000Z"},
            "non-canonical timestamp": {**meta, "createdAt": "2026-09-04T12:34:56Z"},
        }
        for label, value in mutations.items():
            with self.subTest(label=label), self.assertRaises(JevyrContinuityError):
                assert_artifact_meta(value)

    def test_client_lists_only_validated_artifacts(self) -> None:
        meta, _data, index = artifact_fixture()
        responses = [Response(json.dumps(index).encode()), Response(json.dumps(index).encode())]
        with patch("jevyr.client.urlopen", side_effect=responses) as opened:
            client = JevyrClient(base_url="http://test")
            self.assertEqual(client.list_artifacts(ARTIFACT_CASE_ID), [meta])
            self.assertEqual(client.artifact_list(ARTIFACT_CASE_ID), index)
        self.assertEqual(opened.call_count, 2)
        self.assertTrue(
            opened.call_args_list[0].args[0].full_url.endswith(
                f"/v1/cases/{ARTIFACT_CASE_ID}/artifacts"
            )
        )

        malformed = {**index, "artifacts": [{**meta, "caseId": "another-case"}]}
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(malformed).encode()),
        ):
            with self.assertRaises(JevyrContinuityError):
                JevyrClient(base_url="http://test").list_artifacts(ARTIFACT_CASE_ID)

    def test_malformed_artifact_index_json_is_a_continuity_failure(self) -> None:
        with patch("jevyr.client.urlopen", return_value=Response(b"{")):
            with self.assertRaisesRegex(JevyrContinuityError, "malformed body"):
                JevyrClient(base_url="http://test").list_artifacts(ARTIFACT_CASE_ID)

    def test_fetch_artifact_verifies_index_headers_length_media_type_and_hash(self) -> None:
        meta, data, index = artifact_fixture()
        responses = [
            Response(json.dumps(index).encode()),
            artifact_response(meta, data),
            Response(json.dumps(index).encode()),
            artifact_response(meta, data),
        ]
        with patch("jevyr.client.urlopen", side_effect=responses) as opened:
            client = JevyrClient(base_url="http://test")
            result = client.fetch_artifact(ARTIFACT_CASE_ID, meta["id"])
            alias = client.artifact(ARTIFACT_CASE_ID, meta["id"])
        self.assertEqual(result.meta, meta)
        self.assertEqual(result.data, data)
        self.assertEqual(result.verification, "sha256")
        self.assertEqual(alias, result)
        artifact_request = opened.call_args_list[1].args[0]
        self.assertEqual(artifact_request.get_header("Accept"), meta["mediaType"])
        self.assertTrue(artifact_request.full_url.endswith(f"/artifacts/{meta['id']}"))

    def test_fetch_artifact_requires_membership_in_validated_case_index(self) -> None:
        meta, _data, index = artifact_fixture()
        empty = {**index, "artifacts": []}
        with patch(
            "jevyr.client.urlopen",
            return_value=Response(json.dumps(empty).encode()),
        ) as opened:
            with self.assertRaisesRegex(JevyrContinuityError, "does not contain"):
                JevyrClient(base_url="http://test").fetch_artifact(
                    ARTIFACT_CASE_ID, meta["id"]
                )
        self.assertEqual(opened.call_count, 1)

    def test_fetch_artifact_rejects_bad_digest_headers(self) -> None:
        meta, data, index = artifact_fixture()
        for digest in (None, "SHA256:bad", "sha256:" + ("f" * 64)):
            with self.subTest(digest=digest), patch(
                "jevyr.client.urlopen",
                side_effect=[
                    Response(json.dumps(index).encode()),
                    artifact_response(meta, data, {"x-jevyr-digest": digest}),
                ],
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient(base_url="http://test").fetch_artifact(
                        ARTIFACT_CASE_ID, meta["id"]
                    )

    def test_original_subject_certificate_has_8_mib_transport_limit(self) -> None:
        meta, _data, index = artifact_fixture()
        oversized = {**meta, "mediaType": "application/vnd.jevyr.original-subject-assertion-certificate+json", "size": 8 * 1_048_576 + 1}
        with patch("jevyr.client.urlopen", return_value=Response(json.dumps({**index, "artifacts": [oversized]}).encode())) as opened:
            with self.assertRaisesRegex(JevyrContinuityError, "8388608-byte materialization limit"):
                JevyrClient(base_url="http://test").fetch_artifact(ARTIFACT_CASE_ID, meta["id"])
        self.assertEqual(opened.call_count, 1)

    def test_original_subject_certificate_rechecks_changed_index_before_body(self) -> None:
        meta, _data, index = artifact_fixture()
        small = {**meta, "mediaType": "application/vnd.jevyr.original-subject-assertion-certificate+json"}
        responses = [Response(json.dumps({**index, "artifacts": [small]}).encode()),
                     Response(json.dumps({**index, "artifacts": [{**small, "size": 8 * 1_048_576 + 1}]}).encode())]
        with patch("jevyr.client.urlopen", side_effect=responses) as opened:
            client = JevyrClient(base_url="http://test")
            self.assertEqual(client.list_artifacts(ARTIFACT_CASE_ID)[0]["size"], meta["size"])
            with self.assertRaisesRegex(JevyrContinuityError, "8388608-byte materialization limit"):
                client.fetch_artifact(ARTIFACT_CASE_ID, meta["id"])
        self.assertEqual(opened.call_count, 2)

    def test_fetch_artifact_rejects_bad_length_and_media_headers(self) -> None:
        meta, data, index = artifact_fixture()
        for length in (
            None,
            "01",
            "not-a-number",
            "9007199254740992",
            str(meta["size"] + 1),
        ):
            with self.subTest(length=length), patch(
                "jevyr.client.urlopen",
                side_effect=[
                    Response(json.dumps(index).encode()),
                    artifact_response(meta, data, {"content-length": length}),
                ],
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient(base_url="http://test").fetch_artifact(
                        ARTIFACT_CASE_ID, meta["id"]
                    )

        for media_type in (None, "application/octet-stream"):
            with self.subTest(media_type=media_type), patch(
                "jevyr.client.urlopen",
                side_effect=[
                    Response(json.dumps(index).encode()),
                    artifact_response(meta, data, {"content-type": media_type}),
                ],
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient(base_url="http://test").fetch_artifact(
                        ARTIFACT_CASE_ID, meta["id"]
                    )

    def test_fetch_artifact_rejects_truncation_tampering_and_unreadable_body(self) -> None:
        meta, data, index = artifact_fixture()
        tampered = bytes([data[0] ^ 1]) + data[1:]
        for body in (data[:-1], tampered):
            with self.subTest(body=body), patch(
                "jevyr.client.urlopen",
                side_effect=[
                    Response(json.dumps(index).encode()),
                    artifact_response(meta, body),
                ],
            ):
                with self.assertRaises(JevyrContinuityError):
                    JevyrClient(base_url="http://test").fetch_artifact(
                        ARTIFACT_CASE_ID, meta["id"]
                    )

        broken_headers = {
            "content-length": str(meta["size"]),
            "content-type": meta["mediaType"],
            "x-jevyr-digest": meta["digest"],
        }
        with patch(
            "jevyr.client.urlopen",
            side_effect=[
                Response(json.dumps(index).encode()),
                BrokenResponse(headers=broken_headers),
            ],
        ):
            with self.assertRaisesRegex(JevyrContinuityError, "body could not be read"):
                JevyrClient(base_url="http://test").fetch_artifact(
                    ARTIFACT_CASE_ID, meta["id"]
                )

    def test_fetch_artifact_rejects_noncanonical_identifier_before_transport(self) -> None:
        with patch("jevyr.client.urlopen") as opened:
            with self.assertRaises(ValueError):
                JevyrClient(base_url="http://test").fetch_artifact(
                    ARTIFACT_CASE_ID, "../artifact"
                )
        opened.assert_not_called()

    def test_python_canonicalization_matches_protocol_number_rules(self) -> None:
        self.assertEqual(_canonical({"z": 1.0, "tiny": 0.000001, "large": 1e20}), b'{"large":100000000000000000000,"tiny":0.000001,"z":1}')


if __name__ == "__main__":
    unittest.main()
