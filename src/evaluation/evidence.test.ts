import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRequirement, collectEvidence } from './evidence.js';
import { HtmlListRequirementExtractor } from './html-requirement-extractor.js';
import type { Evidence, Requirement, ReviewTask } from './types.js';

const FREE_FORM_REQUIREMENT: Requirement = {
  id: 'general-completion',
  description:
    'Suggest one improvement you would make to Gibwork. Clearly describe the improvement and explain why it would be useful. Keep it under 150 words.',
  required: true,
};

test('assessRequirement: free-form requirement with non-empty content -> claimed, with an honest reason', () => {
  const result = assessRequirement(FREE_FORM_REQUIREMENT, 'Add dark mode because it would make the app easier to use at night.', []);
  assert.equal(result.status, 'claimed');
  assert.equal(result.evidence.length, 0);
  // Must never repeat the old, factually-false claim that nothing was found.
  assert.doesNotMatch(result.reason, /no mention of this requirement was found/i);
  assert.match(result.reason, /free-form/i);
});

test('assessRequirement: free-form requirement with empty/whitespace content -> not_found (unchanged)', () => {
  const empty = assessRequirement(FREE_FORM_REQUIREMENT, '', []);
  assert.equal(empty.status, 'not_found');

  const whitespaceOnly = assessRequirement(FREE_FORM_REQUIREMENT, '   \n\t  ', []);
  assert.equal(whitespaceOnly.status, 'not_found');
});

test('assessRequirement: authored keyword requirement with the keyword absent still resolves to not_found', () => {
  const requirement: Requirement = {
    id: 'foo',
    description: 'Must include @example',
    required: true,
    keywords: ['@example'],
  };
  const result = assessRequirement(requirement, 'This submission does not mention the handle at all.', []);
  assert.equal(result.status, 'not_found');
});

test('assessRequirement: authored keyword requirement with the keyword present still resolves to claimed (regression)', () => {
  const requirement: Requirement = {
    id: 'foo',
    description: 'Must include @example',
    required: true,
    keywords: ['@example'],
  };
  const result = assessRequirement(requirement, 'Tagged @example in the announcement.', []);
  assert.equal(result.status, 'claimed');
});

test('assessRequirement: a requirement with evidenceType is unaffected by the free-form change', () => {
  const requirement: Requirement = {
    id: 'pr-link',
    description: 'Link the pull request',
    required: true,
    evidenceType: 'github',
  };
  const evidence: Evidence[] = [{ type: 'github', value: 'https://github.com/example-org/repo/pull/42', sourceNote: 'submission content/links' }];

  // No claim/keyword at all for this requirement -> still not_found, exactly as before.
  const noClaim = assessRequirement(requirement, 'Here is my PR.', evidence);
  assert.equal(noClaim.status, 'not_found');

  // A requirement with evidenceType and no keywords must not be treated as free-form --
  // it still requires a claim tying the evidence to this requirement specifically.
  assert.notEqual(noClaim.reason, 'Non-empty response provided to a free-form instruction; not deterministically verifiable beyond this -- see --reasoning for a semantic opinion.');
});

test('regression fixture: a live-style free-form bounty description no longer produces the false "not found" reason', () => {
  const description = `Suggest one improvement you would make to Gibwork.

Your response should:
- clearly describe the improvement
- explain why it would be useful
- be no more than 150 words

Submit: Your answer only.`;

  const task: ReviewTask = { id: 'live-style-task', title: 'Gibwork Agent Review Test', description };
  const extractor = new HtmlListRequirementExtractor();
  const [requirement] = extractor.extract(task);
  assert.ok(requirement);
  assert.equal(extractor.usedGeneralFallback, true);

  const submissionContent =
    "I'd add a way for bounty creators to preview the expected submission format before publishing. This would help creators catch unclear requirements early and reduce low-quality or irrelevant submissions.";
  const evidence = collectEvidence({ id: 'sub-1', content: submissionContent });
  const result = assessRequirement(requirement!, submissionContent, evidence);

  // The deterministic layer only ever confirms presence, never semantic quality --
  // that judgment belongs to the reasoning layer, not to this assertion.
  assert.equal(result.status, 'claimed');
  assert.doesNotMatch(result.reason, /no mention of this requirement was found/i);
});
