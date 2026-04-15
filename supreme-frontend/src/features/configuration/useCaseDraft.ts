import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_DRAFT,
  createEvidenceItem,
  normalizeLineEntries,
  type CaseDraft,
  type CaseMode,
  type CaseType,
  type EvidenceItem,
  type EvidenceStatus,
  type EvidenceType,
  type PleaOption,
} from './model';

const STORAGE_KEY = 'supreme.config.draft.v2';
const AUTOSAVE_DELAY_MS = 500;

type Draft = CaseDraft;
type EvidenceMode = Parameters<typeof createEvidenceItem>[1];

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function cloneDefaultDraft(): Draft {
  return {
    ...DEFAULT_DRAFT,
    charges: [...DEFAULT_DRAFT.charges],
    witnesses: [...DEFAULT_DRAFT.witnesses],
    evidence: [...DEFAULT_DRAFT.evidence],
  };
}

const VALID_CASE_TYPES: CaseType[] = ['CRIMINAL', 'CIVIL', 'CORPORATE'];
const VALID_PLEAS: PleaOption[] = [
  'NOT GUILTY',
  'SELF-DEFENSE',
  'LACK OF EVIDENCE',
  'ALIBI',
  'PROCEDURAL VIOLATION',
  'NO CONTEST',
];
const VALID_DIFFICULTIES: Draft['difficulty'][] = ['easy', 'medium', 'hard'];
const VALID_EVIDENCE_MODES: CaseMode[] = ['prosecution', 'defense'];
const VALID_EVIDENCE_TYPES: EvidenceType[] = ['document', 'image', 'video', 'testimony', 'physical'];
const VALID_EVIDENCE_STATUSES: EvidenceStatus[] = ['queued', 'validated', 'flagged'];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function isEvidenceItem(value: unknown): value is EvidenceItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Partial<EvidenceItem>;

  return (
    typeof item.id === 'string'
    && typeof item.value === 'string'
    && VALID_EVIDENCE_MODES.includes(item.mode as CaseMode)
    && VALID_EVIDENCE_TYPES.includes(item.type as EvidenceType)
    && VALID_EVIDENCE_STATUSES.includes(item.status as EvidenceStatus)
    && typeof item.addedAt === 'string'
  );
}

function mergeWithDefaultDraft(raw: unknown): Draft {
  if (!raw || typeof raw !== 'object') {
    return cloneDefaultDraft();
  }

  const parsed = raw as Partial<Draft>;
  const defaultDraft = cloneDefaultDraft();

  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence
      .filter(isEvidenceItem)
      .map((entry) => ({
        ...entry,
        value: entry.value.trim(),
      }))
      .filter((entry) => entry.value.length > 0)
    : [];

  return {
    ...defaultDraft,
    caseType: VALID_CASE_TYPES.includes(parsed.caseType as CaseType)
      ? (parsed.caseType as CaseType)
      : defaultDraft.caseType,
    defendantName: typeof parsed.defendantName === 'string'
      ? parsed.defendantName.trim()
      : defaultDraft.defendantName,
    plea: VALID_PLEAS.includes(parsed.plea as PleaOption)
      ? (parsed.plea as PleaOption)
      : defaultDraft.plea,
    difficulty: VALID_DIFFICULTIES.includes(parsed.difficulty as Draft['difficulty'])
      ? (parsed.difficulty as Draft['difficulty'])
      : defaultDraft.difficulty,
    charges: asStringArray(parsed.charges),
    prosecutionNarrative: typeof parsed.prosecutionNarrative === 'string'
      ? parsed.prosecutionNarrative.trim()
      : defaultDraft.prosecutionNarrative,
    defenseNarrative: typeof parsed.defenseNarrative === 'string'
      ? parsed.defenseNarrative.trim()
      : defaultDraft.defenseNarrative,
    witnesses: asStringArray(parsed.witnesses),
    evidence,
  };
}

export function useCaseDraft() {
  const [draft, setDraft] = useState<Draft>(() => cloneDefaultDraft());
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasHydratedRef = useRef(false);
  const hasUserChangesRef = useRef(false);

  const persist = useCallback((nextDraft: Draft) => {
    try {
      setSaveState('saving');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDraft));
      setLastSavedAt(new Date());
      setSaveError(null);
      setSaveState('saved');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save draft.';
      setSaveState('error');
      setSaveError(message);
      if (!hasHydratedRef.current) {
        setHydrateError(message);
      }
      return false;
    }
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setDraft(mergeWithDefaultDraft(parsed));
      }
      setHydrateError(null);
      setSaveError(null);
    } catch (error) {
      setHydrateError(error instanceof Error ? error.message : 'Failed to hydrate draft.');
      setSaveState('error');
    } finally {
      hasHydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedRef.current || !hasUserChangesRef.current) {
      return;
    }

    setSaveState((prev) => (prev === 'saving' ? prev : 'idle'));

    const timeoutId = window.setTimeout(() => {
      persist(draft);
    }, AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [draft, persist]);

  const setDraftWithTracking = useCallback((next: Draft | ((prev: Draft) => Draft)) => {
    hasUserChangesRef.current = true;
    setDraft(next);
  }, []);

  const updateField = useCallback(
    <K extends keyof Draft>(key: K, value: Draft[K]) => {
      setDraftWithTracking((prev) => ({
        ...prev,
        [key]: value,
      }));
    },
    [setDraftWithTracking],
  );

  const addCharge = useCallback(
    (value: string) => {
      const nextValue = value.trim();
      if (!nextValue) {
        return;
      }

      setDraftWithTracking((prev) => {
        if (prev.charges.includes(nextValue)) {
          return prev;
        }

        return {
          ...prev,
          charges: [...prev.charges, nextValue],
        };
      });
    },
    [setDraftWithTracking],
  );

  const removeCharge = useCallback(
    (value: string) => {
      setDraftWithTracking((prev) => ({
        ...prev,
        charges: prev.charges.filter((charge) => charge !== value),
      }));
    },
    [setDraftWithTracking],
  );

  const addWitness = useCallback(
    (value: string) => {
      const nextValue = value.trim();
      if (!nextValue) {
        return;
      }

      setDraftWithTracking((prev) => {
        if (prev.witnesses.includes(nextValue)) {
          return prev;
        }

        return {
          ...prev,
          witnesses: [...prev.witnesses, nextValue],
        };
      });
    },
    [setDraftWithTracking],
  );

  const removeWitness = useCallback(
    (value: string) => {
      setDraftWithTracking((prev) => ({
        ...prev,
        witnesses: prev.witnesses.filter((witness) => witness !== value),
      }));
    },
    [setDraftWithTracking],
  );

  const addEvidence = useCallback(
    (value: string, mode: EvidenceMode) => {
      const nextValue = value.trim();
      if (!nextValue) {
        return;
      }

      setDraftWithTracking((prev) => ({
        ...prev,
        evidence: [...prev.evidence, createEvidenceItem(nextValue, mode)],
      }));
    },
    [setDraftWithTracking],
  );

  const removeEvidence = useCallback(
    (index: number) => {
      setDraftWithTracking((prev) => ({
        ...prev,
        evidence: prev.evidence.filter((_, evidenceIndex) => evidenceIndex !== index),
      }));
    },
    [setDraftWithTracking],
  );

  const setChargesFromText = useCallback(
    (text: string) => {
      const normalized = normalizeLineEntries(text);
      setDraftWithTracking((prev) => ({
        ...prev,
        charges: normalized,
      }));
    },
    [setDraftWithTracking],
  );

  const setWitnessesFromText = useCallback(
    (text: string) => {
      const normalized = normalizeLineEntries(text);
      setDraftWithTracking((prev) => ({
        ...prev,
        witnesses: normalized,
      }));
    },
    [setDraftWithTracking],
  );

  const resetDraft = useCallback(() => {
    hasUserChangesRef.current = false;
    setDraft(cloneDefaultDraft());
    setSaveState('idle');
    setLastSavedAt(null);
    setHydrateError(null);
    setSaveError(null);

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      setSaveState('error');
    }
  }, []);

  const saveNow = useCallback(() => {
    hasUserChangesRef.current = true;
    return persist(draft);
  }, [draft, persist]);

  return {
    draft,
    setDraft: setDraftWithTracking,
    updateField,
    addCharge,
    removeCharge,
    addWitness,
    removeWitness,
    addEvidence,
    removeEvidence,
    setChargesFromText,
    setWitnessesFromText,
    resetDraft,
    saveNow,
    saveState,
    lastSavedAt,
    hydrateError,
    saveError,
  };
}
