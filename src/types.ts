import type { SubmissionStatus } from '@gibwork/sdk';

export type ReasoningProvider = 'mock' | 'api';

export interface LiveReviewCliOptions {
  mode: 'live';
  taskId: string;
  submissionId?: string;
  status?: SubmissionStatus;
  page?: number;
  limit?: number;
  profile?: string;
  /** Opt-in only: routes unresolved cases through a reasoning layer. Live mode only supports
   *  this alongside the full-review pipeline, not the raw --submission detail view. */
  reasoning: boolean;
  /** Set only when the user explicitly passes --reasoning-provider; undefined means "no
   *  explicit preference". Non-interactive live --reasoning still defaults this to 'mock'
   *  when unset (unchanged). Interactive live mode instead auto-resolves an unset value to
   *  'api' when OPENROUTER_API_KEY is configured, 'mock' otherwise -- see
   *  resolveInteractiveReasoningProvider() in index.ts. Fixture mode is unaffected by any
   *  of this: it keeps defaulting to 'mock' unconditionally (see cli.ts), since fixture
   *  mode's whole point is to run fully offline by default. */
  reasoningProvider?: ReasoningProvider;
  /** Opt-in only: inspects GitHub PR evidence via the `gh` CLI (read-only). Advisory display only. */
  inspectEvidence: boolean;
  /** Opt-in only: shows the full evidence-backed breakdown for one submission (by its
   *  report "#N" display number or its literal submission ID) instead of just the
   *  compact default report. */
  inspect?: string;
  /** Explicit --interactive/--no-interactive override. undefined means "auto-detect from
   *  the terminal" (see resolveInteractiveMode() in cli.ts) -- this field only carries
   *  what the user explicitly asked for, never a resolved TTY-based decision. */
  interactive?: boolean;
}

/** `gibwork-agent tasks --available` -- lists publicly available bounties via tasks.listAvailable(). */
export interface ListAvailableTasksCliOptions {
  mode: 'list-available-tasks';
  page?: number;
  limit?: number;
  profile?: string;
}

export interface FixtureReviewCliOptions {
  mode: 'fixture';
  fixturePath: string;
  /** Opt-in only: routes unresolved cases through a reasoning layer. */
  reasoning: boolean;
  /** 'mock' (default, no network/key) or 'api' (real provider, requires LLM_API_KEY). */
  reasoningProvider: ReasoningProvider;
  /** Opt-in only: inspects GitHub PR evidence via the `gh` CLI (read-only). Advisory display only. */
  inspectEvidence: boolean;
  /** Opt-in only: shows the full evidence-backed breakdown for one submission (by its
   *  report "#N" display number or its literal submission ID) instead of just the
   *  compact default report. */
  inspect?: string;
  /** Explicit --interactive/--no-interactive override. undefined means "auto-detect from
   *  the terminal" (see resolveInteractiveMode() in cli.ts) -- this field only carries
   *  what the user explicitly asked for, never a resolved TTY-based decision. */
  interactive?: boolean;
}

export type ReviewCliOptions = LiveReviewCliOptions | FixtureReviewCliOptions | ListAvailableTasksCliOptions;
