import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequirements } from './evaluation/requirements.js';
import { LocalDeterministicEvaluator } from './evaluation/evaluator.js';
import { renderSubmissionInspection } from './evaluation/report.js';
import { buildReviewSummary } from './evaluation/review-summary.js';
import { loadFixture } from './fixture-loader.js';
import { runInteractiveReview, type AskFn, type InteractiveReviewDeps } from './interactive.js';
import type { LLMProvider, ReasoningRequest, ReasoningResult } from './evaluation/llm.js';
import type { ReviewSubmission, ReviewTask, Requirement, SubmissionAssessment } from './evaluation/types.js';
import type { ReasoningProvider } from './types.js';

/**
 * Exercises runInteractiveReview() directly, using the real fixtures/challenging-task.json
 * (11 submissions, the same fixture used to demo the mockup in this feature's own spec)
 * through the real deterministic evaluator -- no evaluation logic mocked. `ask` is always
 * a scripted fake (never a real TTY/readline), so every test here is fully offline and
 * deterministic.
 */
async function buildChallengingReviewInputs(): Promise<{
  task: ReviewTask;
  submissions: ReviewSubmission[];
  requirements: Requirement[];
  assessments: SubmissionAssessment[];
}> {
  const { task, submissions } = loadFixture(new URL('../fixtures/challenging-task.json', import.meta.url).pathname);
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator(submissions);
  const assessments: SubmissionAssessment[] = [];
  for (const submission of submissions) {
    assessments.push(await evaluator.evaluate(task, submission));
  }
  return { task, submissions, requirements, assessments };
}

/** Feeds answers in order; once exhausted, behaves like a closed readline interface
 *  (createReadlineAsk() resolves '' after EOF/close) -- so running out of scripted
 *  answers exercises the exact same "unwind everything cleanly" path as a real EOF. */
function scriptedAsk(answers: string[]): AskFn {
  let index = 0;
  return async () => (index < answers.length ? answers[index++]! : '');
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

/** Fails the test loudly if a provider is ever constructed -- used for no-reasoning cases. */
function providerShouldNotBeBuilt(): (kind: ReasoningProvider) => LLMProvider {
  return () => {
    throw new Error('a reasoning provider should not have been constructed');
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

async function getCandidates(): Promise<ReturnType<typeof buildReviewSummary>['needsAttention']> {
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  return buildReviewSummary({ task, requirements, assessments }).needsAttention;
}

async function run(
  answers: string[],
  deps: Partial<InteractiveReviewDeps> = {},
): Promise<{ output: string; entries: ReturnType<typeof buildReviewSummary>['needsAttention']; task: ReviewTask; requirements: Requirement[]; submissions: ReviewSubmission[]; assessments: SubmissionAssessment[] }> {
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  const entries = buildReviewSummary({ task, requirements, assessments }).needsAttention;
  const fullDeps: InteractiveReviewDeps = {
    ask: scriptedAsk(answers),
    buildProvider: providerShouldNotBeBuilt(),
    ...deps,
  };
  const output = await captureConsole(() => runInteractiveReview(task, requirements, submissions, assessments, 'mock', fullDeps));
  return { output, entries, task, requirements, submissions, assessments };
}

test('interactive: main menu -> Exit ends the session cleanly without reasoning', async () => {
  const { output } = await run(['2']);
  assert.ok(output.includes('What would you like to do?'));
  assert.ok(output.includes('1. Inspect a submission'));
  assert.ok(output.includes('2. Exit'));
  assert.ok(!output.includes('Which submission would you like to inspect?'));
});

test('interactive: main menu -> Inspect enters the submission-selection list', async () => {
  const { output } = await run(['1']); // then answers run out -> EOF -> unwinds cleanly
  assert.ok(output.includes('Which submission would you like to inspect?'));
});

test('interactive: selecting a submission renders exactly what renderSubmissionInspection() would produce', async () => {
  const { output, entries, task, requirements } = await run(['1', '1']);
  const target = entries[0]!;
  const expected = renderSubmissionInspection(target, task, requirements);

  assert.ok(output.includes(expected), 'interactive output must contain the unmodified renderSubmissionInspection() output');
  assert.ok(output.includes(`SUBMISSION #${target.displayNumber} -- INSPECTION`));
});

test('interactive: invalid submission selection is retried, then goes back without crashing', async () => {
  const { output } = await run(['1', '999', 'not-a-number', '0']); // 3 invalid attempts, then exhausted -> back to main menu -> EOF -> exit
  assert.ok(output.includes('Please enter a number between 1 and'));
  assert.ok(output.includes('Too many invalid attempts -- going back.'));
});

test('interactive: inspect -> Run AI reasoning invokes the provider exactly once for the selected submission', async () => {
  const provider = new RecordingProvider();
  const { output, entries } = await run(['1', '1', '1'], { buildProvider: () => provider }); // menu->inspect, pick #1, "Run AI reasoning"
  const target = entries[0]!;

  assert.deepEqual(provider.calls, [target.submissionId]);
  assert.ok(output.includes('=== REASONING LAYER'));
  assert.ok(output.includes(`--- Submission ${target.submissionId} ---`));
});

test('interactive: inspect -> Back to submissions never invokes the provider', async () => {
  const { output } = await run(['1', '1', '2']); // menu->inspect, pick #1, "Back to submissions"
  assert.ok(!output.includes('=== REASONING LAYER'));
});

test('interactive: "Back to submissions" returns to the selection list, not the top-level menu', async () => {
  const entries = await getCandidates();
  assert.ok(entries.length >= 2, 'fixture must have at least 2 needs-attention submissions for this test to be meaningful');

  const { output } = await run(['1', '1', '2', '2', '3']); // inspect #1, back, inspect #2 (second candidate), exit
  assert.ok(output.includes(`SUBMISSION #${entries[0]!.displayNumber} -- INSPECTION`));
  assert.ok(output.includes(`SUBMISSION #${entries[1]!.displayNumber} -- INSPECTION`));
});

test('interactive: multiple inspections in one session -- reasoning on the first never leaks onto the second', async () => {
  const provider = new RecordingProvider();
  const entries = await getCandidates();
  // Inspect #1, run reasoning, back to submissions, inspect #2, do NOT run reasoning, exit.
  await run(['1', '1', '1', '2', '2', '3', '3'], { buildProvider: () => provider });

  assert.deepEqual(provider.calls, [entries[0]!.submissionId]);
});

test('interactive: EOF on the very first prompt exits cleanly with no hang and no crash', async () => {
  const { output } = await run([]);
  assert.ok(output.includes('What would you like to do?'));
  assert.ok(!output.includes('Which submission would you like to inspect?'));
});

test('interactive: reasoning is advisory only -- running it never changes the deterministic assessments', async () => {
  const provider = new RecordingProvider();
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  const before = JSON.parse(JSON.stringify(assessments));

  await captureConsole(() =>
    runInteractiveReview(task, requirements, submissions, assessments, 'mock', { ask: scriptedAsk(['1', '1', '1', '3']), buildProvider: () => provider }),
  );

  assert.deepEqual(assessments, before);
});

test('interactive: a Priority Review submission can still be selected', async () => {
  const { output, entries } = await run(['1', '1']); // menu->inspect, pick 1st Priority Review entry
  assert.ok(output.includes(`SUBMISSION #${entries[0]!.displayNumber} -- INSPECTION`));
});

test('interactive: a Strong submission excluded from Priority Review appears under OTHER SUBMISSIONS', async () => {
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  const summary = buildReviewSummary({ task, requirements, assessments });
  const strongEntries = summary.entries.filter((entry) => entry.assessment.classification === 'strong');
  assert.ok(strongEntries.length > 0, 'fixture must contain at least one Strong submission for this test to be meaningful');

  const { output } = await run(['1']); // menu->inspect, then answers run out -> EOF -> unwinds cleanly
  assert.ok(output.includes('OTHER SUBMISSIONS'));
  for (const entry of strongEntries) {
    assert.ok(
      output.includes(`#${entry.displayNumber} — Strong — ${entry.assessment.score.total}/100`),
      `expected OTHER SUBMISSIONS to list Strong submission #${entry.displayNumber}`,
    );
  }
});

test('interactive: selecting a Strong submission under OTHER SUBMISSIONS opens its normal inspection', async () => {
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  const summary = buildReviewSummary({ task, requirements, assessments });
  const priorityCount = summary.needsAttention.length;
  const strongEntry = summary.entries.find((entry) => entry.assessment.classification === 'strong')!;
  const expected = renderSubmissionInspection(strongEntry, task, requirements);

  const output = await captureConsole(() =>
    runInteractiveReview(task, requirements, submissions, assessments, 'mock', {
      ask: scriptedAsk(['1', String(priorityCount + 1)]), // menu->inspect, pick the first OTHER SUBMISSIONS entry
      buildProvider: providerShouldNotBeBuilt(),
    }),
  );

  assert.ok(output.includes(expected), 'interactive output must contain the unmodified renderSubmissionInspection() output');
  assert.ok(output.includes(`SUBMISSION #${strongEntry.displayNumber} -- INSPECTION`));
});

test('interactive: no submission appears in both Priority Review and OTHER SUBMISSIONS', async () => {
  const { task, requirements, assessments } = await buildChallengingReviewInputs();
  const summary = buildReviewSummary({ task, requirements, assessments });

  const { output } = await run(['1']); // menu->inspect, then answers run out -> EOF -> unwinds cleanly

  // Every printed "N. #M — ..." menu line references a distinct submission display number.
  const referencedDisplayNumbers = [...output.matchAll(/^\s*\d+\. #(\d+) —/gm)].map((match) => Number(match[1]));
  assert.equal(referencedDisplayNumbers.length, summary.entries.length, 'every submission should appear exactly once across both sections');
  assert.equal(new Set(referencedDisplayNumbers).size, referencedDisplayNumbers.length, 'no display number should be listed twice');
});

test('interactive: existing Back/Exit navigation still works alongside the new OTHER SUBMISSIONS section', async () => {
  const { task, submissions, requirements, assessments } = await buildChallengingReviewInputs();
  const summary = buildReviewSummary({ task, requirements, assessments });
  const priorityCount = summary.needsAttention.length;
  const strongEntry = summary.entries.find((entry) => entry.assessment.classification === 'strong')!;

  const output = await captureConsole(() =>
    runInteractiveReview(task, requirements, submissions, assessments, 'mock', {
      // menu->inspect, pick the Strong entry, Back to submissions, Exit from submission list, Exit main menu
      ask: scriptedAsk(['1', String(priorityCount + 1), '2', '2', '2']),
      buildProvider: providerShouldNotBeBuilt(),
    }),
  );

  assert.ok(output.includes(`SUBMISSION #${strongEntry.displayNumber} -- INSPECTION`));
  assert.ok(output.includes('Which submission would you like to inspect?'));
});

test('interactive: uses the existing report/reasoning renderers rather than a reimplementation', async () => {
  // Covered structurally: this module imports renderSubmissionInspection, renderReasoningSummary,
  // applyReasoning, and buildReviewSummary from the existing evaluation/report modules and
  // calls them directly (see src/interactive.ts) -- never redefines requirement/evidence/score
  // formatting. The byte-for-byte match asserted above (inspection output equals
  // renderSubmissionInspection()'s own output) is the behavioral proof of that reuse.
  const { output, entries } = await run(['1', '1'], {});
  assert.ok(output.includes(`Recommended next step:`)); // a line only renderSubmissionInspection() produces
  assert.ok(entries.length > 0);
});
