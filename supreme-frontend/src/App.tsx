import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Terminal, Shield, Gavel, FolderOpen, FileText, BookOpen,
  Mic, StepBack, Pause, StepForward, Eraser, Upload, ArrowRight,
  ChevronDown, Circle, Image, Film, FileSearch, File, Filter,
  Clock, User, Scale, Play, FastForward, RotateCcw, AlertTriangle,
} from 'lucide-react';
import { cn } from './lib/utils';
import type {
  TranscriptEntry, Verdict, TrialStage, AgentRole,
  CreateCaseRequest, Difficulty,
} from './types';
import * as api from './api';
import * as voice from './voice';

// ─── View / Phase types ────────────────────────────────────────────────────────
type View = 'landing' | 'config' | 'simulation' | 'evidence';
type UIPhase = 'opening' | 'evidence' | 'cross_examination' | 'verdict';

// ─── Voice status for UI ───────────────────────────────────────────────────────
type SpeakingAgent = 'prosecution' | 'defense' | 'judge' | null;

const STAGE_TO_PHASE: Record<TrialStage, UIPhase> = {
  OPENING_PROS: 'opening',
  OPENING_DEF:  'opening',
  EXAMINATION:  'evidence',
  CROSS_EXAM:   'cross_examination',
  CLOSING_PROS: 'cross_examination',
  CLOSING_DEF:  'cross_examination',
  VERDICT:      'verdict',
  COMPLETE:     'verdict',
};

// ─── Top-level App ─────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState<View>('landing');
  const [sessionId, setSessionId]     = useState<string | null>(null);
  const [transcript, setTranscript]   = useState<TranscriptEntry[]>([]);
  const [trialStage, setTrialStage]   = useState<TrialStage>('OPENING_PROS');
  const [activeAgent, setActiveAgent] = useState<AgentRole>('prosecution');
  const [verdict, setVerdict]         = useState<Verdict | null>(null);
  const [isLoading, setIsLoading]     = useState(false);
  const [isComplete, setIsComplete]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [isMuted, setIsMuted]         = useState(false);
  const [speakingAgent, setSpeakingAgent] = useState<SpeakingAgent>(null);

  // Derived UI phase
  const trialPhase: UIPhase = STAGE_TO_PHASE[trialStage] ?? 'opening';

  // ── Objection state (still shown in UI) ─────────────────────────────────────
  const [isObjecting, setIsObjecting]   = useState(false);
  const [objectionText, setObjText]     = useState('');
  const [judgeRuling, setJudgeRuling]   = useState<null | 'SUSTAINED' | 'OVERRULED'>(null);
  const [judgeStatus, setJudgeStatus]   = useState<'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED'>('LISTENING');
  const [isRedactMode, setIsRedactMode] = useState(false);
  const [isPaused, setIsPaused]         = useState(false);

  // ── Create session from config ───────────────────────────────────────────────
  const handleStart = async (req: CreateCaseRequest) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.createCase(req);
      setSessionId(res.session_id);
      setTranscript([]);
      setTrialStage('OPENING_PROS');
      setActiveAgent('prosecution');
      setVerdict(null);
      setIsComplete(false);
      setView('simulation');
    } catch (e: any) {
      setError(e.message ?? 'Failed to create session');
    } finally {
      setIsLoading(false);
    }
  };

  // ── Voice mute toggle ────────────────────────────────────────────────────────
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    voice.setMuted(next);
  };

  // ── Next turn ────────────────────────────────────────────────────────────────
  const handleNextTurn = async () => {
    if (!sessionId || isComplete || isLoading) return;
    setIsLoading(true);
    setError(null);
    voice.stopSpeaking();
    try {
      const res = await api.nextTurn(sessionId);
      setTranscript(prev => [...prev, res.entry]);
      setTrialStage(res.stage);
      setActiveAgent(res.active_agent);

      // ── Speak the new entry ────────────────────────────────────────────────
      const agent = res.entry.agent as 'prosecution' | 'defense' | 'judge';
      setSpeakingAgent(agent);
      voice.speak(res.entry.content, agent).finally(() => setSpeakingAgent(null));

      if (res.is_complete) {
        setIsComplete(true);
        const vr = await api.forceVerdict(sessionId);
        setVerdict(vr.verdict);
        // Speak the verdict
        if (vr.verdict) {
          setSpeakingAgent('judge');
          voice.speak(
            `The court finds the defendant ${vr.verdict.decision}. ${vr.verdict.reasoning.slice(0, 200)}`,
            'judge'
          ).finally(() => setSpeakingAgent(null));
        }
      }
    } catch (e: any) {
      setError(e.message ?? 'Failed to advance turn');
    } finally {
      setIsLoading(false);
    }
  };

  // ── Fast-forward ─────────────────────────────────────────────────────────────
  const handleFastForward = async () => {
    if (!sessionId || isLoading) return;
    setIsLoading(true);
    try {
      const res = await api.fastForward(sessionId);
      setVerdict(res.verdict);
      setIsComplete(true);
      setTrialStage('COMPLETE');
      // reload full transcript
      const state = await api.getSession(sessionId);
      setTranscript(state.transcript);
    } catch (e: any) {
      setError(e.message ?? 'Fast-forward failed');
    } finally {
      setIsLoading(false);
    }
  };

  // ── Objection ────────────────────────────────────────────────────────────────
  const handleObjection = () => { setIsObjecting(true); setJudgeStatus('HALTED'); };
  const submitObjection = async () => {
    if (!objectionText.trim() || !sessionId) return;
    setJudgeStatus('EVALUATING');
    const txt = objectionText;
    setObjText('');
    setIsObjecting(false);
    try {
      const res = await api.raiseObjection(sessionId, txt);
      const newEntry = res.state.transcript[res.state.transcript.length - 1];
      if (newEntry) setTranscript(prev => [...prev, newEntry]);
    } catch { /* non-fatal */ }
    setTimeout(() => {
      const ruling = Math.random() > 0.5 ? 'SUSTAINED' : 'OVERRULED';
      setJudgeRuling(ruling);
      setJudgeStatus('RULING');
    }, 1200);
  };
  const resumeProceedings = () => { setJudgeRuling(null); setJudgeStatus('LISTENING'); };

  // ── Redact ───────────────────────────────────────────────────────────────────
  const handleRedact = async (keyword: string) => {
    if (!sessionId || !keyword) return;
    try {
      await api.redactEntry(sessionId, keyword);
      const state = await api.getSession(sessionId);
      setTranscript(state.transcript);
    } catch { /* non-fatal */ }
  };

  // ── Inject testimony ─────────────────────────────────────────────────────────
  const handleInject = async (text: string) => {
    if (!sessionId || !text) return;
    try {
      const res = await api.injectTestimony(sessionId, text);
      const newEntry = res.state.transcript[res.state.transcript.length - 1];
      if (newEntry) setTranscript(prev => [...prev, newEntry]);
    } catch { /* non-fatal */ }
  };

  // ── Reset ────────────────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (!sessionId) return;
    try {
      await api.resetTrial(sessionId);
      setTranscript([]);
      setTrialStage('OPENING_PROS');
      setActiveAgent('prosecution');
      setVerdict(null);
      setIsComplete(false);
    } catch { /* non-fatal */ }
  };

  return (
    <div className="min-h-screen bg-background text-primary selection:bg-primary selection:text-background font-mono uppercase">
      {/* Loading bar */}
      {isLoading && (
        <div className="fixed top-0 left-0 right-0 h-[2px] z-[999] bg-gradient-to-r from-transparent via-primary to-transparent animate-pulse" />
      )}

      {/* Top App Bar */}
      <header className="fixed top-0 w-full z-50 flex items-center px-6 h-16 bg-background border-b border-primary">
        <div className="flex-1 flex items-center gap-4">
          <img src="/logo.png" alt="Logo" className="w-14 h-14 object-contain invert" />
          <h1 className="text-xl font-bold tracking-tighter font-sans">SUPREME</h1>
        </div>

        <nav className="hidden md:flex flex-none gap-8 items-center h-full">
          <button
            onClick={() => setView('landing')}
            className={cn(
              "px-2 h-full flex items-center transition-colors duration-100 font-medium",
              view === 'landing' ? "text-primary border-b-2 border-primary" : "text-outline hover:bg-primary hover:text-background"
            )}
          >HOME</button>
          {sessionId && (
            <button
              onClick={handleReset}
              className="text-outline px-2 h-full flex items-center hover:bg-primary hover:text-background transition-colors duration-100 gap-2"
            >
              <RotateCcw className="w-3 h-3" /> RESET
            </button>
          )}
        </nav>

        {/* Session ID + security badge */}
        <div className="flex-1 flex justify-end items-center gap-4">
          {sessionId && (
            <div className="text-[9px] text-outline font-mono hidden lg:block">
              SESSION: {sessionId.slice(0, 8)}…
            </div>
          )}
          <div className="relative flex group">
            <div className="p-1 cursor-help hover:bg-primary hover:text-background transition-colors">
              <Shield className="w-5 h-5" />
            </div>
            <div className="absolute right-0 top-full mt-2 w-56 bg-background border border-primary p-4 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-2xl">
              <div className="text-[10px] text-outline tracking-[0.2em] mb-2 font-bold">SECURITY INFORMATION</div>
              <div className="text-[10px] text-primary leading-relaxed font-mono">
                <span className="text-outline">&gt;</span> Backend: <span className="text-green-500">{sessionId ? 'CONNECTED' : 'READY'}</span><br />
                <span className="text-outline">&gt;</span> LLM Model: <span className="text-green-500">gpt-oss-120b:free</span><br />
                <span className="text-outline">&gt;</span> RAG: <span className="text-green-500">Active</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="fixed top-16 left-0 right-0 z-50 bg-red-900/90 border-b border-red-500 px-6 py-2 flex items-center gap-3 text-red-200 text-xs tracking-widest">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-100">✕</button>
        </div>
      )}

      <AnimatePresence mode="wait">
        {view === 'landing' && (
          <motion.div key="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full">
            <LandingView onStart={() => setView('config')} />
          </motion.div>
        )}
        {view === 'config' && (
          <motion.div key="config" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="w-full">
            <ConfigView onStart={handleStart} isLoading={isLoading} />
          </motion.div>
        )}
        {view === 'simulation' && (
          <motion.div key="simulation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full">
            <SimulationView
              sessionId={sessionId}
              transcript={transcript}
              trialPhase={trialPhase}
              trialStage={trialStage}
              activeAgent={activeAgent}
              speakingAgent={speakingAgent}
              isLoading={isLoading}
              isComplete={isComplete}
              isRedactMode={isRedactMode}
              isPaused={isPaused}
              verdict={verdict}
              onViewEvidence={() => setView('evidence')}
              isObjecting={isObjecting}
              setIsObjecting={setIsObjecting}
              objectionText={objectionText}
              setObjectionText={setObjText}
              judgeRuling={judgeRuling}
              judgeStatus={judgeStatus}
              setJudgeStatus={setJudgeStatus}
              submitObjection={submitObjection}
              resumeProceedings={resumeProceedings}
              onRedact={handleRedact}
              onInject={handleInject}
            />
          </motion.div>
        )}
        {view === 'evidence' && (
          <motion.div key="evidence" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="w-full">
            <EvidenceView onBack={() => setView('simulation')} transcript={transcript} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom control bar — simulation only */}
      <AnimatePresence>
        {view === 'simulation' && (
          <motion.footer
            key="footer"
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center h-20 px-8 bg-background/90 backdrop-blur-xl border-t border-primary"
          >
            <ControlBtn icon={<FastForward className="w-5 h-5" />} label="SKIP" onClick={handleFastForward} isActive={isLoading} />
            <ControlBtn icon={<Gavel className="w-5 h-5" />} label="OBJECTION" onClick={handleObjection} isActive={judgeStatus === 'HALTED' || judgeStatus === 'EVALUATING'} />
            <ControlBtn
              icon={isLoading ? <Pause className="w-5 h-5 animate-pulse" /> : <Play className="w-5 h-5" />}
              label="NEXT"
              onClick={handleNextTurn}
              isActive={isLoading}
            />
            <ControlBtn icon={<Eraser className="w-5 h-5" />} label="REDACT" onClick={() => setIsRedactMode(r => !r)} isActive={isRedactMode} />
            <ControlBtn
              icon={
                isMuted
                  ? <span className="text-xs font-bold">🔇</span>
                  : <span className="text-xs font-bold animate-pulse">{speakingAgent ? '🔊' : '🔈'}</span>
              }
              label={isMuted ? 'UNMUTE' : speakingAgent ? 'SPEAKING' : 'VOICE ON'}
              onClick={toggleMute}
              isActive={!!speakingAgent && !isMuted}
            />
          </motion.footer>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── ControlBtn ─────────────────────────────────────────────────────────────
function ControlBtn({ icon, label, onClick, isActive }: {
  icon: React.ReactNode; label: string; onClick?: () => void; isActive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center px-4 py-2 transition-all duration-100 active:scale-95 min-w-[60px]",
        isActive ? "bg-primary text-background" : "text-primary hover:bg-surface-container"
      )}
    >
      {icon}
      <span className="text-[10px] font-bold mt-1 tracking-widest">{label}</span>
    </button>
  );
}

// ─── Evidence types + demo data ────────────────────────────────────────────────
type EvidenceParty = 'prosecution' | 'defense' | 'court';
type EvidenceType = 'document' | 'image' | 'video' | 'testimony' | 'physical';

interface EvidenceRecord {
  id: string; title: string; description: string;
  party: EvidenceParty; type: EvidenceType; phase: string;
  submittedAt: string; admissible: boolean; tags: string[];
}

const TYPE_ICONS: Record<EvidenceType, React.ReactNode> = {
  document: <FileText className="w-4 h-4" />, image: <Image className="w-4 h-4" />,
  video: <Film className="w-4 h-4" />, testimony: <User className="w-4 h-4" />,
  physical: <FileSearch className="w-4 h-4" />,
};

const PARTY_STYLES: Record<EvidenceParty, { label: string; bar: string; badge: string; text: string }> = {
  prosecution: { label: 'Prosecution', bar: 'bg-white', badge: 'bg-white text-black', text: 'text-white' },
  defense:     { label: 'Defense', bar: 'bg-[#6b7280]', badge: 'bg-[#6b7280] text-white', text: 'text-[#9ca3af]' },
  court:       { label: 'Court', bar: 'bg-[#d4af37]', badge: 'bg-[#d4af37] text-black', text: 'text-[#d4af37]' },
};

function EvidenceView({ onBack, transcript }: { onBack: () => void; transcript: TranscriptEntry[] }) {
  const [filter, setFilter]     = useState<EvidenceParty | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<EvidenceType | 'all'>('all');

  // Build evidence records from live transcript citations
  const records: EvidenceRecord[] = transcript.flatMap(entry =>
    entry.citations.map((c, i) => ({
      id: `${entry.agent.toUpperCase().slice(0, 3)}-${String(i + 1).padStart(3, '0')}`,
      title: c.case_id,
      description: c.summary,
      party: entry.agent === 'prosecution' ? 'prosecution' : entry.agent === 'defense' ? 'defense' : 'court' as EvidenceParty,
      type: 'document' as EvidenceType,
      phase: entry.stage,
      submittedAt: entry.timestamp,
      admissible: c.relevance_score > 0.3,
      tags: [entry.stage, entry.agent, `score:${c.relevance_score}`],
    }))
  );

  const filtered = records.filter(e => (filter === 'all' || e.party === filter) && (typeFilter === 'all' || e.type === typeFilter));

  return (
    <main className="flex min-h-screen pt-16 bg-background">
      <aside className="hidden md:flex flex-none w-64 flex-col bg-background border-r border-primary fixed top-16 bottom-0 left-0">
        <div className="p-6 border-b border-primary">
          <h2 className="text-lg font-bold font-sans">Court Management</h2>
          <p className="text-[10px] text-outline uppercase">Status: Secure</p>
        </div>
        <nav className="flex-grow">
          <SideLink icon={<Gavel className="w-4 h-4" />} label="DOCKET" onClick={onBack} />
          <SideLink icon={<FolderOpen className="w-4 h-4" />} label="EVIDENCE" active />
          <SideLink icon={<FileText className="w-4 h-4" />} label="TRANSCRIPT" onClick={onBack} />
        </nav>
        <div className="p-6 border-t border-primary mt-auto">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] text-outline"><span className="w-2 h-2 bg-white inline-block" /> Prosecution</div>
            <div className="flex items-center gap-2 text-[10px] text-outline"><span className="w-2 h-2 bg-[#6b7280] inline-block" /> Defense</div>
            <div className="flex items-center gap-2 text-[10px] text-outline"><span className="w-2 h-2 bg-[#d4af37] inline-block" /> Court</div>
          </div>
        </div>
      </aside>

      <div className="flex-1 md:ml-64 flex flex-col min-h-0">
        <div className="px-10 py-8 border-b border-primary flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-extrabold font-sans tracking-tighter mb-1">EVIDENCE REGISTER</h1>
            <p className="text-[10px] text-outline tracking-widest uppercase">{filtered.length} of {records.length} Records — Current Session</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Scale className="w-4 h-4 text-outline" />
            <span className="text-[10px] text-outline tracking-widest uppercase">Filter by Party:</span>
            {(['all', 'prosecution', 'defense', 'court'] as const).map(p => (
              <button key={p} onClick={() => setFilter(p)}
                className={cn("text-[10px] tracking-widest px-3 py-1 border transition-colors font-bold uppercase",
                  filter === p ? "bg-primary text-background border-primary" : "border-primary/40 text-outline hover:border-primary hover:text-primary"
                )}
              >{p === 'all' ? 'All' : PARTY_STYLES[p].label}</button>
            ))}
          </div>
        </div>

        <div className="flex-1 px-10 py-6 space-y-3 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="py-20 text-center text-outline text-sm tracking-widest">
              {records.length === 0 ? 'No proceedings yet — start the trial to generate evidence citations.' : 'No evidence matches the current filter.'}
            </div>
          )}
          {filtered.map((ev) => {
            const ps = PARTY_STYLES[ev.party];
            return (
              <div key={ev.id} className="flex gap-0 border border-primary/20 hover:border-primary transition-colors group relative overflow-hidden">
                <div className={cn("w-1 flex-none", ps.bar)} />
                <div className="flex-1 p-5 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] font-mono text-outline border border-primary/30 px-2 py-0.5">{ev.id}</span>
                      <span className="flex items-center gap-1.5 text-[10px] tracking-widest text-outline uppercase border border-primary/20 px-2 py-0.5">{TYPE_ICONS[ev.type]} {ev.type}</span>
                      <span className={cn("text-[10px] tracking-widest font-bold px-2 py-0.5 uppercase", ps.badge)}>{ps.label}</span>
                      <span className={cn("text-[10px] tracking-widest px-2 py-0.5 uppercase font-bold border",
                        ev.admissible ? "text-green-500 border-green-500/40" : "text-red-500 border-red-500/40"
                      )}>{ev.admissible ? 'Admitted' : 'Objected'}</span>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-[9px] text-outline shrink-0">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(ev.submittedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="uppercase tracking-widest">{ev.phase}</span>
                    </div>
                  </div>
                  <div>
                    <p className={cn("font-bold tracking-tight font-sans text-sm mb-1 group-hover:text-primary transition-colors", ps.text)}>{ev.title}</p>
                    <p className="text-[11px] text-outline leading-relaxed normal-case">{ev.description}</p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {ev.tags.map(tag => <span key={tag} className="text-[9px] text-outline border border-primary/10 px-2 py-0.5 tracking-widest uppercase">{tag}</span>)}
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

// ─── Landing ───────────────────────────────────────────────────────────────────
function LandingView({ onStart }: { onStart: () => void }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center pt-16 relative overflow-hidden">
      <div className="absolute inset-0 dossier-grid opacity-20 pointer-events-none" />
      <div className="relative z-10 text-center px-4">
        <div className="mb-2 text-outline tracking-[0.5em] text-xs">YOU CANT KNOW IT ALL</div>
        <h1 className="text-7xl md:text-9xl font-extrabold tracking-tighter mb-8 font-sans">SUPREME</h1>
        <div className="flex flex-col md:flex-row gap-12 items-center justify-center mb-16">
          <div className="flex flex-col items-center gap-6">
            <button onClick={onStart}
              className="px-12 py-4 border border-primary bg-transparent text-primary font-bold text-xl tracking-widest hover:bg-primary hover:text-background transition-all duration-300 active:scale-95 group relative overflow-hidden"
            ><span className="relative z-10">START</span></button>
            <div className="flex items-center gap-2 text-[10px] text-outline-variant uppercase">
              <span className="w-2 h-2 bg-outline-variant rounded-full animate-pulse" />
              Ready to proceed
            </div>
          </div>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 w-full px-12 grid grid-cols-1 md:grid-cols-3 gap-0 border-t border-primary/10">
        <InfoBlock title="STEP 1" content="Input all case details, define parties, establish timelines, and upload evidence for indexing." />
        <InfoBlock title="STEP 2" content="Run multi-phase court proceedings with live AI agents — Prosecution vs Defense — powered by OpenRouter." />
        <InfoBlock title="STEP 3" content="The AI judge evaluates all session transcripts and evidence to render a final, impartial ruling." />
      </div>
      <div className="absolute top-1/4 right-1/4 w-32 h-2 redaction-mask" />
      <div className="absolute bottom-1/3 left-1/4 w-48 h-2 redaction-mask opacity-30" />
    </main>
  );
}

function InfoBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="p-8 border-r border-primary/10 last:border-r-0">
      <h3 className="text-xs text-outline mb-2">{title}</h3>
      <p className="text-sm text-outline leading-relaxed">{content}</p>
    </div>
  );
}

// ─── Config ────────────────────────────────────────────────────────────────────
function ConfigView({ onStart, isLoading }: { onStart: (req: CreateCaseRequest) => void; isLoading: boolean }) {
  const [activeTab, setActiveTab] = useState<'prosecution' | 'defense'>('prosecution');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');

  // Controlled fields
  const [caseType, setCaseType]   = useState('CRIMINAL');
  const [defendant, setDefendant] = useState('');
  const [charges, setCharges]     = useState('');
  const [prosNarrative, setProsNarrative] = useState('');
  const [plea, setPlea]           = useState('NOT GUILTY');
  const [defNarrative, setDefNarrative] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const [facts, setFacts]         = useState<string[]>([]);
  const [factInput, setFactInput] = useState('');
  const [evidence, setEvidence]   = useState<string[]>([]);
  const [evidenceInput, setEvidenceInput] = useState('');

  const addFact = () => {
    const t = factInput.trim();
    if (t && !facts.includes(t)) { setFacts(f => [...f, t]); setFactInput(''); }
  };
  const addEvidence = () => {
    const t = evidenceInput.trim();
    if (t && !evidence.includes(t)) { setEvidence(e => [...e, t]); setEvidenceInput(''); }
  };

  const handleSubmit = () => {
    const title = defendant ? `State v. ${defendant}` : `${caseType} Case`;
    const chargeList = charges.split('\n').map(s => s.trim()).filter(Boolean);
    const evidenceList = [
      ...evidence,
      ...prosNarrative.split('.').slice(0, 2).map(s => s.trim()).filter(Boolean),
    ];
    onStart({
      title,
      description: `${caseType} case. Plea: ${plea}. ${prosNarrative} ${defNarrative}`.trim(),
      charges: chargeList.length ? chargeList : [charges || `${caseType} charges`],
      evidence: evidenceList.length ? evidenceList : ['Evidence pending review'],
      difficulty,
    });
  };

  return (
    <main className="md:ml-64 pt-16 min-h-screen pb-24 relative">
      <div className="absolute inset-0 dossier-grid opacity-10 pointer-events-none" />
      <aside className="fixed left-0 top-16 h-[calc(100vh-64px)] w-64 flex flex-col bg-background border-r border-primary hidden md:flex">
        <div className="p-6 border-b border-primary">
          <div className="text-lg font-bold font-sans">Court Management</div>
          <div className="text-[10px] text-outline mt-1 tracking-widest uppercase">Status: Secure</div>
        </div>
        <nav className="flex-1 py-4">
          <SideLink icon={<Gavel className="w-4 h-4" />} label="DOCKET" active />
          <SideLink icon={<FolderOpen className="w-4 h-4" />} label="EVIDENCE" />
          <SideLink icon={<FileText className="w-4 h-4" />} label="TRANSCRIPT" />
          <SideLink icon={<BookOpen className="w-4 h-4" />} label="STATUTES" />
        </nav>
        <div className="p-6 mt-auto border-t border-primary/20">
          <div className="text-[10px] text-outline mb-2 uppercase">Difficulty</div>
          <div className="flex flex-col gap-1">
            {(['easy', 'medium', 'hard'] as Difficulty[]).map(d => (
              <button key={d} onClick={() => setDifficulty(d)}
                className={cn("text-left text-[10px] px-2 py-1 tracking-widest uppercase font-bold transition-colors",
                  difficulty === d ? "bg-primary text-background" : "text-outline hover:text-primary"
                )}
              >{d} — {d === 'easy' ? '1 turn' : d === 'medium' ? '2 turns' : '3 turns'}/stage</button>
            ))}
          </div>
        </div>
      </aside>

      <div className="max-w-4xl mx-auto px-6 py-12 relative z-10">
        <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between border-b border-primary pb-8 gap-4">
          <div>
            <h1 className="text-5xl font-extrabold font-sans tracking-tighter mb-2">CONFIGURATION</h1>
            <p className="text-outline text-xs tracking-[0.3em] font-medium uppercase">CREATE NEW CASE PROFILE</p>
          </div>
          <div className="text-right">
            <span className="text-xs px-3 py-1 border border-primary bg-primary/10 tracking-widest uppercase">
              {difficulty.toUpperCase()} MODE
            </span>
          </div>
        </div>

        <div className="flex items-stretch border border-primary mb-10">
          {(['prosecution', 'defense'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={cn(
                "flex-1 py-3 px-6 text-xs font-bold tracking-[0.25em] uppercase transition-all duration-150 font-mono flex items-center justify-center gap-3",
                activeTab === tab ? "bg-primary text-background" : "text-outline hover:text-primary hover:bg-primary/5"
              )}
            >{tab === 'prosecution' ? 'PROSECUTION DATA' : 'DEFENSE DATA'}</button>
          ))}
        </div>

        {activeTab === 'prosecution' && (
          <div className="space-y-12">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              <div className="space-y-2">
                <label className="block text-[10px] tracking-widest text-outline">CASE TYPE</label>
                <div className="relative">
                  <select value={caseType} onChange={e => setCaseType(e.target.value)}
                    className="w-full bg-transparent border-0 border-b border-primary text-primary font-bold tracking-widest py-3 focus:ring-0 appearance-none cursor-pointer">
                    <option className="bg-background">CRIMINAL</option>
                    <option className="bg-background">CIVIL</option>
                    <option className="bg-background">CORPORATE</option>
                  </select>
                  <ChevronDown className="absolute right-0 top-3 w-5 h-5 pointer-events-none" />
                </div>
              </div>
              <div className="space-y-2 overflow-hidden">
                <label className="block text-[10px] tracking-widest text-outline">DEFENDANT NAME</label>
                <input value={defendant} onChange={e => setDefendant(e.target.value)}
                  className="w-full bg-transparent border-0 border-b border-primary text-primary font-bold tracking-widest py-3 focus:ring-0 focus:outline-none placeholder:text-surface-container-highest"
                  placeholder="FULL LEGAL NAME OF DEFENDANT" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] tracking-widest text-outline">THE CHARGES / ALLEGATIONS</label>
              <textarea value={charges} onChange={e => setCharges(e.target.value)}
                className="w-full bg-transparent border-0 border-b border-primary text-primary font-medium tracking-widest py-3 focus:ring-0 placeholder:text-surface-container-highest resize-none"
                placeholder="STATE THE FORMAL CHARGES OR CIVIL ALLEGATIONS IN FULL..." rows={3} />
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] tracking-widest text-outline">PROSECUTION NARRATIVE</label>
              <textarea value={prosNarrative} onChange={e => setProsNarrative(e.target.value)}
                className="w-full bg-transparent border-0 border-b border-primary text-primary font-medium tracking-widest py-3 focus:ring-0 placeholder:text-surface-container-highest resize-none"
                placeholder="THE SEQUENCE OF EVENTS ACCORDING TO THE ACCUSER / PLAINTIFF..." rows={4} />
            </div>

            {/* Evidence tags */}
            <div className="space-y-3">
              <label className="block text-[10px] tracking-widest text-outline">KEY EVIDENCE ITEMS</label>
              {evidence.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {evidence.map((ev, i) => (
                    <li key={i} className="flex items-start gap-3 border border-primary/30 px-4 py-2 text-sm font-mono group">
                      <span className="text-outline shrink-0">{String(i + 1).padStart(2, '0')}.</span>
                      <span className="flex-1 text-primary leading-relaxed">{ev}</span>
                      <button onClick={() => setEvidence(e => e.filter((_, j) => j !== i))} className="opacity-0 group-hover:opacity-100 text-outline hover:text-primary transition-opacity shrink-0 text-xs">✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-3 border-b border-primary">
                <input className="flex-1 min-w-0 bg-transparent text-primary font-bold tracking-widest py-3 focus:outline-none placeholder:text-surface-container-highest text-sm"
                  placeholder="ADD EVIDENCE ITEM AND PRESS ENTER"
                  value={evidenceInput} onChange={e => setEvidenceInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEvidence(); } }} />
                <button onClick={addEvidence} className="shrink-0 text-[10px] font-bold tracking-widest border border-primary px-3 py-1 hover:bg-primary hover:text-background transition-colors">+ ADD</button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'defense' && (
          <div className="space-y-12">
            <div className="space-y-2">
              <label className="block text-[10px] tracking-widest text-outline">THE PLEA / STANCE</label>
              <div className="relative">
                <select value={plea} onChange={e => setPlea(e.target.value)}
                  className="w-full bg-transparent border-0 border-b border-primary text-primary font-bold tracking-widest py-3 focus:ring-0 appearance-none cursor-pointer">
                  <option className="bg-background">NOT GUILTY</option>
                  <option className="bg-background">SELF-DEFENSE</option>
                  <option className="bg-background">LACK OF EVIDENCE</option>
                  <option className="bg-background">ALIBI</option>
                  <option className="bg-background">PROCEDURAL VIOLATION</option>
                  <option className="bg-background">NO CONTEST</option>
                </select>
                <ChevronDown className="absolute right-0 top-3 w-5 h-5 pointer-events-none" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] tracking-widest text-outline">DEFENSE COUNTER-NARRATIVE</label>
              <textarea value={defNarrative} onChange={e => setDefNarrative(e.target.value)}
                className="w-full bg-transparent border-0 border-b border-primary text-primary font-medium tracking-widest py-3 focus:ring-0 placeholder:text-surface-container-highest resize-none"
                placeholder="THE ALTERNATE SEQUENCE OF EVENTS AS STATED BY THE DEFENDANT..." rows={4} />
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] tracking-widest text-outline">WITNESS / ALIBI LIST</label>
              <textarea value={witnesses} onChange={e => setWitnesses(e.target.value)}
                className="w-full bg-transparent border-0 border-b border-primary text-primary font-medium tracking-widest py-3 focus:ring-0 placeholder:text-surface-container-highest resize-none"
                placeholder="LIST WITNESSES AND ALIBI DETAILS, ONE PER LINE..." rows={3} />
            </div>

            {/* Facts chips */}
            <div className="space-y-3">
              <label className="block text-[10px] tracking-widest text-outline">FACTS OF THE CASE</label>
              {facts.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {facts.map((fact, i) => (
                    <li key={i} className="flex items-start gap-3 border border-primary/30 px-4 py-2 text-sm font-mono group">
                      <span className="text-outline shrink-0">{String(i + 1).padStart(2, '0')}.</span>
                      <span className="flex-1 text-primary leading-relaxed">{fact}</span>
                      <button onClick={() => setFacts(f => f.filter((_, j) => j !== i))} className="opacity-0 group-hover:opacity-100 text-outline hover:text-primary text-xs">✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-3 border-b border-primary">
                <input className="flex-1 min-w-0 bg-transparent text-primary font-bold tracking-widest py-3 focus:outline-none placeholder:text-surface-container-highest text-sm"
                  placeholder="ADD A FACT AND PRESS ENTER"
                  value={factInput} onChange={e => setFactInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFact(); } }} />
                <button onClick={addFact} className="shrink-0 text-[10px] font-bold tracking-widest border border-primary px-3 py-1 hover:bg-primary hover:text-background transition-colors">+ ADD</button>
              </div>
            </div>
          </div>
        )}

        <div className="pt-12">
          <button onClick={handleSubmit} disabled={isLoading}
            className="w-full py-6 border border-primary text-primary hover:bg-primary hover:text-background font-bold tracking-[0.5em] transition-all duration-300 text-xl flex items-center justify-center gap-4 group disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? 'CONVENING...' : 'START SIMULATION'}
            <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
          </button>
          <div className="mt-4 flex justify-between items-center px-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500" />
              <span className="text-[9px] text-outline tracking-widest uppercase">Backend connected — {difficulty} difficulty</span>
            </div>
            <span className="text-[9px] text-outline tracking-widest uppercase">Version: 1.0.0</span>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── SideLink ──────────────────────────────────────────────────────────────────
function SideLink({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <a className={cn("flex items-center px-6 py-4 gap-4 transition-colors duration-100 font-bold text-xs tracking-widest cursor-pointer",
      active ? "bg-primary text-background" : "text-outline hover:text-primary hover:bg-surface-container"
    )} onClick={e => { e.preventDefault(); onClick?.(); }} href="#">
      {icon}{label}
    </a>
  );
}

// ─── AI Processing Indicator ───────────────────────────────────────────────────
const AI_STAGES = [
  { label: 'Parsing case brief', pct: 15 },
  { label: 'Loading precedents', pct: 32 },
  { label: 'Synthesising argument', pct: 58 },
  { label: 'Reviewing evidence', pct: 74 },
  { label: 'Formulating response', pct: 91 },
  { label: 'Ready to proceed', pct: 100 },
];

function AIProcessingIndicator({ isLoading }: { isLoading: boolean }) {
  const [stage, setStage]         = useState(0);
  const [displayPct, setDisplayPct] = useState(0);

  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => setStage(s => (s + 1) % AI_STAGES.length), 1800);
    return () => clearInterval(id);
  }, [isLoading]);

  const target = isLoading ? AI_STAGES[stage].pct : 100;
  useEffect(() => {
    const diff = target - displayPct;
    if (diff === 0) return;
    const step = diff > 0 ? 1 : -1;
    const id = setInterval(() => setDisplayPct(p => {
      if (Math.abs(target - p) <= 1) { clearInterval(id); return target; }
      return p + step;
    }), 12);
    return () => clearInterval(id);
  }, [stage, isLoading]);

  const current = isLoading ? AI_STAGES[stage] : { label: 'Ready to proceed', pct: 100 };

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-[9px] tracking-widest text-outline uppercase font-bold">AI Processing</span>
        <span className={cn("text-[9px] font-mono", isLoading ? "text-primary" : "text-outline")}>{displayPct}%</span>
      </div>
      <div className="h-1.5 w-full bg-outline-variant/30 relative overflow-hidden">
        <div className="h-full bg-primary transition-all duration-300 relative" style={{ width: `${displayPct}%` }}>
          {isLoading && <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-[shimmer_1.4s_linear_infinite]" />}
        </div>
      </div>
      <p className={cn("text-[9px] tracking-wide leading-snug transition-opacity duration-300", !isLoading && "text-outline opacity-50")}>
        {isLoading ? `↳ ${current.label}…` : '↳ Awaiting next turn'}
      </p>
    </div>
  );
}

// ─── Simulation View ───────────────────────────────────────────────────────────
function SimulationView({
  sessionId, transcript, trialPhase, trialStage, activeAgent, speakingAgent,
  isLoading, isComplete, verdict,
  isRedactMode, isPaused, onViewEvidence,
  isObjecting, setIsObjecting, objectionText, setObjectionText,
  judgeRuling, judgeStatus, setJudgeStatus, submitObjection, resumeProceedings,
  onRedact, onInject,
}: {
  sessionId: string | null;
  transcript: TranscriptEntry[];
  trialPhase: UIPhase;
  trialStage: TrialStage;
  activeAgent: AgentRole;
  speakingAgent: SpeakingAgent;
  isLoading: boolean;
  isComplete: boolean;
  verdict: Verdict | null;
  isRedactMode: boolean;
  isPaused: boolean;
  onViewEvidence: () => void;
  isObjecting: boolean;
  setIsObjecting: (v: boolean) => void;
  objectionText: string;
  setObjectionText: (v: string) => void;
  judgeRuling: null | 'SUSTAINED' | 'OVERRULED';
  judgeStatus: 'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED';
  setJudgeStatus: (v: 'LISTENING' | 'EVALUATING' | 'RULING' | 'HALTED') => void;
  submitObjection: () => void;
  resumeProceedings: () => void;
  onRedact: (kw: string) => void;
  onInject: (text: string) => void;
}) {
  const [verdictLean, setVerdictLean]   = useState(52);
  const [objections, setObjections]     = useState({ prosecution: 0, defense: 0 });
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [redactInput, setRedactInput]   = useState('');
  const [injectInput, setInjectInput]   = useState('');
  const [showInject, setShowInject]     = useState(false);

  // Session timer
  useEffect(() => {
    timerRef.current = setInterval(() => setSessionSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Drift verdict lean based on transcript
  useEffect(() => {
    const prosCount = transcript.filter(e => e.agent === 'prosecution' && !e.redacted).length;
    const defCount  = transcript.filter(e => e.agent === 'defense' && !e.redacted).length;
    const total = prosCount + defCount;
    if (total > 0) setVerdictLean(Math.round((prosCount / total) * 100));
  }, [transcript]);

  // Count objections
  useEffect(() => {
    const pros = transcript.filter(e => e.content.startsWith('OBJECTION:') && e.agent === 'defense').length;
    const def  = transcript.filter(e => e.content.startsWith('OBJECTION:') && e.agent === 'prosecution').length;
    setObjections({ prosecution: pros, defense: def });
  }, [transcript]);

  const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // Get latest entry per role
  const prosEntries = transcript.filter(e => e.agent === 'prosecution' && !e.redacted);
  const defEntries  = transcript.filter(e => e.agent === 'defense' && !e.redacted);
  const lastPros    = prosEntries[prosEntries.length - 1];
  const lastDef     = defEntries[defEntries.length - 1];

  const phaseLabels: Record<UIPhase, string> = {
    opening:           'SESSION 1 — OPENING',
    evidence:          'SESSION 2 — EVIDENCE',
    cross_examination: 'CROSS-EXAMINATION',
    verdict:           'FINAL VERDICT',
  };

  return (
    <div className="fixed inset-0 top-16 bottom-20 overflow-hidden" style={{ cursor: isRedactMode ? 'crosshair' : undefined }}>

      {/* Judge banner */}
      <div className={cn(
        "absolute top-0 left-0 md:left-64 right-0 h-8 flex items-center px-6 gap-3 z-30 border-b border-primary/30 font-mono text-[9px] tracking-[0.3em] uppercase transition-colors duration-300",
        judgeStatus === 'LISTENING' && "bg-background",
        judgeStatus === 'HALTED'    && "bg-primary/10",
        judgeStatus === 'EVALUATING' && "bg-primary/5",
      )}>
        <span className="text-outline">JUDGE: </span>
        {judgeStatus === 'LISTENING'  && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
        {judgeStatus === 'EVALUATING' && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-ping" />}
        {judgeStatus === 'HALTED'     && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
        {judgeStatus === 'RULING'     && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
        <span className={cn("font-bold",
          judgeStatus === 'LISTENING'  && "text-green-500",
          judgeStatus === 'HALTED'     && "text-red-400",
          judgeStatus === 'EVALUATING' && "text-yellow-400",
          judgeStatus === 'RULING'     && "text-primary",
        )}>{judgeStatus}</span>
        <span className="text-outline ml-2">STAGE: {trialStage}</span>
        {isLoading && <span className="text-outline animate-pulse ml-auto">↳ AI GENERATING…</span>}
      </div>

      {/* Sidebar */}
      <aside className="absolute left-0 top-0 bottom-0 w-64 flex flex-col bg-background border-r border-primary hidden md:flex">
        <div className="p-6 border-b border-primary">
          <h2 className="text-lg font-bold font-sans">Court Management</h2>
          <p className="text-[10px] text-outline uppercase">Status: {isComplete ? 'CONCLUDED' : 'ACTIVE'}</p>
        </div>
        <nav className="flex-grow">
          <SideLink icon={<Gavel className="w-4 h-4" />} label="DOCKET" active />
          <SideLink icon={<FolderOpen className="w-4 h-4" />} label="EVIDENCE" onClick={onViewEvidence} />
          <SideLink icon={<FileText className="w-4 h-4" />} label="TRANSCRIPT" />
          <SideLink icon={<BookOpen className="w-4 h-4" />} label="STATUTES" />
        </nav>

        {/* Redact input */}
        {isRedactMode && (
          <div className="p-4 border-t border-primary/30 space-y-2">
            <div className="text-[9px] text-outline tracking-widest uppercase">Redact keyword</div>
            <div className="flex gap-2">
              <input value={redactInput} onChange={e => setRedactInput(e.target.value)}
                className="flex-1 bg-transparent border-b border-primary text-primary text-xs py-1 focus:outline-none"
                placeholder="keyword…" onKeyDown={e => { if (e.key === 'Enter') { onRedact(redactInput); setRedactInput(''); }}} />
              <button onClick={() => { onRedact(redactInput); setRedactInput(''); }}
                className="text-[9px] border border-primary px-2 hover:bg-primary hover:text-background transition-colors">GO</button>
            </div>
          </div>
        )}

        {/* Inject testimony */}
        <div className="p-4 border-t border-primary/30">
          <button onClick={() => setShowInject(s => !s)} className="text-[9px] text-outline tracking-widest uppercase hover:text-primary flex items-center gap-2">
            <Mic className="w-3 h-3" /> {showInject ? 'CANCEL INJECTION' : 'INJECT TESTIMONY'}
          </button>
          {showInject && (
            <div className="mt-2 space-y-2">
              <textarea value={injectInput} onChange={e => setInjectInput(e.target.value)} rows={3}
                className="w-full bg-transparent border border-primary/40 text-primary text-[10px] p-2 focus:outline-none resize-none"
                placeholder="Witness testimony text…" />
              <button onClick={() => { onInject(injectInput); setInjectInput(''); setShowInject(false); }}
                className="w-full text-[9px] border border-primary py-1 hover:bg-primary hover:text-background transition-colors tracking-widest">
                SUBMIT TESTIMONY
              </button>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-primary">
          <AIProcessingIndicator isLoading={isLoading} />
        </div>
      </aside>

      {/* Main content */}
      <div className="absolute top-8 right-0 bottom-0 left-0 md:left-64">
        <AnimatePresence mode="wait">
          {trialPhase !== 'verdict' ? (
            <motion.div key="trial" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex flex-row">

              {/* PROSECUTION PANEL */}
              <section className="flex-1 flex flex-col border-r border-primary relative group overflow-y-auto">
                <div className="p-4 border-b border-primary flex justify-between items-center bg-background sticky top-0 z-10">
                  <span className="text-xs tracking-widest uppercase">Prosecution Counsel</span>
                  <Circle className={cn("w-2 h-2", activeAgent === 'prosecution' ? "fill-primary" : "text-outline")} />
                </div>
                <div className="flex-grow flex flex-col justify-center items-center p-8 space-y-8">
                  <div className="w-24 h-24 flex items-center justify-center">
                    <VoiceIndicator isSpeaking={speakingAgent === 'prosecution'} />
                  </div>
                  <div className="text-center space-y-4 max-w-sm w-full">
                    <h3 className="font-sans text-xl font-extrabold tracking-tighter uppercase">
                      {phaseLabels[trialPhase]}
                    </h3>
                    {lastPros ? (
                      <div className="text-left space-y-3">
                        <p className="text-xs leading-relaxed text-primary normal-case font-medium border-l-2 border-primary pl-4">
                          {lastPros.content}
                        </p>
                        {lastPros.citations.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {lastPros.citations.slice(0, 2).map(c => (
                              <span key={c.case_id} className="text-[9px] text-outline border border-primary/20 px-2 py-0.5 tracking-widest">
                                {c.case_id} ({(c.relevance_score * 100).toFixed(0)}%)
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm leading-relaxed text-outline uppercase">
                        {isLoading && activeAgent === 'prosecution' ? 'Generating opening argument…' : 'Press NEXT to begin.'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </section>

              {/* DEFENSE PANEL */}
              <section className="flex-1 flex flex-col relative group overflow-y-auto">
                <div className="p-4 border-b border-primary flex justify-between items-center bg-background sticky top-0 z-10">
                  <span className="text-xs tracking-widest uppercase">Defense Counsel</span>
                  <Circle className={cn("w-2 h-2", activeAgent === 'defense' ? "fill-primary" : "text-outline")} />
                </div>
                <div className="flex-grow flex flex-col justify-center items-center p-8 space-y-8 bg-surface-container-lowest">
                  <div className="w-24 h-24 flex items-center justify-center">
                    <VoiceIndicator isSpeaking={speakingAgent === 'defense'} />
                  </div>
                  <div className="text-center space-y-4 max-w-sm w-full">
                    <h3 className="font-sans text-xl font-extrabold tracking-tighter uppercase">
                      {phaseLabels[trialPhase]}
                    </h3>
                    {lastDef ? (
                      <div className="text-left space-y-3">
                        <p className="text-xs leading-relaxed text-primary normal-case font-medium border-l-2 border-[#6b7280] pl-4">
                          {lastDef.content}
                        </p>
                        {lastDef.citations.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {lastDef.citations.slice(0, 2).map(c => (
                              <span key={c.case_id} className="text-[9px] text-outline border border-primary/20 px-2 py-0.5 tracking-widest">
                                {c.case_id} ({(c.relevance_score * 100).toFixed(0)}%)
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className={cn("text-sm leading-relaxed uppercase", lastPros ? "text-outline" : "text-outline opacity-50")}>
                        {isLoading && activeAgent === 'defense' ? 'Generating rebuttal…' : 'Awaiting prosecution.'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
              </section>

            </motion.div>
          ) : (
            <motion.div key="verdict" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }} className="absolute inset-0 overflow-y-auto bg-background">
              <VerdictScreen verdict={verdict} isLoading={isLoading} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Judge HUD bar */}
      <div className="fixed bottom-20 left-0 md:left-64 right-0 h-16 bg-background border-t border-primary z-40 flex items-stretch divide-x divide-primary/30">
        {/* Verdict lean */}
        <div className="flex-1 flex flex-col justify-center px-5 gap-1 min-w-0">
          <div className="flex justify-between items-center mb-0.5">
            <span className="text-[8px] tracking-[0.2em] text-white font-bold uppercase">Prosecution</span>
            <span className="text-[8px] tracking-[0.15em] text-outline font-bold uppercase">VERDICT LEAN</span>
            <span className="text-[8px] tracking-[0.2em] text-[#6b7280] font-bold uppercase">Defense</span>
          </div>
          <div className="relative h-2 w-full bg-[#6b7280]/30">
            <div className="absolute left-0 top-0 h-full bg-white transition-all duration-700" style={{ width: `${verdictLean}%` }} />
            <div className="absolute right-0 top-0 h-full bg-[#6b7280] transition-all duration-700" style={{ width: `${100 - verdictLean}%` }} />
            <div className="absolute left-1/2 top-0 h-full w-[2px] bg-background -translate-x-1/2 z-10" />
          </div>
          <div className="flex justify-between">
            <span className="text-[8px] text-white font-mono">{verdictLean}%</span>
            <span className="text-[8px] text-[#6b7280] font-mono">{100 - verdictLean}%</span>
          </div>
        </div>

        {/* Objection counter */}
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

        {/* Session timer */}
        <div className="flex flex-col items-center justify-center px-6 flex-none gap-0.5">
          <span className="text-[8px] tracking-[0.2em] text-outline uppercase">Session Time</span>
          <span className="text-2xl font-extrabold font-mono leading-none tabular-nums text-primary">{fmtTime(sessionSeconds)}</span>
          <span className="text-[8px] text-outline tracking-widest uppercase">{trialStage}</span>
        </div>

        {/* Transcript count */}
        <div className="flex flex-col items-center justify-center px-6 flex-none gap-0.5">
          <span className="text-[8px] tracking-[0.2em] text-outline uppercase">Turns</span>
          <span className="text-2xl font-extrabold font-mono leading-none text-primary">{transcript.length}</span>
          <span className="text-[8px] text-outline tracking-widest uppercase">On Record</span>
        </div>
      </div>

      {/* Objection modal */}
      <AnimatePresence>
        {isObjecting && (
          <motion.div key="objection-modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => { setIsObjecting(false); setJudgeStatus('LISTENING'); }}
          >
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }} onClick={e => e.stopPropagation()}
              className="bg-background border border-primary w-full max-w-xl p-8 space-y-6"
            >
              <div className="space-y-1">
                <p className="text-[9px] text-outline tracking-[0.4em] uppercase">Interactive Judge — Active Referee</p>
                <h2 className="text-2xl font-extrabold font-sans tracking-tighter">LOG_OBJECTION_PROTOCOL</h2>
              </div>
              <div className="border-b border-primary">
                <input autoFocus
                  className="w-full bg-transparent text-primary font-mono tracking-widest py-3 focus:outline-none placeholder:text-surface-container-highest text-sm"
                  placeholder="ENTER GROUNDS FOR OBJECTION (E.G., HEARSAY, LEADING)..."
                  value={objectionText}
                  onChange={e => setObjectionText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitObjection(); }} />
              </div>
              <div className="flex gap-4">
                <button onClick={submitObjection} disabled={!objectionText.trim()}
                  className="flex-1 py-4 bg-primary text-background font-bold tracking-[0.3em] text-sm hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed">
                  SUBMIT TO ALGORITHMIC JUDGE
                </button>
                <button onClick={() => { setIsObjecting(false); setJudgeStatus('LISTENING'); }}
                  className="px-6 py-4 border border-primary/40 text-outline font-bold tracking-widest text-xs hover:border-primary hover:text-primary transition-colors">
                  WITHDRAW
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Judge ruling modal */}
      <AnimatePresence>
        {judgeRuling && (
          <motion.div key="ruling-modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className={cn("w-full max-w-2xl border-2 p-12 space-y-8 text-center",
                judgeRuling === 'SUSTAINED' ? "border-primary bg-background" : "border-red-500/60 bg-background"
              )}
            >
              <p className="text-[9px] tracking-[0.5em] text-outline uppercase">Algorithmic Judge — Ruling</p>
              <h2 className={cn("text-6xl md:text-8xl font-extrabold font-sans tracking-tighter leading-none",
                judgeRuling === 'SUSTAINED' ? "text-primary" : "text-red-400"
              )}>{judgeRuling}</h2>
              <p className={cn("text-sm font-mono tracking-widest uppercase",
                judgeRuling === 'SUSTAINED' ? "text-primary" : "text-red-300"
              )}>
                {judgeRuling === 'SUSTAINED' ? 'OBJECTION SUSTAINED. STRIKING FROM RECORD.' : 'OBJECTION OVERRULED. COUNSEL, PROCEED.'}
              </p>
              <div className={cn("h-px w-full", judgeRuling === 'SUSTAINED' ? "bg-primary/30" : "bg-red-500/30")} />
              <button onClick={resumeProceedings}
                className="w-full py-5 border border-primary text-primary font-bold tracking-[0.4em] text-sm hover:bg-primary hover:text-background transition-all duration-200">
                RESUME PROCEEDINGS
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Verdict Screen ─────────────────────────────────────────────────────────────
function VerdictScreen({ verdict, isLoading }: { verdict: Verdict | null; isLoading: boolean }) {
  const [displayedText, setDisplayedText] = useState('');
  const [docketVisible, setDocketVisible] = useState(false);

  const script = verdict
    ? `THIS COURT IS NOW IN SESSION. THE HONOURABLE COURT HAS REVIEWED ALL SUBMITTED EVIDENCE AND TESTIMONY. ${verdict.reasoning}`
    : 'THIS COURT IS NOW IN SESSION. THE HONOURABLE COURT HAS REVIEWED ALL SUBMITTED EVIDENCE AND TESTIMONY. DELIBERATING...';

  useEffect(() => {
    setDisplayedText('');
    setDocketVisible(false);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayedText(script.slice(0, i));
      if (i >= script.length) {
        clearInterval(id);
        setTimeout(() => setDocketVisible(true), 600);
      }
    }, 22);
    return () => clearInterval(id);
  }, [script]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 md:p-16 overflow-y-auto gap-10">
      <div className="text-center pb-4">
        <h1 className="text-4xl md:text-5xl font-extrabold font-sans tracking-[0.2em] text-primary uppercase">VERDICT</h1>
      </div>

      <div className="w-full max-w-2xl font-mono text-sm leading-relaxed min-h-[120px] relative">
        <p className="text-[9px] text-outline tracking-[0.4em] uppercase mb-3">Court Transcript — Final Session</p>
        <p className="text-primary tracking-wide">
          {displayedText}
          <motion.span animate={{ opacity: [1, 0] }} transition={{ duration: 0.5, repeat: Infinity }}
            className="inline-block w-[2px] h-[1em] bg-primary ml-0.5 align-middle" />
        </p>
      </div>

      <AnimatePresence>
        {docketVisible && verdict && (
          <motion.div key="docket" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
            className="w-full max-w-2xl py-8 space-y-6"
          >
            <p className="text-[9px] tracking-[0.5em] text-outline uppercase text-center mb-6">Official Court Record — SUPREME AI</p>
            <div className="text-center border border-primary/30 py-6">
              <p className="text-[9px] tracking-[0.5em] text-outline uppercase mb-2">Final Ruling</p>
              <h2 className={cn("text-5xl md:text-7xl font-extrabold font-sans tracking-tighter leading-none mt-2",
                verdict.decision === 'GUILTY' ? "text-red-400" : verdict.decision === 'NOT GUILTY' ? "text-green-400" : "text-primary"
              )}>
                {verdict.decision}
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-primary/30">
              <div className="py-4 md:pr-6 space-y-1">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase">Key Factors</p>
                {verdict.key_factors.slice(0, 2).map((f, i) => (
                  <p key={i} className="text-xs font-mono font-bold text-primary leading-snug">• {f.slice(0, 60)}</p>
                ))}
              </div>
              <div className="py-4 md:px-6 space-y-1">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase">AI Model</p>
                <p className="text-xs font-mono font-bold text-primary leading-snug">gpt-oss-120b:free</p>
                <p className="text-[8px] text-outline">Powered by OpenRouter</p>
              </div>
              <div className="py-4 md:pl-6 space-y-1 flex flex-col justify-center">
                <p className="text-[8px] tracking-[0.4em] text-outline uppercase">Confidence Score</p>
                <p className="text-5xl font-extrabold font-sans text-primary leading-none">
                  {Math.round(verdict.confidence * 100)}%
                </p>
              </div>
            </div>

            <p className="text-[8px] text-outline tracking-widest text-center pt-2 border-t border-primary/20">
              THIS RULING IS FINAL — GENERATED BY SUPREME_ARBITER_AI v1.0.0
            </p>
          </motion.div>
        )}
        {docketVisible && !verdict && isLoading && (
          <div className="text-center text-outline text-xs tracking-widest animate-pulse">GENERATING VERDICT…</div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Voice Indicator ───────────────────────────────────────────────────────────
function VoiceIndicator({ isSpeaking }: { isSpeaking: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[5px]">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className={`voice-bar${isSpeaking ? ' active' : ''}`} />
      ))}
    </div>
  );
}
