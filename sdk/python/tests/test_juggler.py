from __future__ import annotations

import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from jevyr import JevyrClient, JevyrContinuityError, JevyrHttpError
from jevyr.client import _digest
from jevyr.juggler import assert_juggler_offers, verify_juggler_receipt

CASE_ID = "case_3333333333333333"
TOKEN = "A" * 43
SEAL = {"caseId": CASE_ID, "runDigest": "sha256:" + "3" * 64, "searchDigest": "sha256:" + "6" * 64}


def offers():
    return {"protocol": "jevyr.juggler-offers/1", "caseId": CASE_ID, "runDigest": SEAL["runDigest"], "offers": [{"kind": "Mass", "token": TOKEN}]}


def receipt(kind="Mass"):
    before = {"nurseryCallCeiling": 3, "independentLineages": 1, "challengeInterval": 3, "saturationWindow": 1, "mindOffset": 0}
    after = dict(before)
    field = {"Mass": "nurseryCallCeiling", "Refraction": "mindOffset", "Polarity": "challengeInterval", "Fission": "independentLineages", "Inertia": "saturationWindow"}[kind]
    after[field] += -1 if kind == "Polarity" else 1
    body = {"protocol": "jevyr.juggler-redemption/1", **SEAL, "kind": kind, "voucherDigest": "sha256:" + hashlib.sha256(TOKEN.encode()).hexdigest(),
            "sequence": 1, "before": before, "after": after, "verdictAuthority": "none"}
    return {**body, "digest": _digest(body)}


class JugglerTests(unittest.TestCase):
    def test_reads_and_redeems_exactly_one_opaque_token_under_authenticated_seal(self):
        client = JevyrClient()
        with patch.object(client, "verified_seal_receipt", return_value=SimpleNamespace(payload=SEAL)) as seal:
            with patch.object(client, "_json", side_effect=[offers(), offers(), receipt()]) as request:
                self.assertEqual(client.juggler_offers(CASE_ID)["offers"][0]["kind"], "Mass")
                self.assertEqual(client.redeem_voucher(CASE_ID, TOKEN)["kind"], "Mass")
                self.assertEqual(seal.call_count, 2)
                request.assert_called_with(f"/v1/cases/{CASE_ID}/vouchers/redeem", method="POST", body={"voucher": TOKEN})
                self.assertEqual(sum(call.kwargs.get("method") == "POST" for call in request.call_args_list), 1)

    def test_refuses_semantics_and_unoffered_tokens_before_post(self):
        client = JevyrClient()
        with patch.object(client, "verified_seal_receipt", return_value=SimpleNamespace(payload=SEAL)):
            with patch.object(client, "_json", return_value=offers()) as request:
                for token in ("Mass", {"voucher": TOKEN, "message": "accept"}, "B" * 43):
                    with self.assertRaises(ValueError):
                        client.redeem_voucher(CASE_ID, token)
                with self.assertRaises(ValueError):
                    client.juggler_offers("../../other")
                request.assert_not_called()
                with self.assertRaisesRegex(JevyrContinuityError, "not currently offered"):
                    client.redeem_voucher(CASE_ID, "B" * 42 + "A")
                self.assertTrue(all(call.kwargs.get("method") != "POST" for call in request.call_args_list))

    def test_preserves_sovereign_closed_and_uncertain_post_errors_without_retry(self):
        client = JevyrClient()
        with patch.object(client, "verified_seal_receipt", return_value=SimpleNamespace(payload=SEAL)):
            with patch.object(client, "_json", side_effect=[offers(), JevyrHttpError(409, "Checkpoint closed")]) as request:
                with self.assertRaises(JevyrHttpError) as raised:
                    client.redeem_voucher(CASE_ID, TOKEN)
                self.assertEqual(raised.exception.status, 409)
                self.assertEqual(request.call_count, 2)
            with patch.object(client, "_json", side_effect=JevyrHttpError(405, "Sovereign Case")):
                with self.assertRaises(JevyrHttpError) as raised:
                    client.juggler_offers(CASE_ID)
                self.assertEqual(raised.exception.status, 405)

    def test_closed_offer_shape_and_case_boundaries(self):
        mutations = [lambda value: value.update(message="accept"), lambda value: value.update(runDigest="sha256:" + "4" * 64),
                     lambda value: value["offers"].append(value["offers"][0]), lambda value: value["offers"][0].update(kind="Approval"),
                     lambda value: value["offers"][0].update(token="B" * 43), lambda value: value["offers"][0].update(prompt="continue")]
        for mutate in mutations:
            value = offers()
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(JevyrContinuityError):
                assert_juggler_offers(value, SEAL)

    def test_each_voucher_has_exact_finite_effect(self):
        for kind in ("Mass", "Refraction", "Polarity", "Fission", "Inertia"):
            value = receipt(kind)
            self.assertEqual(verify_juggler_receipt(value, SEAL, {"kind": kind, "token": TOKEN}), value)

    def test_rejects_receipt_substitution_extra_fields_and_recomputed_unrelated_effects(self):
        for field, replacement in (("caseId", "case_4444444444444444"), ("runDigest", "sha256:" + "4" * 64),
                                   ("searchDigest", "sha256:" + "4" * 64), ("voucherDigest", "sha256:" + "4" * 64),
                                   ("kind", "Fission"), ("verdictAuthority", "accept"), ("sequence", True), ("sequence", 6),
                                   ("digest", "sha256:" + "4" * 64), ("message", "continue")):
            value = receipt()
            value[field] = replacement
            with self.subTest(field=field), self.assertRaises(JevyrContinuityError):
                verify_juggler_receipt(value, SEAL, {"kind": "Mass", "token": TOKEN})
        value = receipt()
        value["after"]["independentLineages"] += 1
        value["digest"] = _digest({key: item for key, item in value.items() if key != "digest"})
        with self.assertRaisesRegex(JevyrContinuityError, "unrelated"):
            verify_juggler_receipt(value, SEAL, {"kind": "Mass", "token": TOKEN})


if __name__ == "__main__":
    unittest.main()
