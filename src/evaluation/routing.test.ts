import test from 'node:test';
import assert from 'node:assert/strict';
import { routeForReasoning } from './routing.js';
import type { Requirement, RequirementAssessment, SubmissionAssessment, SubmissionFlag } from './types.js';

const FREE_FORM_REQUIRED: Requirement = {
  id: 'general-completion',
  description: 'Suggest one improvement you would make to Gibwork.',
  required: true,
};

const FREE_FORM_OPTIONAL: Requirement = {
  id: 'general-completion',
  description: 'Suggest one improvement you would make to Gibwork.',
  required: false,
};

const KEYWORD_REQUIREMENT: Requirement = {
  id: 'foo',
  description: 'Must include @example',
  required: true,
  keywords: ['@example'],
};

function requirementAssessment(requirementId: string, status: RequirementAssessment['status']): RequirementAssessment {
  return { requirementId, status, evidence: [], reason: 'test' };
}

function buildAssessment(requirementAssessments: RequirementAssessment[], flags: SubmissionFlag[] = []): SubmissionAssessment {
  return {
    submissionId: 'sub-1',
    classification: 'incomplete',
    confidence: 'medium',
    score: { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: 0 },
    requirementAssessments,
    flags,
    reasons: [],
  };
}

test('routeForReasoning: required free-form requirement at claimed triggers free-form-fulfillment-uncertain', () => {
  const assessment = buildAssessment([requirementAssessment('general-completion', 'claimed')]);
  const decision = routeForReasoning([FREE_FORM_REQUIRED], assessment, false);

  assert.ok(decision.triggers.some((trigger) => trigger.kind === 'free-form-fulfillment-uncertain' && trigger.requirementId === 'general-completion'));
});

test('routeForReasoning: required free-form requirement at claimed sets needsReasoning to true', () => {
  const assessment = buildAssessment([requirementAssessment('general-completion', 'claimed')]);
  const decision = routeForReasoning([FREE_FORM_REQUIRED], assessment, false);

  assert.equal(decision.needsReasoning, true);
});

test('routeForReasoning: a non-required free-form requirement at claimed does not trigger free-form-fulfillment-uncertain', () => {
  const assessment = buildAssessment([requirementAssessment('general-completion', 'claimed')]);
  const decision = routeForReasoning([FREE_FORM_OPTIONAL], assessment, false);

  assert.ok(!decision.triggers.some((trigger) => trigger.kind === 'free-form-fulfillment-uncertain'));
});

test('routeForReasoning: an authored keyword requirement at claimed does not trigger free-form-fulfillment-uncertain', () => {
  const assessment = buildAssessment([requirementAssessment('foo', 'claimed')]);
  const decision = routeForReasoning([KEYWORD_REQUIREMENT], assessment, false);

  assert.ok(!decision.triggers.some((trigger) => trigger.kind === 'free-form-fulfillment-uncertain'));
  // A claimed status with no evidenceType is already the deterministic "fully satisfied"
  // ceiling (classification.ts), so the pre-existing contradiction-risk trigger fires here
  // regardless -- that is unrelated, unchanged behavior, not something this change affects.
  assert.deepEqual(
    decision.triggers.map((trigger) => trigger.kind),
    ['contradiction-risk'],
  );
});

test('routeForReasoning: existing hard-disqualifier behavior (empty submission) still short-circuits every trigger, including the new one', () => {
  const assessment = buildAssessment(
    [requirementAssessment('general-completion', 'not_found')],
    [{ code: 'empty-submission', severity: 'warning', message: 'Submission content is empty.' }],
  );
  const decision = routeForReasoning([FREE_FORM_REQUIRED], assessment, false);

  assert.deepEqual(decision, { needsReasoning: false, triggers: [] });
});
