import type { Requirement, RequirementAssessment, ReviewResult, SubmissionAssessment } from './types.js';
import { isFreeFormClaim } from './classification.js';

export interface RequirementStatusSummary {
  total: number;
  satisfied: number;
  partial: number;
  /** A non-empty response was given to a requirement with no evidence type and no
   *  authored keywords -- deterministically unverifiable either way; a human's semantic
   *  read is needed. Never folded into `satisfied`, which would overstate it. */
  needsSemanticReview: number;
  missing: number;
}

export interface ClassificationCounts {
  strong: number;
  review: number;
  incomplete: number;
  suspicious: number;
}

export interface SubmissionSummaryEntry {
  /** Stable 1-based position in the original (fetched/evaluated) submission order. Used
   *  as the short "#N" reference in every section of the report and for --inspect, so a
   *  submission keeps the same number regardless of which section it appears in. */
  displayNumber: number;
  submissionId: string;
  assessment: SubmissionAssessment;
}

export interface ReviewSummary {
  requirementStatus: RequirementStatusSummary;
  assessedSubmissionCount: number;
  classificationCounts: ClassificationCounts;
  /** All submissions, in original order, with their stable display number attached. */
  entries: SubmissionSummaryEntry[];
  /** Suspicious + Review + Incomplete, ordered by classification urgency (Suspicious
   *  first, then Review, then Incomplete) and score descending within each, capped --
   *  "what needs my judgment first". Strong is deliberately excluded. */
  priorityReview: SubmissionSummaryEntry[];
  priorityReviewOverflow: number;
  /** Strong, score descending, capped -- a few reassuring examples, not an exhaustive list. */
  topSubmissions: SubmissionSummaryEntry[];
  topSubmissionsOverflow: number;
  /** Review + Incomplete + Suspicious, score descending, never truncated -- the full worklist. */
  needsAttention: SubmissionSummaryEntry[];
}

const PRIORITY_REVIEW_CAP = 5;
const TOP_SUBMISSIONS_CAP = 5;

type RequirementBucket = 'satisfied' | 'partial' | 'needsSemanticReview' | 'missing';

function bucketRequirementAssessment(requirement: Requirement | undefined, assessment: RequirementAssessment): RequirementBucket {
  if (assessment.status === 'verified') return 'satisfied';
  if (assessment.status === 'claimed') {
    // A free-form claim found nothing concrete to match against -- it is not
    // deterministically "satisfied", it needs a human's semantic read.
    if (isFreeFormClaim(requirement, assessment)) return 'needsSemanticReview';
    return requirement?.evidenceType ? 'partial' : 'satisfied';
  }
  if (assessment.status === 'partially_verified') return 'partial';
  return 'missing'; // not_found | contradicted
}

/** Ties break toward the worse bucket -- this summary must never overstate how well a
 *  requirement is typically evidenced across the submissions actually received. A
 *  free-form claim has no evidence backing it at all (unlike partial), so it ranks
 *  worse than partial but better than an outright miss. */
function modeBucket(counts: Record<RequirementBucket, number>): RequirementBucket {
  const max = Math.max(counts.missing, counts.needsSemanticReview, counts.partial, counts.satisfied);
  if (counts.missing === max) return 'missing';
  if (counts.needsSemanticReview === max) return 'needsSemanticReview';
  if (counts.partial === max) return 'partial';
  return 'satisfied';
}

/**
 * For each requirement, buckets every submission's assessment of it and takes the most
 * common (worst-tie-break) bucket. This answers "how is this requirement typically
 * evidenced across the submissions we actually received" -- not "did anyone ever satisfy
 * it" -- which is what makes a poorly-evidenced requirement visible at the summary level.
 */
export function summarizeRequirementStatus(
  requirements: Requirement[],
  assessments: SubmissionAssessment[],
): RequirementStatusSummary {
  const summary: RequirementStatusSummary = {
    total: requirements.length,
    satisfied: 0,
    partial: 0,
    needsSemanticReview: 0,
    missing: 0,
  };
  if (assessments.length === 0) return summary;

  for (const requirement of requirements) {
    const counts: Record<RequirementBucket, number> = { satisfied: 0, partial: 0, needsSemanticReview: 0, missing: 0 };
    for (const assessment of assessments) {
      const requirementAssessment = assessment.requirementAssessments.find(
        (item) => item.requirementId === requirement.id,
      );
      if (!requirementAssessment) continue;
      counts[bucketRequirementAssessment(requirement, requirementAssessment)] += 1;
    }
    summary[modeBucket(counts)] += 1;
  }

  return summary;
}

export function countClassifications(assessments: SubmissionAssessment[]): ClassificationCounts {
  const counts: ClassificationCounts = { strong: 0, review: 0, incomplete: 0, suspicious: 0 };
  for (const assessment of assessments) counts[assessment.classification] += 1;
  return counts;
}

function byScoreDesc(a: SubmissionSummaryEntry, b: SubmissionSummaryEntry): number {
  return b.assessment.score.total - a.assessment.score.total;
}

/** Urgency ranking for Priority Review -- lower sorts first. Strong never appears here. */
const PRIORITY_URGENCY_RANK: Record<SubmissionAssessment['classification'], number> = {
  suspicious: 0,
  review: 1,
  incomplete: 2,
  strong: 3,
};

function byPriorityUrgency(a: SubmissionSummaryEntry, b: SubmissionSummaryEntry): number {
  const rankDiff = PRIORITY_URGENCY_RANK[a.assessment.classification] - PRIORITY_URGENCY_RANK[b.assessment.classification];
  if (rankDiff !== 0) return rankDiff;
  return byScoreDesc(a, b);
}

/**
 * Purely a presentation-layer aggregation over already-computed assessments -- touches
 * no evaluation logic (score/classification/confidence are all read, never recomputed).
 */
export function buildReviewSummary(result: ReviewResult): ReviewSummary {
  const entries: SubmissionSummaryEntry[] = result.assessments.map((assessment, index) => ({
    displayNumber: index + 1,
    submissionId: assessment.submissionId,
    assessment,
  }));

  const priorityPool = entries
    .filter((entry) => entry.assessment.classification !== 'strong')
    .sort(byPriorityUrgency);

  const topPool = entries.filter((entry) => entry.assessment.classification === 'strong').sort(byScoreDesc);

  const needsAttention = entries.filter((entry) => entry.assessment.classification !== 'strong').sort(byScoreDesc);

  return {
    requirementStatus: summarizeRequirementStatus(result.requirements, result.assessments),
    assessedSubmissionCount: result.assessments.length,
    classificationCounts: countClassifications(result.assessments),
    entries,
    priorityReview: priorityPool.slice(0, PRIORITY_REVIEW_CAP),
    priorityReviewOverflow: Math.max(0, priorityPool.length - PRIORITY_REVIEW_CAP),
    topSubmissions: topPool.slice(0, TOP_SUBMISSIONS_CAP),
    topSubmissionsOverflow: Math.max(0, topPool.length - TOP_SUBMISSIONS_CAP),
    needsAttention,
  };
}

/**
 * Resolves a user-supplied --inspect reference: the literal submission ID first (exact
 * match -- real Gibwork submission IDs are opaque strings that could coincidentally look
 * numeric), then the stable "#N" display number shown throughout the report.
 */
export function findEntryByRef(entries: SubmissionSummaryEntry[], ref: string): SubmissionSummaryEntry | undefined {
  const byId = entries.find((entry) => entry.submissionId === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const displayNumber = Number(ref);
    return entries.find((entry) => entry.displayNumber === displayNumber);
  }
  return undefined;
}
