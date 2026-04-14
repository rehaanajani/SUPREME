# Frontend-Backend Integration Tasks

This document tracks the work required to fully connect `supreme-frontend` to `supreme-backend` and remove demo-only behavior from runtime flows.

## Goal

Ship a working end-to-end courtroom simulation where UI actions call real backend APIs and all trial state (session, stage, transcript, verdict, evidence list) comes from the backend.

## Scope

- Frontend API integration and state wiring
- Backend CORS/env updates for browser access
- Runtime config cleanup (frontend env values)
- Integration verification steps

## Task Breakdown

### 1) API Contract + Data Mapping

- [x] Confirm canonical backend endpoints and payloads:
  - `POST /api/case`
  - `GET /api/session/{session_id}`
  - `POST /api/session/{session_id}/next`
  - `POST /api/session/{session_id}/control`
  - `POST /api/session/{session_id}/verdict`
  - `POST /api/session/{session_id}/fast-forward`
  - `POST /api/session/{session_id}/reset`
- [x] Define frontend TypeScript types mirroring backend models.
- [x] Define stage mapping from backend trial stages to UI phases.
- [x] Define transcript/evidence adapters from backend shape to existing UI components.

### 2) Frontend API Layer

- [x] Add an API client (`fetch` wrapper) with:
  - base URL from `VITE_API_BASE_URL`
  - JSON request/response handling
  - normalized error handling
- [x] Add trial API module with typed methods:
  - create case
  - read session
  - next turn
  - control action (objection/redact/inject testimony)
  - force verdict
  - fast forward
  - reset trial

### 3) Frontend Runtime Integration

- [x] Replace local/demo session flow with backend-backed session lifecycle.
- [x] Wire config start action to `POST /api/case` and persist session ID in app state.
- [x] Wire simulation controls to backend:
  - next turn
  - objection
  - inject testimony (record)
  - redact
  - fast-forward to verdict
- [x] Refresh/rehydrate session state after each mutation.
- [x] Show clear loading and error states.

### 4) Remove Hardcoded Runtime Data

- [x] Replace transcript demo constants with backend transcript rendering.
- [x] Replace evidence demo constants with backend-derived evidence list (case evidence + cited precedents).
- [x] Drive verdict view from backend verdict data when available.

### 5) Environment + CORS Hardening

- [x] Frontend `.env.example` should contain backend URL config (`VITE_API_BASE_URL`).
- [x] Remove stale Gemini-only runtime env references from Vite config.
- [x] Backend CORS should be environment-driven (allowlist), not wildcard.
- [x] Add `CORS_ORIGINS` to backend `.env.example`.

### 6) Verification

- [x] Frontend typecheck/build passes.
- [x] Backend starts with new CORS config.
- [ ] Manual scenario works:
  1. Create case
  2. Run several turns
  3. File objection
  4. Inject testimony
  5. Redact matching text
  6. Fast-forward/force verdict
  7. Transcript + verdict visible in UI

## Work Log

- [x] Initial integration plan drafted.
- [x] Core implementation completed.
- [ ] Manual E2E validation pending live run.

## Files Changed

- `tasks.md`
- `supreme-frontend/src/App.tsx`
- `supreme-frontend/src/api/client.ts`
- `supreme-frontend/src/api/trial.ts`
- `supreme-frontend/src/api/types.ts`
- `supreme-frontend/src/vite-env.d.ts`
- `supreme-frontend/.env.example`
- `supreme-frontend/vite.config.ts`
- `supreme-backend/config.py`
- `supreme-backend/main.py`
- `supreme-backend/.env.example`
