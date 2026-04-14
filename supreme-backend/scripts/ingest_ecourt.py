"""
scripts/ingest_ecourt.py — Ingest eCourt JSON precedents into Qdrant.

Usage:
    python scripts/ingest_ecourt.py --dir data/ecourt_cases/
    python scripts/ingest_ecourt.py --file data/ecourt_cases/sample.json

Each JSON file must be an object OR a list of objects with at least:
    { "case_id", "title", "facts", "arguments", "judgment" }

The script chunks each case into three sections (facts / arguments / judgment),
embeds them (if OPENAI_API_KEY is set) or uses zero-vectors, and upserts to
Qdrant with payload metadata including a bias tag.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import Any

# Make sure project root is on path when run directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import (
    OPENAI_API_KEY,
    QDRANT_COLLECTION,
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_VECTOR_SIZE,
    EMBEDDING_MODEL,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger("ingest")

# ── Qdrant setup ──────────────────────────────────────────────────────────────

def _get_qdrant():
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams

    kwargs: dict[str, Any] = {"url": QDRANT_URL, "timeout": 10}
    if QDRANT_API_KEY:
        kwargs["api_key"] = QDRANT_API_KEY

    client = QdrantClient(**kwargs)

    existing = [c.name for c in client.get_collections().collections]
    if QDRANT_COLLECTION not in existing:
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(size=QDRANT_VECTOR_SIZE, distance=Distance.COSINE),
        )
        logger.info("Created collection '%s'.", QDRANT_COLLECTION)
    else:
        logger.info("Collection '%s' already exists.", QDRANT_COLLECTION)

    return client


# ── Embedding ─────────────────────────────────────────────────────────────────

async def _embed(texts: list[str]) -> list[list[float]]:
    """Return embeddings or zero-vectors if OpenAI is unavailable."""
    if not OPENAI_API_KEY:
        logger.warning("No OPENAI_API_KEY — using zero vectors (keyword fallback will still work).")
        return [[0.0] * QDRANT_VECTOR_SIZE for _ in texts]

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=OPENAI_API_KEY)
    resp = await client.embeddings.create(input=texts, model=EMBEDDING_MODEL)
    return [item.embedding for item in resp.data]


# ── Chunking ──────────────────────────────────────────────────────────────────

def _chunk_case(case: dict[str, Any]) -> list[dict[str, Any]]:
    """Split a case into three payload chunks: facts, arguments, judgment."""
    case_id = case.get("case_id", str(uuid.uuid4()))
    title   = case.get("title", "Untitled Case")
    bias    = _detect_bias(case)

    chunks = []
    for section in ("facts", "arguments", "judgment"):
        text = case.get(section, "").strip()
        if not text:
            continue
        chunks.append(
            {
                "id":      str(uuid.uuid4()),
                "text":    f"{title} — {section.upper()}: {text}",
                "payload": {
                    "case_id": case_id,
                    "title":   title,
                    "section": section,
                    "summary": text[:300],
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

    texts = [c["text"] for c in chunks]
    vectors = await _embed(texts)

    points = [
        PointStruct(id=c["id"], vector=v, payload=c["payload"])
        for c, v in zip(chunks, vectors)
    ]
    client.upsert(collection_name=QDRANT_COLLECTION, points=points)
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
    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        await _upsert_chunks(qdrant, batch)

    logger.info("Ingestion complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest eCourt JSON precedents into Qdrant.")
    group  = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dir",  help="Directory of JSON files to ingest.")
    group.add_argument("--file", help="Single JSON file to ingest.")

    args = parser.parse_args()
    target = args.dir or args.file

    asyncio.run(main(target))
