import Anthropic from '@anthropic-ai/sdk';
import type { ConfidenceLevel } from './types.js';
import type {
  LLMProvider,
  ReasoningRequest,
  ReasoningResult,
  RelevanceCheckResult,
  RelevanceVerdict,
  ContradictionCheckResult,
  AmbiguityCheckResult,
} from './llm.js';

/**
 * The ONLY file in this codebase that knows about a specific LLM vendor. Everything
 * else depends on the `LLMProvider` interface in llm.js. Swapping providers later
 * means adding a sibling file, not touching the evaluator, router, or orchestrator.
 */

export const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_OUTPUT_TOKENS = 2048;

export interface AnthropicLLMProviderOptions {
  /** May be empty -- a missing key is reported as a clean provider error on first use, not a crash at construction. */
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test-only hook: inject a fake fetch so tests never touch the real network. */
  fetch?: typeof fetch;
}

/** Distinguishes a handled, safe-to-display provider failure from an unexpected bug. */
export class ProviderReasoningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderReasoningError';
  }
}

const SYSTEM_PROMPT = `You are assisting a human reviewer evaluating a submission against a Gibwork bounty's requirements. You do not approve, reject, or make any final decision -- you provide advisory judgments a human reads alongside deterministic checks that already ran.

Rules:
- Reason only from the requirements, submission text, and evidence given to you below. Do not invent facts, and do not assume a URL's, PR's, or attachment's contents beyond what is stated -- a URL existing is not proof of what it contains.
- A claim in the submission text is not proof that a requirement is satisfied.
- If the same evidence is offered for multiple requirements, judge each requirement's relevance independently; note if the evidence plausibly covers more than one.
- "Uncertain" and "insufficient information" are valid, expected answers -- prefer them over a confident guess.
- Distinguish "not enough information to tell" from "this is contradicted" -- these are different findings and must not be conflated.
- Never describe a submitter as committing fraud, plagiarism, or other dishonest/malicious behavior. Describe only what the text and evidence do or do not show.
- Be conservative when uncertain: prefer a lower confidence or a weaker verdict over an assertive one.
- For every judgment, state what evidence (if any) it rests on.

Respond only via the structured output format provided.`;

const RELEVANCE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    requirementId: { type: 'string' },
    verdict: { type: 'string', enum: ['relevant', 'partially_relevant', 'not_relevant', 'uncertain'] },
    reasoning: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['requirementId', 'verdict', 'reasoning', 'confidence'],
  additionalProperties: false,
};

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    contradictionFound: { type: 'boolean' },
    explanation: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['contradictionFound', 'explanation', 'confidence'],
  additionalProperties: false,
};

const REASONING_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    relevance: { type: 'array', items: RELEVANCE_ITEM_SCHEMA },
    contradiction: { anyOf: [CONTRADICTION_SCHEMA, { type: 'null' }] },
    ambiguity: {
      type: 'object',
      properties: {
        needsReasoning: { type: 'boolean' },
        reason: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['needsReasoning', 'reason', 'confidence'],
      additionalProperties: false,
    },
  },
  required: ['relevance', 'contradiction', 'ambiguity'],
  additionalProperties: false,
};

function buildUserPrompt(request: ReasoningRequest): string {
  const submissionText = request.relevance[0]?.claimText ?? request.contradiction?.submissionText ?? '';
  const lines: string[] = [];

  lines.push('Submission text (verbatim -- the only source of truth about what was submitted):');
  lines.push('"""');
  lines.push(submissionText);
  lines.push('"""');
  lines.push('');

  if (request.relevance.length > 0) {
    lines.push('Relevance checks -- for each requirement, judge whether the listed evidence is relevant to it:');
    for (const item of request.relevance) {
      lines.push(`- Requirement [${item.requirementId}]: ${item.requirementDescription}`);
      lines.push(
        item.evidence.length > 0
          ? `  Evidence: ${item.evidence.map((evidence) => `${evidence.type}: ${evidence.value}`).join('; ')}`
          : '  Evidence: (none)',
      );
    }
    lines.push('');
  }

  if (request.contradiction) {
    lines.push("Contradiction check -- does the submission text internally contradict itself with respect to these requirements?");
    for (const claim of request.contradiction.requirementClaims) {
      lines.push(`- [${claim.requirementId}] ${claim.description}`);
    }
  } else {
    lines.push('No contradiction check was requested for this submission -- return null for "contradiction".');
  }

  return lines.join('\n');
}

function isConfidence(value: unknown): value is ConfidenceLevel {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isRelevanceVerdict(value: unknown): value is RelevanceVerdict {
  return value === 'relevant' || value === 'partially_relevant' || value === 'not_relevant' || value === 'uncertain';
}

/**
 * Validates the parsed JSON structurally before trusting any of it -- required fields,
 * enum values, arrays, and strings are all checked. Throws ProviderReasoningError (never
 * silently coerces malformed output into a confident-looking result) on any mismatch.
 */
function validateReasoningResult(raw: unknown, submissionId: string): ReasoningResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProviderReasoningError('Provider response was not a JSON object.');
  }
  const value = raw as Record<string, unknown>;

  if (!Array.isArray(value.relevance)) {
    throw new ProviderReasoningError('Provider response is missing a "relevance" array.');
  }
  const relevance: RelevanceCheckResult[] = value.relevance.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new ProviderReasoningError(`Provider relevance item ${index} was not an object.`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.requirementId !== 'string' || entry.requirementId.length === 0) {
      throw new ProviderReasoningError(`Provider relevance item ${index} is missing a requirementId.`);
    }
    if (!isRelevanceVerdict(entry.verdict)) {
      throw new ProviderReasoningError(`Provider relevance item ${index} has an invalid verdict.`);
    }
    if (typeof entry.reasoning !== 'string') {
      throw new ProviderReasoningError(`Provider relevance item ${index} is missing reasoning text.`);
    }
    if (!isConfidence(entry.confidence)) {
      throw new ProviderReasoningError(`Provider relevance item ${index} has an invalid confidence value.`);
    }
    return { requirementId: entry.requirementId, verdict: entry.verdict, reasoning: entry.reasoning, confidence: entry.confidence };
  });

  let contradiction: ContradictionCheckResult | undefined;
  if (value.contradiction !== null && value.contradiction !== undefined) {
    if (typeof value.contradiction !== 'object') {
      throw new ProviderReasoningError('Provider "contradiction" field was not an object or null.');
    }
    const entry = value.contradiction as Record<string, unknown>;
    if (typeof entry.contradictionFound !== 'boolean') {
      throw new ProviderReasoningError('Provider contradiction result is missing contradictionFound.');
    }
    if (typeof entry.explanation !== 'string') {
      throw new ProviderReasoningError('Provider contradiction result is missing an explanation.');
    }
    if (!isConfidence(entry.confidence)) {
      throw new ProviderReasoningError('Provider contradiction result has an invalid confidence value.');
    }
    contradiction = { contradictionFound: entry.contradictionFound, explanation: entry.explanation, confidence: entry.confidence };
  }

  if (typeof value.ambiguity !== 'object' || value.ambiguity === null) {
    throw new ProviderReasoningError('Provider response is missing an "ambiguity" object.');
  }
  const ambiguityEntry = value.ambiguity as Record<string, unknown>;
  if (typeof ambiguityEntry.needsReasoning !== 'boolean') {
    throw new ProviderReasoningError('Provider ambiguity result is missing needsReasoning.');
  }
  if (typeof ambiguityEntry.reason !== 'string') {
    throw new ProviderReasoningError('Provider ambiguity result is missing a reason.');
  }
  if (!isConfidence(ambiguityEntry.confidence)) {
    throw new ProviderReasoningError('Provider ambiguity result has an invalid confidence value.');
  }
  const ambiguity: AmbiguityCheckResult = {
    needsReasoning: ambiguityEntry.needsReasoning,
    reason: ambiguityEntry.reason,
    confidence: ambiguityEntry.confidence,
  };

  return { submissionId, relevance, ...(contradiction ? { contradiction } : {}), ambiguity };
}

/** Maps SDK failures to a message safe to print -- never a key, header, or raw error body. */
function toProviderError(error: unknown): ProviderReasoningError {
  if (error instanceof ProviderReasoningError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderReasoningError(
      'Authentication with the LLM provider failed. Check that LLM_API_KEY is set to a valid key.',
      { cause: error },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderReasoningError('The LLM provider rate-limited this request. Try again later.', { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderReasoningError('Could not reach the LLM provider (network error or timeout).', { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderReasoningError(`The LLM provider returned an error (HTTP ${String(error.status)}).`, { cause: error });
  }
  return new ProviderReasoningError('The LLM provider request failed.', { cause: error });
}

/**
 * Real provider backed by the official Anthropic SDK (chosen per Anthropic's own
 * tooling guidance: use the official SDK for Claude API calls rather than raw fetch,
 * since it gives typed errors and first-class structured-output support). Never
 * approves, rejects, refunds, submits, or touches Gibwork/wallet state -- it has
 * exactly one method, and that method only returns a judgment object.
 */
export class AnthropicLLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: AnthropicLLMProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch;
  }

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    if (!this.apiKey) {
      throw new ProviderReasoningError(
        'LLM_API_KEY is not set. Set it in your environment, or copy .env.example to .env and run with ' +
          '`node --env-file=.env dist/index.js ...` (after `npm run build`).',
      );
    }

    const client = new Anthropic({
      apiKey: this.apiKey,
      maxRetries: this.maxRetries,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });

    let text: string;
    try {
      const response = await client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(request) }],
          output_config: { format: { type: 'json_schema', schema: REASONING_RESULT_SCHEMA } },
        },
        { timeout: this.timeoutMs },
      );

      if (response.stop_reason === 'refusal') {
        throw new ProviderReasoningError('The model declined to process this request.');
      }

      const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
      if (!textBlock) {
        throw new ProviderReasoningError('Provider response contained no text output.');
      }
      text = textBlock.text;
    } catch (error) {
      throw toProviderError(error);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ProviderReasoningError('Provider returned invalid JSON.', { cause: error });
    }

    return validateReasoningResult(raw, request.submissionId);
  }
}
