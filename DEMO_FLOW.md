# SUPREME AI Courtroom Simulator — Demo Flow Script

## Architecture Overview (30 seconds)

**Stack**: FastAPI backend ↔ React frontend, OpenRouter LLM (multi-model fallback), Qdrant vector DB for case law RAG, Vapi 11Labs voice synthesis, SQLite session persistence.

**Pipeline per turn**: User action → Backend orchestrator → Agent runner (prosecution/defense/judge) → LLM call with RAG context → Transcript + citations returned → Frontend renders with voice narration.

---

## 90-Second Live Demo Flow

### 1. Create Case (0:00–0:15)
- Open the app → **CONFIGURATION** screen
- Fill in: Case type = CRIMINAL, Defendant = "Arjun Mehta"
- Charges: "Theft of proprietary source code"
- Click **START SIMULATION** → session initialises

### 2. Run Opening Statements (0:15–0:35)
- Click **NEXT** twice to get prosecution + defense opening statements
- Point out the **RAG debug chip** (🔍 QDRANT SEMANTIC) showing real case law retrieval
- Click a **citation tag** to show the provenance panel with case ID + summary

### 3. File Objection (0:35–0:55)
- Click **OBJECTION** → enter "Hearsay" → **SUBMIT TO ALGORITHMIC JUDGE**
- Speech **stops immediately** (hard-stop feature)
- Backend LLM adjudicates → ruling modal shows **SUSTAINED** or **OVERRULED** with reason
- Click **RESUME PROCEEDINGS**

### 4. Fast Forward to Verdict (0:55–1:10)
- Click **VERDICT** → all stages auto-run
- Verdict screen: typewriter effect + voice narration
- Expand **Judge's Analysis** card to show all cited precedents

### 5. System Health + Session Replay (1:10–1:30)
- Point to the **health strip** in the status bar: 4 green dots = LLM / Qdrant / Voice / Session
- Click **HOME** → back to config → **Past Trials** section shows prior session
- Click to resume → full trial state restored

---

## Key Demo Talking Points

1. **Real LLM adjudication** — objections are ruled by the AI judge, not hardcoded
2. **Qdrant RAG** — every argument cites real Indian case law from the vector DB
3. **Voice synthesis** — Vapi 11Labs voices for prosecution, defense, and judge
4. **Speech safety** — objection instantly halts all speech
5. **Session persistence** — SQLite-backed, resume any prior trial
6. **System transparency** — debug chips show RAG source, citations show provenance
