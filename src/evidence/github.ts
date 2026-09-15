import { execFileSync } from 'node:child_process';
import type { Evidence } from '../evaluation/types.js';
import { isWellFormedUrl } from '../evaluation/urls.js';

/**
 * Read-only GitHub PR evidence adapter. GitHub is the first evidence source, not the
 * product boundary -- this module only inspects a pull request via `gh pr view` (a
 * read) and normalizes the result. It never marks anything verified and never writes
 * to GitHub (no merge/comment/edit/label/branch mutation exists here or anywhere in
 * this file). Uses the `gh` CLI's existing authentication -- no GitHub token is
 * required in this application, and no credential is ever read, logged, or returned.
 */

export interface GithubPrReference {
  owner: string;
  repo: string;
  number: number;
}

/** A URL that isn't a well-formed GitHub pull request URL at all. */
export class GithubUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubUrlParseError';
  }
}

/** The URL parsed fine, but retrieval via `gh` failed (not found, network, auth, ...). */
export class GithubRetrievalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GithubRetrievalError';
  }
}

const PR_URL_PATTERN = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * Parses a GitHub pull request URL into {owner, repo, number}. Deliberately narrow:
 * a repo root, an issue, a commit link, or the github.com homepage are all rejected
 * with a clear typed error rather than guessed at.
 */
export function parseGithubPullRequestUrl(url: string): GithubPrReference {
  if (!isWellFormedUrl(url)) {
    throw new GithubUrlParseError(`Not a valid URL: "${url}"`);
  }

  const match = PR_URL_PATTERN.exec(url);
  if (!match) {
    throw new GithubUrlParseError(`Not a GitHub pull request URL (expected https://github.com/<owner>/<repo>/pull/<number>): "${url}"`);
  }
  const [, owner, repo, numberText] = match;
  if (!owner || !repo || !numberText) {
    throw new GithubUrlParseError(`Not a GitHub pull request URL: "${url}"`);
  }
  return { owner, repo, number: Number(numberText) };
}

export type GithubCheckState = 'success' | 'failure' | 'pending' | 'other';

export interface GithubCheckSummary {
  name: string;
  state: GithubCheckState;
}

export interface GithubChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Compact, normalized evidence about one pull request. This is what the rest of the
 * product sees -- callers never touch `gh` JSON shapes directly. Deliberately does not
 * include full unified diffs (only per-file add/delete stats) to keep this small and
 * bounded regardless of how large the real PR is.
 */
export interface GithubPrEvidence {
  sourceType: 'github';
  sourceUrl: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
  isDraft: boolean;
  merged: boolean;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  changedFiles: GithubChangedFile[];
  changedFilesTruncated: boolean;
  checks: GithubCheckSummary[];
  reviewDecision: string | null;
  retrievedAt: string;
}

/** Injectable CLI boundary -- tests supply a fake implementation, never touching the real `gh`. */
export type GithubCliRunner = (args: string[]) => string;

function defaultRunner(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const PR_JSON_FIELDS =
  'number,title,body,state,isDraft,mergedAt,additions,deletions,changedFiles,files,statusCheckRollup,reviewDecision';

interface RawGithubPrFile {
  path: string;
  additions: number;
  deletions: number;
}

interface RawGithubCheck {
  name?: string;
  conclusion?: string | null;
  status?: string;
  state?: string;
}

interface RawGithubPr {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  isDraft?: boolean;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: RawGithubPrFile[];
  statusCheckRollup?: RawGithubCheck[];
  reviewDecision?: string | null;
}

function normalizeCheckState(entry: RawGithubCheck): GithubCheckState {
  const raw = (entry.conclusion ?? entry.state ?? entry.status ?? '').toUpperCase();
  if (['SUCCESS', 'SUCCESSFUL', 'PASSED', 'COMPLETED'].includes(raw)) return 'success';
  if (['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(raw)) return 'failure';
  if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING'].includes(raw)) return 'pending';
  return 'other';
}

/**
 * Never includes the runner's raw stdout/stderr/message -- `gh` failures (auth
 * prompts, rate-limit notices, etc.) could otherwise carry tokens or environment
 * detail into a log. The reported message is always a fixed, generic shape.
 */
function buildRetrievalErrorMessage(ref: GithubPrReference): string {
  return (
    `Could not retrieve ${ref.owner}/${ref.repo}#${ref.number} via the GitHub CLI. ` +
    'Confirm the PR exists and is visible to your `gh` authentication (`gh auth status`).'
  );
}

export interface GithubEvidenceAdapterOptions {
  runner?: GithubCliRunner;
  maxChangedFiles?: number;
}

/**
 * Retrieves and normalizes GitHub pull request evidence. This class only ever reads --
 * it has exactly one public method and that method cannot mutate GitHub state. It
 * reports what a PR contains; it never decides whether that satisfies a requirement.
 */
export class GithubEvidenceAdapter {
  private readonly runner: GithubCliRunner;
  private readonly maxChangedFiles: number;

  constructor(options: GithubEvidenceAdapterOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
    this.maxChangedFiles = options.maxChangedFiles ?? 30;
  }

  /** Throws GithubUrlParseError for a non-PR URL, GithubRetrievalError if `gh` or parsing fails. */
  async inspectPullRequest(url: string): Promise<GithubPrEvidence> {
    const ref = parseGithubPullRequestUrl(url);

    let stdout: string;
    try {
      stdout = this.runner(['pr', 'view', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, '--json', PR_JSON_FIELDS]);
    } catch (error) {
      throw new GithubRetrievalError(buildRetrievalErrorMessage(ref), { cause: error });
    }

    let raw: RawGithubPr;
    try {
      raw = JSON.parse(stdout) as RawGithubPr;
    } catch (error) {
      throw new GithubRetrievalError(buildRetrievalErrorMessage(ref), { cause: error });
    }

    const files = raw.files ?? [];
    const changedFiles = files.slice(0, this.maxChangedFiles).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    }));

    return {
      sourceType: 'github',
      sourceUrl: url,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: raw.title ?? '',
      body: raw.body ?? '',
      state: raw.state ?? 'UNKNOWN',
      isDraft: raw.isDraft ?? false,
      merged: Boolean(raw.mergedAt),
      additions: raw.additions ?? 0,
      deletions: raw.deletions ?? 0,
      changedFilesCount: raw.changedFiles ?? files.length,
      changedFiles,
      changedFilesTruncated: files.length > changedFiles.length,
      checks: (raw.statusCheckRollup ?? []).map((entry) => ({
        name: entry.name ?? 'unknown check',
        state: normalizeCheckState(entry),
      })),
      reviewDecision: raw.reviewDecision ?? null,
      retrievedAt: new Date().toISOString(),
    };
  }
}

export interface InspectableGithubEvidence {
  evidence: Evidence;
  ref: GithubPrReference;
}

/**
 * Offline pre-filter: identifies which already-collected evidence items are
 * GitHub PR URLs worth inspecting, without making any network/CLI call. This is
 * the "if GitHub PR evidence exists" step -- purely structural, same spirit as
 * the rest of the deterministic evidence layer.
 */
export function findInspectablePullRequestEvidence(evidence: Evidence[]): InspectableGithubEvidence[] {
  const results: InspectableGithubEvidence[] = [];
  for (const item of evidence) {
    if (item.type !== 'github') continue;
    try {
      results.push({ evidence: item, ref: parseGithubPullRequestUrl(item.value) });
    } catch {
      // Not a PR-shaped GitHub URL (e.g. a bare repo or org link) -- this is a
      // pre-filter, not a place to surface parse errors.
    }
  }
  return results;
}
