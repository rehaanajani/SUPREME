"""
app/tools/llm.py — LLM interface via OpenRouter.

Primary model  : mistralai/mistral-7b-instruct:free
Fallback model : openchat/openchat-3.5:free
Failsafe       : canned courtroom pause phrase
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from config import (
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    TERTIARY_MODEL,
    LLM_MAX_TOKENS,
    LLM_TIMEOUT,
    LLM_RETRIES,
)

logger = logging.getLogger(__name__)

FAILSAFE_RESPONSE = "Your Honour, the counsel requests a brief pause."


async def _call_model(
    model: str,
    system_prompt: str,
    user_prompt: str,
    client: httpx.AsyncClient,
) -> str:
    """Single model call — raises on non-2xx or missing content."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        "max_tokens": LLM_MAX_TOKENS,
    }
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://supreme-courtroom.local",
        "X-Title":       "SUPREME Courtroom Simulator",
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
    return content


async def generate_response(system_prompt: str, user_prompt: str) -> str:
    """
    Query OpenRouter with automatic model fallback and retry logic.

    Retry schedule (per model):
      1. PRIMARY_MODEL  — up to LLM_RETRIES attempts
      2. FALLBACK_MODEL — up to LLM_RETRIES attempts
      3. FAILSAFE_RESPONSE

    Returns the first successful, non-empty string response.
    """
    if not OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY is not set — returning failsafe.")
        return FAILSAFE_RESPONSE

    models_to_try = [PRIMARY_MODEL, FALLBACK_MODEL, TERTIARY_MODEL]

    async with httpx.AsyncClient() as client:
        for model in models_to_try:
            for attempt in range(1, LLM_RETRIES + 1):
                try:
                    logger.debug(
                        "LLM call: model=%s attempt=%d/%d", model, attempt, LLM_RETRIES
                    )
                    return await _call_model(model, system_prompt, user_prompt, client)
                except httpx.TimeoutException:
                    logger.warning("Timeout on model=%s attempt=%d", model, attempt)
                except httpx.HTTPStatusError as exc:
                    logger.warning(
                        "HTTP %s on model=%s attempt=%d",
                        exc.response.status_code, model, attempt,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Error on model=%s attempt=%d: %s", model, attempt, exc)

                if attempt < LLM_RETRIES:
                    await asyncio.sleep(1.0)   # brief back-off before retry

    logger.error("All LLM models exhausted — returning failsafe response.")
    return FAILSAFE_RESPONSE
