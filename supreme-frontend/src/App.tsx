import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Terminal,
  Gavel,
  FolderOpen,
  FileText,
  BookOpen,
  Mic,
  StepBack,
  Pause,
  StepForward,
  Eraser,
  Circle,
  Image,
  Film,
  FileSearch,
  Filter,
  Clock,
  User,
  Scale,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Download,
  Trash2,
} from 'lucide-react';
import { cn } from './lib/utils';
import {
  ApiError,
  type ApiTimelineEvent,
  clearApiTimeline,
  getApiTimelineSnapshot,
  subscribeApiTimeline,
} from './api/client';
import ConfigurationView, { type ConfigurationSidebarState } from './features/configuration/ConfigurationView';
import {
  control,
  createCase,
  fastForward,
  forceVerdict,
  getSession,
  nextTurn,
  resetTrial,
} from './api/trial';
import type {
  AgentRole as BackendAgentRole,
  ObjectionDecision,
  CreateCaseRequest,
  TrialStage as BackendTrialStage,
  TrialState as BackendTrialState,
  TranscriptEntry as BackendTranscriptEntry,
} from './api/types';
import Beams from './components/Beams';

type View = 'landing' | 'config' | 'simulation' | 'evidence' | 'transcript';
type TrialPhase = 'opening' | 'evidence' | 'cross_examination' | 'verdict';
const TRIAL_PHASES: TrialPhase[] = ['opening', 'evidence', 'cross_examination', 'verdict'];
const SESSION_STORAGE_KEY = 'supreme.session_id';
const VERDICT_MESSAGE_CACHE_KEY = 'supreme.verdict_message_cache';

type TranscriptDisplayEntry = {
  id: string | number;
  type: 'statement' | 'qna' | 'ruling';
  speaker: string;
  timestamp: string;
  text?: string;
  question?: string;
  answer?: string;
  raw: BackendTranscriptEntry;
};

type SpeechStatus =
  | 'unsupported'
  | 'idle'
  | 'loading-voices'
  | 'speaking'
  | 'blocked'
  | 'error';

type SpeechState = {
  status: SpeechStatus;
  message: string;
  agent?: Extract<BackendAgentRole, 'prosecution' | 'defense'> | null;
};

function mapStageToPhase(stage?: BackendTrialStage | null): TrialPhase {
  switch (stage) {
    case 'OPENING_PROS':
    case 'OPENING_DEF':
      return 'opening';
    case 'EXAMINATION':
      return 'evidence';
    case 'CROSS_EXAM':
    case 'CLOSING_PROS':
    case 'CLOSING_DEF':
      return 'cross_examination';
    case 'VERDICT':
    case 'COMPLETE':
      return 'verdict';
    default:
      return 'opening';
  }
}

function formatAgent(agent: BackendAgentRole): string {
  if (agent === 'prosecution') return 'PROSECUTION COUNSEL';
  if (agent === 'defense') return 'DEFENSE COUNSEL';
  if (agent === 'witness') return 'WITNESS TESTIMONY';
  return 'ALGORITHMIC JUDGE UNIT-7';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function pickCounselVoice(
  agent: Extract<BackendAgentRole, 'prosecution' | 'defense'>,
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const englishVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
  const candidates = englishVoices.length ? englishVoices : voices;
  if (!candidates.length) return null;

  const preferredTokens = agent === 'prosecution'
    ? ['david', 'daniel', 'mark', 'george', 'male']
    : ['zira', 'samantha', 'susan', 'aria', 'female'];

  const preferred = candidates.find((voice) => {
    const name = voice.name.toLowerCase();
    return preferredTokens.some((token) => name.includes(token));
  });

  return preferred || candidates[0];
}

function toTranscriptDisplay(entries: BackendTranscriptEntry[]): TranscriptDisplayEntry[] {
  return entries.map((entry) => {
    const content = entry.redacted ? '[REDACTED BY COURT ORDER]' : entry.content;
    const citationText = entry.citations.length
      ? `\n\nCITATIONS: ${entry.citations.map((citation) => citation.case_id).join(', ')}`
      : '';
    return {
      id: entry.id,
      type: entry.agent === 'judge' ? 'ruling' : 'statement',
      speaker: formatAgent(entry.agent),
      timestamp: formatTime(entry.timestamp),
      text: `${content}${citationText}`,
      raw: entry,
    };
  });
}

function downloadDebugTranscript(state: BackendTrialState | null, timeline: ApiTimelineEvent[] = []) {
  if (!state) return;

  const payload = {
    exported_at: new Date().toISOString(),
    session_id: state.session_id,
    case: state.case,
    stage: state.stage,
    active_agent: state.active_agent,
    verdict: state.verdict,
    transcript: state.transcript,
    api_timeline: timeline,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `supreme-debug-${state.session_id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function inferEvidenceType(text: string): EvidenceType {
  const lower = text.toLowerCase();
  if (lower.includes('video') || lower.includes('cctv') || lower.includes('footage')) return 'video';
  if (lower.includes('image') || lower.includes('photo') || lower.includes('jpeg') || lower.includes('png')) return 'image';
  if (lower.includes('testimony') || lower.includes('witness') || lower.includes('statement')) return 'testimony';
  return 'document';
}

function buildEvidenceFromState(state: BackendTrialState | null): EvidenceRecord[] {
  if (!state) return [];
  const directEvidence = state.case.evidence.map((item, index) => ({
    id: `EVD-${String(index + 1).padStart(3, '0')}`,
    title: item,
    description: 'Submitted during case configuration.',
    party: index % 2 === 0 ? 'prosecution' : 'defense' as EvidenceParty,
    type: inferEvidenceType(item),
    phase: 'Case Filing',
    submittedAt: state.created_at,
    admissible: true,
    tags: ['Submitted'],
  }));

  const citedMap = new Map<string, EvidenceRecord>();
  state.transcript.forEach((entry, idx) => {
    entry.citations.forEach((citation) => {
      if (citedMap.has(citation.case_id)) return;
      citedMap.set(citation.case_id, {
        id: `CIT-${String(idx + 1).padStart(3, '0')}`,
        title: citation.case_id,
        description: citation.summary,
        party: 'court',
        type: 'document',
        phase: entry.stage.replace('_', ' '),
        submittedAt: entry.timestamp,
        admissible: true,
        tags: ['Precedent', `Score ${citation.relevance_score}`],
      });
    });
  });

  return [...directEvidence, ...Array.from(citedMap.values())];
}

function parseError(error: unknown): string {
  if (error instanceof ApiError) {
    const parts = [error.message];
    if (error.code) parts.push(`[${error.code}]`);
    if (error.hint) parts.push(error.hint);
    if (error.requestId) parts.push(`Request ID: ${error.requestId}`);
    return parts.join(' ');
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected network error.';
}

function extractDescriptionField(description: string | undefined, label: string): string | null {
  if (!description) return null;
  const prefix = `${label.toLowerCase()}:`;
  const line = description
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value || null;
}

function formatStageLabel(stage?: BackendTrialStage | null): string {
  if (!stage) return 'Proceedings in progress';
  return stage.replace(/_/g, ' ').toUpperCase();
}

type VerdictPresentation = {
  ruling: string;
  reasoning: string;
  keyFactors: string[];
  confidence: string;
};

type JudgeRulingState = {
  decision: ObjectionDecision;
  reason: string;
} | null;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normaliseVerdictText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanVerdictToken(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function extractTaggedSection(source: string, label: string, nextLabels: string[] = []): string | null {
  const labelRegex = new RegExp(`\\b${escapeRegex(label)}\\s*:\\s*`, 'i');
  const match = source.match(labelRegex);
  if (!match || match.index === undefined) return null;

  const sectionStart = match.index + match[0].length;
  const remaining = source.slice(sectionStart);
  if (!nextLabels.length) return remaining.trim() || null;

  const nextRegex = new RegExp(`\\b(?:${nextLabels.map(escapeRegex).join('|')})\\s*:`, 'i');
  const nextMatch = nextRegex.exec(remaining);
  const section = nextMatch ? remaining.slice(0, nextMatch.index) : remaining;
  return section.trim() || null;
}

function extractDecision(text: string): string | null {
  const match = text.match(/\b(NOT GUILTY|MISTRIAL|GUILTY)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractKeyFactors(text: string, fallback: string[] = []): string[] {
  const keyFactorsSection =
    extractTaggedSection(text, 'KEY FACTORS DETERMINING THE OUTCOME') ||
    extractTaggedSection(text, 'KEY FACTORS');

  if (keyFactorsSection) {
    const numbered = Array.from(
      keyFactorsSection.matchAll(/(?:^|\s)\d+\.\s+(.+?)(?=(?:\s\d+\.\s)|$)/gis),
    )
      .map((match) => cleanVerdictToken(match[1]))
      .filter(Boolean);

    if (numbered.length) return numbered.slice(0, 5);

    const bulleted = keyFactorsSection
      .split(/\n|[-•]\s+/)
      .map(cleanVerdictToken)
      .filter(Boolean);

    if (bulleted.length) return bulleted.slice(0, 5);
  }

  if (fallback.length) {
    return fallback
      .map((item) => cleanVerdictToken(normaliseVerdictText(item)))
      .filter(Boolean)
      .slice(0, 5);
  }

  return [];
}

function buildVerdictPresentation(
  verdict: BackendTrialState['verdict'],
  judgeStatement: string | null,
): VerdictPresentation {
  const primaryText = judgeStatement?.trim() || verdict?.reasoning?.trim() || '';
  const cleaned = normaliseVerdictText(primaryText);
  const ruling = verdict?.decision || extractDecision(cleaned) || 'PENDING';

  const reasoningSection = extractTaggedSection(
    cleaned,
    'REASONING',
    ['KEY FACTORS DETERMINING THE OUTCOME', 'KEY FACTORS'],
  );

  const fallbackReasoning = cleanVerdictToken(
    cleaned
      .replace(/\bVERDICT\s*:\s*(NOT GUILTY|MISTRIAL|GUILTY)\b/gi, '')
      .replace(/\bREASONING\s*:\s*/i, '')
      .replace(/\bKEY FACTORS DETERMINING THE OUTCOME\s*:[\s\S]*/i, '')
      .replace(/\bKEY FACTORS\s*:[\s\S]*/i, ''),
  );

  const reasoning =
    cleanVerdictToken(reasoningSection || '') ||
    fallbackReasoning ||
    'No detailed reasoning was provided by the judicial model.';

  const keyFactors = extractKeyFactors(cleaned, verdict?.key_factors || []);

  return {
    ruling,
    reasoning,
    keyFactors,
    confidence: verdict ? `${Math.round(verdict.confidence * 100)}%` : 'N/A',
  };
}

function buildVerdictTranscript(view: VerdictPresentation): string {
  const factorsText = view.keyFactors.length
    ? view.keyFactors.map((factor, index) => `${index + 1}. ${factor}`).join('\n')
    : 'No key factors were explicitly listed.';

  return [
    `VERDICT: ${view.ruling}`,
    '',
    'REASONING:',
    view.reasoning,
    '',
    'KEY FACTORS:',
    factorsText,
  ].join('\n');
}

function resolveObjectionDecision(resultText: string, fallback?: ObjectionDecision | null): ObjectionDecision {
  if (fallback === 'SUSTAINED' || fallback === 'OVERRULED') return fallback;
  const normalized = resultText.toUpperCase();
  if (normalized.includes('OVERRULED')) return 'OVERRULED';
  return 'SUSTAINED';
}

function downloadApiTimeline(events: ApiTimelineEvent[]): void {
  if (!events.length) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), events }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `supreme-api-timeline-${timestamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [view, setView] = useState<View>('landing');
  const [trialPhase, setTrialPhase] = useState<TrialPhase>('opening');
  const [isRedactMode, setIsRedactMode] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trialState, setTrialState] = useState<BackendTrialState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiTimelineEvents, setApiTimelineEvents] = useState<ApiTimelineEvent[]>(() => getApiTimelineSnapshot());
  const [isDebugPanelOpen, setIsDebugPanelOpen] = useState(false);

  // ── Judge state (lifted so footer button can trigger it) ────────────────
  const [isObjecting, setIsObjecting] = useState(false);
  const [objectionText, setObjectionText] = useState('');
  const [judgeRuling, setJudgeRuling] = useState<JudgeRulingState>(null);
  const [judgeStatus, setJudgeStatus] = useState<'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED'>('LISTENING');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCompact, setIsSidebarCompact] = useState(false);
  const [configSidebarState, setConfigSidebarState] = useState<ConfigurationSidebarState | null>(null);

  const handleConfigSidebarStateChange = useCallback((next: ConfigurationSidebarState) => {
    setConfigSidebarState((prev) => {
      if (
        prev
        && prev.draftStatus === next.draftStatus
        && prev.completedSteps === next.completedSteps
        && prev.totalSteps === next.totalSteps
        && prev.saveState === next.saveState
        && prev.activeStep === next.activeStep
        && prev.issueCount === next.issueCount
        && prev.lastSavedLabel === next.lastSavedLabel
      ) {
        return prev;
      }

      return next;
    });
  }, []);

  useEffect(() => subscribeApiTimeline(setApiTimelineEvents), []);

  const evidenceRecords = useMemo(() => buildEvidenceFromState(trialState), [trialState]);
  const transcriptEntries = useMemo(
    () => toTranscriptDisplay(trialState?.transcript || []),
    [trialState],
  );

  const syncSession = useCallback(async (sid: string) => {
    const state = await getSession(sid);
    setSessionId(sid);
    setTrialState(state);
    setTrialPhase(mapStageToPhase(state.stage));
    localStorage.setItem(SESSION_STORAGE_KEY, sid);
  }, []);

  useEffect(() => {
    const sid = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!sid) return;

    setIsLoading(true);
    syncSession(sid)
      .then(() => {
        setView('simulation');
        setApiError(null);
      })
      .catch(() => {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [syncSession]);

  const withSessionAction = useCallback(async (action: () => Promise<void>) => {
    setIsLoading(true);
    setApiError(null);
    try {
      await action();
    } catch (error) {
      setApiError(parseError(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleCreateCase = useCallback(async (payload: CreateCaseRequest) => {
    await withSessionAction(async () => {
      const created = await createCase(payload);
      await syncSession(created.session_id);
      setView('simulation');
      setJudgeStatus('LISTENING');
      setJudgeRuling(null);
    });
  }, [syncSession, withSessionAction]);

  const handleObjection = () => {
    if (!sessionId || isLoading) return;
    setIsObjecting(true);
    setJudgeStatus('HALTED');
  };

  const submitObjection = () => {
    if (!sessionId || !objectionText.trim() || isLoading) return;
    const payload = objectionText.trim();
    setJudgeStatus('EVALUATING');
    setObjectionText('');
    setIsObjecting(false);
    withSessionAction(async () => {
      const response = await control(sessionId, { action: 'objection', payload });
      await syncSession(sessionId);
      const decision = resolveObjectionDecision(response.result, response.objection?.decision);
      setJudgeRuling({
        decision,
        reason: response.objection?.reason || response.result || 'No ruling reason provided by backend.',
      });
      setJudgeStatus('RULING');
    });
  };

  const handleInjectTestimony = useCallback(() => {
    if (!sessionId || isLoading) return;
    const testimony = window.prompt('Enter witness testimony to inject into the record:');
    if (!testimony || !testimony.trim()) return;
    withSessionAction(async () => {
      await control(sessionId, { action: 'inject_testimony', payload: testimony.trim() });
      await syncSession(sessionId);
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const handleRedact = useCallback(() => {
    if (!sessionId || isLoading) return;
    const matchText = window.prompt('Enter text to redact from transcript entries:');
    if (!matchText || !matchText.trim()) return;
    setIsRedactMode(true);
    withSessionAction(async () => {
      try {
        await control(sessionId, { action: 'redact', payload: matchText.trim() });
        await syncSession(sessionId);
      } finally {
        setTimeout(() => setIsRedactMode(false), 900);
      }
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const handleVerdict = useCallback(() => {
    if (!sessionId || isLoading) return;
    withSessionAction(async () => {
      await forceVerdict(sessionId);
      await syncSession(sessionId);
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const handleNextTurn = useCallback(() => {
    if (!sessionId || isLoading) return;
    withSessionAction(async () => {
      await nextTurn(sessionId);
      await syncSession(sessionId);
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const handleFastForward = useCallback(() => {
    if (!sessionId || isLoading) return;
    withSessionAction(async () => {
      await fastForward(sessionId);
      await syncSession(sessionId);
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const handleReset = useCallback(() => {
    if (!sessionId || isLoading) return;
    withSessionAction(async () => {
      await resetTrial(sessionId);
      await syncSession(sessionId);
      setJudgeStatus('LISTENING');
      setJudgeRuling(null);
    });
  }, [isLoading, sessionId, syncSession, withSessionAction]);

  const resumeProceedings = () => { setJudgeRuling(null); setJudgeStatus('LISTENING'); };

  const phaseIndex = TRIAL_PHASES.indexOf(trialPhase);
  const goNext = () => handleNextTurn();
  const defendantName = useMemo(
    () => extractDescriptionField(trialState?.case.description, 'Defendant') || 'UNSPECIFIED DEFENDANT',
    [trialState?.case.description],
  );

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [view]);

  useEffect(() => {
    if (!isSidebarOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isSidebarOpen]);

  return (
    <div className="min-h-screen bg-background text-primary selection:bg-primary selection:text-background font-mono uppercase">
      <button
        type="button"
        onClick={() => setIsSidebarOpen(true)}
        className="fixed top-0 left-0 right-0 z-[70] flex h-14 items-center justify-between border-b border-primary/30 bg-background/95 px-4 md:hidden"
      >
        <span className="inline-flex items-center gap-3">
          <img src="/logo.png" alt="Logo" className="h-8 w-8 object-contain invert" />
          <span className="text-sm font-bold tracking-[0.2em]">SUPREME</span>
        </span>
        <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.15em] text-outline">
          <Menu className="h-4 w-4" />
          PANEL
        </span>
      </button>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-[65] hidden border-r border-primary bg-background transition-[width] duration-200 md:block',
          isSidebarCompact ? 'w-20' : 'w-72',
        )}
      >
        <AppSidebar
          view={view}
          onNavigate={setView}
          isCompact={isSidebarCompact}
          onToggleCompact={() => setIsSidebarCompact((prev) => !prev)}
          sessionId={sessionId}
          isLoading={isLoading}
          apiError={apiError}
          trialState={trialState}
          trialPhase={trialPhase}
          judgeStatus={judgeStatus}
          evidenceCount={evidenceRecords.length}
          transcriptCount={transcriptEntries.length}
          defendantName={defendantName}
          configState={configSidebarState}
        />
      </aside>

      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.button
              type="button"
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 z-[82] bg-black/70 md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-[85] w-[min(88vw,320px)] border-r border-primary bg-background md:hidden"
              initial={{ x: -360 }}
              animate={{ x: 0 }}
              exit={{ x: -360 }}
            >
              <AppSidebar
                view={view}
                onNavigate={(nextView) => {
                  setView(nextView);
                  setIsSidebarOpen(false);
                }}
                onCloseMobile={() => setIsSidebarOpen(false)}
                sessionId={sessionId}
                isLoading={isLoading}
                apiError={apiError}
                trialState={trialState}
                trialPhase={trialPhase}
                judgeStatus={judgeStatus}
                evidenceCount={evidenceRecords.length}
                transcriptCount={transcriptEntries.length}
                defendantName={defendantName}
                configState={configSidebarState}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className={cn('md:pl-72 transition-[padding] duration-200', isSidebarCompact && 'md:pl-20')}>
        <div className="pt-14 md:pt-0">
          <AnimatePresence mode="wait">
            {view === 'landing' && (
              <motion.div key="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full">
                <LandingView onStart={() => setView('config')} />
              </motion.div>
            )}
            {view === 'config' && (
              <motion.div key="config" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full">
                <ConfigurationView
                  onStart={handleCreateCase}
                  isLoading={isLoading}
                  isSidebarCompact={isSidebarCompact}
                  onSidebarStateChange={handleConfigSidebarStateChange}
                />
              </motion.div>
            )}
            {view === 'simulation' && (
              <motion.div key="simulation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full">
                <SimulationView
                  trialState={trialState}
                  trialPhase={trialPhase}
                  isSidebarCompact={isSidebarCompact}
                  isRedactMode={isRedactMode}
                  isLoading={isLoading}
                  onViewEvidence={() => setView('evidence')}
                  onViewTranscript={() => setView('transcript')}
                  onFastForward={handleFastForward}
                  isObjecting={isObjecting}
                  setIsObjecting={setIsObjecting}
                  objectionText={objectionText}
                  setObjectionText={setObjectionText}
                  judgeRuling={judgeRuling}
                  judgeStatus={judgeStatus}
                  setJudgeStatus={setJudgeStatus}
                  submitObjection={submitObjection}
                  resumeProceedings={resumeProceedings}
                />
              </motion.div>
            )}
            {view === 'evidence' && (
              <motion.div key="evidence" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="w-full">
                <EvidenceView
                  onBack={() => setView('simulation')}
                  onViewTranscript={() => setView('transcript')}
                  records={evidenceRecords}
                />
              </motion.div>
            )}
            {view === 'transcript' && (
              <motion.div key="transcript" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="w-full">
                <TranscriptView
                  onBack={() => setView('simulation')}
                  onViewEvidence={() => setView('evidence')}
                  entries={transcriptEntries}
                  caseId={trialState?.case.case_id}
                  trialState={trialState}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Bottom Controls — simulation only, slides up on mount */}
      <AnimatePresence>
        {view === 'simulation' && (
          <motion.footer
            key="footer"
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className={cn(
              'fixed bottom-0 left-0 right-0 z-50 flex justify-around items-center h-20 px-8 bg-background/90 backdrop-blur-xl border-t border-primary transition-[left] duration-200',
              isSidebarCompact ? 'md:left-20' : 'md:left-72',
            )}
          >
            <ControlBtn
              icon={<Mic className="w-5 h-5" />}
              label="RECORD"
              onClick={handleInjectTestimony}
              disabled={!sessionId || isLoading}
            />
            <ControlBtn
              icon={<StepBack className="w-5 h-5" />}
              label="RESET TRIAL"
              onClick={handleReset}
              disabled={!sessionId || isLoading}
            />
            <ControlBtn
              icon={<Gavel className="w-5 h-5" />}
              label="OBJECTION"
              onClick={handleObjection}
              isActive={judgeStatus === 'HALTED' || judgeStatus === 'EVALUATING'}
              disabled={!sessionId || isLoading}
            />
            <ControlBtn
              icon={<StepForward className="w-5 h-5" />}
              label="NEXT"
              onClick={goNext}
              isActive={phaseIndex === TRIAL_PHASES.length - 1}
              disabled={!sessionId || isLoading}
            />
            <ControlBtn
              icon={<Pause className="w-5 h-5" />}
              label="FORCE VERDICT"
              onClick={handleVerdict}
              disabled={!sessionId || isLoading}
            />
            <ControlBtn
              icon={<Eraser className="w-5 h-5" />}
              label="REDACT"
              onClick={handleRedact}
              isActive={isRedactMode}
              disabled={!sessionId || isLoading}
            />
          </motion.footer>
        )}
      </AnimatePresence>

      {view === 'simulation' && (
        <DebugOverflowPanel
          isOpen={isDebugPanelOpen}
          events={apiTimelineEvents}
          onToggle={() => setIsDebugPanelOpen((prev) => !prev)}
          onClear={clearApiTimeline}
          onExport={() => downloadApiTimeline(apiTimelineEvents)}
        />
      )}
    </div>
  );
}

type AppSidebarProps = {
  view: View;
  onNavigate: (view: View) => void;
  isCompact?: boolean;
  onToggleCompact?: () => void;
  onCloseMobile?: () => void;
  sessionId: string | null;
  isLoading: boolean;
  apiError: string | null;
  trialState: BackendTrialState | null;
  trialPhase: TrialPhase;
  judgeStatus: 'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED';
  evidenceCount: number;
  transcriptCount: number;
  defendantName: string;
  configState: ConfigurationSidebarState | null;
};

function sidebarItemClass(active: boolean): string {
  return cn(
    'flex w-full items-center justify-start gap-3 border px-3 py-2 text-[10px] tracking-[0.18em] transition-colors',
    active
      ? 'border-primary bg-primary text-background'
      : 'border-outline/30 text-outline hover:border-primary hover:text-primary',
  );
}

function AppSidebar({
  view,
  onNavigate,
  isCompact = false,
  onToggleCompact,
  onCloseMobile,
  sessionId,
  isLoading,
  apiError,
  trialState,
  trialPhase,
  judgeStatus,
  evidenceCount,
  transcriptCount,
  defendantName,
  configState,
}: AppSidebarProps) {
  const navItems: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: 'landing', label: 'HOME', icon: <Gavel className="h-4 w-4" /> },
    { id: 'config', label: 'CONFIGURATION', icon: <BookOpen className="h-4 w-4" /> },
    { id: 'simulation', label: 'DOCKET', icon: <Terminal className="h-4 w-4" /> },
    { id: 'evidence', label: 'EVIDENCE', icon: <FolderOpen className="h-4 w-4" /> },
    { id: 'transcript', label: 'TRANSCRIPT', icon: <FileText className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className={cn('border-b border-primary', isCompact ? 'px-3 py-4' : 'px-5 py-5')}>
        <div className={cn('flex items-center', isCompact ? 'justify-center' : 'gap-3')}>
          <img src="/logo.png" alt="Logo" className="h-10 w-10 object-contain invert" />
          {!isCompact && (
            <div>
              <h1 className="font-sans text-lg font-bold tracking-[0.15em]">SUPREME</h1>
              <p className="text-[9px] tracking-[0.2em] text-outline">COURT MANAGEMENT</p>
            </div>
          )}
        </div>
        <div className={cn('mt-3 flex', isCompact ? 'justify-center' : 'items-center justify-between')}>
          {onToggleCompact && (
            <button
              type="button"
              onClick={onToggleCompact}
              className={cn(
                'inline-flex items-center gap-2 border border-outline/40 px-2 py-1 text-[9px] tracking-[0.15em] text-outline hover:border-primary hover:text-primary',
                isCompact && 'h-8 w-8 justify-center px-0',
              )}
              title={isCompact ? 'Expand sidebar' : 'Compact sidebar'}
              aria-label={isCompact ? 'Expand sidebar' : 'Compact sidebar'}
            >
              {isCompact ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
              {!isCompact && <span>{isCompact ? 'EXPAND' : 'COMPACT'}</span>}
            </button>
          )}
          {onCloseMobile && !isCompact && (
            <button
              type="button"
              onClick={onCloseMobile}
              className="inline-flex h-8 w-8 items-center justify-center border border-outline/40 text-outline hover:border-primary hover:text-primary md:hidden"
              aria-label="Close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className={cn('border-b border-primary/30', isCompact ? 'px-3 py-3' : 'px-5 py-4')}>
        {!isCompact && <p className="mb-2 text-[9px] tracking-[0.25em] text-outline">SESSION STATUS</p>}
        {apiError ? (
          <p className={cn('text-[10px] tracking-[0.15em] text-red-400', isCompact && 'text-center')}>{isCompact ? 'ERR' : `API ERROR: ${apiError}`}</p>
        ) : (
          <p className={cn('text-[10px] tracking-[0.15em] text-outline', isCompact && 'text-center')}>
            {isCompact ? (isLoading ? 'SYNC' : 'LIVE') : (isLoading ? 'SYNCING SESSION...' : 'SESSION CONNECTED')}
          </p>
        )}
        {!isCompact && <p className="mt-1 break-all text-[10px] tracking-[0.1em] text-outline">SID: {sessionId || 'N/A'}</p>}
      </div>

      <nav className={cn('space-y-2 border-b border-primary/30', isCompact ? 'px-2 py-3' : 'px-5 py-4')}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={cn(sidebarItemClass(view === item.id), isCompact && 'h-10 justify-center px-2')}
            title={item.label}
          >
            {item.icon}
            {!isCompact && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className={cn('flex-1 space-y-4 overflow-y-auto', isCompact ? 'px-2 py-3' : 'px-5 py-4')}>
        {isCompact ? (
          <div className="space-y-2">
            <div className="border border-primary/20 bg-surface-container-low px-2 py-2 text-center text-[9px] tracking-[0.12em] text-outline">
              SECURE
            </div>
            {view === 'config' && configState && (
              <div className="border border-primary/20 bg-surface-container-low px-2 py-2 text-center text-[9px] tracking-[0.12em] text-outline">
                CFG {configState.completedSteps}/{configState.totalSteps}
              </div>
            )}
            {view === 'simulation' && (
              <div className="border border-primary/20 bg-surface-container-low px-2 py-2 text-center text-[9px] tracking-[0.12em] text-outline">
                {judgeStatus}
              </div>
            )}
            {view === 'evidence' && (
              <div className="border border-primary/20 bg-surface-container-low px-2 py-2 text-center text-[9px] tracking-[0.12em] text-outline">
                EVD {evidenceCount}
              </div>
            )}
            {view === 'transcript' && (
              <div className="border border-primary/20 bg-surface-container-low px-2 py-2 text-center text-[9px] tracking-[0.12em] text-outline">
                TXT {transcriptCount}
              </div>
            )}
          </div>
        ) : (
          <>
        <div className="border border-primary/20 bg-surface-container-low px-3 py-3">
          <p className="text-[9px] tracking-[0.2em] text-outline">COURT SECURITY</p>
          <p className="mt-2 text-[10px] tracking-[0.1em] text-primary">END-TO-END ENCRYPTION: ACTIVE</p>
          <p className="mt-1 text-[10px] tracking-[0.1em] text-primary">LOCAL PROCESSING: TRUE</p>
          <p className="mt-1 text-[10px] tracking-[0.1em] text-outline">DATA LOGGING: NONE</p>
        </div>

        {view === 'config' && configState && (
          <div className="border border-primary/20 bg-surface-container-low px-3 py-3">
            <p className="text-[9px] tracking-[0.2em] text-outline">CONFIGURATION LIVE</p>
            <p className="mt-2 text-[10px] tracking-[0.12em] text-primary">
              STATUS: {configState.draftStatus.toUpperCase()}
            </p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">
              STEPS: {configState.completedSteps}/{configState.totalSteps}
            </p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">
              ACTIVE: {configState.activeStep.toUpperCase()}
            </p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">
              SAVE: {configState.saveState.toUpperCase()}
            </p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">ISSUES: {configState.issueCount}</p>
            <p className="mt-1 text-[10px] tracking-[0.1em] text-outline normal-case">
              Last saved: {configState.lastSavedLabel}
            </p>
          </div>
        )}

        {view === 'simulation' && (
          <div className="border border-primary/20 bg-surface-container-low px-3 py-3">
            <p className="text-[9px] tracking-[0.2em] text-outline">TRIAL LIVE</p>
            <p className="mt-2 text-[10px] tracking-[0.12em] text-primary">PHASE: {trialPhase.replace('_', ' ')}</p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">JUDGE: {judgeStatus}</p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">ACTIVE AGENT: {trialState?.active_agent || 'N/A'}</p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">DEFENDANT: {defendantName}</p>
          </div>
        )}

        {view === 'evidence' && (
          <div className="border border-primary/20 bg-surface-container-low px-3 py-3">
            <p className="text-[9px] tracking-[0.2em] text-outline">EVIDENCE LIVE</p>
            <p className="mt-2 text-[10px] tracking-[0.12em] text-primary">TOTAL RECORDS: {evidenceCount}</p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">SESSION: {sessionId ? 'ACTIVE' : 'NO SESSION'}</p>
          </div>
        )}

        {view === 'transcript' && (
          <div className="border border-primary/20 bg-surface-container-low px-3 py-3">
            <p className="text-[9px] tracking-[0.2em] text-outline">TRANSCRIPT LIVE</p>
            <p className="mt-2 text-[10px] tracking-[0.12em] text-primary">ENTRIES: {transcriptCount}</p>
            <p className="mt-1 text-[10px] tracking-[0.12em] text-outline">STAGE: {formatStageLabel(trialState?.stage)}</p>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

function ControlBtn({
  icon, label, onClick, isActive, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  isActive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center justify-center px-4 py-2 transition-all duration-100 active:scale-95 min-w-[60px] disabled:opacity-35 disabled:cursor-not-allowed",
        isActive ? "bg-primary text-background" : "text-primary hover:bg-surface-container"
      )}
    >
      {icon}
      <span className="text-[10px] font-bold mt-1 tracking-widest">{label}</span>
    </button>
  );
}

function DebugOverflowPanel({
  isOpen,
  events,
  onToggle,
  onClear,
  onExport,
}: {
  isOpen: boolean;
  events: ApiTimelineEvent[];
  onToggle: () => void;
  onClear: () => void;
  onExport: () => void;
}) {
  const recent = useMemo(() => [...events].slice(-20).reverse(), [events]);

  return (
    <>
      <button
        onClick={onToggle}
        className="fixed bottom-24 right-4 z-[60] border border-primary/40 bg-background/95 px-3 py-2 text-[9px] tracking-[0.2em] hover:border-primary hover:text-primary transition-colors"
      >
        DEBUG {isOpen ? 'OFF' : 'ON'} ({events.length})
      </button>

      {isOpen && (
        <div className="fixed bottom-36 right-4 z-[60] w-[min(92vw,560px)] h-[300px] border border-primary/30 bg-background/95 backdrop-blur overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20">
            <div className="text-[9px] tracking-[0.2em] text-outline">API EVENT OVERFLOW</div>
            <div className="flex items-center gap-2">
              <button onClick={onExport} className="p-1.5 hover:text-primary transition-colors" title="Export events">
                <Download className="w-3.5 h-3.5" />
              </button>
              <button onClick={onClear} className="p-1.5 hover:text-primary transition-colors" title="Clear events">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={onToggle} className="p-1.5 hover:text-primary transition-colors" title="Close panel">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto text-[10px]">
            {!recent.length && <div className="px-3 py-4 text-outline">No API events captured yet.</div>}
            {recent.map((event) => (
              <div key={event.id} className="px-3 py-2 border-b border-primary/10 font-mono normal-case">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-outline">{event.event}</span>
                  <span className="text-outline">{event.method} {event.path}</span>
                </div>
                <div className="flex items-center justify-between gap-3 mt-1 text-outline/80">
                  <span>{new Date(event.at).toLocaleTimeString('en-GB')}</span>
                  <span>
                    {typeof event.status === 'number' ? `status ${event.status}` : 'pending'}
                    {typeof event.latencyMs === 'number' ? ` - ${event.latencyMs}ms` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Evidence Types ────────────────────────────────────────────────────────────
type EvidenceParty = 'prosecution' | 'defense' | 'court';
type EvidenceType = 'document' | 'image' | 'video' | 'testimony' | 'physical';

interface EvidenceRecord {
  id: string;
  title: string;
  description: string;
  party: EvidenceParty;
  type: EvidenceType;
  phase: string;
  submittedAt: string;
  admissible: boolean;
  tags: string[];
}

const PARTY_STYLES: Record<EvidenceParty, { label: string; bar: string; badge: string; text: string }> = {
  prosecution: { label: 'Prosecution', bar: 'bg-white', badge: 'bg-white text-black', text: 'text-white' },
  defense: { label: 'Defense', bar: 'bg-[#6b7280]', badge: 'bg-[#6b7280] text-white', text: 'text-[#9ca3af]' },
  court: { label: 'Court', bar: 'bg-[#d4af37]', badge: 'bg-[#d4af37] text-black', text: 'text-[#d4af37]' },
};

const TYPE_ICONS: Record<EvidenceType, React.ReactNode> = {
  document: <FileText className="w-4 h-4" />,
  image: <Image className="w-4 h-4" />,
  video: <Film className="w-4 h-4" />,
  testimony: <User className="w-4 h-4" />,
  physical: <FileSearch className="w-4 h-4" />,
};

function EvidenceView({
  onBack,
  onViewTranscript,
  records,
}: {
  onBack: () => void;
  onViewTranscript: () => void;
  records: EvidenceRecord[];
}) {
  const [filter, setFilter] = useState<EvidenceParty | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<EvidenceType | 'all'>('all');

  const filtered = records.filter(e =>
    (filter === 'all' || e.party === filter) &&
    (typeFilter === 'all' || e.type === typeFilter)
  );

  return (
    <main className="flex min-h-screen bg-background">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Page Header */}
        <div className="px-10 py-8 border-b border-primary flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-extrabold font-sans tracking-tighter mb-1">EVIDENCE REGISTER</h1>
            <p className="text-[10px] text-outline tracking-widest uppercase">{filtered.length} of {records.length} Records — Current Session</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={onBack}
              className="text-[10px] tracking-widest px-3 py-1 border border-primary/40 text-outline hover:border-primary hover:text-primary"
            >
              DOCKET
            </button>
            <button
              onClick={onViewTranscript}
              className="text-[10px] tracking-widest px-3 py-1 border border-primary/40 text-outline hover:border-primary hover:text-primary"
            >
              TRANSCRIPT
            </button>
            <Scale className="w-4 h-4 text-outline" />
            <span className="text-[10px] text-outline tracking-widest uppercase">Filter by Party:</span>
            {(['all', 'prosecution', 'defense', 'court'] as const).map(p => (
              <button
                key={p}
                onClick={() => setFilter(p)}
                className={cn(
                  "text-[10px] tracking-widest px-3 py-1 border transition-colors font-bold uppercase",
                  filter === p ? "bg-primary text-background border-primary" : "border-primary/40 text-outline hover:border-primary hover:text-primary"
                )}
              >
                {p === 'all' ? 'All' : PARTY_STYLES[p].label}
              </button>
            ))}
          </div>
        </div>

        {/* Type Filter Strip */}
        <div className="px-10 py-3 border-b border-primary/30 flex gap-4 items-center flex-wrap">
          <Filter className="w-3 h-3 text-outline" />
          <span className="text-[9px] text-outline tracking-widest">TYPE:</span>
          {(['all', 'document', 'image', 'video', 'testimony', 'physical'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cn(
                "text-[9px] tracking-widest px-2 py-0.5 uppercase transition-colors",
                typeFilter === t ? "text-primary underline underline-offset-4" : "text-outline hover:text-primary"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Evidence Table */}
        <div className="flex-1 px-10 py-6 space-y-3 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="py-20 text-center text-outline text-sm tracking-widest">No evidence matches the current filter.</div>
          )}
          {filtered.map((ev) => {
            const ps = PARTY_STYLES[ev.party];
            return (
              <div key={ev.id} className="flex gap-0 border border-primary/20 hover:border-primary transition-colors group relative overflow-hidden">
                {/* Party colour bar */}
                <div className={cn("w-1 flex-none", ps.bar)} />

                {/* Content */}
                <div className="flex-1 p-5 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Exhibit ID */}
                      <span className="text-[10px] font-mono text-outline border border-primary/30 px-2 py-0.5">{ev.id}</span>
                      {/* Type badge */}
                      <span className="flex items-center gap-1.5 text-[10px] tracking-widest text-outline uppercase border border-primary/20 px-2 py-0.5">
                        {TYPE_ICONS[ev.type]} {ev.type}
                      </span>
                      {/* Party badge */}
                      <span className={cn("text-[10px] tracking-widest font-bold px-2 py-0.5 uppercase", ps.badge)}>
                        {ps.label}
                      </span>
                      {/* Admissibility */}
                      <span className={cn(
                        "text-[10px] tracking-widest px-2 py-0.5 uppercase font-bold border",
                        ev.admissible ? "text-green-500 border-green-500/40" : "text-red-500 border-red-500/40"
                      )}>
                        {ev.admissible ? 'Admitted' : 'Objected'}
                      </span>
                    </div>
                    {/* Time & phase */}
                    <div className="flex flex-col items-end gap-1 text-[9px] text-outline shrink-0">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(ev.submittedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="uppercase tracking-widest">{ev.phase}</span>
                    </div>
                  </div>

                  <div>
                    <p className={cn("font-bold tracking-tight font-sans text-sm mb-1 group-hover:text-primary transition-colors", ps.text)}>{ev.title}</p>
                    <p className="text-[11px] text-outline leading-relaxed normal-case">{ev.description}</p>
                  </div>

                  {/* Tags */}
                  <div className="flex gap-2 flex-wrap">
                    {ev.tags.map(tag => (
                      <span key={tag} className="text-[9px] text-outline border border-primary/10 px-2 py-0.5 tracking-widest uppercase">{tag}</span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function LandingView({ onStart }: { onStart: () => void }) {

  return (
    <main className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute -inset-x-[14%] -inset-y-[10%] opacity-95 pointer-events-none">
        <Beams
          beamWidth={4.2}
          beamHeight={26}
          beamNumber={24}
          lightColor="#d4af37"
          speed={1.25}
          noiseIntensity={0.85}
          scale={0.28}
          rotation={-4}
        />
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(212,175,55,0.16),transparent_34%),linear-gradient(180deg,rgba(0,0,0,0.18)_0%,rgba(0,0,0,0.76)_58%,rgba(0,0,0,0.96)_100%)] pointer-events-none" />

      <div className="relative z-10 text-center px-4">
        <div className="mb-3 text-outline tracking-[0.55em] text-xs">YOU CAN&apos;T KNOW IT ALL</div>
        <h1 className="text-7xl md:text-9xl font-extrabold tracking-tighter mb-5 font-sans">
          SUPREME
        </h1>
        <p className="mx-auto mb-10 max-w-2xl text-sm md:text-base leading-relaxed text-primary/75 normal-case">
          A cinematic AI courtroom simulator where prosecution, defense, and judge argue through a live procedural record.
        </p>

        <div className="flex flex-col md:flex-row gap-12 items-center justify-center mb-16">
          <div className="flex flex-col items-center gap-6">
            <button
              onClick={onStart}
              className="px-12 py-4 border border-primary bg-transparent text-primary font-bold text-xl tracking-widest hover:bg-primary hover:text-background transition-all duration-300 active:scale-95 group relative overflow-hidden"
            >
              <span className="relative z-10">START</span>
            </button>
            <div className="flex items-center gap-2 text-[10px] text-outline-variant uppercase">
              <span className="w-2 h-2 bg-outline-variant rounded-full animate-pulse" />
              Ready to proceed
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 w-full px-12 grid grid-cols-1 md:grid-cols-3 gap-0 border-t border-primary/10">
        <InfoBlock title="STEP 1" content="Input all case details, define parties, establish timelines, and upload evidence for indexing.." />
        <InfoBlock title="STEP 2" content="Run multi-phase court proceedings, including opening statements, evidence presentation, and cross-examination." />
        <InfoBlock title="STEP 3" content="The algorithmic judge evaluates all session transcripts and evidence to render a final, impartial ruling." />
      </div>
    </main>
  );
}

function InfoBlock({ title, content }: { title: string, content: string }) {
  return (
    <div className="p-8 border-r border-primary/10 last:border-r-0">
      <h3 className="text-xs text-outline mb-2">{title}</h3>
      <p className="text-sm text-outline leading-relaxed">{content}</p>
    </div>
  );
}

function SimulationView({
  trialState,
  trialPhase,
  isSidebarCompact,
  isRedactMode,
  isLoading,
  onViewEvidence,
  onViewTranscript,
  onFastForward,
  isObjecting,
  setIsObjecting,
  objectionText,
  setObjectionText,
  judgeRuling,
  judgeStatus,
  setJudgeStatus,
  submitObjection,
  resumeProceedings,
}: {
  trialState: BackendTrialState | null;
  trialPhase: TrialPhase;
  isSidebarCompact: boolean;
  isRedactMode: boolean;
  isLoading: boolean;
  onViewEvidence: () => void;
  onViewTranscript: () => void;
  onFastForward: () => void;
  isObjecting: boolean;
  setIsObjecting: (v: boolean) => void;
  objectionText: string;
  setObjectionText: (v: string) => void;
  judgeRuling: JudgeRulingState;
  judgeStatus: 'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED';
  setJudgeStatus: (v: 'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED') => void;
  submitObjection: () => void;
  resumeProceedings: () => void;
}) {
  // ── Judge HUD state ───────────────────────────────────────────────
  // verdictLean: 0 = full defense, 100 = full prosecution
  const [verdictLean, setVerdictLean] = useState(52);
  const [sessionSeconds, setSessionSeconds] = useState(120);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spokenEntriesRef = useRef<Set<string>>(new Set());
  const [speechState, setSpeechState] = useState<SpeechState>({
    status: 'idle',
    message: 'Awaiting a new argument to narrate.',
    agent: null,
  });

  const transcript = trialState?.transcript || [];
  const prosecutionLatest = [...transcript].reverse().find((entry) => entry.agent === 'prosecution');
  const defenseLatest = [...transcript].reverse().find((entry) => entry.agent === 'defense');
  const judgeLatest = [...transcript].reverse().find((entry) => entry.agent === 'judge');

  const objections = useMemo(() => {
    return transcript.reduce(
      (acc, entry) => {
        if (!entry.content.toUpperCase().includes('OBJECTION')) return acc;
        if (entry.agent === 'prosecution') acc.prosecution += 1;
        if (entry.agent === 'defense') acc.defense += 1;
        return acc;
      },
      { prosecution: 0, defense: 0 },
    );
  }, [transcript]);

  // Reset timer & drift verdict lean when phase changes
  useEffect(() => {
    setSessionSeconds(120);
    if (trialState?.verdict) {
      if (trialState.verdict.decision === 'GUILTY') {
        setVerdictLean(85);
      } else if (trialState.verdict.decision === 'NOT GUILTY') {
        setVerdictLean(15);
      } else {
        setVerdictLean(50);
      }
      return;
    }
    setVerdictLean(prev => Math.min(95, Math.max(5, prev + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 12 + 3))));
  }, [trialPhase, trialState?.verdict]);

  // Live countdown
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setSessionSeconds(s => {
        if (s <= 1) { clearInterval(timerRef.current!); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [trialPhase]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setSpeechState({
        status: 'unsupported',
        message: 'Speech synthesis is not available in this browser.',
        agent: null,
      });
      return;
    }

    const latestCounselEntry = [...transcript]
      .reverse()
      .find(
        (
          entry,
        ): entry is BackendTranscriptEntry & { agent: Extract<BackendAgentRole, 'prosecution' | 'defense'> } =>
          (entry.agent === 'prosecution' || entry.agent === 'defense')
          && !entry.redacted
          && Boolean(entry.content?.trim()),
      );

    if (!latestCounselEntry) {
      setSpeechState({
        status: 'idle',
        message: 'Awaiting a new argument to narrate.',
        agent: null,
      });
      return;
    }

    const spokenKey = `${trialState?.session_id || 'local'}:${latestCounselEntry.id}:${latestCounselEntry.agent}`;
    if (spokenEntriesRef.current.has(spokenKey)) return;
    spokenEntriesRef.current.add(spokenKey);

    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(latestCounselEntry.content);
    utterance.rate = latestCounselEntry.agent === 'prosecution' ? 0.94 : 1.02;
    utterance.pitch = latestCounselEntry.agent === 'prosecution' ? 0.86 : 1.08;
    utterance.volume = 1;
    utterance.onstart = () => {
      setSpeechState({
        status: 'speaking',
        message: `${formatAgent(latestCounselEntry.agent)} is speaking.`,
        agent: latestCounselEntry.agent,
      });
    };
    utterance.onend = () => {
      setSpeechState({
        status: 'idle',
        message: `${formatAgent(latestCounselEntry.agent)} finished speaking.`,
        agent: latestCounselEntry.agent,
      });
    };
    utterance.onerror = (event) => {
      spokenEntriesRef.current.delete(spokenKey);
      setSpeechState({
        status: 'error',
        message: `Speech synthesis failed: ${event.error || 'unknown error'}.`,
        agent: latestCounselEntry.agent,
      });
    };

    const speak = () => {
      const selectedVoice = pickCounselVoice(latestCounselEntry.agent, synth.getVoices());
      if (selectedVoice) utterance.voice = selectedVoice;
      setSpeechState({
        status: 'loading-voices',
        message: `Preparing ${formatAgent(latestCounselEntry.agent)} voice output.`,
        agent: latestCounselEntry.agent,
      });
      synth.cancel();
      synth.resume();
      synth.speak(utterance);
      window.setTimeout(() => {
        if (!synth.speaking) {
          spokenEntriesRef.current.delete(spokenKey);
          setSpeechState({
            status: 'blocked',
            message: 'Speech did not start. Browser autoplay or voice permissions may be blocking TTS.',
            agent: latestCounselEntry.agent,
          });
        }
      }, 400);
    };

    if (synth.getVoices().length === 0) {
      setSpeechState({
        status: 'loading-voices',
        message: 'Waiting for browser voices to load.',
        agent: latestCounselEntry.agent,
      });
      const onVoicesChanged = () => {
        synth.removeEventListener('voiceschanged', onVoicesChanged);
        speak();
      };
      const fallbackTimeout = window.setTimeout(onVoicesChanged, 250);
      synth.addEventListener('voiceschanged', onVoicesChanged);
      return () => {
        window.clearTimeout(fallbackTimeout);
        synth.removeEventListener('voiceschanged', onVoicesChanged);
      };
    }

    speak();
  }, [transcript, trialState?.session_id]);

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
    };
  }, []);

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const timerUrgent = sessionSeconds <= 20;

  const phaseLabels: Record<TrialPhase, string> = {
    opening: 'SESSION 1 — OPENING',
    evidence: 'SESSION 2 — EVIDENCE',
    cross_examination: 'CROSS-EXAMINATION',
    verdict: 'FINAL VERDICT',
  };

  return (
    <div
      className={cn(
        'fixed inset-x-0 top-14 bottom-20 overflow-hidden md:top-0',
        isSidebarCompact ? 'md:left-20' : 'md:left-72',
      )}
      style={{ cursor: isRedactMode ? 'crosshair' : undefined }}
    >
      {/* Judge Status Banner */}
      <div className={cn(
        "absolute top-0 left-0 right-0 h-8 flex items-center px-6 gap-3 z-30 border-b border-primary/30 font-mono text-[9px] tracking-[0.3em] uppercase transition-colors duration-300",
        judgeStatus === 'LISTENING' && "bg-background",
        judgeStatus === 'HALTED' && "bg-primary/10",
        judgeStatus === 'EVALUATING' && "bg-primary/5",
        judgeStatus === 'RULING' && "bg-background",
      )}>
        <span className="text-outline">JUDGE: </span>
        {judgeStatus === 'LISTENING' && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
        {judgeStatus === 'EVALUATING' && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-ping" />}
        {judgeStatus === 'HALTED' && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
        {judgeStatus === 'RULING' && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
        <span className={cn(
          "font-bold",
          judgeStatus === 'LISTENING' && "text-green-500",
          judgeStatus === 'HALTED' && "text-red-400",
          judgeStatus === 'EVALUATING' && "text-yellow-400",
          judgeStatus === 'RULING' && "text-primary",
        )}>{judgeStatus}</span>
        {judgeStatus === 'EVALUATING' && <span className="text-outline animate-pulse">— Analysing grounds for objection…</span>}
      </div>

      {/* Simulation Split View OR Verdict Screen */}
      <div className="absolute top-8 right-0 bottom-0 left-0">
        <AnimatePresence mode="wait">
          {trialPhase !== 'verdict' ? (
            <motion.div
              key="trial"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-row"
            >
              {/* PROSECUTION */}
              <section className="flex-1 flex flex-col border-r border-primary relative group">
                <div className="p-4 border-b border-primary flex justify-between items-center bg-background">
                  <span className="text-xs tracking-widest uppercase">Prosecution Counsel</span>
                  <Circle className="w-2 h-2 fill-primary" />
                </div>
                <div className="flex-grow flex flex-col justify-center items-center p-12 space-y-12">
                  <div className="w-24 h-24 flex items-center justify-center">
                    <VoiceIndicator isSpeaking={speechState.status === 'speaking' && speechState.agent === 'prosecution'} />
                  </div>
                  <div className="text-center space-y-4 max-w-sm">
                    <h3 className="font-sans text-2xl font-extrabold tracking-tighter uppercase">{prosecutionLatest?.stage.replace('_', ' ') || 'Opening Statement'}</h3>
                    <p className="text-sm leading-relaxed text-outline normal-case">{prosecutionLatest?.content || 'Awaiting prosecution argument from backend session.'}</p>
                  </div>
                </div>
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </section>

              {/* DEFENSE */}
              <section className="flex-1 flex flex-col relative group">
                <div className="p-4 border-b border-primary flex justify-between items-center bg-background">
                  <span className="text-xs tracking-widest uppercase">Defense Counsel</span>
                  <Circle className="w-2 h-2 text-outline" />
                </div>
                <div className="flex-grow flex flex-col justify-center items-center p-12 space-y-12 bg-surface-container-lowest">
                  <div className="w-24 h-24 flex items-center justify-center">
                    <VoiceIndicator isSpeaking={speechState.status === 'speaking' && speechState.agent === 'defense'} />
                  </div>
                  <div className="text-center space-y-4 max-w-sm opacity-50">
                    <h3 className="font-sans text-2xl font-extrabold tracking-tighter uppercase">{defenseLatest?.stage.replace('_', ' ') || 'Opening Statement'}</h3>
                    <p className="text-sm leading-relaxed normal-case">{defenseLatest?.content || 'Awaiting defense response from backend session.'}</p>
                  </div>
                </div>
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </section>
            </motion.div>
          ) : (
            <motion.div
              key="verdict"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="absolute inset-0 overflow-y-auto bg-background"
            >
              <VerdictScreen verdict={trialState?.verdict || null} judgeStatement={judgeLatest?.content || null} isLoading={isLoading} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Judge HUD */}
      <div className={cn(
        'fixed bottom-20 left-0 right-0 h-16 bg-background border-t border-primary z-40 flex items-stretch divide-x divide-primary/30 transition-[left] duration-200',
        isSidebarCompact ? 'md:left-20' : 'md:left-72',
      )}>

        {/* 1. Verdict Lean */}
        <div className="flex-1 flex flex-col justify-center px-5 gap-1 min-w-0 relative overflow-hidden">
          <div className="flex justify-between items-center mb-0.5">
            <span className="text-[8px] tracking-[0.2em] text-white font-bold uppercase">Prosecution</span>
            <span className="text-[8px] tracking-[0.15em] text-outline font-bold uppercase">VERDICT LEAN</span>
            <span className="text-[8px] tracking-[0.2em] text-[#6b7280] font-bold uppercase">Defense</span>
          </div>
          <div className="relative h-2 w-full bg-[#6b7280]/30">
            {/* prosecution fill from left */}
            <div
              className="absolute left-0 top-0 h-full bg-white transition-all duration-700"
              style={{ width: `${verdictLean}%` }}
            />
            {/* defense fill from right */}
            <div
              className="absolute right-0 top-0 h-full bg-[#6b7280] transition-all duration-700"
              style={{ width: `${100 - verdictLean}%` }}
            />
            {/* centre needle */}
            <div className="absolute left-1/2 top-0 h-full w-[2px] bg-background -translate-x-1/2 z-10" />
          </div>
          <div className="flex justify-between">
            <span className="text-[8px] text-white font-mono">{verdictLean}%</span>
            <span className="text-[8px] text-[#6b7280] font-mono">{100 - verdictLean}%</span>
          </div>
        </div>

        {/* 2. Objection Counter */}
        <div className="flex items-center gap-4 px-6 flex-none">
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] tracking-widest text-outline uppercase">Objections</span>
            <div className="flex gap-3 mt-1">
              <div className="flex flex-col items-center">
                <span className="text-[8px] text-white tracking-widest">PROS</span>
                <span className="text-xl font-extrabold font-sans text-white leading-none">{objections.prosecution}</span>
              </div>
              <div className="w-px bg-primary/20 mx-1" />
              <div className="flex flex-col items-center">
                <span className="text-[8px] text-[#9ca3af] tracking-widest">DEF</span>
                <span className="text-xl font-extrabold font-sans text-[#9ca3af] leading-none">{objections.defense}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Session Timer */}
        <div className="flex flex-col items-center justify-center px-6 flex-none gap-0.5">
          <span className="text-[8px] tracking-[0.2em] text-outline uppercase">Session Time</span>
          <span className={cn(
            "text-2xl font-extrabold font-mono leading-none tabular-nums transition-colors",
            timerUrgent ? "text-red-500 animate-pulse" : "text-primary"
          )}>
            {fmtTime(sessionSeconds)}
          </span>
          <span className="text-[8px] text-outline tracking-widest uppercase">{trialPhase.replace('_', ' ')}</span>
        </div>

        <div className="flex items-center justify-center px-4">
          <button
            onClick={onFastForward}
            disabled={isLoading}
            className="text-[9px] tracking-[0.2em] px-3 py-2 border border-primary/40 hover:border-primary hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            FAST FORWARD
          </button>
        </div>

      </div>

      {/* ── Objection Input Modal ────────────────────────────────────── */}
      <AnimatePresence>
        {isObjecting && (
          <motion.div
            key="objection-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => { setIsObjecting(false); setJudgeStatus('LISTENING'); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={e => e.stopPropagation()}
              className="bg-background border border-primary w-full max-w-xl p-8 space-y-6"
            >
              <div className="space-y-1">
                <p className="text-[9px] text-outline tracking-[0.4em] uppercase">⚖ Interactive Judge — Active Referee</p>
                <h2 className="text-2xl font-extrabold font-sans tracking-tighter">LOG_OBJECTION_PROTOCOL</h2>
              </div>
              <div className="border-b border-primary">
                <input
                  autoFocus
                  className="w-full bg-transparent text-primary font-mono tracking-widest py-3 focus:outline-none placeholder:text-surface-container-highest text-sm"
                  placeholder="ENTER GROUNDS FOR OBJECTION (E.G., HEARSAY, LEADING)..."
                  value={objectionText}
                  onChange={e => setObjectionText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitObjection(); }}
                />
              </div>
              <div className="flex gap-4">
                <button
                  onClick={submitObjection}
                  disabled={!objectionText.trim()}
                  className="flex-1 py-4 bg-primary text-background font-bold tracking-[0.3em] text-sm hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  SUBMIT TO ALGORITHMIC JUDGE
                </button>
                <button
                  onClick={() => { setIsObjecting(false); setJudgeStatus('LISTENING'); }}
                  className="px-6 py-4 border border-primary/40 text-outline font-bold tracking-widest text-xs hover:border-primary hover:text-primary transition-colors"
                >
                  WITHDRAW
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Judge Ruling Modal ───────────────────────────────────────── */}
      <AnimatePresence>
        {judgeRuling && (
          <motion.div
            key="ruling-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[95] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className={cn(
                "w-full max-w-2xl border-2 p-12 space-y-8 text-center",
                judgeRuling.decision === 'SUSTAINED' ? "border-primary bg-background" : "border-red-500/60 bg-background"
              )}
            >
              <div className="space-y-2">
                <p className="text-[9px] tracking-[0.5em] text-outline uppercase">Algorithmic Judge — Ruling</p>
                <h2 className={cn(
                  "text-6xl md:text-8xl font-extrabold font-sans tracking-tighter leading-none",
                  judgeRuling.decision === 'SUSTAINED' ? "text-primary" : "text-red-400"
                )}>
                  {judgeRuling.decision}
                </h2>
              </div>
              <p className={cn(
                "text-sm font-mono tracking-widest uppercase",
                judgeRuling.decision === 'SUSTAINED' ? "text-primary" : "text-red-300"
              )}>
                {judgeRuling.decision === 'SUSTAINED'
                  ? 'OBJECTION SUSTAINED. MATCHING TESTIMONY STRUCK FROM RECORD.'
                  : 'OBJECTION OVERRULED. COUNSEL, PROCEED.'}
              </p>
              <p className="text-[10px] text-outline normal-case tracking-normal max-w-xl mx-auto">{judgeRuling.reason}</p>
              <div className={cn(
                "h-px w-full",
                judgeRuling.decision === 'SUSTAINED' ? "bg-primary/30" : "bg-red-500/30"
              )} />
              <button
                onClick={resumeProceedings}
                className="w-full py-5 border border-primary text-primary font-bold tracking-[0.4em] text-sm hover:bg-primary hover:text-background transition-all duration-200"
              >
                RESUME PROCEEDINGS
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Speaker tag colour
function tagColor(type: 'statement' | 'qna' | 'ruling') {
  if (type === 'ruling') return 'text-yellow-400';
  if (type === 'qna') return 'text-primary';
  return 'text-outline';
}

function TranscriptView({
  onBack,
  onViewEvidence,
  entries,
  caseId,
  trialState,
}: {
  onBack: () => void;
  onViewEvidence: () => void;
  entries: TranscriptDisplayEntry[];
  caseId?: string;
  trialState?: BackendTrialState | null;
}) {
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const caseTitle = trialState?.case.title || 'Case pending';
  const configuredDefendant = extractDescriptionField(trialState?.case.description, 'Defendant');
  const configuredPlea = trialState?.case.plea || extractDescriptionField(trialState?.case.description, 'Plea') || 'NOT SPECIFIED';
  const configuredProsecution = extractDescriptionField(trialState?.case.description, 'Prosecution') || 'CASE COUNSEL';
  const configuredDefense = extractDescriptionField(trialState?.case.description, 'Defense') || 'DEFENSE COUNSEL';
  const hearingDate = trialState?.updated_at
    ? new Date(trialState.updated_at).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');
  const proceedingsLabel = formatStageLabel(trialState?.stage);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <main className="flex min-h-screen bg-background">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto pb-8">
        <div className="max-w-4xl mx-auto px-6 py-8 space-y-0">

          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-primary/20 px-4 py-3 text-[10px] tracking-widest">
            <div className="text-outline">CASE NO. {caseId || 'N/A'} - LIVE SESSION TRANSCRIPT</div>
            <div className="flex items-center gap-2">
              <button
                onClick={onBack}
                className="border border-primary/40 px-3 py-1 text-outline hover:border-primary hover:text-primary"
              >
                DOCKET
              </button>
              <button
                onClick={onViewEvidence}
                className="border border-primary/40 px-3 py-1 text-outline hover:border-primary hover:text-primary"
              >
                EVIDENCE
              </button>
            </div>
          </div>

          {/* ── CAUSE TITLE HEADER ───────────────────────────────────────────── */}
          <div className="border-2 border-primary mb-8">
            <div className="bg-primary text-background px-6 py-3 text-center">
              <p className="text-[10px] tracking-[0.5em] font-bold font-mono uppercase">
                IN THE SUPREME ALGORITHMIC TRIBUNAL, NEW DELHI — BHARAT_NODE
              </p>
            </div>
            <div className="border-t border-primary px-8 py-6 space-y-3 font-mono text-[11px]">
              <div className="flex justify-between items-center">
                <span className="text-outline tracking-[0.3em] uppercase text-[9px]">Case Number</span>
                <span className="font-bold tracking-widest">{caseId || 'CASE PENDING'}</span>
              </div>
              <div className="border-t border-primary/30 pt-3 space-y-1">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-bold tracking-wider uppercase">{caseTitle} ...................................................... COMPLAINANT</p>
                    <p className="text-outline text-[9px] tracking-[0.2em] ml-2">THROUGH: {configuredProsecution.toUpperCase()}</p>
                  </div>
                </div>
                <p className="text-center tracking-[0.6em] py-1 text-outline">— VERSUS —</p>
                <div>
                  <p className="font-bold tracking-wider uppercase">{(configuredDefendant || 'UNSPECIFIED DEFENDANT').toUpperCase()} ...................................... ACCUSED</p>
                  <p className="text-outline text-[9px] tracking-[0.2em] ml-2">REPRESENTED BY: {configuredDefense.toUpperCase()}</p>
                </div>
              </div>
              <div className="border-t border-primary/30 pt-3 flex justify-between items-center">
                <span className="text-outline tracking-[0.3em] uppercase text-[9px]">Coram</span>
                <span className="font-bold tracking-widest uppercase">Algorithmic Judge Unit-7</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-outline tracking-[0.3em] uppercase text-[9px]">Date of Hearing</span>
                <span className="tracking-widest">{hearingDate}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-outline tracking-[0.3em] uppercase text-[9px]">Nature of Proceedings</span>
                <span className="tracking-widest uppercase">{proceedingsLabel} — Plea: {configuredPlea}</span>
              </div>
            </div>
          </div>

          {/* ── PREAMBLE ─────────────────────────────────────────────────────── */}
          <div className="border border-primary/40 px-6 py-4 mb-6 font-mono text-[10px] leading-relaxed tracking-wide">
            <p className="text-outline text-[9px] tracking-[0.4em] uppercase mb-2">Court Record — Preamble</p>
            <p>
              The following is an official verbatim record of the deposition proceedings held before the Supreme Algorithmic Tribunal in the matter cited above. All statements herein have been recorded in accordance with Section 278 CrPC (Adapted — Algorithmic Tribunal Rules, 2022). Any corrections have been initialled by the deponent.
            </p>
          </div>

          {/* ── TRANSCRIPT ENTRIES ───────────────────────────────────────────── */}
          <div className="space-y-0 font-mono text-[11px] leading-relaxed">
            {entries.length === 0 && (
              <div className="py-16 text-center text-outline tracking-widest">No transcript entries yet. Run NEXT to generate trial turns.</div>
            )}
            {entries.map((entry, idx) => (
              <div
                key={entry.id}
                className="flex gap-0 border-b border-primary/15 group"
              >
                {/* Left margin: timestamp + paragraph number */}
                <div className="w-28 flex-shrink-0 border-r border-primary/30 pr-4 py-4 flex flex-col items-end gap-1">
                  <span className="text-[8px] tracking-[0.15em] text-outline font-mono">
                    [{entry.timestamp}]
                  </span>
                  <span className="text-[8px] text-outline/50 font-mono">
                    §{String(idx + 1).padStart(2, '0')}
                  </span>
                </div>

                {/* Main content */}
                <div className="flex-1 py-4 pl-5 pr-2 space-y-2">

                  {/* Speaker label */}
                  <p className={cn(
                    'text-[9px] tracking-[0.3em] uppercase font-bold',
                    tagColor(entry.type)
                  )}>
                    {entry.type === 'ruling' && '⚖ '}
                    {entry.type === 'qna' && '◈ '}
                    {entry.speaker}
                  </p>

                  {/* Content */}
                  {entry.type === 'qna' ? (
                    <div className="space-y-1.5 pl-2 border-l border-primary/30">
                      <p>
                        <span className="text-primary font-extrabold">Q. </span>
                        <span className="text-primary/90">{entry.question}</span>
                      </p>
                      <p>
                        <span className="text-outline font-extrabold">A. </span>
                        <span className="text-primary/70">{entry.answer}</span>
                      </p>
                    </div>
                  ) : (
                    <p className={cn(
                      entry.type === 'ruling' ? 'text-yellow-400/80' : 'text-primary/70'
                    )}>
                      {entry.text}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── DIGITAL SIGNATURE FOOTER ─────────────────────────────────────── */}
          <div ref={transcriptEndRef} className="border-2 border-primary mt-8 font-mono">
            <div className="bg-primary/5 border-b border-primary px-6 py-3">
              <p className="text-[9px] tracking-[0.5em] text-outline uppercase text-center">
                RO &amp; AC — Read Over and Acknowledged Correct
              </p>
            </div>
            <div className="px-8 py-6 grid grid-cols-1 md:grid-cols-3 gap-6 divide-y md:divide-y-0 md:divide-x divide-primary/30">
              <div className="md:pr-6 space-y-1">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase mb-1">Deponent Signature</p>
                <p className="text-[10px] text-primary tracking-wide">{(configuredDefendant || 'UNSPECIFIED DEFENDANT').toUpperCase()}</p>
                <p className="text-[9px] text-outline">Digital Thumbprint: 0xFE3A...91B7</p>
              </div>
              <div className="pt-4 md:pt-0 md:px-6 space-y-1">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase mb-1">Tribunal Hash Seal</p>
                <p className="text-[10px] text-primary font-bold tracking-wider">DIGITAL HASH SIGNATURE:</p>
                <p className="text-[9px] text-primary/70 break-all">0x9A4F...C82E_7D01_BHARAT_CRT</p>
              </div>
              <div className="pt-4 md:pt-0 md:pl-6 space-y-1">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase mb-1">Registry Certification</p>
                <p className="text-[10px] text-primary tracking-wide">TRIBUNAL SEAL AFFIXED.</p>
                <p className="text-[9px] text-outline">Certified True Copy — Registrar, SAT-ND</p>
                <p className="text-[9px] text-green-500 animate-pulse uppercase">● Verified Authentic</p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </main>
  );
}

function VerdictScreen({
  verdict,
  judgeStatement,
  isLoading,
}: {
  verdict: BackendTrialState['verdict'];
  judgeStatement: string | null;
  isLoading: boolean;
}) {
  const [displayedText, setDisplayedText] = useState('');
  const [docketVisible, setDocketVisible] = useState(false);
  const verdictView = useMemo(
    () => buildVerdictPresentation(verdict, judgeStatement),
    [verdict, judgeStatement],
  );

  const verdictScript = useMemo(() => {
    if (!judgeStatement && !verdict) {
      return 'Awaiting final judicial statement. Use VERDICT or FAST FORWARD to request final ruling.';
    }
    return buildVerdictTranscript(verdictView);
  }, [judgeStatement, verdict, verdictView]);
  const isTypewriterComplete = displayedText.length >= verdictScript.length;

  useEffect(() => {
    const hasSeenMessage = (() => {
      try {
        return localStorage.getItem(VERDICT_MESSAGE_CACHE_KEY) === verdictScript;
      } catch {
        return false;
      }
    })();

    if (hasSeenMessage) {
      setDisplayedText(verdictScript);
      setDocketVisible(true);
      return;
    }

    try {
      localStorage.setItem(VERDICT_MESSAGE_CACHE_KEY, verdictScript);
    } catch {
      // Ignore localStorage access errors (private mode, blocked storage, etc.)
    }

    let i = 0;
    setDisplayedText('');
    setDocketVisible(false);
    if (!verdictScript) return;
    const id = setInterval(() => {
      i = Math.min(i + 2, verdictScript.length);
      setDisplayedText(verdictScript.slice(0, i));
      if (i >= verdictScript.length) {
        clearInterval(id);
        setTimeout(() => setDocketVisible(true), 600);
      }
    }, 16);
    return () => clearInterval(id);
  }, [verdictScript]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-start p-6 md:p-12 pb-40 overflow-y-auto gap-6 md:gap-8">

      {/* Verdict Header */}
      <div className="text-center pb-2">
        <h1 className="text-4xl md:text-5xl font-extrabold font-sans tracking-[0.2em] text-primary uppercase">VERDICT</h1>
      </div>

      {/* Typewriter Terminal */}
      <div className="w-full max-w-3xl font-mono min-h-[140px] max-h-[38vh] border border-primary/30 bg-surface-container-lowest/40 px-4 py-4 md:px-6 md:py-5 overflow-y-auto">
        <p className="text-[9px] text-outline tracking-[0.4em] uppercase mb-3">Court Transcript — Final Session</p>
        <p className="text-primary text-[11px] leading-relaxed tracking-normal whitespace-pre-wrap break-words normal-case">
          {displayedText}
          {!isTypewriterComplete && (
            <motion.span
              animate={{ opacity: [1, 0] }}
              transition={{ duration: 0.5, repeat: Infinity }}
              className="inline-block w-[2px] h-[1em] bg-primary ml-0.5 align-middle"
            />
          )}
        </p>
      </div>

      {/* Final Docket — fades in after typewriter */}
      <AnimatePresence>
        {docketVisible && (
          <motion.div
            key="docket"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="w-full max-w-3xl py-2 space-y-4"
          >
            <p className="text-[9px] tracking-[0.5em] text-outline uppercase text-center mb-1">Official Court Record</p>

            {/* Ruling — massive */}
            <div className="text-center border border-primary/30 py-5 px-4">
              <p className="text-[9px] tracking-[0.5em] text-outline uppercase mb-2">Final Ruling</p>
              <h2 className="text-4xl md:text-6xl font-extrabold font-sans tracking-tight text-primary leading-none mt-2 break-words">
                {verdictView.ruling}
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
              <div className="border border-primary/20 p-4 space-y-2">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase">Reasoning</p>
                <p className="text-sm font-mono text-primary/90 leading-relaxed normal-case whitespace-pre-wrap break-words">
                  {verdictView.reasoning}
                </p>
              </div>
              <div className="border border-primary/20 p-4 flex flex-col justify-center min-w-[160px]">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase">Confidence Score</p>
                <p className="text-4xl font-extrabold font-sans text-primary leading-none mt-2">{verdictView.confidence}</p>
              </div>
            </div>

            <div className="border border-primary/20 p-4 space-y-3">
              <p className="text-[8px] tracking-[0.4em] text-outline uppercase">Key Factors</p>
              {verdictView.keyFactors.length ? (
                <ul className="space-y-2">
                  {verdictView.keyFactors.map((factor, index) => (
                    <li key={`${factor}-${index}`} className="text-sm font-mono leading-relaxed text-primary/90 normal-case break-words">
                      {index + 1}. {factor}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm font-mono text-outline normal-case">No key factors were listed by the judicial model.</p>
              )}
            </div>

            <p className="text-[8px] text-outline tracking-widest text-center pt-2 border-t border-primary/20">
              {isLoading ? 'WAITING FOR BACKEND RESPONSE...' : 'RULING GENERATED FROM LIVE BACKEND SESSION'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function VoiceIndicator({ isSpeaking }: { isSpeaking: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[5px]">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className={`voice-bar${isSpeaking ? ' active' : ''}`} />
      ))}
    </div>
  );
}

function TimelineNode({ label, active, completed }: { label: string, active?: boolean, completed?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={cn(
        "w-3 h-3 border border-primary transition-all",
        completed ? "bg-primary" : "bg-background",
        active && "outline outline-4 outline-primary/20 bg-primary"
      )} />
      <span className={cn(
        "text-[9px] transition-colors",
        (active || completed) ? "text-primary font-bold" : "text-outline"
      )}>
        {label}
      </span>
    </div>
  );
}
