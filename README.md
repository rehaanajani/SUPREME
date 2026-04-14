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
| Session | Upstash Redis |
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

## Environment Variables

### Backend (`supreme-backend/.env`)
```
OPENROUTER_API_KEY=...
QDRANT_URL=...
QDRANT_API_KEY=...
REDIS_URL=rediss://...
VAPI_API_KEY=...
DEMO_MODE=true
```

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
