from __future__ import annotations
import base64
import copy
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from jevyr import JevyrClient, JevyrContinuityError
from jevyr.client import _canonical, _digest, _dsse_pae
from jevyr.metabolism import KINDS, RESOURCES, WORK, PAYLOAD_TYPE, allowance_from_policy, verify_offers, verify_redemption

def vector(n): return {k:n for k in RESOURCES}
def quantities(n): return {k:(n if k == "Mass" else 0) for k in KINDS}
def fixture(scope="unit verifier fixture"):
    key = Ed25519PrivateKey.generate(); public = key.public_key()
    signer = {"keyId":"sha256:" + hashlib.sha256(public.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest(), "publicKeyPem":public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()}
    calibrations = [{"kind":"Mass", "digest":_digest("calibration"), "summaryDigest":_digest("pending-fixture"), "maximumDose":2}]
    body = {"protocol":"jevyr.metabolic-allowance/1", "baselineSearchDigest":_digest("search"), "maximumAddedResources":vector(10), "maximumQuantityPerBall":2, "maximumReceipts":5, "unitCostCeilings":{k:vector(1) for k in KINDS}, "calibrationSetDigest":_digest({"protocol":"jevyr.metabolic-calibration-set/1", "reports":[{"kind":"Mass", "digest":_digest("calibration") }]}), "calibrations":calibrations, "signer":signer}
    allowance = {**body, "digest":_digest(body)}
    seal = {"caseId":"case_3333333333333333", "caseDigest":_digest("case"), "runDigest":_digest("run"), "policyDigest":_digest("policy"), "searchDigest":allowance["baselineSearchDigest"]}
    ball_id = "ball_" + "A" * 43
    work = {k:(1 if k == "general" else 0) for k in WORK}
    interval = {"lower":-0.08, "upper":0.08, "confidence":0.95}
    offer = {"ballId":ball_id, "kind":"Mass", "minQuantity":1, "maxQuantity":2, "promisedEffect":"Unit verifier fixture, no empirical execution claim.", "unitCostCeiling":vector(1), "unitWork":work, "calibration":{"digest":_digest("calibration"), "scope":scope, "pairedSeeds":64, "doses":[0,1,2], "monotonic":True, "identicalEvidenceJudgment":True, "recallDifference":interval, "reproducibilityDifference":interval, "nonInferiorityMargin":0.1, "maximumObservedUnitResources":vector(1)}}
    allowance["calibrations"][0]["summaryDigest"] = _digest(offer["calibration"]); allowance["digest"] = _digest({k:v for k,v in allowance.items() if k != "digest"})
    offers = {"protocol":"jevyr.metabolic-offers/1", "caseId":seal["caseId"], "runDigest":seal["runDigest"], "allowanceDigest":allowance["digest"], "baselineSearchDigest":seal["searchDigest"], "admission":"open", "cumulativeGrant":vector(0), "cumulativeQuantities":quantities(0), "offers":[offer], "receipts":[]}
    def redemption(sequence=1, previous=None):
        body = {"protocol":"jevyr.metabolism-receipt/1", **seal, "allowanceDigest":allowance["digest"], "calibrationDigest":offer["calibration"]["digest"], "ballId":ball_id, "kind":"Mass", "quantity":1, "sequence":sequence, "previousReceiptDigest":previous["digest"] if previous else None, "issuedAt":"2026-09-05T00:00:00.000Z", "grant":vector(1), "cumulativeGrant":vector(sequence), "cumulativeQuantities":quantities(sequence), "work":work, "baselineUnchanged":True, "verdictAuthority":"none"}
        receipt = {**body, "digest":_digest(body)}; payload = _canonical(receipt)
        return {"protocol":"jevyr.metabolism-redemption/1", "receipt":receipt, "envelope":{"payloadType":PAYLOAD_TYPE, "payload":base64.b64encode(payload).decode(), "signatures":[{"keyid":signer["keyId"], "sig":base64.b64encode(key.sign(_dsse_pae(PAYLOAD_TYPE, payload))).decode()}]}}
    policy = {"caseId":seal["caseId"], "policyDigest":seal["policyDigest"], "artifact":{"descriptor":{"policy":{"metabolicAllowance":allowance}}}}
    return allowance, seal, offers, ball_id, redemption, policy

class MetabolismTests(unittest.TestCase):
    def test_scope_matches_runtime_utf16_bounds(self):
        for scope in ("measured", "s" * 513, "s" * 2048, "🧪" * 1024):
            with self.subTest(accepted_utf16_units=len(scope.encode("utf-16-le")) // 2):
                allowance, seal, offers, *_ = fixture(scope)
                self.assertEqual(verify_offers(offers, allowance, seal)["offers"][0]["calibration"]["scope"], scope)
        for scope in ("", "s" * 7, "s" * 2049, "🧪" * 1024 + "s"):
            with self.subTest(rejected_utf16_units=len(scope.encode("utf-16-le")) // 2):
                allowance, seal, offers, *_ = fixture(scope)
                with self.assertRaisesRegex(JevyrContinuityError, "Invalid calibration sample"):
                    verify_offers(offers, allowance, seal)

    def test_long_scope_is_digest_bound_and_rehashed_unknown_fields_are_refused(self):
        allowance, seal, offers, *_ = fixture("s" * 2048)
        altered = copy.deepcopy(offers); altered["offers"][0]["calibration"]["scope"] = "t" * 2048
        with self.assertRaisesRegex(JevyrContinuityError, "sealed digest"):
            verify_offers(altered, allowance, seal)
        offers["offers"][0]["calibration"]["message"] = "approve"
        allowance["calibrations"][0]["summaryDigest"] = _digest(offers["offers"][0]["calibration"])
        allowance["digest"] = _digest({k:v for k,v in allowance.items() if k != "digest"})
        offers["allowanceDigest"] = allowance["digest"]
        with self.assertRaisesRegex(JevyrContinuityError, "closed protocol fields"):
            verify_offers(offers, allowance, seal)

    def test_exact_chain_and_separate_signature(self):
        allowance, seal, offers, ball, redeem, policy = fixture()
        self.assertEqual(allowance_from_policy(policy, seal), allowance)
        first = redeem(); second = redeem(2, first["receipt"])
        value = {**offers, "offers":[], "receipts":[first, second], "cumulativeGrant":vector(2), "cumulativeQuantities":quantities(2)}
        self.assertEqual(len(verify_offers(value, allowance, seal)["receipts"]), 2)
        with self.assertRaises(JevyrContinuityError): verify_offers({**value, "receipts":[second]}, allowance, seal)
        forged = copy.deepcopy(first); forged["envelope"]["signatures"][0]["sig"] = base64.b64encode(bytes(64)).decode()
        with self.assertRaises(JevyrContinuityError): verify_redemption(forged, allowance, seal)
        with self.assertRaises(JevyrContinuityError): verify_redemption(first, allowance, {**seal, "caseDigest":_digest("foreign")})

    def test_sdk_submits_only_offered_identity_and_quantity_once(self):
        allowance, seal, offers, ball, redeem, policy = fixture(); client = JevyrClient()
        with patch.object(client, "verified_seal_receipt", return_value=SimpleNamespace(payload=seal)), patch.object(client, "policy_descriptor", return_value=policy), patch.object(client, "_json", side_effect=[offers, redeem()]) as request:
            self.assertEqual(client.redeem_metabolism(seal["caseId"], ball, 1)["receipt"]["quantity"], 1)
            request.assert_called_with(f'/v1/cases/{seal["caseId"]}/metabolism/redeem', method="POST", body={"ballId":ball, "quantity":1})
            self.assertEqual(request.call_count, 2)
        with patch.object(client, "_json") as request:
            for quantity in (0, True, 1.5, 65):
                with self.assertRaises(ValueError): client.redeem_metabolism(seal["caseId"], ball, quantity)
            request.assert_not_called()

    def test_refuses_dose_resource_and_unknown_semantic_fields(self):
        allowance, seal, offers, ball, redeem, policy = fixture()
        for changed in ({**offers, "message":"accept"}, {**offers, "cumulativeGrant":vector(1)}, {**offers, "offers":[{**offers["offers"][0], "maxQuantity":3}]}):
            with self.assertRaises(JevyrContinuityError): verify_offers(changed, allowance, seal)

    def test_abort_is_exact_and_nonresumable(self):
        client = JevyrClient(); case = "case_3333333333333333"
        response = {"protocol":"jevyr.abort-accepted/1", "caseId":case, "runDigest":_digest("run"), "outcome":"INVALID", "resumable":False}
        with patch.object(client, "_json", return_value=response) as request:
            self.assertEqual(client.abort(case), response); request.assert_called_once_with(f"/v1/cases/{case}/abort", method="POST", body={})
        for invalid in ({**response, "resumable":True}, {**response, "verdict":"ACCEPT"}):
            with patch.object(client, "_json", return_value=invalid), self.assertRaises(JevyrContinuityError): client.abort(case)

if __name__ == "__main__": unittest.main()
