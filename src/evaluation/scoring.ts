import type { Requirement, RequirementAssessment, ScoreBreakdown, SubmissionFlag } from './types.js';

/** Isolated on purpose -- change the weights/formula here without touching the evaluator. */
const WEIGHTS = {
  requirementCoverage: 40,
  evidenceQuality: 25,
  completeness: 15,
  relevance: 10,
  qualitySignals: 10,
} as const;

const STATUS_WEIGHT: Record<RequirementAssessment['status'], number> = {
  verified: 1,
  partially_verified: 0.6,
  claimed: 0.25,
  not_found: 0,
  contradicted: 0,
};

const COMPLETENESS_LENGTH_TARGET = 400;

/**
 * Transparent, not objective: this is one deterministic way to weigh the signals we
 * have, not ground truth. An empty submission always scores zero across the board.
 */
export function computeScore(
  requirements: Requirement[],
  requirementAssessments: RequirementAssessment[],
  flags: SubmissionFlag[],
  contentLength: number,
): ScoreBreakdown {
  if (flags.some((flag) => flag.code === 'empty-submission')) {
    return { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: 0 };
  }

  const totalRequirements = requirementAssessments.length || 1;
  const coverageRatio =
    requirementAssessments.reduce((sum, assessment) => sum + (STATUS_WEIGHT[assessment.status] ?? 0), 0) /
    totalRequirements;
  const requirementCoverage = Math.round(coverageRatio * WEIGHTS.requirementCoverage);

  const verifiableIds = new Set(requirements.filter((req) => req.evidenceType).map((req) => req.id));
  const verifiableAssessments = requirementAssessments.filter((assessment) => verifiableIds.has(assessment.requirementId));
  const verifiedCount = verifiableAssessments.filter((assessment) => assessment.status === 'verified').length;
  const evidenceRatio = verifiableAssessments.length === 0 ? 1 : verifiedCount / verifiableAssessments.length;
  const evidenceQuality = Math.round(evidenceRatio * WEIGHTS.evidenceQuality);

  const completeness = Math.round(Math.min(1, contentLength / COMPLETENESS_LENGTH_TARGET) * WEIGHTS.completeness);

  const duplicateFlagCount = flags.filter((flag) => flag.code.startsWith('duplicate')).length;
  const relevance = Math.max(0, Math.round(WEIGHTS.relevance - duplicateFlagCount * 5));

  const warningCount = flags.filter((flag) => flag.severity === 'warning').length;
  const qualitySignals = Math.max(0, WEIGHTS.qualitySignals - warningCount * 3);

  const total = requirementCoverage + evidenceQuality + completeness + relevance + qualitySignals;

  return { requirementCoverage, evidenceQuality, completeness, relevance, qualitySignals, total };
}
