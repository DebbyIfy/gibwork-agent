import { parseArgs } from 'node:util';
import type { SubmissionStatus } from '@gibwork/sdk';
import type {
  FixtureReviewCliOptions,
  ListAvailableTasksCliOptions,
  LiveReviewCliOptions,
  ReasoningProvider,
  ReviewCliOptions,
} from './types.js';

const STATUSES: SubmissionStatus[] = ['pending', 'approved', 'rejected'];
const REASONING_PROVIDERS: ReasoningProvider[] = ['mock', 'api'];

const USAGE = `Usage: gibwork-agent tasks --available [options]
       gibwork-agent review <task-id> [options]
       gibwork-agent review --fixture <path> [options]

Read-only review of Gibwork bounty submissions. Only ever lists/views tasks
and submissions, and evaluates them locally -- never approves, rejects,
signs, or submits anything. --fixture runs the same evaluation engine
entirely offline against local fixture data instead of live Gibwork data --
no wallet, no network.

<task-id> is resolved directly via tasks.get(taskId) -- read-only, no wallet,
no network beyond the lookup itself.

Examples:
  gibwork-agent tasks --available
  gibwork-agent review abc123
  gibwork-agent review abc123 --reasoning --inspect-evidence
  gibwork-agent review abc123 --submission sub456
  gibwork-agent review abc123 --status pending
  gibwork-agent review abc123 --inspect 12
  gibwork-agent review --fixture fixtures/task.json
  gibwork-agent review --fixture fixtures/task.json --inspect 3

Options:
  --available         With \`tasks\`: list publicly available bounties
                      (tasks.listAvailable()) with enough detail to choose one.
  --submission <id>   Show full raw detail for one submission instead of
                      running the full review pipeline (no evaluation).
  --status <status>   Filter submissions by status: pending | approved | rejected
  --page <n>          Page number (tasks/submissions list)
  --limit <n>         Page size (tasks/submissions list)
  --profile <name>    Gibwork CLI profile to read wallet config from
  --fixture <path>    Run the local evaluation engine against fixture JSON
                      instead of live Gibwork data (path to a task.json; its
                      submissions.json is read from the same directory)
  --reasoning         Route unresolved cases (weak/partial evidence, possible
                      contradictions) through a reasoning layer. Works with
                      --fixture or a live <task-id>; not with --submission.
  --reasoning-provider <mock|api>
                      Which reasoning layer to use with --reasoning. "mock"
                      (default): local, deterministic, no network, no API key.
                      "api": real OpenRouter API call, requires
                      OPENROUTER_API_KEY -- never enabled unless you
                      explicitly ask for it.
  --inspect-evidence  Inspect any GitHub pull request evidence via the \`gh\`
                      CLI (read-only: gh pr view only, no write/merge/comment
                      operation exists). Advisory display only -- never
                      affects score/classification. Works with --fixture or a
                      live <task-id>; not with --submission.
  --inspect <ref>     Focused drill-down into one submission, referenced
                      either by its report "#N" display number or its literal
                      submission ID -- skips the compact summary and prints
                      only that submission's full evidence-backed breakdown
                      (score, classification, confidence, every requirement's
                      status and evidence, flags). Combined with --reasoning,
                      the reasoning layer is asked about only this
                      submission, not every submission in the bounty. Works
                      with --fixture or a live <task-id>; not with
                      --submission.
  --interactive       Force interactive review mode: after the summary, offer
                      a menu to inspect a submission (picked from a numbered
                      list -- no need to know --inspect) and, from there,
                      optionally run reasoning on just that submission (no
                      need to know --reasoning). Interactive mode is already
                      used automatically when both stdin and stdout are a
                      real terminal (TTY); this flag forces it on even when
                      piped/redirected. Ignored together with --inspect or
                      --submission, which are already direct/non-interactive.
  --no-interactive    Disable interactive mode even in a real terminal --
                      prints the plain summary and exits, same as scripted/
                      piped usage. Cannot be combined with --interactive.
  -h, --help          Show this help
`;

export function parseCli(argv: string[]): ReviewCliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      submission: { type: 'string' },
      status: { type: 'string' },
      page: { type: 'string' },
      limit: { type: 'string' },
      profile: { type: 'string' },
      fixture: { type: 'string' },
      reasoning: { type: 'boolean' },
      'reasoning-provider': { type: 'string' },
      'inspect-evidence': { type: 'boolean' },
      inspect: { type: 'string' },
      interactive: { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
      available: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'tasks') {
    if (!values.available) {
      throw new Error('The "tasks" command currently only supports --available (list bounties via tasks.listAvailable()).');
    }
    const options: ListAvailableTasksCliOptions = { mode: 'list-available-tasks' };
    if (values.page) options.page = Number(values.page);
    if (values.limit) options.limit = Number(values.limit);
    if (values.profile) options.profile = values.profile;
    return options;
  }

  if (command !== 'review') {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  if (values['reasoning-provider'] && !REASONING_PROVIDERS.includes(values['reasoning-provider'] as ReasoningProvider)) {
    throw new Error(`--reasoning-provider must be one of: ${REASONING_PROVIDERS.join(', ')}`);
  }
  if (values['reasoning-provider'] && !values.reasoning) {
    throw new Error('--reasoning-provider requires --reasoning.');
  }

  if (values.interactive && values['no-interactive']) {
    throw new Error('--interactive and --no-interactive cannot both be passed.');
  }
  // undefined = no explicit preference -> caller auto-detects from the terminal.
  const interactiveOverride: boolean | undefined = values['no-interactive'] ? false : values.interactive ? true : undefined;

  if (values.fixture) {
    if (positionals[1]) {
      throw new Error('--fixture cannot be combined with a live <task-id>. Use one or the other.');
    }
    const fixtureOptions: FixtureReviewCliOptions = {
      mode: 'fixture',
      fixturePath: values.fixture,
      reasoning: values.reasoning ?? false,
      reasoningProvider: (values['reasoning-provider'] as ReasoningProvider) ?? 'mock',
      inspectEvidence: values['inspect-evidence'] ?? false,
    };
    if (values.inspect) fixtureOptions.inspect = values.inspect;
    if (interactiveOverride !== undefined) fixtureOptions.interactive = interactiveOverride;
    return fixtureOptions;
  }

  const taskId = positionals[1];
  if (!taskId) {
    process.stdout.write(USAGE);
    process.exit(1);
  }

  if (values.status && !STATUSES.includes(values.status as SubmissionStatus)) {
    throw new Error(`--status must be one of: ${STATUSES.join(', ')}`);
  }

  if (values.submission && (values.reasoning || values['inspect-evidence'] || values.inspect || values.interactive)) {
    throw new Error(
      '--submission (raw single-submission view) cannot be combined with --reasoning/--inspect-evidence/--inspect/--interactive, which apply to the full task review pipeline.',
    );
  }

  const options: LiveReviewCliOptions = {
    mode: 'live',
    taskId,
    reasoning: values.reasoning ?? false,
    inspectEvidence: values['inspect-evidence'] ?? false,
  };
  // Left unset (rather than defaulted to 'mock' here) when not explicitly passed, so live
  // mode can tell "no preference" apart from "user explicitly chose mock" -- see
  // resolveInteractiveReasoningProvider() in index.ts.
  if (values['reasoning-provider']) options.reasoningProvider = values['reasoning-provider'] as ReasoningProvider;
  if (values.submission) options.submissionId = values.submission;
  if (values.status) options.status = values.status as SubmissionStatus;
  if (values.page) options.page = Number(values.page);
  if (values.limit) options.limit = Number(values.limit);
  if (values.profile) options.profile = values.profile;
  if (values.inspect) options.inspect = values.inspect;
  if (interactiveOverride !== undefined) options.interactive = interactiveOverride;
  return options;
}

/**
 * Resolves whether this run should be interactive: an explicit --inspect always wins
 * (it already expresses a specific, scripted request -- see the CLI help text), then an
 * explicit --interactive/--no-interactive, then finally auto-detect from the terminal.
 * Takes TTY state as plain booleans (not read internally) so this stays a pure,
 * unit-testable function -- callers pass `process.stdin.isTTY`/`process.stdout.isTTY`.
 */
export function resolveInteractiveMode(
  options: { interactive?: boolean; inspect?: string },
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  if (options.inspect) return false;
  if (options.interactive !== undefined) return options.interactive;
  return stdinIsTTY && stdoutIsTTY;
}
