"""
app/tools/rag.py — Retrieval-Augmented Generation via Qdrant.

Two modes:
  1. Semantic search  — when OPENAI_API_KEY is set (uses text-embedding-3-small)
  2. Keyword fallback — simple substring scan over stored payloads

Filter by role:
  prosecution → looks for "conviction" bias in metadata
  defense     → looks for "acquittal" bias in metadata
"""

from __future__ import annotations

import logging
from typing import Any

from config import (
    OPENAI_API_KEY,
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_COLLECTION,
    EMBEDDING_MODEL,
    QDRANT_VECTOR_SIZE,
)
from app.models.trial import AgentRole, Citation

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy-initialise heavy clients so import never crashes
# ---------------------------------------------------------------------------

_qdrant_client: Any = None
_openai_client: Any = None


def _get_qdrant():
    global _qdrant_client
    if _qdrant_client is None:
        try:
            from qdrant_client import QdrantClient
            kwargs: dict = {"url": QDRANT_URL, "timeout": 5}
            if QDRANT_API_KEY:
                kwargs["api_key"] = QDRANT_API_KEY
            _qdrant_client = QdrantClient(**kwargs)
        except Exception as exc:
            logger.warning("Qdrant unavailable: %s", exc)
    return _qdrant_client


def _get_openai():
    global _openai_client
    if _openai_client is None and OPENAI_API_KEY:
        try:
            from openai import AsyncOpenAI
            _openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        except Exception as exc:
            logger.warning("OpenAI client init failed: %s", exc)
    return _openai_client


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

async def _embed(text: str) -> list[float] | None:
    """Return an embedding vector or None on failure."""
    client = _get_openai()
    if client is None:
        return None
    try:
        response = await client.embeddings.create(
            input=[text], model=EMBEDDING_MODEL
        )
        return response.data[0].embedding
    except Exception as exc:
        logger.warning("Embedding failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Keyword fallback
# ---------------------------------------------------------------------------

_KEYWORD_BANK: list[dict] = [
    {
        "case_id": "DEMO-001",
        "summary": (
            "State v. Jones — Conviction upheld on circumstantial evidence "
            "corroborated by multiple witnesses. Precedent supports conviction "
            "where physical evidence aligns with testimony."
        ),
        "bias": "conviction",
        "keywords": ["evidence", "witness", "circumstantial"],
    },
    {
        "case_id": "DEMO-002",
        "summary": (
            "People v. Martinez — Acquittal granted due to reasonable doubt. "
            "Chain of custody broken; forensic report inadmissible. "
            "Precedent supports acquittal where evidence integrity is compromised."
        ),
        "bias": "acquittal",
        "keywords": ["doubt", "inadmissible", "chain", "custody", "forensic"],
    },
    {
        "case_id": "DEMO-003",
        "summary": (
            "Commonwealth v. Patel — Conviction secured through digital evidence. "
            "Court confirmed that metadata from electronic devices is admissible "
            "under the Electronic Records Act."
        ),
        "bias": "conviction",
        "keywords": ["digital", "electronic", "metadata", "records"],
    },
    {
        "case_id": "DEMO-004",
        "summary": (
            "In re: Reyes — Acquittal on self-defence grounds. "
            "Testimony of the accused held credible; prosecution failed to "
            "disprove imminent threat beyond reasonable doubt."
        ),
        "bias": "acquittal",
        "keywords": ["self-defence", "threat", "testimony", "credible"],
    },
]

_BIAS_MAP = {
    AgentRole.PROSECUTION: "conviction",
    AgentRole.DEFENSE:     "acquittal",
    AgentRole.JUDGE:       None,   # judge sees everything
}


def _keyword_search(query: str, bias_filter: str | None, top_k: int) -> list[Citation]:
    query_lower = query.lower()
    results: list[tuple[float, dict]] = []

    for record in _KEYWORD_BANK:
        if bias_filter and record["bias"] != bias_filter:
            continue
        score = sum(
            1.0 for kw in record["keywords"] if kw in query_lower
        ) / max(len(record["keywords"]), 1)
        results.append((score, record))

    results.sort(key=lambda x: x[0], reverse=True)
    return [
        Citation(
            case_id=rec["case_id"],
            summary=rec["summary"],
            relevance_score=round(score, 3),
        )
        for score, rec in results[:top_k]
        if score > 0
    ]


# ---------------------------------------------------------------------------
# Qdrant semantic search
# ---------------------------------------------------------------------------

def _qdrant_search(
    vector: list[float], bias_filter: str | None, top_k: int
) -> list[Citation]:
    client = _get_qdrant()
    if client is None:
        return []

    try:
        from qdrant_client.models import Filter, FieldCondition, MatchValue

        flt = None
        if bias_filter:
            flt = Filter(
                must=[FieldCondition(key="bias", match=MatchValue(value=bias_filter))]
            )

        hits = client.search(
            collection_name=QDRANT_COLLECTION,
            query_vector=vector,
            query_filter=flt,
            limit=top_k,
        )
        return [
            Citation(
                case_id=h.payload.get("case_id", h.id),
                summary=h.payload.get("summary", ""),
                relevance_score=round(h.score, 3),
            )
            for h in hits
        ]
    except Exception as exc:
        logger.warning("Qdrant search failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def retrieve_precedents(
    query: str,
    role: AgentRole,
    top_k: int = 3,
) -> list[Citation]:
    """
    Retrieve legal precedents relevant to *query* for the given *role*.

    Strategy:
      1. Try semantic search via OpenAI embeddings + Qdrant.
      2. Fall back to keyword search over the built-in demo bank.
    """
    bias_filter = _BIAS_MAP.get(role)

    # Attempt semantic path
    vector = await _embed(query)
    if vector:
        citations = _qdrant_search(vector, bias_filter, top_k)
        if citations:
            return citations
        logger.debug("Qdrant returned no results; falling back to keyword search.")

    # Keyword fallback
    return _keyword_search(query, bias_filter, top_k)
