import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isFreeFormClaim, isRequirementFullySatisfied, allRequiredRequirementsSatisfied } from './classification.js';
import type { Requirement, RequirementAssessment, ScoreBreakdown } from './types.js';

const FREE_FORM_REQUIREMENT: Requirement = {
  id: 'general-completion',
  description: 'Suggest one improvement you would make to Gibwork.',
  required: true,
};

function requirementAssessment(requirementId: string, status: RequirementAssessment['status']): RequirementAssessment {
  return { requirementId, status, evidence: [], reason: 'test' };
}

function score(total: number): ScoreBreakdown {
  return { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total };
}

test('isRequirementFullySatisfied: claimed with no evidenceType is treated as fully satisfied (the free-form ceiling)', () => {
  const assessment = requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed');
  assert.equal(isRequirementFullySatisfied(FREE_FORM_REQUIREMENT, assessment), true);
});

test('isRequirementFullySatisfied: not_found is never fully satisfied, free-form or not', () => {
  const assessment = requirementAssessment(FREE_FORM_REQUIREMENT.id, 'not_found');
  assert.equal(isRequirementFullySatisfied(FREE_FORM_REQUIREMENT, assessment), false);
});

test('isRequirementFullySatisfied: claimed WITH an evidenceType is not fully satisfied by a claim alone (unchanged)', () => {
  const requirement: Requirement = { id: 'pr-link', description: 'Link the PR', required: true, evidenceType: 'github' };
  const assessment = requirementAssessment('pr-link', 'claimed');
  assert.equal(isRequirementFullySatisfied(requirement, assessment), false);
});

test('allRequiredRequirementsSatisfied: a single required free-form requirement at claimed satisfies the whole set', () => {
  const satisfied = allRequiredRequirementsSatisfied(
    [FREE_FORM_REQUIREMENT],
    [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed')],
  );
  assert.equal(satisfied, true);
});

test('isFreeFormClaim: true for claimed, no evidenceType, no keywords -- the real Gibwork free-form scenario', () => {
  const assessment = requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed');
  assert.equal(isFreeFormClaim(FREE_FORM_REQUIREMENT, assessment), true);
});

test('isFreeFormClaim: false when the requirement has authored keywords (a real match was found)', () => {
  const requirement: Requirement = { ...FREE_FORM_REQUIREMENT, keywords: ['dark mode'] };
  const assessment = requirementAssessment(requirement.id, 'claimed');
  assert.equal(isFreeFormClaim(requirement, assessment), false);
});

test('isFreeFormClaim: false when the requirement has an evidenceType (a different unverified-claim case)', () => {
  const requirement: Requirement = { ...FREE_FORM_REQUIREMENT, evidenceType: 'github' };
  const assessment = requirementAssessment(requirement.id, 'claimed');
  assert.equal(isFreeFormClaim(requirement, assessment), false);
});

test('isFreeFormClaim: false for any non-"claimed" status', () => {
  for (const status of ['verified', 'partially_verified', 'not_found', 'contradicted'] as const) {
    assert.equal(isFreeFormClaim(FREE_FORM_REQUIREMENT, requirementAssessment(FREE_FORM_REQUIREMENT.id, status)), false);
  }
});

test('classify: a required free-form claim is never "strong", even at a top score', () => {
  const result = classify([FREE_FORM_REQUIREMENT], [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed')], [], score(95));
  assert.equal(result, 'review');
});

test('classify: a required free-form claim is never "incomplete" merely because the overall score is mediocre', () => {
  const result = classify([FREE_FORM_REQUIREMENT], [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed')], [], score(58));
  assert.equal(result, 'review');
});

test('classify: a required free-form claim is "review" even at the lowest non-empty score', () => {
  const result = classify([FREE_FORM_REQUIREMENT], [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'claimed')], [], score(0));
  assert.equal(result, 'review');
});

test('classify: an empty free-form submission is still "incomplete" (unaffected by this fix)', () => {
  const flags = [{ code: 'empty-submission', severity: 'warning' as const, message: 'Submission content is empty.' }];
  const result = classify([FREE_FORM_REQUIREMENT], [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'not_found')], flags, score(0));
  assert.equal(result, 'incomplete');
});

test('classify: a keyword-matched claim (not free-form) can still reach "strong" at a top score (unaffected by this fix)', () => {
  const requirement: Requirement = { ...FREE_FORM_REQUIREMENT, keywords: ['dark mode'] };
  const result = classify([requirement], [requirementAssessment(requirement.id, 'claimed')], [], score(95));
  assert.equal(result, 'strong');
});

test('classify: a required requirement with no evidence at all is still "incomplete" (unaffected by this fix)', () => {
  const result = classify([FREE_FORM_REQUIREMENT], [requirementAssessment(FREE_FORM_REQUIREMENT.id, 'not_found')], [], score(30));
  assert.equal(result, 'incomplete');
});
