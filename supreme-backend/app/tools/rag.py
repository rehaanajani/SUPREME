"""
app/tools/rag.py — Retrieval-Augmented Generation via Qdrant.

Two modes:
  1. Semantic search  — when an embedding provider key is set
  2. Keyword fallback — simple substring scan over stored payloads

Filter by role:
  prosecution → looks for "conviction" bias in metadata
  defense     → looks for "acquittal" bias in metadata
"""

from __future__ import annotations

import logging
from typing import Any

from config import (
    EMBEDDING_PROVIDER,
    OPENAI_API_KEY,
    NVIDIA_API_KEY,
    NVIDIA_BASE_URL,
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_COLLECTION,
    EMBEDDING_MODEL,
    QDRANT_VECTOR_SIZE,
    ENABLE_RAG_DEBUG,
)
from app.models.trial import AgentRole, Citation, ToolCallTrace

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy-initialise heavy clients so import never crashes
# ---------------------------------------------------------------------------

_qdrant_client: Any = None
_embedding_client: Any = None
_embedding_client_provider: str | None = None


def _debug(event: str, **kwargs: Any) -> None:
    if not ENABLE_RAG_DEBUG:
        return
    details = " ".join(f"{key}={value}" for key, value in kwargs.items())
    logger.info("RAG_DEBUG event=%s %s", event, details)


def _get_qdrant():
    global _qdrant_client
    if _qdrant_client is None:
        try:
            from qdrant_client import QdrantClient
            kwargs: dict = {"url": QDRANT_URL, "timeout": 5}
            if QDRANT_API_KEY:
                kwargs["api_key"] = QDRANT_API_KEY
            _qdrant_client = QdrantClient(**kwargs)
            _debug("qdrant_client_init_ok", url=QDRANT_URL, has_api_key=bool(QDRANT_API_KEY))
        except Exception as exc:
            logger.warning("Qdrant unavailable: %s", exc)
            _debug("qdrant_client_init_failed", error=exc)
    return _qdrant_client


def _resolve_embedding_config() -> tuple[str | None, str, str | None]:
    """Resolve embedding provider/auth based on env config."""
    provider = EMBEDDING_PROVIDER

    if provider == "openai":
        return "openai", OPENAI_API_KEY, None
    if provider == "nvidia":
        return "nvidia", NVIDIA_API_KEY, NVIDIA_BASE_URL

    # auto mode
    if OPENAI_API_KEY:
        return "openai", OPENAI_API_KEY, None
    if NVIDIA_API_KEY:
        return "nvidia", NVIDIA_API_KEY, NVIDIA_BASE_URL
    return None, "", None


def _get_embedding_client():
    global _embedding_client, _embedding_client_provider
    if _embedding_client is None:
        provider, api_key, base_url = _resolve_embedding_config()
        if not provider or not api_key:
            _debug(
                "embedding_client_skipped_no_key",
                configured_provider=EMBEDDING_PROVIDER,
            )
            return None
        try:
            from openai import AsyncOpenAI

            kwargs: dict[str, Any] = {"api_key": api_key}
            if base_url:
                kwargs["base_url"] = base_url

            _embedding_client = AsyncOpenAI(**kwargs)
            _embedding_client_provider = provider
            _debug(
                "embedding_client_init_ok",
                provider=provider,
                embedding_model=EMBEDDING_MODEL,
                base_url=(base_url or "openai-default"),
            )
        except Exception as exc:
            logger.warning("Embedding client init failed: %s", exc)
            _debug("embedding_client_init_failed", error=exc)
    return _embedding_client


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

async def _embed(text: str) -> list[float] | None:
    """Return an embedding vector or None on failure."""
    client = _get_embedding_client()
    if client is None:
        _debug("embed_skipped_no_embedding_client")
        return None
    try:
        provider, _, _ = _resolve_embedding_config()
        request_kwargs: dict[str, Any] = {
            "input": [text],
            "model": EMBEDDING_MODEL,
        }
        if provider == "nvidia":
            # NV-EmbedQA models are asymmetric and require an input_type.
            request_kwargs["extra_body"] = {"input_type": "query"}

        response = await client.embeddings.create(**request_kwargs)
        _debug("embed_ok", vector_size=len(response.data[0].embedding))
        return response.data[0].embedding
    except Exception as exc:
        logger.warning("Embedding failed: %s", exc)
        _debug("embed_failed", error=exc)
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
    citations = [
        Citation(
            case_id=rec["case_id"],
            summary=rec["summary"],
            relevance_score=round(score, 3),
        )
        for score, rec in results[:top_k]
        if score > 0
    ]
    _debug("keyword_search", bias_filter=bias_filter, hits=len(citations), query=query[:120])
    return citations


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

        points: list[Any] = []

        # qdrant-client API changed; use query_points when available.
        if hasattr(client, "query_points"):
            try:
                response = client.query_points(
                    collection_name=QDRANT_COLLECTION,
                    query=vector,
                    query_filter=flt,
                    limit=top_k,
                    with_payload=True,
                    with_vectors=False,
                )
                points = list(getattr(response, "points", []) or [])
            except Exception as exc:
                # Some clusters require a payload index for filtered queries.
                if bias_filter and "Index required but not found" in str(exc):
                    _debug("qdrant_bias_index_missing_retry_unfiltered", error=exc)
                    response = client.query_points(
                        collection_name=QDRANT_COLLECTION,
                        query=vector,
                        limit=max(top_k * 4, 10),
                        with_payload=True,
                        with_vectors=False,
                    )
                    unfiltered = list(getattr(response, "points", []) or [])
                    points = [
                        point
                        for point in unfiltered
                        if (getattr(point, "payload", None) or {}).get("bias") == bias_filter
                    ][:top_k]
                else:
                    raise
        else:
            hits = client.search(
                collection_name=QDRANT_COLLECTION,
                query_vector=vector,
                query_filter=flt,
                limit=top_k,
            )
            points = list(hits)

        citations = []
        for point in points:
            payload = getattr(point, "payload", None) or {}
            point_id = getattr(point, "id", None)
            score = float(getattr(point, "score", 0.0) or 0.0)
            citations.append(
                Citation(
                    case_id=payload.get("case_id", str(point_id) if point_id is not None else "unknown"),
                    summary=payload.get("summary", ""),
                    relevance_score=round(score, 3),
                )
            )
        _debug(
            "qdrant_search",
            collection=QDRANT_COLLECTION,
            bias_filter=bias_filter,
            hits=len(citations),
            top_case=(citations[0].case_id if citations else "none"),
        )
        return citations
    except Exception as exc:
        logger.warning("Qdrant search failed: %s", exc)
        _debug("qdrant_search_failed", collection=QDRANT_COLLECTION, error=exc)
        return []


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def retrieve_precedents(
    query: str,
    role: AgentRole,
    top_k: int = 3,
) -> list[Citation]:
    citations, _ = await retrieve_precedents_with_trace(query, role, top_k)
    return citations


async def retrieve_precedents_with_trace(
    query: str,
    role: AgentRole,
    top_k: int = 3,
) -> tuple[list[Citation], ToolCallTrace]:
    """
    Retrieve legal precedents relevant to *query* for the given *role*.

    Strategy:
      1. Try semantic search via configured embeddings provider + Qdrant.
      2. Fall back to keyword search over the built-in demo bank.
    """
    bias_filter = _BIAS_MAP.get(role)
    provider, key, _ = _resolve_embedding_config()
    _debug(
        "retrieve_precedents_start",
        role=role,
        top_k=top_k,
        embedding_provider=(provider or "none"),
        has_embedding_key=bool(key),
        qdrant_collection=QDRANT_COLLECTION,
    )

    source = "keyword"

    # Attempt semantic path
    vector = await _embed(query)
    if vector:
        citations = _qdrant_search(vector, bias_filter, top_k)
        if citations:
            source = "qdrant"
            _debug("retrieve_precedents_end", source=source, hits=len(citations))
            return citations, ToolCallTrace(
                name="retrieve_precedents",
                status="success",
                input={
                    "query": query,
                    "role": role,
                    "top_k": top_k,
                    "bias_filter": bias_filter,
                },
                output={
                    "source": source,
                    "citations": [citation.model_dump() for citation in citations],
                },
            )
        logger.debug("Qdrant returned no results; falling back to keyword search.")
        _debug("qdrant_empty_fallback_keyword")

    # Keyword fallback
    citations = _keyword_search(query, bias_filter, top_k)
    _debug("retrieve_precedents_end", source=source, hits=len(citations))
    return citations, ToolCallTrace(
        name="retrieve_precedents",
        status="success",
        input={
            "query": query,
            "role": role,
            "top_k": top_k,
            "bias_filter": bias_filter,
        },
        output={
            "source": source,
            "citations": [citation.model_dump() for citation in citations],
        },
    )


def rag_diagnostics() -> dict[str, Any]:
    """Return current RAG runtime diagnostics for debugging."""
    provider, key, base_url = _resolve_embedding_config()

    diagnostics: dict[str, Any] = {
        "embedding_provider_configured": EMBEDDING_PROVIDER,
        "embedding_provider_effective": provider or "none",
        "embedding_model": EMBEDDING_MODEL,
        "embedding_key_set": bool(key),
        "openai_api_key_set": bool(OPENAI_API_KEY),
        "nvidia_api_key_set": bool(NVIDIA_API_KEY),
        "embedding_base_url": (base_url or "openai-default") if provider else None,
        "embedding_client_provider": _embedding_client_provider,
        "qdrant_url": QDRANT_URL,
        "qdrant_collection": QDRANT_COLLECTION,
        "qdrant_vector_size": QDRANT_VECTOR_SIZE,
        "qdrant_api_key_set": bool(QDRANT_API_KEY),
        "qdrant_client_available": False,
        "collection_exists": False,
        "collection_points_count": None,
        "errors": [],
    }

    client = _get_qdrant()
    diagnostics["qdrant_client_available"] = client is not None
    if client is None:
        diagnostics["errors"].append("Qdrant client unavailable.")
        return diagnostics

    try:
        collections = client.get_collections().collections
        names = [collection.name for collection in collections]
        diagnostics["collections"] = names
        diagnostics["collection_exists"] = QDRANT_COLLECTION in names
    except Exception as exc:
        diagnostics["errors"].append(f"Failed to list collections: {exc}")
        return diagnostics

    if diagnostics["collection_exists"]:
        try:
            info = client.get_collection(QDRANT_COLLECTION)
            diagnostics["collection_points_count"] = getattr(info, "points_count", None)
        except Exception as exc:
            diagnostics["errors"].append(f"Failed to inspect collection '{QDRANT_COLLECTION}': {exc}")

    return diagnostics
