from __future__ import annotations

from time import perf_counter
from typing import Optional

from app.models.trial import DiagnosticsModel, DiagnosticsRag, DiagnosticsTiming, RequestDiagnostics
from app.observability.request_context import get_request_id


def now_ms() -> float:
    return perf_counter() * 1000.0


def build_request_diagnostics(
    started_at_ms: float,
    model_id: Optional[str] = None,
    rag_source: Optional[str] = None,
) -> RequestDiagnostics:
    total = int(max(0, round(now_ms() - started_at_ms)))
    return RequestDiagnostics(
        request_id=get_request_id(),
        timings_ms=DiagnosticsTiming(total=total),
        model=DiagnosticsModel(id=model_id, provider="openrouter") if model_id else None,
        rag=DiagnosticsRag(source=rag_source) if rag_source else None,
    )
