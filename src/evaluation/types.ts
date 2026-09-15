export type RequirementStatus = 'verified' | 'partially_verified' | 'claimed' | 'not_found' | 'contradicted';

export type SubmissionClassification = 'strong' | 'review' | 'incomplete' | 'suspicious';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Extensible on purpose -- an LLM-backed extractor/evaluator may introduce more later. */
export type EvidenceType = 'github' | 'url' | 'document' | 'image' | 'text' | 'other';

export interface Requirement {
  id: string;
  description: string;
  required: boolean;
  /** Deterministic hint: substrings whose presence in submission text counts as a claim. */
  keywords?: string[];
  /** What evidence type would verify this requirement, if any exists for it. */
  evidenceType?: EvidenceType;
}

export interface Evidence {
  type: EvidenceType;
  value: string;
  sourceNote?: string;
}

export interface RequirementAssessment {
  requirementId: string;
  status: RequirementStatus;
  evidence: Evidence[];
  reason: string;
}

export interface SubmissionFlag {
  code: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface ScoreBreakdown {
  requirementCoverage: number;
  evidenceQuality: number;
  completeness: number;
  relevance: number;
  qualitySignals: number;
  total: number;
}

export interface SubmissionAssessment {
  submissionId: string;
  classification: SubmissionClassification;
  confidence: ConfidenceLevel;
  score: ScoreBreakdown;
  requirementAssessments: RequirementAssessment[];
  flags: SubmissionFlag[];
  reasons: string[];
}

export interface ReviewTask {
  id: string;
  title: string;
  description: string;
  /** Fixtures may supply these directly; a future extractor could derive them instead. */
  requirements?: Requirement[];
}

export interface ReviewSubmission {
  id: string;
  content: string;
  links?: string[];
  attachments?: { type: EvidenceType; value: string }[];
}

export interface ReviewResult {
  task: ReviewTask;
  requirements: Requirement[];
  assessments: SubmissionAssessment[];
}
