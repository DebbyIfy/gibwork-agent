import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements } from './requirements.js';
import { LocalDeterministicEvaluator } from './evaluator.js';
import { renderReviewReport, renderSubmissionInspection } from './report.js';
import { buildReviewSummary, findEntryByRef } from './review-summary.js';
import { loadFixture } from '../fixture-loader.js';
import type { ReviewResult, SubmissionAssessment } from './types.js';

/**
 * Uses the real fixtures/task.json + fixtures/submissions.json through the real
 * deterministic evaluator (no mocking of evaluation logic) -- these tests only ever
 * assert on how the result is *presented*, never on the evaluation logic itself.
 * fixtures/task.json is known to produce one submission of each classification
 * (strong, review x2, incomplete x2, suspicious x2), which is exactly what's needed to
 * exercise every section of the new report.
 */
async function buildMainFixtureResult(): Promise<ReviewResult> {
  const { task, submissions } = loadFixture(new URL('../../fixtures/task.json', import.meta.url).pathname);
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator(submissions);
  const assessments: SubmissionAssessment[] = [];
  for (const submission of submissions) {
    assessments.push(await evaluator.evaluate(task, submission));
  }
  return { task, requirements, assessments };
}

test('renderReviewReport: summary appears before any per-submission detail (summary-first)', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);

  const bountyIndex = output.indexOf('Bounty');
  const requirementsIndex = output.indexOf('Requirements');
  const submissionsIndex = output.indexOf('Submissions');
  const priorityIndex = output.indexOf('Priority Review');
  const topIndex = output.indexOf('TOP SUBMISSIONS');
  const needsAttentionIndex = output.indexOf('NEEDS ATTENTION');

  assert.ok(bountyIndex < requirementsIndex);
  assert.ok(requirementsIndex < submissionsIndex);
  assert.ok(submissionsIndex < priorityIndex);
  assert.ok(priorityIndex < topIndex);
  assert.ok(topIndex < needsAttentionIndex);
});

test('renderReviewReport: executive summary reports bounty title, requirement status, and all four classification counts', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);

  assert.ok(output.includes('Add a working contact form to the marketing site'));
  assert.ok(output.includes('4 total · 3 satisfied · 0 partial · 1 missing'));
  assert.ok(output.includes('7 total'));
  assert.match(output, /STRONG\s+1/);
  assert.match(output, /REVIEW\s+2/);
  assert.match(output, /INCOMPLETE\s+2/);
  assert.match(output, /SUSPICIOUS\s+2/);
});

test('renderReviewReport: Priority Review groups Suspicious, then Review, then Incomplete, score descending within each group', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);
  const priorityBlock = output.slice(output.indexOf('Priority Review'), output.indexOf('TOP SUBMISSIONS'));

  // Fixture scores: sub-006/sub-007 (Suspicious, 56/56, stable original order), sub-002/sub-003
  // (Review, 62/37), sub-004/sub-005 (Incomplete, 75/0). Urgency group order beats score --
  // sub-004 (Incomplete, 75) must still sort after every Suspicious/Review entry.
  // Cap is 5, so the lowest-urgency/lowest-score entry (sub-005, Incomplete, 0) overflows.
  const order = ['#6', '#7', '#2', '#3', '#4'].map((label) => priorityBlock.indexOf(label));
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1]! >= 0 && order[i]! >= 0 && order[i - 1]! < order[i]!, `expected ${order} to be strictly increasing`);
  }
  // Strong (#1) never belongs in Priority Review; sub-005 (#5) overflowed out of the capped list.
  assert.ok(!priorityBlock.includes('#1 '));
  assert.ok(!priorityBlock.includes('#5 '));
  assert.ok(priorityBlock.includes('more in Suspicious/Review/Incomplete'));
});

test('renderReviewReport: never uses "approve"/"reject" as an instruction, only as the fixed safety disclaimer', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);

  const actionLines = output.split('\n').filter((line) => line.trim().startsWith('→'));
  assert.ok(actionLines.length > 0, 'expected at least one call-to-action line');
  for (const line of actionLines) {
    assert.doesNotMatch(line.toLowerCase(), /approve|reject/);
  }

  // The only place "approve"/"reject" may appear is the fixed human-in-the-loop disclaimer.
  assert.ok(output.includes('No submissions were approved or rejected.'));
  assert.ok(output.includes('Human review required.'));
  assert.doesNotMatch(output.toLowerCase(), /fraud|plagiari/);
});

test('renderReviewReport: uses exactly the four documented calls-to-action, one per classification', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);

  assert.ok(output.includes('No immediate concerns')); // strong
  assert.ok(output.includes('Human review recommended')); // review
  assert.ok(output.includes('Required evidence is missing')); // incomplete
  assert.ok(output.includes('Requires manual verification')); // suspicious
});

test('renderReviewReport: zero submissions renders gracefully with no crash and no misleading counts', () => {
  const result: ReviewResult = {
    task: { id: 'empty-task', title: 'A bounty with no submissions yet', description: '' },
    requirements: [{ id: 'r1', description: 'Do the thing.', required: true }],
    assessments: [],
  };
  const output = renderReviewReport(result);

  assert.ok(output.includes('A bounty with no submissions yet'));
  assert.ok(output.includes('0 total'));
  assert.match(output, /STRONG\s+0/);
  assert.match(output, /REVIEW\s+0/);
  assert.match(output, /INCOMPLETE\s+0/);
  assert.match(output, /SUSPICIOUS\s+0/);
  assert.ok(output.includes('No submissions have been received for this bounty yet.'));
  assert.ok(!output.includes('TOP SUBMISSIONS'));
  assert.ok(!output.includes('NEEDS ATTENTION'));
  // The safety disclaimer must still hold even when there is nothing to review.
  assert.ok(output.includes('No submissions were approved or rejected.'));
});

test('renderReviewReport: compact default output never dumps every requirement for every submission', async () => {
  const result = await buildMainFixtureResult();
  const output = renderReviewReport(result);

  // The full per-requirement evidence dump (evidence URLs, "reason:" lines) only belongs
  // in --inspect output, never in the default compact report.
  assert.ok(!output.includes('reason:'));
  assert.ok(!output.includes('expected evidence type:'));
});

test('renderSubmissionInspection: shows score, classification, confidence, per-requirement evidence, and flags -- without leaking chain-of-thought', async () => {
  const result = await buildMainFixtureResult();
  const summary = buildReviewSummary(result);
  const entry = findEntryByRef(summary.entries, 'sub-006');
  assert.ok(entry);

  const output = renderSubmissionInspection(entry!, result.task, result.requirements);

  assert.ok(output.includes('SUBMISSION #6 -- INSPECTION'));
  assert.ok(output.includes('Classification: Suspicious'));
  assert.ok(output.includes('Confidence:     MEDIUM'));
  assert.match(output, /Score:\s+56\/100/);
  assert.ok(output.includes('status: verified'));
  assert.ok(output.includes('expected evidence type: github'));
  assert.ok(output.includes('[github] https://github.com/example-org/site-contact-form/pull/99'));
  assert.ok(output.includes('Signals (quality / suspicious / duplicate):'));
  assert.ok(output.includes('Potential duplicate'));
  assert.ok(output.includes('Evidence and prioritization only -- no approve/reject/refund/pay action was taken.'));
  // Conservative wording: never an outright fraud/plagiarism accusation.
  assert.doesNotMatch(output.toLowerCase(), /fraud|plagiari/);
});

test('renderSubmissionInspection: a requirement with no evidence is shown as "none found", not fabricated', async () => {
  const result = await buildMainFixtureResult();
  const summary = buildReviewSummary(result);
  const entry = findEntryByRef(summary.entries, 'sub-005'); // the empty submission
  assert.ok(entry);

  const output = renderSubmissionInspection(entry!, result.task, result.requirements);
  assert.ok(output.includes('evidence: none found'));
  assert.ok(output.includes('Submission content is empty.'));
});

test('findEntryByRef resolves --inspect by the report\'s "#N" display number', async () => {
  const result = await buildMainFixtureResult();
  const summary = buildReviewSummary(result);
  const byNumber = findEntryByRef(summary.entries, '6');
  assert.equal(byNumber?.submissionId, 'sub-006');
});
