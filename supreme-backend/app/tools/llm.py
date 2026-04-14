"""
app/tools/llm.py - LLM interface via OpenRouter with debug traces.
"""

from __future__ import annotations

import asyncio
import logging
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

FAILSAFE_RESPONSE = "Your Honour, the counsel requests a brief pause."


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

    if not OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY is not set - returning failsafe.")
        traces.append(
            ToolCallTrace(
                name="openrouter.chat.completions",
                status="failsafe",
                input={"reason": "missing_openrouter_api_key"},
                output={"content": FAILSAFE_RESPONSE},
            )
        )
        return FAILSAFE_RESPONSE, traces

    models_to_try = [PRIMARY_MODEL, FALLBACK_MODEL, TERTIARY_MODEL]

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
                    traces.append(
                        ToolCallTrace(
                            name="openrouter.chat.completions",
                            status="http_error",
                            input={"model": model, "attempt": attempt, "max_tokens": LLM_MAX_TOKENS},
                            output={
                                "status_code": exc.response.status_code,
                                "response": exc.response.text[:1000],
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

    logger.error("All LLM models exhausted - returning failsafe response.")
    traces.append(
        ToolCallTrace(
            name="openrouter.chat.completions",
            status="failsafe",
            input={"reason": "all_models_exhausted"},
            output={"content": FAILSAFE_RESPONSE},
        )
    )
    return FAILSAFE_RESPONSE, traces
