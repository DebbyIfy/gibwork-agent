import type { ReviewSubmission, ReviewTask, SubmissionAssessment } from './types.js';
import { extractRequirements } from './requirements.js';
import { runPreChecks } from './precheck.js';
import { assessRequirement, collectEvidence } from './evidence.js';
import { computeScore } from './scoring.js';
import { classify, computeConfidence } from './classification.js';

/**
 * Replaceable evaluation boundary. A future LLM-backed evaluator implements the
 * exact same interface; today only the deterministic implementation exists.
 */
export interface SubmissionEvaluator {
  evaluate(task: ReviewTask, submission: ReviewSubmission): Promise<SubmissionAssessment>;
}

function buildReasons(
  assessment: Pick<SubmissionAssessment, 'requirementAssessments' | 'flags' | 'classification'>,
): string[] {
  const reasons: string[] = [];

  for (const flag of assessment.flags) {
    reasons.push(flag.message);
  }
  for (const requirementAssessment of assessment.requirementAssessments) {
    if (requirementAssessment.status === 'not_found' || requirementAssessment.status === 'contradicted') {
      reasons.push(`${requirementAssessment.requirementId}: ${requirementAssessment.reason}`);
    }
  }
  if (reasons.length === 0) {
    reasons.push('No issues were found by deterministic checks.');
  }
  return reasons;
}

/**
 * Deterministic, offline, LLM-free evaluator. Takes the full submission batch up
 * front (constructor) so per-submission evaluate() calls can still see sibling
 * submissions for duplicate detection, while keeping the evaluate() signature
 * itself limited to a single (task, submission) pair.
 */
export class LocalDeterministicEvaluator implements SubmissionEvaluator {
  constructor(private readonly allSubmissions: ReviewSubmission[] = []) {}

  async evaluate(task: ReviewTask, submission: ReviewSubmission): Promise<SubmissionAssessment> {
    const requirements = extractRequirements(task);
    const flags = runPreChecks(submission, this.allSubmissions);
    const evidence = collectEvidence(submission);
    const requirementAssessments = requirements.map((requirement) =>
      assessRequirement(requirement, submission.content ?? '', evidence),
    );
    const score = computeScore(requirements, requirementAssessments, flags, (submission.content ?? '').trim().length);
    const classification = classify(requirements, requirementAssessments, flags, score);
    const confidence = computeConfidence(requirementAssessments, flags);
    const reasons = buildReasons({ requirementAssessments, flags, classification });

    return {
      submissionId: submission.id,
      classification,
      confidence,
      score,
      requirementAssessments,
      flags,
      reasons,
    };
  }
}
