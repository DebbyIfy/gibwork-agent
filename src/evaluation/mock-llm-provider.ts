import type {
  LLMProvider,
  ReasoningRequest,
  ReasoningResult,
  RelevanceCheckResult,
  RelevanceVerdict,
} from './llm.js';

/**
 * Deterministic, fully offline stand-in for a real LLM. It returns pre-defined
 * reasoning for a small set of known fixture submission IDs, purely to prove the
 * routing/orchestration plumbing end to end without spending money or calling a
 * network API. It contains no model logic, no heuristics beyond a lookup table, and
 * must never be used outside local testing -- it is not a substitute for real
 * reasoning and its "judgments" are canned, not inferred.
 */
export class FixtureMockLLMProvider implements LLMProvider {
  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    switch (request.submissionId) {
      case 'sub-c11':
        return this.result(request, {
          relevance: request.relevance.map((item) =>
            this.verdict(item.requirementId, 'relevant', 'medium', 'Evidence corresponds to the claim for this requirement.'),
          ),
          contradiction: {
            contradictionFound: true,
            explanation:
              'The submission states the change is "fully backward compatible" but also states callers "must always include a page parameter" because the endpoint no longer returns the full list by default. These two statements describe incompatible behavior for existing callers.',
            confidence: 'high',
          },
          ambiguityReason:
            'A likely contradiction was found between the backward-compatibility claim and a stated behavior change; a human should confirm which statement is accurate.',
        });

      case 'sub-c03':
        return this.result(request, {
          relevance: request.relevance.map((item) =>
            item.requirementId === 'tests-added'
              ? this.verdict(
                  item.requirementId,
                  'partially_relevant',
                  'medium',
                  'An image attachment is present and described as test results, but its actual contents were not provided to this model, so its relevance to automated test coverage cannot be confirmed from that description alone.',
                )
              : this.verdict(item.requirementId, 'relevant', 'medium', 'Evidence corresponds to the claim for this requirement.'),
          ),
          ambiguityReason: 'The tests-added requirement rests on an image attachment whose contents were not available for review.',
        });

      case 'sub-c05':
        return this.result(request, {
          relevance: request.relevance.map((item) =>
            this.verdict(
              item.requirementId,
              'not_relevant',
              'medium',
              'The only evidence provided is a link to a general blog post about why pagination matters. It does not appear to be a link to the actual code, PR, or test artifacts this requirement asks for.',
            ),
          ),
          ambiguityReason: 'Confident-sounding claims are not backed by evidence that relates to the specific requirement.',
        });

      default:
        // No pre-defined case: return a conservative, generic "insufficient information"
        // result rather than fabricating a specific judgment for a submission this mock
        // was never given canned data for.
        return this.result(request, {
          relevance: request.relevance.map((item) =>
            item.inspectedEvidence && item.inspectedEvidence.length > 0
              ? this.verdict(
                  item.requirementId,
                  'uncertain',
                  'low',
                  'Inspected GitHub PR evidence was provided, but this local mock provider does not perform real semantic reasoning over PR content -- it cannot confirm whether the PR actually supports this requirement. Insufficient evidence from the inspected PR for an automated judgment; human review recommended.',
                )
              : this.verdict(
                  item.requirementId,
                  'uncertain',
                  'low',
                  'No pre-defined reasoning is registered for this submission in the local mock provider; this is a generic fallback, not a real judgment.',
                ),
          ),
          contradiction: request.contradiction
            ? {
                contradictionFound: false,
                explanation: 'No clear internal contradiction was found in the submission text.',
                confidence: 'medium',
              }
            : undefined,
          ambiguityReason: 'This is a generic mock response used only for local testing; no real reasoning was performed.',
        });
    }
  }

  private verdict(
    requirementId: string,
    verdict: RelevanceVerdict,
    confidence: RelevanceCheckResult['confidence'],
    reasoning: string,
  ): RelevanceCheckResult {
    return { requirementId, verdict, reasoning, confidence };
  }

  private result(
    request: ReasoningRequest,
    parts: {
      relevance: RelevanceCheckResult[];
      contradiction?: ReasoningResult['contradiction'];
      ambiguityReason: string;
    },
  ): ReasoningResult {
    return {
      submissionId: request.submissionId,
      relevance: parts.relevance,
      ...(parts.contradiction ? { contradiction: parts.contradiction } : {}),
      ambiguity: { needsReasoning: true, reason: parts.ambiguityReason, confidence: 'medium' },
    };
  }
}
