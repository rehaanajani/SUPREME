# SUPREME — AI Courtroom Simulator

A high-contrast, brutalist AI-powered courtroom simulation platform built with React, Vite, TypeScript, Tailwind CSS, and Framer Motion.

## Overview

SUPREME simulates multi-phase court proceedings using AI agents for Prosecution and Defense counsels, presided over by an algorithmic judge. Users configure a case, then step through trial phases — from Opening Statements through Evidence, Cross-Examination, and a final Verdict.

## Features

- **Case Configuration** — Define case type, plaintiff vs. defendant, case summary, facts, evidence uploads, and timeline of events
- **Multi-Phase Trial** — Step through Opening → Evidence → Cross-Examination → Verdict
- **Dual-Counsel View** — Split-panel simulation with Prosecution and Defense AI agents
- **Procedural Controls** — Record witness testimony, pause/object to proceedings, redact sensitive content, navigate trial phases
- **Secure by Design** — End-to-end encrypted, zero data logging, local processing
- **Brutalist UI** — Strict monochrome design system: binary palette, 0px border-radius, monospace typography

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Styling | Tailwind CSS |
| Animations | Framer Motion |
| Icons | Lucide React |

## Getting Started

```bash
# Install dependencies
npm install

# Start the development server
npm run dev
```

The app will be available at `http://localhost:3000`.

## Project Structure

```
src/
  App.tsx          # Core application — all views, state, and components
  main.tsx         # React entry point
  lib/
    utils.ts       # Tailwind class utility (cn)
public/
  logo.png         # App logo
```

## Usage

1. **Landing** — Click **START** to begin configuring a case
2. **Configuration** — Fill in case type, parties, summary, individual facts, evidence, and timeline
3. **Simulation** — Use the bottom control bar to navigate phases, pause, record, or redact

## License

MIT
