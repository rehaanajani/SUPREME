# SUPREME Frontend

React + Vite frontend for the SUPREME courtroom simulator.

## Getting Started

```bash
npm install
cp .env.example .env
npm run dev
```

By default the app runs on `http://localhost:3000` and expects the backend at `http://localhost:8000`.

## Environment

Use `supreme-frontend/.env`:

```bash
VITE_API_BASE_URL=http://localhost:8000
VITE_DEBUG_API=false
```

## Flow Overview

1. Landing -> start a new case.
2. Configuration -> enter defendant, plea, charges, and evidence.
3. Simulation -> advance turns, object, inject testimony, redact text, or force verdict.
4. Evidence/Transcript -> inspect generated trial state from backend session data.

## Notes

- Voice playback uses browser `speechSynthesis` for prosecution/defense narration.
- API requests and errors are surfaced with request diagnostics in the UI.
