import { createInterface } from 'node:readline/promises';
import { buildReviewSummary, type SubmissionSummaryEntry } from './evaluation/review-summary.js';
import { classificationLabel, renderSubmissionInspection, renderReasoningSummary } from './evaluation/report.js';
import { applyReasoning } from './evaluation/reasoning.js';
import type { LLMProvider } from './evaluation/llm.js';
import type { ReasoningProvider } from './types.js';
import type { Requirement, ReviewSubmission, ReviewTask, SubmissionAssessment } from './evaluation/types.js';
import type { GithubEvidenceAdapter } from './evidence/github.js';

/** Injected I/O boundary -- production uses a real readline/promises interface (see
 *  createReadlineAsk()); tests supply a scripted queue of answers, never a real TTY. */
export type AskFn = (prompt: string) => Promise<string>;

export interface InteractiveReviewDeps {
  ask: AskFn;
  /** Same provider-construction callback printReview() already uses -- interactive mode
   *  never builds its own provider, it only decides *when* to call this (on demand,
   *  per submission, only if the user explicitly asks). */
  buildProvider: (kind: ReasoningProvider) => LLMProvider;
}

/** Thrown internally to unwind every nested menu loop at once when the user picks
 *  "Exit" from any level. Never surfaces outside runInteractiveReview(). */
class ExitRequested extends Error {}

const MAX_PROMPT_ATTEMPTS = 3;

/**
 * Shared retry/EOF loop used by every numbered menu in this module. Empty input, EOF
 * (ask() resolving to '' -- see createReadlineAsk()), and exhausting
 * MAX_PROMPT_ATTEMPTS invalid attempts all resolve to `null`, which every caller treats
 * as "go back" -- never a crash, never a hang, never an unhandled rejection.
 */
async function readChoice(ask: AskFn, max: number): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const raw = (await ask('\n> ')).trim();
    if (raw === '') return null;
    const choice = Number(raw);
    if (Number.isInteger(choice) && choice >= 1 && choice <= max) return choice;
    console.log(`Please enter a number between 1 and ${max}.`);
  }

  console.log('\nToo many invalid attempts -- going back.');
  return null;
}

async function promptChoice(ask: AskFn, question: string, options: string[]): Promise<number | null> {
  console.log(`\n${question}\n`);
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option}`));
  return readChoice(ask, options.length);
}

function describeSubmission(entry: SubmissionSummaryEntry): string {
  return `#${entry.displayNumber} — ${classificationLabel(entry.assessment.classification)} — ${entry.assessment.score.total}/100`;
}

/**
 * Lists Priority Review submissions first, in their existing (unchanged) order, then --
 * only if any exist -- every remaining submission (Strong included) under an "OTHER
 * SUBMISSIONS" heading, numbering continuing on from Priority Review. Either list may
 * be selected; nothing here recomputes classification, score, or ordering.
 */
async function selectSubmission(
  ask: AskFn,
  priorityReview: SubmissionSummaryEntry[],
  otherSubmissions: SubmissionSummaryEntry[],
): Promise<SubmissionSummaryEntry | undefined> {
  console.log('\nWhich submission would you like to inspect?\n');
  priorityReview.forEach((entry, index) => console.log(`  ${index + 1}. ${describeSubmission(entry)}`));
  if (otherSubmissions.length > 0) {
    console.log('\nOTHER SUBMISSIONS');
    otherSubmissions.forEach((entry, index) => console.log(`  ${priorityReview.length + index + 1}. ${describeSubmission(entry)}`));
  }

  const all = [...priorityReview, ...otherSubmissions];
  const choice = await readChoice(ask, all.length);
  if (choice === null) return undefined;
  return all[choice - 1];
}

/**
 * Runs the existing advisory reasoning layer for exactly the one submission being
 * inspected -- the same applyReasoning() call printReview()'s --inspect --reasoning
 * path already uses. No new reasoning logic; `entry.assessment` is only ever read.
 */
async function runReasoningForEntry(
  entry: SubmissionSummaryEntry,
  requirements: Requirement[],
  submissions: ReviewSubmission[],
  reasoningProvider: ReasoningProvider,
  deps: InteractiveReviewDeps,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<void> {
  const submission = submissions.find((item) => item.id === entry.submissionId);
  if (!submission) {
    console.log('\nSubmission data not found -- nothing to reason about.');
    return;
  }

  if (reasoningProvider === 'mock') {
    console.log(
      '\nNote: --reasoning uses a local, deterministic mock provider only. No LLM API, SDK, key, or network call is involved.\n',
    );
  }

  const provider = deps.buildProvider(reasoningProvider);
  const reasoning = await applyReasoning(submission, requirements, entry.assessment, provider, githubAdapter);
  console.log('');
  console.log(renderReasoningSummary(new Map([[submission.id, reasoning]])));
}

async function runPostInspectionMenu(
  entry: SubmissionSummaryEntry,
  requirements: Requirement[],
  submissions: ReviewSubmission[],
  reasoningProvider: ReasoningProvider,
  deps: InteractiveReviewDeps,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<void> {
  while (true) {
    const choice = await promptChoice(deps.ask, 'What would you like to do?', ['Run AI reasoning', 'Back to submissions', 'Exit']);
    if (choice === null || choice === 2) return; // back to the submission list
    if (choice === 3) throw new ExitRequested();
    await runReasoningForEntry(entry, requirements, submissions, reasoningProvider, deps, githubAdapter);
    // Loop back to this same menu -- "After reasoning, allow the user to return to the
    // submission action menu" -- so Back/Exit/run-again are all still available.
  }
}

async function runSubmissionSelection(
  priorityReview: SubmissionSummaryEntry[],
  otherSubmissions: SubmissionSummaryEntry[],
  task: ReviewTask,
  requirements: Requirement[],
  submissions: ReviewSubmission[],
  reasoningProvider: ReasoningProvider,
  deps: InteractiveReviewDeps,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<void> {
  while (true) {
    const entry = await selectSubmission(deps.ask, priorityReview, otherSubmissions);
    if (!entry) return; // back to the main menu

    console.log('');
    console.log(renderSubmissionInspection(entry, task, requirements));

    await runPostInspectionMenu(entry, requirements, submissions, reasoningProvider, deps, githubAdapter);
  }
}

/**
 * Additional convenience layer over the existing review pipeline -- orchestration only.
 * No evaluation, scoring, classification, or reasoning logic lives here: submission
 * selection reuses buildReviewSummary()'s already-computed, already-sorted
 * `needsAttention` list for Priority Review (order unchanged), and every remaining
 * submission (Strong included) from `entries` for the OTHER SUBMISSIONS section, so any
 * submission -- not just ones needing attention -- can be inspected. Inspection reuses
 * renderSubmissionInspection() unmodified, and reasoning reuses
 * applyReasoning()/renderReasoningSummary() unmodified. `assessments` are only ever read,
 * never recomputed or mutated -- reasoning triggered from this menu is exactly as
 * advisory as --reasoning already is, and this module has no Gibwork write capability to
 * call in the first place.
 */
export async function runInteractiveReview(
  task: ReviewTask,
  requirements: Requirement[],
  submissions: ReviewSubmission[],
  assessments: SubmissionAssessment[],
  reasoningProvider: ReasoningProvider,
  deps: InteractiveReviewDeps,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<void> {
  const summary = buildReviewSummary({ task, requirements, assessments });
  // Review/Incomplete/Suspicious, score descending, never truncated -- the same "what
  // needs a human's attention" worklist already shown in the report's NEEDS ATTENTION
  // section, not a new selection or ranking.
  const priorityReview = summary.needsAttention;
  const priorityReviewIds = new Set(priorityReview.map((entry) => entry.submissionId));
  // Everything not already in Priority Review (i.e. Strong submissions), in original
  // submission order -- so a submission never appears in both sections.
  const otherSubmissions = summary.entries.filter((entry) => !priorityReviewIds.has(entry.submissionId));

  try {
    while (true) {
      const choice = await promptChoice(deps.ask, 'What would you like to do?', ['Inspect a submission', 'Exit']);
      if (choice === null || choice === 2) return;

      if (priorityReview.length === 0 && otherSubmissions.length === 0) {
        console.log('\nNo submissions currently need attention -- nothing to inspect.');
        continue;
      }

      await runSubmissionSelection(priorityReview, otherSubmissions, task, requirements, submissions, reasoningProvider, deps, githubAdapter);
    }
  } catch (error) {
    if (!(error instanceof ExitRequested)) throw error;
  }
}

/**
 * Production I/O boundary: a real readline/promises interface over the process's own
 * stdin/stdout. Deliberately consumes lines via the interface's async iterator
 * (`rl[Symbol.asyncIterator]()`) rather than repeated `rl.question()` calls: over a
 * non-TTY/piped stdin (scripted answers, or this module's own manual verification),
 * repeated `question()` calls can race the stream's 'close' event and silently drop
 * already-buffered lines between one question resolving and the next one being asked --
 * the async iterator is the pull-based, backpressure-correct pattern that doesn't have
 * this failure mode, and it behaves identically over a real TTY. EOF (Ctrl+D, or the
 * input stream simply ending) makes every subsequent ask() resolve to '' instead of
 * hanging forever -- promptChoice() already treats '' as "go back", so this unwinds
 * runInteractiveReview() cleanly rather than leaving the process stuck on a promise that
 * would otherwise never settle. Ctrl+C is left to Node's default SIGINT handling
 * (immediate process exit) -- no listener is registered here, so nothing intercepts or
 * delays it.
 */
export function createReadlineAsk(): { ask: AskFn; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;

  const ask: AskFn = async (prompt) => {
    if (closed) return '';
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) {
      closed = true;
      return '';
    }
    return value;
  };

  return {
    ask,
    close: () => {
      closed = true;
      rl.close();
    },
  };
}
