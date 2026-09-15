import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyReasoning } from './reasoning.js';
import { FixtureMockLLMProvider } from './mock-llm-provider.js';
import { GithubEvidenceAdapter, type GithubCliRunner } from '../evidence/github.js';
import type { LLMProvider, ReasoningRequest, ReasoningResult, RelevanceCheckResult } from './llm.js';
import type { Requirement, ReviewSubmission, SubmissionAssessment } from './types.js';

/**
 * All tests here are fully offline: the LLM provider and the GitHub CLI boundary are
 * both plain injected fakes. Nothing spawns a real `gh` process, makes a network call,
 * or requires an Anthropic API key.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
const sampleCliOutput = readFileSync(join(moduleDir, '..', '..', 'fixtures', 'github-pr-sample.json'), 'utf8');
const PR_URL = 'https://github.com/example-org/tasks-api/pull/112';

function runnerReturning(output: string): GithubCliRunner {
  return () => output;
}

function runnerCounting(output: string): { runner: GithubCliRunner; calls: () => number } {
  let calls = 0;
  return {
    runner: () => {
      calls += 1;
      return output;
    },
    calls: () => calls,
  };
}

function runnerThrowing(message: string): GithubCliRunner {
  return () => {
    throw new Error(message);
  };
}

/** Records the last request it was given and echoes back a fixed verdict per relevance item. */
class RecordingLLMProvider implements LLMProvider {
  lastRequest?: ReasoningRequest;

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    this.lastRequest = request;
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

/**
 * A provider whose "reasoning" is entirely mechanical (string checks on the inspected
 * PR content), used only to demonstrate that the reasoning request carries enough
 * distinct signal for a provider to tell "PR exists" apart from "PR evidence actually
 * supports the requirement" -- not a real LLM, just a stand-in for one.
 */
class SemanticFakeProvider implements LLMProvider {
  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    const relevance: RelevanceCheckResult[] = request.relevance.map((item) => {
      const pr = item.inspectedEvidence?.[0];
      if (!pr) {
        return { requirementId: item.requirementId, verdict: 'uncertain', reasoning: 'no PR evidence inspected', confidence: 'low' };
      }
      const touchesRelevantCode = pr.changedFiles.some((file) => file.path.includes('tasks.ts'));
      if (pr.merged && touchesRelevantCode) {
        return {
          requirementId: item.requirementId,
          verdict: 'relevant',
          reasoning: 'PR is merged and its changed files touch the relevant code path.',
          confidence: 'high',
        };
      }
      return {
        requirementId: item.requirementId,
        verdict: 'partially_relevant',
        reasoning: 'PR exists and claims the work, but its changed files do not evidence the specific requirement.',
        confidence: 'medium',
      };
    });
    return { submissionId: request.submissionId, relevance, ambiguity: { needsReasoning: false, reason: 'n/a', confidence: 'medium' } };
  }
}

/** Always returns a fixed verdict for every relevance item -- used to prove the advisory
 *  boundary: whatever this returns must never leak into the deterministic assessment. */
class FixedVerdictProvider implements LLMProvider {
  constructor(private readonly verdict: RelevanceCheckResult['verdict']) {}

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    return {
      submissionId: request.submissionId,
      relevance: request.relevance.map((item) => ({
        requirementId: item.requirementId,
        verdict: this.verdict,
        reasoning: `fixed verdict: ${this.verdict}`,
        confidence: 'high',
      })),
      ambiguity: { needsReasoning: false, reason: 'n/a', confidence: 'medium' },
    };
  }
}

function freeFormClaimedAssessment(content: string): SubmissionAssessment {
  return {
    submissionId: 'sub-free-form',
    classification: 'incomplete',
    confidence: 'medium',
    score: { requirementCoverage: 10, evidenceQuality: 25, completeness: 5, relevance: 10, qualitySignals: 10, total: 60 },
    requirementAssessments: [
      {
        requirementId: 'general-completion',
        status: 'claimed',
        evidence: [],
        reason:
          'Non-empty response provided to a free-form instruction; not deterministically verifiable beyond this -- see --reasoning for a semantic opinion.',
      },
    ],
    flags: [],
    reasons: [],
  };
}

const freeFormRequirement: Requirement = {
  id: 'general-completion',
  description: 'Suggest one improvement you would make to Gibwork.',
  required: true,
};

function partiallyVerifiedAssessment(requirementId: string, evidenceValue: string): SubmissionAssessment {
  return {
    submissionId: 'sub-1',
    classification: 'review',
    confidence: 'medium',
    score: { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: 0 },
    requirementAssessments: [
      {
        requirementId,
        status: 'partially_verified',
        evidence: [{ type: 'github', value: evidenceValue }],
        reason: 'Evidence present but relevance unclear.',
      },
    ],
    flags: [],
    reasons: [],
  };
}

const requirement: Requirement = { id: 'pagination-implemented', description: 'Pagination is implemented', required: true, evidenceType: 'github' };
const submission: ReviewSubmission = { id: 'sub-1', content: `Implemented pagination: ${PR_URL}` };

// 1. A routed submission with GitHub evidence receives inspected PR context in the reasoning request.
test('a routed submission with GitHub evidence receives inspected PR context in the reasoning request', async () => {
  const assessment = partiallyVerifiedAssessment('pagination-implemented', PR_URL);
  const provider = new RecordingLLMProvider();
  const adapter = new GithubEvidenceAdapter({ runner: runnerReturning(sampleCliOutput) });

  await applyReasoning(submission, [requirement], assessment, provider, adapter);

  assert.ok(provider.lastRequest, 'provider should have been called');
  const item = provider.lastRequest?.relevance.find((entry) => entry.requirementId === 'pagination-implemented');
  assert.ok(item, 'relevance item for the routed requirement should be present');
  assert.equal(item?.inspectedEvidence?.length, 1);
  assert.equal(item?.inspectedEvidence?.[0]?.title, 'Add pagination to the /tasks endpoint');
  assert.equal(item?.inspectedEvidence?.[0]?.merged, true);
  assert.equal(item?.inspectedEvidence?.[0]?.changedFiles.length, 3);
  // The raw evidence metadata is still present too -- inspection is additive, not a replacement.
  assert.deepEqual(item?.evidence, [{ type: 'github', value: PR_URL }]);
});

// 2. A cross-requirement evidence-binding case sends the SAME PR evidence separately against each relevant requirement.
test('the same PR evidence is sent separately against each requirement it is cited for', async () => {
  const assessment: SubmissionAssessment = {
    submissionId: 'sub-2',
    classification: 'review',
    confidence: 'medium',
    score: { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: 0 },
    requirementAssessments: [
      { requirementId: 'pagination-implemented', status: 'verified', evidence: [{ type: 'github', value: PR_URL }], reason: 'ok' },
      { requirementId: 'tests-added', status: 'verified', evidence: [{ type: 'github', value: PR_URL }], reason: 'ok' },
    ],
    flags: [],
    reasons: [],
  };
  const requirements: Requirement[] = [
    { id: 'pagination-implemented', description: 'Pagination is implemented', required: true, evidenceType: 'github' },
    { id: 'tests-added', description: 'Tests were added', required: true, evidenceType: 'github' },
  ];
  const provider = new RecordingLLMProvider();
  const { runner, calls } = runnerCounting(sampleCliOutput);
  const adapter = new GithubEvidenceAdapter({ runner });

  await applyReasoning({ id: 'sub-2', content: `One PR does it all: ${PR_URL}` }, requirements, assessment, provider, adapter);

  const request = provider.lastRequest;
  assert.ok(request);
  assert.equal(request?.relevance.length, 2, 'both requirements must appear as independent relevance items');

  const paginationItem = request?.relevance.find((entry) => entry.requirementId === 'pagination-implemented');
  const testsItem = request?.relevance.find((entry) => entry.requirementId === 'tests-added');
  assert.ok(paginationItem?.inspectedEvidence?.length === 1, 'pagination requirement gets its own inspected evidence');
  assert.ok(testsItem?.inspectedEvidence?.length === 1, 'tests requirement independently gets the same inspected evidence');
  assert.deepEqual(paginationItem?.inspectedEvidence, testsItem?.inspectedEvidence, 'same PR, so same evidence content for both');

  // Efficiency, not semantics: the underlying `gh` call happens once even though the
  // evidence is attached to two independent requirement evaluations.
  assert.equal(calls(), 1);
});

// 3. The model can distinguish: PR exists / PR claims something / PR evidence actually supports the requirement.
test('the reasoning request carries enough to distinguish PR-exists from PR-actually-supports-it', async () => {
  const supportingAssessment = partiallyVerifiedAssessment('pagination-implemented', PR_URL);
  const provider = new SemanticFakeProvider();
  const supportingAdapter = new GithubEvidenceAdapter({ runner: runnerReturning(sampleCliOutput) });
  const supportingResult = await applyReasoning(submission, [requirement], supportingAssessment, provider, supportingAdapter);
  assert.equal(supportingResult.result?.relevance[0]?.verdict, 'relevant');

  const unrelatedPrBody = JSON.stringify({
    number: 9,
    title: 'Add pagination to the /tasks endpoint',
    body: 'Claims pagination was added.',
    state: 'MERGED',
    mergedAt: '2026-05-01T12:00:00Z',
    additions: 3,
    deletions: 0,
    changedFiles: 1,
    files: [{ path: 'README.md', additions: 3, deletions: 0 }],
    statusCheckRollup: [],
    reviewDecision: null,
  });
  const claimOnlyAssessment = partiallyVerifiedAssessment('pagination-implemented', 'https://github.com/example-org/tasks-api/pull/9');
  const claimOnlyAdapter = new GithubEvidenceAdapter({ runner: runnerReturning(unrelatedPrBody) });
  const claimOnlyResult = await applyReasoning(
    { id: 'sub-1', content: 'Implemented pagination: https://github.com/example-org/tasks-api/pull/9' },
    [requirement],
    claimOnlyAssessment,
    provider,
    claimOnlyAdapter,
  );
  assert.equal(claimOnlyResult.result?.relevance[0]?.verdict, 'partially_relevant');
  assert.notEqual(supportingResult.result?.relevance[0]?.verdict, claimOnlyResult.result?.relevance[0]?.verdict);
});

// 4. Insufficient GitHub evidence produces a conservative reasoning result.
test('insufficient GitHub evidence produces a conservative (uncertain/low) reasoning result', async () => {
  const assessment = partiallyVerifiedAssessment('pagination-implemented', PR_URL);
  const provider = new FixtureMockLLMProvider();
  const adapter = new GithubEvidenceAdapter({ runner: runnerReturning(sampleCliOutput) });

  const reasoning = await applyReasoning(
    { id: 'sub-not-in-mock-table', content: `Implemented pagination: ${PR_URL}` },
    [requirement],
    { ...assessment, submissionId: 'sub-not-in-mock-table' },
    provider,
    adapter,
  );

  const verdict = reasoning.result?.relevance.find((entry) => entry.requirementId === 'pagination-implemented');
  assert.equal(verdict?.verdict, 'uncertain');
  assert.equal(verdict?.confidence, 'low');
  assert.match(verdict?.reasoning ?? '', /insufficient evidence/i);
});

// 5. GitHub retrieval failure does not crash the review.
test('a GitHub retrieval failure does not crash applyReasoning', async () => {
  const assessment = partiallyVerifiedAssessment('pagination-implemented', PR_URL);
  const provider = new RecordingLLMProvider();
  const adapter = new GithubEvidenceAdapter({ runner: runnerThrowing('simulated gh outage') });

  const reasoning = await applyReasoning(submission, [requirement], assessment, provider, adapter);

  assert.equal(reasoning.routed, true);
  assert.ok(reasoning.result, 'reasoning should still complete despite the retrieval failure');
  const item = provider.lastRequest?.relevance.find((entry) => entry.requirementId === 'pagination-implemented');
  assert.equal(item?.inspectedEvidence, undefined, 'no inspected evidence should be attached when retrieval failed');
});

// 6. GitHub retrieval failure does not alter deterministic score/classification/confidence.
test('a GitHub retrieval failure never mutates the deterministic assessment', async () => {
  const assessment = partiallyVerifiedAssessment('pagination-implemented', PR_URL);
  const snapshot = JSON.stringify(assessment);
  const provider = new RecordingLLMProvider();
  const adapter = new GithubEvidenceAdapter({ runner: runnerThrowing('simulated gh outage') });

  await applyReasoning(submission, [requirement], assessment, provider, adapter);

  assert.equal(JSON.stringify(assessment), snapshot, 'assessment object must be byte-identical after reasoning runs');
});

// 7. Existing non-GitHub reasoning still works.
test('existing non-GitHub reasoning is unaffected when no GitHub evidence or adapter is involved', async () => {
  const urlRequirement: Requirement = { id: 'docs-updated', description: 'Docs were updated', required: true, evidenceType: 'url' };
  const assessment: SubmissionAssessment = {
    submissionId: 'sub-3',
    classification: 'review',
    confidence: 'medium',
    score: { requirementCoverage: 0, evidenceQuality: 0, completeness: 0, relevance: 0, qualitySignals: 0, total: 0 },
    requirementAssessments: [
      {
        requirementId: 'docs-updated',
        status: 'partially_verified',
        evidence: [{ type: 'url', value: 'https://example.dev/blog/pagination' }],
        reason: 'Evidence present but relevance unclear.',
      },
    ],
    flags: [],
    reasons: [],
  };
  const provider = new RecordingLLMProvider();

  // No githubAdapter passed at all -- matches how ordinary --reasoning-only runs behave.
  const reasoning = await applyReasoning({ id: 'sub-3', content: 'See blog post.' }, [urlRequirement], assessment, provider);

  assert.equal(reasoning.routed, true);
  assert.equal(reasoning.result?.relevance[0]?.verdict, 'relevant');
  const item = provider.lastRequest?.relevance.find((entry) => entry.requirementId === 'docs-updated');
  assert.equal(item?.inspectedEvidence, undefined);
});

// 8. A free-form (general-completion) requirement routed via free-form-fulfillment-uncertain
// is included in the relevance request, carrying the real submission content and no evidence.
test('a free-form requirement claimed via the new trigger is included in the relevance request with the submission content and empty evidence', async () => {
  const content = 'Add dark mode because it would make the app easier to use at night.';
  const assessment = freeFormClaimedAssessment(content);
  const provider = new RecordingLLMProvider();

  const reasoning = await applyReasoning({ id: 'sub-free-form', content }, [freeFormRequirement], assessment, provider);

  assert.equal(reasoning.routed, true);
  assert.ok(reasoning.triggers.includes('free-form-fulfillment-uncertain:general-completion'));

  const item = provider.lastRequest?.relevance.find((entry) => entry.requirementId === 'general-completion');
  assert.ok(item, 'the free-form requirement must appear in the relevance request');
  assert.equal(item?.claimText, content);
  assert.deepEqual(item?.evidence, []);
  assert.equal(item?.inspectedEvidence, undefined);
});

// 9. Advisory-only boundary: an LLM "relevant" verdict must not change deterministic status/score/classification.
test('a free-form LLM verdict of "relevant" does not mutate the deterministic assessment', async () => {
  const content = "I'd add a way for bounty creators to preview the expected submission format before publishing.";
  const assessment = freeFormClaimedAssessment(content);
  const snapshot = JSON.stringify(assessment);
  const provider = new FixedVerdictProvider('relevant');

  const reasoning = await applyReasoning({ id: 'sub-free-form', content }, [freeFormRequirement], assessment, provider);

  assert.equal(reasoning.result?.relevance[0]?.verdict, 'relevant');
  // The deterministic assessment object itself must be byte-identical after reasoning runs.
  assert.equal(JSON.stringify(assessment), snapshot);
  assert.equal(assessment.requirementAssessments[0]?.status, 'claimed');
  assert.notEqual(assessment.requirementAssessments[0]?.status, 'verified');
  assert.equal(assessment.classification, 'incomplete');
});

// 10. Advisory-only boundary, the other direction: an LLM "not_relevant" verdict must not
// demote status/classification either -- the deterministic layer never reacts to reasoning.
test('a free-form LLM verdict of "not_relevant" does not mutate the deterministic assessment', async () => {
  const content = 'Something entirely unrelated to the bounty instruction.';
  const assessment = freeFormClaimedAssessment(content);
  const snapshot = JSON.stringify(assessment);
  const provider = new FixedVerdictProvider('not_relevant');

  const reasoning = await applyReasoning({ id: 'sub-free-form', content }, [freeFormRequirement], assessment, provider);

  assert.equal(reasoning.result?.relevance[0]?.verdict, 'not_relevant');
  assert.equal(JSON.stringify(assessment), snapshot);
  assert.equal(assessment.requirementAssessments[0]?.status, 'claimed');
  assert.notEqual(assessment.requirementAssessments[0]?.status, 'not_found');
  assert.equal(assessment.classification, 'incomplete');
});

// 11. The two verdicts above genuinely differ in the advisory output -- proving the reasoning
// layer itself is responsive, even though it never reaches back into the deterministic layer.
test('relevant vs. not_relevant verdicts differ in the advisory reasoning output for the same free-form submission', async () => {
  const content = 'Add dark mode.';

  const relevantResult = await applyReasoning(
    { id: 'sub-free-form', content },
    [freeFormRequirement],
    freeFormClaimedAssessment(content),
    new FixedVerdictProvider('relevant'),
  );
  const notRelevantResult = await applyReasoning(
    { id: 'sub-free-form', content },
    [freeFormRequirement],
    freeFormClaimedAssessment(content),
    new FixedVerdictProvider('not_relevant'),
  );

  assert.notEqual(relevantResult.result?.relevance[0]?.verdict, notRelevantResult.result?.relevance[0]?.verdict);
});

// 12. A non-required free-form requirement never gets a free-form-fulfillment-uncertain
// relevance item (mirrors routing.test.ts). Note: with zero required assessments,
// allRequiredRequirementsSatisfied is vacuously true, so the pre-existing, unrelated
// contradiction-risk trigger still fires and routes -- that is unchanged existing
// behavior, not something this free-form change affects.
test('a non-required free-form requirement is never included as a relevance item', async () => {
  const content = 'Some optional free-form response.';
  const assessment = freeFormClaimedAssessment(content);
  const optionalRequirement: Requirement = { ...freeFormRequirement, required: false };
  const provider = new RecordingLLMProvider();

  const reasoning = await applyReasoning({ id: 'sub-free-form', content }, [optionalRequirement], assessment, provider);

  assert.ok(!reasoning.triggers.includes('free-form-fulfillment-uncertain:general-completion'));
  assert.equal(provider.lastRequest?.relevance.length, 0);
});
