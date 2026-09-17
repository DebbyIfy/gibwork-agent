import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements } from './requirements.js';
import { LocalDeterministicEvaluator } from './evaluator.js';
import { buildReviewSummary, findEntryByRef } from './review-summary.js';
import { renderReviewReport, renderSubmissionInspection } from './report.js';
import { applyReasoning } from './reasoning.js';
import type { LLMProvider, ReasoningRequest, ReasoningResult } from './llm.js';
import type { ReviewSubmission, ReviewTask } from './types.js';

/**
 * The real Gibwork task at the center of this fix: a single free-form instruction with
 * no structured requirements, no authored keywords, and no evidence type -- so it falls
 * back to the general-completion requirement, exactly as a live task with no
 * "Submit"/"Requirements" HTML section does. This is deliberately built the same way
 * (StructuredRequirementExtractor's fallback), not a hand-crafted shortcut.
 */
const FREE_FORM_TASK: ReviewTask = {
  id: 'ab62af5e-1f35-483a-96bf-9a094b8b1cfb',
  title: 'Gibwork Agent Review Test',
  description:
    'Suggest one improvement you would make to Gibwork.\n\n' +
    'Your response should:\n' +
    '- clearly describe the improvement\n' +
    '- explain why it would be useful\n' +
    '- be no more than 150 words\n\n' +
    'Submit: Your answer only.',
};

class FixedVerdictProvider implements LLMProvider {
  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    return {
      submissionId: request.submissionId,
      relevance: request.relevance.map((item) => ({
        requirementId: item.requirementId,
        verdict: 'relevant',
        reasoning: 'mock: looks like a real suggestion',
        confidence: 'medium',
      })),
      ambiguity: { needsReasoning: false, reason: 'n/a', confidence: 'medium' },
    };
  }
}

async function evaluateOne(content: string) {
  const requirements = extractRequirements(FREE_FORM_TASK);
  const submission: ReviewSubmission = { id: 'sub-1', content };
  const evaluator = new LocalDeterministicEvaluator([submission]);
  const assessment = await evaluator.evaluate(FREE_FORM_TASK, submission);
  return { requirements, submission, assessment };
}

test('free-form scenario: a non-empty response is "claimed", not "verified" or "not_found"', async () => {
  const { assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  assert.equal(assessment.requirementAssessments[0]?.status, 'claimed');
  assert.deepEqual(assessment.requirementAssessments[0]?.evidence, []);
  assert.match(assessment.requirementAssessments[0]?.reason ?? '', /free-form/i);
});

test('free-form scenario: a non-empty response classifies as "review", never "incomplete" and never "strong"', async () => {
  const { assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  assert.equal(assessment.classification, 'review');
});

test('free-form scenario: an empty response is "not_found" and classifies as "incomplete" (unaffected by this fix)', async () => {
  const { assessment } = await evaluateOne('');
  assert.equal(assessment.requirementAssessments[0]?.status, 'not_found');
  assert.equal(assessment.classification, 'incomplete');
  assert.ok(assessment.flags.some((flag) => flag.code === 'empty-submission'));
});

test('free-form scenario: the summary never reports this as "satisfied", and surfaces it as "needs semantic review"', async () => {
  const { requirements, assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  const summary = buildReviewSummary({ task: FREE_FORM_TASK, requirements, assessments: [assessment] });

  assert.equal(summary.requirementStatus.satisfied, 0);
  assert.equal(summary.requirementStatus.needsSemanticReview, 1);
  assert.equal(summary.requirementStatus.missing, 0);

  const output = renderReviewReport({ task: FREE_FORM_TASK, requirements, assessments: [assessment] });
  assert.ok(output.includes('1 total · 0 satisfied · 0 partial · 0 missing · 1 needs semantic review'));
  assert.ok(!output.includes('1 satisfied'));
});

test('free-form scenario: the compact report block never says "supported", and shows the semantic-review marker instead', async () => {
  const { requirements, assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  const output = renderReviewReport({ task: FREE_FORM_TASK, requirements, assessments: [assessment] });

  assert.ok(!output.includes('supported'));
  assert.ok(output.includes('needs semantic review'));
  assert.ok(output.includes('Human review recommended'));
  assert.ok(!output.includes('Required evidence is missing'));
});

test('free-form scenario: individual inspection and the summary/report agree with each other', async () => {
  const { requirements, assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  const summary = buildReviewSummary({ task: FREE_FORM_TASK, requirements, assessments: [assessment] });
  const entry = findEntryByRef(summary.entries, 'sub-1');
  assert.ok(entry);

  const reportOutput = renderReviewReport({ task: FREE_FORM_TASK, requirements, assessments: [assessment] });
  const inspectionOutput = renderSubmissionInspection(entry!, FREE_FORM_TASK, requirements);

  // Same classification, same recommended action, in both places -- no contradiction
  // between what the summary implies and what --inspect shows for the same submission.
  assert.ok(reportOutput.includes('Human review recommended'));
  assert.ok(inspectionOutput.includes('Classification: Review'));
  assert.ok(inspectionOutput.includes('Recommended next step: Human review recommended'));
  assert.ok(inspectionOutput.includes('status: claimed'));
  assert.ok(inspectionOutput.includes('evidence: none found'));
  assert.doesNotMatch(inspectionOutput, /status: verified/);
});

test('free-form scenario: reasoning is advisory only -- it never mutates the deterministic assessment', async () => {
  const { requirements, submission, assessment } = await evaluateOne(
    'Add a public API changelog so bounty hunters can see what changed without digging through commits.',
  );
  const snapshot = JSON.stringify(assessment);

  const reasoning = await applyReasoning(submission, requirements, assessment, new FixedVerdictProvider());

  assert.equal(reasoning.routed, true);
  assert.ok(reasoning.triggers.includes('free-form-fulfillment-uncertain:general-completion'));
  assert.equal(reasoning.result?.relevance[0]?.verdict, 'relevant');
  // The deterministic assessment object itself must be byte-identical after reasoning runs --
  // an advisory "relevant" opinion must never upgrade status/score/classification/confidence.
  assert.equal(JSON.stringify(assessment), snapshot);
  assert.equal(assessment.classification, 'review');
  assert.equal(assessment.requirementAssessments[0]?.status, 'claimed');
});
