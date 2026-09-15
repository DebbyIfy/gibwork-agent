import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseGithubPullRequestUrl,
  findInspectablePullRequestEvidence,
  GithubEvidenceAdapter,
  GithubUrlParseError,
  GithubRetrievalError,
  type GithubCliRunner,
} from './github.js';
import { LocalDeterministicEvaluator } from '../evaluation/evaluator.js';
import { extractRequirements } from '../evaluation/requirements.js';
import type { ReviewSubmission, ReviewTask } from '../evaluation/types.js';

/**
 * All tests here are fully offline: the GitHub CLI boundary (`GithubCliRunner`) is a
 * plain injected function, so nothing here spawns a real `gh` process or touches the
 * network. No GitHub authentication, real repository, or real PR is required.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
const sampleCliOutput = readFileSync(join(moduleDir, '..', '..', 'fixtures', 'github-pr-sample.json'), 'utf8');

const SAMPLE_URL = 'https://github.com/example-org/tasks-api/pull/112';

function runnerReturning(output: string): GithubCliRunner {
  return () => output;
}

function runnerThrowing(message: string): GithubCliRunner {
  return () => {
    throw new Error(message);
  };
}

// 1. valid PR URL parsing
test('parses a valid pull request URL', () => {
  const ref = parseGithubPullRequestUrl('https://github.com/owner-1/repo_2/pull/112');
  assert.deepEqual(ref, { owner: 'owner-1', repo: 'repo_2', number: 112 });
});

test('parses a valid pull request URL with a trailing path/query/fragment', () => {
  assert.deepEqual(parseGithubPullRequestUrl('https://github.com/o/r/pull/5/files'), { owner: 'o', repo: 'r', number: 5 });
  assert.deepEqual(parseGithubPullRequestUrl('https://github.com/o/r/pull/5?diff=split'), { owner: 'o', repo: 'r', number: 5 });
});

// 2. malformed PR URL
test('rejects a malformed PR URL (missing/non-numeric PR number)', () => {
  assert.throws(() => parseGithubPullRequestUrl('https://github.com/owner/repo/pull/'), GithubUrlParseError);
  assert.throws(() => parseGithubPullRequestUrl('https://github.com/owner/repo/pull/abc'), GithubUrlParseError);
  assert.throws(() => parseGithubPullRequestUrl('not a url at all'), GithubUrlParseError);
});

// 3. non-PR GitHub URL
test('rejects a well-formed but non-PR GitHub URL', () => {
  assert.throws(() => parseGithubPullRequestUrl('https://github.com/owner/repo'), GithubUrlParseError);
  assert.throws(() => parseGithubPullRequestUrl('https://github.com/owner/repo/issues/5'), GithubUrlParseError);
  assert.throws(() => parseGithubPullRequestUrl('https://github.com'), GithubUrlParseError);
  assert.throws(() => parseGithubPullRequestUrl('https://example.com/owner/repo/pull/5'), GithubUrlParseError);
});

// 4. successful normalized PR retrieval
test('retrieves and normalizes a PR via the (mocked) GitHub CLI', async () => {
  const adapter = new GithubEvidenceAdapter({ runner: runnerReturning(sampleCliOutput) });
  const evidence = await adapter.inspectPullRequest(SAMPLE_URL);

  assert.equal(evidence.sourceType, 'github');
  assert.equal(evidence.owner, 'example-org');
  assert.equal(evidence.repo, 'tasks-api');
  assert.equal(evidence.number, 112);
  assert.equal(evidence.title, 'Add pagination to the /tasks endpoint');
  assert.equal(evidence.state, 'MERGED');
  assert.equal(evidence.merged, true);
});

// 5. failed GitHub retrieval
test('a failed CLI invocation is rejected as a safe GithubRetrievalError', async () => {
  const adapter = new GithubEvidenceAdapter({ runner: runnerThrowing('gh: pull request not found') });
  await assert.rejects(() => adapter.inspectPullRequest(SAMPLE_URL), GithubRetrievalError);
});

// 6. authentication/CLI failure
test('an authentication failure from the CLI is rejected as a safe GithubRetrievalError', async () => {
  const adapter = new GithubEvidenceAdapter({
    runner: runnerThrowing('To get started with GitHub CLI, please run: gh auth login. HTTP 401: Bad credentials'),
  });
  await assert.rejects(() => adapter.inspectPullRequest(SAMPLE_URL), GithubRetrievalError);
});

// 7. no credential leakage in errors
test('a thrown error message never leaks tokens/credentials from the CLI', async () => {
  const secret = 'ghp_FAKESECRETTOKENVALUE1234567890';
  const adapter = new GithubEvidenceAdapter({
    runner: runnerThrowing(`authentication error using token ${secret}`),
  });
  await assert.rejects(() => adapter.inspectPullRequest(SAMPLE_URL), (error: unknown) => {
    assert.ok(error instanceof GithubRetrievalError);
    assert.ok(!error.message.includes(secret), 'error message must not include the raw CLI error text');
    assert.ok(!error.message.includes('ghp_'), 'error message must not include a token-shaped substring');
    return true;
  });
});

// 8. normalized evidence contains the expected fields
test('normalized evidence has the full expected shape', async () => {
  const adapter = new GithubEvidenceAdapter({ runner: runnerReturning(sampleCliOutput) });
  const evidence = await adapter.inspectPullRequest(SAMPLE_URL);

  assert.equal(evidence.additions, 84);
  assert.equal(evidence.deletions, 12);
  assert.equal(evidence.changedFilesCount, 3);
  assert.equal(evidence.changedFiles.length, 3);
  assert.deepEqual(evidence.changedFiles[0], { path: 'src/routes/tasks.ts', additions: 40, deletions: 6 });
  assert.equal(evidence.changedFilesTruncated, false);
  assert.deepEqual(evidence.checks, [
    { name: 'build', state: 'success' },
    { name: 'test', state: 'success' },
  ]);
  assert.equal(evidence.reviewDecision, 'APPROVED');
  assert.equal(evidence.sourceUrl, SAMPLE_URL);
  assert.equal(typeof evidence.retrievedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(evidence.retrievedAt)));
});

test('changed files list is capped and marked truncated when there are more files than the cap', async () => {
  const manyFiles = Array.from({ length: 5 }, (_, i) => ({ path: `file-${i}.ts`, additions: 1, deletions: 0 }));
  const body = JSON.stringify({ number: 1, title: 't', state: 'OPEN', files: manyFiles, changedFiles: 5 });
  const adapter = new GithubEvidenceAdapter({ runner: runnerReturning(body), maxChangedFiles: 2 });
  const evidence = await adapter.inspectPullRequest('https://github.com/o/r/pull/1');

  assert.equal(evidence.changedFiles.length, 2);
  assert.equal(evidence.changedFilesCount, 5);
  assert.equal(evidence.changedFilesTruncated, true);
});

test('findInspectablePullRequestEvidence pre-filters offline, without any CLI call', () => {
  const results = findInspectablePullRequestEvidence([
    { type: 'github', value: SAMPLE_URL },
    { type: 'github', value: 'https://github.com/example-org/tasks-api' }, // not a PR -- skipped
    { type: 'url', value: 'https://example.dev/blog' }, // wrong type -- skipped
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ref.number, 112);
});

// 9. deterministic assessment remains unchanged when evidence inspection is unavailable
test('the deterministic assessment is identical whether or not GitHub evidence inspection succeeds', async () => {
  const task: ReviewTask = {
    id: 't1',
    title: 'Task',
    description: 'desc',
    requirements: [
      { id: 'pr-req', description: 'Link a PR', required: true, keywords: ['pagination'], evidenceType: 'github' },
    ],
  };
  const submission: ReviewSubmission = { id: 'sub-1', content: `Implemented pagination: ${SAMPLE_URL}` };
  const requirements = extractRequirements(task);
  const evaluator = new LocalDeterministicEvaluator([submission]);

  const assessmentBefore = await evaluator.evaluate(task, submission);
  const snapshot = JSON.stringify(assessmentBefore);

  // Simulate the GitHub adapter being consulted and failing -- the deterministic
  // evaluator never calls the adapter itself, so this must have zero effect.
  const adapter = new GithubEvidenceAdapter({ runner: runnerThrowing('simulated CLI outage') });
  await assert.rejects(() => adapter.inspectPullRequest(SAMPLE_URL), GithubRetrievalError);

  assert.equal(JSON.stringify(assessmentBefore), snapshot, 'assessment object must be untouched');
  assert.equal(assessmentBefore.requirementAssessments[0]?.status, 'verified');
});
