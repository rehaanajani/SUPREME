"""
scripts/ingest_ecourt.py — Ingest eCourt JSON precedents into Qdrant.

Usage:
    python scripts/ingest_ecourt.py --dir data/ecourt_cases/
    python scripts/ingest_ecourt.py --file data/ecourt_cases/sample.json

Each JSON file must be an object OR a list of objects with at least:
    { "case_id", "title", "facts", "arguments", "judgment" }

The script chunks each case into three sections (facts / arguments / judgment),
embeds them (OpenAI or NVIDIA if configured) or uses zero-vectors, and upserts
to Qdrant with payload metadata including a bias tag.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
import sys
import uuid
from pathlib import Path
from typing import Any, Callable

# Make sure project root is on path when run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import (
    EMBEDDING_PROVIDER,
    OPENAI_API_KEY,
    NVIDIA_API_KEY,
    NVIDIA_BASE_URL,
    QDRANT_COLLECTION,
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_VECTOR_SIZE,
    EMBEDDING_MODEL,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger("ingest")

RETRY_MAX_ATTEMPTS = int(os.getenv("INGEST_RETRY_MAX_ATTEMPTS", "8"))
RETRY_BASE_DELAY_SECONDS = float(os.getenv("INGEST_RETRY_BASE_DELAY_SECONDS", "1.0"))
RETRY_MAX_DELAY_SECONDS = float(os.getenv("INGEST_RETRY_MAX_DELAY_SECONDS", "30.0"))


def _retry_delay(attempt: int) -> float:
    return min(RETRY_MAX_DELAY_SECONDS, RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt - 1)))


def _run_with_retry(name: str, fn: Callable[[], Any]) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, RETRY_MAX_ATTEMPTS + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt >= RETRY_MAX_ATTEMPTS:
                break
            delay = _retry_delay(attempt)
            logger.warning(
                "%s failed (attempt %d/%d): %s | retrying in %.1fs",
                name,
                attempt,
                RETRY_MAX_ATTEMPTS,
                exc,
                delay,
            )
            time.sleep(delay)

    raise RuntimeError(f"{name} failed after {RETRY_MAX_ATTEMPTS} attempts: {last_error}")


async def _run_async_with_retry(name: str, fn: Callable[[], Any]) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, RETRY_MAX_ATTEMPTS + 1):
        try:
            return await fn()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt >= RETRY_MAX_ATTEMPTS:
                break
            delay = _retry_delay(attempt)
            logger.warning(
                "%s failed (attempt %d/%d): %s | retrying in %.1fs",
                name,
                attempt,
                RETRY_MAX_ATTEMPTS,
                exc,
                delay,
            )
            await asyncio.sleep(delay)

    raise RuntimeError(f"{name} failed after {RETRY_MAX_ATTEMPTS} attempts: {last_error}")

# ── Qdrant setup ──────────────────────────────────────────────────────────────

def _get_qdrant():
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, PayloadSchemaType, VectorParams

    def _extract_vector_size(collection_info: Any) -> int | None:
        vectors = getattr(getattr(getattr(collection_info, "config", None), "params", None), "vectors", None)
        if vectors is None:
            return None
        size = getattr(vectors, "size", None)
        if size is not None:
            return int(size)
        if isinstance(vectors, dict):
            for value in vectors.values():
                value_size = getattr(value, "size", None)
                if value_size is not None:
                    return int(value_size)
        return None

    kwargs: dict[str, Any] = {"url": QDRANT_URL, "timeout": 10}
    if QDRANT_API_KEY:
        kwargs["api_key"] = QDRANT_API_KEY

    client = QdrantClient(**kwargs)

    existing = [
        c.name
        for c in _run_with_retry("qdrant_get_collections", lambda: client.get_collections()).collections
    ]
    if QDRANT_COLLECTION not in existing:
        _run_with_retry(
            "qdrant_create_collection",
            lambda: client.create_collection(
                collection_name=QDRANT_COLLECTION,
                vectors_config=VectorParams(size=QDRANT_VECTOR_SIZE, distance=Distance.COSINE),
            ),
        )
        logger.info("Created collection '%s'.", QDRANT_COLLECTION)
    else:
        info = _run_with_retry(
            "qdrant_get_collection",
            lambda: client.get_collection(QDRANT_COLLECTION),
        )
        existing_size = _extract_vector_size(info)
        if existing_size is not None and existing_size != QDRANT_VECTOR_SIZE:
            raise RuntimeError(
                "Qdrant collection vector size mismatch for "
                f"'{QDRANT_COLLECTION}': existing={existing_size}, expected={QDRANT_VECTOR_SIZE}. "
                "Use a new QDRANT_COLLECTION or update QDRANT_VECTOR_SIZE and re-ingest."
            )
        logger.info("Collection '%s' already exists.", QDRANT_COLLECTION)

    # Ensure payload index for bias filter used by retrieval.
    _run_with_retry(
        "qdrant_create_bias_index",
        lambda: client.create_payload_index(
            collection_name=QDRANT_COLLECTION,
            field_name="bias",
            field_schema=PayloadSchemaType.KEYWORD,
        ),
    )
    logger.info("Ensured payload index on 'bias'.")

    return client


# ── Embedding ─────────────────────────────────────────────────────────────────

async def _embed(texts: list[str]) -> list[list[float]]:
    """Return embeddings or zero-vectors if no embedding provider is configured."""

    provider = EMBEDDING_PROVIDER
    api_key = ""
    base_url: str | None = None

    if provider == "openai":
        api_key = OPENAI_API_KEY
    elif provider == "nvidia":
        api_key = NVIDIA_API_KEY
        base_url = NVIDIA_BASE_URL
    else:
        if OPENAI_API_KEY:
            provider = "openai"
            api_key = OPENAI_API_KEY
        elif NVIDIA_API_KEY:
            provider = "nvidia"
            api_key = NVIDIA_API_KEY
            base_url = NVIDIA_BASE_URL

    if not api_key:
        logger.warning("No embedding API key configured — using zero vectors (keyword fallback will still work).")
        return [[0.0] * QDRANT_VECTOR_SIZE for _ in texts]

    from openai import AsyncOpenAI

    if base_url:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    else:
        client = AsyncOpenAI(api_key=api_key)
    logger.info("Embedding provider: %s | model: %s", provider, EMBEDDING_MODEL)
    request_kwargs: dict[str, Any] = {
        "input": texts,
        "model": EMBEDDING_MODEL,
    }
    if provider == "nvidia":
        # Passages/documents during ingestion
        request_kwargs["extra_body"] = {"input_type": "passage"}

    resp = await _run_async_with_retry(
        "embeddings_create",
        lambda: client.embeddings.create(**request_kwargs),
    )
    return [item.embedding for item in resp.data]


# ── Chunking ──────────────────────────────────────────────────────────────────

def _split_text_for_embedding(
    text: str,
    max_words: int = 120,
    overlap_words: int = 20,
) -> list[str]:
    """Split long text into overlapping word windows for embedding limits."""
    words = text.split()
    if not words:
        return []
    if len(words) <= max_words:
        return [text]

    stride = max(1, max_words - overlap_words)
    chunks: list[str] = []
    for start in range(0, len(words), stride):
        part = words[start : start + max_words]
        if not part:
            break
        part_text = " ".join(part)
        if len(part_text) > 1000:
            part_text = part_text[:1000]
        chunks.append(part_text)
        if start + max_words >= len(words):
            break
    return chunks


def _chunk_case(case: dict[str, Any]) -> list[dict[str, Any]]:
    """Split a case into payload chunks: facts, arguments, judgment (with subchunks)."""
    case_id = case.get("case_id", str(uuid.uuid4()))
    title   = case.get("title", "Untitled Case")
    bias    = _detect_bias(case)

    chunks = []
    for section in ("facts", "arguments", "judgment"):
        text = case.get(section, "").strip()
        if not text:
            continue

        section_parts = _split_text_for_embedding(text)
        for idx, part_text in enumerate(section_parts, start=1):
            chunks.append(
                {
                    "id":      str(uuid.uuid4()),
                    "text":    f"{title} — {section.upper()} (part {idx}/{len(section_parts)}): {part_text}",
                    "payload": {
                        "case_id": case_id,
                        "title":   title,
                        "section": section,
                        "section_part": idx,
                        "section_parts": len(section_parts),
                        "summary": part_text[:300],
                        "bias":    bias,
                    },
                }
            )
    return chunks


def _detect_bias(case: dict[str, Any]) -> str:
    """
    Heuristically tag a case as 'conviction' or 'acquittal' based on judgment text.
    """
    judgment = case.get("judgment", "").lower()
    if any(kw in judgment for kw in ["convicted", "guilty", "sentenced", "conviction"]):
        return "conviction"
    if any(kw in judgment for kw in ["acquitted", "not guilty", "discharged", "acquittal"]):
        return "acquittal"
    return "conviction"  # default


# ── Upsert ────────────────────────────────────────────────────────────────────

async def _upsert_chunks(client, chunks: list[dict[str, Any]]) -> None:
    from qdrant_client.models import PointStruct

    points: list[Any] = []

    embed_batch_size = 8
    for i in range(0, len(chunks), embed_batch_size):
        embed_batch = chunks[i : i + embed_batch_size]
        texts = [c["text"] for c in embed_batch]
        try:
            vectors = await _embed(texts)
        except Exception:
            # If provider rejects one input in batch (e.g. token limit), retry individually
            vectors = []
            for text in texts:
                try:
                    vectors.extend(await _embed([text]))
                except Exception:
                    vectors.append([0.0] * QDRANT_VECTOR_SIZE)
        points.extend(
            PointStruct(id=c["id"], vector=v, payload=c["payload"])
            for c, v in zip(embed_batch, vectors)
        )

    _run_with_retry(
        "qdrant_upsert",
        lambda: client.upsert(collection_name=QDRANT_COLLECTION, points=points),
    )
    logger.info("Upserted %d chunks.", len(points))


# ── File / directory loading ──────────────────────────────────────────────────

def _load_cases(path: str) -> list[dict[str, Any]]:
    p = Path(path)
    files: list[Path] = []

    if p.is_dir():
        files = list(p.glob("**/*.json"))
        logger.info("Found %d JSON files in '%s'.", len(files), path)
    elif p.is_file():
        files = [p]
    else:
        logger.error("Path '%s' does not exist.", path)
        sys.exit(1)

    cases: list[dict] = []
    for f in files:
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                cases.extend(raw)
            elif isinstance(raw, dict):
                cases.append(raw)
        except Exception as exc:
            logger.warning("Skipping '%s': %s", f, exc)

    logger.info("Loaded %d total cases.", len(cases))
    return cases


# ── Main ──────────────────────────────────────────────────────────────────────

async def main(path: str) -> None:
    qdrant = _get_qdrant()
    cases  = _load_cases(path)

    if not cases:
        logger.warning("No cases loaded — nothing to ingest.")
        return

    all_chunks: list[dict] = []
    for case in cases:
        all_chunks.extend(_chunk_case(case))

    logger.info("Total chunks to ingest: %d", len(all_chunks))

    # Batch in groups of 50 to avoid oversized requests
    batch_size = 50
    failed_batch_starts: list[int] = []
    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        try:
            await _upsert_chunks(qdrant, batch)
        except Exception as exc:  # noqa: BLE001
            logger.error("Batch %d failed after retries: %s", (i // batch_size) + 1, exc)
            failed_batch_starts.append(i)

    if failed_batch_starts:
        logger.warning("Retrying %d failed batches once more.", len(failed_batch_starts))
        still_failed = 0
        for start in failed_batch_starts:
            batch = all_chunks[start : start + batch_size]
            try:
                await _upsert_chunks(qdrant, batch)
            except Exception as exc:  # noqa: BLE001
                still_failed += 1
                logger.error(
                    "Final retry failed for batch %d: %s",
                    (start // batch_size) + 1,
                    exc,
                )
        if still_failed:
            logger.warning(
                "Ingestion completed with %d unrecoverable failed batch(es). Re-run script to resume via upsert.",
                still_failed,
            )

    logger.info("Ingestion complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest eCourt JSON precedents into Qdrant.")
    group  = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dir",  help="Directory of JSON files to ingest.")
    group.add_argument("--file", help="Single JSON file to ingest.")

    args = parser.parse_args()
    target = args.dir or args.file

    asyncio.run(main(target))
