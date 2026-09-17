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
 *
 * Backed by OpenRouter (https://openrouter.ai), which exposes an OpenAI-compatible
 * chat completions API in front of many underlying models -- including a free router
 * model (`openrouter/free`) suitable for testing real semantic reasoning without a
 * paid key. Talks to it with plain `fetch` (already a Node/runtime global) rather than
 * an SDK: OpenRouter's API surface used here is one HTTP endpoint with a JSON body, so
 * a dedicated client library would add a dependency without adding capability.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 2048;

export interface OpenRouterLLMProviderOptions {
  /** May be empty -- a missing key is reported as a clean provider error on first use, not a crash at construction. */
  apiKey: string;
  model?: string;
  timeoutMs?: number;
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

Respond with a single JSON object, and nothing else -- no markdown code fences, no commentary before or after it -- matching exactly this JSON schema:
`;

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

function buildSystemPrompt(): string {
  return `${SYSTEM_PROMPT}${JSON.stringify(REASONING_RESULT_SCHEMA)}`;
}

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
 * Vendor-agnostic: this is the same validation regardless of which model answered.
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

/**
 * Some models wrap JSON in a ```json fence even when told not to. Stripping it is a
 * parsing convenience, not a trust decision -- whatever comes out still goes through
 * JSON.parse and full structural validation below.
 */
function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

interface OpenRouterErrorBody {
  error?: { message?: string; code?: string | number };
}

/** Maps HTTP/network failures to a message safe to print -- never a key, header, or raw error body. */
async function toProviderError(response: Response): Promise<ProviderReasoningError> {
  let parsedMessage: string | undefined;
  try {
    const body = (await response.json()) as OpenRouterErrorBody;
    parsedMessage = body.error?.message;
  } catch {
    // Response body wasn't JSON (or was empty) -- fall back to the status alone below.
  }

  if (response.status === 401 || response.status === 403) {
    return new ProviderReasoningError(
      'Authentication with OpenRouter failed. Check that OPENROUTER_API_KEY is set to a valid key.',
    );
  }
  if (response.status === 429) {
    return new ProviderReasoningError('OpenRouter rate-limited this request. Try again later.');
  }
  return new ProviderReasoningError(
    `OpenRouter returned an error (HTTP ${response.status})${parsedMessage ? `: ${parsedMessage}` : '.'}`,
  );
}

interface OpenRouterChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

/**
 * Real provider backed by OpenRouter's OpenAI-compatible chat completions endpoint.
 * Never approves, rejects, refunds, submits, or touches Gibwork/wallet state -- it has
 * exactly one method, and that method only returns a judgment object.
 */
export class OpenRouterLLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterLLMProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async reason(request: ReasoningRequest): Promise<ReasoningResult> {
    if (!this.apiKey) {
      throw new ProviderReasoningError(
        'OPENROUTER_API_KEY is not set. Set it in your environment, or copy .env.example to .env at the project ' +
          'root -- it is loaded automatically.',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: buildUserPrompt(request) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderReasoningError('Could not reach OpenRouter in time (request timed out).', { cause: error });
      }
      throw new ProviderReasoningError('Could not reach OpenRouter (network error).', { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw await toProviderError(response);
    }

    let body: OpenRouterChatResponse;
    try {
      body = (await response.json()) as OpenRouterChatResponse;
    } catch (error) {
      throw new ProviderReasoningError('OpenRouter response was not valid JSON.', { cause: error });
    }

    if (body.model) {
      // openrouter/free (and other multi-model routers) may hand the request to any
      // underlying model -- surfacing which one actually answered is purely informational,
      // advisory-only output, never something downstream evaluation logic reads.
      console.log(`[OpenRouter] request handled by model: ${body.model}`);
    }

    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      throw new ProviderReasoningError('The model declined to process this request (content filter).');
    }
    const text = choice?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new ProviderReasoningError('OpenRouter response contained no message content.');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(extractJsonText(text));
    } catch (error) {
      throw new ProviderReasoningError('Provider returned invalid JSON.', { cause: error });
    }

    return validateReasoningResult(raw, request.submissionId);
  }
}
