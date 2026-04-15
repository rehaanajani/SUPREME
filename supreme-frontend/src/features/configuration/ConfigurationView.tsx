import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  BookText,
  Circle,
  CircleCheckBig,
  FileStack,
  FolderKanban,
  Gavel,
  Play,
  Save,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';

import type { CreateCaseRequest } from '../../api/types';
import { cn } from '../../lib/utils';
import {
  buildCasePayload,
  buildValidation,
  getCompletionMetrics,
  getDraftStatus,
  type CaseMode,
  type ConfigurationStepId,
} from './model';
import { useCaseDraft } from './useCaseDraft';

type ConfigurationViewProps = {
  onStart: (payload: CreateCaseRequest) => void;
  isLoading: boolean;
  isSidebarCompact?: boolean;
  onSidebarStateChange?: (state: ConfigurationSidebarState) => void;
};

export type ConfigurationSidebarState = {
  draftStatus: 'draft' | 'incomplete' | 'ready';
  completedSteps: number;
  totalSteps: number;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  activeStep: ConfigurationStepId;
  issueCount: number;
  lastSavedLabel: string;
};

const STEP_ORDER: Array<{ id: ConfigurationStepId; label: string; icon: typeof Gavel }> = [
  { id: 'basics', label: 'Basics', icon: Gavel },
  { id: 'allegations', label: 'Allegations', icon: FileStack },
  { id: 'narrative', label: 'Narrative', icon: BookText },
  { id: 'evidence', label: 'Evidence', icon: FolderKanban },
  { id: 'review', label: 'Review', icon: ShieldCheck },
];

function toReadableTimestamp(value: Date | null): string {
  if (!value) return 'Not saved yet';
  return value.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getSaveStateLabel(saveState: 'idle' | 'saving' | 'saved' | 'error'): string {
  if (saveState === 'saving') return 'Autosaving';
  if (saveState === 'saved') return 'Saved';
  if (saveState === 'error') return 'Save error';
  return 'Idle';
}

function getSaveStateTone(saveState: 'idle' | 'saving' | 'saved' | 'error'): string {
  if (saveState === 'saving') return 'text-amber-300 border-amber-300/40 bg-amber-300/10';
  if (saveState === 'saved') return 'text-emerald-300 border-emerald-300/40 bg-emerald-300/10';
  if (saveState === 'error') return 'text-red-300 border-red-300/40 bg-red-300/10';
  return 'text-outline border-outline/40 bg-surface-container-low';
}

function getFirstFailingStep(validation: ReturnType<typeof buildValidation>): ConfigurationStepId {
  if (validation.fieldErrors.defendantName) return 'basics';
  if (validation.fieldErrors.charges) return 'allegations';
  if (validation.fieldErrors.narrative) return 'narrative';
  if (validation.fieldErrors.evidence) return 'evidence';
  return 'review';
}

export default function ConfigurationView(props: ConfigurationViewProps) {
  const { onStart, isLoading, isSidebarCompact = false, onSidebarStateChange } = props;
  const {
    draft,
    updateField,
    addCharge,
    removeCharge,
    addWitness,
    removeWitness,
    addEvidence,
    removeEvidence,
    saveNow,
    saveState,
    lastSavedAt,
    hydrateError,
    saveError,
  } = useCaseDraft();

  const [activeStep, setActiveStep] = useState<ConfigurationStepId>('basics');
  const [showValidation, setShowValidation] = useState(false);
  const [chargeInput, setChargeInput] = useState('');
  const [witnessInput, setWitnessInput] = useState('');
  const [evidenceInput, setEvidenceInput] = useState('');
  const [evidenceMode, setEvidenceMode] = useState<CaseMode>('prosecution');

  const validation = useMemo(() => buildValidation(draft), [draft]);
  const completion = useMemo(() => getCompletionMetrics(draft), [draft]);
  const draftStatus = useMemo(() => getDraftStatus(draft, validation), [draft, validation]);

  useEffect(() => {
    if (!onSidebarStateChange) return;
    onSidebarStateChange({
      draftStatus,
      completedSteps: completion.completedSteps,
      totalSteps: completion.totalSteps,
      saveState,
      activeStep,
      issueCount: validation.errors.length,
      lastSavedLabel: toReadableTimestamp(lastSavedAt),
    });
  }, [
    activeStep,
    completion.completedSteps,
    completion.totalSteps,
    draftStatus,
    lastSavedAt,
    onSidebarStateChange,
    saveState,
    validation.errors.length,
  ]);

  const prosecutionEvidence = useMemo(
    () => draft.evidence.filter((item) => item.mode === 'prosecution'),
    [draft.evidence],
  );
  const defenseEvidence = useMemo(
    () => draft.evidence.filter((item) => item.mode === 'defense'),
    [draft.evidence],
  );

  const runValidation = (): boolean => {
    setShowValidation(true);
    if (!validation.isValid) {
      setActiveStep(getFirstFailingStep(validation));
      return false;
    }
    return true;
  };

  const handleSaveDraft = () => {
    saveNow();
  };

  const handleStart = () => {
    if (!runValidation()) {
      return;
    }

    const payload = buildCasePayload(draft);
    onStart(payload);
  };

  const addChargeChip = () => {
    addCharge(chargeInput);
    setChargeInput('');
  };

  const addWitnessChip = () => {
    addWitness(witnessInput);
    setWitnessInput('');
  };

  const addEvidenceChip = () => {
    addEvidence(evidenceInput, evidenceMode);
    setEvidenceInput('');
  };

  const hasStepError = (stepId: ConfigurationStepId): boolean => {
    if (!showValidation) return false;
    if (stepId === 'basics') return Boolean(validation.fieldErrors.defendantName);
    if (stepId === 'allegations') return Boolean(validation.fieldErrors.charges);
    if (stepId === 'narrative') return Boolean(validation.fieldErrors.narrative);
    if (stepId === 'evidence') return Boolean(validation.fieldErrors.evidence);
    return !validation.isValid;
  };

  return (
    <main className="min-h-screen bg-background pt-4 md:pt-6 pb-36 text-primary">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <section className="mb-6 rounded-none border border-primary/25 bg-surface-container-low px-4 py-4 sm:px-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] tracking-[0.25em] text-outline">COURTROOM CONFIGURATION WIZARD</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Case Setup</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] tracking-widest">
              {(['draft', 'incomplete', 'ready'] as const).map((status) => (
                <span
                  key={status}
                  className={cn(
                    'border px-2 py-1 uppercase',
                    draftStatus === status
                      ? 'border-primary bg-primary text-background'
                      : 'border-outline/40 text-outline',
                  )}
                >
                  {status}
                </span>
              ))}
            </div>
          </div>

          <div className="mb-4 flex items-center gap-3 text-[11px] text-primary/85">
            <span
              className={cn(
                'inline-flex items-center gap-2 border px-2 py-1 text-[10px] tracking-widest uppercase',
                getSaveStateTone(saveState),
              )}
            >
              <Circle className="h-3 w-3" />
              {getSaveStateLabel(saveState)}
            </span>
            <span className="text-outline">Last saved: {toReadableTimestamp(lastSavedAt)}</span>
          </div>

          <div className="mb-4 h-2 w-full overflow-hidden bg-surface-container">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round(completion.ratio * 100)}%` }}
            />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {STEP_ORDER.map((step) => {
              const isActive = activeStep === step.id;
              const isComplete = completion.byStep[step.id];
              const Icon = step.icon;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setActiveStep(step.id)}
                  className={cn(
                    'flex items-center gap-2 border px-3 py-2 text-left text-xs tracking-wide transition-colors',
                    isActive
                      ? 'border-primary bg-surface-container text-primary'
                      : 'border-outline/40 bg-background text-outline hover:text-primary',
                    hasStepError(step.id) && 'border-red-300/60 text-red-200',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="uppercase">{step.label}</span>
                  {isComplete && <CircleCheckBig className="ml-auto h-4 w-4" />}
                </button>
              );
            })}
          </div>
        </section>

        {showValidation && !validation.isValid && (
          <div className="mb-6 border border-red-300/40 bg-red-300/10 px-4 py-3 text-sm text-red-100">
            <div className="mb-2 flex items-center gap-2 text-[11px] tracking-widest uppercase">
              <AlertTriangle className="h-4 w-4" />
              Validation failed - {validation.errors.length} issue(s)
            </div>
            <ul className="space-y-1 text-[13px] normal-case text-red-100/90">
              {validation.errors.map((error) => (
                <li key={error}>- {error}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="border border-primary/25 bg-surface-container-low p-4 sm:p-6">
            {activeStep === 'basics' && (
              <div className="space-y-5">
                <header>
                  <h2 className="text-lg font-semibold uppercase tracking-wide">Basics</h2>
                  <p className="mt-1 text-sm text-outline normal-case">
                    Define case identity, defendant, plea, and simulation difficulty.
                  </p>
                </header>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">Case Type</span>
                    <select
                      value={draft.caseType}
                      onChange={(event) => updateField('caseType', event.target.value as typeof draft.caseType)}
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                    >
                      <option value="CRIMINAL">CRIMINAL</option>
                      <option value="CIVIL">CIVIL</option>
                      <option value="CORPORATE">CORPORATE</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">Difficulty</span>
                    <select
                      value={draft.difficulty}
                      onChange={(event) =>
                        updateField('difficulty', event.target.value as typeof draft.difficulty)
                      }
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                    >
                      <option value="easy">EASY</option>
                      <option value="medium">MEDIUM</option>
                      <option value="hard">HARD</option>
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">
                    Defendant Name
                  </span>
                  <input
                    value={draft.defendantName}
                    onChange={(event) => updateField('defendantName', event.target.value)}
                    placeholder="FULL LEGAL NAME"
                    className={cn(
                      'w-full border bg-background px-3 py-2 text-sm tracking-wide focus:outline-none',
                      showValidation && validation.fieldErrors.defendantName
                        ? 'border-red-300/70 text-red-100 focus:border-red-300'
                        : 'border-outline/40 focus:border-primary',
                    )}
                  />
                  {showValidation && validation.fieldErrors.defendantName && (
                    <p className="mt-2 text-xs text-red-200 normal-case">
                      {validation.fieldErrors.defendantName}
                    </p>
                  )}
                </label>

                <label className="block">
                  <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">Plea</span>
                  <select
                    value={draft.plea}
                    onChange={(event) => updateField('plea', event.target.value as typeof draft.plea)}
                    className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                  >
                    <option value="NOT GUILTY">NOT GUILTY</option>
                    <option value="SELF-DEFENSE">SELF-DEFENSE</option>
                    <option value="LACK OF EVIDENCE">LACK OF EVIDENCE</option>
                    <option value="ALIBI">ALIBI</option>
                    <option value="PROCEDURAL VIOLATION">PROCEDURAL VIOLATION</option>
                    <option value="NO CONTEST">NO CONTEST</option>
                  </select>
                </label>
              </div>
            )}

            {activeStep === 'allegations' && (
              <div className="space-y-5">
                <header>
                  <h2 className="text-lg font-semibold uppercase tracking-wide">Allegations</h2>
                  <p className="mt-1 text-sm text-outline normal-case">
                    Enter each allegation as a chip for fast scanning and clean edits.
                  </p>
                </header>

                <div>
                  <label className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">
                    Add Charge
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={chargeInput}
                      onChange={(event) => setChargeInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault();
                          addChargeChip();
                        }
                      }}
                      placeholder="TYPE CHARGE AND PRESS ENTER"
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={addChargeChip}
                      className="border border-primary px-4 py-2 text-xs tracking-widest hover:bg-primary hover:text-background"
                    >
                      Add
                    </button>
                  </div>
                  {showValidation && validation.fieldErrors.charges && (
                    <p className="mt-2 text-xs text-red-200 normal-case">{validation.fieldErrors.charges}</p>
                  )}
                </div>

                <div className="flex min-h-20 flex-wrap gap-2 border border-outline/30 bg-background p-3">
                  {draft.charges.length === 0 && (
                    <p className="text-xs text-outline normal-case">No charges added yet.</p>
                  )}
                  {draft.charges.map((charge) => (
                    <span
                      key={charge}
                      className="inline-flex items-center gap-2 border border-outline/40 bg-surface px-2 py-1 text-xs normal-case text-primary/90"
                    >
                      {charge}
                      <button
                        type="button"
                        onClick={() => removeCharge(charge)}
                        className="text-outline hover:text-red-200"
                        aria-label={`Remove ${charge}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {activeStep === 'narrative' && (
              <div className="space-y-5">
                <header>
                  <h2 className="text-lg font-semibold uppercase tracking-wide">Narrative</h2>
                  <p className="mt-1 text-sm text-outline normal-case">
                    Capture both party narratives and list witnesses as removable chips.
                  </p>
                </header>

                <div className="grid grid-cols-1 gap-4">
                  <label className="block">
                    <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">
                      Prosecution Narrative
                    </span>
                    <textarea
                      rows={4}
                      value={draft.prosecutionNarrative}
                      onChange={(event) => updateField('prosecutionNarrative', event.target.value)}
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm leading-relaxed normal-case focus:border-primary focus:outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">
                      Defense Narrative
                    </span>
                    <textarea
                      rows={4}
                      value={draft.defenseNarrative}
                      onChange={(event) => updateField('defenseNarrative', event.target.value)}
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm leading-relaxed normal-case focus:border-primary focus:outline-none"
                    />
                  </label>
                </div>

                {showValidation && validation.fieldErrors.narrative && (
                  <p className="text-xs text-red-200 normal-case">{validation.fieldErrors.narrative}</p>
                )}

                <div>
                  <label className="mb-2 block text-[10px] tracking-[0.18em] text-outline uppercase">
                    Witnesses
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={witnessInput}
                      onChange={(event) => setWitnessInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                          event.preventDefault();
                          addWitnessChip();
                        }
                      }}
                      placeholder="ADD WITNESS NAME OR ROLE"
                      className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={addWitnessChip}
                      className="border border-primary px-4 py-2 text-xs tracking-widest hover:bg-primary hover:text-background"
                    >
                      Add
                    </button>
                  </div>

                  <div className="mt-3 flex min-h-16 flex-wrap gap-2 border border-outline/30 bg-background p-3">
                    {draft.witnesses.length === 0 && (
                      <p className="text-xs text-outline normal-case">No witnesses added yet.</p>
                    )}
                    {draft.witnesses.map((witness) => (
                      <span
                        key={witness}
                        className="inline-flex items-center gap-2 border border-outline/40 bg-surface px-2 py-1 text-xs normal-case text-primary/90"
                      >
                        {witness}
                        <button
                          type="button"
                          onClick={() => removeWitness(witness)}
                          className="text-outline hover:text-red-200"
                          aria-label={`Remove ${witness}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeStep === 'evidence' && (
              <div className="space-y-5">
                <header>
                  <h2 className="text-lg font-semibold uppercase tracking-wide">Evidence</h2>
                  <p className="mt-1 text-sm text-outline normal-case">
                    Toggle source mode, add evidence chips, and monitor type and status badges.
                  </p>
                </header>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] tracking-[0.18em] text-outline uppercase">Mode</span>
                  {(['prosecution', 'defense'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setEvidenceMode(mode)}
                      className={cn(
                        'border px-3 py-1 text-[10px] tracking-widest uppercase',
                        evidenceMode === mode
                          ? 'border-primary bg-primary text-background'
                          : 'border-outline/40 text-outline hover:text-primary',
                      )}
                    >
                      {mode}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={evidenceInput}
                    onChange={(event) => setEvidenceInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault();
                        addEvidenceChip();
                      }
                    }}
                    placeholder="ADD EVIDENCE DESCRIPTION"
                    className="w-full border border-outline/40 bg-background px-3 py-2 text-sm tracking-wide focus:border-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={addEvidenceChip}
                    className="border border-primary px-4 py-2 text-xs tracking-widest hover:bg-primary hover:text-background"
                  >
                    Add
                  </button>
                </div>

                {showValidation && validation.fieldErrors.evidence && (
                  <p className="text-xs text-red-200 normal-case">{validation.fieldErrors.evidence}</p>
                )}

                <div className="space-y-3">
                  {draft.evidence.length === 0 && (
                    <p className="border border-outline/30 bg-background p-3 text-sm text-outline normal-case">
                      No evidence captured yet.
                    </p>
                  )}

                  {draft.evidence.map((item, index) => (
                    <div
                      key={`${item.id}-${index}`}
                      className="flex flex-wrap items-start gap-3 border border-outline/30 bg-background p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-primary/90 normal-case">{item.value}</p>
                        <div className="mt-2 flex flex-wrap gap-2 text-[10px] tracking-widest uppercase">
                          <span className="border border-outline/40 px-2 py-1 text-outline">{item.mode}</span>
                          <span className="border border-outline/40 px-2 py-1 text-outline">{item.type}</span>
                          <span className="border border-primary/40 px-2 py-1 text-primary/85">{item.status}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeEvidence(index)}
                        className="border border-outline/40 px-2 py-1 text-xs tracking-widest text-outline hover:border-red-300/50 hover:text-red-200"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeStep === 'review' && (
              <div className="space-y-5">
                <header>
                  <h2 className="text-lg font-semibold uppercase tracking-wide">Review</h2>
                  <p className="mt-1 text-sm text-outline normal-case">
                    Compact readback of all case inputs before simulation start.
                  </p>
                </header>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Defendant</p>
                    <p className="mt-1 text-sm normal-case">{draft.defendantName || 'Not provided'}</p>
                  </div>
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Case Profile</p>
                    <p className="mt-1 text-sm normal-case">
                      {draft.caseType} | {draft.plea} | {draft.difficulty}
                    </p>
                  </div>
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Charges</p>
                    <p className="mt-1 text-sm normal-case">{draft.charges.length} item(s)</p>
                  </div>
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Witnesses</p>
                    <p className="mt-1 text-sm normal-case">{draft.witnesses.length} item(s)</p>
                  </div>
                </div>

                <div className="border border-outline/30 bg-background p-3">
                  <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Narrative Snapshot</p>
                  <p className="mt-2 text-sm normal-case text-primary/90">
                    {draft.prosecutionNarrative || draft.defenseNarrative
                      ? `${draft.prosecutionNarrative || 'No prosecution narrative.'} ${draft.defenseNarrative || 'No defense narrative.'}`
                      : 'No narrative entered.'}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Prosecution Evidence</p>
                    <p className="mt-1 text-sm normal-case">{prosecutionEvidence.length} item(s)</p>
                  </div>
                  <div className="border border-outline/30 bg-background p-3">
                    <p className="text-[10px] tracking-[0.18em] text-outline uppercase">Defense Evidence</p>
                    <p className="mt-1 text-sm normal-case">{defenseEvidence.length} item(s)</p>
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="border border-primary/25 bg-surface-container-low p-4 sm:p-5 lg:sticky lg:top-24 lg:h-fit">
            <h3 className="text-sm tracking-[0.2em] text-outline uppercase">Summary Panel</h3>

            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between border border-outline/30 bg-background px-3 py-2">
                <span className="text-outline">Completion</span>
                <span>
                  {completion.completedSteps}/{completion.totalSteps}
                </span>
              </div>

              <div className="flex items-center justify-between border border-outline/30 bg-background px-3 py-2">
                <span className="text-outline">Charges</span>
                <span>{draft.charges.length}</span>
              </div>

              <div className="flex items-center justify-between border border-outline/30 bg-background px-3 py-2">
                <span className="text-outline">Witnesses</span>
                <span>{draft.witnesses.length}</span>
              </div>

              <div className="flex items-center justify-between border border-outline/30 bg-background px-3 py-2">
                <span className="text-outline">Evidence</span>
                <span>{draft.evidence.length}</span>
              </div>

              <div className="border border-outline/30 bg-background px-3 py-2">
                <div className="flex items-center gap-2 text-[10px] tracking-widest text-outline uppercase">
                  <Users className="h-3.5 w-3.5" />
                  Party Split
                </div>
                <p className="mt-1 text-sm normal-case">
                  Prosecution: {prosecutionEvidence.length} | Defense: {defenseEvidence.length}
                </p>
              </div>

              {hydrateError && (
                <div className="border border-red-300/40 bg-red-300/10 px-3 py-2 text-xs text-red-200 normal-case">
                  {hydrateError}
                </div>
              )}

              {saveError && !hydrateError && (
                <div className="border border-red-300/40 bg-red-300/10 px-3 py-2 text-xs text-red-200 normal-case">
                  Save error: {saveError}
                </div>
              )}

              <div className="border border-outline/30 bg-background px-3 py-2">
                <div className="flex items-center gap-2 text-[10px] tracking-widest text-outline uppercase">
                  <BadgeCheck className="h-3.5 w-3.5" />
                  Current Status
                </div>
                <p className="mt-1 text-sm uppercase">
                  {draftStatus === 'ready' ? 'READY' : draftStatus === 'incomplete' ? 'INCOMPLETE' : 'DRAFT'}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-primary/30 bg-background/95 backdrop-blur transition-[left] duration-200',
          isSidebarCompact ? 'md:left-20' : 'md:left-72',
        )}
      >
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="text-xs text-outline normal-case">
            Last saved: {toReadableTimestamp(lastSavedAt)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSaveDraft}
              className="inline-flex items-center gap-2 border border-outline/50 px-3 py-2 text-xs tracking-widest text-outline hover:border-primary hover:text-primary"
            >
              <Save className="h-4 w-4" />
              Save Draft
            </button>
            <button
              type="button"
              onClick={runValidation}
              className="inline-flex items-center gap-2 border border-primary/70 px-3 py-2 text-xs tracking-widest text-primary hover:bg-primary hover:text-background"
            >
              <ShieldCheck className="h-4 w-4" />
              Validate
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={isLoading}
              className="inline-flex items-center gap-2 border border-primary bg-primary px-3 py-2 text-xs tracking-widest text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Start Simulation
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
