from __future__ import annotations
import unittest
from unittest.mock import patch
from jevyr import JevyrClient, JevyrContinuityError
from jevyr.client import _digest
from test_client import intent_contract

def draft(revision=1):
    preview = intent_contract(); submission = {"protocol":"jevyr.case/1", "case":{"impulse":preview["originalImpulse"], "seed":"ab"*32, "control":"juggler"}}
    return {"protocol":"jevyr.airlock-draft/1", "draftId":"draft_" + "1" * 32, "revision":revision, "state":"DRAFT", "createdAt":"2026-09-05T00:00:00.000Z", "updatedAt":"2026-09-05T00:00:00.000Z", "submission":submission, "submissionDigest":_digest(submission), "preview":preview, "choices":{}, "choicesDigest":_digest({}), "startup":{"policyDigest":_digest({}), "genomeDigest":_digest("genome"), "genomeVersion":"jevyr.genome/1", "searchEnvelope":{}, "capabilities":[], "policy":{}, "subjectCapture":"on-seal"}}

class AirlockTests(unittest.TestCase):
    def test_choices_bind_exact_preview_and_reject_unsupported_permission(self):
        client = JevyrClient(); value = draft(2)
        choices = {"capabilityIds":["mind.rule.v1"], "preset":"wild", "sandbox":"observe_only", "resourceCeiling":{"maxMindInvocations":2}}
        value["choices"] = choices; value["choicesDigest"] = _digest(choices)
        value["startup"]["policy"] = {"policy":{"airlockChoicesDigest":value["choicesDigest"]}}
        value["startup"]["policyDigest"] = _digest(value["startup"]["policy"])
        with patch.object(client, "_json", return_value=value) as request:
            self.assertEqual(client.replace_draft(value["draftId"], 1, value["submission"], choices=choices), value)
            self.assertEqual(request.call_args.kwargs["body"]["choices"], choices)
        value["choicesDigest"] = _digest({})
        with patch.object(client, "_json", return_value=value), self.assertRaises(JevyrContinuityError): client.draft(value["draftId"])
        with patch.object(client, "_json") as request:
            with self.assertRaises(JevyrContinuityError): client.replace_draft(value["draftId"], 1, value["submission"], choices={"resourceCeiling":{"hostShell":1}})
            request.assert_not_called()
    def test_create_read_and_exact_revision_edit(self):
        client = JevyrClient(); value = draft()
        with patch.object(client, "_json", side_effect=[value, value, draft(2)]) as request:
            self.assertEqual(client.create_draft(value["submission"]), value)
            self.assertEqual(client.draft(value["draftId"]), value)
            self.assertEqual(client.replace_draft(value["draftId"], 1, value["submission"])["revision"], 2)
            request.assert_called_with(f'/v1/drafts/{value["draftId"]}', method="PATCH", body={"revision":1, "submission":value["submission"]})
    def test_refuses_unknown_draft_fields_and_crossed_reply(self):
        client = JevyrClient(); value = draft()
        with patch.object(client, "_json", return_value={**value, "continue":True}), self.assertRaises(JevyrContinuityError): client.draft(value["draftId"])
        with patch.object(client, "_json", return_value=value), self.assertRaises(JevyrContinuityError): client.draft("draft_" + "2" * 32)
        with patch.object(client, "_json") as request:
            with self.assertRaises(ValueError): client.replace_draft(value["draftId"], True, value["submission"])
            with self.assertRaises(ValueError): client.seal_draft(value["draftId"], 1, "accept")
            request.assert_not_called()

if __name__ == "__main__": unittest.main()
