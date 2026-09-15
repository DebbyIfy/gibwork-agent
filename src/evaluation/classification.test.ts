import test from 'node:test';
import assert from 'node:assert/strict';
import { isRequirementFullySatisfied, allRequiredRequirementsSatisfied } from './classification.js';
import type { Requirement, RequirementAssessment } from './types.js';

const FREE_FORM_REQUIREMENT: Requirement = {
  id: 'general-completion',
  description: 'Suggest one improvement you would make to Gibwork.',
  required: true,
};

function requirementAssessment(requirementId: string, status: RequirementAssessment['status']): RequirementAssessment {
  return { requirementId, status, evidence: [], reason: 'test' };
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
