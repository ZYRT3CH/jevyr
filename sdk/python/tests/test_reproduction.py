from __future__ import annotations
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from jevyr import JevyrClient, JevyrContinuityError

def receipt(prefix="a"):
    return {"protocol":"jevyr.seal/1", "caseId":"case_"+prefix*16,"runDigest":"sha256:"+prefix*64,"sealedAt":"2026-09-05T00:00:00.000Z","policyVersion":"bone-v1","genomeVersion":"genome-v1", **{field:"sha256:"+"c"*64 for field in ("submissionDigest","subjectMaterialCaptureDigest","caseDigest","policyDigest","genomeDigest","searchDigest","intentContractDigest")}}

class ReproductionTests(unittest.TestCase):
    def test_exact_controlled_rerun_authenticates_both_seals_without_reposting_source(self):
        client = JevyrClient(); source, created = receipt(), receipt("b")
        with patch.object(client,"verified_seal_receipt",side_effect=[SimpleNamespace(payload=source),SimpleNamespace(payload=created)]) as verified, patch.object(client,"_json",return_value=created) as request:
            self.assertEqual(client.reproduce_case(source["caseId"],"same"),created)
            request.assert_called_once_with("/v1/reproductions",method="POST",body={"sourceCaseId":source["caseId"],"seed":"same"})
            self.assertEqual(verified.call_count,2)
    def test_changed_material_or_unverified_response_fails_and_does_not_retry(self):
        client=JevyrClient();source,created=receipt(),receipt("b")
        with patch.object(client,"verified_seal_receipt",return_value=SimpleNamespace(payload=source)), patch.object(client,"_json",return_value={**created,"subjectMaterialCaptureDigest":"sha256:"+"d"*64}) as request:
            with self.assertRaises(JevyrContinuityError):client.reproduce_case(source["caseId"],"new")
            self.assertEqual(request.call_count,1)
        with patch.object(client,"verified_seal_receipt",side_effect=[SimpleNamespace(payload=source),SimpleNamespace(payload={**created,"policyDigest":"sha256:"+"d"*64})]),patch.object(client,"_json",return_value=created):
            with self.assertRaises(JevyrContinuityError):client.reproduce_case(source["caseId"],"same")
        with patch.object(client,"_json") as request:
            with self.assertRaises(ValueError):client.reproduce_case(source["caseId"],"continue")
            request.assert_not_called()

if __name__ == "__main__":unittest.main()
