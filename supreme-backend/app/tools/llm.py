"""
app/tools/llm.py - LLM interface via OpenRouter with debug traces.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx

from app.models.trial import ToolCallTrace
from config import (
    FALLBACK_MODEL,
    LLM_MAX_TOKENS,
    LLM_RETRIES,
    LLM_TIMEOUT,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    PRIMARY_MODEL,
    TERTIARY_MODEL,
)

logger = logging.getLogger(__name__)

DEFAULT_FAILSAFE_RESPONSE = "The Court notes a temporary language-service interruption."
FREE_TIER_LIMIT_MARKER = "free-models-per-day"
OPENROUTER_AUTO_MODEL = "openrouter/auto"


def _extract_prompt_field(user_prompt: str, labels: tuple[str, ...]) -> str:
    for label in labels:
        match = re.search(rf"^\s*{re.escape(label)}\s*:\s*(.+)$", user_prompt, flags=re.MULTILINE)
        if match:
            return match.group(1).strip()
    return ""


def _extract_prompt_list(user_prompt: str, labels: tuple[str, ...]) -> list[str]:
    raw = _extract_prompt_field(user_prompt, labels)
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _build_advocate_fallback(role: str, user_prompt: str) -> str:
    stage = _extract_prompt_field(user_prompt, ("CURRENT STAGE",)).upper()
    charges = _extract_prompt_list(user_prompt, ("CHARGES", "CHARGES AGAINST CLIENT"))
    evidence = _extract_prompt_list(user_prompt, ("KEY EVIDENCE", "PROSECUTION EVIDENCE (to counter)"))

    lead_charge = charges[0] if charges else "the charged offence"
    lead_evidence = evidence[0] if evidence else "the material already on record"

    if role == "prosecution":
        if stage == "OPENING_PROS":
            return (
                f"Your Honour, the prosecution submits that the accused committed {lead_charge}. "
                f"The record includes {lead_evidence}, which directly supports the prosecution narrative. "
                "We will prove each ingredient of the offence beyond reasonable doubt through admissible evidence."
            )
        if stage == "EXAMINATION":
            return (
                f"Your Honour, during examination the prosecution relies on {lead_evidence} to establish {lead_charge}. "
                "This material is internally consistent and aligns with the prosecution timeline. "
                "The prosecution therefore seeks to proceed to the next evidentiary segment."
            )
        if stage == "CLOSING_PROS":
            return (
                f"Your Honour, in closing, the prosecution reiterates that {lead_charge} stands proved. "
                f"The cumulative evidentiary record, including {lead_evidence}, remains unshaken in material particulars. "
                "The prosecution prays for conviction in accordance with law."
            )
        return (
            f"Your Honour, the prosecution continues to press the charge of {lead_charge}. "
            f"The submissions remain grounded in {lead_evidence} and the existing record. "
            "The prosecution seeks to continue proceedings without delay."
        )

    if role == "defense":
        if stage == "OPENING_DEF":
            return (
                f"Your Honour, the defence contests the prosecution's allegation of {lead_charge}. "
                f"At this stage, {lead_evidence} does not eliminate reasonable doubt against the accused. "
                "The defence seeks strict proof of every element before any adverse finding."
            )
        if stage == "CROSS_EXAM":
            return (
                f"Your Honour, in cross-examination the defence challenges the reliability of {lead_evidence}. "
                "The prosecution version contains gaps that prevent a safe finding of guilt. "
                "These deficiencies must weigh in favour of the accused."
            )
        if stage == "CLOSING_DEF":
            return (
                f"Your Honour, in closing, the defence submits that {lead_charge} has not been proved beyond reasonable doubt. "
                f"The prosecution's reliance on {lead_evidence} remains insufficient for conviction. "
                "The accused is entitled to acquittal on the present record."
            )
        return (
            f"Your Honour, the defence maintains that the allegation of {lead_charge} is not established in law. "
            f"The existing record, including {lead_evidence}, leaves material doubt unresolved. "
            "The defence seeks continuation of proceedings with full procedural safeguards."
        )

    return DEFAULT_FAILSAFE_RESPONSE


def _build_judge_fallback() -> str:
    return (
        "Decision: MISTRIAL.\n"
        "Reasoning: The Court cannot safely determine guilt because repeated language-service interruptions "
        "prevented complete adversarial submissions and reliable testing of evidence.\n"
        "- Material interruptions in prosecution and defence submissions\n"
        "- Incomplete opportunity for full cross-examination on the record\n"
        "- Interests of justice require a fresh hearing"
    )


def _failsafe_response(system_prompt: str, user_prompt: str) -> str:
    prompt = system_prompt.lower()

    if (
        "output format (exact keys)" in prompt
        and "decision:" in prompt
        and "analysis:" in prompt
    ):
        return (
            "DECISION: OVERRULED\n"
            "REASON: The objection cannot be adjudicated because language service is unavailable.\n"
            "ANALYSIS: The challenged statement remains on record until analysis service is restored."
        )

    if "public prosecutor" in prompt:
        return _build_advocate_fallback("prosecution", user_prompt)

    if "defence counsel" in prompt or "defense counsel" in prompt:
        return _build_advocate_fallback("defense", user_prompt)

    if "presiding judge" in prompt:
        return _build_judge_fallback()

    return DEFAULT_FAILSAFE_RESPONSE


async def _call_model(
    model: str,
    system_prompt: str,
    user_prompt: str,
    client: httpx.AsyncClient,
) -> tuple[str, dict[str, Any]]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": LLM_MAX_TOKENS,
    }
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://supreme-courtroom.local",
        "X-Title": "SUPREME Courtroom Simulator",
    }

    response = await client.post(
        OPENROUTER_BASE_URL,
        json=payload,
        headers=headers,
        timeout=LLM_TIMEOUT,
    )
    response.raise_for_status()

    data = response.json()
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    if not content:
        raise ValueError("Empty content returned by model.")
    return content, data


async def generate_response(system_prompt: str, user_prompt: str) -> str:
    content, _ = await generate_response_with_trace(system_prompt, user_prompt)
    return content


async def generate_response_with_trace(
    system_prompt: str,
    user_prompt: str,
) -> tuple[str, list[ToolCallTrace]]:
    traces: list[ToolCallTrace] = []
    failsafe_content = _failsafe_response(system_prompt, user_prompt)

    if not OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY is not set - returning failsafe.")
        traces.append(
            ToolCallTrace(
                name="openrouter.chat.completions",
                status="failsafe",
                input={"reason": "missing_openrouter_api_key"},
                output={"content": failsafe_content},
            )
        )
        return failsafe_content, traces

    models_to_try = [PRIMARY_MODEL, FALLBACK_MODEL, TERTIARY_MODEL]
    if OPENROUTER_AUTO_MODEL not in models_to_try:
        models_to_try.append(OPENROUTER_AUTO_MODEL)

    free_tier_limit_hit = False

    async with httpx.AsyncClient() as client:
        for model in models_to_try:
            for attempt in range(1, LLM_RETRIES + 1):
                try:
                    logger.debug("LLM call: model=%s attempt=%d/%d", model, attempt, LLM_RETRIES)
                    content, data = await _call_model(model, system_prompt, user_prompt, client)
                    traces.append(
                        ToolCallTrace(
                            name="openrouter.chat.completions",
                            status="success",
                            input={
                                "model": model,
                                "attempt": attempt,
                                "max_tokens": LLM_MAX_TOKENS,
                            },
                            output={
                                "response_id": data.get("id"),
                                "model": data.get("model", model),
                                "content": content,
                            },
                        )
                    )
                    return content, traces
                except httpx.TimeoutException:
                    logger.warning("Timeout on model=%s attempt=%d", model, attempt)
                    traces.append(
                        ToolCallTrace(
                            name="openrouter.chat.completions",
                            status="timeout",
                            input={"model": model, "attempt": attempt, "max_tokens": LLM_MAX_TOKENS},
                            error="Request timed out.",
                        )
                    )
                except httpx.HTTPStatusError as exc:
                    logger.warning("HTTP %s on model=%s attempt=%d", exc.response.status_code, model, attempt)
                    body = exc.response.text[:1000]
                    if exc.response.status_code == 429 and FREE_TIER_LIMIT_MARKER in body:
                        free_tier_limit_hit = True
                    traces.append(
                        ToolCallTrace(
                            name="openrouter.chat.completions",
                            status="http_error",
                            input={"model": model, "attempt": attempt, "max_tokens": LLM_MAX_TOKENS},
                            output={
                                "status_code": exc.response.status_code,
                                "response": body,
                            },
                            error=f"HTTP {exc.response.status_code}",
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Error on model=%s attempt=%d: %s", model, attempt, exc)
                    traces.append(
                        ToolCallTrace(
                            name="openrouter.chat.completions",
                            status="error",
                            input={"model": model, "attempt": attempt, "max_tokens": LLM_MAX_TOKENS},
                            error=str(exc),
                        )
                    )

                if attempt < LLM_RETRIES:
                    await asyncio.sleep(1.0)

    if free_tier_limit_hit:
        logger.error(
            "All model calls failed after OpenRouter free-tier daily limit was hit; returning template failsafe output."
        )
    else:
        logger.error("All LLM models exhausted - returning failsafe response.")
    traces.append(
        ToolCallTrace(
            name="openrouter.chat.completions",
            status="failsafe",
            input={"reason": "all_models_exhausted"},
            output={"content": failsafe_content},
        )
    )
    return failsafe_content, traces
