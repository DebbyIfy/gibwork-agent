import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewSummary, countClassifications, findEntryByRef, summarizeRequirementStatus } from './review-summary.js';
import type { Requirement, RequirementAssessment, SubmissionAssessment, SubmissionClassification } from './types.js';

function requirementAssessment(requirementId: string, status: RequirementAssessment['status']): RequirementAssessment {
  return { requirementId, status, evidence: [], reason: 'test' };
}

function assessment(
  submissionId: string,
  classification: SubmissionClassification,
  score: number,
  requirementAssessments: RequirementAssessment[] = [],
): SubmissionAssessment {
  return {
    submissionId,
    classification,
    confidence: 'medium',
    score: { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: score },
    requirementAssessments,
    flags: [],
    reasons: [],
  };
}

test('summarizeRequirementStatus: no submissions -> everything zero, not claimed as missing', () => {
  const requirements: Requirement[] = [{ id: 'r1', description: 'd', required: true }];
  const summary = summarizeRequirementStatus(requirements, []);
  assert.deepEqual(summary, { total: 1, satisfied: 0, partial: 0, needsSemanticReview: 0, missing: 0 });
});

test('summarizeRequirementStatus: a free-form claim (no evidenceType, no keywords) is its own bucket, never "satisfied"', () => {
  const requirements: Requirement[] = [{ id: 'r1', description: 'no-evidence-type req', required: true }];
  const assessments = [
    assessment('s1', 'review', 70, [requirementAssessment('r1', 'claimed')]),
    assessment('s2', 'review', 60, [requirementAssessment('r1', 'claimed')]),
    assessment('s3', 'incomplete', 10, [requirementAssessment('r1', 'not_found')]),
  ];
  const summary = summarizeRequirementStatus(requirements, assessments);
  // claimed with no evidenceType and no keywords is a free-form claim -- deterministically
  // unverifiable, so this one requirement's mode bucket is needsSemanticReview (2 claimed
  // vs 1 not_found), never "satisfied".
  assert.equal(summary.needsSemanticReview, 1);
  assert.equal(summary.satisfied, 0);
  assert.equal(summary.missing, 0);
});

test('summarizeRequirementStatus: a keyword-matched claim (no evidenceType, but has keywords) is still "satisfied"', () => {
  const requirements: Requirement[] = [{ id: 'r1', description: 'keyword req', required: true, keywords: ['docs'] }];
  const assessments = [assessment('s1', 'review', 70, [requirementAssessment('r1', 'claimed')])];
  const summary = summarizeRequirementStatus(requirements, assessments);
  // A keyword match found something concrete -- unlike a bare free-form claim, this
  // legitimately reaches the deterministic "satisfied" ceiling, unchanged by this fix.
  assert.equal(summary.satisfied, 1);
  assert.equal(summary.needsSemanticReview, 0);
});

test('summarizeRequirementStatus: a claim against a requirement WITH an evidence type is only "partial"', () => {
  const requirements: Requirement[] = [{ id: 'r1', description: 'needs evidence', required: true, evidenceType: 'github' }];
  const assessments = [assessment('s1', 'review', 60, [requirementAssessment('r1', 'claimed')])];
  const summary = summarizeRequirementStatus(requirements, assessments);
  assert.equal(summary.partial, 1);
  assert.equal(summary.satisfied, 0);
});

test('summarizeRequirementStatus: ties break toward the worse bucket (never overstates evidence quality)', () => {
  const requirements: Requirement[] = [{ id: 'r1', description: 'd', required: true, evidenceType: 'github' }];
  // 2 verified (satisfied) vs 2 partially_verified (partial) -> tie -> must resolve to "partial", not "satisfied".
  const tie = summarizeRequirementStatus(requirements, [
    assessment('s1', 'strong', 90, [requirementAssessment('r1', 'verified')]),
    assessment('s2', 'strong', 90, [requirementAssessment('r1', 'verified')]),
    assessment('s3', 'review', 60, [requirementAssessment('r1', 'partially_verified')]),
    assessment('s4', 'review', 60, [requirementAssessment('r1', 'partially_verified')]),
  ]);
  assert.equal(tie.partial, 1);
  assert.equal(tie.satisfied, 0);

  // A genuine 3-way tie (1 satisfied / 1 partial / 1 missing) must resolve to "missing".
  const threeWay = summarizeRequirementStatus(requirements, [
    assessment('s1', 'strong', 90, [requirementAssessment('r1', 'verified')]),
    assessment('s2', 'review', 60, [requirementAssessment('r1', 'partially_verified')]),
    assessment('s3', 'incomplete', 10, [requirementAssessment('r1', 'not_found')]),
  ]);
  assert.equal(threeWay.missing, 1);
});

test('countClassifications counts all four buckets, including zero for absent ones', () => {
  const counts = countClassifications([
    assessment('s1', 'strong', 90),
    assessment('s2', 'strong', 95),
    assessment('s3', 'review', 60),
  ]);
  assert.deepEqual(counts, { strong: 2, review: 1, incomplete: 0, suspicious: 0 });
});

test('buildReviewSummary assigns stable display numbers in original submission order', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [assessment('s1', 'strong', 90), assessment('s2', 'review', 60), assessment('s3', 'suspicious', 50)],
  });
  assert.deepEqual(
    summary.entries.map((entry) => [entry.displayNumber, entry.submissionId]),
    [
      [1, 's1'],
      [2, 's2'],
      [3, 's3'],
    ],
  );
});

test('buildReviewSummary: priorityReview includes Suspicious+Review+Incomplete, ordered by urgency then score descending', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [
      assessment('strong-1', 'strong', 99),
      assessment('review-low', 'review', 40),
      assessment('suspicious-hi', 'suspicious', 70),
      assessment('review-hi', 'review', 80),
      assessment('incomplete-hi', 'incomplete', 90),
      assessment('incomplete-low', 'incomplete', 20),
    ],
  });
  // Urgency group order is Suspicious, then Review, then Incomplete -- regardless of score --
  // and score descending only breaks ties within the same classification.
  assert.deepEqual(
    summary.priorityReview.map((entry) => entry.submissionId),
    ['suspicious-hi', 'review-hi', 'review-low', 'incomplete-hi', 'incomplete-low'],
  );
  // Strong must never appear in Priority Review.
  assert.ok(!summary.priorityReview.some((entry) => entry.submissionId === 'strong-1'));
});

test('buildReviewSummary: priorityReview and topSubmissions are capped with an accurate overflow count', () => {
  const reviewAssessments = Array.from({ length: 8 }, (_, index) => assessment(`review-${index}`, 'review', 50 + index));
  const strongAssessments = Array.from({ length: 7 }, (_, index) => assessment(`strong-${index}`, 'strong', 80 + index));

  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [...reviewAssessments, ...strongAssessments],
  });

  assert.equal(summary.priorityReview.length, 5);
  assert.equal(summary.priorityReviewOverflow, 3);
  assert.equal(summary.topSubmissions.length, 5);
  assert.equal(summary.topSubmissionsOverflow, 2);
  // Capped lists keep the highest scores (all same classification here, so pure score order).
  assert.equal(summary.priorityReview[0]?.submissionId, 'review-7');
  assert.equal(summary.topSubmissions[0]?.submissionId, 'strong-6');
});

test('buildReviewSummary: priorityReview orders Suspicious before Review before Incomplete even when scores favor the opposite', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [
      // Deliberately scored so a pure score-descending sort would put Incomplete first --
      // urgency-by-classification must still win.
      assessment('incomplete-1', 'incomplete', 95),
      assessment('review-1', 'review', 50),
      assessment('suspicious-1', 'suspicious', 5),
    ],
  });
  assert.deepEqual(
    summary.priorityReview.map((entry) => entry.submissionId),
    ['suspicious-1', 'review-1', 'incomplete-1'],
  );
});

test('buildReviewSummary: needsAttention includes everything except Strong, never truncated', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [
      assessment('strong-1', 'strong', 99),
      assessment('review-1', 'review', 60),
      assessment('incomplete-1', 'incomplete', 30),
      assessment('suspicious-1', 'suspicious', 50),
    ],
  });
  assert.deepEqual(
    summary.needsAttention.map((entry) => entry.submissionId).sort(),
    ['incomplete-1', 'review-1', 'suspicious-1'],
  );
});

test('buildReviewSummary: zero submissions produces empty pools without throwing', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [{ id: 'r1', description: 'd', required: true }],
    assessments: [],
  });
  assert.equal(summary.assessedSubmissionCount, 0);
  assert.deepEqual(summary.entries, []);
  assert.deepEqual(summary.priorityReview, []);
  assert.deepEqual(summary.topSubmissions, []);
  assert.deepEqual(summary.needsAttention, []);
  assert.deepEqual(summary.classificationCounts, { strong: 0, review: 0, incomplete: 0, suspicious: 0 });
});

test('findEntryByRef: matches the literal submission ID even when it looks numeric', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    // "3" is deliberately used both as a literal ID (on a submission whose display
    // number is 4) and would also parse as display number 3 (submission "c").
    assessments: [assessment('a', 'strong', 90), assessment('b', 'strong', 90), assessment('c', 'strong', 90), assessment('3', 'strong', 90)],
  });

  const byLiteralId = findEntryByRef(summary.entries, '3');
  assert.equal(byLiteralId?.submissionId, '3');
  assert.equal(byLiteralId?.displayNumber, 4);
});

test('findEntryByRef: falls back to the "#N" display number when no literal ID matches', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [assessment('sub-abc', 'strong', 90), assessment('sub-def', 'review', 60)],
  });

  const bySecondPosition = findEntryByRef(summary.entries, '2');
  assert.equal(bySecondPosition?.submissionId, 'sub-def');
});

test('findEntryByRef: returns undefined for an unknown reference instead of throwing', () => {
  const summary = buildReviewSummary({
    task: { id: 't', title: 'Task', description: '' },
    requirements: [],
    assessments: [assessment('sub-abc', 'strong', 90)],
  });
  assert.equal(findEntryByRef(summary.entries, 'does-not-exist'), undefined);
  assert.equal(findEntryByRef(summary.entries, '99'), undefined);
});
