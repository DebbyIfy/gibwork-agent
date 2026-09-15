import type { LLMProvider, ReasoningRequest, ReasoningResult } from './llm.js';
import type { Evidence, Requirement, ReviewSubmission, SubmissionAssessment } from './types.js';
import { routeForReasoning, type RoutingTrigger } from './routing.js';
import { findInspectablePullRequestEvidence, type GithubEvidenceAdapter, type GithubPrEvidence } from '../evidence/github.js';

export interface SubmissionReasoning {
  routed: boolean;
  triggers: string[];
  result?: ReasoningResult;
  /** Set when routed but the provider failed -- the deterministic assessment is still shown regardless. */
  error?: string;
}

/** Additive companion to SubmissionAssessment -- the deterministic assessment itself is never mutated. */
export interface ReasonedAssessment {
  assessment: SubmissionAssessment;
  reasoning: SubmissionReasoning;
}

function labelTrigger(trigger: RoutingTrigger): string {
  return trigger.requirementId ? `${trigger.kind}:${trigger.requirementId}` : trigger.kind;
}

/**
 * Inspects whatever GitHub PR evidence is present in one requirement's evidence list.
 * `cache` is shared across the whole buildRequest() call so the same PR referenced by
 * two different requirements (a cross-requirement-evidence-binding case) is only
 * fetched once via `gh`, while still being attached independently to each requirement
 * that references it. A retrieval failure for one URL is swallowed here -- that
 * specific requirement simply gets no inspectedEvidence, exactly as if inspection had
 * never been attempted; it never aborts the whole request or throws.
 */
async function inspectGithubEvidence(
  evidence: Evidence[],
  adapter: GithubEvidenceAdapter,
  cache: Map<string, GithubPrEvidence | null>,
): Promise<GithubPrEvidence[] | undefined> {
  const candidates = findInspectablePullRequestEvidence(evidence);
  if (candidates.length === 0) return undefined;

  const inspected: GithubPrEvidence[] = [];
  for (const candidate of candidates) {
    const url = candidate.evidence.value;
    if (!cache.has(url)) {
      try {
        cache.set(url, await adapter.inspectPullRequest(url));
      } catch {
        cache.set(url, null);
      }
    }
    const entry = cache.get(url);
    if (entry) inspected.push(entry);
  }
  return inspected.length > 0 ? inspected : undefined;
}

async function buildRequest(
  submission: ReviewSubmission,
  requirements: Requirement[],
  assessment: SubmissionAssessment,
  triggers: RoutingTrigger[],
  githubAdapter?: GithubEvidenceAdapter,
): Promise<ReasoningRequest> {
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const assessmentById = new Map(
    assessment.requirementAssessments.map((requirementAssessment) => [requirementAssessment.requirementId, requirementAssessment]),
  );

  const relevanceRequirementIds = [
    ...new Set(
      triggers
        .filter(
          (trigger) =>
            trigger.kind === 'evidence-relevance-uncertain' ||
            trigger.kind === 'attachment-relevance-unconfirmed' ||
            trigger.kind === 'cross-requirement-evidence-binding' ||
            trigger.kind === 'free-form-fulfillment-uncertain',
        )
        .map((trigger) => trigger.requirementId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const inspectionCache = new Map<string, GithubPrEvidence | null>();
  const relevance = [];
  for (const requirementId of relevanceRequirementIds) {
    const requirement = requirementById.get(requirementId);
    const requirementAssessment = assessmentById.get(requirementId);
    const evidence = requirementAssessment?.evidence ?? [];

    const inspectedEvidence = githubAdapter ? await inspectGithubEvidence(evidence, githubAdapter, inspectionCache) : undefined;

    relevance.push({
      requirementId,
      requirementDescription: requirement?.description ?? '',
      claimText: submission.content ?? '',
      evidence,
      ...(inspectedEvidence ? { inspectedEvidence } : {}),
    });
  }

  const request: ReasoningRequest = { submissionId: submission.id, relevance };

  if (triggers.some((trigger) => trigger.kind === 'contradiction-risk')) {
    request.contradiction = {
      submissionText: submission.content ?? '',
      requirementClaims: requirements.map((requirement) => ({ requirementId: requirement.id, description: requirement.description })),
    };
  }

  return request;
}

/**
 * The only place the deterministic pipeline talks to an LLMProvider. If routing decides
 * no reasoning is needed -- or no provider is configured -- the provider is never
 * called. This is the cost-control gate: at most one batched call per submission, and
 * only for submissions the deterministic router actually flagged as unresolved.
 *
 * A provider failure is caught here, not propagated: the deterministic assessment must
 * never disappear because the advisory reasoning layer had a problem. `assessment`
 * itself is only ever read, never mutated -- this function returns a companion object,
 * not a modified copy.
 */
export async function applyReasoning(
  submission: ReviewSubmission,
  requirements: Requirement[],
  assessment: SubmissionAssessment,
  provider?: LLMProvider,
  githubAdapter?: GithubEvidenceAdapter,
): Promise<SubmissionReasoning> {
  const decision = routeForReasoning(requirements, assessment, (submission.attachments ?? []).length > 0);
  const triggers = decision.triggers.map(labelTrigger);

  if (!decision.needsReasoning || !provider) {
    return { routed: false, triggers };
  }

  const request = await buildRequest(submission, requirements, assessment, decision.triggers, githubAdapter);
  try {
    const result = await provider.reason(request);
    return { routed: true, triggers, result };
  } catch (error) {
    return { routed: true, triggers, error: error instanceof Error ? error.message : 'Unknown provider error.' };
  }
}
