from __future__ import annotations
import base64
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from jevyr import (
    JevyrClient, JevyrContinuityError, IN_TOTO_DSSE_PAYLOAD_TYPE,
    canonical_record_text, derive_run_statements, verify_run_attestations,
)
from jevyr.client import _assert_envelope, _canonical, _digest, _dsse_pae


def fixture():
    return json.loads((Path(__file__).parent / "fixtures/run-attestations.json").read_text(encoding="utf-8"))


def signing_fixture():
    """Fresh test-only signer; the published fixture's private key is never needed."""
    value = fixture()
    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    key_id = "sha256:" + hashlib.sha256(public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    signer = value["material"]["trust"]["keys"][0]
    signer.update(keyId=key_id, publicKeyPem=public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode())
    def envelope(payload_type, payload):
        data = _canonical(payload)
        return {"payloadType":payload_type, "payload":base64.b64encode(data).decode(), "signatures":[{"keyid":key_id,"sig":base64.b64encode(key.sign(_dsse_pae(payload_type,data))).decode()}]}
    material = value["material"]
    for kind in ("seal", "record", "terminal"):
        material[kind+"Envelope"] = envelope(material[kind+"Envelope"]["payloadType"], material[kind])
    statements = derive_run_statements(material["seal"], material["record"], material["terminal"], key_id)
    for kind in ("production", "advisory"):
        value["payload"][kind] = envelope(IN_TOTO_DSSE_PAYLOAD_TYPE, statements[kind])
    return value, envelope, statements


class RunAttestationsTests(unittest.TestCase):
    def test_daemon_produced_cross_language_payload_and_exact_record_bytes(self):
        value = fixture()
        verified = verify_run_attestations(value["payload"], value["material"])
        self.assertEqual(verified.verification, "dsse-ed25519+exact-derived-run-statements")
        self.assertEqual(verified.slsa_level_claim, "none")
        self.assertEqual(verified.canonical_record, canonical_record_text(value["material"]["record"]))
        subject_digest = verified.statements["production"]["subject"][0]["digest"]["sha256"]
        self.assertEqual(subject_digest, hashlib.sha256(verified.canonical_record.encode("utf-8")).hexdigest())
        self.assertNotEqual(subject_digest, hashlib.sha256((json.dumps(value["material"]["record"], indent=2)+"\n").encode()).hexdigest())
        self.assertEqual(len(value["material"]["trust"]["keys"][0]["payloadTypes"]), 3)
        with self.assertRaises(JevyrContinuityError): _assert_envelope(value["payload"]["production"])

    def test_resigned_wrong_subject_predicate_and_advisory_are_rejected(self):
        value, envelope, statements = signing_fixture()
        verify_run_attestations(value["payload"], value["material"])
        subject = copy.deepcopy(statements["production"])
        subject["subject"][0]["digest"]["sha256"] = "f" * 64
        advisory = copy.deepcopy(statements["advisory"])
        advisory["predicate"]["axes"]["judgment"] = "ACCEPT"
        for changed in (
            {**value["payload"], "production":envelope(IN_TOTO_DSSE_PAYLOAD_TYPE, subject)},
            {**value["payload"], "advisory":envelope(IN_TOTO_DSSE_PAYLOAD_TYPE, advisory)},
            {**value["payload"], "production":value["payload"]["advisory"], "advisory":value["payload"]["production"]},
        ):
            with self.subTest(changed=changed["production"]["payload"][:20]), self.assertRaises(JevyrContinuityError):
                verify_run_attestations(changed, value["material"])

    def test_missing_tampered_cross_case_foreign_signer_and_widened_trust_fail(self):
        value = fixture()
        missing = copy.deepcopy(value["payload"]); del missing["advisory"]
        invalid_sig = copy.deepcopy(value["payload"]); invalid_sig["production"]["signatures"][0]["sig"] = base64.b64encode(bytes(64)).decode()
        duplicate = copy.deepcopy(value["payload"]); duplicate["production"]["signatures"] *= 2
        other, _, _ = signing_fixture()
        for changed in (missing, invalid_sig, duplicate, {**value["payload"], "extra":"promote"},
                {**value["payload"], "caseId":"case_4444444444444444", "runDigest":"sha256:"+"4"*64},
                {**value["payload"], "advisory":other["payload"]["advisory"]}):
            with self.assertRaises(JevyrContinuityError): verify_run_attestations(changed, value["material"])
        trust = copy.deepcopy(value["material"]); trust["trust"]["keys"][0]["payloadTypes"].append(IN_TOTO_DSSE_PAYLOAD_TYPE)
        with self.assertRaises(JevyrContinuityError): verify_run_attestations(value["payload"], trust)
        # A separately trusted signer still cannot substitute one member of the closure chain.
        mixed = copy.deepcopy(value["material"])
        mixed["trust"]["keys"].extend(other["material"]["trust"]["keys"])
        mixed["terminalEnvelope"] = other["material"]["terminalEnvelope"]
        with self.assertRaises(JevyrContinuityError): verify_run_attestations(value["payload"], mixed)
        with self.assertRaises(JevyrContinuityError): verify_run_attestations(value["payload"], {})

    def test_resigned_terminal_cannot_bind_a_different_canonical_record(self):
        value, envelope, _ = signing_fixture()
        material = value["material"]
        material["terminal"]["recordDigest"] = _digest("foreign record")
        material["terminalEnvelope"] = envelope(material["terminalEnvelope"]["payloadType"], material["terminal"])
        with self.assertRaisesRegex(JevyrContinuityError, "canonical Record digest"):
            verify_run_attestations(value["payload"], material)

    def test_client_reads_exact_routes_without_mutating_and_checks_requested_case(self):
        value = fixture(); case_id = value["payload"]["caseId"]; material = value["material"]
        routes = {f"/v1/cases/{case_id}/attestations": value["payload"], "/v1/trust": material["trust"]}
        for name, suffix in (("seal", "seal"), ("record", "record"), ("terminal", "terminal"),
                ("sealEnvelope", "seal/envelope"), ("recordEnvelope", "record/envelope"), ("terminalEnvelope", "terminal/envelope")):
            routes[f"/v1/cases/{case_id}/{suffix}"] = material[name]
        client = JevyrClient()
        with patch.object(client, "_json", side_effect=lambda path: copy.deepcopy(routes[path])) as request:
            self.assertEqual(client.verified_run_attestations(case_id).payload, value["payload"])
            self.assertEqual(request.call_count, 8)
        with patch.object(client, "_json", return_value=value["payload"]):
            with self.assertRaises(JevyrContinuityError): client.run_attestations("case_4444444444444444")
        with patch.object(client, "_json") as request:
            with self.assertRaises(ValueError): client.run_attestations("../other")
            request.assert_not_called()


if __name__ == "__main__": unittest.main()
