import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements } from './evaluation/requirements.js';
import { LocalDeterministicEvaluator } from './evaluation/evaluator.js';
import { renderReviewReport } from './evaluation/report.js';
import { loadFixture } from './fixture-loader.js';
import { printReview } from './index.js';
import type { LLMProvider, ReasoningRequest, ReasoningResult } from './evaluation/llm.js';
import type { ReviewSubmission, ReviewTask, Requirement, SubmissionAssessment } from './evaluation/types.js';
import type { ReasoningProvider } from './types.js';

/**
 * Exercises printReview() -- the shared function runFixtureReview/runLiveReview both
 * delegate to for deciding what a review run prints -- directly, using the real
 * fixtures/task.json through the real deterministic evaluator (no evaluation logic
 * mocked). fixtures/task.json's 7 submissions are known (see report.test.ts) to be 1
 * Strong / 2 Review / 2 Incomplete / 2 Suspicious, and under the mock reasoning provider
 * exactly sub-001 (#1) and sub-002 (#2) are router-flagged -- the rest are not routed at
 * all, so a provider is never even asked about them.
 */
async function buildFixtureReviewInputs(): Promise<{
  task: ReviewTask;
  submissions: ReviewSubmission[];
  requirements: Requirement[];
  assessments: SubmissionAssessment[];
}> {
  const { task, submissions } = loadFixture(new URL('../fixtures/task.json', import.meta.url).pathname);
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator(submissions);
  const assessments: SubmissionAssessment[] = [];
  for (const submission of submissions) {
    assessments.push(await evaluator.evaluate(task, submission));
  }
  return { task, submissions, requirements, assessments };
}

/** Records every submission id it was asked to reason about -- never a real network call. */
class RecordingProvider implements LLMProvider {
  calls: string[] = [];

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    this.calls.push(request.submissionId);
    return {
      submissionId: request.submissionId,
      relevance: request.relevance.map((item) => ({
        requirementId: item.requirementId,
        verdict: 'relevant',
        reasoning: 'recorded',
        confidence: 'medium',
      })),
      ambiguity: { needsReasoning: false, reason: 'n/a', confidence: 'medium' },
    };
  }
}

/** Fails the test loudly if a provider is ever constructed -- used for --reasoning-off cases. */
function providerShouldNotBeBuilt(): (kind: ReasoningProvider) => LLMProvider {
  return () => {
    throw new Error('a reasoning provider should not have been constructed when --reasoning was not requested');
  };
}

async function captureConsole(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('printReview: without --inspect, output is unchanged from the plain renderReviewReport() summary', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const expected = renderReviewReport({ task, requirements, assessments });

  const output = await captureConsole(() =>
    printReview(task, requirements, submissions, assessments, { withReasoning: false, reasoningProvider: 'mock' }, providerShouldNotBeBuilt()),
  );

  assert.equal(output, expected);
});

test('printReview: --inspect skips the full summary entirely', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();

  const output = await captureConsole(() =>
    printReview(
      task,
      requirements,
      submissions,
      assessments,
      { withReasoning: false, reasoningProvider: 'mock', inspect: '3' },
      providerShouldNotBeBuilt(),
    ),
  );

  assert.ok(!output.includes('GIBWORK SUBMISSION REVIEW'));
  assert.ok(!output.includes('Priority Review'));
  assert.ok(!output.includes('TOP SUBMISSIONS'));
  assert.ok(!output.includes('NEEDS ATTENTION'));
});

test('printReview: --inspect renders the selected submission\'s own classification, score, and requirement detail', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const target = assessments.find((item) => item.submissionId === submissions[0]!.id)!; // #1 is the fixture's Strong submission

  const output = await captureConsole(() =>
    printReview(
      task,
      requirements,
      submissions,
      assessments,
      { withReasoning: false, reasoningProvider: 'mock', inspect: '1' },
      providerShouldNotBeBuilt(),
    ),
  );

  assert.ok(output.includes('SUBMISSION #1 -- INSPECTION'));
  assert.ok(output.includes(`Submission:     ${target.submissionId}`));
  assert.ok(output.includes('Classification: Strong'));
  assert.ok(output.includes(`Score:          ${target.score.total}/100`));
  assert.ok(output.includes('Requirements:'));
});

test('printReview: --reasoning without --inspect preserves current behavior -- every router-flagged submission is reasoned about', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const provider = new RecordingProvider();

  const output = await captureConsole(() =>
    printReview(task, requirements, submissions, assessments, { withReasoning: true, reasoningProvider: 'mock' }, () => provider),
  );

  assert.ok(output.includes('=== REASONING LAYER'));
  // fixtures/task.json routes exactly sub-001 and sub-002 under the mock provider --
  // the provider must still be asked about both, not narrowed to one.
  assert.deepEqual(provider.calls.sort(), ['sub-001', 'sub-002']);
});

test('printReview: --reasoning with --inspect invokes the provider only for the inspected submission', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const provider = new RecordingProvider();
  const inspected = submissions.find((item) => item.id === 'sub-002')!; // #2, known to be router-flagged

  const output = await captureConsole(() =>
    printReview(
      task,
      requirements,
      submissions,
      assessments,
      { withReasoning: true, reasoningProvider: 'mock', inspect: '2' },
      () => provider,
    ),
  );

  assert.deepEqual(provider.calls, [inspected.id]);
  assert.ok(output.includes(`--- Submission ${inspected.id} ---`));
  for (const submission of submissions) {
    if (submission.id === inspected.id) continue;
    assert.ok(!output.includes(`--- Submission ${submission.id} ---`));
  }
});

test('printReview: --reasoning with --inspect on a submission the router does not flag calls the provider zero times', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const provider = new RecordingProvider();

  const output = await captureConsole(() =>
    printReview(
      task,
      requirements,
      submissions,
      assessments,
      { withReasoning: true, reasoningProvider: 'mock', inspect: '3' }, // sub-003 is not router-flagged
      () => provider,
    ),
  );

  assert.deepEqual(provider.calls, []);
  assert.ok(output.includes('Routed to reasoning: NO'));
});

test('printReview: reasoning is advisory only -- enabling it never changes the deterministic assessments', async () => {
  const { task, submissions, requirements, assessments } = await buildFixtureReviewInputs();
  const before = JSON.parse(JSON.stringify(assessments));
  const provider = new RecordingProvider();

  await captureConsole(() =>
    printReview(
      task,
      requirements,
      submissions,
      assessments,
      { withReasoning: true, reasoningProvider: 'mock', inspect: '2' },
      () => provider,
    ),
  );
  await captureConsole(() =>
    printReview(task, requirements, submissions, assessments, { withReasoning: true, reasoningProvider: 'mock' }, () => provider),
  );

  assert.deepEqual(assessments, before);
});
