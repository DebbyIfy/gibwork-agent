#!/usr/bin/env node
import type { AvailableTasksQuery, GibworkClient, SubmissionPaginationQuery, SubmissionStatus, TaskDetails } from '@gibwork/sdk';
import { parseCli } from './cli.js';
import { buildGibworkClient, listSubmissions, getSubmissionDetail, listAvailableTasks, getTask } from './gibwork.js';
import { renderSubmissionDetail, renderAvailableTasksList } from './present.js';
import { loadFixture } from './fixture-loader.js';
import { extractRequirements } from './evaluation/requirements.js';
import { LocalDeterministicEvaluator } from './evaluation/evaluator.js';
import { collectEvidence } from './evaluation/evidence.js';
import { renderReviewReport, renderReasoningSummary, renderSubmissionInspection } from './evaluation/report.js';
import { buildReviewSummary, findEntryByRef } from './evaluation/review-summary.js';
import { applyReasoning, type SubmissionReasoning } from './evaluation/reasoning.js';
import { FixtureMockLLMProvider } from './evaluation/mock-llm-provider.js';
import { AnthropicLLMProvider, DEFAULT_MODEL } from './evaluation/real-llm-provider.js';
import type { LLMProvider } from './evaluation/llm.js';
import { GithubEvidenceAdapter, findInspectablePullRequestEvidence } from './evidence/github.js';
import { renderGithubEvidenceSection, type GithubEvidenceOutcome } from './evidence/report.js';
import { toReviewSubmission, toReviewTask } from './evaluation/gibwork-adapter.js';
import { HtmlListRequirementExtractor, MAX_EXTRACTED_REQUIREMENTS } from './evaluation/html-requirement-extractor.js';
import type { ReasoningProvider } from './types.js';
import type { Requirement, ReviewSubmission, ReviewTask, SubmissionAssessment } from './evaluation/types.js';

/**
 * Only ever describes what actually happened for THIS run (fallback vs. truncation vs.
 * a normal heuristic extraction) -- never claims a fixed, universal limitation, since
 * that's no longer true now that a real criteria/deliverable section is extracted.
 */
function buildRequirementsNotice(extractor: HtmlListRequirementExtractor): string {
  if (extractor.usedGeneralFallback) {
    return (
      'No recognizable criteria/deliverable list (e.g. "Submit"/"Requirements"/"Rules" headings) was found in ' +
      "this task's description, so it is evaluated against a single general-completion requirement rather than " +
      'itemized criteria.'
    );
  }
  const truncationNote = extractor.wasTruncated
    ? ` Extraction was capped at ${MAX_EXTRACTED_REQUIREMENTS} items -- additional qualifying items were found but not included.`
    : '';
  return (
    "Requirements were heuristically extracted from this task's description HTML (e.g. \"Submit\"/\"Rules\" " +
    'sections), not authored by a human reviewer -- keyword matching is conservative by design and may miss ' +
    `paraphrased evidence. Treat --reasoning output and manual review as the final word on ambiguous items.${truncationNote}`
  );
}

function buildReasoningProvider(kind: ReasoningProvider): LLMProvider {
  if (kind === 'mock') return new FixtureMockLLMProvider();

  const apiKey = process.env.LLM_API_KEY ?? '';
  const model = process.env.LLM_MODEL;
  console.log(
    `\n--reasoning-provider api: using the real Anthropic API (model: ${model && model.length > 0 ? model : DEFAULT_MODEL}). ` +
      'This makes real network calls and may incur cost -- only routed submissions are sent, one batched call each.\n',
  );
  return new AnthropicLLMProvider({ apiKey, ...(model ? { model } : {}) });
}

async function runEvidenceInspection(submissions: ReviewSubmission[], adapter: GithubEvidenceAdapter): Promise<void> {
  console.log(
    '\n--inspect-evidence: making read-only `gh pr view` calls for any GitHub PR evidence found. ' +
      'No write/merge/comment operation exists in this tool.\n',
  );

  const bySubmission = new Map<string, GithubEvidenceOutcome[]>();

  for (const submission of submissions) {
    const evidence = collectEvidence(submission);
    const candidates = findInspectablePullRequestEvidence(evidence);
    const outcomes: GithubEvidenceOutcome[] = [];

    for (const candidate of candidates) {
      try {
        const prEvidence = await adapter.inspectPullRequest(candidate.evidence.value);
        outcomes.push({ url: candidate.evidence.value, evidence: prEvidence });
      } catch (error) {
        outcomes.push({ url: candidate.evidence.value, error: error instanceof Error ? error.message : 'Unknown error.' });
      }
    }

    bySubmission.set(submission.id, outcomes);
  }

  console.log(renderGithubEvidenceSection(bySubmission));
}

export interface PrintReviewOptions {
  /** Set for a live Gibwork review -- drops the (otherwise true) "fixture mode" footer note. */
  live?: boolean;
  /** Shown directly under the requirements line in the full summary; not shown in --inspect mode. */
  generalRequirementsNotice?: string;
  withReasoning: boolean;
  reasoningProvider: ReasoningProvider;
  /** A report "#N" display number or a literal submission ID. When set, this becomes a
   *  focused single-submission drill-down instead of the full summary. */
  inspect?: string;
}

/**
 * Shared by fixture and live review -- the single place that decides what a review run
 * actually prints. Without --inspect this is unchanged from before: the full summary,
 * then (if --reasoning) every router-flagged submission's reasoning. With --inspect this
 * is a drill-down, not an addition: the full summary is skipped entirely in favor of one
 * submission's full evidence-backed breakdown, and if --reasoning is also set, the
 * provider is asked about (and only about) that one submission -- never every submission
 * in the bounty. `assessments` are only ever read here, never recomputed or mutated --
 * reasoning stays advisory regardless of which mode this renders.
 */
export async function printReview(
  task: ReviewTask,
  requirements: Requirement[],
  submissions: ReviewSubmission[],
  assessments: SubmissionAssessment[],
  options: PrintReviewOptions,
  buildProvider: (kind: ReasoningProvider) => LLMProvider,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<void> {
  const logMockNoticeIfNeeded = (): void => {
    if (options.reasoningProvider === 'mock') {
      console.log(
        '\nNote: --reasoning uses a local, deterministic mock provider only. No LLM API, SDK, key, or network call is involved.\n',
      );
    }
  };

  if (options.inspect) {
    const summary = buildReviewSummary({ task, requirements, assessments });
    const entry = findEntryByRef(summary.entries, options.inspect);
    if (!entry) {
      console.log(
        `\nNo submission matching "${options.inspect}" was found in this review ` +
          `(${summary.entries.length} submission(s), numbered #1-#${summary.entries.length}).`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(renderSubmissionInspection(entry, task, requirements));

    if (options.withReasoning) {
      const submission = submissions.find((item) => item.id === entry.submissionId);
      if (submission) {
        logMockNoticeIfNeeded();
        const provider = buildProvider(options.reasoningProvider);
        const reasoning = await applyReasoning(submission, requirements, entry.assessment, provider, githubAdapter);
        console.log(renderReasoningSummary(new Map([[submission.id, reasoning]])));
      }
    }
    return;
  }

  console.log(
    renderReviewReport(
      { task, requirements, assessments },
      {
        ...(options.live !== undefined ? { live: options.live } : {}),
        ...(options.generalRequirementsNotice ? { generalRequirementsNotice: options.generalRequirementsNotice } : {}),
      },
    ),
  );

  if (options.withReasoning) {
    logMockNoticeIfNeeded();
    const provider = buildProvider(options.reasoningProvider);
    const reasoningById = new Map<string, SubmissionReasoning>();
    for (const submission of submissions) {
      const assessment = assessments.find((item) => item.submissionId === submission.id);
      if (!assessment) continue;
      reasoningById.set(submission.id, await applyReasoning(submission, requirements, assessment, provider, githubAdapter));
    }
    console.log(renderReasoningSummary(reasoningById));
  }
}

export async function runFixtureReview(
  fixturePath: string,
  withReasoning: boolean,
  reasoningProvider: ReasoningProvider,
  inspectEvidence: boolean,
  inspect: string | undefined,
): Promise<void> {
  console.log('=== FIXTURE MODE -- local evaluation only: no Gibwork wallet, no Gibwork network, no LLM ===\n');

  const { task, submissions } = loadFixture(fixturePath);
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator(submissions);

  const assessments: SubmissionAssessment[] = [];
  for (const submission of submissions) {
    assessments.push(await evaluator.evaluate(task, submission));
  }

  const githubAdapter = inspectEvidence ? new GithubEvidenceAdapter() : undefined;

  await printReview(
    task,
    requirements,
    submissions,
    assessments,
    { withReasoning, reasoningProvider, ...(inspect ? { inspect } : {}) },
    buildReasoningProvider,
    githubAdapter,
  );

  if (inspectEvidence && githubAdapter) {
    await runEvidenceInspection(submissions, githubAdapter);
  }
}

interface RunLiveReviewOptions {
  status?: SubmissionStatus;
  page?: number;
  limit?: number;
  withReasoning: boolean;
  reasoningProvider: ReasoningProvider;
  inspectEvidence: boolean;
  inspect?: string;
}

/**
 * Live counterpart to runFixtureReview(): fetches a real task's submissions (read-only)
 * and runs the exact same deterministic-evaluation / reasoning / evidence-inspection
 * pipeline. `liveTask` must already have been resolved via getTask() -- this function
 * only ever calls submissions.list(), never a write/financial endpoint.
 */
async function runLiveReview(client: GibworkClient, liveTask: TaskDetails, options: RunLiveReviewOptions): Promise<void> {
  console.log(
    `=== LIVE REVIEW -- deterministic evaluation of real Gibwork stage submissions for task ${liveTask.id} ` +
      '(read-only: no approve/reject/refund/create/sign call exists in this tool) ===\n',
  );

  const task = toReviewTask(liveTask);

  const query: SubmissionPaginationQuery = {};
  if (options.status) query.status = options.status;
  if (options.page) query.page = options.page;
  if (options.limit) query.limit = options.limit;
  // Default to fetching the complete set so evaluation covers every submission --
  // the task-level submission counts are never trusted as authoritative on their own.
  if (!options.page && !options.limit) query.pageAll = true;

  let submissionPage;
  try {
    submissionPage = await listSubmissions(client, liveTask.id, query);
  } catch (error) {
    console.log(
      `Could not fetch submissions for this task: ${error instanceof Error ? error.message : 'Unknown error.'}\n` +
        'No evaluation was run.',
    );
    return;
  }

  const taskLevelTotal =
    liveTask.taskSubmissionsApprovedCount + liveTask.taskSubmissionsPendingCount + liveTask.taskSubmissionsRejectedCount;

  console.log(
    `Fetched ${submissionPage.results.length} of ${submissionPage.total} submission(s) reported by submissions.list() ` +
      `(the task itself separately reports ${taskLevelTotal} submission(s) across approved/pending/rejected -- ` +
      'this submissions.list() count is the authoritative one for this wallet).\n',
  );

  const submissions = submissionPage.results.map(toReviewSubmission);
  const requirementExtractor = new HtmlListRequirementExtractor();
  const requirements = extractRequirements(task, requirementExtractor);
  const evaluator = new LocalDeterministicEvaluator(submissions);

  const assessments: SubmissionAssessment[] = [];
  for (const submission of submissions) {
    assessments.push(await evaluator.evaluate(task, submission));
  }

  const githubAdapter = options.inspectEvidence ? new GithubEvidenceAdapter() : undefined;

  await printReview(
    task,
    requirements,
    submissions,
    assessments,
    {
      live: true,
      generalRequirementsNotice: buildRequirementsNotice(requirementExtractor),
      withReasoning: options.withReasoning,
      reasoningProvider: options.reasoningProvider,
      ...(options.inspect ? { inspect: options.inspect } : {}),
    },
    buildReasoningProvider,
    githubAdapter,
  );

  if (submissions.length === 0) {
    console.log('\nNo submissions were returned for this task -- nothing further to evaluate.');
  }

  if (options.inspectEvidence && githubAdapter) {
    await runEvidenceInspection(submissions, githubAdapter);
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  if (cli.mode === 'fixture') {
    await runFixtureReview(cli.fixturePath, cli.reasoning, cli.reasoningProvider, cli.inspectEvidence, cli.inspect);
    return;
  }

  const { client } = buildGibworkClient(cli.profile);

  if (cli.mode === 'list-available-tasks') {
    const query: AvailableTasksQuery = {};
    if (cli.page) query.page = cli.page;
    if (cli.limit) query.limit = cli.limit;

    console.log('Reading available bounties from Gibwork (read-only, tasks.listAvailable())...');
    const page = await listAvailableTasks(client, query);
    console.log(renderAvailableTasksList(page));
    return;
  }

  // cli.mode === 'live'
  console.log(`Resolving task ${cli.taskId} directly (tasks.get(), read-only)...`);
  const liveTask = await getTask(client, cli.taskId);
  if (!liveTask) {
    console.log(
      `\nTask "${cli.taskId}" was not found.\n` + 'The bounty may never have existed on this environment, may have been mistyped, or the ID may be malformed.',
    );
    process.exitCode = 1;
    return;
  }

  if (cli.submissionId) {
    console.log(`Reading submission ${cli.submissionId} on task ${cli.taskId} from Gibwork (read-only)...`);
    const detail = await getSubmissionDetail(client, cli.taskId, cli.submissionId);
    console.log(renderSubmissionDetail(cli.taskId, detail));
    return;
  }

  await runLiveReview(client, liveTask, {
    ...(cli.status ? { status: cli.status } : {}),
    ...(cli.page ? { page: cli.page } : {}),
    ...(cli.limit ? { limit: cli.limit } : {}),
    withReasoning: cli.reasoning,
    reasoningProvider: cli.reasoningProvider,
    inspectEvidence: cli.inspectEvidence,
    ...(cli.inspect ? { inspect: cli.inspect } : {}),
  });
}

// Guarded so this file can be imported by tests (e.g. index.test.ts, for printReview/
// runFixtureReview) without immediately parsing process.argv and running the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
