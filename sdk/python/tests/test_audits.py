import unittest
from jevyr.client import JevyrContinuityError, _assert_event_payload, _digest


class InvestigationAuditTests(unittest.TestCase):
    def test_formal_certificate_is_exact_and_cannot_impersonate_an_execution(self):
        proof = {"protocol": "jevyr.formal-counterexample/1", "rule": "finite-sequence-length-lower-bound", "intentContractDigest": "sha256:" + "a" * 64, "obligationId": "critical", "statementDigest": "sha256:" + "b" * 64, "source": {"start": 0, "end": 4, "text": "test"}, "proposition": {"domain": "all_finite_byte_strings", "minimumInputLength": 0, "minimumOutputLength": 0, "requiredSaving": 1}, "witness": {"inputLength": 0, "inputHex": "", "maximumOutputLength": -1}}
        payload = {"evidenceId": "formal_1", "evidenceType": "tool_observation", "summary": "Finite arithmetic certificate; Bone independently checks the sealed statement.", "contentDigest": _digest(proof), "formalProof": proof}
        _assert_event_payload("evidence.observed", payload)
        for mutation in ({"evidenceType": "sandbox_execution"}, {"supports": ["critical"]}, {"contentDigest": "sha256:" + "c" * 64}):
            with self.assertRaises(JevyrContinuityError):
                _assert_event_payload("evidence.observed", {**payload, **mutation})
        for witness in ({**proof["witness"], "maximumOutputLength": 0}, {**proof["witness"], "inputLength": False}):
            invalid = {**proof, "witness": witness}
            with self.assertRaises(JevyrContinuityError):
                _assert_event_payload("evidence.observed", {**payload, "formalProof": invalid, "contentDigest": _digest(invalid)})

    def test_closed_population_failure_is_scoped_to_one_observation_per_member(self):
        payload = {"assayId": "closed_population", "status": "failed", "critical": True, "summary": "All sealed members failed.", "scope": "closed_population", "populationIds": ["candidate_a", "candidate_b"], "evidenceIds": ["observation_a", "observation_b"]}
        _assert_event_payload("assay.status", payload)
        with self.assertRaises(JevyrContinuityError):
            _assert_event_payload("assay.status", {**payload, "obligationId": "global_claim"})
        with self.assertRaises(JevyrContinuityError):
            _assert_event_payload("assay.status", {**payload, "evidenceIds": ["observation_a"]})

    def test_audit_receipt_requires_digest_binding_and_closed_shape(self):
        audit = {"kind": "assumption_check", "sealedAssumptionsDigest": "sha256:" + "a" * 64, "appliedAssumptionsDigest": "sha256:" + "a" * 64}
        payload = {"evidenceId": "audit_1", "evidenceType": "tool_observation", "summary": "Measured assumption bindings.", "contentDigest": _digest(audit), "audit": audit}
        _assert_event_payload("evidence.observed", payload)
        with self.assertRaisesRegex(JevyrContinuityError, "digest"):
            _assert_event_payload("evidence.observed", {**payload, "contentDigest": "sha256:" + "b" * 64})
        with self.assertRaises(JevyrContinuityError):
            _assert_event_payload("evidence.observed", {**payload, "audit": {**audit, "desiredVerdict": "ACCEPT"}})

    def test_reflex_reports_absent_measurements_without_treating_them_as_passes(self):
        payload = {"loop": 1, "reviewedEvidenceDigest": "sha256:" + "a" * 64, "intentContractDigest": "sha256:" + "b" * 64, "challengedNodeIds": [], "materialFindings": [], "decision": "confirm", "audits": [{"audit": "provider-correlation", "status": "unmeasured", "summary": "No paired trials.", "evidenceIds": []}]}
        _assert_event_payload("reflex.completed", payload)
        payload["audits"][0]["status"] = "probably-passed"
        with self.assertRaises(JevyrContinuityError):
            _assert_event_payload("reflex.completed", payload)


if __name__ == "__main__":
    unittest.main()
