import type { ConfidenceLevel, Evidence } from './types.js';
import type { GithubPrEvidence } from '../evidence/github.js';

/**
 * Future extension point. No implementation exists here beyond a deterministic mock
 * used for local testing (see mock-llm-provider.ts) -- no SDK, no API key, no network
 * call anywhere in this file or its mock.
 *
 * Deliberately narrow: a provider is asked three specific, bounded questions per
 * submission (evidence relevance, contradiction, ambiguity) in a single batched call.
 * It never receives the whole task/submission corpus repeatedly, never decides
 * classification/confidence/score, and has no method that could approve, reject,
 * refund, submit, or otherwise change Gibwork state -- those methods simply do not
 * exist on this interface.
 */

export type RelevanceVerdict = 'relevant' | 'partially_relevant' | 'not_relevant' | 'uncertain';

export interface RelevanceCheckRequest {
  requirementId: string;
  requirementDescription: string;
  /** The submission's own text -- not fetched content from any linked URL/attachment. */
  claimText: string;
  /** Metadata only (type/value/sourceNote). Contents of a URL/attachment are never fetched or invented. */
  evidence: Evidence[];
  /**
   * Compact, already-inspected evidence for this requirement's own evidence list --
   * e.g. what a referenced GitHub PR actually contains (title, body, changed files,
   * checks). Present only when an evidence adapter was configured and something in
   * `evidence` was inspectable. `GithubPrEvidence` today, since GitHub is currently
   * the only evidence adapter; a future second adapter (generic URL, document,
   * image, ...) would widen this to a union rather than adding a parallel field --
   * not built now, since no second adapter exists yet.
   *
   * This is evidence, not a verdict: its presence never implies a requirement is
   * satisfied. The provider decides what it means; this interface does not.
   */
  inspectedEvidence?: GithubPrEvidence[];
}

export interface RelevanceCheckResult {
  requirementId: string;
  verdict: RelevanceVerdict;
  reasoning: string;
  confidence: ConfidenceLevel;
}

export interface ContradictionCheckRequest {
  submissionText: string;
  requirementClaims: { requirementId: string; description: string }[];
}

export interface ContradictionCheckResult {
  contradictionFound: boolean;
  explanation: string;
  confidence: ConfidenceLevel;
}

export interface AmbiguityCheckResult {
  needsReasoning: boolean;
  reason: string;
  confidence: ConfidenceLevel;
}

export interface ReasoningRequest {
  submissionId: string;
  /** Only the requirements the deterministic router flagged as needing a relevance opinion. */
  relevance: RelevanceCheckRequest[];
  /** Present only when the router decided a contradiction pass is warranted. */
  contradiction?: ContradictionCheckRequest;
}

export interface ReasoningResult {
  submissionId: string;
  relevance: RelevanceCheckResult[];
  contradiction?: ContradictionCheckResult;
  ambiguity: AmbiguityCheckResult;
}

/**
 * One batched entry point per submission. Implementations must never invent evidence,
 * never assert that a URL/PR/attachment's contents are known unless actually provided
 * in the request, and must distinguish observation from inference -- "insufficient
 * information" is a valid, expected result, not a failure.
 */
export interface LLMProvider {
  reason(request: ReasoningRequest): Promise<ReasoningResult>;
}
