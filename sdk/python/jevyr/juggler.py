"""Finite scheduling vouchers; no semantic input or verdict authority."""
from __future__ import annotations

import hashlib
import re
from typing import Any, Literal, Mapping, TypedDict, cast

JUGGLER_VOUCHER_KINDS = ("Mass", "Refraction", "Polarity", "Fission", "Inertia")
JugglerKind = Literal["Mass", "Refraction", "Polarity", "Fission", "Inertia"]


class JugglerOffer(TypedDict):
    kind: JugglerKind
    token: str


class JugglerOffers(TypedDict):
    protocol: Literal["jevyr.juggler-offers/1"]
    caseId: str
    runDigest: str
    offers: list[JugglerOffer]


class JugglerSchedule(TypedDict):
    nurseryCallCeiling: int
    independentLineages: int
    challengeInterval: int
    saturationWindow: int
    mindOffset: int


class JugglerReceipt(TypedDict):
    protocol: Literal["jevyr.juggler-redemption/1"]
    caseId: str
    runDigest: str
    searchDigest: str
    kind: JugglerKind
    voucherDigest: str
    sequence: int
    before: JugglerSchedule
    after: JugglerSchedule
    verdictAuthority: Literal["none"]
    digest: str


SCHEDULE_FIELDS = {"nurseryCallCeiling", "independentLineages", "challengeInterval", "saturationWindow", "mindOffset"}


def _check(condition: bool, message: str) -> None:
    if not condition:
        from .client import JevyrContinuityError
        raise JevyrContinuityError(message)


def _exact(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    _check(isinstance(value, dict) and set(value) == fields, f"{label} must have exactly its closed protocol fields")
    return value


def assert_juggler_case_id(case_id: Any) -> None:
    if not isinstance(case_id, str) or re.fullmatch(r"case_[a-f0-9]{16}", case_id) is None:
        raise ValueError("Juggler requires a canonical CASE_ID")


def assert_juggler_token(token: Any) -> None:
    if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]", token) is None:
        raise ValueError("Voucher must be a canonical server-issued opaque token")


def assert_juggler_offers(raw: Any, seal: Mapping[str, Any]) -> JugglerOffers:
    value = _exact(raw, {"protocol", "caseId", "runDigest", "offers"}, "Juggler offers")
    _check(value["protocol"] == "jevyr.juggler-offers/1" and value["caseId"] == seal["caseId"] and value["runDigest"] == seal["runDigest"],
           "Juggler offers cross the authenticated Case/run boundary")
    _check(isinstance(value["offers"], list) and len(value["offers"]) <= 5, "Juggler offers exceed the finite voucher set")
    tokens: set[str] = set()
    kinds: set[str] = set()
    for item in value["offers"]:
        offer = _exact(item, {"kind", "token"}, "Juggler offer")
        _check(offer["kind"] in JUGGLER_VOUCHER_KINDS, "Unsupported Juggler voucher kind")
        try:
            assert_juggler_token(offer["token"])
        except ValueError:
            _check(False, "Malformed Juggler voucher token")
        _check(offer["token"] not in tokens and offer["kind"] not in kinds, "Duplicate Juggler token or kind")
        tokens.add(offer["token"])
        kinds.add(offer["kind"])
    return cast(JugglerOffers, value)


def _schedule(raw: Any) -> dict[str, int]:
    value = _exact(raw, SCHEDULE_FIELDS, "Juggler schedule")
    for key, number in value.items():
        _check(isinstance(number, int) and not isinstance(number, bool)
               and (0 if key in {"nurseryCallCeiling", "mindOffset"} else 1) <= number <= 9_007_199_254_740_991,
               "Juggler schedule contains an invalid bounded integer")
    _check(value["mindOffset"] < 256, "Juggler investigator offset is outside its finite domain")
    return value


def verify_juggler_receipt(raw: Any, seal: Mapping[str, Any], offered: JugglerOffer) -> JugglerReceipt:
    from .client import _digest
    value = _exact(raw, {"protocol", "caseId", "runDigest", "searchDigest", "kind", "voucherDigest", "sequence", "before", "after", "verdictAuthority", "digest"}, "Juggler receipt")
    _check(value["protocol"] == "jevyr.juggler-redemption/1" and value["verdictAuthority"] == "none", "Juggler receipt claimed unsupported authority")
    _check(all(value[key] == seal[key] for key in ("caseId", "runDigest", "searchDigest")), "Juggler receipt crosses the authenticated Case/run/search boundary")
    _check(value["kind"] == offered["kind"] and value["voucherDigest"] == "sha256:" + hashlib.sha256(offered["token"].encode("utf-8")).hexdigest(),
           "Juggler receipt does not bind the offered token and kind")
    _check(isinstance(value["sequence"], int) and not isinstance(value["sequence"], bool) and 1 <= value["sequence"] <= 5,
           "Juggler receipt sequence is outside its finite domain")
    before, after = _schedule(value["before"]), _schedule(value["after"])
    field = {"Mass": "nurseryCallCeiling", "Refraction": "mindOffset", "Polarity": "challengeInterval", "Fission": "independentLineages", "Inertia": "saturationWindow"}[offered["kind"]]
    _check(all(before[key] == after[key] for key in SCHEDULE_FIELDS if key != field), "Juggler receipt changed an unrelated schedule field")
    effect = (after[field] == before[field] + 1 or before[field] > 0 and after[field] == 0) if offered["kind"] == "Refraction" else after[field] == before[field] + (-1 if offered["kind"] == "Polarity" else 1)
    _check(effect, "Juggler receipt has no exact finite voucher effect")
    _check(isinstance(value["digest"], str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value["digest"]) is not None
           and value["digest"] == _digest({key: item for key, item in value.items() if key != "digest"}), "Juggler receipt digest mismatch")
    return cast(JugglerReceipt, value)
