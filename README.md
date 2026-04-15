# SUPREME — AI Courtroom Simulator

> Multi-agent AI courtroom with voice — Prosecution vs Defense with a live AI Judge.

Built for hackathon demonstration. Two AI agents argue a case in real-time with distinct voices, powered by OpenRouter LLMs and optional Vapi TTS.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS + Framer Motion |
| Backend | FastAPI + Uvicorn |
| LLM | OpenRouter (gpt-oss-120b:free → gemma-3-27b-it:free → nemotron-120b:free) |
| RAG | Qdrant Cloud vector DB |
| Session | SQLite (default) / Redis (optional) |
| Voice | Vapi TTS (+ browser speechSynthesis fallback) |

---

## Quick Start

### 1. Backend
```bash
cd supreme-backend
pip install -r requirements.txt
cp .env.example .env   # fill in your API keys
python main.py
```

### 2. Frontend
```bash
cd supreme-frontend
npm install
npm run dev
```

Open **http://localhost:3000**

---

## Build a Legal Dataset (Indian Kanoon -> Qdrant)

From `supreme-backend/` you can fetch Indian Kanoon records into an
ingest-ready JSON dataset, then push it into Qdrant.

```bash
# 1) Set your token (or place it in .env)
export INDIANKANOON_API_TOKEN=...

# 2) Fetch dataset (example: Supreme Court + High Courts)
python scripts/fetch_indiankanoon_dataset.py \
  --query "murder" \
  --query "cheating" \
  --pages 2 \
  --doctypes supremecourt,highcourts \
  --max-docs 80 \
  --out data/ecourt_cases/ik_dataset.json

# 3) Ingest into Qdrant for RAG
python scripts/ingest_ecourt.py --file data/ecourt_cases/ik_dataset.json
```

The fetch script uses token auth against `https://api.indiankanoon.org` and
exports cases in the schema expected by `scripts/ingest_ecourt.py`:
`case_id`, `title`, `facts`, `arguments`, `judgment`.

---

## Environment Variables

### Backend (`supreme-backend/.env`)
```
OPENROUTER_API_KEY=...
EMBEDDING_PROVIDER=auto
EMBEDDING_MODEL=
OPENAI_API_KEY=...
NVIDIA_API_KEY=...
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
QDRANT_URL=...
QDRANT_API_KEY=...
QDRANT_VECTOR_SIZE=1536
REDIS_URL=rediss://...
SESSION_BACKEND=sqlite
SESSION_SQLITE_PATH=./data/sessions.db
SESSION_TTL=86400
VAPI_API_KEY=...
INDIANKANOON_API_TOKEN=...
DEMO_MODE=true
```

Session backend notes:
- Default is `SESSION_BACKEND=sqlite`, so no external session service/key is required.
- SQLite uses `SESSION_SQLITE_PATH` (default `./data/sessions.db`).
- Use `SESSION_BACKEND=redis` only if you want Redis/Upstash.

Embedding provider notes:
- `EMBEDDING_PROVIDER=auto` prefers OpenAI if `OPENAI_API_KEY` is set, else NVIDIA if `NVIDIA_API_KEY` is set.
- Force NVIDIA with `EMBEDDING_PROVIDER=nvidia` and `EMBEDDING_MODEL=nvidia/nv-embedqa-e5-v5`.
- For `nvidia/nv-embedqa-e5-v5`, set `QDRANT_VECTOR_SIZE=1024`.
- If a collection already exists with a different vector size, create a new collection or re-ingest into a size-matched one.

### Frontend (`supreme-frontend/.env`)
```
VITE_VAPI_API_KEY=...
```

---

## Features

- ⚖️ **Multi-agent trial** — Prosecution, Defense, and Judge AI agents
- 🔊 **Dual voice** — Each agent has a distinct voice (Vapi premium or browser TTS fallback)
- 📜 **Live transcript** — Real-time turn-by-turn courtroom record
- 🚨 **Objection system** — Raise objections; Judge rules SUSTAINED/OVERRULED
- 📁 **Evidence register** — View all cited precedents and evidence
- ✂️ **Redact** — Strike entries from the record mid-trial
- ⚡ **Fast-forward** — Skip to the verdict instantly
- 🧠 **RAG** — Qdrant-powered retrieval of legal precedents
