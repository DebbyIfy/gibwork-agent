import type {
  ConfidenceLevel,
  Requirement,
  RequirementAssessment,
  ScoreBreakdown,
  SubmissionClassification,
  SubmissionFlag,
} from './types.js';

const STRONG_SCORE_THRESHOLD = 80;
const REVIEW_SCORE_THRESHOLD = 60;

/** A requirement is as satisfied as it can deterministically get. */
export function isRequirementFullySatisfied(requirement: Requirement, assessment: RequirementAssessment): boolean {
  if (assessment.status === 'verified') return true;
  // No evidence type means we could never verify it beyond a claim -- a claim is the ceiling.
  if (assessment.status === 'claimed' && !requirement.evidenceType) return true;
  return false;
}

/**
 * True when every REQUIRED requirement is resolved to its deterministic ceiling.
 * Exported so the reasoning router can ask the same question classify() does,
 * without duplicating this logic.
 */
export function allRequiredRequirementsSatisfied(
  requirements: Requirement[],
  assessments: RequirementAssessment[],
): boolean {
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const requiredAssessments = assessments.filter((assessment) => byId.get(assessment.requirementId)?.required);
  return requiredAssessments.every((assessment) => {
    const requirement = byId.get(assessment.requirementId);
    return requirement ? isRequirementFullySatisfied(requirement, assessment) : false;
  });
}

/**
 * Classification never lets a high score override an obvious flag: empty and
 * duplicate signals are checked first, before the score is even consulted.
 */
export function classify(
  requirements: Requirement[],
  assessments: RequirementAssessment[],
  flags: SubmissionFlag[],
  score: ScoreBreakdown,
): SubmissionClassification {
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const requiredAssessments = assessments.filter((assessment) => byId.get(assessment.requirementId)?.required);

  const hasEmptyFlag = flags.some((flag) => flag.code === 'empty-submission');
  const hasDuplicateFlag = flags.some((flag) => flag.code.startsWith('duplicate'));
  const hasMissingRequired = requiredAssessments.some((assessment) => assessment.status === 'not_found');
  const hasContradictedRequired = requiredAssessments.some((assessment) => assessment.status === 'contradicted');

  if (hasEmptyFlag) return 'incomplete';
  if (hasDuplicateFlag) return 'suspicious';
  if (hasMissingRequired || hasContradictedRequired) return 'incomplete';

  const allRequiredSatisfied = allRequiredRequirementsSatisfied(requirements, assessments);
  if (allRequiredSatisfied && score.total >= STRONG_SCORE_THRESHOLD) return 'strong';

  const hasUnverifiedRequiredClaim = requiredAssessments.some(
    (assessment) => (assessment.status === 'claimed' && byId.get(assessment.requirementId)?.evidenceType) ||
      assessment.status === 'partially_verified',
  );
  if (hasUnverifiedRequiredClaim) return 'review';
  if (score.total >= REVIEW_SCORE_THRESHOLD) return 'review';
  return 'incomplete';
}

/**
 * Independent from score on purpose: a submission can score high while resting on
 * unverified claims (low confidence), or score modestly while everything present
 * is fully evidenced (high confidence).
 */
export function computeConfidence(assessments: RequirementAssessment[], flags: SubmissionFlag[]): ConfidenceLevel {
  if (flags.some((flag) => flag.code === 'empty-submission')) return 'low';

  const total = assessments.length || 1;
  const resolvedWithEvidence = assessments.filter(
    (assessment) => assessment.status === 'verified' || assessment.status === 'contradicted',
  ).length;
  const ambiguous = assessments.filter(
    (assessment) => assessment.status === 'claimed' || assessment.status === 'partially_verified',
  ).length;
  const evidenceRatio = resolvedWithEvidence / total;

  if (evidenceRatio >= 0.75 && ambiguous === 0) return 'high';
  if (evidenceRatio >= 0.4 || ambiguous <= total / 2) return 'medium';
  return 'low';
}
