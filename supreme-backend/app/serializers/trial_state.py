from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.models.trial import TranscriptEntry, TrialState
from config import EXPOSE_DEBUG_TRACES

REDACTED_PLACEHOLDER = "[REDACTED BY COURT ORDER]"


def serialize_public_state(state: TrialState) -> dict[str, Any]:
    payload = deepcopy(state.model_dump())
    transcript = payload.get("transcript", [])

    for entry in transcript:
        _sanitize_entry_dict(entry)

    return payload


def serialize_public_entry(entry: TranscriptEntry) -> dict[str, Any]:
    payload = deepcopy(entry.model_dump())
    _sanitize_entry_dict(payload)
    return payload


def _sanitize_entry_dict(entry: dict[str, Any]) -> None:
    if entry.get("redacted"):
        entry["content"] = REDACTED_PLACEHOLDER
    if not EXPOSE_DEBUG_TRACES:
        entry["debug"] = None
