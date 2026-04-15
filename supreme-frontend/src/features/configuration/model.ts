import type { CreateCaseRequest } from '../../api/types';

export type CaseType = 'CRIMINAL' | 'CIVIL' | 'CORPORATE';

export type PleaOption =
  | 'NOT GUILTY'
  | 'SELF-DEFENSE'
  | 'LACK OF EVIDENCE'
  | 'ALIBI'
  | 'PROCEDURAL VIOLATION'
  | 'NO CONTEST';

export type CaseMode = 'prosecution' | 'defense';

export type ConfigurationStepId =
  | 'basics'
  | 'allegations'
  | 'narrative'
  | 'evidence'
  | 'review';

export type DraftStatus = 'draft' | 'incomplete' | 'ready';

export type EvidenceType = 'document' | 'image' | 'video' | 'testimony' | 'physical';

export type EvidenceStatus = 'queued' | 'validated' | 'flagged';

export interface EvidenceItem {
  id: string;
  value: string;
  mode: CaseMode;
  type: EvidenceType;
  status: EvidenceStatus;
  addedAt: string;
}

export interface CaseDraft {
  caseType: CaseType;
  defendantName: string;
  plea: PleaOption;
  difficulty: 'easy' | 'medium' | 'hard';
  charges: string[];
  prosecutionNarrative: string;
  defenseNarrative: string;
  witnesses: string[];
  evidence: EvidenceItem[];
}

export interface StepMeta {
  id: ConfigurationStepId;
  label: string;
  hint: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  fieldErrors: Partial<
    Record<'defendantName' | 'charges' | 'evidence' | 'narrative', string>
  >;
}

export interface CompletionMetrics {
  completedSteps: number;
  totalSteps: number;
  ratio: number;
  byStep: Record<ConfigurationStepId, boolean>;
}

export const CONFIGURATION_STEPS: StepMeta[] = [
  {
    id: 'basics',
    label: 'Case Basics',
    hint: 'Set the case type, defendant, plea, and difficulty.',
  },
  {
    id: 'allegations',
    label: 'Allegations',
    hint: 'Add at least one clear charge to frame the case.',
  },
  {
    id: 'narrative',
    label: 'Narrative',
    hint: 'Describe the prosecution or defense perspective.',
  },
  {
    id: 'evidence',
    label: 'Evidence',
    hint: 'Attach supporting items and verify relevance.',
  },
  {
    id: 'review',
    label: 'Review',
    hint: 'Validate all details before creating the case.',
  },
];

export const DEFAULT_DRAFT: CaseDraft = {
  caseType: 'CRIMINAL',
  defendantName: '',
  plea: 'NOT GUILTY',
  difficulty: 'medium',
  charges: [],
  prosecutionNarrative: '',
  defenseNarrative: '',
  witnesses: [],
  evidence: [],
};

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function stableHash(input: string): number {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return Math.abs(hash >>> 0);
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeLineEntries(input: string): string[] {
  const entries = input
    .split(/\r?\n/g)
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const uniqueEntries: string[] = [];

  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      uniqueEntries.push(entry);
    }
  }

  return uniqueEntries;
}

export function inferEvidenceType(value: string): EvidenceType {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return 'document';
  }

  if (/(jpg|jpeg|png|gif|webp|svg|image|photo|screenshot)/.test(normalized)) {
    return 'image';
  }

  if (/(mp4|mov|avi|webm|video|footage|recording)/.test(normalized)) {
    return 'video';
  }

  if (/(witness|testimony|statement|deposition|affidavit)/.test(normalized)) {
    return 'testimony';
  }

  if (/(fingerprint|weapon|dna|sample|physical|object|artifact)/.test(normalized)) {
    return 'physical';
  }

  return 'document';
}

export function createEvidenceItem(value: string, mode: CaseMode): EvidenceItem {
  const normalizedValue = normalizeText(value);
  const fallbackValue = normalizedValue || 'Untitled evidence';
  const idBase = slugify(fallbackValue) || 'evidence-item';
  const hashSource = `${mode}|${fallbackValue}`;
  const hash = stableHash(hashSource).toString(36);

  return {
    id: `evidence-${idBase}-${hash}`,
    value: fallbackValue,
    mode,
    type: inferEvidenceType(fallbackValue),
    status: 'queued',
    addedAt: new Date(stableHash(`addedAt:${hashSource}`)).toISOString(),
  };
}

export function buildValidation(draft: CaseDraft): ValidationResult {
  const fieldErrors: ValidationResult['fieldErrors'] = {};
  const errors: string[] = [];

  const defendantName = normalizeText(draft.defendantName);
  const charges = draft.charges.map((charge) => normalizeText(charge)).filter(Boolean);
  const evidence = draft.evidence.filter((item) => normalizeText(item.value).length > 0);

  const prosecutionNarrative = normalizeText(draft.prosecutionNarrative);
  const defenseNarrative = normalizeText(draft.defenseNarrative);

  if (!defendantName) {
    fieldErrors.defendantName = 'Defendant name is required.';
    errors.push(fieldErrors.defendantName);
  }

  if (charges.length === 0) {
    fieldErrors.charges = 'At least one charge is required.';
    errors.push(fieldErrors.charges);
  }

  if (evidence.length === 0) {
    fieldErrors.evidence = 'At least one evidence item is required.';
    errors.push(fieldErrors.evidence);
  }

  if (!prosecutionNarrative && !defenseNarrative) {
    fieldErrors.narrative = 'Provide a prosecution or defense narrative.';
    errors.push(fieldErrors.narrative);
  }

  return {
    isValid: errors.length === 0,
    errors,
    fieldErrors,
  };
}

export function hasMeaningfulInput(draft: CaseDraft): boolean {
  return (
    normalizeText(draft.defendantName).length > 0
    || draft.charges.map((charge) => normalizeText(charge)).filter(Boolean).length > 0
    || normalizeText(draft.prosecutionNarrative).length > 0
    || normalizeText(draft.defenseNarrative).length > 0
    || draft.witnesses.map((witness) => normalizeText(witness)).filter(Boolean).length > 0
    || draft.evidence.filter((item) => normalizeText(item.value).length > 0).length > 0
  );
}

export function getDraftStatus(draft: CaseDraft, validation: ValidationResult): DraftStatus {
  if (validation.isValid) {
    return 'ready';
  }

  if (!hasMeaningfulInput(draft)) {
    return 'draft';
  }

  return 'incomplete';
}

export function buildCasePayload(draft: CaseDraft): CreateCaseRequest {
  const defendantName = normalizeText(draft.defendantName);
  const title = `${draft.caseType} - ${defendantName}`.trim();

  const charges = draft.charges.map((charge) => normalizeText(charge)).filter(Boolean);
  const evidenceValues = draft.evidence
    .map((item) => normalizeText(item.value))
    .filter((value) => value.length > 0);

  const descriptionLines: string[] = [
    `Case Type: ${draft.caseType}`,
    `Defendant: ${defendantName || 'Unknown'}`,
    `Plea: ${draft.plea}`,
  ];

  const prosecutionNarrative = normalizeText(draft.prosecutionNarrative);
  const defenseNarrative = normalizeText(draft.defenseNarrative);
  const witnesses = draft.witnesses.map((witness) => normalizeText(witness)).filter(Boolean);

  if (prosecutionNarrative) {
    descriptionLines.push(`Prosecution: ${prosecutionNarrative}`);
  }

  if (defenseNarrative) {
    descriptionLines.push(`Defense: ${defenseNarrative}`);
  }

  if (witnesses.length > 0) {
    descriptionLines.push(`Witnesses: ${witnesses.join(', ')}`);
  }

  return {
    title,
    description: descriptionLines.join('\n'),
    charges,
    evidence: evidenceValues,
    plea: draft.plea,
    difficulty: draft.difficulty,
  };
}

export function getCompletionMetrics(draft: CaseDraft): CompletionMetrics {
  const validation = buildValidation(draft);
  const basicsComplete = normalizeText(draft.defendantName).length > 0;
  const allegationsComplete =
    draft.charges.map((charge) => normalizeText(charge)).filter(Boolean).length > 0;
  const narrativeComplete =
    normalizeText(draft.prosecutionNarrative).length > 0 ||
    normalizeText(draft.defenseNarrative).length > 0;
  const evidenceComplete =
    draft.evidence.filter((item) => normalizeText(item.value).length > 0).length > 0;
  const reviewComplete = validation.isValid;

  const byStep: CompletionMetrics['byStep'] = {
    basics: basicsComplete,
    allegations: allegationsComplete,
    narrative: narrativeComplete,
    evidence: evidenceComplete,
    review: reviewComplete,
  };
  const completedSteps = Object.values(byStep).filter(Boolean).length;

  const totalSteps = CONFIGURATION_STEPS.length;

  return {
    completedSteps,
    totalSteps,
    ratio: totalSteps === 0 ? 0 : completedSteps / totalSteps,
    byStep,
  };
}
