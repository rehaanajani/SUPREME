"""
config.py — SUPREME Courtroom Simulator
Central configuration loaded from environment variables.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ── OpenRouter (LLM) ──────────────────────────────────────────────────────────
OPENROUTER_API_KEY: str  = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1/chat/completions"

# Confirmed live-tested working free models (tested 2025-04-14)
PRIMARY_MODEL:   str = "openai/gpt-oss-120b:free"             # 120B, OpenAI OSS — best quality
FALLBACK_MODEL:  str = "google/gemma-3-27b-it:free"           # 27B Google, strong reasoning
TERTIARY_MODEL:  str = "nvidia/nemotron-3-super-120b-a12b:free"  # 120B NVIDIA — last resort

LLM_MAX_TOKENS: int   = 300
LLM_TIMEOUT:    float = 15.0
LLM_RETRIES:    int   = 2

# ── OpenAI (embeddings, optional) ────────────────────────────────────────────
OPENAI_API_KEY:   str = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL:  str = "text-embedding-3-small"

# ── Qdrant ────────────────────────────────────────────────────────────────────
QDRANT_URL:         str = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY:     str = os.getenv("QDRANT_API_KEY", "")    # required for Qdrant Cloud
QDRANT_COLLECTION:  str = os.getenv("QDRANT_COLLECTION", "ecourt_precedents")
QDRANT_VECTOR_SIZE: int = 1536  # matches text-embedding-3-small

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL:   str = os.getenv("REDIS_URL", "redis://localhost:6379")
SESSION_TTL: int = 86_400  # 24 hours in seconds

# ── Application ───────────────────────────────────────────────────────────────
APP_HOST:   str  = os.getenv("APP_HOST", "0.0.0.0")
APP_PORT:   int  = int(os.getenv("APP_PORT", "8000"))
DEMO_MODE:  bool = os.getenv("DEMO_MODE", "true").lower() == "true"
APP_LOG_LEVEL: str = os.getenv("APP_LOG_LEVEL", "INFO").upper()
ENABLE_RAG_DEBUG: bool = os.getenv("ENABLE_RAG_DEBUG", "false").lower() == "true"
CORS_ORIGINS: list[str] = [
    origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

# ── Vapi (optional voice layer) ───────────────────────────────────────────────
VAPI_API_KEY:           str  = os.getenv("VAPI_API_KEY", "")
VAPI_PROSECUTOR_VOICE:  str  = os.getenv("VAPI_PROSECUTOR_VOICE", "")   # e.g. ElevenLabs voice ID
VAPI_DEFENSE_VOICE:     str  = os.getenv("VAPI_DEFENSE_VOICE", "")
VAPI_JUDGE_VOICE:       str  = os.getenv("VAPI_JUDGE_VOICE", "")
VAPI_ENABLED:           bool = bool(VAPI_API_KEY)

# ── Trial defaults ────────────────────────────────────────────────────────────
TURNS_PER_STAGE: dict[str, int] = {
    "easy":   1,
    "medium": 2,
    "hard":   3,
}
