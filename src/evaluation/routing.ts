import type { Requirement, RequirementAssessment, SubmissionAssessment, SubmissionFlag } from './types.js';
import { allRequiredRequirementsSatisfied, isFreeFormClaim } from './classification.js';

export type RoutingTriggerKind =
  | 'evidence-relevance-uncertain'
  | 'attachment-relevance-unconfirmed'
  | 'cross-requirement-evidence-binding'
  | 'contradiction-risk'
  | 'free-form-fulfillment-uncertain';

export interface RoutingTrigger {
  kind: RoutingTriggerKind;
  requirementId?: string;
}

export interface RoutingDecision {
  needsReasoning: boolean;
  triggers: RoutingTrigger[];
}

function hasHardDisqualifier(flags: SubmissionFlag[]): boolean {
  return flags.some((flag) => flag.code === 'empty-submission' || flag.code.startsWith('duplicate'));
}

/**
 * Structural, non-semantic check: the same evidence value used as `verified`
 * evidence for two or more distinct requirements of the same evidence type. This
 * does NOT assume that's wrong -- one artifact (e.g. a single PR) can legitimately
 * satisfy multiple requirements. It only flags that the same artifact is being
 * relied upon more than once, so a semantic check of whether it actually covers
 * both may add value. Requirement IDs are deduplicated so a requirement whose
 * evidence is shared with several others is only flagged once.
 */
function findCrossRequirementEvidenceBindings(assessments: RequirementAssessment[]): RoutingTrigger[] {
  const requirementIdsByEvidenceKey = new Map<string, string[]>();

  for (const assessment of assessments) {
    if (assessment.status !== 'verified') continue;
    for (const evidence of assessment.evidence) {
      const key = `${evidence.type}::${evidence.value}`;
      const requirementIds = requirementIdsByEvidenceKey.get(key) ?? [];
      requirementIds.push(assessment.requirementId);
      requirementIdsByEvidenceKey.set(key, requirementIds);
    }
  }

  const flaggedRequirementIds = new Set<string>();
  for (const requirementIds of requirementIdsByEvidenceKey.values()) {
    if (requirementIds.length < 2) continue;
    for (const requirementId of requirementIds) flaggedRequirementIds.add(requirementId);
  }

  return [...flaggedRequirementIds].map((requirementId) => ({
    kind: 'cross-requirement-evidence-binding' as const,
    requirementId,
  }));
}

/**
 * Deterministic router -- decides WHETHER and WHY reasoning is warranted using only
 * facts the deterministic evaluator already computed. No LLM call happens here; this
 * is the cost-control gate. A submission already conclusively resolved by a hard
 * signal (empty, duplicate) is never routed -- reasoning would add cost with no
 * value, and this is checked first so duplicate-flagged submissions are hard-exited
 * before any other trigger (including cross-requirement-evidence-binding) is even
 * considered.
 */
export function routeForReasoning(
  requirements: Requirement[],
  assessment: SubmissionAssessment,
  hasAttachments: boolean,
): RoutingDecision {
  if (hasHardDisqualifier(assessment.flags)) {
    return { needsReasoning: false, triggers: [] };
  }

  const triggers: RoutingTrigger[] = [];
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));

  for (const requirementAssessment of assessment.requirementAssessments) {
    if (requirementAssessment.status === 'partially_verified') {
      // Evidence exists but its relevance/specificity to this exact requirement is unclear.
      triggers.push({ kind: 'evidence-relevance-uncertain', requirementId: requirementAssessment.requirementId });
    } else if (
      hasAttachments &&
      (requirementAssessment.status === 'verified' || requirementAssessment.status === 'claimed')
    ) {
      // An attachment (image/document) exists whose relevance to a specific requirement
      // cannot be judged deterministically, regardless of what already satisfied it.
      triggers.push({ kind: 'attachment-relevance-unconfirmed', requirementId: requirementAssessment.requirementId });
    }

    const requirement = byId.get(requirementAssessment.requirementId);
    if (requirement?.required && isFreeFormClaim(requirement, requirementAssessment)) {
      // Free-form (no keywords, no evidenceType): the deterministic layer could only ever
      // reach "claimed" here by observing non-empty content, never by confirming the
      // response actually fulfills the instruction -- that judgment belongs to reasoning.
      triggers.push({ kind: 'free-form-fulfillment-uncertain', requirementId: requirementAssessment.requirementId });
    }
  }

  triggers.push(...findCrossRequirementEvidenceBindings(assessment.requirementAssessments));

  // Only ask for contradiction reasoning when the submission otherwise appears to
  // satisfy every required requirement -- that is exactly when an undetected
  // cross-sentence contradiction would matter most, and exactly when the
  // deterministic layer itself has nothing further to flag about completeness.
  if (allRequiredRequirementsSatisfied(requirements, assessment.requirementAssessments)) {
    triggers.push({ kind: 'contradiction-risk' });
  }

  return { needsReasoning: triggers.length > 0, triggers };
}
