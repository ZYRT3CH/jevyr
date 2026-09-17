from __future__ import annotations

import codecs
from dataclasses import dataclass
from datetime import datetime
import base64
import binascii
import hashlib
import json
import math
import re
import time
from typing import Any, Callable, Generic, Iterator, Literal, Mapping, NotRequired, Sequence, TypeVar, TypedDict, TYPE_CHECKING, cast as typing_cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from .juggler import JugglerOffers, JugglerReceipt, assert_juggler_case_id, assert_juggler_token, assert_juggler_offers, verify_juggler_receipt
from .metabolism import allowance_from_policy, assert_ball_id, assert_quantity, verify_offers, verify_redemption
from .airlock import assert_draft_id, assert_revision, validate_draft

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


Json = dict[str, Any]
if TYPE_CHECKING:
    from .run_attestations import VerifiedRunAttestations
LifecycleStage = Literal["cast", "snapshot", "seal", "self_scan", "interpret", "diverge", "recombine", "embody", "challenge", "assay", "reflex", "crystallize", "sign", "memory_tribunal", "terminate"]
EventKind = Literal["stage.status", "claim.published", "action.status", "evidence.observed", "candidate.status", "assay.status", "reflex.completed", "memory.influence", "search.status", "kernel.status"]
Feasibility = Literal["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"]


def _unambiguous_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise JevyrContinuityError(
                f"Remote JSON contains duplicate object key {key!r}"
            )
        value[key] = item
    return value


def _loads_unambiguous(value: str | bytes | bytearray) -> Any:
    """Decode fatal UTF-8 JSON without accepting last-member-wins duplicate keys."""
    if not isinstance(value, str):
        try:
            value = bytes(value).decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise JevyrContinuityError("Remote JSON is not valid UTF-8") from error
    return json.loads(value, object_pairs_hook=_unambiguous_object)


class SealReceipt(TypedDict):
    protocol: Literal["jevyr.seal/1"]
    caseId: str
    submissionDigest: str
    subjectMaterialCaptureDigest: str
    caseDigest: str
    runDigest: str
    sealedAt: str
    policyVersion: str
    policyDigest: str
    genomeVersion: str
    genomeDigest: str
    searchDigest: str
    intentContractDigest: str


class SealedCase(TypedDict):
    protocol: Literal["jevyr.case/1"]
    caseId: str
    submissionDigest: str
    subjectMaterialCaptureDigest: str
    caseDigest: str
    runDigest: str
    sealedAt: str
    policyVersion: str
    policyDigest: str
    genomeVersion: str
    genomeDigest: str
    searchEnvelope: Json
    intentContractDigest: str
    intentContract: Json
    intent: Json
    subjects: list[Json]


class IntentContract(TypedDict):
    protocol: Literal["jevyr.intent-contract/1"]
    compilerVersion: Literal["jevyr.intent-compiler/1"]
    originalImpulse: str
    originalImpulseDigest: str
    goal: Json
    subjectIds: list[str]
    explicitConstraints: list[Json]
    requestedAssays: list[str]
    successConditions: list[Json]
    failureConditions: list[Json]
    ambiguities: list[Json]
    alternativeInterpretations: list[Json]
    criticalObligations: list[Json]
    digest: str


class CaseEvent(TypedDict):
    protocol: Literal["jevyr.event/1"]
    caseDigest: str
    runDigest: str
    sequence: int
    priorDigest: str | None
    eventDigest: str
    observedAt: str
    stage: LifecycleStage
    kind: EventKind
    actor: PublicActor
    payload: Json


class PublicActor(TypedDict):
    id: str
    kind: Literal["kernel", "mind", "tool", "peer", "forge", "archivist"]
    instance: NotRequired[str]


class LiveCaseStatus(TypedDict):
    protocol: Literal["jevyr.status/1"]
    caseDigest: str
    runDigest: str
    lifecycle: Literal["queued", "running", "crystallized", "terminated", "invalid"]
    stage: LifecycleStage
    stageStatus: Literal["entered", "working", "completed", "failed", "skipped"]
    lastSequence: int
    headDigest: str | None
    updatedAt: str


class TerminalReceipt(TypedDict):
    """Write-once commitment to the complete terminal public ledger."""

    protocol: Literal["jevyr.terminal/1"]
    caseId: str
    caseDigest: str
    runDigest: str
    lifecycle: Literal["terminated", "invalid"]
    stage: LifecycleStage
    stageStatus: Literal["entered", "working", "completed", "failed", "skipped"]
    lastSequence: int
    eventHeadDigest: str | None
    recordDigest: str
    artifactIndexDigest: str
    closedAt: str


class LiveEventBatch(TypedDict):
    protocol: Literal["jevyr.live/1"]
    caseDigest: str
    runDigest: str
    afterSequence: int
    throughSequence: int
    headDigest: str | None
    caughtUp: bool
    events: list[CaseEvent]
    polledAt: str


class VerdictBasis(TypedDict):
    code: str
    summary: str
    evidenceIds: list[str]
    obligationIds: NotRequired[list[str]]
    candidateIds: NotRequired[list[str]]


class JevyrVerdict(TypedDict):
    policyVersion: str
    intentContractDigest: str
    evidenceDigest: str
    integrity: Literal["VALID", "INVALID"]
    creation: Literal["CONCEIVED", "NO_SURVIVOR", "FAILED"]
    embodiment: Literal["BUILT", "NOT_BUILT", "FAILED"]
    judgment: Literal["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"]
    selectedCandidateId: NotRequired[str]
    feasibilityByCandidate: dict[str, Feasibility]
    basis: list[VerdictBasis]


class ReflexFinding(TypedDict):
    code: str
    summary: str
    evidenceIds: list[str]


class ReflexPayload(TypedDict):
    loop: Literal[1, 2]
    reviewedEvidenceDigest: str
    intentContractDigest: str
    challengedNodeIds: list[str]
    materialFindings: list[ReflexFinding]
    decision: Literal["confirm", "revise", "repeat_once"]
    audits: NotRequired[list[Json]]


class MemoryInfluencePayload(TypedDict):
    memoryDigest: str
    influence: Literal["seeded_hypothesis", "strategy_selected", "calibration_applied"]
    summary: str
    weight: float


class SignedRecord(TypedDict):
    protocol: Literal["jevyr.record/1"]
    caseDigest: str
    runDigest: str
    policyDigest: str
    genomeDigest: str
    searchDigest: str
    intentContractDigest: str
    eventHeadDigest: str
    verdict: JevyrVerdict
    reflex: ReflexPayload
    memoryInfluences: list[MemoryInfluencePayload]
    crystallizedAt: str


class ArtifactMeta(TypedDict):
    protocol: Literal["jevyr.artifact/1"]
    id: str
    caseId: str
    name: str
    mediaType: str
    size: int
    digest: str
    createdAt: str


class ArtifactList(TypedDict):
    protocol: Literal["jevyr.artifacts/1"]
    caseId: str
    artifacts: list[ArtifactMeta]


class DescriptorArtifact(TypedDict):
    protocol: Literal["jevyr.descriptor-artifact/1"]
    kind: Literal["policy", "genome", "search"]
    digest: str
    descriptor: Any


class CasePolicyDescriptor(TypedDict):
    protocol: Literal["jevyr.case-policy-descriptor/1"]
    caseId: str
    caseDigest: str
    runDigest: str
    policyDigest: str
    artifact: DescriptorArtifact


Payload = TypeVar("Payload")
_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_ARTIFACT_ID = re.compile(r"^artifact_[a-f0-9]{24}$")
_ARTIFACT_MEDIA_TYPE = re.compile(
    r"^[a-z0-9][a-z0-9!#$&^_.+\-]*/[a-z0-9][a-z0-9!#$&^_.+\-]*(?:;\s*charset=[a-z0-9._\-]+)?$",
    re.IGNORECASE,
)
_CANONICAL_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_STAGE_SEQUENCE = ("cast", "snapshot", "seal", "self_scan", "interpret", "diverge", "recombine", "embody", "challenge", "assay", "reflex", "crystallize", "sign", "memory_tribunal", "terminate")
_STAGES = frozenset(_STAGE_SEQUENCE)
_STAGE_INDEX = {stage: index for index, stage in enumerate(_STAGE_SEQUENCE)}
_KINDS = frozenset(("stage.status", "claim.published", "action.status", "evidence.observed", "candidate.status", "assay.status", "reflex.completed", "memory.influence", "search.status", "kernel.status"))
_ACTORS = frozenset(("kernel", "mind", "tool", "peer", "forge", "archivist"))
_LIFECYCLES = frozenset(("queued", "running", "crystallized", "terminated", "invalid"))
_STAGE_STATUSES = frozenset(("entered", "working", "completed", "failed", "skipped"))
_EVENT_RESOURCE_NAMES = frozenset((
    "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
    "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
    "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
))
_EVENT_EVIDENCE_TYPES = frozenset((
    "subject_snapshot", "tool_observation", "sandbox_execution", "artifact",
    "model_report", "peer_report", "memory_hint",
))
_EVENT_ID_MAX = 256
_EVENT_SUMMARY_MAX = 32_768
_EVENT_REFERENCE_MAX = 256
_FORBIDDEN_TRACE_KEYS = frozenset(("chainofthought", "chain_of_thought", "reasoningtrace", "reasoning_trace", "scratchpad", "hiddenstate", "hidden_state", "internalthoughts", "internal_thoughts"))
SEAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.seal+json"
RECORD_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.record+json"
TERMINAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.terminal+json"
_PAYLOAD_TYPES = (
    SEAL_DSSE_PAYLOAD_TYPE,
    RECORD_DSSE_PAYLOAD_TYPE,
    TERMINAL_DSSE_PAYLOAD_TYPE,
)
_DEFAULT_RECONNECT_DELAY = 1.5
_DEFAULT_MAX_RECONNECT_DELAY = 15.0
_MAX_JSON_ENDPOINT_BYTES = 32 * 1_048_576
_MAX_JSON_ERROR_BYTES = 1_048_576
_MAX_ARTIFACT_ENDPOINT_BYTES = 512 * 1_048_576
_MAX_SSE_EVENT_CHARACTERS = 8 * 1_048_576
_MAX_SSE_LINES = 65_536


class JevyrError(RuntimeError):
    """Base Jevyr transport error."""


class JevyrHttpError(JevyrError):
    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class JevyrContinuityError(JevyrError):
    """Raised when public protocol shape, content, or hash continuity is invalid."""


@dataclass(frozen=True)
class LiveFrame:
    event: CaseEvent
    cursor: int
    head_digest: str
    continuity: str
    transport: str
    verification_scope: Literal["event-hash-chain"] = "event-hash-chain"

    @property
    def segment_digest(self) -> str:
        """Deprecated alias for head_digest."""
        return self.head_digest


@dataclass(frozen=True)
class VerifiedArtifact:
    """Artifact bytes accepted only after index, header, length, and hash checks."""

    meta: ArtifactMeta
    data: bytes
    verification: Literal["sha256"] = "sha256"


@dataclass(frozen=True)
class VerifiedDssePayload(Generic[Payload]):
    """Payload authenticated by a trusted Ed25519 key over DSSE PAE bytes."""

    payload: Payload
    envelope: Json
    key_id: str
    payload_type: str
    verification: str = "dsse-ed25519"


@dataclass(frozen=True)
class AuthenticatedRecord(VerifiedDssePayload[SignedRecord]):
    """Signed, Seal-bound Record; persisted evidence has not been replayed."""

    verification_scope: Literal["dsse-signature+seal-provenance"] = (
        "dsse-signature+seal-provenance"
    )
    persisted_evidence: Literal["not-replayed"] = "not-replayed"


@dataclass(frozen=True)
class AuthenticatedTerminalReceipt(VerifiedDssePayload[TerminalReceipt]):
    """Terminal closure authenticated independently from its endpoint bytes."""


@dataclass(frozen=True, kw_only=True)
class AuthenticatedTerminalRecord(AuthenticatedRecord):
    """Authenticated Record bound to a separately signed terminal ledger head."""

    terminal: AuthenticatedTerminalReceipt
    trace_verification: Literal["event-hash-chain+signed-terminal-head"] = (
        "event-hash-chain+signed-terminal-head"
    )


@dataclass(frozen=True)
class VerifiedCasePolicyDescriptor:
    binding: CasePolicyDescriptor
    record: AuthenticatedRecord
    verification: Literal["sha256+dsse-record-binding"] = "sha256+dsse-record-binding"


def _number(value: float) -> str:
    if not math.isfinite(value):
        raise TypeError("Canonical JSON does not permit non-finite numbers")
    if value == 0:
        return "0"
    negative = value < 0
    absolute = -value if negative else value
    raw = repr(absolute).lower()
    if "e" in raw:
        mantissa, exponent_text = raw.split("e", 1)
        exponent = int(exponent_text)
        digits = mantissa.replace(".", "").rstrip("0")
        decimal = (mantissa.find(".") if "." in mantissa else len(mantissa)) + exponent
        if 1e-6 <= absolute < 1e21:
            if decimal <= 0:
                rendered = "0." + ("0" * -decimal) + digits
            elif decimal >= len(digits):
                rendered = digits + ("0" * (decimal - len(digits)))
            else:
                rendered = digits[:decimal] + "." + digits[decimal:]
        else:
            coefficient = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
            scientific_exponent = decimal - 1
            sign = "+" if scientific_exponent >= 0 else ""
            rendered = f"{coefficient}e{sign}{scientific_exponent}"
    else:
        rendered = raw[:-2] if raw.endswith(".0") else raw
    return ("-" if negative else "") + rendered


def _serialize(value: Any, seen: set[int]) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, (list, tuple)):
        identity = id(value)
        if identity in seen:
            raise TypeError("Canonical JSON does not permit cyclic values")
        seen.add(identity)
        try:
            return "[" + ",".join(_serialize(item, seen) for item in value) + "]"
        finally:
            seen.remove(identity)
    if isinstance(value, Mapping):
        identity = id(value)
        if identity in seen:
            raise TypeError("Canonical JSON does not permit cyclic values")
        if any(not isinstance(key, str) for key in value):
            raise TypeError("Canonical JSON object keys must be strings")
        seen.add(identity)
        try:
            keys = sorted(value, key=lambda item: item.encode("utf-16-be", "surrogatepass"))
            return "{" + ",".join(
                f"{json.dumps(key, ensure_ascii=False)}:{_serialize(value[key], seen)}" for key in keys
            ) + "}"
        finally:
            seen.remove(identity)
    raise TypeError(f"Canonical JSON cannot encode {type(value).__name__}")


def _canonical(value: Any) -> bytes:
    return _serialize(value, set()).encode("utf-8")


def _digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _exact_keys(value: Mapping[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise JevyrContinuityError(f"{label} fields do not match its versioned contract")


def _keys_with_optional(value: Mapping[str, Any], required: set[str], allowed: set[str], label: str) -> None:
    fields = set(value)
    if not required.issubset(fields) or not fields.issubset(allowed):
        raise JevyrContinuityError(f"{label} fields do not match its versioned contract")


def _non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise JevyrContinuityError(f"{label} must be a non-empty string")
    return value


def _string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise JevyrContinuityError(f"{label} must be an array of non-empty strings")
    return value


def _basename_only(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1] or "artifact"
    sanitized = re.sub(r'[\x00-\x1f\x7f"]', "_", base)
    return sanitized or "artifact"


def _utf16_length(value: str) -> int:
    """Match JavaScript string-length semantics used by the sibling SDK."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _valid_canonical_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not _CANONICAL_TIMESTAMP.fullmatch(value):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.utcoffset() is not None and parsed.utcoffset().total_seconds() == 0


def _non_negative_integer(value: Any, label: str, maximum: int = _MAX_SAFE_INTEGER) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > maximum
    ):
        raise ValueError(
            f"{label} must be a non-negative safe integer no greater than {maximum}"
        )
    return value


def _bounded_seconds(value: Any, label: str, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or value < 0
        or value > maximum
    ):
        raise ValueError(f"{label} must be a finite number between 0 and {maximum}")
    return float(value)


def _reconnect_backoff(base: float, ceiling: float, failures: int) -> float:
    if base == 0:
        return 0.0
    exponent = min(16, max(0, failures - 1))
    return min(ceiling, base * (2**exponent))


def _retry_bounds(reconnect_delay: Any, max_reconnect_delay: Any) -> tuple[float, float]:
    base = _bounded_seconds(reconnect_delay, "reconnect_delay", 60.0)
    ceiling = _bounded_seconds(
        max_reconnect_delay,
        "max_reconnect_delay",
        300.0,
    )
    if ceiling < base:
        raise ValueError("max_reconnect_delay cannot be less than reconnect_delay")
    return base, ceiling


def _retryable_transport_error(error: BaseException) -> bool:
    if isinstance(error, JevyrContinuityError):
        return False
    if isinstance(error, JevyrHttpError):
        return error.status in {408, 429} or error.status >= 500
    if isinstance(error, HTTPError):
        return error.code in {408, 429} or error.code >= 500
    return isinstance(error, (JevyrError, URLError, OSError, TimeoutError))


def assert_artifact_meta(
    value: Any,
    *,
    expected_case_id: str | None = None,
    expected_artifact_id: str | None = None,
) -> ArtifactMeta:
    """Strictly validate one content-addressed artifact descriptor."""
    if not isinstance(value, dict):
        raise JevyrContinuityError("Artifact metadata is not an object")
    _exact_keys(
        value,
        {"protocol", "id", "caseId", "name", "mediaType", "size", "digest", "createdAt"},
        "Artifact metadata",
    )
    artifact_id = value.get("id")
    case_id = value.get("caseId")
    name = value.get("name")
    media_type = value.get("mediaType")
    size = value.get("size")
    digest = value.get("digest")
    if (
        value.get("protocol") != "jevyr.artifact/1"
        or not isinstance(artifact_id, str)
        or not _ARTIFACT_ID.fullmatch(artifact_id)
        or not isinstance(case_id, str)
        or not case_id
        or not isinstance(name, str)
        or not 1 <= _utf16_length(name) <= 255
        or _basename_only(name) != name
        or not isinstance(media_type, str)
        or len(media_type) > 200
        or not _ARTIFACT_MEDIA_TYPE.fullmatch(media_type)
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 0 <= size <= _MAX_SAFE_INTEGER
        or not isinstance(digest, str)
        or not _DIGEST.fullmatch(digest)
        or artifact_id != f"artifact_{digest[len('sha256:'):len('sha256:') + 24]}"
        or not _valid_canonical_timestamp(value.get("createdAt"))
    ):
        raise JevyrContinuityError("Artifact contains invalid metadata")
    if expected_case_id is not None and case_id != expected_case_id:
        raise JevyrContinuityError("Artifact metadata crossed a Case boundary")
    if expected_artifact_id is not None and artifact_id != expected_artifact_id:
        raise JevyrContinuityError("Artifact metadata does not match the requested artifact")
    return typing_cast(ArtifactMeta, value)


def assert_artifact_list(value: Any, expected_case_id: str) -> ArtifactList:
    """Strictly validate a complete Case artifact-index response."""
    if not isinstance(value, dict):
        raise JevyrContinuityError("Artifact endpoint returned a non-object index")
    _exact_keys(value, {"protocol", "caseId", "artifacts"}, "Artifact index")
    entries = value.get("artifacts")
    if (
        value.get("protocol") != "jevyr.artifacts/1"
        or value.get("caseId") != expected_case_id
        or not isinstance(entries, list)
    ):
        raise JevyrContinuityError("Artifact endpoint returned an invalid Case index")
    seen: set[str] = set()
    artifacts: list[ArtifactMeta] = []
    for entry in entries:
        artifact = assert_artifact_meta(entry, expected_case_id=expected_case_id)
        if artifact["id"] in seen:
            raise JevyrContinuityError(f"Artifact index repeats {artifact['id']}")
        seen.add(artifact["id"])
        artifacts.append(artifact)
    return {"protocol": "jevyr.artifacts/1", "caseId": expected_case_id, "artifacts": artifacts}


def assert_descriptor_artifact(
    value: Any,
    *,
    expected_kind: Literal["policy", "genome", "search"] | None = None,
    expected_digest: str | None = None,
) -> DescriptorArtifact:
    """Rehash and strictly validate one persisted provenance descriptor."""
    if not isinstance(value, dict):
        raise JevyrContinuityError("Descriptor artifact is not an object")
    _exact_keys(value, {"protocol", "kind", "digest", "descriptor"}, "Descriptor artifact")
    kind = value.get("kind")
    digest = value.get("digest")
    if (
        value.get("protocol") != "jevyr.descriptor-artifact/1"
        or kind not in {"policy", "genome", "search"}
        or not isinstance(digest, str)
        or not _DIGEST.fullmatch(digest)
    ):
        raise JevyrContinuityError("Descriptor artifact has invalid identity metadata")
    try:
        computed = _digest(value.get("descriptor"))
    except (TypeError, ValueError) as error:
        raise JevyrContinuityError("Descriptor artifact does not contain canonical JSON data") from error
    if computed != digest:
        raise JevyrContinuityError("Descriptor artifact bytes do not match its SHA-256 digest")
    if expected_kind is not None and kind != expected_kind:
        raise JevyrContinuityError("Descriptor artifact has the wrong provenance kind")
    if expected_digest is not None and digest != expected_digest:
        raise JevyrContinuityError("Descriptor artifact digest does not match the authenticated reference")
    if kind == "policy":
        descriptor = value.get("descriptor")
        if not isinstance(descriptor, dict):
            raise JevyrContinuityError("Policy descriptor payload is not an object")
        _exact_keys(descriptor, {"protocol", "version", "policy", "subjectSnapshots"}, "Policy descriptor payload")
        if (
            descriptor.get("protocol") != "jevyr.policy-descriptor/1"
            or not isinstance(descriptor.get("version"), str)
            or not descriptor["version"]
            or not isinstance(descriptor.get("policy"), dict)
            or not isinstance(descriptor.get("subjectSnapshots"), dict)
        ):
            raise JevyrContinuityError("Policy descriptor payload has an invalid canonical envelope")
    return typing_cast(DescriptorArtifact, value)


def assert_case_policy_descriptor(value: Any, expected_case_id: str) -> CasePolicyDescriptor:
    """Validate the daemon's exact Case-scoped policy descriptor binding."""
    if not isinstance(value, dict):
        raise JevyrContinuityError("Policy descriptor endpoint returned a non-object")
    _exact_keys(
        value,
        {"protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "artifact"},
        "Case policy descriptor",
    )
    if (
        value.get("protocol") != "jevyr.case-policy-descriptor/1"
        or value.get("caseId") != expected_case_id
        or any(
            not isinstance(value.get(field), str) or not _DIGEST.fullmatch(value[field])
            for field in ("caseDigest", "runDigest", "policyDigest")
        )
    ):
        raise JevyrContinuityError("Policy descriptor endpoint crossed or malformed its Case binding")
    artifact = assert_descriptor_artifact(
        value.get("artifact"),
        expected_kind="policy",
        expected_digest=typing_cast(str, value["policyDigest"]),
    )
    return {
        "protocol": "jevyr.case-policy-descriptor/1",
        "caseId": expected_case_id,
        "caseDigest": typing_cast(str, value["caseDigest"]),
        "runDigest": typing_cast(str, value["runDigest"]),
        "policyDigest": typing_cast(str, value["policyDigest"]),
        "artifact": artifact,
    }


def assert_policy_descriptor_record_binding(
    binding: CasePolicyDescriptor,
    record_value: Any,
) -> CasePolicyDescriptor:
    """Bind content-verified policy bytes to a separately authenticated Record payload."""
    record = _assert_record(record_value)
    if (
        binding["caseDigest"] != record["caseDigest"]
        or binding["runDigest"] != record["runDigest"]
        or binding["policyDigest"] != record["policyDigest"]
        or binding["artifact"]["digest"] != record["policyDigest"]
    ):
        raise JevyrContinuityError("Policy descriptor does not match the authenticated Record identity")
    return binding


def _single_response_header(response: Any, name: str) -> Any:
    headers = getattr(response, "headers", None)
    if headers is not None:
        get_all = getattr(headers, "get_all", None)
        if callable(get_all):
            values = get_all(name)
            if values is not None:
                if len(values) != 1:
                    raise JevyrContinuityError(f"Response repeats the {name} header")
                return values[0]
        get = getattr(headers, "get", None)
        if callable(get):
            return get(name)
    getheader = getattr(response, "getheader", None)
    return getheader(name) if callable(getheader) else None


def _read_bounded_response(response: Any, maximum_bytes: int, label: str) -> bytes:
    declared = _single_response_header(response, "content-length")
    if declared is not None:
        if not isinstance(declared, str) or re.fullmatch(r"(?:0|[1-9][0-9]*)", declared) is None:
            raise JevyrContinuityError(f"{label} has a malformed content-length")
        if int(declared) > maximum_bytes:
            raise JevyrContinuityError(f"{label} exceeds the {maximum_bytes}-byte limit")
    read_chunk = getattr(response, "read", None)
    if not callable(read_chunk):
        read_chunk = getattr(response, "read1", None)
    if not callable(read_chunk):
        raise JevyrContinuityError(f"{label} is not readable")
    chunks: list[bytes] = []
    total = 0
    while True:
        raw = read_chunk(65_536)
        if raw is None:
            raw = b""
        if not isinstance(raw, (bytes, bytearray, memoryview)):
            raise JevyrContinuityError(f"{label} did not yield bytes")
        chunk = bytes(raw)
        if not chunk:
            break
        total += len(chunk)
        if total > maximum_bytes:
            raise JevyrContinuityError(f"{label} exceeds the {maximum_bytes}-byte limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _base64(value: Any, label: str) -> bytes:
    if not isinstance(value, str) or len(value) % 4:
        raise JevyrContinuityError(f"{label} is not canonical base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise JevyrContinuityError(f"{label} is not valid base64") from error
    if base64.b64encode(decoded).decode("ascii") != value:
        raise JevyrContinuityError(f"{label} is not canonical base64")
    return decoded


def _dsse_pae(payload_type: str, payload: bytes) -> bytes:
    encoded_type = payload_type.encode("utf-8")
    return b"".join((
        b"DSSEv1 ", str(len(encoded_type)).encode("ascii"), b" ", encoded_type,
        b" ", str(len(payload)).encode("ascii"), b" ", payload,
    ))


def _assert_envelope(value: Any) -> Json:
    if not isinstance(value, dict):
        raise JevyrContinuityError("DSSE endpoint returned a non-object envelope")
    _exact_keys(value, {"payloadType", "payload", "signatures"}, "DSSE envelope")
    if value.get("payloadType") not in _PAYLOAD_TYPES:
        raise JevyrContinuityError("DSSE envelope uses an unsupported payload type")
    _base64(value.get("payload"), "DSSE payload")
    signatures = value.get("signatures")
    if not isinstance(signatures, list) or not signatures:
        raise JevyrContinuityError("DSSE envelope has no signatures")
    for entry in signatures:
        if not isinstance(entry, dict):
            raise JevyrContinuityError("DSSE signature entry is not an object")
        _exact_keys(entry, {"keyid", "sig"}, "DSSE signature")
        if not isinstance(entry.get("keyid"), str) or not _DIGEST.fullmatch(entry["keyid"]):
            raise JevyrContinuityError("DSSE signature has an invalid key id")
        if len(_base64(entry.get("sig"), "DSSE signature")) != 64:
            raise JevyrContinuityError("Ed25519 signature must contain 64 bytes")
    return value


def _public_key(raw: Mapping[str, Any]) -> tuple[Ed25519PublicKey, bytes]:
    pem = raw.get("publicKeyPem")
    if not isinstance(pem, str) or "PRIVATE KEY" in pem:
        raise JevyrContinuityError("Trust bundle contains invalid or private key material")
    try:
        key = serialization.load_pem_public_key(pem.encode("ascii"))
    except (ValueError, TypeError, UnicodeEncodeError) as error:
        raise JevyrContinuityError("Trust key is not a valid public PEM document") from error
    if not isinstance(key, Ed25519PublicKey):
        raise JevyrContinuityError("Trust key is not an Ed25519 public key")
    spki = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return key, spki


def _assert_trust_bundle(value: Any) -> Json:
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.trust-bundle/1":
        raise JevyrContinuityError("Trust endpoint did not return jevyr.trust-bundle/1")
    _exact_keys(value, {"protocol", "keys"}, "PublicTrustBundle")
    keys = value.get("keys")
    if not isinstance(keys, list) or not keys:
        raise JevyrContinuityError("Trust bundle contains no public keys")
    seen: set[str] = set()
    for raw in keys:
        if not isinstance(raw, dict):
            raise JevyrContinuityError("Trust key is not an object")
        _exact_keys(raw, {"keyId", "algorithm", "publicKeyPem", "payloadTypes"}, "PublicTrustKey")
        key_id = raw.get("keyId")
        if not isinstance(key_id, str) or not _DIGEST.fullmatch(key_id) or raw.get("algorithm") != "Ed25519":
            raise JevyrContinuityError("Trust key metadata is invalid")
        if raw.get("payloadTypes") != list(_PAYLOAD_TYPES):
            raise JevyrContinuityError("Trust key payloadTypes do not match the Jevyr signing contract")
        if key_id in seen:
            raise JevyrContinuityError(f"Trust bundle repeats key id {key_id}")
        seen.add(key_id)
        _key, spki = _public_key(raw)
        if "sha256:" + hashlib.sha256(spki).hexdigest() != key_id:
            raise JevyrContinuityError(f"Trust key {key_id} does not match its public key bytes")
    return value


def _assert_seal_receipt(value: Any) -> SealReceipt:
    required = {"protocol", "caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "searchDigest", "intentContractDigest"}
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.seal/1":
        raise JevyrContinuityError("Endpoint did not return a canonical SealReceipt")
    _exact_keys(value, required, "SealReceipt")
    digest_fields = ("submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest")
    if not all(isinstance(value.get(name), str) and _DIGEST.fullmatch(value[name]) for name in digest_fields):
        raise JevyrContinuityError("SealReceipt contains invalid identity fields")
    run_digest = typing_cast(str, value["runDigest"])
    if value.get("caseId") != f"case_{run_digest[len('sha256:'):len('sha256:') + 16]}":
        raise JevyrContinuityError("SealReceipt caseId is not derived from runDigest")
    if not _valid_canonical_timestamp(value.get("sealedAt")):
        raise JevyrContinuityError("SealReceipt sealedAt must be a canonical UTC timestamp with millisecond precision")
    _non_empty_string(value.get("policyVersion"), "SealReceipt policyVersion")
    _non_empty_string(value.get("genomeVersion"), "SealReceipt genomeVersion")
    return typing_cast(SealReceipt, value)


def assert_intent_contract_payload(value: Any) -> IntentContract:
    """Validate the complete canonical replay contract, including both content digests."""
    required = {
        "protocol", "compilerVersion", "originalImpulse", "originalImpulseDigest", "goal",
        "subjectIds", "explicitConstraints", "requestedAssays", "successConditions",
        "failureConditions", "ambiguities", "alternativeInterpretations",
        "criticalObligations", "digest",
    }
    if not isinstance(value, dict):
        raise JevyrContinuityError("IntentContract must be an object")
    _exact_keys(value, required, "IntentContract")
    if value.get("protocol") != "jevyr.intent-contract/1":
        raise JevyrContinuityError("IntentContract uses an unsupported protocol")
    if value.get("compilerVersion") != "jevyr.intent-compiler/1":
        raise JevyrContinuityError("IntentContract uses an unsupported compiler version")

    impulse = _non_empty_string(value.get("originalImpulse"), "IntentContract.originalImpulse")
    impulse_digest = value.get("originalImpulseDigest")
    if not isinstance(impulse_digest, str) or not _DIGEST.fullmatch(impulse_digest):
        raise JevyrContinuityError("IntentContract.originalImpulseDigest must be a canonical SHA-256 digest")
    expected_impulse_digest = "sha256:" + hashlib.sha256(impulse.encode("utf-8")).hexdigest()
    if impulse_digest != expected_impulse_digest:
        raise JevyrContinuityError("IntentContract.originalImpulseDigest does not bind the exact impulse bytes")

    goal = value.get("goal")
    if not isinstance(goal, dict):
        raise JevyrContinuityError("IntentContract.goal must be an object")
    _exact_keys(goal, {"statement", "source"}, "IntentContract.goal")
    _non_empty_string(goal.get("statement"), "IntentContract.goal.statement")
    if goal.get("source") not in {"whole_impulse", "impulse_prefix"}:
        raise JevyrContinuityError("IntentContract.goal.source is invalid")

    _string_list(value.get("subjectIds"), "IntentContract.subjectIds")
    _string_list(value.get("requestedAssays"), "IntentContract.requestedAssays")

    all_ids: set[str] = set()

    def register_id(entry: Mapping[str, Any], label: str) -> str:
        identifier = _non_empty_string(entry.get("id"), f"{label}.id")
        if identifier in all_ids:
            raise JevyrContinuityError(f"{label}.id duplicates another IntentContract id")
        all_ids.add(identifier)
        return identifier

    constraints = value.get("explicitConstraints")
    if not isinstance(constraints, list):
        raise JevyrContinuityError("IntentContract.explicitConstraints must be an array")
    for index, entry in enumerate(constraints):
        label = f"IntentContract.explicitConstraints[{index}]"
        if not isinstance(entry, dict):
            raise JevyrContinuityError(f"{label} must be an object")
        _exact_keys(entry, {"id", "statement", "origin"}, label)
        register_id(entry, label)
        _non_empty_string(entry.get("statement"), f"{label}.statement")
        if entry.get("origin") not in {"impulse", "declared_constraint"}:
            raise JevyrContinuityError(f"{label}.origin is invalid")

    condition_references: list[tuple[str, list[str]]] = []

    def validate_conditions(raw: Any, kind: str) -> None:
        label = f"IntentContract.{kind}Conditions"
        if not isinstance(raw, list):
            raise JevyrContinuityError(f"{label} must be an array")
        for index, entry in enumerate(raw):
            item_label = f"{label}[{index}]"
            if not isinstance(entry, dict):
                raise JevyrContinuityError(f"{item_label} must be an object")
            _exact_keys(entry, {"id", "kind", "statement", "source", "obligationIds"}, item_label)
            register_id(entry, item_label)
            if entry.get("kind") != kind:
                raise JevyrContinuityError(f"{item_label}.kind must be {kind}")
            _non_empty_string(entry.get("statement"), f"{item_label}.statement")
            if entry.get("source") not in {"kernel", "impulse"}:
                raise JevyrContinuityError(f"{item_label}.source is invalid")
            references = _string_list(entry.get("obligationIds"), f"{item_label}.obligationIds")
            condition_references.append((item_label, references))

    validate_conditions(value.get("successConditions"), "success")
    validate_conditions(value.get("failureConditions"), "failure")

    ambiguity_ids: set[str] = set()
    ambiguities = value.get("ambiguities")
    if not isinstance(ambiguities, list):
        raise JevyrContinuityError("IntentContract.ambiguities must be an array")
    ambiguity_codes = {
        "DEICTIC_REFERENCE", "DISJUNCTION_SCOPE", "MODAL_FORCE", "OPEN_SCOPE",
        "SUBJECTIVE_PREDICATE",
    }
    for index, entry in enumerate(ambiguities):
        label = f"IntentContract.ambiguities[{index}]"
        if not isinstance(entry, dict):
            raise JevyrContinuityError(f"{label} must be an object")
        _exact_keys(entry, {"id", "code", "sourceText", "summary"}, label)
        ambiguity_ids.add(register_id(entry, label))
        if entry.get("code") not in ambiguity_codes:
            raise JevyrContinuityError(f"{label}.code is invalid")
        _non_empty_string(entry.get("sourceText"), f"{label}.sourceText")
        _non_empty_string(entry.get("summary"), f"{label}.summary")

    alternatives = value.get("alternativeInterpretations")
    if not isinstance(alternatives, list):
        raise JevyrContinuityError("IntentContract.alternativeInterpretations must be an array")
    for index, entry in enumerate(alternatives):
        label = f"IntentContract.alternativeInterpretations[{index}]"
        if not isinstance(entry, dict):
            raise JevyrContinuityError(f"{label} must be an object")
        _exact_keys(entry, {"id", "ambiguityId", "statement", "resolution"}, label)
        register_id(entry, label)
        ambiguity_id = _non_empty_string(entry.get("ambiguityId"), f"{label}.ambiguityId")
        if ambiguity_id not in ambiguity_ids:
            raise JevyrContinuityError(f"{label}.ambiguityId does not reference a contract ambiguity")
        _non_empty_string(entry.get("statement"), f"{label}.statement")
        if entry.get("resolution") != "UNRESOLVED":
            raise JevyrContinuityError(f"{label}.resolution must be UNRESOLVED")

    obligations = value.get("criticalObligations")
    if not isinstance(obligations, list) or not obligations:
        raise JevyrContinuityError("IntentContract.criticalObligations must be a non-empty array")
    obligation_ids: set[str] = set()
    obligation_required = {"id", "statement", "origin", "critical", "assayability"}
    obligation_allowed = obligation_required | {"oracle", "unassayableReason"}
    oracle_kinds = {
        "command_exit_code", "exact_output", "network_access_count", "output_parse",
        "path_exists", "sealed_subject_digest", "sealed_test_suite", "requested_assay",
    }
    for index, entry in enumerate(obligations):
        label = f"IntentContract.criticalObligations[{index}]"
        if not isinstance(entry, dict):
            raise JevyrContinuityError(f"{label} must be an object")
        _keys_with_optional(entry, obligation_required, obligation_allowed, label)
        obligation_ids.add(register_id(entry, label))
        _non_empty_string(entry.get("statement"), f"{label}.statement")
        if entry.get("origin") not in {"impulse", "declared_constraint", "requested_assay"}:
            raise JevyrContinuityError(f"{label}.origin is invalid")
        if entry.get("critical") is not True:
            raise JevyrContinuityError(f"{label}.critical must be true")
        assayability = entry.get("assayability")
        if assayability not in {"ASSAYABLE", "UNASSAYABLE"}:
            raise JevyrContinuityError(f"{label}.assayability is invalid")
        oracle = entry.get("oracle")
        if assayability == "ASSAYABLE" and not isinstance(oracle, dict):
            raise JevyrContinuityError(f"{label}.oracle is required for an assayable obligation")
        if assayability == "UNASSAYABLE" and "oracle" in entry:
            raise JevyrContinuityError(f"{label}.oracle is forbidden for an unassayable obligation")
        if assayability == "UNASSAYABLE":
            _non_empty_string(entry.get("unassayableReason"), f"{label}.unassayableReason")
        if isinstance(oracle, dict):
            _exact_keys(oracle, {"kind", "operand", "operator", "expected"}, f"{label}.oracle")
            if oracle.get("kind") not in oracle_kinds:
                raise JevyrContinuityError(f"{label}.oracle.kind is invalid")
            _non_empty_string(oracle.get("operand"), f"{label}.oracle.operand")
            _non_empty_string(oracle.get("expected"), f"{label}.oracle.expected")
            if oracle.get("operator") not in {"equals", "exists", "passes", "parses_as", "unchanged"}:
                raise JevyrContinuityError(f"{label}.oracle.operator is invalid")

    for label, references in condition_references:
        for obligation_id in references:
            if obligation_id not in obligation_ids:
                raise JevyrContinuityError(f"{label}.obligationIds references unknown obligation {obligation_id}")

    contract_digest = value.get("digest")
    if not isinstance(contract_digest, str) or not _DIGEST.fullmatch(contract_digest):
        raise JevyrContinuityError("IntentContract.digest must be a canonical SHA-256 digest")
    unsigned = {key: child for key, child in value.items() if key != "digest"}
    if _digest(unsigned) != contract_digest:
        raise JevyrContinuityError("IntentContract.digest does not bind the canonical intent contract")
    return typing_cast(IntentContract, value)


def _assert_record(value: Any) -> SignedRecord:
    required = {"protocol", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest", "verdict", "reflex", "memoryInfluences", "crystallizedAt"}
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.record/1":
        raise JevyrContinuityError("Endpoint did not return a canonical Record payload")
    _exact_keys(value, required, "SignedRecord")
    if not all(_DIGEST.fullmatch(str(value.get(name))) for name in ("caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest", "eventHeadDigest")):
        raise JevyrContinuityError("Record contains invalid identity digests")
    if not _valid_canonical_timestamp(value.get("crystallizedAt")):
        raise JevyrContinuityError("Record crystallizedAt timestamp is invalid")
    verdict = value.get("verdict")
    reflex = value.get("reflex")
    if not isinstance(verdict, dict) or not isinstance(reflex, dict) or not isinstance(value.get("memoryInfluences"), list):
        raise JevyrContinuityError("Record contains invalid structural fields")
    verdict_keys = {"policyVersion", "intentContractDigest", "evidenceDigest", "integrity", "creation", "embodiment", "judgment", "feasibilityByCandidate", "basis"}
    if "selectedCandidateId" in verdict:
        verdict_keys.add("selectedCandidateId")
    _exact_keys(verdict, verdict_keys, "SignedRecord.verdict")
    if (
        not isinstance(verdict.get("policyVersion"), str)
        or not verdict["policyVersion"].strip()
        or not _DIGEST.fullmatch(str(verdict.get("intentContractDigest")))
        or verdict.get("intentContractDigest") != value.get("intentContractDigest")
        or not _DIGEST.fullmatch(str(verdict.get("evidenceDigest")))
        or verdict.get("integrity") not in {"VALID", "INVALID"}
        or verdict.get("creation") not in {"CONCEIVED", "NO_SURVIVOR", "FAILED"}
        or verdict.get("embodiment") not in {"BUILT", "NOT_BUILT", "FAILED"}
        or verdict.get("judgment") not in {"ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"}
        or not isinstance(verdict.get("feasibilityByCandidate"), dict)
        or not isinstance(verdict.get("basis"), list)
    ):
        raise JevyrContinuityError("Record verdict has an invalid structure or intent identity")
    if "selectedCandidateId" in verdict:
        _event_identifier(verdict["selectedCandidateId"], "Record selectedCandidateId")
    feasibility = verdict["feasibilityByCandidate"]
    if len(feasibility) > _EVENT_REFERENCE_MAX:
        raise JevyrContinuityError("Record feasibilityByCandidate contains too many candidates")
    for candidate_id, outcome in feasibility.items():
        _event_identifier(candidate_id, "Record feasibility candidateId")
        if outcome not in {"BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"}:
            raise JevyrContinuityError("Record feasibilityByCandidate contains an invalid outcome")
    basis = verdict["basis"]
    if len(basis) > _EVENT_REFERENCE_MAX:
        raise JevyrContinuityError("Record verdict basis contains too many entries")
    for index, entry in enumerate(basis):
        if not isinstance(entry, dict):
            raise JevyrContinuityError(f"Record verdict basis[{index}] is not an object")
        required_basis = {"code", "summary", "evidenceIds"}
        _keys_with_optional(entry, required_basis, required_basis | {"obligationIds", "candidateIds"}, f"Record verdict basis[{index}]")
        _event_identifier(entry.get("code"), f"Record verdict basis[{index}].code")
        _event_summary(entry.get("summary"), f"Record verdict basis[{index}].summary")
        _event_identifiers(entry.get("evidenceIds"), f"Record verdict basis[{index}].evidenceIds")
        for field in ("obligationIds", "candidateIds"):
            if field in entry:
                _event_identifiers(entry[field], f"Record verdict basis[{index}].{field}")
    _assert_event_payload("reflex.completed", reflex)
    if reflex.get("intentContractDigest") != value.get("intentContractDigest"):
        raise JevyrContinuityError("Record Reflex does not bind intentContractDigest")
    memories = value["memoryInfluences"]
    if len(memories) > _EVENT_REFERENCE_MAX:
        raise JevyrContinuityError("Record memoryInfluences contains too many entries")
    for memory in memories:
        if not isinstance(memory, dict):
            raise JevyrContinuityError("Record memory influence is not an object")
        _assert_event_payload("memory.influence", memory)
    return typing_cast(SignedRecord, value)


def assert_terminal_receipt(value: Any) -> TerminalReceipt:
    """Strictly validate a signed commitment to one complete terminal ledger."""
    required = {
        "protocol",
        "caseId",
        "caseDigest",
        "runDigest",
        "lifecycle",
        "stage",
        "stageStatus",
        "lastSequence",
        "eventHeadDigest",
        "recordDigest",
        "artifactIndexDigest",
        "closedAt",
    }
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.terminal/1":
        raise JevyrContinuityError(
            "Endpoint did not return a canonical TerminalReceipt"
        )
    _exact_keys(value, required, "TerminalReceipt")
    for field in ("caseDigest", "runDigest", "recordDigest", "artifactIndexDigest"):
        digest = value.get(field)
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise JevyrContinuityError(
                f"TerminalReceipt {field} must be a canonical SHA-256 digest"
            )
    run_digest = typing_cast(str, value["runDigest"])
    expected_case_id = f"case_{run_digest[len('sha256:'):len('sha256:') + 16]}"
    if value.get("caseId") != expected_case_id:
        raise JevyrContinuityError(
            "TerminalReceipt caseId is not derived from runDigest"
        )
    try:
        last_sequence = _non_negative_integer(
            value.get("lastSequence"), "TerminalReceipt lastSequence"
        )
    except ValueError as error:
        raise JevyrContinuityError(str(error)) from error
    event_head = value.get("eventHeadDigest")
    if event_head is not None and (
        not isinstance(event_head, str) or not _DIGEST.fullmatch(event_head)
    ):
        raise JevyrContinuityError(
            "TerminalReceipt eventHeadDigest must be null or a canonical SHA-256 digest"
        )
    if last_sequence == 0 and event_head is not None:
        raise JevyrContinuityError(
            "An empty terminal ledger must have a null eventHeadDigest"
        )
    if last_sequence > 0 and event_head is None:
        raise JevyrContinuityError(
            "A non-empty terminal ledger must have an eventHeadDigest"
        )
    lifecycle = value.get("lifecycle")
    stage = value.get("stage")
    stage_status = value.get("stageStatus")
    if lifecycle not in {"terminated", "invalid"}:
        raise JevyrContinuityError(
            "TerminalReceipt lifecycle must be terminated or invalid"
        )
    if stage not in _STAGES or stage_status not in _STAGE_STATUSES:
        raise JevyrContinuityError(
            "TerminalReceipt contains an invalid lifecycle stage or status"
        )
    if lifecycle == "terminated" and (
        stage != "terminate" or stage_status != "completed"
    ):
        raise JevyrContinuityError(
            "A terminated closure must complete the terminate stage"
        )
    if lifecycle == "invalid" and stage_status != "failed":
        raise JevyrContinuityError(
            "An invalid closure must have failed stage status"
        )
    if not _valid_canonical_timestamp(value.get("closedAt")):
        raise JevyrContinuityError(
            "TerminalReceipt closedAt must be a canonical UTC timestamp with millisecond precision"
        )
    return typing_cast(TerminalReceipt, value)


def _verify_dsse(
    envelope_value: Any,
    trust_value: Any,
    payload_type: str,
    parser: Callable[[Any], Payload],
    expected_payload: Mapping[str, Any] | None = None,
) -> VerifiedDssePayload[Payload]:
    envelope = _assert_envelope(envelope_value)
    trust = _assert_trust_bundle(trust_value)
    if envelope["payloadType"] != payload_type:
        raise JevyrContinuityError(f"Expected DSSE payload type {payload_type}")
    payload_bytes = _base64(envelope["payload"], "DSSE payload")
    try:
        text = payload_bytes.decode("utf-8", errors="strict")
        decoded = _loads_unambiguous(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise JevyrContinuityError("DSSE payload is not valid UTF-8 JSON") from error
    payload = parser(decoded)
    if _canonical(payload) != payload_bytes:
        raise JevyrContinuityError("DSSE payload bytes are not canonical JSON for the decoded payload")
    if expected_payload is not None and _canonical(expected_payload) != payload_bytes:
        raise JevyrContinuityError("DSSE payload does not equal the canonical endpoint payload")

    trusted = {raw["keyId"]: raw for raw in trust["keys"]}
    pae = _dsse_pae(payload_type, payload_bytes)
    for entry in envelope["signatures"]:
        raw_key = trusted.get(entry["keyid"])
        if raw_key is None or payload_type not in raw_key["payloadTypes"]:
            continue
        key, _spki = _public_key(raw_key)
        try:
            key.verify(_base64(entry["sig"], "DSSE signature"), pae)
        except InvalidSignature:
            continue
        return VerifiedDssePayload(payload, envelope, raw_key["keyId"], payload_type)
    raise JevyrContinuityError("DSSE Ed25519 signature did not verify under a trusted key id")


def verify_seal_envelope(envelope: Any, trust_bundle: Any, expected_payload: Mapping[str, Any] | None = None) -> VerifiedDssePayload[SealReceipt]:
    return _verify_dsse(envelope, trust_bundle, SEAL_DSSE_PAYLOAD_TYPE, _assert_seal_receipt, expected_payload)


def verify_record_envelope(envelope: Any, trust_bundle: Any, expected_payload: Mapping[str, Any] | None = None) -> VerifiedDssePayload[SignedRecord]:
    return _verify_dsse(envelope, trust_bundle, RECORD_DSSE_PAYLOAD_TYPE, _assert_record, expected_payload)


def verify_terminal_envelope(
    envelope: Any,
    trust_bundle: Any,
    expected_payload: Mapping[str, Any] | None = None,
) -> VerifiedDssePayload[TerminalReceipt]:
    return _verify_dsse(
        envelope,
        trust_bundle,
        TERMINAL_DSSE_PAYLOAD_TYPE,
        assert_terminal_receipt,
        expected_payload,
    )


def _event_digest(event: Mapping[str, Any]) -> str:
    return _digest({key: value for key, value in event.items() if key != "eventDigest"})


def _advance(_previous: str, event: Mapping[str, Any]) -> str:
    """Deprecated compatibility helper; canonical events carry their own head."""
    return _event_digest(event)


def _contains_forbidden_trace(value: Any) -> bool:
    if isinstance(value, list):
        return any(_contains_forbidden_trace(item) for item in value)
    if not isinstance(value, Mapping):
        return False
    return any(key.lower() in _FORBIDDEN_TRACE_KEYS or _contains_forbidden_trace(child) for key, child in value.items())


def _decode_sse(response: Any) -> Iterator[dict[str, str]]:
    """Decode UTF-8 SSE over CRLF, bare CR, or bare LF chunk boundaries."""

    message: dict[str, str] = {}
    data: list[str] = []
    buffer = ""
    event_characters = 0
    event_lines = 0
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    read_chunk = getattr(response, "read1", None)
    if not callable(read_chunk):
        read_chunk = getattr(response, "read", None)
    if not callable(read_chunk):
        raise JevyrContinuityError("SSE response body is not readable")

    def consume_line(line: str) -> dict[str, str] | None:
        nonlocal message, data, event_characters, event_lines
        if line == "":
            emitted = None
            if data:
                emitted = {**message, "data": "\n".join(data)}
            message, data = {}, []
            event_characters, event_lines = 0, 0
            return emitted
        event_characters += len(line) + 1
        event_lines += 1
        if event_characters > _MAX_SSE_EVENT_CHARACTERS or event_lines > _MAX_SSE_LINES:
            raise JevyrContinuityError("SSE event exceeds its bounded transport envelope")
        if line.startswith(":"):
            return None
        field, divider, value = line.partition(":")
        if divider and value.startswith(" "):
            value = value[1:]
        if field == "data":
            data.append(value)
        elif field == "id" and "\x00" not in value:
            message[field] = value
        elif field == "event":
            message[field] = value
        elif field == "retry" and value.isascii() and value.isdigit():
            message[field] = value
        return None

    def consume_buffer(done: bool) -> list[dict[str, str]]:
        nonlocal buffer
        emitted: list[dict[str, str]] = []
        while True:
            ending = next(
                (index for index, character in enumerate(buffer) if character in "\r\n"),
                None,
            )
            if ending is None:
                break
            if buffer[ending] == "\r" and ending + 1 == len(buffer) and not done:
                break
            consumed = 2 if buffer[ending : ending + 2] == "\r\n" else 1
            line = buffer[:ending]
            buffer = buffer[ending + consumed :]
            value = consume_line(line)
            if value is not None:
                emitted.append(value)
        return emitted

    try:
        while True:
            raw = read_chunk(8_192)
            if raw is None:
                raw = b""
            if not isinstance(raw, (bytes, bytearray, memoryview)):
                raise JevyrContinuityError("SSE response body did not yield bytes")
            done = len(raw) == 0
            buffer += decoder.decode(bytes(raw), final=done)
            for value in consume_buffer(done):
                yield value
            if event_characters + len(buffer) > _MAX_SSE_EVENT_CHARACTERS:
                raise JevyrContinuityError("SSE event exceeds its bounded transport envelope")
            if not done:
                continue
            if buffer:
                value = consume_line(buffer)
                buffer = ""
                if value is not None:
                    yield value
            if data:
                yield {**message, "data": "\n".join(data)}
            return
    except UnicodeDecodeError as error:
        raise JevyrContinuityError("SSE response is not valid UTF-8") from error


def _event_identifier(value: Any, label: str) -> str:
    text = _non_empty_string(value, label)
    if _utf16_length(text) > _EVENT_ID_MAX:
        raise JevyrContinuityError(f"{label} exceeds {_EVENT_ID_MAX} characters")
    return text


def _event_summary(value: Any, label: str = "Event payload summary") -> str:
    text = _non_empty_string(value, label)
    if _utf16_length(text) > _EVENT_SUMMARY_MAX:
        raise JevyrContinuityError(f"{label} exceeds {_EVENT_SUMMARY_MAX} characters")
    return text


def _event_identifiers(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > _EVENT_REFERENCE_MAX:
        raise JevyrContinuityError(f"{label} must be an array of at most {_EVENT_REFERENCE_MAX} identifiers")
    result = [_event_identifier(item, f"{label}[{index}]") for index, item in enumerate(value)]
    if len(set(result)) != len(result):
        raise JevyrContinuityError(f"{label} must not contain duplicates")
    return result


def _event_digests(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > _EVENT_REFERENCE_MAX:
        raise JevyrContinuityError(f"{label} must be an array of at most {_EVENT_REFERENCE_MAX} digests")
    if any(not isinstance(item, str) or not _DIGEST.fullmatch(item) for item in value):
        raise JevyrContinuityError(f"{label} contains an invalid SHA-256 digest")
    if len(set(value)) != len(value):
        raise JevyrContinuityError(f"{label} must not contain duplicates")
    return value


def _event_number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or float(value) < minimum
        or float(value) > maximum
    ):
        raise JevyrContinuityError(f"{label} must be a finite number in [{minimum}, {maximum}]")
    return float(value)


def _assert_investigation_audit(value: Any) -> None:
    if not isinstance(value, dict):
        raise JevyrContinuityError("Investigation audit must be an object")
    shapes = {
        "lineage_commitment": {"invocationId", "providerId", "modelId", "lineageId", "seedCommitment", "seedEnforcement", "promptDigest", "candidateIds", "visibleCandidateIds", "memoryDigests", "assumptionDigest"},
        "paired_probe": {"pairId", "axis", "arm", "obligationDigest", "evidenceDigest", "outcomeDigest"},
        "evaluator_boundary": {"builderId", "evaluatorId", "sealedOracleDigest", "appliedOracleDigest", "untrustedOracleInput"},
        "assumption_check": {"sealedAssumptionsDigest", "appliedAssumptionsDigest"},
        "memory_validation": {"memoryDigest", "contaminated", "derivedFromDigests"},
        "terminal_claim": {"claimId", "evidenceIds"},
    }
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in shapes:
        raise JevyrContinuityError("Unknown investigation audit kind")
    _exact_keys(value, {"kind"} | shapes[kind], "Investigation audit")
    for field, item in value.items():
        if field == "kind":
            continue
        if field in {"contaminated", "untrustedOracleInput"}:
            if not isinstance(item, bool):
                raise JevyrContinuityError(f"Investigation audit {field} must be boolean")
        elif field in {"memoryDigests", "derivedFromDigests"}:
            _event_digests(item, f"Investigation audit {field}")
        elif field in {"candidateIds", "visibleCandidateIds", "evidenceIds"}:
            _event_identifiers(item, f"Investigation audit {field}")
        elif field.endswith("Digest") or field == "seedCommitment":
            if not isinstance(item, str) or not _DIGEST.fullmatch(item):
                raise JevyrContinuityError(f"Investigation audit {field} must be a digest")
        else:
            _event_identifier(item, f"Investigation audit {field}")
    if kind == "lineage_commitment" and value["seedEnforcement"] not in {"honored", "unverified"}:
        raise JevyrContinuityError("Investigation seed enforcement is invalid")
    if kind == "paired_probe" and (value["axis"] not in {"preference_wording", "initial_condition"} or value["arm"] not in {"baseline", "variant"}):
        raise JevyrContinuityError("Investigation paired probe axis or arm is invalid")


def _assert_formal_counterexample(value: Any) -> None:
    if not isinstance(value, dict):
        raise JevyrContinuityError("Formal proof must be an object")
    _exact_keys(value, {"protocol", "rule", "intentContractDigest", "obligationId", "statementDigest", "source", "proposition", "witness"}, "Formal proof")
    if value["protocol"] != "jevyr.formal-counterexample/1" or value["rule"] != "finite-sequence-length-lower-bound":
        raise JevyrContinuityError("Formal proof rule is unknown")
    for field in ("intentContractDigest", "statementDigest"):
        if not isinstance(value[field], str) or not _DIGEST.fullmatch(value[field]):
            raise JevyrContinuityError("Formal proof digest is invalid")
    _event_identifier(value["obligationId"], "Formal proof obligationId")
    for field, keys in (("source", {"start", "end", "text"}), ("proposition", {"domain", "minimumInputLength", "minimumOutputLength", "requiredSaving"}), ("witness", {"inputLength", "inputHex", "maximumOutputLength"})):
        if not isinstance(value[field], dict):
            raise JevyrContinuityError(f"Formal proof {field} must be an object")
        _exact_keys(value[field], keys, f"Formal proof {field}")
    source, proposition, witness = value["source"], value["proposition"], value["witness"]
    _event_summary(source["text"], "Formal proof source text")
    if any(type(source[key]) is not int or not 0 <= source[key] <= 1_000_000 for key in ("start", "end")):
        raise JevyrContinuityError("Formal proof source offsets are invalid")
    if source["end"] - source["start"] != len(source["text"].encode("utf-16-le")) // 2:
        raise JevyrContinuityError("Formal proof source span is not exact")
    if proposition["domain"] not in {"all_finite_byte_strings", "all_finite_bit_strings"}:
        raise JevyrContinuityError("Formal proof domain is invalid")
    if any(type(proposition[key]) is not int or proposition[key] != 0 for key in ("minimumInputLength", "minimumOutputLength")):
        raise JevyrContinuityError("Formal proof requires natural finite sequence lengths")
    if type(proposition["requiredSaving"]) is not int or not 1 <= proposition["requiredSaving"] <= 999_999:
        raise JevyrContinuityError("Formal proof saving is invalid")
    if type(witness["inputLength"]) is not int or witness["inputLength"] != 0 or witness["inputHex"] != "":
        raise JevyrContinuityError("Formal proof witness must be the empty sequence")
    if type(witness["maximumOutputLength"]) is not int or not -999_999 <= witness["maximumOutputLength"] <= -1:
        raise JevyrContinuityError("Formal proof output bound is invalid")


def _assert_event_payload(kind: str, payload: dict[str, Any]) -> None:
    """Apply the same closed, discriminator-specific payload contract as @jevyr/protocol."""
    if kind == "stage.status":
        _keys_with_optional(payload, {"stage", "status", "summary"}, {"stage", "status", "summary", "progress"}, "stage.status payload")
        if payload.get("stage") not in _STAGES or payload.get("status") not in _STAGE_STATUSES:
            raise JevyrContinuityError("stage.status payload contains an invalid stage or status")
        if "progress" in payload:
            _event_number(payload["progress"], "stage.status progress", 0, 1)
        _event_summary(payload.get("summary"))
        return

    if kind == "claim.published":
        _keys_with_optional(payload, {"claimId", "statement", "claimType"}, {"claimId", "statement", "claimType", "confidence", "candidateId"}, "claim.published payload")
        _event_identifier(payload.get("claimId"), "claimId")
        _non_empty_string(payload.get("statement"), "claim statement")
        if payload.get("claimType") not in {"interpretation", "mechanism", "risk", "requirement", "prediction"}:
            raise JevyrContinuityError("claim.published payload contains an invalid claimType")
        if "confidence" in payload:
            _event_number(payload["confidence"], "claim confidence", 0, 1)
        if "candidateId" in payload:
            _event_identifier(payload["candidateId"], "claim candidateId")
        return

    if kind == "action.status":
        required = {"actionId", "actionType", "status", "summary"}
        _keys_with_optional(payload, required, required | {"toolId", "artifactDigests", "resource"}, "action.status payload")
        _event_identifier(payload.get("actionId"), "actionId")
        _event_identifier(payload.get("actionType"), "actionType")
        if payload.get("status") not in {"requested", "started", "completed", "failed", "denied"}:
            raise JevyrContinuityError("action.status payload contains an invalid status")
        if "toolId" in payload:
            _event_identifier(payload["toolId"], "action toolId")
        if "artifactDigests" in payload:
            _event_digests(payload["artifactDigests"], "action artifactDigests")
        if "resource" in payload:
            resource = payload["resource"]
            fields = {"cpuMillis", "wallMillis", "bytesRead", "bytesWritten"}
            if not isinstance(resource, dict) or not set(resource).issubset(fields):
                raise JevyrContinuityError("action resource fields do not match its versioned contract")
            for field, value in resource.items():
                try:
                    _non_negative_integer(value, f"action resource {field}")
                except ValueError as error:
                    raise JevyrContinuityError(str(error)) from error
        _event_summary(payload.get("summary"))
        return

    if kind == "evidence.observed":
        required = {"evidenceId", "evidenceType", "summary", "contentDigest"}
        _keys_with_optional(payload, required, required | {"candidateId", "assayId", "supports", "refutes", "audit", "formalProof"}, "evidence.observed payload")
        _event_identifier(payload.get("evidenceId"), "evidenceId")
        if payload.get("evidenceType") not in _EVENT_EVIDENCE_TYPES:
            raise JevyrContinuityError("evidence.observed payload contains an invalid evidenceType")
        if not isinstance(payload.get("contentDigest"), str) or not _DIGEST.fullmatch(payload["contentDigest"]):
            raise JevyrContinuityError("evidence contentDigest is invalid")
        for field in ("candidateId", "assayId"):
            if field in payload:
                _event_identifier(payload[field], f"evidence {field}")
        supports = _event_identifiers(payload["supports"], "evidence supports") if "supports" in payload else []
        refutes = _event_identifiers(payload["refutes"], "evidence refutes") if "refutes" in payload else []
        if set(supports).intersection(refutes):
            raise JevyrContinuityError("evidence cannot support and refute the same identifier")
        if "audit" in payload:
            _assert_investigation_audit(payload["audit"])
            if _digest(payload["audit"]) != payload["contentDigest"]:
                raise JevyrContinuityError("Investigation audit digest does not match the observed content")
        if "formalProof" in payload:
            _assert_formal_counterexample(payload["formalProof"])
            if payload["evidenceType"] != "tool_observation" or any(key in payload for key in ("candidateId", "assayId", "supports", "refutes", "audit")):
                raise JevyrContinuityError("Formal proof cannot claim sandbox or model edge authority")
            if _digest(payload["formalProof"]) != payload["contentDigest"]:
                raise JevyrContinuityError("Formal proof digest does not match its exact certificate")
        _event_summary(payload.get("summary"))
        return

    if kind == "candidate.status":
        required = {"candidateId", "status", "summary"}
        _keys_with_optional(payload, required, required | {"feasibility", "parentIds", "artifactDigests"}, "candidate.status payload")
        candidate_id = _event_identifier(payload.get("candidateId"), "candidateId")
        if payload.get("status") not in {"proposed", "embodied", "invalidated", "survived", "selected"}:
            raise JevyrContinuityError("candidate.status payload contains an invalid status")
        if "feasibility" in payload and payload["feasibility"] not in {"BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED"}:
            raise JevyrContinuityError("candidate.status payload contains an invalid feasibility")
        if "parentIds" in payload and candidate_id in _event_identifiers(payload["parentIds"], "candidate parentIds"):
            raise JevyrContinuityError("a candidate cannot name itself as a parent")
        if "artifactDigests" in payload:
            _event_digests(payload["artifactDigests"], "candidate artifactDigests")
        _event_summary(payload.get("summary"))
        return

    if kind == "assay.status":
        required = {"assayId", "status", "critical", "summary"}
        _keys_with_optional(payload, required, required | {"candidateId", "obligationId", "evidenceIds", "scope", "populationIds"}, "assay.status payload")
        _event_identifier(payload.get("assayId"), "assayId")
        if payload.get("status") not in {"planned", "running", "passed", "failed", "inconclusive", "blocked"}:
            raise JevyrContinuityError("assay.status payload contains an invalid status")
        if not isinstance(payload.get("critical"), bool):
            raise JevyrContinuityError("assay critical must be a boolean")
        for field in ("candidateId", "obligationId"):
            if field in payload:
                _event_identifier(payload[field], f"assay {field}")
        if "evidenceIds" in payload:
            _event_identifiers(payload["evidenceIds"], "assay evidenceIds")
        if "scope" in payload or "populationIds" in payload:
            population = _event_identifiers(payload.get("populationIds"), "assay populationIds")
            if (payload.get("scope") != "closed_population" or payload.get("critical") is not True
                    or payload.get("status") != "failed" or "candidateId" in payload or "obligationId" in payload
                    or not population or not isinstance(payload.get("evidenceIds"), list)
                    or len(payload["evidenceIds"]) != len(population)):
                raise JevyrContinuityError("Closed population failure requires one observation per member and no global obligation claim")
        _event_summary(payload.get("summary"))
        return

    if kind == "reflex.completed":
        required = {"loop", "reviewedEvidenceDigest", "intentContractDigest", "challengedNodeIds", "materialFindings", "decision"}
        _keys_with_optional(payload, required, required | {"audits"}, "reflex.completed payload")
        if payload.get("loop") not in {1, 2} or isinstance(payload.get("loop"), bool):
            raise JevyrContinuityError("Reflex loop must be one or two")
        for field in ("reviewedEvidenceDigest", "intentContractDigest"):
            if not isinstance(payload.get(field), str) or not _DIGEST.fullmatch(payload[field]):
                raise JevyrContinuityError(f"Reflex {field} is invalid")
        _event_identifiers(payload.get("challengedNodeIds"), "Reflex challengedNodeIds")
        findings = payload.get("materialFindings")
        if not isinstance(findings, list) or len(findings) > _EVENT_REFERENCE_MAX:
            raise JevyrContinuityError("Reflex materialFindings is invalid")
        for index, finding in enumerate(findings):
            if not isinstance(finding, dict):
                raise JevyrContinuityError(f"Reflex materialFindings[{index}] is not an object")
            _exact_keys(finding, {"code", "summary", "evidenceIds"}, f"Reflex materialFindings[{index}]")
            _event_identifier(finding.get("code"), f"Reflex materialFindings[{index}].code")
            _event_summary(finding.get("summary"), f"Reflex materialFindings[{index}].summary")
            _event_identifiers(finding.get("evidenceIds"), f"Reflex materialFindings[{index}].evidenceIds")
        if payload.get("decision") not in {"confirm", "revise", "repeat_once"}:
            raise JevyrContinuityError("Reflex decision is invalid")
        if "audits" in payload:
            if not isinstance(payload["audits"], list) or len(payload["audits"]) > 32:
                raise JevyrContinuityError("Reflex audits must be a bounded list")
            for audit in payload["audits"]:
                if not isinstance(audit, dict):
                    raise JevyrContinuityError("Reflex audit must be an object")
                _exact_keys(audit, {"audit", "status", "summary", "evidenceIds"}, "Reflex audit")
                _event_identifier(audit.get("audit"), "Reflex audit name")
                _event_summary(audit.get("summary"), "Reflex audit summary")
                _event_identifiers(audit.get("evidenceIds"), "Reflex audit evidenceIds")
                if audit.get("status") not in {"passed", "failed", "unmeasured"}:
                    raise JevyrContinuityError("Reflex audit status is invalid")
        return

    if kind == "memory.influence":
        _exact_keys(payload, {"memoryDigest", "influence", "summary", "weight"}, "memory.influence payload")
        if not isinstance(payload.get("memoryDigest"), str) or not _DIGEST.fullmatch(payload["memoryDigest"]):
            raise JevyrContinuityError("memory influence digest is invalid")
        if payload.get("influence") not in {"seeded_hypothesis", "strategy_selected", "calibration_applied"}:
            raise JevyrContinuityError("memory influence kind is invalid")
        _event_number(payload.get("weight"), "memory influence weight", 0, 0.2)
        _event_summary(payload.get("summary"))
        return

    if kind == "search.status":
        required = {"layer", "status", "attempted", "attemptSafetyCeiling", "resources", "summary"}
        allowed = required | {"candidateId", "assayId", "hypothesisNursery", "assayArchive", "termination"}
        _keys_with_optional(payload, required, allowed, "search.status payload")
        layer = payload.get("layer")
        if layer not in {"HYPOTHESIS_NURSERY", "ASSAY_ARCHIVE"}:
            raise JevyrContinuityError("search telemetry layer is invalid")
        if payload.get("status") not in {"started", "exploring", "hypothesis_admitted", "archive_changed", "completed", "failed"}:
            raise JevyrContinuityError("search telemetry status is invalid")
        try:
            _non_negative_integer(payload.get("attempted"), "search attempted")
        except ValueError as error:
            raise JevyrContinuityError(str(error)) from error
        guard = payload.get("attemptSafetyCeiling")
        if not isinstance(guard, str) or len(guard) > 128 or not re.fullmatch(r"[1-9][0-9]*", guard):
            raise JevyrContinuityError("attemptSafetyCeiling must be a positive decimal string of at most 128 digits")
        for field in ("candidateId", "assayId"):
            if field in payload:
                _event_identifier(payload[field], f"search {field}")
        resources = payload.get("resources")
        if not isinstance(resources, list) or len(resources) != len(_EVENT_RESOURCE_NAMES):
            raise JevyrContinuityError("search resources must contain every sealed resource dimension")
        names: set[str] = set()
        for index, resource in enumerate(resources):
            if not isinstance(resource, dict):
                raise JevyrContinuityError(f"search resources[{index}] is not an object")
            _exact_keys(resource, {"name", "used", "ceiling", "measurement"}, f"search resources[{index}]")
            name = resource.get("name")
            if name not in _EVENT_RESOURCE_NAMES or name in names:
                raise JevyrContinuityError(f"search resources[{index}] has an unknown or duplicate name")
            names.add(typing_cast(str, name))
            try:
                _non_negative_integer(resource.get("ceiling"), f"search resources[{index}].ceiling")
            except ValueError as error:
                raise JevyrContinuityError(str(error)) from error
            measurement = resource.get("measurement")
            if measurement not in {"MEASURED", "UPPER_BOUND", "DECLARED_ONLY"}:
                raise JevyrContinuityError(f"search resources[{index}] measurement is invalid")
            used = resource.get("used")
            if measurement == "DECLARED_ONLY":
                if used is not None:
                    raise JevyrContinuityError("declared-only search resources must use null")
            else:
                _event_number(used, f"search resources[{index}].used", 0, float("inf"))
        nursery = payload.get("hypothesisNursery")
        if layer == "HYPOTHESIS_NURSERY" and not isinstance(nursery, dict):
            raise JevyrContinuityError("hypothesisNursery telemetry is required for the hypothesis layer")
        if isinstance(nursery, dict):
            fields = {"exactDistinctHypotheses", "scars", "declaredMechanismLabels", "exactYieldAge"}
            _exact_keys(nursery, fields, "hypothesisNursery")
            for field in ("exactDistinctHypotheses", "scars", "exactYieldAge"):
                try:
                    _non_negative_integer(nursery.get(field), f"hypothesisNursery {field}")
                except ValueError as error:
                    raise JevyrContinuityError(str(error)) from error
            _string_list(nursery.get("declaredMechanismLabels"), "hypothesisNursery declaredMechanismLabels")
        archive = payload.get("assayArchive")
        if layer == "ASSAY_ARCHIVE" and not isinstance(archive, dict):
            raise JevyrContinuityError("assayArchive telemetry is required for the assay layer")
        if isinstance(archive, dict):
            required_archive = {"measuredEntries", "occupiedNiches"}
            _keys_with_optional(archive, required_archive, required_archive | {"lastMeasuredNovelty"}, "assayArchive")
            for field in required_archive:
                try:
                    _non_negative_integer(archive.get(field), f"assayArchive {field}")
                except ValueError as error:
                    raise JevyrContinuityError(str(error)) from error
            if "lastMeasuredNovelty" in archive:
                _event_number(archive["lastMeasuredNovelty"], "assayArchive lastMeasuredNovelty", 0, 1)
        if "termination" in payload and payload["termination"] not in {"HYPOTHESIS_SATURATED", "RESOURCE_EXHAUSTED", "ATTEMPT_CEILING"}:
            raise JevyrContinuityError("search termination is invalid")
        _event_summary(payload.get("summary"))
        return

    if kind == "kernel.status":
        _keys_with_optional(payload, {"operation", "summary"}, {"operation", "summary", "artifactDigest"}, "kernel.status payload")
        if payload.get("operation") not in {"sealed", "policy_compiled", "record_crystallized", "signed", "terminated"}:
            raise JevyrContinuityError("kernel operation is invalid")
        if "artifactDigest" in payload and (not isinstance(payload["artifactDigest"], str) or not _DIGEST.fullmatch(payload["artifactDigest"])):
            raise JevyrContinuityError("kernel artifactDigest is invalid")
        _event_summary(payload.get("summary"))


def _assert_event(
    raw: Any,
    cursor: int,
    prior_digest: str | None,
    case_digest: str,
    run_digest: str,
    *,
    anchor: bool = True,
) -> CaseEvent:
    if not isinstance(raw, dict) or raw.get("protocol") != "jevyr.event/1":
        raise JevyrContinuityError("Live transport emitted a non-canonical event")
    expected_keys = {"protocol", "caseDigest", "runDigest", "sequence", "priorDigest", "eventDigest", "observedAt", "stage", "kind", "actor", "payload"}
    if set(raw) != expected_keys:
        raise JevyrContinuityError("CaseEvent fields do not match jevyr.event/1")
    sequence = raw.get("sequence")
    if (
        isinstance(sequence, bool)
        or not isinstance(sequence, int)
        or sequence < 1
        or sequence > _MAX_SAFE_INTEGER
        or sequence != cursor + 1
    ):
        raise JevyrContinuityError(f"Event gap: expected {cursor + 1}, received {raw.get('sequence')}")
    if (
        not isinstance(raw.get("caseDigest"), str)
        or not _DIGEST.fullmatch(raw["caseDigest"])
        or not isinstance(raw.get("runDigest"), str)
        or not _DIGEST.fullmatch(raw["runDigest"])
        or raw.get("caseDigest") != case_digest
        or raw.get("runDigest") != run_digest
    ):
        raise JevyrContinuityError("Case or run digest changed inside one stream")
    if anchor and raw.get("priorDigest") != prior_digest:
        raise JevyrContinuityError("Event priorDigest does not match the verified cursor head")
    if raw.get("priorDigest") is not None and not _DIGEST.fullmatch(str(raw.get("priorDigest"))):
        raise JevyrContinuityError("Event priorDigest is invalid")
    if raw.get("stage") not in _STAGES or raw.get("kind") not in _KINDS:
        raise JevyrContinuityError("Event stage or kind is invalid")
    if not _valid_canonical_timestamp(raw.get("observedAt")):
        raise JevyrContinuityError("Event observedAt timestamp is invalid")
    actor = raw.get("actor")
    if (
        not isinstance(actor, dict)
        or not isinstance(actor.get("id"), str)
        or not actor["id"]
        or actor.get("kind") not in _ACTORS
    ):
        raise JevyrContinuityError("Event actor is invalid")
    _keys_with_optional(actor, {"id", "kind"}, {"id", "kind", "instance"}, "Event actor")
    if "instance" in actor and not isinstance(actor["instance"], str):
        raise JevyrContinuityError("Event actor instance is invalid")
    payload = raw.get("payload")
    if not isinstance(payload, dict) or _contains_forbidden_trace(payload):
        raise JevyrContinuityError("Event payload is invalid or exposes private reasoning")
    _assert_event_payload(typing_cast(str, raw["kind"]), payload)
    if not _DIGEST.fullmatch(str(raw.get("eventDigest"))) or raw["eventDigest"] != _event_digest(raw):
        raise JevyrContinuityError("Event content does not match eventDigest")
    return typing_cast(CaseEvent, raw)


def _assert_status(value: Any) -> LiveCaseStatus:
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.status/1":
        raise JevyrContinuityError("Status endpoint did not return jevyr.status/1")
    _exact_keys(
        value,
        {
            "protocol",
            "caseDigest",
            "runDigest",
            "lifecycle",
            "stage",
            "stageStatus",
            "lastSequence",
            "headDigest",
            "updatedAt",
        },
        "LiveCaseStatus",
    )
    if (
        not isinstance(value.get("caseDigest"), str)
        or not _DIGEST.fullmatch(value["caseDigest"])
        or not isinstance(value.get("runDigest"), str)
        or not _DIGEST.fullmatch(value["runDigest"])
        or (
            value.get("headDigest") is not None
            and (
                not isinstance(value.get("headDigest"), str)
                or not _DIGEST.fullmatch(value["headDigest"])
            )
        )
    ):
        raise JevyrContinuityError("Status contains an invalid digest")
    try:
        last_sequence = _non_negative_integer(value.get("lastSequence"), "Status lastSequence")
    except ValueError as error:
        raise JevyrContinuityError(str(error)) from error
    if (
        value.get("lifecycle") not in _LIFECYCLES
        or value.get("stage") not in _STAGES
        or value.get("stageStatus") not in _STAGE_STATUSES
    ):
        raise JevyrContinuityError("Status contains an invalid lifecycle state")
    if not _valid_canonical_timestamp(value.get("updatedAt")):
        raise JevyrContinuityError("Status contains an invalid updatedAt timestamp")
    if last_sequence == 0 and value.get("headDigest") is not None:
        raise JevyrContinuityError("Status with no events cannot expose a headDigest")
    if last_sequence > 0 and value.get("headDigest") is None:
        raise JevyrContinuityError("Status with events must expose a headDigest")
    return typing_cast(LiveCaseStatus, value)


def _assert_live_event_batch(value: Any, requested_after: int) -> LiveEventBatch:
    if not isinstance(value, dict) or value.get("protocol") != "jevyr.live/1":
        raise JevyrContinuityError("Event endpoint did not return jevyr.live/1")
    _exact_keys(
        value,
        {
            "protocol",
            "caseDigest",
            "runDigest",
            "afterSequence",
            "throughSequence",
            "headDigest",
            "caughtUp",
            "events",
            "polledAt",
        },
        "LiveEventBatch",
    )
    if (
        not isinstance(value.get("caseDigest"), str)
        or not _DIGEST.fullmatch(value["caseDigest"])
        or not isinstance(value.get("runDigest"), str)
        or not _DIGEST.fullmatch(value["runDigest"])
    ):
        raise JevyrContinuityError("Event batch contains invalid case or run digests")
    after = value.get("afterSequence")
    through = value.get("throughSequence")
    if (
        isinstance(after, bool)
        or not isinstance(after, int)
        or after != requested_after
        or isinstance(through, bool)
        or not isinstance(through, int)
        or through < requested_after
        or through > _MAX_SAFE_INTEGER
    ):
        raise JevyrContinuityError("Event batch cursor does not match the request")
    head = value.get("headDigest")
    if head is not None and (not isinstance(head, str) or not _DIGEST.fullmatch(head)):
        raise JevyrContinuityError("Event batch contains an invalid headDigest")
    events = value.get("events")
    if (
        not isinstance(value.get("caughtUp"), bool)
        or not isinstance(events, list)
        or not _valid_canonical_timestamp(value.get("polledAt"))
    ):
        raise JevyrContinuityError("Event batch has an invalid envelope")
    sequence = requested_after
    prior: str | None = None
    anchored = requested_after == 0
    for raw in events:
        event = _assert_event(
            raw,
            sequence,
            prior,
            value["caseDigest"],
            value["runDigest"],
            anchor=anchored,
        )
        sequence = event["sequence"]
        prior = event["eventDigest"]
        anchored = True
    if through != sequence:
        raise JevyrContinuityError("throughSequence does not match the returned events")
    if value["caughtUp"] and events and head != prior:
        raise JevyrContinuityError("Caught-up batch headDigest does not match its final event")
    if value["caughtUp"] and requested_after == 0 and not events and head is not None:
        raise JevyrContinuityError("Empty ledger cannot expose a non-null headDigest")
    return typing_cast(LiveEventBatch, value)


def verify_event_chain(events: Sequence[Mapping[str, Any]]) -> tuple[bool, str | None, list[str]]:
    problems: list[str] = []
    prior: str | None = None
    case_digest = str(events[0].get("caseDigest")) if events else ""
    run_digest = str(events[0].get("runDigest")) if events else ""
    for cursor, event in enumerate(events):
        try:
            _assert_event(dict(event), cursor, prior, case_digest, run_digest)
        except JevyrContinuityError as error:
            problems.append(str(error))
        prior = str(event.get("eventDigest"))
    return not problems, prior, problems


class JevyrClient:
    """Synchronous local daemon client. Cast is the only semantic write."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:4317",
        *,
        headers: Mapping[str, str] | None = None,
        timeout: float = 35.0,
    ) -> None:
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(float(timeout))
            or timeout <= 0
        ):
            raise ValueError("timeout must be a finite positive number of seconds")
        self.base_url = base_url.rstrip("/")
        self.headers = dict(headers or {})
        self.timeout = float(timeout)

    def cast(
        self,
        impulse: str,
        *,
        subjects: Sequence[Mapping[str, Any]] = (),
        mode: str = "auto",
        constraints: Sequence[str] = (),
        requested_assays: Sequence[str] = (),
        privacy: str = "local_only",
        control: str = "sovereign",
        seed: str | None = None,
    ) -> SealReceipt:
        if not impulse.strip():
            raise ValueError("Cast impulse cannot be empty")
        intent: Json = {
            "impulse": impulse.strip(),
            "mode": mode,
            "subjects": list(subjects),
            "constraints": list(constraints),
            "requestedAssays": list(requested_assays),
            "privacy": privacy,
            "control": control,
        }
        if seed is not None:
            intent["seed"] = seed
        value = self._json("/v1/cases", method="POST", body={"protocol": "jevyr.case/1", "case": intent})
        return _assert_seal_receipt(value)

    def trust_bundle(self) -> Json:
        return _assert_trust_bundle(self._json("/v1/trust"))

    def run_attestations(self, case_id: str) -> Json:
        """Read the two strict fixed attestation envelopes; signatures are not yet verified."""
        from .run_attestations import assert_run_attestations
        if not isinstance(case_id, str) or not re.fullmatch(r"case_[a-f0-9]{16}", case_id):
            raise ValueError("Invalid Case identifier")
        value = assert_run_attestations(self._json(f"/v1/cases/{case_id}/attestations"))
        if value["caseId"] != case_id:
            raise JevyrContinuityError("Attestations belong to a different Case")
        return value

    def verified_run_attestations(self, case_id: str) -> "VerifiedRunAttestations":
        """Verify local production/advisory and the signed closure; no SLSA level claim."""
        from .run_attestations import verify_run_attestations
        raw = self.run_attestations(case_id)
        return verify_run_attestations(raw, {
            "seal": self.seal_receipt(case_id), "record": self.record(case_id),
            "terminal": self.terminal_receipt(case_id), "trust": self.trust_bundle(),
            "sealEnvelope": self.seal_envelope(case_id), "recordEnvelope": self.record_envelope(case_id),
            "terminalEnvelope": self.terminal_envelope(case_id),
        })

    def create_draft(self, submission: Mapping[str, Any]) -> Json:
        return validate_draft(self._json("/v1/drafts", method="POST", body={**submission, "protocol": submission.get("protocol", "jevyr.case/1")}))

    def reproduce_case(self, source_case_id: str, seed: Literal["same", "new"]) -> SealReceipt:
        """Cast a new Sovereign Case from authenticated stored bytes; never recapture locators."""
        assert_juggler_case_id(source_case_id)
        if seed not in ("same", "new"):
            raise ValueError("Reproduction seed must be same or new")
        source = self.verified_seal_receipt(source_case_id).payload
        receipt = _assert_seal_receipt(self._json("/v1/reproductions", method="POST", body={"sourceCaseId": source_case_id, "seed": seed}))
        if receipt["caseId"] == source_case_id or any(receipt[key] != source[key] for key in ("subjectMaterialCaptureDigest", "policyDigest", "genomeDigest", "searchDigest")) or seed == "same" and receipt["caseDigest"] != source["caseDigest"]:
            raise JevyrContinuityError("Reproduction changed its controlled input bindings")
        authenticated = self.verified_seal_receipt(receipt["caseId"])
        if authenticated.payload != receipt:
            raise JevyrContinuityError("Reproduction response differs from its authenticated Seal")
        return receipt

    def draft(self, draft_id: str) -> Json:
        assert_draft_id(draft_id)
        value = validate_draft(self._json(f"/v1/drafts/{draft_id}"))
        if value["draftId"] != draft_id:
            raise JevyrContinuityError("Airlock returned a different draft")
        return value

    def replace_draft(self, draft_id: str, revision: int, submission: Mapping[str, Any], *, choices: Mapping[str, Any] | None = None) -> Json:
        assert_draft_id(draft_id); assert_revision(revision)
        from .airlock import validate_choices
        body: Json = {"revision": revision, "submission": {**submission, "protocol": submission.get("protocol", "jevyr.case/1")}}
        if choices is not None:
            body["choices"] = validate_choices(dict(choices))
        value = validate_draft(self._json(f"/v1/drafts/{draft_id}", method="PATCH", body=body))
        if value["draftId"] != draft_id or value["revision"] != revision + 1:
            raise JevyrContinuityError("Airlock edit returned a different draft revision")
        if choices is not None and value["choices"] != dict(choices):
            raise JevyrContinuityError("Airlock edit returned different execution choices")
        return value

    def seal_draft(self, draft_id: str, revision: int, policy_digest: str) -> Json:
        assert_draft_id(draft_id); assert_revision(revision)
        if not isinstance(policy_digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", policy_digest):
            raise ValueError("Seal requires the exact previewed policy digest")
        value = validate_draft(self._json(f"/v1/drafts/{draft_id}/seal", method="POST", body={"revision": revision, "policyDigest": policy_digest}))
        if value["draftId"] != draft_id or value["revision"] != revision or value["startup"]["policyDigest"] != policy_digest or value["state"] != "SEALED":
            raise JevyrContinuityError("Airlock Seal differs from the requested revision and policy")
        return value

    def abort(self, case_id: str) -> Json:
        assert_juggler_case_id(case_id)
        receipt = self._json(f"/v1/cases/{case_id}/abort", method="POST", body={})
        if set(receipt) != {"protocol", "caseId", "runDigest", "outcome", "resumable"} or receipt.get("protocol") != "jevyr.abort-accepted/1" or receipt.get("caseId") != case_id or not isinstance(receipt.get("runDigest"), str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", receipt["runDigest"]) or receipt.get("outcome") != "INVALID" or receipt.get("resumable") is not False:
            raise JevyrContinuityError("Invalid abort receipt")
        return receipt

    def _metabolism_context(self, case_id: str) -> tuple[Json, Json, SealReceipt]:
        assert_juggler_case_id(case_id)
        seal = self.verified_seal_receipt(case_id).payload
        allowance = allowance_from_policy(self.policy_descriptor(case_id), seal)
        offers = verify_offers(self._json(f"/v1/cases/{case_id}/metabolism"), allowance, seal)
        return offers, allowance, seal

    def metabolism_offers(self, case_id: str) -> Json:
        return self._metabolism_context(case_id)[0]

    def redeem_metabolism(self, case_id: str, ball_id: str, quantity: int) -> Json:
        assert_ball_id(ball_id); assert_quantity(quantity)
        offers, allowance, seal = self._metabolism_context(case_id)
        offered = next((offer for offer in offers["offers"] if offer["ballId"] == ball_id), None)
        if offers["admission"] != "open" or offered is None or quantity > offered["maxQuantity"]:
            raise JevyrContinuityError("Metabolic quantity is not currently offered")
        raw = self._json(f"/v1/cases/{case_id}/metabolism/redeem", method="POST", body={"ballId": ball_id, "quantity": quantity})
        value = verify_redemption(raw, allowance, seal, offers["receipts"][-1]["receipt"] if offers["receipts"] else None)
        receipt = value["receipt"]
        if receipt["ballId"] != ball_id or receipt["quantity"] != quantity or receipt["kind"] != offered["kind"] or receipt["calibrationDigest"] != offered["calibration"]["digest"]:
            raise JevyrContinuityError("Metabolic redemption differs from the exact offered ball and quantity")
        return value

    def _juggler_context(self, case_id: str) -> tuple[JugglerOffers, SealReceipt]:
        assert_juggler_case_id(case_id)
        seal = self.verified_seal_receipt(case_id).payload
        offers = assert_juggler_offers(self._json(f"/v1/cases/{case_id}/vouchers"), seal)
        return offers, seal

    def juggler_offers(self, case_id: str) -> JugglerOffers:
        """Finite scheduling offers bound to the authenticated Seal, with no semantic input."""
        return self._juggler_context(case_id)[0]

    def redeem_voucher(self, case_id: str, token: str) -> JugglerReceipt:
        """Send exactly one currently offered opaque token. Never automatically retry the POST."""
        assert_juggler_case_id(case_id)
        assert_juggler_token(token)
        offers, seal = self._juggler_context(case_id)
        offered = next((offer for offer in offers["offers"] if offer["token"] == token), None)
        if offered is None:
            raise JevyrContinuityError("Voucher is not currently offered for this Case; it may be spent or its checkpoint closed")
        raw = self._json(f"/v1/cases/{case_id}/vouchers/redeem", method="POST", body={"voucher": token})
        return verify_juggler_receipt(raw, seal, offered)

    def seal_receipt(self, case_id: str) -> SealReceipt:
        return _assert_seal_receipt(self._json(f"/v1/cases/{quote(case_id, safe='')}/seal"))

    def seal_envelope(self, case_id: str) -> Json:
        return _assert_envelope(self._json(f"/v1/cases/{quote(case_id, safe='')}/seal/envelope"))

    def intent_contract(self, case_id: str) -> IntentContract:
        """Fetch and fully validate the deterministic replay contract."""
        return assert_intent_contract_payload(
            self._json(f"/v1/cases/{quote(case_id, safe='')}/intent-contract")
        )

    def policy_descriptor(self, case_id: str) -> CasePolicyDescriptor:
        """Fetch and content-verify the policy descriptor selected by one Case."""
        return assert_case_policy_descriptor(
            self._json(f"/v1/cases/{quote(case_id, safe='')}/policy-descriptor"),
            case_id,
        )

    def verified_policy_descriptor(self, case_id: str) -> VerifiedCasePolicyDescriptor:
        """Bind verified policy bytes to the Case's authenticated crystallized Record."""
        record = self.authenticated_record(case_id)
        binding = self.policy_descriptor(case_id)
        assert_policy_descriptor_record_binding(binding, record.payload)
        return VerifiedCasePolicyDescriptor(binding=binding, record=record)

    def artifact_list(self, case_id: str) -> ArtifactList:
        """Fetch and strictly validate the complete Case artifact index."""
        value = self._json(f"/v1/cases/{quote(case_id, safe='')}/artifacts")
        return assert_artifact_list(value, case_id)

    def list_artifacts(self, case_id: str) -> list[ArtifactMeta]:
        """List only metadata that passes content-address and Case-boundary checks."""
        return self.artifact_list(case_id)["artifacts"]

    def fetch_artifact(self, case_id: str, artifact_id: str) -> VerifiedArtifact:
        """Retrieve bytes only after index, response metadata, length, and hash agree."""
        if not isinstance(artifact_id, str) or not _ARTIFACT_ID.fullmatch(artifact_id):
            raise ValueError("Artifact identifier must be canonical")
        meta = next(
            (entry for entry in self.list_artifacts(case_id) if entry["id"] == artifact_id),
            None,
        )
        if meta is None:
            raise JevyrContinuityError("Artifact index does not contain the requested artifact")
        if meta["size"] > _MAX_ARTIFACT_ENDPOINT_BYTES:
            raise JevyrContinuityError(
                f"Artifact exceeds the SDK's {_MAX_ARTIFACT_ENDPOINT_BYTES}-byte materialization limit"
            )
        if meta["mediaType"] == "application/vnd.jevyr.original-subject-assertion-certificate+json" and meta["size"] > 8 * 1_048_576:
            raise JevyrContinuityError("Original-subject certificate exceeds its 8388608-byte materialization limit")

        request = Request(
            f"{self.base_url}/v1/cases/{quote(case_id, safe='')}/artifacts/{quote(artifact_id, safe='')}",
            headers={**self.headers, "Accept": meta["mediaType"]},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                header_digest = _single_response_header(response, "x-jevyr-digest")
                if not isinstance(header_digest, str) or not _DIGEST.fullmatch(header_digest):
                    raise JevyrContinuityError(
                        "Artifact response has a missing or malformed x-jevyr-digest header"
                    )
                if header_digest != meta["digest"]:
                    raise JevyrContinuityError(
                        "Artifact response digest does not match its indexed metadata"
                    )

                header_length = _single_response_header(response, "content-length")
                if (
                    not isinstance(header_length, str)
                    or not re.fullmatch(r"(?:0|[1-9][0-9]*)", header_length)
                ):
                    raise JevyrContinuityError(
                        "Artifact response has a missing or malformed content-length header"
                    )
                advertised_length = int(header_length)
                if (
                    advertised_length > _MAX_SAFE_INTEGER
                    or advertised_length != meta["size"]
                ):
                    raise JevyrContinuityError(
                        "Artifact response length does not match its indexed metadata"
                    )

                media_type = _single_response_header(response, "content-type")
                if not isinstance(media_type, str) or media_type != meta["mediaType"]:
                    raise JevyrContinuityError(
                        "Artifact response media type does not match its indexed metadata"
                    )

                try:
                    data = _read_bounded_response(
                        response,
                        meta["size"],
                        "Artifact response body",
                    )
                except Exception as error:
                    raise JevyrContinuityError(
                        f"Artifact response body could not be read: {error}"
                    ) from error
        except HTTPError as error:
            try:
                payload = json.load(error)
            except Exception:
                payload = None
            message = payload.get("error") if isinstance(payload, dict) else str(error)
            raise JevyrHttpError(error.code, message, payload) from error
        except URLError as error:
            raise JevyrError(str(error.reason)) from error

        if not isinstance(data, bytes):
            raise JevyrContinuityError("Artifact response body was not a byte sequence")
        if len(data) != meta["size"]:
            raise JevyrContinuityError(
                "Artifact response byte length does not match its indexed metadata"
            )
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        if digest != meta["digest"]:
            raise JevyrContinuityError(
                "Artifact response bytes do not match their indexed SHA-256 digest"
            )
        return VerifiedArtifact(meta=meta, data=data)

    def artifact(self, case_id: str, artifact_id: str) -> VerifiedArtifact:
        """Concise alias for :meth:`fetch_artifact`."""
        return self.fetch_artifact(case_id, artifact_id)

    def record_envelope(self, case_id: str) -> Json:
        return _assert_envelope(self._json(f"/v1/cases/{quote(case_id, safe='')}/record/envelope"))

    def terminal_receipt(self, case_id: str) -> TerminalReceipt:
        """Fetch the strict signed-closure payload for a terminal Case."""
        receipt = assert_terminal_receipt(
            self._json(f"/v1/cases/{quote(case_id, safe='')}/terminal")
        )
        if receipt["caseId"] != case_id:
            raise JevyrContinuityError(
                "TerminalReceipt caseId does not match the requested case"
            )
        return receipt

    def terminal_envelope(self, case_id: str) -> Json:
        """Fetch the DSSE envelope over a Case's terminal closure payload."""
        return _assert_envelope(
            self._json(
                f"/v1/cases/{quote(case_id, safe='')}/terminal/envelope"
            )
        )

    def verified_seal_receipt(self, case_id: str) -> VerifiedDssePayload[SealReceipt]:
        trust = self.trust_bundle()
        receipt = self.seal_receipt(case_id)
        envelope = self.seal_envelope(case_id)
        if receipt["caseId"] != case_id:
            raise JevyrContinuityError("SealReceipt caseId does not match the requested case")
        return verify_seal_envelope(envelope, trust, receipt)

    def verified_intent_contract(self, case_id: str) -> IntentContract:
        """Bind a validated replay contract to this case's authenticated SealReceipt."""
        verified_seal = self.verified_seal_receipt(case_id)
        contract = self.intent_contract(case_id)
        if contract["digest"] != verified_seal.payload["intentContractDigest"]:
            raise JevyrContinuityError(
                "IntentContract digest does not match its authenticated SealReceipt"
            )
        return contract

    def authenticated_record(self, case_id: str) -> AuthenticatedRecord:
        """Authenticate Record and Seal provenance without replaying persisted evidence."""
        trust = self.trust_bundle()
        receipt = self.seal_receipt(case_id)
        seal_envelope = self.seal_envelope(case_id)
        record = self.record(case_id)
        record_envelope = self.record_envelope(case_id)
        if receipt["caseId"] != case_id:
            raise JevyrContinuityError("SealReceipt caseId does not match the requested case")
        verified_seal = verify_seal_envelope(seal_envelope, trust, receipt)
        verified = verify_record_envelope(record_envelope, trust, record)
        if verified_seal.key_id != verified.key_id:
            raise JevyrContinuityError(
                "Seal and Record were not authenticated by the same trusted key"
            )
        for field in ("caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest"):
            if record[field] != receipt[field]:
                raise JevyrContinuityError("Record provenance identity does not match its authenticated SealReceipt")
        if record["verdict"].get("intentContractDigest") != receipt["intentContractDigest"]:
            raise JevyrContinuityError("Record verdict intent identity does not match its authenticated SealReceipt")
        return AuthenticatedRecord(
            payload=verified.payload,
            envelope=verified.envelope,
            key_id=verified.key_id,
            payload_type=verified.payload_type,
            verification=verified.verification,
        )

    def authenticated_terminal_receipt(
        self, case_id: str
    ) -> AuthenticatedTerminalReceipt:
        """Authenticate the complete-ledger closure without replaying evidence."""
        trust = self.trust_bundle()
        receipt = self.terminal_receipt(case_id)
        envelope = self.terminal_envelope(case_id)
        verified = verify_terminal_envelope(envelope, trust, receipt)
        return AuthenticatedTerminalReceipt(
            payload=verified.payload,
            envelope=verified.envelope,
            key_id=verified.key_id,
            payload_type=verified.payload_type,
            verification=verified.verification,
        )

    def verified_terminal_receipt(
        self, case_id: str
    ) -> AuthenticatedTerminalReceipt:
        """Compatibility spelling for :meth:`authenticated_terminal_receipt`."""
        return self.authenticated_terminal_receipt(case_id)

    def verified_record(self, case_id: str) -> AuthenticatedRecord:
        """Compatibility alias for authenticated_record; evidence is not replayed."""
        return self.authenticated_record(case_id)

    def status(self, case_id: str) -> LiveCaseStatus:
        return _assert_status(self._json(f"/v1/cases/{quote(case_id, safe='')}"))

    def poll_events(self, case_id: str, cursor: int = 0, *, wait_ms: int = 0, limit: int = 500) -> LiveEventBatch:
        cursor = _non_negative_integer(cursor, "Event cursor")
        wait_ms = _non_negative_integer(wait_ms, "Event poll wait_ms", 30_000)
        limit = _non_negative_integer(limit, "Event poll limit", 2_000)
        if limit < 1:
            raise ValueError("Event poll limit must be at least one")
        query = urlencode({"after": cursor, "waitMs": wait_ms, "limit": limit})
        page = self._json(f"/v1/cases/{quote(case_id, safe='')}/events?{query}")
        return _assert_live_event_batch(page, cursor)

    def live_events(
        self,
        case_id: str,
        *,
        cursor: int = 0,
        cursor_digest: str | None = None,
        prefer_sse: bool = True,
        poll_wait_ms: int = 15_000,
        reconnect_delay: float = _DEFAULT_RECONNECT_DELAY,
        max_reconnect_delay: float = _DEFAULT_MAX_RECONNECT_DELAY,
        max_sse_failures: int = 3,
    ) -> Iterator[LiveFrame]:
        cursor = _non_negative_integer(cursor, "Event cursor")
        poll_wait_ms = _non_negative_integer(
            poll_wait_ms,
            "Event poll wait_ms",
            30_000,
        )
        max_sse_failures = _non_negative_integer(
            max_sse_failures,
            "max_sse_failures",
        )
        if max_sse_failures < 1:
            raise ValueError("max_sse_failures must be at least one")
        if not isinstance(prefer_sse, bool):
            raise ValueError("prefer_sse must be a boolean")
        retry_base, retry_ceiling = _retry_bounds(
            reconnect_delay,
            max_reconnect_delay,
        )
        current = self._retry_transport_read(
            lambda: self.status(case_id),
            retry_base,
            retry_ceiling,
        )
        if cursor > current["lastSequence"]:
            raise JevyrContinuityError(f"Cursor {cursor} is beyond ledger sequence {current['lastSequence']}")
        case_digest = current["caseDigest"]
        run_digest = current["runDigest"]
        prior_digest = self._retry_transport_read(
            lambda: self._resolve_cursor_digest(
                case_id,
                cursor,
                cursor_digest,
                current,
            ),
            retry_base,
            retry_ceiling,
        )
        failures = 0
        use_sse = prefer_sse
        last_stage_index = -1
        if self._terminal(current) and cursor == current["lastSequence"]:
            if current["headDigest"] != prior_digest:
                raise JevyrContinuityError(
                    "Terminal status head does not match the requested cursor"
                )
            return

        while True:
            if use_sse:
                request = Request(
                    f"{self.base_url}/v1/cases/{quote(case_id, safe='')}/events/stream?{urlencode({'after': cursor})}",
                    headers={**self.headers, "Accept": "text/event-stream", "Last-Event-ID": str(cursor)},
                )
                try:
                    try:
                        opened = urlopen(request, timeout=self.timeout)
                    except HTTPError as error:
                        raise self._http_error(error) from error
                    except URLError as error:
                        raise JevyrError(str(error.reason)) from error
                    with opened as response:
                        media_type = _single_response_header(response, "content-type")
                        if (
                            not isinstance(media_type, str)
                            or media_type.split(";", 1)[0].strip().lower()
                            != "text/event-stream"
                        ):
                            raise JevyrError(
                                "SSE endpoint returned a non-event-stream response"
                            )
                        messages = _decode_sse(response)
                        try:
                            for message in messages:
                                if "event" in message:
                                    raise JevyrContinuityError(
                                        "SSE emitted a named event outside the canonical default-message stream"
                                    )
                                try:
                                    raw = _loads_unambiguous(message["data"])
                                except (KeyError, json.JSONDecodeError) as error:
                                    raise JevyrContinuityError(
                                        "SSE emitted non-JSON event data"
                                    ) from error
                                event = _assert_event(
                                    raw,
                                    cursor,
                                    prior_digest,
                                    case_digest,
                                    run_digest,
                                )
                                stage_index = _STAGE_INDEX[event["stage"]]
                                if stage_index < last_stage_index:
                                    raise JevyrContinuityError(
                                        "Live event stream regressed to an earlier lifecycle stage"
                                    )
                                last_stage_index = max(last_stage_index, stage_index)
                                if message.get("id") != str(event["sequence"]):
                                    raise JevyrContinuityError(
                                        "SSE id is missing or does not match CaseEvent.sequence"
                                    )
                                cursor = event["sequence"]
                                prior_digest = event["eventDigest"]
                                failures = 0
                                yield LiveFrame(
                                    event,
                                    cursor,
                                    prior_digest,
                                    "verified",
                                    "sse",
                                )
                        finally:
                            messages.close()
                    status = self.status(case_id)
                    self._assert_observed_status(
                        current,
                        status,
                        cursor,
                        prior_digest,
                    )
                    if self._terminal(status):
                        if cursor != status["lastSequence"]:
                            raise JevyrContinuityError(
                                "SSE closed before the terminal event cursor was consumed"
                            )
                        return
                    failures += 1
                except JevyrContinuityError:
                    raise
                except BaseException as error:
                    if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                        raise
                    if not _retryable_transport_error(error):
                        raise
                    failures += 1
                if failures >= max_sse_failures:
                    use_sse = False
                else:
                    time.sleep(
                        _reconnect_backoff(
                            retry_base,
                            retry_ceiling,
                            failures,
                        )
                    )
                continue

            try:
                page = self.poll_events(case_id, cursor, wait_ms=poll_wait_ms)
                if page["caseDigest"] != case_digest or page["runDigest"] != run_digest:
                    raise JevyrContinuityError(
                        "Event batch crossed a case or run boundary"
                    )
                if not page["caughtUp"] and not page["events"]:
                    raise JevyrContinuityError(
                        "Event polling made no cursor progress before claiming more events exist"
                    )
                for raw in page["events"]:
                    event = _assert_event(
                        raw,
                        cursor,
                        prior_digest,
                        case_digest,
                        run_digest,
                    )
                    stage_index = _STAGE_INDEX[event["stage"]]
                    if stage_index < last_stage_index:
                        raise JevyrContinuityError(
                            "Live event stream regressed to an earlier lifecycle stage"
                        )
                    last_stage_index = max(last_stage_index, stage_index)
                    cursor = event["sequence"]
                    prior_digest = event["eventDigest"]
                    failures = 0
                    yield LiveFrame(
                        event,
                        cursor,
                        prior_digest,
                        "verified",
                        "poll",
                    )
                if page["caughtUp"]:
                    if page["headDigest"] != prior_digest:
                        raise JevyrContinuityError(
                            "Caught-up page head does not match consumed stream"
                        )
                    status = self.status(case_id)
                    self._assert_observed_status(
                        current,
                        status,
                        cursor,
                        prior_digest,
                    )
                    if self._terminal(status):
                        if cursor != status["lastSequence"]:
                            raise JevyrContinuityError(
                                "Polling stopped before the terminal event cursor was consumed"
                            )
                        return
                failures = 0
            except JevyrContinuityError:
                raise
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    raise
                if not _retryable_transport_error(error):
                    raise
                failures += 1
                time.sleep(
                    _reconnect_backoff(
                        retry_base,
                        retry_ceiling,
                        failures,
                    )
                )

    def events(self, case_id: str, **options: Any) -> Iterator[LiveFrame]:
        return self.live_events(case_id, **options)

    def record(self, case_id: str) -> SignedRecord:
        value = self._json(f"/v1/cases/{quote(case_id, safe='')}/record")
        return _assert_record(value)

    def wait_for_authenticated_record(
        self, case_id: str, **options: Any
    ) -> AuthenticatedTerminalRecord:
        """Bind a Record prefix to its independently signed terminal ledger head."""
        for _frame in self.live_events(case_id, **options):
            pass
        retry_base, retry_ceiling = _retry_bounds(
            options.get("reconnect_delay", _DEFAULT_RECONNECT_DELAY),
            options.get("max_reconnect_delay", _DEFAULT_MAX_RECONNECT_DELAY),
        )
        observed_terminal = self._retry_transport_read(
            lambda: self.status(case_id),
            retry_base,
            retry_ceiling,
        )
        if not self._terminal(observed_terminal):
            raise JevyrContinuityError(
                "Live observation ended before the Case reached a terminal status"
            )
        authenticated = self._await_authenticated_record(
            case_id,
            retry_base,
            retry_ceiling,
        )
        record = authenticated.payload
        if (
            record["caseDigest"] != observed_terminal["caseDigest"]
            or record["runDigest"] != observed_terminal["runDigest"]
        ):
            raise JevyrContinuityError("Record does not belong to observed case and run")
        contains_record_head, cursor, head_digest, tail_observed_at = self._scan_record_head(
            case_id,
            record,
            retry_base,
            retry_ceiling,
        )
        if not contains_record_head:
            raise JevyrContinuityError("Record eventHeadDigest is not a verified prefix of the public trace")
        final_status = self._retry_transport_read(
            lambda: self.status(case_id),
            retry_base,
            retry_ceiling,
        )
        self._assert_same_run(observed_terminal, final_status)
        if (
            not self._terminal(final_status)
            or final_status["lastSequence"] != cursor
            or final_status["headDigest"] != head_digest
        ):
            raise JevyrContinuityError(
                "Authenticated Record observation does not end at the exact terminal ledger head"
            )
        terminal = self._await_authenticated_terminal_receipt(
            case_id,
            retry_base,
            retry_ceiling,
        )
        closure = terminal.payload
        if terminal.key_id != authenticated.key_id:
            raise JevyrContinuityError(
                "Seal, Record, and terminal closure were not authenticated by the same trusted key"
            )
        if (
            closure["caseId"] != case_id
            or closure["caseDigest"] != record["caseDigest"]
            or closure["runDigest"] != record["runDigest"]
        ):
            raise JevyrContinuityError(
                "Terminal closure does not belong to the authenticated case and run"
            )
        if closure["recordDigest"] != _digest(record):
            raise JevyrContinuityError(
                "Terminal closure does not bind the canonical authenticated Record"
            )
        artifact_index = self.artifact_list(case_id)
        if closure["artifactIndexDigest"] != _digest(artifact_index):
            raise JevyrContinuityError(
                "Terminal closure does not bind the canonical Case artifact index"
            )
        if (
            closure["lastSequence"] != cursor
            or closure["eventHeadDigest"] != head_digest
        ):
            raise JevyrContinuityError(
                "Terminal closure does not bind the exact verified terminal ledger head"
            )
        if (
            closure["caseDigest"] != final_status["caseDigest"]
            or closure["runDigest"] != final_status["runDigest"]
            or closure["lifecycle"] != final_status["lifecycle"]
            or closure["stage"] != final_status["stage"]
            or closure["stageStatus"] != final_status["stageStatus"]
            or closure["lastSequence"] != final_status["lastSequence"]
            or closure["eventHeadDigest"] != final_status["headDigest"]
            or closure["closedAt"] != final_status["updatedAt"]
            or closure["closedAt"]
            != (tail_observed_at or final_status["updatedAt"])
        ):
            raise JevyrContinuityError(
                "Terminal closure does not equal the exact final status projection and verified ledger tail"
            )
        return AuthenticatedTerminalRecord(
            payload=authenticated.payload,
            envelope=authenticated.envelope,
            key_id=authenticated.key_id,
            payload_type=authenticated.payload_type,
            verification=authenticated.verification,
            terminal=terminal,
        )

    def wait_for_record(self, case_id: str, **options: Any) -> SignedRecord:
        """Compatibility payload-only wrapper; prefer wait_for_authenticated_record."""
        return self.wait_for_authenticated_record(case_id, **options).payload

    def _retry_transport_read(
        self,
        read: Callable[[], Payload],
        reconnect_delay: float,
        max_reconnect_delay: float,
    ) -> Payload:
        failures = 0
        while True:
            try:
                return read()
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    raise
                if not _retryable_transport_error(error):
                    raise
                failures += 1
                time.sleep(
                    _reconnect_backoff(
                        reconnect_delay,
                        max_reconnect_delay,
                        failures,
                    )
                )

    def _await_authenticated_record(
        self,
        case_id: str,
        reconnect_delay: float,
        max_reconnect_delay: float,
    ) -> AuthenticatedRecord:
        failures = 0
        while True:
            try:
                return self.authenticated_record(case_id)
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    raise
                record_pending = isinstance(error, JevyrHttpError) and error.status in {
                    404,
                    409,
                }
                if not record_pending and not _retryable_transport_error(error):
                    raise
                failures += 1
                time.sleep(
                    _reconnect_backoff(
                        reconnect_delay,
                        max_reconnect_delay,
                        failures,
                    )
                )

    def _await_authenticated_terminal_receipt(
        self,
        case_id: str,
        reconnect_delay: float,
        max_reconnect_delay: float,
    ) -> AuthenticatedTerminalReceipt:
        failures = 0
        while True:
            try:
                return self.authenticated_terminal_receipt(case_id)
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    raise
                closure_pending = isinstance(error, JevyrHttpError) and error.status in {
                    404,
                    409,
                }
                if not closure_pending and not _retryable_transport_error(error):
                    raise
                failures += 1
                time.sleep(
                    _reconnect_backoff(
                        reconnect_delay,
                        max_reconnect_delay,
                        failures,
                    )
                )

    def _scan_record_head(
        self,
        case_id: str,
        record: Mapping[str, Any],
        reconnect_delay: float,
        max_reconnect_delay: float,
    ) -> tuple[bool, int, str | None, str | None]:
        cursor = 0
        prior_digest: str | None = None
        tail_observed_at: str | None = None
        contains_record_head = False
        last_stage_index = -1
        while True:
            page = self._retry_transport_read(
                lambda: self.poll_events(case_id, cursor, limit=2_000),
                reconnect_delay,
                max_reconnect_delay,
            )
            if page["caseDigest"] != record["caseDigest"] or page["runDigest"] != record["runDigest"]:
                raise JevyrContinuityError("Record prefix lookup crossed a case or run boundary")
            for raw in page["events"]:
                event = _assert_event(raw, cursor, prior_digest, str(record["caseDigest"]), str(record["runDigest"]))
                stage_index = _STAGE_INDEX[event["stage"]]
                if stage_index < last_stage_index:
                    raise JevyrContinuityError(
                        "Record prefix lookup found a lifecycle stage regression"
                    )
                last_stage_index = max(last_stage_index, stage_index)
                cursor = event["sequence"]
                prior_digest = event["eventDigest"]
                tail_observed_at = event["observedAt"]
                if event["eventDigest"] == record["eventHeadDigest"]:
                    contains_record_head = True
            if page["caughtUp"]:
                if page["headDigest"] != prior_digest:
                    raise JevyrContinuityError(
                        "Record prefix lookup ended at a different public ledger head"
                    )
                return contains_record_head, cursor, prior_digest, tail_observed_at
            if not page["events"]:
                raise JevyrContinuityError("Record prefix lookup made no cursor progress")

    def _resolve_cursor_digest(self, case_id: str, cursor: int, supplied: str | None, status: Json) -> str | None:
        if cursor == 0:
            if supplied is not None:
                raise JevyrContinuityError("cursor_digest is invalid when cursor is zero")
            return None
        if supplied is not None:
            if not isinstance(supplied, str) or not _DIGEST.fullmatch(supplied):
                raise JevyrContinuityError("cursor_digest must be a canonical SHA-256 digest")
            if cursor == status["lastSequence"] and supplied != status["headDigest"]:
                raise JevyrContinuityError("cursor_digest does not match status headDigest")
            return supplied
        if cursor == status["lastSequence"]:
            if status["headDigest"] is None:
                raise JevyrContinuityError("Status has no digest for the requested cursor")
            return str(status["headDigest"])
        anchor = self.poll_events(case_id, cursor - 1, limit=1)
        if anchor["caseDigest"] != status["caseDigest"] or anchor["runDigest"] != status["runDigest"] or not anchor["events"] or anchor["events"][0]["sequence"] != cursor:
            raise JevyrContinuityError(f"Unable to resolve digest for cursor {cursor}")
        return str(anchor["events"][0]["eventDigest"])

    @staticmethod
    def _terminal(status: Mapping[str, Any]) -> bool:
        return status.get("lifecycle") in {"terminated", "invalid"}

    @staticmethod
    def _assert_same_run(initial: Mapping[str, Any], current: Mapping[str, Any]) -> None:
        if initial.get("caseDigest") != current.get("caseDigest") or initial.get("runDigest") != current.get("runDigest"):
            raise JevyrContinuityError("Status crossed a case or run boundary")

    @classmethod
    def _assert_observed_status(
        cls,
        initial: Mapping[str, Any],
        current: Mapping[str, Any],
        cursor: int,
        head_digest: str | None,
    ) -> None:
        cls._assert_same_run(initial, current)
        if current["lastSequence"] < cursor:
            raise JevyrContinuityError("Status event cursor moved backwards")
        if (
            current["lastSequence"] == cursor
            and current["headDigest"] != head_digest
        ):
            raise JevyrContinuityError(
                "Status head does not match the consumed event cursor"
            )

    def _json(self, path: str, *, method: str = "GET", body: Any = None) -> Json:
        encoded = None if body is None else _canonical(body)
        headers = {**self.headers, "Accept": "application/json"}
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=encoded, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                try:
                    value = _loads_unambiguous(
                        _read_bounded_response(
                            response,
                            _MAX_JSON_ENDPOINT_BYTES,
                            "JSON endpoint body",
                        )
                    )
                except Exception as error:
                    raise JevyrContinuityError(
                        f"JSON endpoint returned a malformed body: {error}"
                    ) from error
        except HTTPError as error:
            raise self._http_error(error) from error
        except URLError as error:
            raise JevyrError(str(error.reason)) from error
        if not isinstance(value, dict):
            raise JevyrContinuityError("Jevyr endpoint returned a non-object JSON response")
        return value

    @staticmethod
    def _http_error(error: HTTPError) -> JevyrHttpError:
        try:
            try:
                payload = _loads_unambiguous(
                    _read_bounded_response(
                        error,
                        _MAX_JSON_ERROR_BYTES,
                        "JSON error body",
                    )
                )
            except Exception:
                payload = None
        finally:
            error.close()
        message = payload.get("error") if isinstance(payload, dict) else str(error)
        return JevyrHttpError(error.code, message, payload)
