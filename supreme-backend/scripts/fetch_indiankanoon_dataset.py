"""
scripts/fetch_indiankanoon_dataset.py

Fetch Indian Kanoon documents via API token auth and export them into the
JSON shape expected by scripts/ingest_ecourt.py.

Usage examples:
    python scripts/fetch_indiankanoon_dataset.py \
      --query "murder" \
      --query "culpable homicide" \
      --pages 2 \
      --doctypes supremecourt,delhi \
      --out data/ecourt_cases/ik_dataset.json

    INDIANKANOON_API_TOKEN=... python scripts/fetch_indiankanoon_dataset.py \
      --queries-file data/queries.txt --pages 1

Notes:
  - Requires a valid Indian Kanoon API token.
  - Please comply with Indian Kanoon API pricing and Terms.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import time
from dataclasses import dataclass
from html import unescape
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def _load_env_file_if_present() -> None:
    env_path = Path(".env")
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        cleaned = value.strip().strip('"').strip("'")
        os.environ[key] = cleaned


_load_env_file_if_present()


BASE_URL = "https://api.indiankanoon.org"
DEFAULT_OUTPUT = "data/ecourt_cases/ik_dataset.json"


class IKApiError(RuntimeError):
    """Raised when an Indian Kanoon API request fails."""


@dataclass
class SearchHit:
    tid: str
    query: str
    title: str
    headline: str
    docsource: str


def _extract_doc_id_from_case(case: dict[str, Any]) -> str | None:
    metadata = case.get("metadata")
    if isinstance(metadata, dict):
        doc_id = metadata.get("doc_id")
        if doc_id is not None:
            value = str(doc_id).strip()
            if value:
                return value

    case_id = str(case.get("case_id") or "").strip()
    if case_id.startswith("IK-"):
        return case_id[3:]
    return None


def _load_existing_cases(output_path: Path) -> tuple[list[dict[str, Any]], set[str]]:
    if not output_path.exists():
        return [], set()

    raw = json.loads(output_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise IKApiError(f"Existing output must be a JSON list: {output_path}")

    cases: list[dict[str, Any]] = []
    doc_ids: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        cases.append(item)
        doc_id = _extract_doc_id_from_case(item)
        if doc_id:
            doc_ids.add(doc_id)
    return cases, doc_ids


def _read_json(
    url: str,
    headers: dict[str, str],
    params: dict[str, Any] | None = None,
    method: str = "POST",
    max_retries: int = 5,
    retry_delay: float = 1.0,
) -> dict[str, Any]:
    full_url = f"{url}?{urlencode(params)}" if params else url
    request_method = method.upper()

    for attempt in range(max_retries + 1):
        data = b"" if request_method == "POST" else None
        req = Request(full_url, headers=headers, method=request_method, data=data)
        try:
            with urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8", errors="replace")

            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise IKApiError(
                    f"Unexpected payload shape from {full_url}; expected object, got {type(payload).__name__}"
                )
            return payload

        except HTTPError as exc:
            if exc.code == 405 and request_method == "POST":
                return _read_json(
                    url,
                    headers,
                    params=params,
                    method="GET",
                    max_retries=max_retries,
                    retry_delay=retry_delay,
                )

            body = exc.read().decode("utf-8", errors="replace")
            snippet = body[:400].replace("\n", " ")

            if exc.code in (401, 403):
                raise IKApiError(
                    f"Authentication failed (HTTP {exc.code}). Check INDIANKANOON_API_TOKEN. Response: {snippet}"
                ) from exc

            retriable = exc.code in {408, 409, 425, 429, 500, 502, 503, 504}
            if retriable and attempt < max_retries:
                backoff = retry_delay * (2 ** attempt) + random.uniform(0.0, 0.5)
                time.sleep(backoff)
                continue
            raise IKApiError(f"API request failed (HTTP {exc.code}) for {full_url}. Response: {snippet}") from exc

        except (URLError, TimeoutError) as exc:
            if attempt < max_retries:
                backoff = retry_delay * (2 ** attempt) + random.uniform(0.0, 0.5)
                time.sleep(backoff)
                continue
            raise IKApiError(f"Network error calling {full_url}: {exc}") from exc

        except json.JSONDecodeError as exc:
            raise IKApiError(f"Invalid JSON from {full_url}. First bytes were not valid JSON.") from exc

    raise IKApiError(f"Failed to fetch {full_url} after retries.")


def _strip_html(text: str) -> str:
    if not text:
        return ""
    text = unescape(text)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _first_marker_index(text_lower: str, markers: list[str]) -> int:
    positions = [text_lower.find(marker) for marker in markers if text_lower.find(marker) != -1]
    return min(positions) if positions else -1


def _split_sections(full_text: str) -> tuple[str, str, str]:
    text = full_text.strip()
    if not text:
        return "", "", ""

    lower = text.lower()
    argument_markers = [
        "arguments",
        "contentions",
        "submissions",
        "learned counsel",
        "it is contended",
    ]
    judgment_markers = [
        "judgment",
        "order",
        "held that",
        "conclusion",
        "we therefore",
        "result",
    ]

    arg_idx = _first_marker_index(lower, argument_markers)
    jud_idx = _first_marker_index(lower, judgment_markers)

    if arg_idx != -1 and jud_idx != -1 and arg_idx < jud_idx:
        facts = text[:arg_idx].strip()
        arguments = text[arg_idx:jud_idx].strip()
        judgment = text[jud_idx:].strip()
        return facts, arguments, judgment

    # Fallback: rough thirds
    n = len(text)
    one_third = n // 3
    two_thirds = (2 * n) // 3
    return text[:one_third].strip(), text[one_third:two_thirds].strip(), text[two_thirds:].strip()


def _load_queries(inline_queries: list[str], queries_file: str | None) -> list[str]:
    queries = [query.strip() for query in inline_queries if query.strip()]
    if queries_file:
        path = Path(queries_file)
        if not path.exists():
            raise IKApiError(f"Queries file not found: {queries_file}")
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if line and not line.startswith("#"):
                queries.append(line)

    # stable dedupe preserving first occurrence
    seen: set[str] = set()
    deduped: list[str] = []
    for query in queries:
        key = query.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(query)
    return deduped


def _build_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Token {token}",
        "Accept": "application/json",
        "User-Agent": "SUPREME-IK-Dataset-Fetcher/1.0",
    }


def _extract_hits(search_payload: dict[str, Any], query: str) -> list[SearchHit]:
    docs = search_payload.get("docs", [])
    if not isinstance(docs, list):
        return []

    hits: list[SearchHit] = []
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        tid = str(doc.get("tid") or doc.get("docid") or "").strip()
        if not tid:
            continue
        hits.append(
            SearchHit(
                tid=tid,
                query=query,
                title=str(doc.get("title") or "").strip(),
                headline=str(doc.get("headline") or "").strip(),
                docsource=str(doc.get("docsource") or "").strip(),
            )
        )
    return hits


def _build_case_record(hit: SearchHit, doc_payload: dict[str, Any], meta_payload: dict[str, Any]) -> dict[str, Any]:
    title = (
        str(meta_payload.get("title") or "").strip()
        or str(doc_payload.get("title") or "").strip()
        or hit.title
        or f"Indian Kanoon Document {hit.tid}"
    )

    doc_html = str(doc_payload.get("doc") or doc_payload.get("text") or "")
    full_text = _strip_html(doc_html)
    if not full_text:
        # Fallback for sparse payloads
        full_text = " ".join(part for part in [hit.headline, title] if part).strip()

    facts, arguments, judgment = _split_sections(full_text)
    if not facts and full_text:
        facts = full_text

    return {
        "case_id": f"IK-{hit.tid}",
        "title": title,
        "facts": facts,
        "arguments": arguments,
        "judgment": judgment,
        "metadata": {
            "source": "indiankanoon",
            "doc_id": hit.tid,
            "query": hit.query,
            "docsource": hit.docsource,
            "api_doc_url": f"{BASE_URL}/doc/{hit.tid}/",
            "api_docmeta_url": f"{BASE_URL}/docmeta/{hit.tid}/",
            "api_origdoc_url": f"{BASE_URL}/origdoc/{hit.tid}/",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Indian Kanoon cases and export ingest-ready JSON.")
    parser.add_argument("--query", action="append", default=[], help="Search query. Repeat for multiple queries.")
    parser.add_argument("--queries-file", help="Path to newline-delimited queries file.")
    parser.add_argument("--pages", type=int, default=1, help="Number of search pages per query (default: 1).")
    parser.add_argument("--start-page", type=int, default=0, help="Search page to start from (default: 0).")
    parser.add_argument("--max-docs", type=int, default=100, help="Max documents to download in total.")
    parser.add_argument("--doctypes", help="Indian Kanoon doctypes filter, e.g. supremecourt,highcourts.")
    parser.add_argument("--fromdate", help="Filter start date DD-MM-YYYY.")
    parser.add_argument("--todate", help="Filter end date DD-MM-YYYY.")
    parser.add_argument("--sleep-seconds", type=float, default=0.35, help="Delay between API calls.")
    parser.add_argument("--out", default=DEFAULT_OUTPUT, help=f"Output file path (default: {DEFAULT_OUTPUT}).")
    parser.add_argument("--token", default=os.getenv("INDIANKANOON_API_TOKEN", ""), help="API token.")
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from existing output file by skipping already downloaded doc IDs.",
    )
    parser.add_argument(
        "--save-every",
        type=int,
        default=50,
        help="Save checkpoint every N newly fetched documents (default: 50).",
    )
    parser.add_argument("--max-retries", type=int, default=5, help="Retries for transient API/network failures.")
    parser.add_argument("--retry-delay", type=float, default=1.0, help="Base delay seconds for retry backoff.")
    args = parser.parse_args()

    if not args.token:
        raise IKApiError("Missing token. Set INDIANKANOON_API_TOKEN or pass --token.")

    queries = _load_queries(args.query, args.queries_file)
    if not queries:
        raise IKApiError("No queries provided. Use --query and/or --queries-file.")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    existing_cases: list[dict[str, Any]] = []
    existing_doc_ids: set[str] = set()
    if args.resume:
        existing_cases, existing_doc_ids = _load_existing_cases(out_path)
        if existing_cases:
            print(
                f"[resume] loaded {len(existing_cases)} existing cases from {out_path} "
                f"({len(existing_doc_ids)} unique doc IDs)"
            )

    headers = _build_headers(args.token)
    unique_hits: dict[str, SearchHit] = {}

    def current_total() -> int:
        return len(existing_doc_ids) + len(unique_hits)

    if current_total() >= args.max_docs:
        print(
            f"Target already met from existing output: {current_total()} docs >= max-docs {args.max_docs}."
        )
        print(f"No API calls needed. Output remains at {out_path}")
        return

    for query in queries:
        for page in range(args.start_page, args.start_page + max(args.pages, 0)):
            params: dict[str, Any] = {"formInput": query, "pagenum": page}
            if args.doctypes:
                params["doctypes"] = args.doctypes
            if args.fromdate:
                params["fromdate"] = args.fromdate
            if args.todate:
                params["todate"] = args.todate

            payload = _read_json(
                f"{BASE_URL}/search/",
                headers,
                params=params,
                max_retries=args.max_retries,
                retry_delay=args.retry_delay,
            )
            hits = _extract_hits(payload, query)

            for hit in hits:
                if hit.tid in existing_doc_ids:
                    continue
                unique_hits.setdefault(hit.tid, hit)
                if current_total() >= args.max_docs:
                    break

            print(
                f"[search] query='{query}' page={page} hits={len(hits)} "
                f"new_unique={len(unique_hits)} total={current_total()}"
            )
            if current_total() >= args.max_docs:
                break
            if args.sleep_seconds > 0:
                time.sleep(args.sleep_seconds)

        if current_total() >= args.max_docs:
            break

    if current_total() == 0:
        raise IKApiError("Search returned no documents. Try broader queries or adjust filters.")

    cases: list[dict[str, Any]] = []
    for idx, hit in enumerate(unique_hits.values(), start=1):
        doc_payload = _read_json(
            f"{BASE_URL}/doc/{hit.tid}/",
            headers,
            max_retries=args.max_retries,
            retry_delay=args.retry_delay,
        )
        meta_payload = _read_json(
            f"{BASE_URL}/docmeta/{hit.tid}/",
            headers,
            max_retries=args.max_retries,
            retry_delay=args.retry_delay,
        )
        cases.append(_build_case_record(hit, doc_payload, meta_payload))
        print(
            f"[doc] {idx}/{len(unique_hits)} tid={hit.tid} "
            f"total={len(existing_cases) + len(cases)}"
        )

        should_checkpoint = args.save_every > 0 and len(cases) % args.save_every == 0
        if should_checkpoint:
            merged = existing_cases + cases
            merged = merged[: args.max_docs]
            out_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[checkpoint] wrote {len(merged)} cases to {out_path}")

        if len(existing_cases) + len(cases) >= args.max_docs:
            break

        if args.sleep_seconds > 0:
            time.sleep(args.sleep_seconds)

    merged_cases = existing_cases + cases
    merged_cases = merged_cases[: args.max_docs]
    out_path.write_text(json.dumps(merged_cases, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        f"Saved {len(merged_cases)} total cases to {out_path} "
        f"(added {len(cases)} new)."
    )
    print("This file can be ingested using scripts/ingest_ecourt.py")


if __name__ == "__main__":
    try:
        main()
    except IKApiError as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1)
